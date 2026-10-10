import { describe, expect, it } from "vitest";
import { addDays, daysBetween, formatTime, isValidDate, localDate, weekdayOf, zonedTimeToUtc } from "@/lib/time";

const NY = "America/New_York";

describe("zonedTimeToUtc", () => {
  it("converts New York winter time (UTC-5)", () => {
    expect(zonedTimeToUtc("2026-12-01", "09:00", NY).toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("converts New York summer time (UTC-4)", () => {
    expect(zonedTimeToUtc("2026-07-01", "09:00", NY).toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });

  it("gets both sides of the spring daylight-saving change right (Mar 8, 2026)", () => {
    expect(zonedTimeToUtc("2026-03-08", "01:00", NY).toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(zonedTimeToUtc("2026-03-08", "09:00", NY).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("gets both sides of the autumn daylight-saving change right (Nov 1, 2026)", () => {
    expect(zonedTimeToUtc("2026-11-01", "00:30", NY).toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(zonedTimeToUtc("2026-11-01", "09:00", NY).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("works for other timezones", () => {
    expect(zonedTimeToUtc("2026-07-01", "09:00", "America/Los_Angeles").toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-01", "09:00", "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
  });

  it("rejects bad input", () => {
    expect(() => zonedTimeToUtc("2026-02-30", "09:00", NY)).toThrow();
    expect(() => zonedTimeToUtc("2026-02-01", "25:00", NY)).toThrow();
  });
});

describe("calendar helpers", () => {
  it("finds the shop's date, which can differ from the UTC date", () => {
    // 11:30pm in New York is already the next day in UTC.
    expect(localDate(new Date("2026-11-04T04:30:00Z"), NY)).toBe("2026-11-03");
  });

  it("formats times on the shop's clock", () => {
    expect(formatTime(new Date("2026-11-03T15:15:00Z"), NY)).toBe("10:15 AM");
  });

  it("adds days across months, years and daylight-saving changes", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(daysBetween("2026-10-10", "2026-12-09")).toBe(60);
  });

  it("knows the weekday", () => {
    expect(weekdayOf("2026-11-03")).toBe(2); // Tuesday
    expect(weekdayOf("2026-11-01")).toBe(0); // Sunday
  });

  it("validates dates", () => {
    expect(isValidDate("2026-11-03")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("11/03/2026")).toBe(false);
  });
});
