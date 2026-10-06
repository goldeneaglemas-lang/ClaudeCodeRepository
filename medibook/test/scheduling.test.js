import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookingError } from '../src/scheduling.js';
import { MONDAY_8AM_IST, setup } from './helpers.js';

const patient = { name: 'Asha Rao', phone: '+91 98765 43210' };

test('findSlots follows working hours and slot length', () => {
  const { scheduler, clinic, doctor } = setup();
  const { days } = scheduler.findSlots(clinic, doctor.id, { fromDate: '2026-10-05', toDate: '2026-10-06', now: MONDAY_8AM_IST });
  assert.deepEqual(days, [
    { date: '2026-10-05', weekday: 'mon', times: ['09:00', '09:30', '10:00', '10:30'] },
    { date: '2026-10-06', weekday: 'tue', times: ['09:00', '09:30', '10:00', '10:30', '14:00', '14:30'] },
  ]);
});

test('min notice hides slots that are too soon', () => {
  const { scheduler, clinic, doctor } = setup();
  const now = new Date('2026-10-05T03:45:00Z'); // 09:15 local, 60 min notice -> first slot 10:30
  const { days } = scheduler.findSlots(clinic, doctor.id, { fromDate: '2026-10-05', toDate: '2026-10-05', now });
  assert.deepEqual(days[0].times, ['10:30']);
});

test('booking removes the slot, prevents double booking and notifies', () => {
  const { scheduler, clinic, doctor, events } = setup();
  const now = MONDAY_8AM_IST;
  const appt = scheduler.book(clinic, { doctorId: doctor.id, startLocal: '2026-10-05T09:30', patient, reason: 'Fever', now });
  assert.match(appt.confirmation_code, /^[A-Z2-9]{6}$/);
  assert.equal(appt.start_local, '2026-10-05T09:30');
  assert.equal(events[0].type, 'appointment.booked');

  const { days } = scheduler.findSlots(clinic, doctor.id, { fromDate: '2026-10-05', toDate: '2026-10-05', now });
  assert.ok(!days[0].times.includes('09:30'));

  assert.throws(
    () => scheduler.book(clinic, { doctorId: doctor.id, startLocal: '2026-10-05T09:30', patient, now }),
    (e) => e instanceof BookingError && e.code === 'SLOT_UNAVAILABLE',
  );
});

test('rejects off-grid, closed-day and past times', () => {
  const { scheduler, clinic, doctor } = setup();
  const now = MONDAY_8AM_IST;
  for (const startLocal of ['2026-10-05T09:15', '2026-10-07T09:00', '2026-10-04T09:00', '2026-10-05 9am']) {
    assert.throws(() => scheduler.book(clinic, { doctorId: doctor.id, startLocal, patient, now }), BookingError, startLocal);
  }
});

test('validates patient details', () => {
  const { scheduler, clinic, doctor } = setup();
  const base = { doctorId: doctor.id, startLocal: '2026-10-05T09:00', now: MONDAY_8AM_IST };
  assert.throws(() => scheduler.book(clinic, { ...base, patient: { name: 'A', phone: '9876543210' } }), /full name/);
  assert.throws(() => scheduler.book(clinic, { ...base, patient: { name: 'Asha', phone: '123' } }), /phone/);
  assert.throws(() => scheduler.book(clinic, { ...base, patient: { name: 'Asha', phone: '9876543210', email: 'x@' } }), /email/);
});

test('time off blocks slots', () => {
  const { store, scheduler, clinic, doctor } = setup();
  store.addTimeOff(doctor.id, '2026-10-05T03:30:00.000Z', '2026-10-05T04:30:00.000Z'); // 09:00-10:00 local
  const { days } = scheduler.findSlots(clinic, doctor.id, { fromDate: '2026-10-05', toDate: '2026-10-05', now: MONDAY_8AM_IST });
  assert.deepEqual(days[0].times, ['10:00', '10:30']);
});

test('lookup/cancel/reschedule require matching code and phone', () => {
  const { scheduler, clinic, doctor, events } = setup();
  const now = MONDAY_8AM_IST;
  const { confirmation_code: code } = scheduler.book(clinic, { doctorId: doctor.id, startLocal: '2026-10-05T10:00', patient, now });

  assert.throws(() => scheduler.lookup(clinic, { code, phone: '+91 11111 11111' }), /No appointment/);
  assert.equal(scheduler.lookup(clinic, { code: code.toLowerCase(), phone: '98765 43210' }).status, 'booked');

  const moved = scheduler.reschedule(clinic, { code, phone: patient.phone, newStartLocal: '2026-10-06T14:00', now });
  assert.equal(moved.start_local, '2026-10-06T14:00');
  // old slot is free again
  const { days } = scheduler.findSlots(clinic, doctor.id, { fromDate: '2026-10-05', toDate: '2026-10-05', now });
  assert.ok(days[0].times.includes('10:00'));

  const cancelled = scheduler.cancel(clinic, { code, phone: patient.phone, now });
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => scheduler.cancel(clinic, { code, phone: patient.phone, now }), /already cancelled/);
  assert.deepEqual(events.map((e) => e.type), ['appointment.booked', 'appointment.rescheduled', 'appointment.cancelled']);
});

test('clinics are isolated from each other', () => {
  const { store, scheduler, clinic, doctor } = setup();
  const other = store.createClinic({ slug: 'other', name: 'Other', timezone: 'UTC', password_hash: 'x' });
  assert.throws(() => scheduler.findSlots(other, doctor.id, {}), /doctor was not found/);
  const { confirmation_code: code } = scheduler.book(clinic, { doctorId: doctor.id, startLocal: '2026-10-05T09:00', patient, now: MONDAY_8AM_IST });
  assert.throws(() => scheduler.lookup(other, { code, phone: patient.phone }), /No appointment/);
});
