import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendlyError, runVoiceCheck } from '../src/voice/diagnostics.js';
import { tone } from './helpers.js';

const clinic = { voice_speaker: 'kavitha' };

test('friendlyError explains common failures', () => {
  assert.match(friendlyError({ status: 401, message: 'invalid x-api-key' }, 'Claude'), /Claude rejected the API key \(401\)/);
  assert.match(friendlyError({ statusCode: 429, body: { message: 'quota' } }, 'Sarvam'), /out of credits or rate limited.*quota/);
  assert.match(friendlyError({ statusCode: 400, body: { error: { message: 'bad speaker' } } }, 'Sarvam'), /rejected the request \(400\): bad speaker/);
  assert.match(friendlyError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'Sarvam'), /could not reach Sarvam/);
  assert.match(friendlyError({ status: 503, message: 'down' }, 'Claude'), /server error \(503\)/);
});

test('voice check reports each step', async () => {
  const anthropic = { beta: { messages: { create: async () => ({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }] }) } } };
  const speech = {
    synthesize: async () => tone(800),
    transcribe: async () => ({ text: 'வணக்கம், நாளைக்கு appointment வேணும்', language: 'ta-IN' }),
  };
  const steps = await runVoiceCheck({ anthropic, model: 'claude-opus-5-5', speech, clinic });
  assert.deepEqual(steps.map((s) => s.ok), [true, true, true]);
  assert.match(steps[2].detail, /ta-IN/);
});

test('voice check names missing keys and failing services', async () => {
  const none = await runVoiceCheck({ anthropic: null, speech: null, clinic });
  assert.ok(none.every((s) => !s.ok));
  assert.match(none[0].error, /ANTHROPIC_API_KEY/);
  assert.match(none[1].error, /SARVAM_API_KEY/);

  const badClaude = { beta: { messages: { create: async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); } } } };
  const badSarvam = { synthesize: async () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); }, transcribe: async () => ({}) };
  const steps = await runVoiceCheck({ anthropic: badClaude, model: 'm', speech: badSarvam, clinic });
  assert.match(steps[0].error, /Claude rejected the API key/);
  assert.match(steps[1].error, /Sarvam rejected the API key \(403\)/);
  assert.match(steps[2].error, /Skipped/);
});
