import { SarvamAIClient } from 'sarvamai';
import { PHONE_RATE, decodeWav, encodeWav, resample } from './audio.js';

// Speech-to-text and text-to-speech for Indian languages via Sarvam AI.
//   STT: saaras:v3 in "codemix" mode with automatic language detection, so a caller can
//        speak Tamil, English or a mix ("appointment venum") and English words stay in English.
//   TTS: bulbul:v3 at 8 kHz, the phone line's native rate.

export const STT_MODEL = process.env.SARVAM_STT_MODEL || 'saaras:v3';
export const TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v3';
export const DEFAULT_SPEAKER = 'kavitha';

export function createSarvamSpeech({ apiKey = process.env.SARVAM_API_KEY, client } = {}) {
  const sarvam = client ?? new SarvamAIClient({ apiSubscriptionKey: apiKey });

  return {
    /** pcm: 16-bit mono at 8 kHz. Returns { text, language } (language is a BCP-47 code or null). */
    async transcribe(pcm) {
      const wav = encodeWav(resample(pcm, PHONE_RATE, 16000), 16000); // Sarvam works best at 16 kHz
      const res = await sarvam.speechToText.transcribe({
        file: { data: wav, filename: 'utterance.wav', contentType: 'audio/wav' },
        model: STT_MODEL,
        mode: 'codemix',
        language_code: 'unknown',
      });
      return { text: (res.transcript ?? '').trim(), language: res.language_code || null };
    },

    /** Returns 16-bit mono PCM at 8 kHz. */
    async synthesize(text, language, speaker = DEFAULT_SPEAKER) {
      const res = await sarvam.textToSpeech.convert({
        text,
        language_code: language,
        speaker,
        model: TTS_MODEL,
        speech_sample_rate: PHONE_RATE,
        output_audio_codec: 'wav',
      });
      const { pcm, sampleRate } = decodeWav(Buffer.from(res.audios[0], 'base64'));
      return resample(pcm, sampleRate, PHONE_RATE);
    },
  };
}
