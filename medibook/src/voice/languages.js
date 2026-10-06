// Languages the phone assistant can speak (Sarvam AI speech for Indian languages).
// Fixed phrases are pre-written per language; the AI writes everything else itself.
// Tamil text should be reviewed by a native speaker before launch.

export const LANGUAGES = {
  'en-IN': {
    name: 'English',
    phrases: {
      greeting: ({ clinic, others }) =>
        `Hello, thank you for calling ${clinic.name}. I'm the automated booking assistant, and this call is transcribed. ` +
        `If this is a medical emergency, please hang up and dial ${clinic.emergency_number} now. ` +
        `${others.includes('ta-IN') ? 'You can speak in English or Tamil. ' : ''}How can I help you today?`,
      greetingAlso: () => 'You can also speak in English.',
      oneMoment: () => 'One moment please.',
      stillThere: () => 'Are you still there? How can I help you?',
      noInputBye: () => "I haven't heard anything, so I'll end the call now. Please call back any time. Goodbye.",
      sayAgain: () => "Sorry, I didn't catch that. Could you say that again?",
      troubleTransfer: () => "Sorry, I'm having trouble right now. Let me connect you to our front desk.",
      troubleBye: (clinic) => `Sorry, I'm having trouble right now.${clinic.phone ? ` Please call our front desk at ${clinic.phone}.` : ' Please call again in a few minutes.'} Goodbye.`,
      transferring: () => 'Connecting you to our front desk now.',
    },
  },
  'ta-IN': {
    name: 'Tamil',
    phrases: {
      greeting: ({ clinic, others }) =>
        `வணக்கம், ${clinic.name} க்கு அழைத்ததற்கு நன்றி. நான் தானியங்கி முன்பதிவு உதவியாளர். இந்த அழைப்பு எழுத்து வடிவில் பதிவு செய்யப்படும். ` +
        `அவசர மருத்துவ உதவி தேவை என்றால், உடனே அழைப்பைத் துண்டித்து ${clinic.emergency_number} க்கு அழைக்கவும். ` +
        `${others.includes('en-IN') ? 'நீங்கள் தமிழிலோ ஆங்கிலத்திலோ பேசலாம். ' : ''}உங்களுக்கு எப்படி உதவலாம்?`,
      greetingAlso: () => 'நீங்கள் தமிழிலும் பேசலாம்.',
      oneMoment: () => 'ஒரு நிமிடம் காத்திருங்கள்.',
      stillThere: () => 'நீங்கள் இன்னும் லைனில் இருக்கிறீர்களா? உங்களுக்கு எப்படி உதவலாம்?',
      noInputBye: () => 'எதுவும் கேட்கவில்லை, அதனால் அழைப்பை முடிக்கிறேன். எப்போது வேண்டுமானாலும் மீண்டும் அழைக்கலாம். நன்றி, வணக்கம்.',
      sayAgain: () => 'மன்னிக்கவும், சரியாகக் கேட்கவில்லை. மீண்டும் ஒருமுறை சொல்ல முடியுமா?',
      troubleTransfer: () => 'மன்னிக்கவும், ஒரு சிறிய சிக்கல். உங்களை எங்கள் வரவேற்பு மேசையுடன் இணைக்கிறேன்.',
      troubleBye: (clinic) => `மன்னிக்கவும், ஒரு சிறிய சிக்கல்.${clinic.phone ? ` தயவுசெய்து எங்கள் வரவேற்பு மேசையை ${clinic.phone} என்ற எண்ணில் அழைக்கவும்.` : ' சில நிமிடங்கள் கழித்து மீண்டும் அழைக்கவும்.'} நன்றி, வணக்கம்.`,
      transferring: () => 'உங்களை எங்கள் வரவேற்பு மேசையுடன் இணைக்கிறேன்.',
    },
  },
};

export const SUPPORTED_LANGUAGE_CODES = Object.keys(LANGUAGES);

/** Clinic's phone languages, primary first. Stored as "ta-IN,en-IN". */
export function clinicLanguages(clinic) {
  const list = String(clinic.voice_languages || '')
    .split(',').map((s) => s.trim()).filter((c) => LANGUAGES[c]);
  return list.length ? [...new Set(list)] : ['en-IN'];
}

export function phrase(language, key, ...args) {
  const lang = LANGUAGES[language] ?? LANGUAGES['en-IN'];
  return (lang.phrases[key] ?? LANGUAGES['en-IN'].phrases[key])(...args);
}

const TAMIL_SCRIPT = /[஀-௿]/;
const TAMIL_CHARS = /[஀-௿]/g;
const LATIN_WORDS = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

/**
 * Which language did the caller just speak? Decided from the transcript itself, not left to the AI.
 * - Any real amount of Tamil script means Tamil (Tamil speakers mix in English words: "appointment venum").
 * - A switch to English needs a real English sentence (4+ words); "OK", "yes", "thank you", or a
 *   phone number keep the current language, because Tamil callers say those too.
 */
export function detectCallerLanguage(text, { allowed = ['ta-IN', 'en-IN'], current = allowed[0] } = {}) {
  const tamil = (String(text).match(TAMIL_CHARS) ?? []).length;
  const latinWords = String(text).match(LATIN_WORDS) ?? [];
  const latinLetters = latinWords.join('').length;
  if (allowed.includes('ta-IN') && tamil > 0 && tamil / (tamil + latinLetters) >= 0.2) return 'ta-IN';
  if (allowed.includes('en-IN') && tamil === 0 && latinWords.length >= 4) return 'en-IN';
  return allowed.includes(current) ? current : allowed[0];
}

/** Per-turn instruction to the AI so it answers in the caller's language. */
export function replyLanguageInstruction(language) {
  if (language === 'ta-IN') {
    return 'The caller is speaking Tamil. Reply only in Tamil: everyday spoken Tamil in Tamil script, even if earlier replies were in English. ' +
      'Keep English words people normally use, like appointment or doctor, and English letters for codes and phone numbers.';
  }
  if (language === 'en-IN') return 'The caller is speaking English. Reply in English.';
  return null;
}

/** Which voice should read this text: Tamil script means Tamil, otherwise English. */
export function languageOfText(text, fallback = 'en-IN') {
  if (TAMIL_SCRIPT.test(text)) return 'ta-IN';
  if (/[A-Za-z]/.test(text)) return 'en-IN';
  return fallback;
}

/** Split a reply into sentences so the first one can start playing sooner. */
export function sentences(text) {
  const parts = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?।]+(?:[.!?।]+|$)/g) ?? [];
  // Merge very short fragments (e.g. "Dr.") into the next sentence.
  const out = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && out.at(-1).length < 12) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
