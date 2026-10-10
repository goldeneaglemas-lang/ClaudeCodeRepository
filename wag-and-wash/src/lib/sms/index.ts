// Sending texts (PLAN.md §2). Twilio in production; when TWILIO_* isn't set
// (dev, tests) texts are only written to the server log. Never in production.

export type SendResult = { id: string };

export interface SmsProvider {
  readonly name: "twilio" | "test";
  send(to: string, body: string): Promise<SendResult>;
}

const twilioProvider: SmsProvider = {
  name: "twilio",
  async send(to, body) {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const token = process.env.TWILIO_AUTH_TOKEN!;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER!, Body: body }),
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok || !data.sid) throw new Error(`Twilio error ${res.status}: ${data.message ?? "unknown"}`);
    return { id: data.sid };
  },
};

let testCounter = 0;
const testProvider: SmsProvider = {
  name: "test",
  async send(to, body) {
    testCounter += 1;
    console.info(`[test SMS to ${to}] ${body}`);
    return { id: `test_sms_${Date.now()}_${testCounter}` };
  },
};

/** True when texts aren't really sent (no Twilio settings). Never in production. */
export function usingTestSms(): boolean {
  return !process.env.TWILIO_ACCOUNT_SID && process.env.NODE_ENV !== "production";
}

export function smsProvider(): SmsProvider {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) return twilioProvider;
  if (usingTestSms()) return testProvider;
  throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER must be set in production.");
}
