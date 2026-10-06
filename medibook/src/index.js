import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'node:crypto';
import { DEFAULT_MODEL } from './assistant/agent.js';
import { createStore, openDb } from './db.js';
import { createNotifier } from './notify.js';
import { createScheduler } from './scheduling.js';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 3000);
const store = createStore(openDb());
const scheduler = createScheduler(store, { notify: createNotifier() });

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set in production');
  sessionSecret = randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set; using a random one (admin logins reset on restart).');
}

const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const anthropic = hasCredentials ? new Anthropic() : null;
if (!anthropic) console.warn('ANTHROPIC_API_KEY not set; AI chat is disabled, the booking form still works.');

// Chat transcripts can contain personal data; keep them only as long as needed.
const retentionDays = Number(process.env.CHAT_RETENTION_DAYS || 30);
const purge = () => store.purgeChatSessions(new Date(Date.now() - retentionDays * 86400000).toISOString());
purge();
setInterval(purge, 6 * 3600 * 1000).unref();

const voice = {
  authToken: process.env.TWILIO_AUTH_TOKEN,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  requireSignature: process.env.NODE_ENV === 'production',
};
if (!voice.authToken) {
  console.warn(process.env.NODE_ENV === 'production'
    ? 'TWILIO_AUTH_TOKEN not set; phone calls are disabled.'
    : 'TWILIO_AUTH_TOKEN not set; phone webhooks accept unsigned requests (development only).');
}

const app = createApp({
  store, scheduler, anthropic, sessionSecret, model: DEFAULT_MODEL,
  secureCookies: process.env.NODE_ENV === 'production',
  voice,
});
app.listen(port, () => console.log(`MediBook AI running on http://localhost:${port}`));
