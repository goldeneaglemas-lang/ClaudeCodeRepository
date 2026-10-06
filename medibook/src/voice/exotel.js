import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { runAssistantTurn } from '../assistant/agent.js';
import { SESSION_COOKIE, parseCookies, readSessionToken } from '../auth.js';
import { normalizePhone } from '../scheduling.js';
import { BYTES_PER_MS, chunks } from './audio.js';
import { friendlyError } from './diagnostics.js';
import { clinicLanguages, detectCallerLanguage, languageOfText, phrase, sentences } from './languages.js';
import { callSessionId } from './routes.js';
import { Vad } from './vad.js';

// Phone calls in India over Exotel's Voicebot applet (bidirectional audio WebSocket).
//
//   Caller ──► ExoPhone ──► Exotel call flow: [Voicebot applet] ──► [Passthru /exotel/next] ──► [Connect front desk] / [Hangup]
//                                   │ wss://<host>/exotel/stream?clinic=<id>&token=<EXOTEL_STREAM_TOKEN>
//                                   ▼
//   audio in (8 kHz PCM) ─► voice activity detection ─► Sarvam speech-to-text (Tamil / English, auto-detected)
//                         ─► Claude + booking tools ─► Sarvam text-to-speech ─► audio out
//
// The caller can talk over the assistant: their speech clears the queued audio ("barge-in").
// To transfer or hang up, the assistant closes the stream and Exotel continues the flow;
// /exotel/next answers 200 when the call should go to the front desk.
//
// Protocol (JSON text frames): connected, start {stream_sid, call_sid, from, to}, media {payload: base64 PCM},
// dtmf {digit}, mark {name}, stop. We send media, mark and clear.

const CHUNK_BYTES = 3200; // 200 ms of 8 kHz 16-bit audio per media message
const DEFAULT_TIMINGS = {
  fillerAfterMs: 1500, // say "one moment" if the AI hasn't answered by then
  silenceRepromptMs: 9000, // caller silent this long after the assistant finished -> "are you still there?"
};
const MAX_SILENCES = 2;
const MAX_TURNS = 40;
const MAX_CALL_MS = 15 * 60_000;
const TTS_CACHE_LIMIT = 300;

// Synthesized audio for repeated phrases (greetings, "one moment"), kept per speech service.
const ttsCaches = new WeakMap();

export class ExotelCall {
  constructor(ws, { store, scheduler, anthropic, model, speech, slug, testClinicId = null, timings = {} }) {
    Object.assign(this, { ws, store, scheduler, anthropic, model, speech, slug, testClinicId });
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.test = testClinicId !== null;
    this.clinic = null;
    this.ended = false;
    this.speakGen = 0; // bumped on barge-in; stale audio checks it and stops
    this.markSeq = 0;
    this.marks = new Map(); // mark name -> resolve()
    this.playbackEndsAt = 0;
    this.turns = 0;
    this.silences = 0;
    this.thinking = false;
    this.turnChain = Promise.resolve();
    this.vad = new Vad({
      onSpeechStart: () => this.#onSpeechStart(),
      onUtterance: (pcm) => { this.turnChain = this.turnChain.then(() => this.#handleUtterance(pcm)).catch((e) => this.#fail(e)); },
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.#onMessage(msg).catch((e) => this.#fail(e));
    });
    ws.on('close', () => this.#finish('hung_up', { close: false }));
    ws.on('error', (e) => console.error('[exotel] socket error', e.message));
  }

  // ---------- protocol ----------

  async #onMessage(msg) {
    switch (msg.event) {
      case 'start': return this.#onStart(msg.start ?? {});
      case 'media':
        if (!this.ended && this.clinic && msg.media?.payload) this.vad.push(Buffer.from(msg.media.payload, 'base64'));
        return;
      case 'dtmf':
        if (msg.dtmf?.digit === '0' && this.clinic?.transfer_number) return this.#transfer();
        return;
      case 'mark': {
        const resolve = this.marks.get(msg.mark?.name);
        if (resolve) resolve(true);
        return;
      }
      case 'stop': return this.#finish('hung_up', { close: false });
      default:
    }
  }

  #send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  #debug(kind, text) {
    if (this.test) this.#send({ event: 'debug', kind, text });
  }

  async #onStart(start) {
    if (this.clinic) return;
    this.streamSid = start.stream_sid;
    this.callSid = start.call_sid || `exo-${Date.now()}`;
    this.from = normalizePhone(start.from || '');
    this.startedAt = Date.now();

    const clinic = this.slug ? this.store.getClinicBySlug(this.slug) : this.store.getClinicByPhoneDigits(start.to);
    if (!clinic || (this.test && clinic.id !== this.testClinicId)) {
      console.warn(`[exotel] no clinic for this call: clinic=${this.slug ?? '(none in URL)'} dialled=${start.to ?? '?'}. ` +
        'Add ?clinic=<clinic-id> to the Voicebot URL, or set the clinic phone number in Settings.');
      this.ws.close(1000);
      return;
    }
    this.clinic = clinic;
    this.languages = clinicLanguages(clinic);
    this.language = this.languages[0];
    this.store.startCall(this.callSid, clinic.id, this.from, { provider: this.test ? 'test' : 'exotel', language: this.language });
    console.log(`[exotel] ${this.test ? 'test call' : 'call'} ${this.callSid} from ${this.from || 'unknown'} to ${clinic.slug} (${this.languages.join('+')})`);
    this.maxTimer = setTimeout(() => this.#endWith('noInputBye', 'completed'), MAX_CALL_MS);

    if (!this.anthropic) {
      this.#debug('error', 'ANTHROPIC_API_KEY is not set on the server, so the assistant cannot talk.');
      return this.#endWith(clinic.transfer_number ? 'troubleTransfer' : 'troubleBye',
        clinic.transfer_number ? 'transferred' : 'error');
    }
    const greeting = phrase(this.language, 'greeting', { clinic, others: this.languages });
    if (await this.#say(greeting, this.language)) this.#armSilenceTimer();
  }

  // ---------- speaking ----------

  async #tts(text, language) {
    let ttsCache = ttsCaches.get(this.speech);
    if (!ttsCache) ttsCaches.set(this.speech, (ttsCache = new Map()));
    const key = `${language}|${this.clinic.voice_speaker}|${text}`;
    if (ttsCache.has(key)) return ttsCache.get(key);
    const audio = await this.speech.synthesize(text, language, this.clinic.voice_speaker || undefined)
      .catch((err) => { throw Object.assign(err, { service: 'Sarvam text-to-speech' }); });
    if (text.length <= 300) {
      if (ttsCache.size >= TTS_CACHE_LIMIT) ttsCache.delete(ttsCache.keys().next().value);
      ttsCache.set(key, audio);
    }
    return audio;
  }

  /** Speak text sentence by sentence. Resolves true when played to the end, false if interrupted. */
  async #say(text, language = languageOfText(text, this.language)) {
    const gen = this.speakGen;
    const parts = sentences(text);
    let next = parts.length ? this.#tts(parts[0], language) : null;
    for (let i = 0; i < parts.length; i++) {
      const audio = await next;
      next = i + 1 < parts.length ? this.#tts(parts[i + 1], language) : null;
      if (gen !== this.speakGen || this.ended) { next?.catch(() => {}); return false; }
      if (i === 0) this.#debug('assistant', text); // shown once the caller actually starts hearing it
      this.#sendAudio(audio);
    }
    return this.#waitForPlayback(gen);
  }

  #sendAudio(pcm) {
    for (const c of chunks(pcm, CHUNK_BYTES)) {
      this.#send({ event: 'media', stream_sid: this.streamSid, media: { payload: c.toString('base64') } });
    }
    this.playbackEndsAt = Math.max(Date.now(), this.playbackEndsAt) + pcm.length / BYTES_PER_MS;
    this.vad.assistantTalking = true;
  }

  /** Exotel echoes a mark once the audio queued before it has played. */
  #waitForPlayback(gen) {
    const name = `m${++this.markSeq}`;
    this.#send({ event: 'mark', stream_sid: this.streamSid, mark: { name } });
    return new Promise((resolve) => {
      const done = (played) => {
        clearTimeout(timer);
        this.marks.delete(name);
        const current = gen === this.speakGen;
        if (current && !this.marks.size) { this.vad.assistantTalking = false; this.playbackEndsAt = 0; }
        resolve(played && current);
      };
      // Fallback if a mark never comes back: assume playback finished on schedule.
      const timer = setTimeout(() => done(true), Math.max(0, this.playbackEndsAt - Date.now()) + 2500);
      this.marks.set(name, done);
    });
  }

  #interrupt() {
    this.speakGen++;
    this.#send({ event: 'clear', stream_sid: this.streamSid });
    for (const resolve of [...this.marks.values()]) resolve(false);
    this.vad.assistantTalking = false;
    this.playbackEndsAt = 0;
  }

  // ---------- listening ----------

  #onSpeechStart() {
    clearTimeout(this.silenceTimer);
    if (this.vad.assistantTalking) this.#interrupt(); // caller talked over the assistant
  }

  #armSilenceTimer() {
    clearTimeout(this.silenceTimer);
    if (this.ended) return;
    this.silenceTimer = setTimeout(async () => {
      if (this.thinking || this.vad.speaking || this.ended) return;
      this.silences++;
      if (this.silences >= MAX_SILENCES) return this.#endWith('noInputBye', 'no_input');
      if (await this.#say(phrase(this.language, 'stillThere'), this.language)) this.#armSilenceTimer();
    }, this.timings.silenceRepromptMs);
  }

  async #handleUtterance(pcm) {
    if (this.ended || !this.clinic) return;
    this.thinking = true;
    try {
      this.#debug('state', 'Heard you, working out what you said…');
      // On a Tamil line, tell speech-to-text to expect Tamil; it still keeps English words as English.
      const languageCode = this.languages.includes('ta-IN') ? 'ta-IN' : this.languages[0];
      const { text } = await this.speech.transcribe(pcm, { languageCode })
        .catch((err) => { throw Object.assign(err, { service: 'Sarvam speech-to-text' }); });
      if (!text) { // noise, cough, line crackle: keep waiting for the caller
        this.#debug('state', 'Heard a sound but no words. Speak a little louder or closer to the microphone.');
        if (!this.vad.assistantTalking) this.#armSilenceTimer();
        return;
      }
      this.language = detectCallerLanguage(text, { allowed: this.languages, current: this.language });
      this.#debug('caller', text);

      this.silences = 0;
      this.turns++;
      this.store.updateCall(this.callSid, { turns: this.turns, silences: 0, language: this.language });
      if (this.turns > MAX_TURNS) return this.#transferOrEnd();

      const filler = setTimeout(() => { this.#say(phrase(this.language, 'oneMoment'), this.language).catch(() => {}); }, this.timings.fillerAfterMs);
      let result;
      try {
        const sessionId = callSessionId(this.callSid);
        const history = this.store.getChatSession(this.clinic.id, sessionId)?.messages ?? [];
        result = await runAssistantTurn({
          client: this.anthropic, model: this.model, store: this.store, scheduler: this.scheduler, clinic: this.clinic,
          history, userText: text, channel: 'voice', callerPhone: this.from, languages: this.languages,
          replyLanguage: this.languages.length > 1 ? this.language : null,
        }).catch((err) => { throw Object.assign(err, { service: 'Claude' }); });
        this.store.saveChatSession(this.clinic.id, sessionId, result.messages);
      } finally {
        clearTimeout(filler);
      }

      const call = this.store.getCall(this.callSid);
      this.store.updateCall(this.callSid, {
        bookings: call.bookings + result.bookings,
        outcome: result.bookings > 0 && call.outcome !== 'transferred' ? 'booked' : call.outcome,
      });
      this.thinking = false;
      const played = await this.#say(result.reply);
      if (result.action === 'transfer') return this.#transfer({ announce: false });
      if (result.action === 'end') return this.#finish('completed');
      if (played) this.#armSilenceTimer();
    } finally {
      this.thinking = false;
    }
  }

  // ---------- ending ----------

  async #transfer({ announce = true } = {}) {
    if (!this.clinic.transfer_number) return this.#endWith('troubleBye', 'error');
    this.store.updateCall(this.callSid, { outcome: 'transferred' });
    if (announce) await this.#say(phrase(this.language, 'transferring'), this.language);
    this.#finish('transferred');
  }

  #transferOrEnd() {
    return this.clinic.transfer_number ? this.#transfer() : this.#endWith('troubleBye', 'completed');
  }

  async #endWith(phraseKey, outcome) {
    if (this.ended) return;
    if (outcome === 'transferred') this.store.updateCall(this.callSid, { outcome });
    const text = phrase(this.language, phraseKey, this.clinic);
    try { await this.#say(text, this.language); } catch (e) { console.error('[exotel] tts failed', e.message); }
    this.#finish(outcome);
  }

  async #fail(err) {
    console.error('[exotel] call error', this.callSid, err);
    this.#debug('error', friendlyError(err, err?.service ?? 'Server'));
    if (this.ended || !this.clinic) return this.ws.close(1011);
    this.thinking = false;
    const canTransfer = Boolean(this.clinic.transfer_number);
    await this.#endWith(canTransfer ? 'troubleTransfer' : 'troubleBye', canTransfer ? 'transferred' : 'error');
  }

  #finish(reason, { close = true } = {}) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxTimer);
    for (const resolve of [...this.marks.values()]) resolve(false);
    if (this.clinic && this.callSid) {
      const call = this.store.getCall(this.callSid);
      console.log(`[exotel] call ${this.callSid} ended: ${call?.outcome || reason}, ${this.turns} turns`);
      this.store.updateCall(this.callSid, {
        status: 'ended',
        ended_at: new Date().toISOString(),
        duration_seconds: Math.round((Date.now() - this.startedAt) / 1000),
        outcome: call?.outcome || reason,
      });
    }
    if (close && this.ws.readyState === 1) this.ws.close(1000);
  }
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accept Exotel media-stream WebSockets on /exotel/stream.
 * Auth: ?token= must equal EXOTEL_STREAM_TOKEN; or, for the dashboard's "test call",
 * a logged-in clinic admin session (test calls are tagged and can only reach that clinic).
 */
export function attachExotel(server, {
  store, scheduler, anthropic, model, speech, streamToken, sessionSecret, requireToken = false, timings,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/exotel/stream') return socket.destroy();

    const slug = url.searchParams.get('clinic') || null;
    let testClinicId = null;
    if (url.searchParams.get('test') === '1') {
      const session = readSessionToken(sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      const clinic = slug && store.getClinicBySlug(slug);
      if (!session || !clinic || clinic.id !== session.clinicId) return reject(socket, 401, 'test call without a dashboard login');
      testClinicId = clinic.id;
    } else if (streamToken) {
      if (!tokenMatches(url.searchParams.get('token'), streamToken)) {
        return reject(socket, 401, 'wrong or missing token in the stream URL (must match EXOTEL_STREAM_TOKEN)');
      }
    } else if (requireToken) {
      return reject(socket, 503, 'EXOTEL_STREAM_TOKEN is not set (required in production)');
    }
    if (!speech) return reject(socket, 503, 'SARVAM_API_KEY is not set');

    wss.handleUpgrade(req, socket, head, (ws) => {
      new ExotelCall(ws, { store, scheduler, anthropic, model, speech, slug, testClinicId, timings });
    });
  });
  return wss;
}

function reject(socket, status, reason) {
  console.warn(`[exotel] refused a call stream: ${reason}`);
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
