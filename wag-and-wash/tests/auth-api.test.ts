// Sign-in and account endpoints over HTTP.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as sendCode } from "@/app/api/auth/code/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { POST as verify } from "@/app/api/auth/verify/route";
import { POST as cancel } from "@/app/api/bookings/[id]/cancel/route";
import { PATCH as editDog } from "@/app/api/me/dogs/[id]/route";
import { PATCH as preferences } from "@/app/api/me/preferences/route";
import { GET as me } from "@/app/api/me/route";
import { clearBookings, db, signIn } from "./helpers";

beforeEach(async () => {
  await clearBookings();
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => db.$disconnect());

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/x", { method: "POST", body: JSON.stringify(body), headers });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("sign-in endpoints", () => {
  it("sends a code, verifies it and sets a secure session cookie", async () => {
    const sent = await sendCode(req({ phone: "(555) 234-5678" }));
    expect(sent.status).toBe(200);
    const { devCode, phone } = await sent.json();
    expect(phone).toBe("+15552345678");

    const res = await verify(req({ phone: "555-234-5678", code: devCode }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^ww_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);

    const who = await me(new Request("http://localhost/x", { headers: { cookie: cookie.split(";")[0] } }));
    expect((await who.json()).phone).toBe("+15552345678");
  });

  it("rejects a bad phone number or wrong code", async () => {
    expect((await sendCode(req({ phone: "123" }))).status).toBe(400);
    await sendCode(req({ phone: "5552345678" }));
    const res = await verify(req({ phone: "5552345678", code: "12345" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("says 429 when too many codes are requested", async () => {
    for (let i = 0; i < 3; i++) await sendCode(req({ phone: "5552345678" }));
    expect((await sendCode(req({ phone: "5552345678" }))).status).toBe(429);
  });

  it("refuses sign-in requests from other websites", async () => {
    expect((await sendCode(req({ phone: "5552345678" }, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("signs out", async () => {
    const cookie = await signIn("+15552345678");
    const res = await signOut(req({}, { cookie }));
    expect(res.headers.get("set-cookie")).toMatch(/ww_session=;/);
    expect((await me(new Request("http://localhost/x", { headers: { cookie } }))).status).toBe(401);
  });
});

describe("account endpoints need sign-in", () => {
  it.each([
    ["GET /api/me", () => me(new Request("http://localhost/x"))],
    ["PATCH /api/me/preferences", () => preferences(req({ smsOptIn: false }))],
    ["PATCH /api/me/dogs/:id", () => editDog(req({ name: "X", size: "small" }), idParams("00000000-0000-4000-8000-000000000000"))],
    ["POST /api/bookings/:id/cancel", () => cancel(req({}), idParams("00000000-0000-4000-8000-000000000000"))],
  ])("%s says 401", async (_name, call) => {
    expect((await call()).status).toBe(401);
  });

  it("cancel says 404 for a booking that isn't yours", async () => {
    const cookie = await signIn("+15552345678");
    const res = await cancel(req({}, { cookie }), idParams("00000000-0000-4000-8000-000000000000"));
    expect(res.status).toBe(404);
  });
});
