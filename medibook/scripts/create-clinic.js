// Usage: npm run create-clinic -- --slug sunrise --name "Sunrise Clinic" --timezone Asia/Kolkata \
//          --password "a-long-password" [--phone "+91 ..."] [--address "..."] [--emergency 112]
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth.js';
import { createStore, openDb } from '../src/db.js';
import { isValidTimeZone } from '../src/time.js';

const { values: v } = parseArgs({
  options: {
    slug: { type: 'string' }, name: { type: 'string' }, timezone: { type: 'string' },
    password: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' },
    emergency: { type: 'string' },
  },
});
if (!v.slug || !v.name || !v.timezone || !v.password) {
  console.error('Required: --slug --name --timezone --password');
  process.exit(1);
}
if (!/^[a-z0-9-]{2,40}$/.test(v.slug)) { console.error('slug: lowercase letters, digits and dashes'); process.exit(1); }
if (!isValidTimeZone(v.timezone)) { console.error(`Unknown time zone ${v.timezone}`); process.exit(1); }
if (v.password.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }

const store = createStore(openDb());
const clinic = store.createClinic({
  slug: v.slug, name: v.name, timezone: v.timezone, phone: v.phone, address: v.address,
  emergency_number: v.emergency, password_hash: hashPassword(v.password),
});
console.log(`Created clinic "${clinic.name}" (id ${clinic.id}).`);
console.log(`Patient chat:  /c/${clinic.slug}\nBooking form:  /c/${clinic.slug}/book\nAdmin login:   /admin  (clinic ID: ${clinic.slug})`);
console.log('Next: log in to /admin and add doctors with their working hours.');
