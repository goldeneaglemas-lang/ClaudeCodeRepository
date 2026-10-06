# MediBook AI

An AI receptionist for doctors and clinics. Patients chat or talk with it on the clinic's website, or simply **phone the clinic**, and it books, reschedules and cancels appointments against the doctors' real schedules.

## What's in the box

| Part | URL | Who uses it |
|---|---|---|
| AI chat assistant, with voice input and spoken replies | `/c/<clinic-id>` | Patients |
| **AI phone line** in **Tamil and English**: answers calls to the clinic's number and books during the call. India: Exotel + Sarvam AI; elsewhere: Twilio. Setup guide: [VOICE.md](VOICE.md) | `/exotel/*`, `/voice/*` | Patients who call |
| Browser test call: talk to the phone assistant through your computer's mic | Dashboard → Phone calls → Test call | Clinic staff, you |
| Booking form, no AI needed | `/c/<clinic-id>/book` | Patients (fallback / accessibility) |
| Website widget, one `<script>` line | `/widget.js` | Clinic's website |
| Clinic dashboard | `/admin` | Doctors / front desk |
| Landing page | `/` | Prospective customers |

**Assistant:** Claude with tool use. The model never writes to the database directly. It calls tools (`find_available_slots`, `book_appointment`, `reschedule_appointment`, `cancel_appointment`, `lookup_appointment`, `list_doctors`), and the server re-checks every request against the clinic's rules.

**Scheduling rules (enforced on the server):**
- Hours, appointment length and active status are set per doctor.
- Time off can be blocked per doctor.
- Minimum notice and how far ahead patients can book are clinic settings.
- Time zones and daylight saving are handled.
- A database constraint plus a transaction prevent double booking.

**Safety:**
- The assistant does not give medical advice.
- If a patient describes an emergency, they are sent to the clinic's emergency number.
- Looking up, changing or cancelling an appointment needs both the 6-character confirmation code and the phone number used to book.

**Dashboard:**
- Day and week list of appointments, filtered by doctor and status.
- Mark appointments done, no-show or cancelled.
- Add walk-ins.
- Manage doctors and their hours.
- Block leave.
- Edit clinic settings and the notes the assistant uses (fees, parking, what to bring).
- Copy the embed code.

**Notifications:** every booking, reschedule and cancellation is POSTed to `NOTIFY_WEBHOOK_URL`. Connect it to Zapier, Make or n8n to send SMS, WhatsApp or email confirmations, or to sync with Google Calendar or an existing practice-management system.

**Multi-clinic:** one deployment serves many clinics, each with its own login and data.

## Run it

Requires Node.js 22.5 or newer.

```bash
cd medibook
npm install
npm run seed                      # demo clinic: ID "demo", password "demo-password-123"
export ANTHROPIC_API_KEY=sk-ant-...   # without it, chat is off and the booking form still works
npm start                         # http://localhost:3000
```

Open http://localhost:3000/c/demo (patient) and http://localhost:3000/admin (clinic).

Run the tests with `npm test`.

**Try a phone call without a phone line:**
- **Speak it (Tamil/English):** set `SARVAM_API_KEY` too, then in the dashboard open **Phone calls → Test call** and talk through your mic.
- **Type it (Twilio flow):** run `npm run call` in a second terminal.

To connect real phone numbers, see [VOICE.md](VOICE.md).

### Add a real clinic

```bash
npm run create-clinic -- --slug drsharma --name "Dr Sharma's Clinic" \
  --timezone Asia/Kolkata --password "a-long-password" --phone "+91 ..." --emergency 112
```

Then log in at `/admin`, add the doctors and their hours, and paste the snippet from the **Add to website** tab onto the clinic's site.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns on the AI chat |
| `MEDIBOOK_MODEL` | `claude-opus-5-5` | Claude model used by the assistant |
| `SESSION_SECRET` | random (dev only) | Signs admin login cookies. **Required in production** |
| `NODE_ENV` | none | Set to `production` for secure cookies |
| `PORT` | `3000` | HTTP port |
| `MEDIBOOK_DB` | `medibook.db` | SQLite file |
| `NOTIFY_WEBHOOK_URL` | none | Receives booking events as JSON |
| `CHAT_RETENTION_DAYS` | `30` | Chat and call transcripts are deleted after this many days |
| `SARVAM_API_KEY` | none | Sarvam AI speech (Tamil/English). Turns on Exotel phone calls and dashboard test calls |
| `EXOTEL_STREAM_TOKEN` | none | Secret that Exotel's stream URL must carry. **Required for Exotel calls in production** |
| `TWILIO_AUTH_TOKEN` | none | Verifies phone webhooks come from Twilio. **Required for Twilio calls in production** |
| `PUBLIC_BASE_URL` | none | Public HTTPS address as configured in Twilio, e.g. `https://book.example.com` |

## Deploying

The app is a single Node process with an SQLite file, so any host with a persistent disk works: Render, Railway, Fly.io, a VPS, or AWS Lightsail.

- Put it behind HTTPS. Microphone input only works on HTTPS.
- Set `SESSION_SECRET` and `NODE_ENV=production`.
- Back up the `.db` file daily.

For many clinics or several instances, move to Postgres and a shared rate limiter (Redis). The store layer in `src/db.js` is the only place that touches SQL.

## Code map

```
src/
  index.js            entry point / wiring
  server.js           HTTP routes: patient API, chat, admin API
  scheduling.js       availability, booking, reschedule, cancel (all business rules)
  assistant/agent.js  Claude conversation loop + system prompt (safety rules live here)
  assistant/tools.js  tool definitions the AI can call
  db.js               SQLite schema + queries
  time.js             time-zone helpers
  auth.js             password hashing, signed session cookies
  notify.js           webhook notifications
  voice/exotel.js     phone calls in India: Exotel audio stream, turn-taking, barge-in, transfer
  voice/sarvam.js     Sarvam AI speech-to-text / text-to-speech (Tamil, English)
  voice/vad.js        detects when the caller starts and stops talking
  voice/audio.js      PCM / WAV / resampling helpers
  voice/languages.js  Tamil and English phrases, language detection
  voice/routes.js     phone calls via Twilio: webhooks, turn handling, transfer, call log
  voice/twiml.js      TwiML builder + Twilio signature check
public/               chat, booking form, dashboard, widget (plain HTML/JS, no build step)
scripts/              seed, create-clinic, call-simulator (npm run call)
test/                 unit + HTTP tests (AI is mocked)
```
