// The slots endpoint against a real database.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/slots/route";
import { getSlots } from "@/lib/slots";
import { bookingData, clearBookings, db } from "./helpers";

beforeEach(clearBookings);
afterAll(() => db.$disconnect());

const NOW = new Date("2026-10-27T12:00:00Z");
const TUESDAY = "2026-11-03";
const ny = (time: string) => new Date(`${TUESDAY}T${time}:00-05:00`);

async function bathAndBrush() {
  return db.service.findFirstOrThrow({ where: { name: "Bath & Brush" } });
}

async function labelsOn(date: string, now = NOW) {
  const service = await bathAndBrush();
  const days = await getSlots(service.id, date, date, now);
  return days![0].slots.map((s) => s.label);
}

describe("getSlots", () => {
  it("offers the full day when nothing is booked", async () => {
    const s = await labelsOn(TUESDAY);
    expect(s[0]).toBe("9:00 AM");
    expect(s.at(-1)).toBe("4:00 PM");
  });

  it("hides a confirmed booking and its cleanup gap", async () => {
    await db.booking.create({ data: await bookingData(ny("10:00"), { status: "confirmed", holdExpiresAt: null }) });
    const s = await labelsOn(TUESDAY);
    expect(s).not.toContain("10:00 AM");
    expect(s).not.toContain("11:00 AM");
    expect(s).toContain("11:15 AM");
  });

  it("hides a slot someone is paying for right now", async () => {
    await db.booking.create({ data: await bookingData(ny("10:00"), { holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000) }) });
    expect(await labelsOn(TUESDAY)).not.toContain("10:00 AM");
  });

  it("frees a slot whose payment hold has run out", async () => {
    await db.booking.create({ data: await bookingData(ny("10:00"), { holdExpiresAt: new Date(NOW.getTime() - 60_000) }) });
    expect(await labelsOn(TUESDAY)).toContain("10:00 AM");
  });

  it.each(["cancelled", "expired", "completed", "no_show"] as const)("frees a slot whose booking is %s", async (status) => {
    await db.booking.create({ data: await bookingData(ny("10:00"), { status, holdExpiresAt: null }) });
    expect(await labelsOn(TUESDAY)).toContain("10:00 AM");
  });

  it("hides Jess's time off", async () => {
    await db.timeOff.create({ data: { startsAt: ny("12:00"), endsAt: ny("13:00"), reason: "Lunch" } });
    const s = await labelsOn(TUESDAY);
    expect(s).toContain("11:00 AM");
    expect(s).not.toContain("12:00 PM");
    expect(s).toContain("1:00 PM");
  });

  it("returns one entry per day across a range, empty on closed days", async () => {
    const service = await bathAndBrush();
    const days = await getSlots(service.id, "2026-11-01", "2026-11-07", NOW);
    expect(days!.map((d) => d.date)).toEqual([
      "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07",
    ]);
    expect(days!.map((d) => d.slots.length > 0)).toEqual([false, false, true, true, true, true, true]);
  });

  it("returns null for a service that isn't offered", async () => {
    const service = await db.service.create({ data: { name: "Retired Service", durationMin: 30, priceCents: 3000, active: false } });
    expect(await getSlots(service.id, TUESDAY, TUESDAY, NOW)).toBeNull();
    await db.service.delete({ where: { id: service.id } });
  });
});

describe("GET /api/slots", () => {
  const call = (query: string) => GET(new Request(`http://test/api/slots?${query}`));

  it("returns days and slots", async () => {
    const service = await bathAndBrush();
    const res = await call(`serviceId=${service.id}&from=2026-11-03&to=2026-11-04`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timezone).toBe("America/New_York");
    expect(body.days).toHaveLength(2);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects bad input with a clear message", async () => {
    const service = await bathAndBrush();
    expect((await call(`from=2026-11-03`)).status).toBe(400);
    expect((await call(`serviceId=not-a-uuid&from=2026-11-03`)).status).toBe(400);
    expect((await call(`serviceId=${service.id}&from=2026-11-31`)).status).toBe(400);
    expect((await call(`serviceId=${service.id}&from=2026-11-05&to=2026-11-03`)).status).toBe(400);
    expect((await call(`serviceId=${service.id}&from=2026-11-01&to=2027-03-01`)).status).toBe(400);
  });

  it("returns 404 for an unknown service", async () => {
    const res = await call(`serviceId=00000000-0000-4000-8000-000000000000&from=2026-11-03`);
    expect(res.status).toBe(404);
  });
});
