import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWav, encodeWav, resample, rms } from '../src/voice/audio.js';
import { clinicLanguages, languageOfText, phrase, sentences } from '../src/voice/languages.js';
import { Vad } from '../src/voice/vad.js';
import { silence, tone } from './helpers.js';


test('wav round trip and resampling', () => {
  const pcm = tone(100);
  const back = decodeWav(encodeWav(pcm, 8000));
  assert.equal(back.sampleRate, 8000);
  assert.deepEqual(back.pcm, pcm);
  const up = resample(pcm, 8000, 16000);
  assert.equal(up.length, pcm.length * 2);
  assert.ok(Math.abs(rms(up) - rms(pcm)) / rms(pcm) < 0.05);
  assert.throws(() => decodeWav(Buffer.from('nope')), /Not a WAV/);
});

test('VAD finds an utterance between silences', () => {
  const starts = [];
  const utterances = [];
  const vad = new Vad({ onSpeechStart: () => starts.push(1), onUtterance: (a) => utterances.push(a) });
  vad.push(silence(500));
  vad.push(tone(600));
  vad.push(silence(1000));
  assert.equal(starts.length, 1);
  assert.equal(utterances.length, 1);
  const ms = utterances[0].length / 16;
  assert.ok(ms >= 600 && ms <= 600 + 300 + 800, `utterance ${ms}ms`);
});

test('VAD ignores clicks and quiet noise', () => {
  const utterances = [];
  const vad = new Vad({ onUtterance: (a) => utterances.push(a) });
  vad.push(tone(2000, 100)); // line hiss
  vad.push(tone(40)); // click
  vad.push(silence(1000));
  assert.equal(utterances.length, 0);
});

test('VAD needs longer speech to interrupt the assistant', () => {
  const starts = [];
  const vad = new Vad({ onSpeechStart: () => starts.push(1) });
  vad.assistantTalking = true;
  vad.push(tone(160));
  vad.push(silence(1000));
  assert.equal(starts.length, 0);
  vad.push(tone(400));
  assert.equal(starts.length, 1);
});

test('languages helpers', () => {
  assert.deepEqual(clinicLanguages({ voice_languages: 'ta-IN,en-IN' }), ['ta-IN', 'en-IN']);
  assert.deepEqual(clinicLanguages({ voice_languages: 'xx-XX' }), ['en-IN']);
  assert.equal(languageOfText('சரி, appointment புக் ஆகிடுச்சு'), 'ta-IN');
  assert.equal(languageOfText('Your code is K 7 M'), 'en-IN');
  assert.equal(languageOfText('123', 'ta-IN'), 'ta-IN');
  assert.deepEqual(sentences('Dr. Test is free at ten. Shall I book it? வணக்கம்.'),
    ['Dr. Test is free at ten.', 'Shall I book it?', 'வணக்கம்.']);
  const clinic = { name: 'Test Clinic', emergency_number: '112', phone: '' };
  assert.match(phrase('ta-IN', 'greeting', { clinic, others: ['ta-IN', 'en-IN'] }), /Test Clinic.*112.*ஆங்கிலத்திலோ/);
  assert.match(phrase('en-IN', 'greeting', { clinic, others: ['en-IN', 'ta-IN'] }), /English or Tamil/);
  assert.match(phrase('xx', 'oneMoment'), /One moment/);
});
