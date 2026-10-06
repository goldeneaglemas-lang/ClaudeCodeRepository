# MediBook AI — AI appointment booking assistant for doctors

MediBook AI is an AI receptionist for clinics. Patients chat or talk with it on the clinic's website, or **call the clinic's phone number**, and it books, reschedules and cancels appointments against the doctors' real schedules, around the clock. Clinic staff manage everything from a simple web dashboard.

All the code is in the [`medibook/`](medibook/) folder.

## Features

- **AI chat assistant** (powered by Claude). Patients type in plain language, in their own language, to book, reschedule, cancel or check an appointment.
- **AI phone line.** The AI answers calls to the clinic's number (via Twilio), talks with the caller, and books, reschedules or cancels during the call. It transfers to the front desk when asked. See [`medibook/VOICE.md`](medibook/VOICE.md).
- **Voice on the website.** Patients can tap the mic to speak, and replies can be read aloud.
- **Booking form.** A simple form that works even without the AI.
- **Website widget.** One line of code adds a "Book appointment" button to the clinic's website.
- **Clinic dashboard:**
  - daily and weekly appointment list
  - phone call log with transcripts and outcomes
  - walk-ins, no-shows and cancellations
  - doctors' hours and leave
  - clinic settings
- **Safety:**
  - no medical advice
  - emergencies are directed to the emergency number
  - no double bookings
  - existing bookings need a confirmation code plus the patient's phone number
- **Multi-clinic.** One installation serves many clinics, each with its own login and data.
- **Notifications.** Booking events are sent to a webhook (Zapier, Make or n8n) to send SMS, WhatsApp or email confirmations.

## Run it locally

Requires [Node.js](https://nodejs.org) 22.5 or newer.

```bash
cd medibook
npm install
npm run seed          # creates a demo clinic
npm start             # http://localhost:3000   (stop with Ctrl + C)
```

| Page | URL |
|---|---|
| Patient AI chat | http://localhost:3000/c/demo |
| Patient booking form | http://localhost:3000/c/demo/book |
| Clinic dashboard | http://localhost:3000/admin (clinic ID `demo`, password `demo-password-123`) |

To turn on the AI chat, get an API key from https://console.anthropic.com and start the app with it:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # Windows PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Try a **phone call** without a phone line: keep the server running and, in a second terminal, run `cd medibook && npm run call`. You play the caller by typing.

Run the tests with `cd medibook && npm test`.

## More documentation

- [`medibook/README.md`](medibook/README.md): configuration, adding a real clinic, deployment, code map.
- [`medibook/VOICE.md`](medibook/VOICE.md): connecting a real phone number (Twilio) so the AI answers calls.
- [`medibook/LAUNCH.md`](medibook/LAUNCH.md): what's needed before selling (compliance, pilot, pricing, roadmap).

---

## Other: Birthday Reminder Agent

This repo also includes a Claude Code subagent, `birthday-reminder`, defined in
[`.claude/agents/birthday-reminder.md`](.claude/agents/birthday-reminder.md). It is separate from MediBook AI.

It reads birthdays from `data/birthdays.json` (an array of `{ "name", "date" }`
entries, where `date` is `MM-DD`) and reports birthdays that are today or
coming up within the next 7 days. It can also add, update, or remove entries
when asked, e.g. "Any birthdays coming up?" or "Add Ada Lovelace's birthday on December 10th."
