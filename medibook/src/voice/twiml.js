import { createHmac, timingSafeEqual } from 'node:crypto';

// Minimal TwiML builder and Twilio request-signature check (no Twilio SDK needed).

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

export const twiml = (...verbs) => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`;

export function say(clinic, text) {
  return `<Say voice="${esc(clinic.voice_name)}" language="${esc(clinic.voice_language)}">${esc(text)}</Say>`;
}

/** Speak `text`, then listen for the caller's reply and POST it to `action`. */
export function gather(clinic, text, { action, hints = [] }) {
  const lang = clinic.voice_language || 'en-US';
  const attrs = [
    'input="speech"',
    `action="${esc(action)}"`,
    'method="POST"',
    `language="${esc(lang)}"`,
    'speechTimeout="auto"',
    'actionOnEmptyResult="true"',
  ];
  // Twilio's tuned phone-call speech model is only available for US English.
  if (lang === 'en-US') attrs.push('speechModel="phone_call"', 'enhanced="true"');
  const hintText = hints.filter(Boolean).join(', ').slice(0, 900);
  if (hintText) attrs.push(`hints="${esc(hintText)}"`);
  return `<Gather ${attrs.join(' ')}>${say(clinic, text)}</Gather>`;
}

export const redirect = (url) => `<Redirect method="POST">${esc(url)}</Redirect>`;
export const hangup = () => '<Hangup/>';
export const pause = (seconds) => `<Pause length="${Number(seconds)}"/>`;
export const dial = (number, { timeout = 25 } = {}) => `<Dial timeout="${Number(timeout)}">${esc(number)}</Dial>`;

/**
 * Twilio signs each webhook: base64(HMAC-SHA1(authToken, fullUrl + sorted(key + value)...)).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function isValidTwilioRequest(authToken, url, params, signature) {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
