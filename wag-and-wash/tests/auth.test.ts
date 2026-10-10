// Phone sign-in codes and sessions.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, endSession, phoneForToken, sendLoginCode, verifyLoginCode } from "@/lib/auth";
import { clearBookings, db } from "./helpers";

beforeEach(async () => {
  await clearBookings();
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => db.$disconnect());

const SAM = "+15552345678";
const NOW = new Date("2026-10-27T12:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe("sign-in codes", () => {
  it("texts a 6-digit code and signs in with it", async () => {
    const info = vi.spyOn(console, "info");
    const { devCode } = await sendLoginCode(SAM, "1.2.3.4", NOW);
    expect(devCode).toMatch(/^\d{6}$/);
    expect(info.mock.calls[0][0]).toContain(`Your Wag & Wash code is ${devCode}`);

    const { token, expiresAt } = await verifyLoginCode(SAM, devCode!, later(1));
    expect(await phoneForToken(token, later(2))).toBe(SAM);
    expect(expiresAt).toEqual(new Date(later(1).getTime() + 30 * 86_400_000));
  });

  it("stores only a hash of the code", async () => {
    const { devCode } = await sendLoginCode(SAM, null, NOW);
    const row = await db.loginCode.findFirstOrThrow();
    expect(row.codeHash).not.toContain(devCode!);
    expect(row.codeHash).toHaveLength(64);
  });

  it("rejects a wrong code, and a right code for a different phone", async () => {
    const { devCode } = await sendLoginCode(SAM, null, NOW);
    const wrong = devCode === "000000" ? "111111" : "000000";
    await expect(verifyLoginCode(SAM, wrong, later(1))).rejects.toBeInstanceOf(AuthError);
    await expect(verifyLoginCode("+15559876543", devCode!, later(1))).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a code after 10 minutes", async () => {
    const { devCode } = await sendLoginCode(SAM, null, NOW);
    await expect(verifyLoginCode(SAM, devCode!, later(11))).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("works only once", async () => {
    const { devCode } = await sendLoginCode(SAM, null, NOW);
    await verifyLoginCode(SAM, devCode!, later(1));
    await expect(verifyLoginCode(SAM, devCode!, later(1))).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("locks a code after 5 wrong guesses, even if the 6th is right", async () => {
    const { devCode } = await sendLoginCode(SAM, null, NOW);
    const wrong = devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyLoginCode(SAM, wrong, later(1))).rejects.toBeInstanceOf(AuthError);
    await expect(verifyLoginCode(SAM, devCode!, later(1))).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("can't be brute-forced with guesses sent all at once", async () => {
    await sendLoginCode(SAM, null, NOW);
    const guesses = Array.from({ length: 20 }, (_, i) => String(i).padStart(6, "0"));
    await Promise.allSettled(guesses.map((g) => verifyLoginCode(SAM, g, later(1))));
    expect((await db.loginCode.findFirstOrThrow()).attempts).toBe(5);
  });

  it("only accepts the newest code", async () => {
    const first = await sendLoginCode(SAM, null, NOW);
    const second = await sendLoginCode(SAM, null, later(1));
    if (first.devCode !== second.devCode) {
      await expect(verifyLoginCode(SAM, first.devCode!, later(2))).rejects.toBeInstanceOf(AuthError);
    }
    await expect(verifyLoginCode(SAM, second.devCode!, later(2))).resolves.toHaveProperty("token");
  });

  it("allows 3 codes per phone per 15 minutes", async () => {
    for (let i = 0; i < 3; i++) await sendLoginCode(SAM, null, later(i));
    await expect(sendLoginCode(SAM, null, later(3))).rejects.toMatchObject({ code: "too_many_codes" });
    await expect(sendLoginCode(SAM, null, later(16))).resolves.toHaveProperty("devCode");
  });

  it("allows 10 codes per IP address per hour", async () => {
    for (let i = 0; i < 10; i++) await sendLoginCode(`+1555234${String(1000 + i)}`, "9.9.9.9", later(i));
    await expect(sendLoginCode("+15559990000", "9.9.9.9", later(11))).rejects.toMatchObject({ code: "too_many_codes" });
    await expect(sendLoginCode("+15559990000", "8.8.8.8", later(11))).resolves.toHaveProperty("devCode");
  });

  it("doesn't count a code that couldn't be sent", async () => {
    vi.stubEnv("NODE_ENV", "production"); // no Twilio settings, so sending fails
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendLoginCode(SAM, null, NOW)).rejects.toThrow();
    vi.unstubAllEnvs();
    expect(await db.loginCode.count()).toBe(0);
  });

  it("never shows the code on screen in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
    vi.stubEnv("AUTH_SECRET", "prod-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }));
    const result = await sendLoginCode(SAM, null, NOW);
    vi.unstubAllEnvs();
    expect(result.devCode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("api.twilio.com"), expect.anything());
  });
});

describe("sessions", () => {
  async function session() {
    const { devCode } = await sendLoginCode(SAM, null, NOW);
    return (await verifyLoginCode(SAM, devCode!, NOW)).token;
  }

  it("ends after 30 days", async () => {
    const token = await session();
    expect(await phoneForToken(token, later(29 * 24 * 60))).toBe(SAM);
    expect(await phoneForToken(token, later(30 * 24 * 60 + 1))).toBeNull();
  });

  it("ends on sign-out", async () => {
    const token = await session();
    await endSession(token);
    expect(await phoneForToken(token, NOW)).toBeNull();
  });

  it("doesn't accept a made-up or missing token", async () => {
    expect(await phoneForToken("made-up", NOW)).toBeNull();
    expect(await phoneForToken(null, NOW)).toBeNull();
  });

  it("stores only a hash of the session token", async () => {
    const token = await session();
    const row = await db.customerSession.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);
  });
});
