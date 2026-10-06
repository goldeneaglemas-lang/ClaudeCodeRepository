import { BookingError } from '../scheduling.js';

// Tool definitions exposed to Claude. Inputs are re-validated by the scheduler,
// so the model can never book a slot the clinic's rules don't allow.
export const TOOLS = [
  {
    name: 'list_doctors',
    description:
      'List the doctors at this clinic with their id, specialty and appointment length. ' +
      'Use this to match the patient to a doctor if you are unsure.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_available_slots',
    description:
      'Find open appointment times for one doctor between two dates (inclusive, at most 14 days). ' +
      'Dates and returned times are in the clinic\'s local time zone. Always call this before offering times; ' +
      'never invent availability.',
    input_schema: {
      type: 'object',
      properties: {
        doctor_id: { type: 'integer' },
        from_date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        to_date: { type: 'string', description: 'YYYY-MM-DD, defaults to 6 days after from_date' },
      },
      required: ['doctor_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book an appointment. Only call this after the patient has explicitly confirmed the doctor, ' +
      'date and time, and you have their full name and phone number. Returns a confirmation code ' +
      'the patient must keep.',
    input_schema: {
      type: 'object',
      properties: {
        doctor_id: { type: 'integer' },
        start: { type: 'string', description: 'Local start time, YYYY-MM-DDTHH:mm, exactly as returned by find_available_slots' },
        patient_name: { type: 'string' },
        patient_phone: { type: 'string' },
        patient_email: { type: 'string', description: 'Optional' },
        reason: { type: 'string', description: 'Short, non-diagnostic reason for visit, in the patient\'s words' },
      },
      required: ['doctor_id', 'start', 'patient_name', 'patient_phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_appointment',
    description: 'Look up an existing appointment. Requires the confirmation code and the phone number used to book.',
    input_schema: {
      type: 'object',
      properties: {
        confirmation_code: { type: 'string' },
        patient_phone: { type: 'string' },
      },
      required: ['confirmation_code', 'patient_phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_appointment',
    description:
      'Cancel an appointment. Requires the confirmation code and the phone number used to book. ' +
      'Confirm with the patient before calling.',
    input_schema: {
      type: 'object',
      properties: {
        confirmation_code: { type: 'string' },
        patient_phone: { type: 'string' },
      },
      required: ['confirmation_code', 'patient_phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      'Move an existing appointment to a new open slot (optionally with a different doctor). ' +
      'Check availability first and confirm the new time with the patient before calling.',
    input_schema: {
      type: 'object',
      properties: {
        confirmation_code: { type: 'string' },
        patient_phone: { type: 'string' },
        new_start: { type: 'string', description: 'Local start time, YYYY-MM-DDTHH:mm' },
        doctor_id: { type: 'integer', description: 'Only if switching doctor' },
      },
      required: ['confirmation_code', 'patient_phone', 'new_start'],
      additionalProperties: false,
    },
  },
];

// Phone-only tools. The agent loop handles these itself (they control the call, not the schedule).
export const VOICE_CONTROL_TOOLS = [
  {
    name: 'transfer_to_front_desk',
    description:
      'Transfer the phone call to a human at the front desk. Use when the caller asks for a person, ' +
      'is upset, or needs something you cannot do.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Short reason, for staff' } },
      additionalProperties: false,
    },
  },
  {
    name: 'end_call',
    description: 'Hang up the phone call. Use only after the caller has said they need nothing else, or has said goodbye.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const MAX_SLOTS_RETURNED = 60;

/** Execute a tool call. Returns { content: string, isError: boolean }. */
export function executeTool({ scheduler, store, clinic, now }, name, input = {}) {
  try {
    const result = run();
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    if (err instanceof BookingError) {
      return { content: JSON.stringify({ error: err.code, message: err.message }), isError: true };
    }
    console.error(`[tool ${name}]`, err);
    return { content: JSON.stringify({ error: 'INTERNAL', message: 'Something went wrong. Please try again.' }), isError: true };
  }

  function run() {
    switch (name) {
      case 'list_doctors':
        return store.listDoctors(clinic.id).map((d) => ({
          id: d.id, name: d.name, specialty: d.specialty, bio: d.bio, appointment_minutes: d.slot_minutes,
          working_days: Object.keys(d.working_hours).filter((k) => d.working_hours[k]?.length),
        }));
      case 'find_available_slots': {
        const { doctor, from, to, days } = scheduler.findSlots(clinic, input.doctor_id, {
          fromDate: input.from_date, toDate: input.to_date, now,
        });
        let remaining = MAX_SLOTS_RETURNED;
        const trimmed = [];
        for (const d of days) {
          if (remaining <= 0) break;
          trimmed.push({ ...d, times: d.times.slice(0, remaining) });
          remaining -= d.times.length;
        }
        return {
          doctor: doctor.name, searched_from: from, searched_to: to, appointment_minutes: doctor.slot_minutes,
          days: trimmed,
          truncated: remaining < 0,
          note: days.length ? undefined : 'No openings in this range. Try later dates or another doctor.',
        };
      }
      case 'book_appointment':
        return scheduler.book(clinic, {
          doctorId: input.doctor_id,
          startLocal: input.start,
          patient: { name: input.patient_name, phone: input.patient_phone, email: input.patient_email },
          reason: input.reason,
          source: 'assistant',
          now,
        });
      case 'lookup_appointment':
        return scheduler.lookup(clinic, { code: input.confirmation_code, phone: input.patient_phone });
      case 'cancel_appointment':
        return scheduler.cancel(clinic, { code: input.confirmation_code, phone: input.patient_phone, now });
      case 'reschedule_appointment':
        return scheduler.reschedule(clinic, {
          code: input.confirmation_code, phone: input.patient_phone, newStartLocal: input.new_start,
          doctorId: input.doctor_id, now,
        });
      default:
        throw new BookingError('UNKNOWN_TOOL', `Unknown tool ${name}`);
    }
  }
}
