// Creates a demo clinic with two doctors. Usage: npm run seed
import { hashPassword } from '../src/auth.js';
import { createStore, openDb } from '../src/db.js';

const store = createStore(openDb());
if (store.getClinicBySlug('demo')) {
  console.log('Demo clinic already exists. Delete medibook.db to reseed.');
  process.exit(0);
}
const password = process.env.DEMO_PASSWORD || 'demo-password-123';
const clinic = store.createClinic({
  slug: 'demo',
  name: 'Sunrise Family Clinic',
  timezone: process.env.DEMO_TIMEZONE || 'Asia/Kolkata',
  phone: '+91 80 4000 1234',
  address: '12 MG Road, Bengaluru',
  emergency_number: '112',
  assistant_notes: 'Consultation fee is 500 rupees, payable at the clinic. Free parking behind the building. Please arrive 10 minutes early with any previous reports.',
  password_hash: hashPassword(password),
});
const weekdays = (ranges) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, ranges]));
store.createDoctor(clinic.id, {
  name: 'Dr. Priya Sharma', specialty: 'General Physician', slot_minutes: 15,
  bio: 'Family medicine, fevers, check-ups, chronic conditions.',
  working_hours: { ...weekdays([['09:00', '13:00'], ['16:00', '19:00']]), sat: [['09:00', '13:00']] },
});
store.createDoctor(clinic.id, {
  name: 'Dr. Arjun Mehta', specialty: 'Pediatrician', slot_minutes: 20,
  bio: 'Children from newborns to 16 years, vaccinations.',
  working_hours: { mon: [['10:00', '14:00']], wed: [['10:00', '14:00']], fri: [['15:00', '19:00']] },
});
console.log(`Demo clinic created.\n  Patient chat: /c/demo\n  Admin: /admin  clinic ID "demo", password "${password}"`);
