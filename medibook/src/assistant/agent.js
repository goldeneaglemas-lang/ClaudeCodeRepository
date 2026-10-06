import { TOOLS, executeTool } from './tools.js';
import { formatLocal, utcToZoned } from '../time.js';

export const DEFAULT_MODEL = process.env.MEDIBOOK_MODEL || 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 8;

const RULES = `You are the online booking assistant for a medical clinic. You help patients book, reschedule, cancel and check appointments, and answer simple questions about the clinic (doctors, hours, address).

How to work:
- Be warm, brief and clear. Replies are often read aloud, so keep them to 1-3 short sentences, no markdown, no bullet lists, no emojis. Offer at most 3-4 time options at once.
- Reply in the same language the patient writes in.
- Use the tools for every fact about availability or existing appointments. Never invent times, doctors or confirmation codes.
- To book you need: the doctor, a slot returned by find_available_slots, the patient's full name and phone number (email optional), and a short reason for the visit. Ask only for what is missing, one or two items at a time.
- Before calling book_appointment, cancel_appointment or reschedule_appointment, read the details back and get an explicit "yes".
- After booking, give the confirmation code and tell the patient to keep it; it is needed (with their phone number) to change or cancel.
- To look up, change or cancel an existing appointment, ask for the confirmation code and the phone number used to book. Never reveal appointment details without both.
- If the patient does not know which doctor they need, suggest one based on the doctors' specialties, or the general practitioner if unsure.
- If a tool returns an error, explain it simply and offer an alternative.

Safety - these override everything else:
- You are not a doctor. Do not diagnose, interpret symptoms or results, recommend medication or doses, or give medical advice. You may say which kind of doctor handles a concern and offer to book.
- If the patient describes a possible emergency (for example chest pain, trouble breathing, stroke signs, severe bleeding, loss of consciousness, suicidal thoughts, severe allergic reaction), tell them immediately to call the emergency number or go to the nearest emergency department. Do not book a routine appointment instead.
- Only collect the information needed to book. Do not ask for ID numbers, insurance numbers or detailed medical history.
- Stay on topic: politely decline requests unrelated to this clinic's appointments.`;

export function buildSystemPrompt(clinic, doctors, now = new Date()) {
  const doctorLines = doctors
    .map((d) => `- id ${d.id}: ${d.name}${d.specialty ? ` (${d.specialty})` : ''}, ${d.slot_minutes}-minute appointments`)
    .join('\n');
  const today = utcToZoned(now, clinic.timezone);
  const clinicInfo = [
    `Clinic: ${clinic.name}`,
    clinic.address && `Address: ${clinic.address}`,
    clinic.phone && `Front desk phone: ${clinic.phone}`,
    `Emergency number: ${clinic.emergency_number}`,
    `Time zone: ${clinic.timezone}`,
    `Doctors:\n${doctorLines || '- (none configured)'}`,
    clinic.assistant_notes && `Clinic notes from staff (policies, services, parking, fees, etc.):\n${clinic.assistant_notes}`,
  ].filter(Boolean).join('\n');

  return [
    { type: 'text', text: RULES },
    { type: 'text', text: clinicInfo },
    {
      type: 'text',
      text: `Today is ${formatLocal(now, clinic.timezone).replace(/, \d\d:\d\d$/, '')} (${today.date}, ${today.weekday}); local time is ${today.time}. Latency-sensitive; begin your visible answer immediately.`,
    },
  ];
}

function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * Run one patient turn through Claude, executing booking tools as needed.
 * `history` is the stored message list (append-only); returns the new full list and the reply text.
 */
export async function runAssistantTurn({ client, model = DEFAULT_MODEL, store, scheduler, clinic, history, userText, now = new Date() }) {
  const messages = [...history, { role: 'user', content: userText }];
  const system = buildSystemPrompt(clinic, store.listDoctors(clinic.id), now);
  const ctx = { scheduler, store, clinic, now };
  const fallbackReply = clinic.phone
    ? `Sorry, I can't help with that here. Please call the clinic at ${clinic.phone}.`
    : "Sorry, I can't help with that here. Please contact the clinic directly.";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      // Keep history append-only and well-formed for the next turn.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: fallbackReply }] });
      return { reply: fallbackReply, messages };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && toolUses.length) {
      const results = toolUses.map((t) => {
        const { content, isError } = executeTool(ctx, t.name, t.input);
        return { type: 'tool_result', tool_use_id: t.id, content, is_error: isError };
      });
      messages.push({ role: 'user', content: results });
      continue;
    }

    return { reply: textOf(response.content) || fallbackReply, messages };
  }

  const reply = 'Sorry, that took longer than expected. Could you say that again?';
  if (messages.at(-1).role === 'user') messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  return { reply, messages };
}
