// Talk to the phone assistant from your terminal, exactly as Twilio would drive it.
// Usage: npm run call -- [--clinic demo] [--from +919876543210] [--url http://localhost:3000]
// Type what the caller says; press Enter on an empty line to simulate silence; Ctrl+C hangs up.
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { twilioSignature } from '../src/voice/twiml.js';

const { values: v } = parseArgs({
  options: {
    clinic: { type: 'string', default: 'demo' },
    to: { type: 'string', default: '' },
    from: { type: 'string', default: '+919876543210' },
    url: { type: 'string', default: process.env.SIM_URL || `http://localhost:${process.env.PORT || 3000}` },
  },
});

const callSid = `CA${randomBytes(16).toString('hex')}`;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const signBase = (process.env.PUBLIC_BASE_URL || v.url).replace(/\/$/, '');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();

/** Next thing the caller says, or null if input ended (works when typing or piping a script). */
async function ask() {
  process.stdout.write('🗣️  You: ');
  const { value, done } = await lines.next();
  if (done) return null;
  if (!process.stdin.isTTY) process.stdout.write(`${value}\n`);
  return value;
}
const startedAt = Date.now();

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function post(path, params) {
  const body = { CallSid: callSid, From: v.from, To: v.to, AccountSid: 'ACsimulator', ...params };
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (authToken) headers['X-Twilio-Signature'] = twilioSignature(authToken, signBase + path, body);
  const res = await fetch(v.url + path, { method: 'POST', headers, body: new URLSearchParams(body) });
  if (res.status === 204) return '';
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text;
}

async function hangUp() {
  await post('/voice/status', { CallStatus: 'completed', CallDuration: String(Math.round((Date.now() - startedAt) / 1000)) }).catch(() => {});
  rl.close();
}

let path = `/voice/incoming${v.to ? '' : `?clinic=${encodeURIComponent(v.clinic)}`}`;
let params = {};
console.log(`📞 Calling ${v.to || `clinic "${v.clinic}"`} from ${v.from} (CallSid ${callSid})\n`);
rl.on('SIGINT', async () => { console.log('\n📴 You hung up.'); await hangUp(); process.exit(0); });

while (true) {
  const xml = await post(path, params);
  for (const [, text] of xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)) console.log(`🤖 ${decode(text)}`);
  const dialTo = /<Dial[^>]*>([\s\S]*?)<\/Dial>/.exec(xml);
  if (dialTo) { console.log(`\n☎️  [Transferring call to ${decode(dialTo[1])}]`); break; }
  if (/<Hangup\/>/.test(xml)) { console.log('\n📴 Assistant hung up.'); break; }
  const redirect = /<Redirect[^>]*>([\s\S]*?)<\/Redirect>/.exec(xml);
  if (/<Gather/.test(xml)) {
    const action = decode(/<Gather[^>]*action="([^"]+)"/.exec(xml)[1]);
    const said = await ask();
    if (said === null) { console.log('\n📴 You hung up.'); break; }
    path = action;
    params = { SpeechResult: said, Confidence: said ? '0.9' : '0' };
  } else if (redirect) {
    path = decode(redirect[1]);
    params = {};
  } else {
    console.log('(no further instructions; call ended)');
    break;
  }
}
await hangUp();
