import express from 'express';
import { runAssistantTurn } from '../assistant/agent.js';
import { dial, gather, hangup, isValidTwilioRequest, redirect, say, twiml } from './twiml.js';

// Phone-call booking over Twilio Programmable Voice.
//
// Call flow:
//   POST /voice/incoming  call starts -> greeting, listen
//   POST /voice/turn      caller finished speaking (Twilio speech-to-text in SpeechResult) -> AI reply, listen
//   POST /voice/wait      AI still working after FIRST_WAIT -> keep the caller company until it's done
//   POST /voice/status    call ended (status callback) -> record duration and outcome
//
// Twilio gives up on a webhook after 15 seconds, so a slow AI turn is answered with
// "one moment" + <Redirect> to /voice/wait while the turn keeps running in the background.
// Pending turns live in memory: run a single instance (or add sticky routing) for voice.

const MAX_TURNS = 40;
const MAX_SILENCES = 2;
const MAX_TURN_MS = 45_000;
const STALE_PENDING_MS = 5 * 60_000;

export const callSessionId = (callSid) => `call-${callSid}`;

export function createVoiceRouter({
  store, scheduler, anthropic, model,
  authToken, publicBaseUrl, requireSignature = false,
  firstWaitMs = 6000, waitMs = 8000,
}) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '20kb' }));

  // CallSid -> { promise, done, result, error, startedAt, notified }
  const pending = new Map();
  setInterval(() => {
    const cutoff = Date.now() - STALE_PENDING_MS;
    for (const [sid, p] of pending) if (p.startedAt < cutoff) pending.delete(sid);
  }, 60_000).unref();

  const sendXml = (res, ...verbs) => res.type('text/xml').send(twiml(...verbs));
  const paths = {
    turn: '/voice/turn',
    wait: '/voice/wait',
  };

  router.use((req, res, next) => {
    if (!authToken) {
      if (requireSignature) return res.status(503).send('Voice is not configured: set TWILIO_AUTH_TOKEN');
      return next();
    }
    const base = publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const url = base.replace(/\/$/, '') + req.originalUrl;
    if (!isValidTwilioRequest(authToken, url, req.body ?? {}, req.get('X-Twilio-Signature'))) {
      return res.status(403).send('Invalid Twilio signature');
    }
    next();
  });

  function hintsFor(clinic) {
    return [...store.listDoctors(clinic.id).map((d) => d.name), 'appointment', 'reschedule', 'cancel', 'confirmation code'];
  }

  function listen(res, clinic, text) {
    sendXml(res, gather(clinic, text, { action: paths.turn, hints: hintsFor(clinic) }));
  }

  function transferOrEnd(res, clinic, call, text) {
    if (clinic.transfer_number) {
      store.updateCall(call.call_sid, { outcome: 'transferred' });
      return sendXml(res, say(clinic, text), dial(clinic.transfer_number),
        say(clinic, 'Sorry, no one is available to take your call right now. Please call back later. Goodbye.'), hangup());
    }
    const phone = clinic.phone ? ` You can also reach our front desk at ${clinic.phone}.` : '';
    return sendXml(res, say(clinic, `${text}${phone} Goodbye.`), hangup());
  }

  function loadCall(req, res) {
    const sid = req.body.CallSid;
    const call = sid && store.getCall(sid);
    const clinic = call && store.getClinic(call.clinic_id);
    if (!call || !clinic) {
      sendXml(res, '<Say>Sorry, something went wrong. Please call again.</Say>', hangup());
      return {};
    }
    return { call, clinic };
  }

  /** Send the finished AI turn back to Twilio. */
  function respondWithTurn(res, clinic, call, entry) {
    pending.delete(call.call_sid);
    if (entry.error) {
      console.error('[voice] turn failed', call.call_sid, entry.error);
      return transferOrEnd(res, clinic, call,
        clinic.transfer_number ? "Sorry, I'm having trouble right now. Let me connect you to our front desk."
          : "Sorry, I'm having trouble right now. Please try calling again in a few minutes.");
    }
    const { reply, action, bookings } = entry.result;
    const fresh = store.getCall(call.call_sid);
    store.updateCall(call.call_sid, {
      bookings: fresh.bookings + bookings,
      outcome: bookings > 0 && fresh.outcome !== 'transferred' ? 'booked' : fresh.outcome,
    });
    if (action === 'transfer') return transferOrEnd(res, clinic, call, reply);
    if (action === 'end') return sendXml(res, say(clinic, reply), hangup());
    return listen(res, clinic, reply);
  }

  async function settled(entry, ms) {
    if (!entry.done) await Promise.race([entry.promise, new Promise((r) => setTimeout(r, ms))]);
    return entry.done;
  }

  router.post('/incoming', (req, res) => {
    const { CallSid, From = '', To = '' } = req.body;
    const clinic = store.getClinicByVoiceNumber(To) ?? (req.query.clinic && store.getClinicBySlug(String(req.query.clinic)));
    if (!CallSid || !clinic) {
      return sendXml(res, '<Say>Sorry, this number is not set up for appointments.</Say>', hangup());
    }
    const call = store.startCall(CallSid, clinic.id, From);
    if (!anthropic) {
      return transferOrEnd(res, clinic, call, `Thank you for calling ${clinic.name}. Our automated booking line is not available right now.` +
        (clinic.transfer_number ? ' Let me connect you to our front desk.' : ''));
    }
    listen(res, clinic,
      `Thank you for calling ${clinic.name}. I'm the automated booking assistant, and this call is transcribed. ` +
      `If this is a medical emergency, please hang up and dial ${clinic.emergency_number}. ` +
      'How can I help you today?');
  });

  router.post('/turn', async (req, res) => {
    const { call, clinic } = loadCall(req, res);
    if (!call) return;
    const speech = String(req.body.SpeechResult ?? '').trim().slice(0, 1000);

    if (!speech) {
      const silences = call.silences + 1;
      store.updateCall(call.call_sid, { silences });
      if (silences >= MAX_SILENCES) {
        if (!call.outcome) store.updateCall(call.call_sid, { outcome: 'no_input' });
        return sendXml(res, say(clinic, "I haven't heard anything, so I'll end the call now. Please call back any time. Goodbye."), hangup());
      }
      return listen(res, clinic, "Sorry, I didn't catch that. Could you say that again?");
    }

    const turns = call.turns + 1;
    store.updateCall(call.call_sid, { turns, silences: 0 });
    if (turns > MAX_TURNS) {
      return transferOrEnd(res, clinic, call, "We've been talking for a while, so let me get someone to help you.");
    }

    // Ignore a duplicate webhook for a turn that is still running.
    let entry = pending.get(call.call_sid);
    if (!entry) {
      const sessionId = callSessionId(call.call_sid);
      entry = { startedAt: Date.now(), done: false, notified: false };
      entry.promise = (async () => {
        const history = store.getChatSession(clinic.id, sessionId)?.messages ?? [];
        const result = await runAssistantTurn({
          client: anthropic, model, store, scheduler, clinic, history, userText: speech,
          channel: 'voice', callerPhone: call.from_number,
        });
        store.saveChatSession(clinic.id, sessionId, result.messages);
        return result;
      })().then((r) => { entry.result = r; }, (e) => { entry.error = e; }).finally(() => { entry.done = true; });
      pending.set(call.call_sid, entry);
    }

    if (await settled(entry, firstWaitMs)) return respondWithTurn(res, clinic, call, entry);
    sendXml(res, say(clinic, 'One moment please.'), redirect(paths.wait));
  });

  router.post('/wait', async (req, res) => {
    const { call, clinic } = loadCall(req, res);
    if (!call) return;
    const entry = pending.get(call.call_sid);
    if (!entry) return listen(res, clinic, 'Sorry, could you say that again?');
    if (await settled(entry, waitMs)) return respondWithTurn(res, clinic, call, entry);
    if (Date.now() - entry.startedAt > MAX_TURN_MS) {
      pending.delete(call.call_sid);
      return transferOrEnd(res, clinic, call, "Sorry, this is taking too long.");
    }
    if (!entry.notified) {
      entry.notified = true;
      return sendXml(res, say(clinic, 'Still checking, thank you for waiting.'), redirect(paths.wait));
    }
    sendXml(res, '<Pause length="1"/>', redirect(paths.wait));
  });

  router.post('/status', (req, res) => {
    const { CallSid, CallStatus, CallDuration } = req.body;
    const call = CallSid && store.getCall(CallSid);
    if (call && ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(CallStatus)) {
      store.updateCall(CallSid, {
        status: 'ended',
        ended_at: new Date().toISOString(),
        duration_seconds: Number(CallDuration) || null,
        outcome: call.outcome || 'completed',
      });
      pending.delete(CallSid);
    }
    res.sendStatus(204);
  });

  return router;
}

/** Turn a stored call conversation into a readable transcript for clinic staff. */
export function callTranscript(messages = []) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') lines.push({ speaker: 'caller', text: m.content });
      else if (Array.isArray(m.content) && m.content[0]?.type === 'text') lines.push({ speaker: 'caller', text: m.content[0].text });
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) lines.push({ speaker: 'assistant', text: b.text.trim() });
        if (b.type === 'tool_use') lines.push({ speaker: 'action', text: b.name.replaceAll('_', ' ') });
      }
    }
  }
  return lines;
}
