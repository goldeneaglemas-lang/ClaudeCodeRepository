import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAssistantTurn } from './assistant/agent.js';
import {
  SESSION_COOKIE, createSessionToken, hashPassword, parseCookies, readSessionToken, verifyPassword,
} from './auth.js';
import { BookingError } from './scheduling.js';
import { WEEKDAYS, addDays, isValidDateStr, isValidTimeZone, utcToZoned, zonedToUtc } from './time.js';
import { callSessionId, callTranscript, createVoiceRouter } from './voice/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_CHAT_MESSAGES = 120; // stored entries (user + assistant + tool results)
const MAX_MESSAGE_CHARS = 1000;

/** Fixed-window in-memory rate limiter. Swap for Redis when running multiple instances. */
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const n = (hits.get(k) ?? 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests, please slow down.' });
    next();
  };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validateWorkingHours(wh) {
  if (typeof wh !== 'object' || wh === null) throw new BookingError('INVALID', 'working_hours must be an object');
  const out = {};
  for (const [day, ranges] of Object.entries(wh)) {
    if (!WEEKDAYS.includes(day)) throw new BookingError('INVALID', `Unknown weekday "${day}"`);
    if (!Array.isArray(ranges)) throw new BookingError('INVALID', `Hours for ${day} must be a list`);
    out[day] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !r.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || r[0] >= r[1]) {
        throw new BookingError('INVALID', `Invalid hours for ${day}; use [["09:00","13:00"], ...]`);
      }
      return [r[0], r[1]];
    });
  }
  return out;
}

function validateDoctorInput(body, { partial = false } = {}) {
  const d = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (name.length < 2 || name.length > 100) throw new BookingError('INVALID', 'Doctor name is required');
    d.name = name;
  }
  if (body.specialty !== undefined) d.specialty = String(body.specialty).trim().slice(0, 100);
  if (body.bio !== undefined) d.bio = String(body.bio).trim().slice(0, 500);
  if (body.slot_minutes !== undefined) {
    const n = Number(body.slot_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 240) throw new BookingError('INVALID', 'slot_minutes must be 5-240');
    d.slot_minutes = n;
  }
  if (body.working_hours !== undefined) d.working_hours = validateWorkingHours(body.working_hours);
  if (body.active !== undefined) d.active = Boolean(body.active);
  return d;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function createApp({ store, scheduler, anthropic, sessionSecret, model, secureCookies = false, voice = {} }) {
  if (!sessionSecret) throw new Error('sessionSecret is required');
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Patient pages are embedded on clinic websites; everything else must not be framed.
    if (!req.path.startsWith('/c/')) res.set('X-Frame-Options', 'DENY');
    next();
  });

  // ---------- static pages ----------
  const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
  app.get('/', page('index.html'));
  app.get('/admin', page('admin.html'));
  app.get('/c/:slug', page('chat.html'));
  app.get('/c/:slug/book', page('book.html'));
  app.use('/static', express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
  app.get('/widget.js', page('widget.js'));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------- phone calls (Twilio webhooks) ----------
  app.use('/voice', createVoiceRouter({ store, scheduler, anthropic, model, ...voice }));

  // ---------- public patient API ----------
  const clinicFromSlug = (req, res, next) => {
    const clinic = store.getClinicBySlug(req.params.slug);
    if (!clinic) return res.status(404).json({ error: 'NOT_FOUND', message: 'Clinic not found' });
    req.clinic = clinic;
    next();
  };
  const patientLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const chatLimiter = rateLimit({ windowMs: 60_000, max: 20 });

  app.get('/api/c/:slug', clinicFromSlug, (req, res) => {
    const c = req.clinic;
    res.json({
      clinic: { slug: c.slug, name: c.name, phone: c.phone, address: c.address, timezone: c.timezone, emergency_number: c.emergency_number },
      doctors: store.listDoctors(c.id).map(({ id, name, specialty, bio, slot_minutes }) => ({ id, name, specialty, bio, slot_minutes })),
      ai_enabled: Boolean(anthropic),
    });
  });

  app.get('/api/c/:slug/slots', patientLimiter, clinicFromSlug, (req, res) => {
    res.json(scheduler.findSlots(req.clinic, req.query.doctor_id, { fromDate: req.query.from, toDate: req.query.to }).days);
  });

  app.post('/api/c/:slug/appointments', patientLimiter, clinicFromSlug, (req, res) => {
    const b = req.body ?? {};
    const appt = scheduler.book(req.clinic, {
      doctorId: b.doctor_id, startLocal: b.start, reason: b.reason, source: 'web_form',
      patient: { name: b.name, phone: b.phone, email: b.email },
    });
    res.status(201).json(appt);
  });

  app.post('/api/c/:slug/appointments/lookup', patientLimiter, clinicFromSlug, (req, res) => {
    res.json(scheduler.lookup(req.clinic, { code: req.body?.code, phone: req.body?.phone }));
  });

  app.post('/api/c/:slug/appointments/cancel', patientLimiter, clinicFromSlug, (req, res) => {
    res.json(scheduler.cancel(req.clinic, { code: req.body?.code, phone: req.body?.phone }));
  });

  app.post('/api/c/:slug/chat', chatLimiter, clinicFromSlug, asyncRoute(async (req, res) => {
    if (!anthropic) {
      return res.status(503).json({ error: 'AI_DISABLED', message: 'The AI assistant is not configured. Please use the booking form.' });
    }
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'EMPTY', message: 'Message is empty.' });
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: 'TOO_LONG', message: `Please keep messages under ${MAX_MESSAGE_CHARS} characters.` });
    }
    const sessionId = typeof req.body?.session_id === 'string' && req.body.session_id.length <= 64
      ? req.body.session_id : randomUUID();
    const history = store.getChatSession(req.clinic.id, sessionId)?.messages ?? [];
    if (history.length >= MAX_CHAT_MESSAGES) {
      return res.status(409).json({ error: 'SESSION_FULL', message: 'This conversation is very long. Please start a new chat.' });
    }
    const { reply, messages } = await runAssistantTurn({
      client: anthropic, model, store, scheduler, clinic: req.clinic, history, userText: message,
    });
    store.saveChatSession(req.clinic.id, sessionId, messages);
    res.json({ session_id: sessionId, reply });
  }));

  // ---------- admin (clinic staff) ----------
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`;
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10 });

  app.post('/api/admin/login', loginLimiter, (req, res) => {
    const row = store.getClinicPasswordHash(String(req.body?.slug ?? ''));
    if (!row || !verifyPassword(String(req.body?.password ?? ''), row.password_hash)) {
      return res.status(401).json({ error: 'BAD_LOGIN', message: 'Wrong clinic ID or password.' });
    }
    res.set('Set-Cookie', `${SESSION_COOKIE}=${createSessionToken(sessionSecret, row.id)}; ${cookieFlags}; Max-Age=43200`);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.set('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags}; Max-Age=0`);
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    const session = readSessionToken(sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    const clinic = session && store.getClinic(session.clinicId);
    if (!clinic) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Please log in.' });
    req.clinic = clinic;
    next();
  });

  admin.get('/me', (req, res) => res.json(req.clinic));

  admin.put('/clinic', (req, res) => {
    const b = req.body ?? {};
    const fields = {};
    for (const k of ['name', 'phone', 'address', 'emergency_number']) {
      if (b[k] !== undefined) fields[k] = String(b[k]).trim().slice(0, 200);
    }
    if (b.assistant_notes !== undefined) fields.assistant_notes = String(b.assistant_notes).slice(0, 4000);
    if (b.timezone !== undefined) {
      if (!isValidTimeZone(b.timezone)) throw new BookingError('INVALID', 'Unknown time zone');
      fields.timezone = b.timezone;
    }
    for (const [k, lo, hi] of [['min_notice_minutes', 0, 10080], ['booking_horizon_days', 1, 365]]) {
      if (b[k] !== undefined) {
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < lo || n > hi) throw new BookingError('INVALID', `${k} must be ${lo}-${hi}`);
        fields[k] = n;
      }
    }
    for (const k of ['voice_number', 'transfer_number']) {
      if (b[k] !== undefined) {
        const v = String(b[k]).replace(/[\s()-]/g, '');
        if (v && !E164_RE.test(v)) throw new BookingError('INVALID', `${k.replace('_', ' ')} must be in international format, e.g. +14155550123`);
        fields[k] = v;
      }
    }
    if (b.voice_language !== undefined) {
      if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(b.voice_language)) throw new BookingError('INVALID', 'Voice language must look like en-US or en-IN');
      fields.voice_language = b.voice_language;
    }
    if (b.voice_name !== undefined) {
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(b.voice_name)) throw new BookingError('INVALID', 'Invalid voice name, e.g. Polly.Joanna-Neural');
      fields.voice_name = b.voice_name;
    }
    if (b.new_password !== undefined) {
      if (String(b.new_password).length < 10) throw new BookingError('INVALID', 'Password must be at least 10 characters');
      fields.password_hash = hashPassword(String(b.new_password));
    }
    if (fields.name === '') throw new BookingError('INVALID', 'Clinic name is required');
    try {
      res.json(store.updateClinic(req.clinic.id, fields));
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new BookingError('INVALID', 'That phone number is already used by another clinic.');
      throw err;
    }
  });

  admin.get('/calls', (req, res) => res.json(store.listCalls(req.clinic.id)));
  admin.get('/calls/:sid/transcript', (req, res) => {
    const call = store.getCall(req.params.sid);
    if (!call || call.clinic_id !== req.clinic.id) return res.status(404).json({ error: 'NOT_FOUND', message: 'Call not found' });
    const session = store.getChatSession(req.clinic.id, callSessionId(call.call_sid));
    res.json({ call, transcript: callTranscript(session?.messages) });
  });

  admin.get('/doctors', (req, res) => res.json(store.listDoctors(req.clinic.id, { includeInactive: true })));
  admin.post('/doctors', (req, res) => res.status(201).json(store.createDoctor(req.clinic.id, validateDoctorInput(req.body ?? {}))));
  admin.put('/doctors/:id', (req, res) => {
    const d = store.updateDoctor(req.clinic.id, Number(req.params.id), validateDoctorInput(req.body ?? {}, { partial: true }));
    if (!d) return res.status(404).json({ error: 'NOT_FOUND', message: 'Doctor not found' });
    res.json(d);
  });

  const localDateToIso = (clinic, date) => zonedToUtc(`${date}T00:00`, clinic.timezone).toISOString();

  admin.get('/appointments', (req, res) => {
    const tz = req.clinic.timezone;
    const from = isValidDateStr(req.query.from) ? req.query.from : utcToZoned(new Date(), tz).date;
    const to = isValidDateStr(req.query.to) ? req.query.to : addDays(from, 6);
    const rows = store.listAppointments(req.clinic.id, {
      fromIso: localDateToIso(req.clinic, from),
      toIso: localDateToIso(req.clinic, addDays(to, 1)),
      doctorId: req.query.doctor_id ? Number(req.query.doctor_id) : undefined,
      status: req.query.status || undefined,
    });
    res.json(rows.map((a) => ({ ...a, start_local: utcToZoned(new Date(a.start_at), tz).local })));
  });

  admin.post('/appointments', (req, res) => {
    const b = req.body ?? {};
    const appt = scheduler.book(req.clinic, {
      doctorId: b.doctor_id, startLocal: b.start, reason: b.reason, source: 'staff',
      patient: { name: b.name, phone: b.phone, email: b.email },
    });
    res.status(201).json(appt);
  });

  admin.post('/appointments/:id/status', (req, res) => {
    const status = req.body?.status;
    if (!['booked', 'cancelled', 'completed', 'no_show'].includes(status)) {
      throw new BookingError('INVALID', 'status must be booked, cancelled, completed or no_show');
    }
    const appt = store.getAppointment(Number(req.params.id));
    if (!appt || appt.clinic_id !== req.clinic.id) return res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
    try {
      res.json(store.setAppointmentStatus(appt.id, status));
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new BookingError('SLOT_UNAVAILABLE', 'That slot has been re-booked by someone else.');
      throw err;
    }
  });

  admin.get('/time-off', (req, res) => res.json(store.listClinicTimeOff(req.clinic.id, new Date().toISOString())));
  admin.post('/time-off', (req, res) => {
    const b = req.body ?? {};
    const doctor = store.getDoctor(req.clinic.id, Number(b.doctor_id));
    if (!doctor) throw new BookingError('UNKNOWN_DOCTOR', 'Doctor not found');
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (!re.test(b.start ?? '') || !re.test(b.end ?? '') || b.start >= b.end) {
      throw new BookingError('INVALID', 'start and end must be YYYY-MM-DDTHH:mm with start before end');
    }
    const tz = req.clinic.timezone;
    const id = store.addTimeOff(doctor.id, zonedToUtc(b.start, tz).toISOString(), zonedToUtc(b.end, tz).toISOString(),
      String(b.reason ?? '').slice(0, 200));
    res.status(201).json({ id });
  });
  admin.delete('/time-off/:id', (req, res) => {
    if (!store.deleteTimeOff(req.clinic.id, Number(req.params.id))) return res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
    res.json({ ok: true });
  });

  app.use('/api/admin', admin);

  // ---------- errors ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BookingError) {
      const status = err.code === 'NOT_FOUND' || err.code === 'UNKNOWN_DOCTOR' ? 404
        : err.code === 'SLOT_UNAVAILABLE' ? 409 : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON', message: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong. Please try again or call the clinic.' });
  });

  return app;
}
