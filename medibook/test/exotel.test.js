import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../src/server.js';
import { attachExotel } from '../src/voice/exotel.js';
import { PASSWORD, setup, silence, tone } from './helpers.js';

const servers = [];
const sockets = [];
after(() => {
  sockets.forEach((w) => w.clients.forEach((c) => c.terminate()));
  servers.forEach((s) => { s.closeAllConnections(); s.close(); });
});

const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const tool = (name, input = {}) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${name}_${Math.random()}`, name, input }] });

function fakeClaude(script, { delayMs = 0 } = {}) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (req) => {
      requests.push(structuredClone(req));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const next = script.shift() ?? text('Okay.');
      return typeof next === 'function' ? next(req) : next;
    } } },
  };
}

/** Stand-in for Sarvam: scripted transcripts, 100 ms of audio per spoken sentence. */
function fakeSpeech(transcripts) {
  const spoken = [];
  return {
    spoken,
    transcribe: async () => transcripts.shift() ?? { text: '', language: null },
    synthesize: async (t, language, speaker) => { spoken.push({ text: t, language, speaker }); return tone(100); },
  };
}

async function start({ claude, speech, token, clinicFields = {}, timings = {} }) {
  const ctx = setup();
  ctx.store.updateClinic(ctx.clinic.id, { voice_number: '+914440001234', voice_languages: 'ta-IN,en-IN', ...clinicFields });
  const app = createApp({ ...ctx, anthropic: claude, sessionSecret: 's', speechEnabled: true });
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  sockets.push(attachExotel(server, {
    ...ctx, anthropic: claude, speech, streamToken: token, sessionSecret: 's',
    timings: { fillerAfterMs: 5000, silenceRepromptMs: 60_000, ...timings },
  }));
  const port = server.address().port;
  return { ...ctx, port, base: `http://127.0.0.1:${port}` };
}

/** A fake Exotel: connects, echoes marks (as if audio played instantly), records everything. */
function dial(t, { query = 'clinic=demo', from = '+919876543210', to = '04440001234', echoMarks = true, headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}/exotel/stream?${query}`, { headers });
  const received = [];
  const callSid = `CA${Math.random().toString(16).slice(2)}`;
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    received.push(msg);
    if (msg.event === 'mark' && echoMarks) ws.send(JSON.stringify(msg));
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const speak = (pcm) => {
    for (let i = 0; i < pcm.length; i += 3200) send({ event: 'media', stream_sid: 'S1', media: { payload: pcm.subarray(i, i + 3200).toString('base64') } });
  };
  return {
    ws, received, closed, callSid, send,
    async connect() {
      await opened;
      send({ event: 'connected' });
      send({ event: 'start', start: { stream_sid: 'S1', call_sid: callSid, account_sid: 'A1', from, to } });
    },
    /** Caller says something: 600 ms of "speech" followed by a pause. */
    say: () => speak(Buffer.concat([tone(600), silence(1000)])),
    speak,
    count: (event) => received.filter((m) => m.event === event).length,
  };
}

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('Tamil caller books, then says bye in English', async () => {
  const script = [];
  const claude = fakeClaude(script);
  const speech = fakeSpeech([
    { text: 'நாளைக்கு Dr Test கிட்ட appointment வேணும்', language: 'ta-IN' },
    { text: 'Thank you, bye', language: 'en-IN' },
  ]);
  const t = await start({ claude, speech });
  const { days } = t.scheduler.findSlots(t.clinic, t.doctor.id, {});
  const slot = `${days[0].date}T${days[0].times[0]}`;
  script.push(
    tool('book_appointment', { doctor_id: t.doctor.id, start: slot, patient_name: 'Meena', patient_phone: '+919876543210' }),
    text('சரி, உங்க appointment புக் ஆகிடுச்சு. உங்க code K 7 M. வேற ஏதாவது வேணுமா?'),
    tool('end_call'),
    text('Thank you for calling. Goodbye!'),
  );

  const call = dial(t);
  await call.connect();
  await until(() => speech.spoken.length >= 1);
  assert.equal(speech.spoken[0].language, 'ta-IN'); // greets in the clinic's first language
  assert.match(speech.spoken[0].text, /Test Clinic/);
  assert.equal(speech.spoken[0].speaker, 'kavitha');
  await until(() => call.count('media') > 0); // greeting audio streamed to the caller

  call.say();
  await until(() => speech.spoken.some((s) => s.text.includes('புக் ஆகிடுச்சு')));
  const tamilReply = speech.spoken.filter((s) => /புக்|code|வேற/.test(s.text));
  assert.ok(tamilReply.every((s) => s.language === 'ta-IN'));
  const sys = claude.requests[0].system.map((b) => b.text).join('\n');
  assert.match(sys, /Tamil on the phone/);
  assert.match(sys, /\+919876543210/);

  call.say();
  assert.equal(await call.closed, 1000); // assistant hung up
  assert.equal(speech.spoken.at(-1).language, 'en-IN');
  assert.equal(speech.spoken.at(-1).text, 'Goodbye!');

  const rec = t.store.getCall(call.callSid);
  assert.equal(rec.provider, 'exotel');
  assert.equal(rec.outcome, 'booked');
  assert.equal(rec.bookings, 1);
  assert.equal(rec.language, 'en-IN');
  assert.equal(rec.status, 'ended');
  assert.equal((await fetch(`${t.base}/exotel/next?CallSid=${call.callSid}`)).status, 404); // no transfer
});

test('caller can interrupt the assistant (barge-in)', async () => {
  const t = await start({ claude: fakeClaude([]), speech: fakeSpeech([]) });
  const call = dial(t, { echoMarks: false }); // greeting never finishes playing
  await call.connect();
  await until(() => call.count('media') > 0);
  call.speak(tone(500));
  await until(() => call.count('clear') === 1);
  call.ws.close();
});

test('transfer to front desk: stream closes and /exotel/next says 200', async () => {
  const claude = fakeClaude([tool('transfer_to_front_desk', { reason: 'asked for a person' }), text('Connecting you now.')]);
  const t = await start({ claude, speech: fakeSpeech([{ text: 'Can I talk to a person', language: 'en-IN' }]), clinicFields: { transfer_number: '+914440009999' } });
  const call = dial(t);
  await call.connect();
  await until(() => call.count('mark') >= 1);
  call.say();
  await call.closed;
  assert.equal(t.store.getCall(call.callSid).outcome, 'transferred');
  const next = await fetch(`${t.base}/exotel/next?CallSid=${call.callSid}`);
  assert.equal(next.status, 200);
});

test('"one moment" filler while the AI is slow', async () => {
  const speech = fakeSpeech([{ text: 'appointment venum', language: 'ta-IN' }]);
  const t = await start({ claude: fakeClaude([text('சொல்லுங்க.')], { delayMs: 300 }), speech, timings: { fillerAfterMs: 50 } });
  const call = dial(t);
  await call.connect();
  await until(() => call.count('mark') >= 1);
  call.say();
  await until(() => speech.spoken.some((s) => s.text === 'சொல்லுங்க.'));
  const i = speech.spoken.findIndex((s) => s.text === 'ஒரு நிமிடம் காத்திருங்கள்.');
  assert.ok(i > 0 && i < speech.spoken.findIndex((s) => s.text === 'சொல்லுங்க.'));
  call.ws.close();
});

test('silent caller: reprompt, then goodbye', async () => {
  const speech = fakeSpeech([]);
  const t = await start({ claude: fakeClaude([]), speech, timings: { silenceRepromptMs: 80 } });
  const call = dial(t);
  await call.connect();
  await call.closed;
  assert.ok(speech.spoken.some((s) => s.text.includes('லைனில்')));
  assert.ok(speech.spoken.at(-1).text.includes('வணக்கம்'));
  assert.equal(t.store.getCall(call.callSid).outcome, 'no_input');
});

test('noise that transcribes to nothing is ignored, and the silence timer keeps running', async () => {
  const claude = fakeClaude([]);
  const speech = fakeSpeech([{ text: '', language: null }]);
  const t = await start({ claude, speech, timings: { silenceRepromptMs: 300 } });
  const call = dial(t);
  await call.connect();
  await until(() => call.count('mark') >= 1);
  call.say();
  await call.closed; // reprompt, then goodbye
  assert.equal(claude.requests.length, 0);
  assert.equal(t.store.getCall(call.callSid).outcome, 'no_input');
});

test('clinic is found by the dialled number when no clinic is in the URL', async () => {
  const speech = fakeSpeech([]);
  const t = await start({ claude: fakeClaude([]), speech });
  const call = dial(t, { query: '', to: '04440001234' });
  await call.connect();
  await until(() => speech.spoken.length > 0);
  assert.match(speech.spoken[0].text, /Test Clinic/);
  call.ws.close();
  const unknown = dial(t, { query: '', to: '01100000000' });
  await unknown.connect();
  await unknown.closed;
});

test('stream requires the token; dashboard test calls need a login', async () => {
  const t = await start({ claude: fakeClaude([]), speech: fakeSpeech([]), token: 'secret-token' });
  await assert.rejects(dial(t).connect(), /401/);
  const ok = dial(t, { query: 'clinic=demo&token=secret-token' });
  await ok.connect();
  ok.ws.close();

  await assert.rejects(dial(t, { query: 'clinic=demo&test=1' }).connect(), /401/);
  const login = await fetch(`${t.base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'demo', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const testCall = dial(t, { query: 'clinic=demo&test=1', headers: { cookie } });
  await testCall.connect();
  await until(() => testCall.received.some((m) => m.event === 'debug' && m.kind === 'assistant'));
  testCall.ws.close();
  await until(() => t.store.listCalls(t.clinic.id).some((c) => c.provider === 'test'));
});
