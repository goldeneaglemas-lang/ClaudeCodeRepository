# Taking MediBook AI to market

The software in this folder is a working first version (MVP). This page covers what is still needed before charging clinics, and the decisions only the owner can make.

## 1. Decisions needed from you

1. ~~Country~~ **India** (decided), languages **Tamil and English** (decided). The demo clinic is in Chennai; phone calls run on Exotel + Sarvam AI.
2. **Product name and domain.** "MediBook AI" is a placeholder; check trademarks before using it.
3. **Price** (suggestion in section 4).
4. **Which channels matter most to your clinics:** website chat and phone calls (Tamil and English) are built; WhatsApp and SMS are on the roadmap.
5. **Do target clinics already use a practice-management or EHR system** whose calendar we must sync with? Or is MediBook their calendar?

## 2. Legal and compliance (do before taking real patient data)

Appointment details plus a reason for visit count as health data in most countries.

| Market | What applies | What to do |
|---|---|---|
| USA | HIPAA | Sign a **BAA** with Anthropic (API) and with your hosting provider. Use a HIPAA-eligible host (AWS, GCP or Azure with a BAA). Sign a BAA with each clinic. |
| India | DPDP Act 2023 | Privacy notice and consent text on the chat and form, a named grievance officer, a data-processing agreement with each clinic. |
| EU / UK | GDPR | DPA with clinics and sub-processors, EU data residency if clinics ask, a records-of-processing document. |

For every market:
- Add a privacy policy and terms of service, linked from the chat and the form.
- Get a lawyer to review them once.
- Keep chat retention short. It defaults to 30 days via `CHAT_RETENTION_DAYS`.
- Encrypt backups.
- Restrict who can access the server.
- Phone calls: the greeting tells callers the assistant is automated and the call is transcribed. Check the rules on call recording or transcription consent and on disclosing AI. For India, list Exotel, Sarvam AI and Anthropic as processors in your privacy notice and data-processing agreement. (US only: if Twilio handles health data, sign Twilio's BAA.)

## 3. Before the first paying clinic

- Deploy on HTTPS with daily backups (see README → Deploying), and set `SESSION_SECRET`.
- Connect `NOTIFY_WEBHOOK_URL` to an SMS or WhatsApp sender so patients get confirmations. A Zapier, Make or n8n + Twilio/MSG91/Gupshup flow takes about an hour.
- **Pilot with 1–3 friendly clinics for 2–4 weeks.** Read the chat transcripts every day, and adjust the rules in `src/assistant/agent.js` and the per-clinic notes in the dashboard.
- **Get the Tamil reviewed.** Have a native Tamil speaker review the fixed phrases (`src/voice/languages.js`), the chat page's Tamil text (`public/chat.js`), and a dozen test calls. Pick the voice clinics like best.
- For phone booking, open an Exotel account (business KYC takes a few days), get an ExoPhone for each pilot clinic, and follow [VOICE.md](VOICE.md). Get a Sarvam AI API key.
- Test with a real `ANTHROPIC_API_KEY`. The automated tests mock the AI, so the live conversation quality has not been exercised in this repo yet.
- Measure the real cost per conversation (next section).

## 4. Running costs and pricing (estimates, not measurements)

- **AI cost:** a typical booking conversation is about 5–10 model calls. On the default model (Claude Opus 5.5, $4 / $20 per million input/output tokens, with prompt caching on) that is roughly **$0.05–$0.25 per booking conversation**. Check this against your Anthropic usage dashboard during the pilot.
- **Cheaper model:** setting `MEDIBOOK_MODEL` to a cheaper model such as `claude-sonnet-5-5` (half the price) is a one-line change. Try it in the pilot before switching.
- **Hosting:** $10–$50/month covers many clinics at the start.
- **Suggested pricing to test:** a flat monthly fee per doctor (for example $29–$79/month in the US, ₹1,500–₹4,000/month in India), with a free 14-day trial. One recovered no-show or missed call per month usually pays for it, which is the sales message.

## 5. Roadmap (suggested order)

1. **SMS/WhatsApp reminders** 24 hours and 2 hours before the visit. This cuts no-shows, which is the easiest feature to sell.
2. ~~**Phone calls**~~ ✅ built: India on Exotel + Sarvam AI (Tamil/English, callers can interrupt), elsewhere on Twilio. See VOICE.md. Possible next steps: streaming speech recognition for faster replies, more Indian languages (Sarvam supports Hindi, Telugu, Kannada, Malayalam and more), outbound reminder calls.
3. **WhatsApp chat** booking (very important in India and the Middle East).
4. **Google Calendar / Outlook two-way sync** for doctors who keep a personal calendar.
5. **Self-serve sign-up and billing** (Stripe or Razorpay), so clinics can onboard without you running `create-clinic`.
6. **Multiple staff logins per clinic** with roles, plus an audit log.
7. **Move to Postgres** when you pass a few dozen clinics or need more than one server.
