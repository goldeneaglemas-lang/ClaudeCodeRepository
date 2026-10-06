import { hashPassword } from '../src/auth.js';
import { createStore, openDb } from '../src/db.js';
import { createScheduler } from '../src/scheduling.js';

export const PASSWORD = 'test-password-123';

export function setup({ timezone = 'Asia/Kolkata' } = {}) {
  const store = createStore(openDb(':memory:'));
  const events = [];
  const scheduler = createScheduler(store, { notify: (e) => events.push(e) });
  const clinic = store.createClinic({
    slug: 'demo', name: 'Test Clinic', timezone, phone: '+91 80 1111 2222', emergency_number: '112',
    password_hash: hashPassword(PASSWORD),
  });
  const doctor = store.createDoctor(clinic.id, {
    name: 'Dr. Test', specialty: 'General Physician', slot_minutes: 30,
    working_hours: { mon: [['09:00', '11:00']], tue: [['09:00', '11:00'], ['14:00', '15:00']] },
  });
  return { store, scheduler, clinic, doctor, events };
}

// Monday 2026-10-05 08:00 in Asia/Kolkata (UTC+5:30).
export const MONDAY_8AM_IST = new Date('2026-10-05T02:30:00Z');

/** 8 kHz 16-bit PCM test tone (a stand-in for speech). */
export function tone(ms, amplitude = 8000, rate = 8000) {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 300 * i) / rate)), i * 2);
  return buf;
}
export const silence = (ms) => tone(ms, 0);
