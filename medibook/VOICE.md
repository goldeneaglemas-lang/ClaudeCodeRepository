# Phone booking: the AI answers the clinic's phone

Patients call the clinic's number and talk to the AI assistant. It can book, reschedule, cancel or check an appointment during the call, using the same doctors, hours and rules as the website chat.

## What happens on a call

```
Patient's phone ──► Clinic number (Twilio) ──► MediBook /voice/incoming
                                                  │
   "Thank you for calling Sunrise Family Clinic… emergency? dial 112… How can I help?"
                                                  │
 Patient speaks ──► Twilio speech-to-text ──► /voice/turn ──► Claude + booking tools
                                                  │
 Patient hears  ◄── Twilio text-to-speech ◄── reply ("Dr Sharma is free Thursday at ten…")
                                                  │
           …repeats until booked ──► "Your code is K 7 M 2 Q 9" ──► goodbye, hang up
```

**What the caller gets:**
- They are greeted by the clinic's name, told it's an automated assistant and that the call is transcribed, and told what to do in an emergency.
- The caller's number is offered for the booking, so they don't have to read it out.
- Confirmation codes are read slowly, one character at a time.
- Times are spoken naturally, for example "Thursday at half past ten".
- If they say *"I want to talk to a person"*, or the AI can't help or has an error, the call transfers to the front desk number. If no transfer number is set, the assistant gives the front desk phone instead.
- If the AI needs more than about 6 seconds, the caller hears *"One moment please"* rather than silence or a dropped call.
- If nobody speaks twice, the assistant says goodbye politely and hangs up.

**What the clinic gets:** the dashboard's **Phone calls** tab lists every call with the caller's number, length, outcome (Booked, Transferred, Completed, No response) and full transcript.

## Try it without a phone line (local)

```bash
cd medibook
npm run seed
export ANTHROPIC_API_KEY=sk-ant-...
npm start                  # terminal 1
npm run call               # terminal 2: you are the caller
```

Type what the caller would say and press Enter. An empty line counts as silence, and Ctrl+C hangs up. The simulator sends exactly the same requests Twilio would. Options: `npm run call -- --clinic demo --from +919876543210`.

## Go live with a real phone number (about 30 minutes)

You need the app deployed on a public **HTTPS** address (see README → Deploying), for example `https://book.yourdomain.com`.

1. **Create a Twilio account** at https://www.twilio.com and buy a phone number with **Voice** capability in the clinic's country.
   - Some countries, including India, ask for business documents (a "regulatory bundle") before you can buy a local number. Start this early, because approval can take days.
   - Alternatively, the clinic can keep its existing number and **forward** calls to the Twilio number, either always or only when busy or after hours.
2. In Twilio, open **Phone Numbers → Manage → Active numbers →** your number → **Voice configuration** and set:
   - **A call comes in:** Webhook, `https://book.yourdomain.com/voice/incoming`, HTTP **POST**
   - **Call status changes:** `https://book.yourdomain.com/voice/status`, HTTP **POST**
3. Set these environment variables on your server and restart:

   | Variable | Value |
   |---|---|
   | `TWILIO_AUTH_TOKEN` | From the Twilio Console home page (Account Info). Used to verify that requests really come from Twilio. |
   | `PUBLIC_BASE_URL` | `https://book.yourdomain.com` (exactly as entered in Twilio) |
   | `ANTHROPIC_API_KEY` | Your Claude API key |

4. In the clinic dashboard, go to **Settings → Phone line** and fill in:
   - **Clinic phone number on Twilio** in international format, e.g. `+918040001234`. This is how an incoming call is matched to the right clinic.
   - **Transfer to:** the front desk's real number, for "speak to a person".
   - **Caller language and voice.** Defaults that work well: `en-US` + `Polly.Joanna-Neural`, `en-IN` + `Polly.Aditi`, `en-GB` + `Polly.Amy-Neural`, `hi-IN` + `Polly.Aditi`. Other voices are listed in Twilio's text-to-speech docs.
5. Call the number from your phone.

Each clinic gets its own Twilio number; one server handles all of them. The `create-clinic` script can also set these: `--voice-number +91... --transfer +91... --language en-IN --voice Polly.Aditi`.

### Testing a local server with a real phone

Run `ngrok http 3000` and use the `https://….ngrok-free.app` address as `PUBLIC_BASE_URL` and in the Twilio webhooks.

## Costs

Rough figures; check before quoting prices to clinics.
- **Twilio:** a monthly fee for each number, plus per-minute charges for incoming calls and speech recognition. Typically a few US cents per minute in total, varying by country; see https://www.twilio.com/en-us/voice/pricing.
- **Claude:** about the same as a chat booking, a few cents to roughly 25 cents per booking call on the default model (see LAUNCH.md).
- A typical booking call lasts 1–3 minutes.

## Limits and notes

- **One server for voice.** A call's "still thinking" state is kept in that server's memory. Run a single instance (normal for this app), or add sticky sessions if you scale out.
- **Speech recognition can mishear** names and codes. The assistant is instructed to confirm details and ask callers to spell when unsure; check transcripts during the pilot.
- **Turn-taking:** Twilio waits for the caller to pause, then sends what they said. Callers can't interrupt the assistant mid-sentence; this keeps the system simple and reliable. A future upgrade is streaming audio with barge-in (Twilio Media Streams with a realtime speech service).
- **Recording:** only the text transcript is stored, not audio. It is deleted after `CHAT_RETENTION_DAYS`, 30 by default. The greeting tells callers the call is transcribed. Check local rules on call recording consent and on disclosing AI.
- **Webhooks** without a valid Twilio signature are rejected when `TWILIO_AUTH_TOKEN` is set. In production (`NODE_ENV=production`), voice is switched off until the token is set.
