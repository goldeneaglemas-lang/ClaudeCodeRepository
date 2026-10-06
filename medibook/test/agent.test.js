import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, runAssistantTurn } from '../src/assistant/agent.js';
import { MONDAY_8AM_IST, setup } from './helpers.js';

/** Fake Anthropic client that replays scripted responses and records requests. */
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(structuredClone(req));
          const next = responses.shift();
          if (!next) throw new Error('no more scripted responses');
          return typeof next === 'function' ? next(req) : next;
        },
      },
    },
  };
}

const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const toolUse = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });

test('system prompt contains clinic facts, doctors and date', () => {
  const { store, clinic } = setup();
  const sys = buildSystemPrompt(clinic, store.listDoctors(clinic.id), MONDAY_8AM_IST).map((b) => b.text).join('\n');
  assert.match(sys, /Test Clinic/);
  assert.match(sys, /id \d+: Dr\. Test \(General Physician\), 30-minute/);
  assert.match(sys, /2026-10-05, mon/);
  assert.match(sys, /Emergency number: 112/);
  assert.match(sys, /not a doctor/);
});

test('runs the tool loop: find slots then book', async () => {
  const { store, scheduler, clinic, doctor } = setup();
  const client = fakeClient([
    toolUse('t1', 'find_available_slots', { doctor_id: doctor.id, from_date: '2026-10-05', to_date: '2026-10-05' }),
    toolUse('t2', 'book_appointment', {
      doctor_id: doctor.id, start: '2026-10-05T09:00', patient_name: 'Asha Rao', patient_phone: '9876543210', reason: 'Cough',
    }),
    (req) => {
      const result = JSON.parse(req.messages.at(-1).content[0].content);
      return text(`Booked! Your code is ${result.confirmation_code}.`);
    },
  ]);

  const { reply, messages } = await runAssistantTurn({
    client, store, scheduler, clinic, history: [], userText: 'Book me with Dr Test at 9 on Monday', now: MONDAY_8AM_IST,
  });

  assert.match(reply, /^Booked! Your code is [A-Z2-9]{6}\.$/);
  const slotsResult = JSON.parse(client.requests[1].messages.at(-1).content[0].content);
  assert.deepEqual(slotsResult.days[0].times, ['09:00', '09:30', '10:00', '10:30']);
  assert.equal(store.listAppointments(clinic.id).length, 1);

  // History alternates roles correctly and ends with the assistant.
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  // Request shape
  const req = client.requests[0];
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(req.tools.some((t) => t.name === 'book_appointment'));
});

test('tool errors are returned to the model as is_error results', async () => {
  const { store, scheduler, clinic, doctor } = setup();
  const client = fakeClient([
    toolUse('t1', 'book_appointment', { doctor_id: doctor.id, start: '2026-10-05T09:10', patient_name: 'Asha Rao', patient_phone: '9876543210' }),
    text('That time is not available.'),
  ]);
  await runAssistantTurn({ client, store, scheduler, clinic, history: [], userText: 'hi', now: MONDAY_8AM_IST });
  const result = client.requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /SLOT_UNAVAILABLE/);
  assert.equal(store.listAppointments(clinic.id).length, 0);
});

test('refusal returns a safe fallback and keeps history well-formed', async () => {
  const { store, scheduler, clinic } = setup();
  const client = fakeClient([{ stop_reason: 'refusal', content: [] }]);
  const { reply, messages } = await runAssistantTurn({ client, store, scheduler, clinic, history: [], userText: 'x', now: MONDAY_8AM_IST });
  assert.match(reply, /call the clinic/);
  assert.equal(messages.at(-1).role, 'assistant');
});

test('continues an existing conversation', async () => {
  const { store, scheduler, clinic } = setup();
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] }];
  const client = fakeClient([text('Sure.')]);
  await runAssistantTurn({ client, store, scheduler, clinic, history, userText: 'book please', now: MONDAY_8AM_IST });
  assert.equal(client.requests[0].messages.length, 3);
});

test('reply-language instruction: system message on supported models, inside the user turn otherwise', async () => {
  const { store, scheduler, clinic } = setup();
  const a = fakeClient([text('சரி.')]);
  await runAssistantTurn({ client: a, model: 'claude-opus-5-5', store, scheduler, clinic, history: [], userText: 'appointment வேணும்', replyLanguage: 'ta-IN' });
  assert.deepEqual(a.requests[0].messages.map((m) => m.role), ['user', 'system']);
  assert.match(a.requests[0].messages[1].content, /Reply only in Tamil/);

  const b = fakeClient([text('சரி.')]);
  await runAssistantTurn({ client: b, model: 'claude-haiku-4-5', store, scheduler, clinic, history: [], userText: 'appointment வேணும்', replyLanguage: 'ta-IN' });
  const msgs = b.requests[0].messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content[0].text, 'appointment வேணும்');
  assert.match(msgs[0].content[1].text, /Reply only in Tamil/);

  const c = fakeClient([text('Sure.')]);
  await runAssistantTurn({ client: c, store, scheduler, clinic, history: [], userText: 'hi' });
  assert.deepEqual(c.requests[0].messages.map((m) => m.role), ['user']);
});
