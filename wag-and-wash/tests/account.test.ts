// My bookings: listing, cancelling with the 10-day rule, dogs and texts (PLAN.md §3.2, §5.6).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelError, cancelBookingByCustomer, listBookings, setReminderTexts, updateDog } from "@/lib/account";
import { confirmDepositPaid, createBookingHold } from "@/lib/bookings";
import { testProvider } from "@/lib/payments/test-provider";
import { clearBookings, db } from "./helpers";

beforeEach(async () => {
  await clearBookings();
  vi.restoreAllMocks();
});
afterAll(() => db.$disconnect());

const SAM = "+15552345678";
const ALEX = "+15559876543";
const NOW = new Date("2026-10-27T12:00:00Z");
const ny = (date: string, time = "10:00") => new Date(`${date}T${time}:00-05:00`);

async function confirmedBooking(startsAt: Date, phone = SAM, now = NOW) {
  const service = await db.service.findFirstOrThrow({ where: { name: "Bath & Brush" } });
  const { bookingId } = await createBookingHold(
    {
      serviceId: service.id,
      startsAt,
      customer: { name: "Customer", phone },
      dog: { name: "Biscuit", size: "medium" },
      acceptNonRefundable: true,
    },
    { baseUrl: "http://test", now },
  );
  const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await confirmDepositPaid({ bookingId, checkoutId: b.stripeCheckoutId!, paymentIntentId: `pi_${bookingId}`, amountCents: 2500, currency: "usd" });
  return bookingId;
}

describe("listBookings", () => {
  it("splits upcoming from past and leaves out unpaid holds and other people's bookings", async () => {
    const soon = await confirmedBooking(ny("2026-11-03"));
    const later = await confirmedBooking(ny("2026-11-24"));
    const cancelled = await confirmedBooking(ny("2026-11-25"));
    await db.booking.update({ where: { id: cancelled }, data: { status: "cancelled" } });
    await confirmedBooking(ny("2026-11-26"), ALEX);
    const service = await db.service.findFirstOrThrow();
    await createBookingHold(
      { serviceId: service.id, startsAt: ny("2026-11-27"), customer: { name: "Sam", phone: SAM }, dog: { name: "Biscuit", size: "medium" }, acceptNonRefundable: true },
      { baseUrl: "http://test", now: NOW },
    ); // unpaid

    const { upcoming, past } = await listBookings(SAM, NOW);
    expect(upcoming.map((b) => b.id)).toEqual([soon, later]);
    expect(past.map((b) => b.id)).toEqual([cancelled]);
  });

  it("moves a booking to past once its time has gone", async () => {
    const id = await confirmedBooking(ny("2026-11-03"));
    const { upcoming, past } = await listBookings(SAM, ny("2026-11-03", "12:00"));
    expect(upcoming).toHaveLength(0);
    expect(past.map((b) => b.id)).toEqual([id]);
  });
});

describe("cancelBookingByCustomer", () => {
  it("refunds the deposit 10 or more days ahead and frees the slot", async () => {
    const refund = vi.spyOn(testProvider, "refund");
    const id = await confirmedBooking(ny("2026-11-24"));
    expect(await cancelBookingByCustomer(id, SAM, NOW)).toEqual({ refunded: true });
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: `pi_${id}`, amountCents: 2500 }));
    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });
    expect(b.status).toBe("cancelled");
    expect(b.cancelledAt).toEqual(NOW);
    expect(b.payments.filter((p) => p.type === "refund")).toMatchObject([{ amountCents: 2500, status: "succeeded" }]);
    // The slot can be booked again.
    await expect(confirmedBooking(ny("2026-11-24"), ALEX)).resolves.toBeTruthy();
  });

  it("refunds at exactly 10 days ahead", async () => {
    const startsAt = ny("2026-11-24");
    const id = await confirmedBooking(startsAt);
    const tenDaysBefore = new Date(startsAt.getTime() - 10 * 86_400_000);
    expect(await cancelBookingByCustomer(id, SAM, tenDaysBefore)).toEqual({ refunded: true });
  });

  it("keeps the deposit less than 10 days ahead, but still cancels", async () => {
    const refund = vi.spyOn(testProvider, "refund");
    const id = await confirmedBooking(ny("2026-11-03"));
    expect(await cancelBookingByCustomer(id, SAM, NOW)).toEqual({ refunded: false });
    expect(refund).not.toHaveBeenCalled();
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
  });

  it("won't cancel someone else's booking", async () => {
    const id = await confirmedBooking(ny("2026-11-24"));
    await expect(cancelBookingByCustomer(id, ALEX, NOW)).rejects.toMatchObject({ code: "not_found" });
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("confirmed");
  });

  it("won't cancel twice or refund twice, even all at once", async () => {
    const refund = vi.spyOn(testProvider, "refund");
    const id = await confirmedBooking(ny("2026-11-24"));
    const results = await Promise.allSettled([1, 2, 3].map(() => cancelBookingByCustomer(id, SAM, NOW)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("won't cancel an appointment that has already started", async () => {
    const id = await confirmedBooking(ny("2026-11-03"));
    await expect(cancelBookingByCustomer(id, SAM, ny("2026-11-03", "10:30"))).rejects.toBeInstanceOf(CancelError);
  });

  it("records a failed refund for Jess to sort out, and the booking stays cancelled", async () => {
    vi.spyOn(testProvider, "refund").mockRejectedValueOnce(new Error("Stripe is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await confirmedBooking(ny("2026-11-24"));
    expect(await cancelBookingByCustomer(id, SAM, NOW)).toEqual({ refunded: false });
    const b = await db.booking.findUniqueOrThrow({ where: { id }, include: { payments: true } });
    expect(b.status).toBe("cancelled");
    expect(b.payments.find((p) => p.type === "refund")).toMatchObject({ status: "failed", amountCents: 2500 });
  });

  it("can refund a duplicate payment and then a cancellation on the same booking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await confirmedBooking(ny("2026-11-24"));
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    await confirmDepositPaid({ bookingId: id, checkoutId: b.stripeCheckoutId!, paymentIntentId: "pi_dup", amountCents: 2500, currency: "usd" });
    expect(await cancelBookingByCustomer(id, SAM, NOW)).toEqual({ refunded: true });
    expect(await db.payment.count({ where: { bookingId: id, type: "refund", status: "succeeded" } })).toBe(2);
  });
});

describe("dogs and texts", () => {
  it("lets a customer edit their own dog only", async () => {
    await confirmedBooking(ny("2026-11-24"));
    const dog = await db.dog.findFirstOrThrow();
    expect(await updateDog(ALEX, dog.id, { name: "Hacked", size: "xl" })).toBe(false);
    expect(await updateDog(SAM, dog.id, { name: "Biscuit", breed: "Cockapoo", size: "large", notes: "Loves treats" })).toBe(true);
    expect(await db.dog.findUniqueOrThrow({ where: { id: dog.id } })).toMatchObject({ breed: "Cockapoo", size: "large", notes: "Loves treats" });
  });

  it("turns reminder texts off and on", async () => {
    await confirmedBooking(ny("2026-11-24"));
    await setReminderTexts(SAM, false);
    expect((await db.customer.findFirstOrThrow()).smsOptIn).toBe(false);
    await setReminderTexts(SAM, true);
    expect((await db.customer.findFirstOrThrow()).smsOptIn).toBe(true);
  });
});
