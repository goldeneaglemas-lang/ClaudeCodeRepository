// Checks the database rules that protect Jess's calendar (PLAN.md §4, §5.2).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookingData, clearBookings, db, isOverlapError } from "./helpers";

beforeEach(clearBookings);
afterAll(() => db.$disconnect());

// A Tuesday, 10:00–11:00 New York time (14:00Z), blocked until 11:15 by the cleanup gap.
const TEN_AM = at("2026-11-03T15:00:00Z");

describe("no double-booking", () => {
  it("refuses a booking at exactly the same time", async () => {
    await db.booking.create({ data: await bookingData(TEN_AM) });
    const clash = await bookingData(TEN_AM);
    await expect(db.booking.create({ data: clash })).rejects.toSatisfy(isOverlapError);
  });

  it("refuses a booking that overlaps part of another", async () => {
    await db.booking.create({ data: await bookingData(TEN_AM) });
    const half = await bookingData(at("2026-11-03T15:30:00Z"));
    await expect(db.booking.create({ data: half })).rejects.toSatisfy(isOverlapError);
  });

  it("refuses a booking inside Jess's 15-minute cleanup gap", async () => {
    await db.booking.create({ data: await bookingData(TEN_AM) }); // ends 11:00, blocked until 11:15
    const tooSoon = await bookingData(at("2026-11-03T16:00:00Z")); // 11:00
    await expect(db.booking.create({ data: tooSoon })).rejects.toSatisfy(isOverlapError);
  });

  it("allows a booking that starts right after the cleanup gap", async () => {
    await db.booking.create({ data: await bookingData(TEN_AM) });
    const next = await bookingData(at("2026-11-03T16:15:00Z")); // 11:15
    await expect(db.booking.create({ data: next })).resolves.toBeTruthy();
  });

  it.each(["cancelled", "expired", "completed", "no_show"] as const)(
    "lets a new booking take a slot whose old booking is %s",
    async (status) => {
      await db.booking.create({ data: await bookingData(TEN_AM, { status, holdExpiresAt: null }) });
      await expect(db.booking.create({ data: await bookingData(TEN_AM) })).resolves.toBeTruthy();
    },
  );

  it("gives the slot to exactly one of 10 customers booking at the same moment", async () => {
    const attempts = await Promise.all(Array.from({ length: 10 }, () => bookingData(TEN_AM)));
    const results = await Promise.allSettled(attempts.map((data) => db.booking.create({ data })));

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(9);
    for (const r of lost) expect(isOverlapError(r.reason)).toBe(true);
    expect(await db.booking.count()).toBe(1);
  });
});

describe("booking sanity checks", () => {
  it("refuses a booking that ends before it starts", async () => {
    const bad = await bookingData(TEN_AM, { endsAt: at("2026-11-03T14:00:00Z") });
    await expect(db.booking.create({ data: bad })).rejects.toThrow(/bookings_times_valid/);
  });

  it("refuses a deposit bigger than the price", async () => {
    const bad = await bookingData(TEN_AM, { priceCents: 2000, depositCents: 2500 });
    await expect(db.booking.create({ data: bad })).rejects.toThrow(/bookings_amounts_valid/);
  });

  it("refuses an unpaid booking with no hold expiry", async () => {
    const bad = await bookingData(TEN_AM, { holdExpiresAt: null });
    await expect(db.booking.create({ data: bad })).rejects.toThrow(/bookings_hold_only_when_pending/);
  });
});
