// Checks the seeded settings match Jess's decisions (PLAN.md §8).
import { afterAll, describe, expect, it } from "vitest";
import { db } from "./helpers";

afterAll(() => db.$disconnect());

describe("seed data", () => {
  it("uses Jess's rules: $25 deposit, 10-day cancellation, 15-minute gap", async () => {
    const s = await db.settings.findUniqueOrThrow({ where: { id: 1 } });
    expect(s.depositCents).toBe(2500);
    expect(s.cancellationDays).toBe(10);
    expect(s.bufferMin).toBe(15);
  });

  it("opens Tuesday to Saturday, 9am to 5pm", async () => {
    const hours = await db.businessHours.findMany({ orderBy: { weekday: "asc" } });
    expect(hours.map((h) => h.weekday)).toEqual([2, 3, 4, 5, 6]);
    for (const h of hours) expect([h.openTime, h.closeTime]).toEqual(["09:00", "17:00"]);
  });

  it("prices every service at or above the deposit", async () => {
    const services = await db.service.findMany();
    expect(services.length).toBeGreaterThan(0);
    for (const s of services) expect(s.priceCents).toBeGreaterThanOrEqual(2500);
  });

  it("allows only one settings row", async () => {
    await expect(db.settings.create({ data: { id: 2 } })).rejects.toThrow(/settings_single_row/);
  });
});
