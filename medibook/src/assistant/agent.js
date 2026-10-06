import { TOOLS, VOICE_CONTROL_TOOLS, executeTool } from './tools.js';
import { formatLocal, utcToZoned } from '../time.js';

export const DEFAULT_MODEL = process.env.MEDIBOOK_MODEL || 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 8;

const RULES = `You are the booking assistant for a medical clinic. You help patients book, reschedule, cancel and check appointments, and answer simple questions about the clinic (doctors, hours, address).

How to work:
- Be warm, brief and clear. Replies are often read aloud, so keep them to 1-3 short sentences, no markdown, no bullet lists, no emojis. Offer at most 3-4 time options at once.
- Reply in the same language the patient uses.
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

const VOICE_RULES = `You are answering a PHONE CALL to the clinic. Everything you write is converted to speech, so:
- Speak naturally in one or two short sentences per reply. Never use lists, symbols, abbreviations, URLs or markdown.
- Say dates and times the way people speak them, for example "Thursday the ninth at half past ten in the morning". Offer at most three times at once.
- The caller's words come from speech recognition and may contain mistakes. If a name, number or code sounds wrong or unclear, ask them to repeat or spell it.
- Read confirmation codes slowly, one character at a time, using words for letters where helpful (for example "K as in kite"), and offer to repeat it.
- The caller's phone number is given below when known. Ask whether to use it for the booking instead of asking them to read out a number.
- If the caller asks for a person, is upset, or you cannot help, use transfer_to_front_desk (when available) after a short sentence saying you will connect them.
- When the caller has nothing more to ask, say a brief goodbye and use end_call.`;

const LANGUAGE_NAMES = { 'en-IN': 'English', 'ta-IN': 'Tamil', 'en-US': 'English' };

const TAMIL_RULES = `Tamil on the phone:
- Callers may speak Tamil, English, or a mix of both. Always reply in the language of the caller's latest message; if they mix, reply in Tamil with the same everyday English words they used.
- Use simple, polite, everyday spoken Tamil as people talk in Tamil Nadu (for example "சொல்லுங்க", "சரி", "கண்டிப்பா"), not formal written Tamil. Address the caller respectfully (நீங்க / உங்க).
- Write Tamil in Tamil script. Keep words people normally say in English, such as appointment, doctor, OK, token, in English.
- Write times and dates in Tamil words the way people say them, for example "வியாழக்கிழமை காலை பத்தரை மணிக்கு" or "சாயங்காலம் நாலு மணிக்கு". Do not write digits for times.
- Read confirmation codes and phone numbers as English letters and digits separated by spaces, for example "K 7 M 2 Q 9".`;

export function buildSystemPrompt(clinic, doctors, now = new Date(), { channel = 'chat', callerPhone = '', canTransfer = false, languages = [] } = {}) {
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

  const blocks = [{ type: 'text', text: RULES }];
  if (channel === 'voice') {
    blocks.push({
      type: 'text',
      text: `${VOICE_RULES}\n${canTransfer ? 'Transfer to the front desk is available.' : 'Transfer to a person is not available; give the front desk phone number instead.'}`,
    });
    if (languages.length) {
      const names = languages.map((c) => LANGUAGE_NAMES[c] ?? c);
      blocks.push({
        type: 'text',
        text: `This phone line speaks ${names.join(' and ')}.${languages.includes('ta-IN') ? `\n${TAMIL_RULES}` : ''}`,
      });
    }
  }
  blocks.push({ type: 'text', text: clinicInfo });
  if (channel === 'voice' && callerPhone) {
    blocks.push({ type: 'text', text: `Caller's phone number (from caller ID): ${callerPhone}` });
  }
  return [
    ...blocks,
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
export async function runAssistantTurn({
  client, model = DEFAULT_MODEL, store, scheduler, clinic, history, userText, now = new Date(),
  channel = 'chat', callerPhone = '', languages = [],
}) {
  const messages = [...history, { role: 'user', content: userText }];
  const canTransfer = channel === 'voice' && Boolean(clinic.transfer_number);
  const system = buildSystemPrompt(clinic, store.listDoctors(clinic.id), now, { channel, callerPhone, canTransfer, languages });
  const tools = channel === 'voice'
    ? [...TOOLS, ...VOICE_CONTROL_TOOLS.filter((t) => canTransfer || t.name !== 'transfer_to_front_desk')]
    : TOOLS;
  const ctx = { scheduler, store, clinic, now };
  // Call-control requests from the model ("transfer", "end") and successful bookings, for the caller to act on.
  let action = null;
  let bookings = 0;
  let fallbackReply = clinic.phone
    ? `Sorry, I can't help with that here. Please call the clinic at ${clinic.phone}.`
    : "Sorry, I can't help with that here. Please contact the clinic directly.";
  if (channel === 'voice') {
    fallbackReply = canTransfer
      ? "Sorry, I can't help with that. Let me connect you to our front desk."
      : `Sorry, I can't help with that on this line.${clinic.phone ? ` Please call our front desk at ${clinic.phone}.` : ''}`;
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      system,
      tools,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      if (canTransfer) action = 'transfer';
      // Keep history append-only and well-formed for the next turn.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: fallbackReply }] });
      return { reply: fallbackReply, messages, action, bookings };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && toolUses.length) {
      const results = toolUses.map((t) => {
        if (t.name === 'transfer_to_front_desk' || t.name === 'end_call') {
          const requested = t.name === 'end_call' ? 'end' : 'transfer';
          if (action !== 'transfer') action = requested; // a transfer request wins over hanging up
          const note = requested === 'transfer'
            ? 'The call will be transferred after your next message. Say one short sentence telling the caller you are connecting them.'
            : 'The call will end after your next message. Say one short goodbye sentence.';
          return { type: 'tool_result', tool_use_id: t.id, content: JSON.stringify({ ok: true, note }), is_error: false };
        }
        const { content, isError } = executeTool(ctx, t.name, t.input);
        if (t.name === 'book_appointment' && !isError) bookings++;
        return { type: 'tool_result', tool_use_id: t.id, content, is_error: isError };
      });
      messages.push({ role: 'user', content: results });
      continue;
    }

    return { reply: textOf(response.content) || fallbackReply, messages, action, bookings };
  }

  const reply = 'Sorry, that took longer than expected. Could you say that again?';
  if (messages.at(-1).role === 'user') messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  return { reply, messages, action, bookings };
}
