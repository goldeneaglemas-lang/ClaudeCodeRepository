import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clinics (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  timezone        TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  emergency_number TEXT NOT NULL DEFAULT '911',
  assistant_notes TEXT NOT NULL DEFAULT '',
  min_notice_minutes INTEGER NOT NULL DEFAULT 60,
  booking_horizon_days INTEGER NOT NULL DEFAULT 60,
  password_hash   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS doctors (
  id            INTEGER PRIMARY KEY,
  clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  specialty     TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  slot_minutes  INTEGER NOT NULL DEFAULT 15,
  working_hours TEXT NOT NULL DEFAULT '{}',
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS time_off (
  id        INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  start_at  TEXT NOT NULL,
  end_at    TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY,
  clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  code          TEXT NOT NULL UNIQUE,
  patient_name  TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  patient_email TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'booked',
  source        TEXT NOT NULL DEFAULT 'assistant',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_start ON appointments(doctor_id, start_at);
-- Last line of defence against double booking.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appt_active_slot
  ON appointments(doctor_id, start_at) WHERE status = 'booked';

CREATE TABLE IF NOT EXISTS calls (
  call_sid    TEXT PRIMARY KEY,
  clinic_id   INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  from_number TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'in_progress',
  outcome     TEXT NOT NULL DEFAULT '',
  turns       INTEGER NOT NULL DEFAULT 0,
  silences    INTEGER NOT NULL DEFAULT 0,
  bookings    INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_clinic_started ON calls(clinic_id, started_at);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT PRIMARY KEY,
  clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  messages   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// Columns added after the first release. Applied to existing databases on startup.
const ADDED_COLUMNS = {
  clinics: {
    voice_number: "TEXT NOT NULL DEFAULT ''", // the clinic's Twilio phone number, E.164
    transfer_number: "TEXT NOT NULL DEFAULT ''", // front desk number for handing a call to a human
    voice_language: "TEXT NOT NULL DEFAULT 'en-US'",
    voice_name: "TEXT NOT NULL DEFAULT 'Polly.Joanna-Neural'",
    voice_languages: "TEXT NOT NULL DEFAULT 'en-IN'", // phone languages (Sarvam), primary first, e.g. "ta-IN,en-IN"
    voice_speaker: "TEXT NOT NULL DEFAULT 'kavitha'", // Sarvam voice
  },
  calls: {
    provider: "TEXT NOT NULL DEFAULT 'twilio'",
    language: "TEXT NOT NULL DEFAULT ''",
  },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of Object.entries(cols)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }
  // Each phone number routes to exactly one clinic.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_clinic_voice_number ON clinics(voice_number) WHERE voice_number <> ''`);
}

export function openDb(file = process.env.MEDIBOOK_DB || 'medibook.db') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside an IMMEDIATE transaction (takes the write lock up front). */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const toDoctor = (row) =>
  row && { ...row, active: Boolean(row.active), working_hours: JSON.parse(row.working_hours) };

const CLINIC_PUBLIC_COLS = `id, slug, name, timezone, phone, address, emergency_number,
  assistant_notes, min_notice_minutes, booking_horizon_days,
  voice_number, transfer_number, voice_language, voice_name, voice_languages, voice_speaker`;

export function createStore(db) {
  return {
    db,

    // --- clinics ---
    createClinic(c) {
      const r = db
        .prepare(
          `INSERT INTO clinics (slug, name, timezone, phone, address, emergency_number, assistant_notes, password_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.slug, c.name, c.timezone, c.phone ?? '', c.address ?? '', c.emergency_number ?? '911',
          c.assistant_notes ?? '', c.password_hash);
      return this.getClinic(Number(r.lastInsertRowid));
    },
    getClinic(id) {
      return db.prepare(`SELECT ${CLINIC_PUBLIC_COLS} FROM clinics WHERE id = ?`).get(id);
    },
    getClinicBySlug(slug) {
      return db.prepare(`SELECT ${CLINIC_PUBLIC_COLS} FROM clinics WHERE slug = ?`).get(slug);
    },
    getClinicByVoiceNumber(number) {
      if (!number) return undefined;
      return db.prepare(`SELECT ${CLINIC_PUBLIC_COLS} FROM clinics WHERE voice_number = ?`).get(number);
    },
    /** Match a dialled number in any format (+9180..., 080..., 80...) by its last 10 digits. */
    getClinicByPhoneDigits(number) {
      const digits = String(number ?? '').replace(/\D/g, '').slice(-10);
      if (digits.length < 10) return undefined;
      return db.prepare(
        `SELECT ${CLINIC_PUBLIC_COLS} FROM clinics WHERE voice_number <> '' AND substr(voice_number, -10) = ?`,
      ).get(digits);
    },
    getClinicPasswordHash(slug) {
      return db.prepare('SELECT id, password_hash FROM clinics WHERE slug = ?').get(slug);
    },
    updateClinic(id, fields) {
      const allowed = ['name', 'timezone', 'phone', 'address', 'emergency_number', 'assistant_notes',
        'min_notice_minutes', 'booking_horizon_days', 'password_hash',
        'voice_number', 'transfer_number', 'voice_language', 'voice_name', 'voice_languages', 'voice_speaker'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (keys.length) {
        db.prepare(`UPDATE clinics SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
          .run(...keys.map((k) => fields[k]), id);
      }
      return this.getClinic(id);
    },

    // --- doctors ---
    createDoctor(clinicId, d) {
      const r = db
        .prepare(
          `INSERT INTO doctors (clinic_id, name, specialty, bio, slot_minutes, working_hours, active)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(clinicId, d.name, d.specialty ?? '', d.bio ?? '', d.slot_minutes ?? 15,
          JSON.stringify(d.working_hours ?? {}), d.active === false ? 0 : 1);
      return this.getDoctor(clinicId, Number(r.lastInsertRowid));
    },
    getDoctor(clinicId, id) {
      return toDoctor(db.prepare('SELECT * FROM doctors WHERE clinic_id = ? AND id = ?').get(clinicId, id));
    },
    listDoctors(clinicId, { includeInactive = false } = {}) {
      const sql = includeInactive
        ? 'SELECT * FROM doctors WHERE clinic_id = ? ORDER BY name'
        : 'SELECT * FROM doctors WHERE clinic_id = ? AND active = 1 ORDER BY name';
      return db.prepare(sql).all(clinicId).map(toDoctor);
    },
    updateDoctor(clinicId, id, d) {
      const cur = this.getDoctor(clinicId, id);
      if (!cur) return null;
      const next = { ...cur, ...d };
      db.prepare(
        `UPDATE doctors SET name = ?, specialty = ?, bio = ?, slot_minutes = ?, working_hours = ?, active = ?
         WHERE clinic_id = ? AND id = ?`,
      ).run(next.name, next.specialty, next.bio, next.slot_minutes, JSON.stringify(next.working_hours),
        next.active ? 1 : 0, clinicId, id);
      return this.getDoctor(clinicId, id);
    },

    // --- time off ---
    addTimeOff(doctorId, startAt, endAt, reason = '') {
      const r = db.prepare('INSERT INTO time_off (doctor_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
        .run(doctorId, startAt, endAt, reason);
      return Number(r.lastInsertRowid);
    },
    listTimeOff(doctorId, fromIso, toIso) {
      return db.prepare(
        'SELECT * FROM time_off WHERE doctor_id = ? AND end_at > ? AND start_at < ? ORDER BY start_at',
      ).all(doctorId, fromIso, toIso);
    },
    listClinicTimeOff(clinicId, fromIso) {
      return db.prepare(
        `SELECT t.* FROM time_off t JOIN doctors d ON d.id = t.doctor_id
         WHERE d.clinic_id = ? AND t.end_at > ? ORDER BY t.start_at`,
      ).all(clinicId, fromIso);
    },
    deleteTimeOff(clinicId, id) {
      return db.prepare(
        'DELETE FROM time_off WHERE id = ? AND doctor_id IN (SELECT id FROM doctors WHERE clinic_id = ?)',
      ).run(id, clinicId).changes > 0;
    },

    // --- appointments ---
    activeAppointments(doctorId, fromIso, toIso) {
      return db.prepare(
        `SELECT * FROM appointments WHERE doctor_id = ? AND status = 'booked'
         AND end_at > ? AND start_at < ? ORDER BY start_at`,
      ).all(doctorId, fromIso, toIso);
    },
    insertAppointment(a) {
      const r = db.prepare(
        `INSERT INTO appointments (clinic_id, doctor_id, code, patient_name, patient_phone, patient_email,
           reason, start_at, end_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.clinic_id, a.doctor_id, a.code, a.patient_name, a.patient_phone, a.patient_email ?? '',
        a.reason ?? '', a.start_at, a.end_at, a.source ?? 'assistant');
      return this.getAppointment(Number(r.lastInsertRowid));
    },
    getAppointment(id) {
      return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    },
    getAppointmentByCode(clinicId, code) {
      return db.prepare('SELECT * FROM appointments WHERE clinic_id = ? AND code = ?').get(clinicId, code);
    },
    setAppointmentStatus(id, status) {
      db.prepare(
        `UPDATE appointments SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(status, id);
      return this.getAppointment(id);
    },
    moveAppointment(id, startAt, endAt) {
      db.prepare(
        `UPDATE appointments SET start_at = ?, end_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      ).run(startAt, endAt, id);
      return this.getAppointment(id);
    },
    listAppointments(clinicId, { fromIso, toIso, doctorId, status } = {}) {
      const where = ['a.clinic_id = ?'];
      const args = [clinicId];
      if (fromIso) { where.push('a.start_at >= ?'); args.push(fromIso); }
      if (toIso) { where.push('a.start_at < ?'); args.push(toIso); }
      if (doctorId) { where.push('a.doctor_id = ?'); args.push(doctorId); }
      if (status) { where.push('a.status = ?'); args.push(status); }
      return db.prepare(
        `SELECT a.*, d.name AS doctor_name FROM appointments a JOIN doctors d ON d.id = a.doctor_id
         WHERE ${where.join(' AND ')} ORDER BY a.start_at LIMIT 500`,
      ).all(...args);
    },

    // --- phone calls ---
    startCall(callSid, clinicId, fromNumber, { provider = 'twilio', language = '' } = {}) {
      db.prepare('INSERT OR IGNORE INTO calls (call_sid, clinic_id, from_number, provider, language) VALUES (?, ?, ?, ?, ?)')
        .run(callSid, clinicId, fromNumber, provider, language);
      return this.getCall(callSid);
    },
    getCall(callSid) {
      return db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid);
    },
    updateCall(callSid, fields) {
      const allowed = ['status', 'outcome', 'turns', 'silences', 'bookings', 'duration_seconds', 'ended_at', 'language'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (keys.length) {
        db.prepare(`UPDATE calls SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE call_sid = ?`)
          .run(...keys.map((k) => fields[k]), callSid);
      }
      return this.getCall(callSid);
    },
    listCalls(clinicId, limit = 100) {
      return db.prepare('SELECT * FROM calls WHERE clinic_id = ? ORDER BY started_at DESC LIMIT ?').all(clinicId, limit);
    },

    // --- chat sessions ---
    getChatSession(clinicId, id) {
      const row = db.prepare('SELECT * FROM chat_sessions WHERE clinic_id = ? AND id = ?').get(clinicId, id);
      return row && { ...row, messages: JSON.parse(row.messages) };
    },
    saveChatSession(clinicId, id, messages) {
      db.prepare(
        `INSERT INTO chat_sessions (id, clinic_id, messages) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET messages = excluded.messages,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(id, clinicId, JSON.stringify(messages));
    },
    purgeChatSessions(olderThanIso) {
      return db.prepare('DELETE FROM chat_sessions WHERE updated_at < ?').run(olderThanIso).changes;
    },
  };
}
