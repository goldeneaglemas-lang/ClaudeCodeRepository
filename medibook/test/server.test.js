import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server.js';
import { PASSWORD, setup } from './helpers.js';

let server;
let base;
let ctx;
let fakeReplies = [];

before(async () => {
  ctx = setup();
  const anthropic = {
    beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: fakeReplies.shift() ?? 'ok' }] }) } },
  };
  const app = createApp({ ...ctx, anthropic, sessionSecret: 'test-secret' });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

function nextOpenSlot() {
  const { days } = ctx.scheduler.findSlots(ctx.clinic, ctx.doctor.id, {});
  if (!days.length) throw new Error('no open slot in the next 7 days');
  return `${days[0].date}T${days[0].times[0]}`;
}

test('public clinic info hides internals', async () => {
  const { status, body } = await json('/api/c/demo');
  assert.equal(status, 200);
  assert.equal(body.clinic.name, 'Test Clinic');
  assert.equal(body.ai_enabled, true);
  assert.equal(body.doctors.length, 1);
  assert.equal(body.clinic.password_hash, undefined);
  assert.equal((await json('/api/c/nope')).status, 404);
});

test('booking form flow: slots, book, conflict, lookup, cancel', async () => {
  const start = nextOpenSlot();
  const booking = { doctor_id: ctx.doctor.id, start, name: 'Ravi Kumar', phone: '+91 99999 88888' };
  const created = await json('/api/c/demo/appointments', { method: 'POST', body: booking });
  assert.equal(created.status, 201);
  const code = created.body.confirmation_code;

  const dup = await json('/api/c/demo/appointments', { method: 'POST', body: booking });
  assert.equal(dup.status, 409);

  const found = await json('/api/c/demo/appointments/lookup', { method: 'POST', body: { code, phone: '9999988888' } });
  assert.equal(found.body.patient_name, 'Ravi Kumar');
  const wrong = await json('/api/c/demo/appointments/lookup', { method: 'POST', body: { code, phone: '1234567' } });
  assert.equal(wrong.status, 404);

  const cancelled = await json('/api/c/demo/appointments/cancel', { method: 'POST', body: { code, phone: booking.phone } });
  assert.equal(cancelled.body.status, 'cancelled');
});

test('chat endpoint creates and continues a session', async () => {
  fakeReplies = ['Hello! Which doctor?', 'Great.'];
  const first = await json('/api/c/demo/chat', { method: 'POST', body: { message: 'I want to book' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.reply, 'Hello! Which doctor?');
  const second = await json('/api/c/demo/chat', { method: 'POST', body: { message: 'Dr Test', session_id: first.body.session_id } });
  assert.equal(second.body.session_id, first.body.session_id);
  assert.equal(ctx.store.getChatSession(ctx.clinic.id, first.body.session_id).messages.length, 4);
  assert.equal((await json('/api/c/demo/chat', { method: 'POST', body: { message: '' } })).status, 400);
});

test('admin requires login and is scoped to the clinic', async () => {
  assert.equal((await json('/api/admin/appointments')).status, 401);
  const bad = await json('/api/admin/login', { method: 'POST', body: { slug: 'demo', password: 'wrong' } });
  assert.equal(bad.status, 401);

  const login = await json('/api/admin/login', { method: 'POST', body: { slug: 'demo', password: PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const auth = { headers: { cookie } };

  const me = await json('/api/admin/me', auth);
  assert.equal(me.body.slug, 'demo');
  assert.equal(me.body.password_hash, undefined);

  const doc = await json('/api/admin/doctors', {
    ...auth, method: 'POST',
    body: { name: 'Dr. New', slot_minutes: 20, working_hours: { sat: [['10:00', '12:00']] } },
  });
  assert.equal(doc.status, 201);
  const badHours = await json('/api/admin/doctors', { ...auth, method: 'POST', body: { name: 'Dr. X', working_hours: { sat: [['12:00', '10:00']] } } });
  assert.equal(badHours.status, 400);

  const start = nextOpenSlot();
  const manual = await json('/api/admin/appointments', { ...auth, method: 'POST', body: { doctor_id: ctx.doctor.id, start, name: 'Walk In', phone: '9000000000' } });
  assert.equal(manual.status, 201);
  const list = await json(`/api/admin/appointments?from=${start.slice(0, 10)}&to=${start.slice(0, 10)}`, auth);
  const row = list.body.find((a) => a.patient_name === 'Walk In');
  assert.equal(row.source, 'staff');
  const done = await json(`/api/admin/appointments/${row.id}/status`, { ...auth, method: 'POST', body: { status: 'completed' } });
  assert.equal(done.body.status, 'completed');

  const tamper = await json('/api/admin/me', { headers: { cookie: cookie.replace(/.$/, 'x') } });
  assert.equal(tamper.status, 401);
});

test('pages are served with framing rules', async () => {
  const chat = await fetch(`${base}/c/demo`);
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-frame-options'), null);
  const admin = await fetch(`${base}/admin`);
  assert.equal(admin.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/widget.js`)).status, 200);
});
