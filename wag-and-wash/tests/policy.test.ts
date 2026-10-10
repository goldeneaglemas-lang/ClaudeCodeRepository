import { describe, expect, it } from "vitest";
import { isRefundable, refundDeadline } from "@/lib/policy";

const startsAt = new Date("2026-11-20T15:00:00Z");

describe("10-day cancellation rule", () => {
  it("sets the deadline 10 days before the appointment", () => {
    expect(refundDeadline(startsAt, 10).toISOString()).toBe("2026-11-10T15:00:00.000Z");
  });

  it("refunds 11 days ahead", () => {
    expect(isRefundable(startsAt, new Date("2026-11-09T15:00:00Z"), 10)).toBe(true);
  });

  it("refunds at exactly 10 days ahead", () => {
    expect(isRefundable(startsAt, new Date("2026-11-10T15:00:00Z"), 10)).toBe(true);
  });

  it("keeps the deposit one minute after the deadline", () => {
    expect(isRefundable(startsAt, new Date("2026-11-10T15:01:00Z"), 10)).toBe(false);
  });

  it("keeps the deposit for a booking made less than 10 days ahead", () => {
    expect(isRefundable(startsAt, new Date("2026-11-15T09:00:00Z"), 10)).toBe(false);
  });
});
