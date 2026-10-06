# Phone booking: the AI answers the clinic's phone

Patients call the clinic and talk to the AI assistant in **Tamil or English**, or a mix of both. It can book, reschedule, cancel or check an appointment during the call, using the same doctors, hours and rules as the website.

There are two ways to connect a phone line:

| | **India: Exotel + Sarvam AI** (recommended for India) | **Outside India: Twilio** |
|---|---|---|
| Phone numbers | Indian numbers (e.g. Chennai 044) from Exotel | Twilio numbers |
| Languages | Tamil and English, auto-detected, Tamil-English mixing understood | One language per clinic (English etc.) |
| Voice | Sarvam AI Indian voices (e.g. Kavitha) | Amazon Polly / Google voices via Twilio |
| Caller can interrupt the assistant | Yes | No (takes turns) |
| Setup | Exotel call flow + WebSocket | Twilio webhook |

---

## India: Exotel + Sarvam AI

### How a call works

```
Patient dials the clinic (ExoPhone, or the clinic's old number forwarded to it)
   │
Exotel call flow:  [Voicebot] ──► [Passthru: /exotel/next] ──200──► [Connect: front desk]
                       │                          └──other──► [Hangup]
                       ▼  live audio both ways (WebSocket)
                 MediBook /exotel/stream
                       │
   caller audio ─► detects when the caller stops talking ─► Sarvam speech-to-text (Tamil/English auto-detect)
                ─► Claude + booking tools (the same engine as the chat)
                ─► Sarvam text-to-speech (Tamil or English voice) ─► caller hears the reply
```

**What the caller hears:**
1. A greeting in Tamil: "வணக்கம், Sunrise Family Clinic க்கு அழைத்ததற்கு நன்றி… அவசர மருத்துவ உதவி தேவை என்றால்… 112 க்கு அழைக்கவும். நீங்கள் தமிழிலோ ஆங்கிலத்திலோ பேசலாம். உங்களுக்கு எப்படி உதவலாம்?" (Settings can make English the first language instead.)
2. The caller speaks Tamil, English, or both mixed (*"நாளைக்கு Dr Lakshmi கிட்ட appointment வேணும்"*), and the assistant replies in the language they used.
3. Times are said naturally, for example "வியாழக்கிழமை காலை பத்தரை மணிக்கு". It offers the caller's own number for the booking and reads the confirmation code letter by letter.
4. **Callers can talk over the assistant** and it stops to listen.
5. If the AI takes more than about 1.5 seconds, the caller hears "ஒரு நிமிடம் காத்திருங்கள்" / "One moment please".
6. "I want to talk to a person", or pressing **0**, transfers the call to the front desk. Errors also go to the front desk.
7. After two long silences, the assistant says goodbye and hangs up.

### Try it now, without a phone line

1. Get API keys:
   - **Claude:** https://console.anthropic.com
   - **Sarvam AI:** sign up at https://www.sarvam.ai and create an API key in the dashboard
2. Start the server:
   ```bash
   cd medibook
   npm run seed                      # demo clinic in Chennai, Tamil + English
   export ANTHROPIC_API_KEY=sk-ant-...
   export SARVAM_API_KEY=...
   npm start
   ```
3. Open http://localhost:3000/admin, log in (`demo` / `demo-password-123`), go to **Phone calls → 🎙️ Test call (browser)**, press **Start call** and talk in Tamil or English.
   - Use headphones, so the assistant doesn't hear itself.
   - Test calls use exactly the same audio path as real phone calls, and they appear in the Phone calls tab marked "test call".

### If the test call doesn't work

Press **Check setup** on the test call page first. It tests the browser, microphone, Claude and Sarvam one by one and names what's wrong. Common causes:

| What you see | Fix |
|---|---|
| Server won't start: `Cannot find package 'ws'` or `'sarvamai'` | You pulled new code but didn't install it. Run `npm install` in `medibook/`, then `npm start`. |
| "SARVAM_API_KEY / ANTHROPIC_API_KEY is not set" | Set the keys **in the same terminal window** you run `npm start` in, then restart the server. Mac/Linux: `export SARVAM_API_KEY=...`. Windows PowerShell: `$env:SARVAM_API_KEY="..."`. Windows cmd: `set SARVAM_API_KEY=...` |
| "rejected the API key (401/403)" | The key is wrong, revoked or not activated. Create a new one in the provider's dashboard. |
| "out of credits or rate limited (429)" | Add credits or a payment method in that provider's dashboard. |
| "Browsers only allow the microphone on https:// or http://localhost" | Open `http://localhost:3000` on the computer running the server, not an IP address. On a cloud server, use HTTPS. |
| "You are not logged in" | Log in at `/admin` in the same browser, then open Phone calls → Test call again. |
| Microphone ❌ / no sound picked up | Allow the microphone (icon in the address bar) and check the right input device in your computer's sound settings. |
| The assistant keeps stopping mid-sentence | It's hearing itself through your speakers. Use headphones. |
| The greeting is in English, or **it answers in English when you speak Tamil** | The clinic is set to English only, usually because your database was created before Tamil support. **Check setup** shows "Call languages ❌" in this case. Go to Settings → Languages on calls → "Tamil and English" and save, or delete `medibook.db` and run `npm run seed` again. |
| It switches to English after I say "OK" or "yes" | That shouldn't happen any more: short words, numbers and "OK" keep the current language. It switches to English only when the caller says a full English sentence (4+ words), and back to Tamil as soon as they speak Tamil. |

The server terminal also prints the full error for every failed call, starting with `[exotel] call error`.

### Go live with a real number

You need the app deployed on a public **HTTPS** address, for example `https://book.yourdomain.in` (see README → Deploying).

1. **Exotel account.** Sign up at https://exotel.com, complete business KYC, and buy an **ExoPhone** (e.g. a Chennai 044 number).
   - Ask Exotel support to enable the **Voicebot applet** on your account if it isn't visible.
   - Alternatively, the clinic keeps its existing number and sets call forwarding to the ExoPhone, either always or only when busy or unanswered.
2. **Server settings.** Set these environment variables and restart:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | Claude API key |
   | `SARVAM_API_KEY` | Sarvam AI API key |
   | `EXOTEL_STREAM_TOKEN` | A long random secret you make up (e.g. `openssl rand -hex 24`). Exotel must include it in the stream URL. |

3. **Call flow in Exotel** (App Bazaar → create a flow):
   1. **Voicebot** applet, URL:
      `wss://book.yourdomain.in/exotel/stream?clinic=<clinic-id>&token=<EXOTEL_STREAM_TOKEN>`
      (Use 8 kHz audio, the default.)
   2. **Passthru** applet after it, URL `https://book.yourdomain.in/exotel/next`.
      MediBook answers **200** when the caller should be transferred.
   3. On the Passthru's **200** branch, add a **Connect** applet that dials the front desk number. On the other branch, add **Hangup**.
   4. Assign this flow to the ExoPhone.
4. **Clinic dashboard.** In Settings → Phone line, set:
   - **Clinic phone number:** the ExoPhone. With `?clinic=` in the URL this is optional, but it also lets one shared flow route by the number dialled.
   - **Transfer to:** the front desk.
   - **Languages on calls:** e.g. "Tamil and English".
   - **Voice:** pick one using the Test call page.
5. Call the number.

Each clinic gets its own ExoPhone and flow, with its own `clinic=` value in the URL; one server handles all clinics.

Exotel's dashboard labels change over time. If an applet name above doesn't match exactly, the pieces you need are: a bidirectional audio stream to a WebSocket (Voicebot or Stream), a step that calls a URL and branches on the response (Passthru), and a call transfer (Connect).

### Costs

Approximate; confirm on each provider's pricing page.
- **Exotel:** a monthly plan, plus per-minute call charges.
- **Sarvam AI:** pay per use for speech-to-text (per audio minute) and text-to-speech (per character). See the pricing page on sarvam.ai.
- **Claude:** a few cents to roughly 25 cents per booking call on the default model (see LAUNCH.md).

A typical booking call is 1–3 minutes. Measure real costs during the pilot.

---

## Outside India: Twilio

Twilio handles speech recognition and voice itself; MediBook answers its webhooks. One language per clinic, and callers take turns (no interrupting).

1. Buy a Twilio number with Voice. In its **Voice configuration**:
   - **A call comes in:** Webhook `https://book.yourdomain.com/voice/incoming`, HTTP **POST**
   - **Call status changes:** `https://book.yourdomain.com/voice/status`, HTTP **POST**
2. Set `TWILIO_AUTH_TOKEN` (Twilio Console → Account Info) and `PUBLIC_BASE_URL` (exactly the address used in Twilio) on the server.
3. In the dashboard, set the clinic phone number, the transfer number, and under **Twilio settings** the caller language and voice (e.g. `en-US` with `Polly.Joanna-Neural`).
4. Try it without a phone line: `npm run call` in a second terminal (you type what the caller says).

---

## Notes and limits

- **Tamil wording:** the fixed phrases (greeting, "one moment", goodbye) are in `src/voice/languages.js`, and the assistant's Tamil style rules are in `src/assistant/agent.js`. **Have a native Tamil speaker review both before launch**, and listen to test calls.
- **Speech recognition can mishear** names, numbers and codes on noisy lines. The assistant confirms details and asks callers to repeat when unsure. Read transcripts daily during the pilot.
- **One server for calls.** Each live call is handled in the memory of the server it's connected to. That's fine for a single server, which is normal for this app.
- **Privacy:** only the text transcript is stored, not audio. It is deleted after `CHAT_RETENTION_DAYS` (default 30). The greeting tells callers the call is transcribed. Under India's DPDP Act, include phone calls in your privacy notice; Sarvam AI, Exotel and Anthropic are your processors.
- **Security:**
  - Exotel streams without the right `EXOTEL_STREAM_TOKEN` are refused. In production (`NODE_ENV=production`), Exotel calls are refused until the token is set.
  - Dashboard test calls need a logged-in clinic user and can only reach that clinic.
  - Twilio webhooks are checked against Twilio's signature.
