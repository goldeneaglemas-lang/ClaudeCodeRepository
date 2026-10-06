import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildSystemPrompt, runAssistantTurn } from '../src/assistant/agent.js';
import { createApp } from '../src/server.js';
import { twilioSignature } from '../src/voice/twiml.js';
import { MONDAY_8AM_IST, PASSWORD, setup } from './helpers.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

/** Fake Claude: each call pops the next scripted response (object or function of the request). */
function fakeClaude(script, { delayMs = 0 } = {}) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(structuredClone(req));
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          const next = script.shift() ?? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Okay.' }] };
          return typeof next === 'function' ? next(req) : next;
        },
      },
    },
  };
}
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const tool = (name, input = {}) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${name}_${Math.random()}`, name, input }] });

async function start({ claude, voice = {}, clinicFields = {} } = {}) {
  const ctx = setup();
  ctx.store.updateClinic(ctx.clinic.id, { voice_number: '+918040001234', ...clinicFields });
  const app = createApp({ ...ctx, anthropic: claude, sessionSecret: 's', voice: { firstWaitMs: 2000, waitMs: 2000, ...voice } });
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const callSid = `CAtest${Date.now()}${Math.random().toString(16).slice(2)}`;
  const post = async (path, params = {}, headers = {}) => {
    const body = { CallSid: callSid, From: '+919876543210', To: '+918040001234', ...params };
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body),
    });
    n++;
    return { status: res.status, xml: await res.text(), body };
  };
  return { ...ctx, base, post, callSid, calls: () => n };
}

test('Twilio signature matches the documented example', () => {
  // Example from https://www.twilio.com/docs/usage/security
  const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
    CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212',
  });
  assert.equal(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
});

test('voice prompt and tools', () => {
  const { store, clinic } = setup();
  const sys = buildSystemPrompt(clinic, store.listDoctors(clinic.id), MONDAY_8AM_IST,
    { channel: 'voice', callerPhone: '+919876543210', canTransfer: false }).map((b) => b.text).join('\n');
  assert.match(sys, /PHONE CALL/);
  assert.match(sys, /caller ID\): \+919876543210/);
  assert.match(sys, /Transfer to a person is not available/);
  const chat = buildSystemPrompt(clinic, store.listDoctors(clinic.id), MONDAY_8AM_IST).map((b) => b.text).join('\n');
  assert.doesNotMatch(chat, /PHONE CALL/);
});

test('voice tools: end_call always, transfer only with a transfer number', async () => {
  const { store, scheduler, clinic } = setup();
  const names = async (c) => {
    const claude = fakeClaude([text('hi')]);
    await runAssistantTurn({ client: claude, store, scheduler, clinic: c, history: [], userText: 'x', channel: 'voice' });
    return claude.requests[0].tools.map((t) => t.name);
  };
  assert.ok((await names(clinic)).includes('end_call'));
  assert.ok(!(await names(clinic)).includes('transfer_to_front_desk'));
  assert.ok((await names({ ...clinic, transfer_number: '+918040009999' })).includes('transfer_to_front_desk'));
});

test('full booking call: greeting, book, goodbye, status, transcript', async () => {
  const script = [];
  const claude = fakeClaude(script);
  const t = await start({ claude });
  const { days } = t.scheduler.findSlots(t.clinic, t.doctor.id, {});
  const slot = `${days[0].date}T${days[0].times[0]}`;

  const greet = await t.post('/voice/incoming');
  assert.equal(greet.status, 200);
  assert.match(greet.xml, /<Gather input="speech" action="\/voice\/turn"/);
  assert.match(greet.xml, /Thank you for calling Test Clinic/);
  assert.match(greet.xml, /dial 112/);
  assert.match(greet.xml, /hints="Dr\. Test/);

  script.push(
    tool('book_appointment', { doctor_id: t.doctor.id, start: slot, patient_name: 'Asha Rao', patient_phone: '+919876543210', reason: 'Fever' }),
    (req) => text(`You're booked. Your code is ${JSON.parse(req.messages.at(-1).content[0].content).confirmation_code}. Anything else?`),
  );
  const turn1 = await t.post('/voice/turn', { SpeechResult: 'Book me with Dr Test, use this number' });
  assert.match(turn1.xml, /You&apos;re booked\. Your code is [A-Z2-9]{6}\. Anything else\?<\/Say><\/Gather>/);
  // Voice mode: caller ID given to the model
  assert.ok(claude.requests[0].system.some((b) => b.text.includes('+919876543210')));

  script.push(tool('end_call'), text('Thanks for calling, goodbye!'));
  const turn2 = await t.post('/voice/turn', { SpeechResult: "No that's all, bye" });
  assert.match(turn2.xml, /goodbye!<\/Say><Hangup\/>/);

  const status = await t.post('/voice/status', { CallStatus: 'completed', CallDuration: '95' });
  assert.equal(status.status, 204);
  const call = t.store.getCall(t.callSid);
  assert.equal(call.outcome, 'booked');
  assert.equal(call.bookings, 1);
  assert.equal(call.turns, 2);
  assert.equal(call.duration_seconds, 95);
  assert.equal(t.store.listAppointments(t.clinic.id)[0].patient_name, 'Asha Rao');

  // Staff can read the transcript
  const login = await fetch(`${t.base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'demo', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const tr = await (await fetch(`${t.base}/api/admin/calls/${t.callSid}/transcript`, { headers: { cookie } })).json();
  assert.deepEqual(tr.transcript.map((l) => l.speaker), ['caller', 'action', 'assistant', 'caller', 'action', 'assistant']);
  const list = await (await fetch(`${t.base}/api/admin/calls`, { headers: { cookie } })).json();
  assert.equal(list[0].call_sid, t.callSid);
});

test('slow AI turn: caller hears "one moment" and the answer arrives via /voice/wait', async () => {
  const claude = fakeClaude([text('Dr Test is free tomorrow at nine.')], { delayMs: 300 });
  const t = await start({ claude, voice: { firstWaitMs: 50, waitMs: 2000 } });
  await t.post('/voice/incoming');
  const turn = await t.post('/voice/turn', { SpeechResult: 'When is Dr Test free?' });
  assert.match(turn.xml, /One moment please\.<\/Say><Redirect method="POST">\/voice\/wait<\/Redirect>/);
  const wait = await t.post('/voice/wait');
  assert.match(wait.xml, /<Gather[^>]*>.*Dr Test is free tomorrow at nine\./);
  assert.equal(claude.requests.length, 1);
});

test('silence twice ends the call', async () => {
  const t = await start({ claude: fakeClaude([]) });
  await t.post('/voice/incoming');
  const first = await t.post('/voice/turn', { SpeechResult: '' });
  assert.match(first.xml, /didn&apos;t catch that/);
  const second = await t.post('/voice/turn', { SpeechResult: '' });
  assert.match(second.xml, /<Hangup\/>/);
  assert.equal(t.store.getCall(t.callSid).outcome, 'no_input');
});

test('transfer to front desk dials the transfer number', async () => {
  const claude = fakeClaude([tool('transfer_to_front_desk', { reason: 'wants a person' }), text('Sure, connecting you now.')]);
  const t = await start({ claude, clinicFields: { transfer_number: '+918040009999' } });
  await t.post('/voice/incoming');
  const turn = await t.post('/voice/turn', { SpeechResult: 'Let me talk to a human' });
  assert.match(turn.xml, /connecting you now\.<\/Say><Dial timeout="25">\+918040009999<\/Dial>/);
  assert.equal(t.store.getCall(t.callSid).outcome, 'transferred');
});

test('AI failure falls back to the front desk', async () => {
  const claude = { beta: { messages: { create: async () => { throw new Error('API down'); } } } };
  const t = await start({ claude, clinicFields: { transfer_number: '+918040009999' } });
  await t.post('/voice/incoming');
  const turn = await t.post('/voice/turn', { SpeechResult: 'hello' });
  assert.match(turn.xml, /having trouble.*<Dial/);
});

test('with the AI switched off, calls go straight to the front desk', async () => {
  const t = await start({ claude: null, clinicFields: { transfer_number: '+918040009999' } });
  const res = await t.post('/voice/incoming');
  assert.match(res.xml, /not available right now\. Let me connect you.*<Dial timeout="25">\+918040009999<\/Dial>/);
});

test('unknown number is rejected politely', async () => {
  const t = await start({ claude: fakeClaude([]) });
  const res = await t.post('/voice/incoming', { To: '+10000000000' });
  assert.match(res.xml, /not set up.*<Hangup\/>/);
});

test('webhooks must be signed when an auth token is configured', async () => {
  const t = await start({ claude: fakeClaude([]), voice: { authToken: 'tok', publicBaseUrl: 'https://clinic.example.com' } });
  assert.equal((await t.post('/voice/incoming')).status, 403);
  const params = { CallSid: t.callSid, From: '+919876543210', To: '+918040001234' };
  const sig = twilioSignature('tok', 'https://clinic.example.com/voice/incoming', params);
  const ok = await t.post('/voice/incoming', params, { 'X-Twilio-Signature': sig });
  assert.equal(ok.status, 200);
  assert.match(ok.xml, /Thank you for calling/);
});

test('production without an auth token refuses webhooks', async () => {
  const t = await start({ claude: fakeClaude([]), voice: { requireSignature: true } });
  assert.equal((await t.post('/voice/incoming')).status, 503);
});
