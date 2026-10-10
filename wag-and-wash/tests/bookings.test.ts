// Holding a slot, paying the deposit, and the awkward cases (PLAN.md §5.2–5.4).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingError,
  confirmDepositPaid,
  createBookingHold,
  expireStaleHolds,
  handleCheckoutExpired,
  releaseHold,
  type NewBookingInput,
} from "@/lib/bookings";
import { testProvider } from "@/lib/payments/test-provider";
import { clearBookings, db } from "./helpers";

beforeEach(async () => {
  await clearBookings();
  vi.restoreAllMocks();
});
afterAll(() => db.$disconnect());

const NOW = new Date("2026-10-27T12:00:00Z");
const nyTime = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`);
const FAR = nyTime("2026-11-24", "10:00"); // 28 days ahead: deposit refundable
const NEAR = nyTime("2026-11-03", "10:00"); // 7 days ahead: deposit not refundable
const BASE = "https://wagandwash.test";

async function input(startsAt: Date, overrides: Partial<NewBookingInput> = {}): Promise<NewBookingInput> {
  const service = await db.service.findFirstOrThrow({ where: { name: "Bath & Brush" } });
  return {
    serviceId: service.id,
    startsAt,
    customer: { name: "Sam Rivera", phone: "+15552345678", email: "sam@example.com" },
    dog: { name: "Biscuit", breed: "Cockapoo", size: "medium", notes: "Nervous of dryers" },
    acceptNonRefundable: false,
    ...overrides,
  };
}

const hold = async (startsAt: Date, overrides: Partial<NewBookingInput> = {}, now = NOW) =>
  createBookingHold(await input(startsAt, overrides), { baseUrl: BASE, now });

async function pay(bookingId: string, overrides: Partial<Parameters<typeof confirmDepositPaid>[0]> = {}) {
  const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  return confirmDepositPaid({
    bookingId,
    checkoutId: booking.stripeCheckoutId!,
    paymentIntentId: `pi_${bookingId}`,
    amountCents: 2500,
    currency: "usd",
    ...overrides,
  });
}

describe("createBookingHold", () => {
  it("holds the slot and opens a checkout page", async () => {
    const { bookingId, checkoutUrl } = await hold(FAR);
    expect(checkoutUrl).toBe(`/dev/checkout/test_cs_${bookingId}`);

    const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { customer: true, dog: true } });
    expect(b.status).toBe("pending_payment");
    expect(b.startsAt).toEqual(FAR);
    expect(b.endsAt).toEqual(new Date(FAR.getTime() + 60 * 60_000));
    expect(b.blockedUntil).toEqual(new Date(FAR.getTime() + 75 * 60_000)); // + 15 min cleanup
    expect(b.holdExpiresAt).toEqual(new Date(NOW.getTime() + 32 * 60_000)); // 30 min + 2 min margin
    expect(b.depositCents).toBe(2500);
    expect(b.priceCents).toBe(5500);
    expect(b.customer.phone).toBe("+15552345678");
    expect(b.dog).toMatchObject({ name: "Biscuit", size: "medium", notes: "Nervous of dryers" });
  });

  it("closes the checkout page a minute before the hold ends", async () => {
    const spy = vi.spyOn(testProvider, "createDepositCheckout");
    const { bookingId } = await hold(FAR);
    const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const call = spy.mock.calls[0][0];
    expect(call.expiresAt.getTime()).toBe(b.holdExpiresAt!.getTime() - 60_000);
    expect(call.expiresAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(30 * 60_000); // Stripe's minimum
    expect(call.successUrl).toBe(`${BASE}/book/done?booking=${bookingId}`);
    expect(call.cancelUrl).toBe(`${BASE}/book/cancelled?booking=${bookingId}`);
    expect(call.amountCents).toBe(2500);
  });

  it("refuses a time that's already held", async () => {
    await hold(FAR);
    await expect(hold(FAR, { customer: { name: "Alex", phone: "+15559876543" } })).rejects.toMatchObject({
      code: "slot_unavailable",
    });
  });

  it.each([
    ["a closed day (Monday)", nyTime("2026-11-23", "10:00")],
    ["before opening", nyTime("2026-11-24", "08:00")],
    ["too late to finish by closing", nyTime("2026-11-24", "16:30")],
    ["off the 15-minute grid", nyTime("2026-11-24", "10:07")],
    ["in the past", nyTime("2026-10-20", "10:00")],
    ["beyond the 60-day window", nyTime("2027-01-05", "10:00")],
  ])("refuses %s", async (_label, startsAt) => {
    await expect(hold(startsAt)).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(await db.booking.count()).toBe(0);
  });

  it("asks the customer to accept a non-refundable deposit less than 10 days ahead", async () => {
    await expect(hold(NEAR)).rejects.toMatchObject({ code: "needs_non_refundable_ok" });
    await expect(hold(NEAR, { acceptNonRefundable: true })).resolves.toHaveProperty("bookingId");
  });

  it("lets a new customer take a slot whose old hold ran out, even before the clean-up job", async () => {
    const first = await hold(FAR);
    const later = new Date(NOW.getTime() + 40 * 60_000);
    const second = await hold(FAR, { customer: { name: "Alex", phone: "+15559876543" } }, later);
    expect((await db.booking.findUniqueOrThrow({ where: { id: first.bookingId } })).status).toBe("expired");
    expect((await db.booking.findUniqueOrThrow({ where: { id: second.bookingId } })).status).toBe("pending_payment");
  });

  it("gives the slot to exactly one of 5 customers booking at once", async () => {
    const attempts = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => hold(FAR, { customer: { name: `C${n}`, phone: `+1555234000${n}` } })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    for (const a of attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected")) {
      expect(a.reason).toBeInstanceOf(BookingError);
      expect(["slot_taken", "slot_unavailable"]).toContain(a.reason.code);
    }
    expect(await db.booking.count({ where: { status: "pending_payment" } })).toBe(1);
  });

  it("reuses a returning customer and dog without changing their saved details", async () => {
    const first = await hold(FAR);
    await pay(first.bookingId);
    await hold(nyTime("2026-11-25", "10:00"), {
      customer: { name: "Someone Else", phone: "+15552345678", email: "other@example.com" },
      dog: { name: "biscuit", size: "xl", notes: "changed" },
    });
    const customers = await db.customer.findMany({ include: { dogs: true } });
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ name: "Sam Rivera", email: "sam@example.com" });
    expect(customers[0].dogs).toHaveLength(1);
    expect(customers[0].dogs[0]).toMatchObject({ size: "medium", notes: "Nervous of dryers" });
  });

  it("frees the slot if there's no payment provider (production without a Stripe key)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(hold(FAR)).rejects.toMatchObject({ code: "payment_setup_failed" });
    vi.unstubAllEnvs();
    expect(await db.booking.count({ where: { status: "pending_payment" } })).toBe(0);
  });

  it("frees the slot if the payment page can't be opened", async () => {
    vi.spyOn(testProvider, "createDepositCheckout").mockRejectedValueOnce(new Error("Stripe is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(hold(FAR)).rejects.toMatchObject({ code: "payment_setup_failed" });
    expect(await db.booking.count({ where: { status: "pending_payment" } })).toBe(0);
    await expect(hold(FAR)).resolves.toHaveProperty("bookingId");
  });
});

describe("confirmDepositPaid", () => {
  it("confirms the booking and records the deposit", async () => {
    const { bookingId } = await hold(FAR);
    expect(await pay(bookingId)).toBe("confirmed");
    const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { payments: true } });
    expect(b.status).toBe("confirmed");
    expect(b.holdExpiresAt).toBeNull();
    expect(b.stripePaymentIntentId).toBe(`pi_${bookingId}`);
    expect(b.payments).toMatchObject([{ type: "deposit", amountCents: 2500, status: "succeeded" }]);
  });

  it("counts a repeated webhook only once", async () => {
    const { bookingId } = await hold(FAR);
    expect(await pay(bookingId)).toBe("confirmed");
    expect(await pay(bookingId)).toBe("already_processed");
    expect(await db.payment.count()).toBe(1);
  });

  it("counts two webhooks arriving at the same moment only once", async () => {
    const { bookingId } = await hold(FAR);
    const results = await Promise.all([pay(bookingId), pay(bookingId), pay(bookingId)]);
    expect(results.filter((r) => r === "confirmed")).toHaveLength(1);
    expect(results.filter((r) => r === "already_processed")).toHaveLength(2);
    expect(await db.payment.count()).toBe(1);
  });

  it("confirms a late payment if nobody took the slot meanwhile", async () => {
    const { bookingId } = await hold(FAR);
    await expireStaleHolds(new Date(NOW.getTime() + 60 * 60_000));
    expect(await pay(bookingId)).toBe("confirmed");
  });

  it("refunds a late payment if someone else took the slot", async () => {
    const refund = vi.spyOn(testProvider, "refund");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await hold(FAR);
    const later = new Date(NOW.getTime() + 40 * 60_000);
    await hold(FAR, { customer: { name: "Alex", phone: "+15559876543" } }, later);

    expect(await pay(first.bookingId)).toBe("refunded_slot_taken");
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: `pi_${first.bookingId}`, amountCents: 2500 }));
    const b = await db.booking.findUniqueOrThrow({ where: { id: first.bookingId }, include: { payments: true } });
    expect(b.status).toBe("expired");
    expect(b.payments.map((p) => p.type).sort()).toEqual(["deposit", "refund"]);
    // ...and a repeat of that webhook doesn't refund twice.
    expect(await pay(first.bookingId)).toBe("already_processed");
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("refunds only once when duplicate late webhooks arrive at the same moment", async () => {
    const refund = vi.spyOn(testProvider, "refund");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await hold(FAR);
    await hold(FAR, { customer: { name: "Alex", phone: "+15559876543" } }, new Date(NOW.getTime() + 40 * 60_000));

    const results = await Promise.all([pay(first.bookingId), pay(first.bookingId), pay(first.bookingId)]);
    expect(results.filter((r) => r === "refunded_slot_taken")).toHaveLength(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(await db.payment.count({ where: { bookingId: first.bookingId, type: "refund" } })).toBe(1);
  });

  it("refunds a payment for a booking that was cancelled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bookingId } = await hold(FAR);
    await db.booking.update({ where: { id: bookingId }, data: { status: "cancelled" } });
    expect(await pay(bookingId)).toBe("refunded_cancelled");
  });

  it("refunds a second, different payment for an already-confirmed booking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bookingId } = await hold(FAR);
    await pay(bookingId);
    expect(await pay(bookingId, { paymentIntentId: "pi_second" })).toBe("refunded_duplicate");
  });

  it("doesn't confirm if the amount paid is wrong", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { bookingId } = await hold(FAR);
    expect(await pay(bookingId, { amountCents: 100 })).toBe("amount_mismatch");
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("pending_payment");
  });

  it("ignores a payment for a different checkout page", async () => {
    const { bookingId } = await hold(FAR);
    expect(await pay(bookingId, { checkoutId: "cs_someone_else" })).toBe("checkout_mismatch");
  });
});

describe("releasing holds", () => {
  it("frees the slot when the customer backs out of paying", async () => {
    const expire = vi.spyOn(testProvider, "expireCheckout");
    const { bookingId } = await hold(FAR);
    await releaseHold(bookingId);
    expect(expire).toHaveBeenCalledWith(`test_cs_${bookingId}`);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("expired");
  });

  it("never releases a confirmed booking", async () => {
    const { bookingId } = await hold(FAR);
    await pay(bookingId);
    await releaseHold(bookingId);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("confirmed");
  });

  it("frees the slot when Stripe closes the payment page unpaid", async () => {
    const { bookingId } = await hold(FAR);
    await handleCheckoutExpired(`test_cs_${bookingId}`);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("expired");
  });

  it("the clean-up job only expires holds that have run out", async () => {
    const old = await hold(FAR);
    const fresh = await hold(nyTime("2026-11-25", "10:00"), {}, new Date(NOW.getTime() + 20 * 60_000));
    expect(await expireStaleHolds(new Date(NOW.getTime() + 33 * 60_000))).toBe(1);
    expect((await db.booking.findUniqueOrThrow({ where: { id: old.bookingId } })).status).toBe("expired");
    expect((await db.booking.findUniqueOrThrow({ where: { id: fresh.bookingId } })).status).toBe("pending_payment");
  });
});
