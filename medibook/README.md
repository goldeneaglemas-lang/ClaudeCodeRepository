# MediBook AI

An AI receptionist for doctors and clinics. Patients chat or talk with it on the clinic's website, and it books, reschedules and cancels appointments against the doctors' real schedules.

## What's in the box

| Part | URL | Who uses it |
|---|---|---|
| AI chat assistant, with voice input and spoken replies | `/c/<clinic-id>` | Patients |
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
| `CHAT_RETENTION_DAYS` | `30` | Chat transcripts are deleted after this many days |

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
public/               chat, booking form, dashboard, widget (plain HTML/JS, no build step)
scripts/              seed + create-clinic
test/                 unit + HTTP tests (AI is mocked)
```
