// Usage: npm run create-clinic -- --slug sunrise --name "Sunrise Clinic" --timezone Asia/Kolkata \
//          --password "a-long-password" [--phone "+91 ..."] [--address "..."] [--emergency 112]
//          [--voice-number +9144...] [--transfer +9144...] [--languages ta-IN,en-IN] [--speaker kavitha]
//          [--language en-US --voice Polly.Joanna-Neural]   (Twilio, outside India)
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth.js';
import { createStore, openDb } from '../src/db.js';
import { isValidTimeZone } from '../src/time.js';

const { values: v } = parseArgs({
  options: {
    slug: { type: 'string' }, name: { type: 'string' }, timezone: { type: 'string' },
    password: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' },
    emergency: { type: 'string' }, 'voice-number': { type: 'string' }, transfer: { type: 'string' },
    language: { type: 'string' }, voice: { type: 'string' }, languages: { type: 'string' }, speaker: { type: 'string' },
  },
});
if (!v.slug || !v.name || !v.timezone || !v.password) {
  console.error('Required: --slug --name --timezone --password');
  process.exit(1);
}
if (!/^[a-z0-9-]{2,40}$/.test(v.slug)) { console.error('slug: lowercase letters, digits and dashes'); process.exit(1); }
if (!isValidTimeZone(v.timezone)) { console.error(`Unknown time zone ${v.timezone}`); process.exit(1); }
for (const k of ['voice-number', 'transfer']) {
  if (v[k] && !/^\+[1-9]\d{6,14}$/.test(v[k])) { console.error(`--${k} must be in international format, e.g. +918040001234`); process.exit(1); }
}
if (v.languages && v.languages.split(',').some((l) => !['ta-IN', 'en-IN'].includes(l.trim()))) {
  console.error('--languages must be a comma list of ta-IN and/or en-IN'); process.exit(1);
}
if (v.password.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }

const store = createStore(openDb());
const clinic = store.createClinic({
  slug: v.slug, name: v.name, timezone: v.timezone, phone: v.phone, address: v.address,
  emergency_number: v.emergency, password_hash: hashPassword(v.password),
});
store.updateClinic(clinic.id, {
  ...(v['voice-number'] && { voice_number: v['voice-number'] }),
  ...(v.transfer && { transfer_number: v.transfer }),
  ...(v.language && { voice_language: v.language }),
  ...(v.voice && { voice_name: v.voice }),
  ...(v.languages && { voice_languages: v.languages }),
  ...(v.speaker && { voice_speaker: v.speaker }),
});
console.log(`Created clinic "${clinic.name}" (id ${clinic.id}).`);
console.log(`Patient chat:  /c/${clinic.slug}\nBooking form:  /c/${clinic.slug}/book\nAdmin login:   /admin  (clinic ID: ${clinic.slug})`);
if (v['voice-number']) console.log(`Phone line:    ${v['voice-number']} (connect it in Exotel or Twilio, see VOICE.md)`);
console.log('Next: log in to /admin and add doctors with their working hours.');
