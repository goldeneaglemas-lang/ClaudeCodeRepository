// The HTTP side: booking form endpoint, Stripe webhook, test checkout, clean-up job.
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createBooking } from "@/app/api/bookings/route";
import { GET as bookingStatus } from "@/app/api/bookings/[id]/route";
import { POST as release } from "@/app/api/bookings/[id]/release/route";
import { GET as expireHolds } from "@/app/api/cron/expire-holds/route";
import { POST as testPay } from "@/app/api/dev/checkout/[id]/pay/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { getSlots } from "@/lib/slots";
import { clearBookings, db } from "./helpers";

const WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

beforeEach(async () => {
  await clearBookings();
  vi.restoreAllMocks();
});
afterAll(() => db.$disconnect());

/** A real free slot 20+ days from today, so the routes (which use the real clock) accept it. */
async function freeSlot(daysAhead = 20) {
  const service = await db.service.findFirstOrThrow({ where: { name: "Bath & Brush" } });
  const from = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + (daysAhead + 7) * 86_400_000).toISOString().slice(0, 10);
  const days = await getSlots(service.id, from, to);
  const slot = days!.flatMap((d) => d.slots)[0];
  return { serviceId: service.id, startsAt: slot.startsAt };
}

function form(slot: { serviceId: string; startsAt: string }, overrides: Record<string, unknown> = {}) {
  return {
    ...slot,
    customer: { name: "Sam Rivera", phone: "(555) 234-5678", email: "" },
    dog: { name: "Biscuit", breed: "", size: "medium", notes: "" },
    acceptNonRefundable: false,
    ...overrides,
  };
}

const post = (body: unknown) =>
  createBooking(new Request("http://localhost:3000/api/bookings", { method: "POST", body: JSON.stringify(body) }));
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/bookings", () => {
  it("holds the slot and returns the payment page", async () => {
    const res = await post(form(await freeSlot()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.checkoutUrl).toBe(`/dev/checkout/test_cs_${body.bookingId}`);
    const customer = await db.customer.findFirstOrThrow();
    expect(customer.phone).toBe("+15552345678");
    expect(customer.email).toBeNull();
  });

  it("says 409 when the time has gone", async () => {
    const slot = await freeSlot();
    await post(form(slot));
    const res = await post(form(slot, { customer: { name: "Alex", phone: "555-987-6543" } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/isn't available|just booked/);
  });

  it("rejects a bad phone number", async () => {
    const res = await post(form(await freeSlot(), { customer: { name: "Sam", phone: "12345" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/10-digit/);
  });

  it("rejects missing or invalid fields", async () => {
    const slot = await freeSlot();
    expect((await post({})).status).toBe(400);
    expect((await post(form(slot, { dog: { name: "", size: "medium" } }))).status).toBe(400);
    expect((await post(form(slot, { dog: { name: "Rex", size: "huge" } }))).status).toBe(400);
    expect((await post(form(slot, { customer: { name: "Sam", phone: "5552345678", email: "not-an-email" } }))).status).toBe(400);
    expect(
      (await createBooking(new Request("http://localhost/api/bookings", { method: "POST", body: "not json" }))).status,
    ).toBe(400);
  });

  it("needs the non-refundable box ticked for a booking less than 10 days away", async () => {
    const slot = await freeSlot(3);
    expect((await post(form(slot))).status).toBe(422);
    expect((await post(form(slot, { acceptNonRefundable: true }))).status).toBe(201);
  });
});

describe("test checkout", () => {
  it("pays the deposit and confirms the booking", async () => {
    const { bookingId } = await (await post(form(await freeSlot()))).json();
    const res = await testPay(new Request("http://localhost/x", { method: "POST" }), idParams(`test_cs_${bookingId}`));
    expect((await res.json()).result).toBe("confirmed");
    const status = await bookingStatus(new Request("http://localhost/x"), idParams(bookingId));
    expect(await status.json()).toEqual({ status: "confirmed" });
  });

  it("won't take payment once the hold is released", async () => {
    const { bookingId } = await (await post(form(await freeSlot()))).json();
    await release(new Request("http://localhost/x", { method: "POST" }), idParams(bookingId));
    const res = await testPay(new Request("http://localhost/x", { method: "POST" }), idParams(`test_cs_${bookingId}`));
    expect(res.status).toBe(410);
  });

  it("isn't available in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await testPay(new Request("http://localhost/x", { method: "POST" }), idParams("test_cs_x"));
    expect(res.status).toBe(404);
    vi.unstubAllEnvs();
  });
});

describe("POST /api/webhooks/stripe", () => {
  const signer = new Stripe("sk_test_unused");

  function event(type: string, session: Record<string, unknown>) {
    return JSON.stringify({ id: `evt_${Math.random()}`, object: "event", type, data: { object: { object: "checkout.session", ...session } } });
  }

  function send(payload: string, secret = WEBHOOK_SECRET) {
    const signature = signer.webhooks.generateTestHeaderString({ payload, secret });
    return stripeWebhook(
      new Request("http://localhost/api/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": signature } }),
    );
  }

  async function heldBooking() {
    const { bookingId } = await (await post(form(await freeSlot()))).json();
    return bookingId as string;
  }

  const paidSession = (bookingId: string) => ({
    id: `test_cs_${bookingId}`,
    payment_status: "paid",
    payment_intent: "pi_123",
    amount_total: 2500,
    currency: "usd",
    metadata: { booking_id: bookingId },
    client_reference_id: bookingId,
  });

  it("confirms the booking when checkout completes", async () => {
    const bookingId = await heldBooking();
    const res = await send(event("checkout.session.completed", paidSession(bookingId)));
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("confirmed");
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("confirmed");
  });

  it("handles the same event twice without double-counting", async () => {
    const bookingId = await heldBooking();
    const payload = event("checkout.session.completed", paidSession(bookingId));
    await send(payload);
    expect((await (await send(payload)).json()).result).toBe("already_processed");
    expect(await db.payment.count()).toBe(1);
  });

  it("frees the slot when the checkout page expires unpaid", async () => {
    const bookingId = await heldBooking();
    await send(event("checkout.session.expired", { id: `test_cs_${bookingId}`, payment_status: "unpaid" }));
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("expired");
  });

  it("does nothing for a completed checkout that isn't paid yet", async () => {
    const bookingId = await heldBooking();
    await send(event("checkout.session.completed", { ...paidSession(bookingId), payment_status: "unpaid" }));
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("pending_payment");
  });

  it("rejects an event that isn't signed by Stripe", async () => {
    const bookingId = await heldBooking();
    const res = await send(event("checkout.session.completed", paidSession(bookingId)), "whsec_wrong");
    expect(res.status).toBe(400);
    const unsigned = await stripeWebhook(new Request("http://localhost/x", { method: "POST", body: "{}" }));
    expect(unsigned.status).toBe(400);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("pending_payment");
  });
});

describe("GET /api/cron/expire-holds", () => {
  it("needs the cron secret when one is set", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await expireHolds(new Request("http://localhost/x"))).status).toBe(401);
    const ok = await expireHolds(new Request("http://localhost/x", { headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ expired: 0 });
    vi.unstubAllEnvs();
  });

  it("refuses to run in production without a secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect((await expireHolds(new Request("http://localhost/x"))).status).toBe(500);
    vi.unstubAllEnvs();
  });
});
