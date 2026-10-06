import { randomInt } from 'node:crypto';
import { transaction } from './db.js';
import {
  addDays, formatLocal, fromMinutes, isValidDateStr, toMinutes, utcToZoned, weekdayOf, zonedToUtc,
} from './time.js';

export const MAX_SEARCH_DAYS = 14;

/** An error whose message is safe to show to patients (and to the AI). */
export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function newConfirmationCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/\D/g, '');
  return (s.startsWith('+') ? '+' : '') + digits;
}

function phonesMatch(a, b) {
  const da = normalizePhone(a).replace(/\D/g, '');
  const db = normalizePhone(b).replace(/\D/g, '');
  if (da.length < 7 || db.length < 7) return false;
  // Tolerate a missing country code / trunk prefix by comparing the last 10 digits.
  return da.slice(-10) === db.slice(-10);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validatePatient({ name, phone, email, reason }) {
  const cleanName = String(name ?? '').trim();
  if (cleanName.length < 2 || cleanName.length > 100) {
    throw new BookingError('INVALID_NAME', "Please provide the patient's full name.");
  }
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.replace(/\D/g, '').length < 7 || cleanPhone.length > 20) {
    throw new BookingError('INVALID_PHONE', 'Please provide a valid phone number.');
  }
  const cleanEmail = String(email ?? '').trim();
  if (cleanEmail && (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 200)) {
    throw new BookingError('INVALID_EMAIL', 'That email address does not look valid.');
  }
  const cleanReason = String(reason ?? '').trim().slice(0, 500);
  return { name: cleanName, phone: cleanPhone, email: cleanEmail, reason: cleanReason };
}

function overlaps(startMs, endMs, ranges) {
  return ranges.some((r) => startMs < Date.parse(r.end_at) && Date.parse(r.start_at) < endMs);
}

export function createScheduler(store, { notify = () => {} } = {}) {
  function requireDoctor(clinic, doctorId) {
    const doctor = store.getDoctor(clinic.id, Number(doctorId));
    if (!doctor || !doctor.active) throw new BookingError('UNKNOWN_DOCTOR', 'That doctor was not found.');
    return doctor;
  }

  /**
   * Open slots for a doctor between two local dates (inclusive), grouped by date.
   * Returns [{ date: "YYYY-MM-DD", weekday, times: ["09:00", ...] }].
   */
  function findSlots(clinic, doctorId, { fromDate, toDate, now = new Date() } = {}) {
    const doctor = requireDoctor(clinic, doctorId);
    const tz = clinic.timezone;
    const today = utcToZoned(now, tz).date;
    let from = fromDate && isValidDateStr(fromDate) ? fromDate : today;
    if (from < today) from = today;
    let to = toDate && isValidDateStr(toDate) ? toDate : addDays(from, 6);
    if (to < from) to = from;
    if (to > addDays(from, MAX_SEARCH_DAYS - 1)) to = addDays(from, MAX_SEARCH_DAYS - 1);

    const earliest = now.getTime() + clinic.min_notice_minutes * 60000;
    const latest = now.getTime() + clinic.booking_horizon_days * 86400000;
    const rangeStart = zonedToUtc(`${from}T00:00`, tz).toISOString();
    const rangeEnd = zonedToUtc(`${addDays(to, 1)}T00:00`, tz).toISOString();
    const busy = [
      ...store.activeAppointments(doctor.id, rangeStart, rangeEnd),
      ...store.listTimeOff(doctor.id, rangeStart, rangeEnd),
    ];
    const slotMs = doctor.slot_minutes * 60000;

    const days = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const weekday = weekdayOf(date);
      const times = [];
      for (const [s, e] of doctor.working_hours[weekday] ?? []) {
        const endMin = toMinutes(e);
        for (let m = toMinutes(s); m + doctor.slot_minutes <= endMin; m += doctor.slot_minutes) {
          const time = fromMinutes(m);
          const start = zonedToUtc(`${date}T${time}`, tz).getTime();
          // Skip wall-clock times that don't exist (DST gap) - they map to a different local time.
          if (utcToZoned(new Date(start), tz).time !== time) continue;
          if (start < earliest || start > latest) continue;
          if (overlaps(start, start + slotMs, busy)) continue;
          times.push(time);
        }
      }
      if (times.length) days.push({ date, weekday, times });
    }
    return { doctor, from, to, days };
  }

  function describe(clinic, appt) {
    const doctor = store.getDoctor(clinic.id, appt.doctor_id);
    return {
      confirmation_code: appt.code,
      status: appt.status,
      doctor: doctor?.name ?? 'Unknown',
      doctor_id: appt.doctor_id,
      when: formatLocal(new Date(appt.start_at), clinic.timezone),
      start_local: utcToZoned(new Date(appt.start_at), clinic.timezone).local,
      patient_name: appt.patient_name,
      reason: appt.reason,
    };
  }

  function assertSlotOpen(clinic, doctorId, startLocal, now) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(startLocal ?? ''));
    if (!m) throw new BookingError('INVALID_TIME', 'Time must be in the form YYYY-MM-DDTHH:mm.');
    const [, date, time] = m;
    const { doctor, days } = findSlots(clinic, doctorId, { fromDate: date, toDate: date, now });
    // findSlots clamps out-of-range dates, so check the day it returned is the one asked for.
    if (days[0]?.date !== date || !days[0].times.includes(time)) {
      throw new BookingError('SLOT_UNAVAILABLE', 'That time is not available. Please choose another open slot.');
    }
    const start = zonedToUtc(`${date}T${time}`, clinic.timezone);
    const end = new Date(start.getTime() + doctor.slot_minutes * 60000);
    return { doctor, startIso: start.toISOString(), endIso: end.toISOString() };
  }

  function book(clinic, { doctorId, startLocal, patient, reason, source = 'assistant', now = new Date() }) {
    const p = validatePatient({ ...patient, reason });
    const appt = transaction(store.db, () => {
      const { doctor, startIso, endIso } = assertSlotOpen(clinic, doctorId, startLocal, now);
      try {
        return store.insertAppointment({
          clinic_id: clinic.id, doctor_id: doctor.id, code: newConfirmationCode(),
          patient_name: p.name, patient_phone: p.phone, patient_email: p.email, reason: p.reason,
          start_at: startIso, end_at: endIso, source,
        });
      } catch (err) {
        if (/UNIQUE/i.test(err.message)) {
          throw new BookingError('SLOT_UNAVAILABLE', 'That slot was just taken. Please choose another time.');
        }
        throw err;
      }
    });
    notify({ type: 'appointment.booked', clinic, appointment: appt, details: describe(clinic, appt) });
    return describe(clinic, appt);
  }

  function findOwned(clinic, code, phone) {
    const appt = store.getAppointmentByCode(clinic.id, String(code ?? '').trim().toUpperCase());
    if (!appt || !phonesMatch(appt.patient_phone, phone)) {
      throw new BookingError('NOT_FOUND',
        'No appointment matches that confirmation code and phone number.');
    }
    return appt;
  }

  function lookup(clinic, { code, phone }) {
    return describe(clinic, findOwned(clinic, code, phone));
  }

  function cancel(clinic, { code, phone, now = new Date() }) {
    const appt = findOwned(clinic, code, phone);
    if (appt.status !== 'booked') throw new BookingError('NOT_ACTIVE', `This appointment is already ${appt.status}.`);
    if (Date.parse(appt.start_at) <= now.getTime()) {
      throw new BookingError('IN_PAST', 'This appointment has already started or passed.');
    }
    const updated = store.setAppointmentStatus(appt.id, 'cancelled');
    notify({ type: 'appointment.cancelled', clinic, appointment: updated, details: describe(clinic, updated) });
    return describe(clinic, updated);
  }

  function reschedule(clinic, { code, phone, newStartLocal, doctorId, now = new Date() }) {
    const updated = transaction(store.db, () => {
      const appt = findOwned(clinic, code, phone);
      if (appt.status !== 'booked') throw new BookingError('NOT_ACTIVE', `This appointment is already ${appt.status}.`);
      if (Date.parse(appt.start_at) <= now.getTime()) {
        throw new BookingError('IN_PAST', 'This appointment has already started or passed.');
      }
      const targetDoctor = doctorId ?? appt.doctor_id;
      const { doctor, startIso, endIso } = assertSlotOpen(clinic, targetDoctor, newStartLocal, now);
      store.db.prepare('UPDATE appointments SET doctor_id = ? WHERE id = ?').run(doctor.id, appt.id);
      return store.moveAppointment(appt.id, startIso, endIso);
    });
    notify({ type: 'appointment.rescheduled', clinic, appointment: updated, details: describe(clinic, updated) });
    return describe(clinic, updated);
  }

  return { findSlots, book, lookup, cancel, reschedule, describe };
}
