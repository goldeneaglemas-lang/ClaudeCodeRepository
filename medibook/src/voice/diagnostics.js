import { languageOfText } from './languages.js';

// Turns API and network errors into plain-language reasons, and runs a setup check
// (Claude, Sarvam text-to-speech, Sarvam speech-to-text) for the dashboard.

export function friendlyError(err, service) {
  const status = err?.status ?? err?.statusCode;
  const detail = String(err?.body?.error?.message ?? err?.body?.message ?? err?.error?.error?.message ?? err?.message ?? err)
    .replace(/\s+/g, ' ').slice(0, 300);
  const code = err?.code ?? err?.cause?.code;
  if (!status && (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code) || /fetch failed|network|timed? ?out/i.test(detail))) {
    return `the server could not reach ${service} (check the internet connection or firewall). ${detail}`;
  }
  if (status === 401 || status === 403) return `${service} rejected the API key (${status}). Check the key is correct and active. ${detail}`;
  if (status === 402 || status === 429) return `${service} refused the request (${status}): out of credits or rate limited. ${detail}`;
  if (status === 404) return `${service} says not found (404): the model or speaker name may be wrong. ${detail}`;
  if (status >= 400 && status < 500) return `${service} rejected the request (${status}): ${detail}`;
  if (status >= 500) return `${service} had a server error (${status}); try again in a minute. ${detail}`;
  return `${service}: ${detail}`;
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, error: err.friendly ?? String(err.message ?? err) };
  }
}

const wrap = (service, fn) => async () => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[voice-check] ${service}`, err);
    err.friendly = friendlyError(err, service);
    throw err;
  }
};

/** Check each piece the phone assistant needs. Spends a tiny amount of API credit. */
export async function runVoiceCheck({ anthropic, model, speech, clinic }) {
  const steps = [];
  steps.push(anthropic
    ? await step('Claude (AI conversation)', wrap('Claude', async () => {
      const res = await anthropic.beta.messages.create({
        model, max_tokens: 1024, output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      });
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return `model ${res.model} replied "${text.slice(0, 40)}"`;
    }))
    : { name: 'Claude (AI conversation)', ok: false, error: 'ANTHROPIC_API_KEY is not set on the server.' });

  if (!speech) {
    steps.push({ name: 'Sarvam voice (text-to-speech)', ok: false, error: 'SARVAM_API_KEY is not set on the server.' });
    steps.push({ name: 'Sarvam hearing (speech-to-text)', ok: false, error: 'SARVAM_API_KEY is not set on the server.' });
    return steps;
  }

  const sample = 'வணக்கம், நாளைக்கு appointment வேணும்.';
  let audio = null;
  steps.push(await step('Sarvam voice (text-to-speech)', wrap('Sarvam', async () => {
    audio = await speech.synthesize(sample, languageOfText(sample), clinic.voice_speaker || undefined);
    if (!audio?.length) throw Object.assign(new Error('empty audio'), { friendly: 'Sarvam returned no audio.' });
    return `${(audio.length / 16000).toFixed(1)} s of audio with voice "${clinic.voice_speaker}"`;
  })));
  steps.push(audio
    ? await step('Sarvam hearing (speech-to-text)', wrap('Sarvam', async () => {
      const { text, language } = await speech.transcribe(audio);
      return `heard "${text}" (${language ?? 'language unknown'})`;
    }))
    : { name: 'Sarvam hearing (speech-to-text)', ok: false, error: 'Skipped because text-to-speech failed.' });
  return steps;
}
