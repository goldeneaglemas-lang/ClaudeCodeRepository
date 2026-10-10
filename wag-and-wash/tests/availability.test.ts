// The slot rules on their own, without a database (PLAN.md §5.1).
import { describe, expect, it } from "vitest";
import { computeDaySlots, type AvailabilityRules, type DaySlotsInput, type Range } from "@/lib/availability";
import { formatTime } from "@/lib/time";

const NY = "America/New_York";
const RULES: AvailabilityRules = { timezone: NY, bufferMin: 15, slotStepMin: 15, minNoticeHours: 2, bookingWindowDays: 60 };
const TUE_TO_SAT = [2, 3, 4, 5, 6].map((weekday) => ({ weekday, openTime: "09:00", closeTime: "17:00" }));

// "Now" is a week before the test day, so notice and window rules don't get in the way.
const NOW = new Date("2026-10-27T12:00:00Z");
const TUESDAY = "2026-11-03"; // New York is UTC-5 on this day

const ny = (time: string) => new Date(`${TUESDAY}T${time}:00-05:00`);
const range = (from: string, to: string): Range => ({ start: ny(from), end: ny(to) });

function slots(overrides: Partial<DaySlotsInput> = {}) {
  const input: DaySlotsInput = {
    date: TUESDAY,
    durationMin: 60,
    hours: TUE_TO_SAT,
    busy: [],
    timeOff: [],
    rules: RULES,
    now: NOW,
    ...overrides,
  };
  return computeDaySlots(input).map((d) => formatTime(d, NY));
}

describe("opening hours", () => {
  it("offers every 15 minutes from opening, finishing by closing", () => {
    const s = slots();
    expect(s[0]).toBe("9:00 AM");
    expect(s[1]).toBe("9:15 AM");
    expect(s.at(-1)).toBe("4:00 PM"); // a 60-min appointment must end by 5:00
    expect(s).toHaveLength(29);
  });

  it("stops earlier for longer services", () => {
    expect(slots({ durationMin: 120 }).at(-1)).toBe("3:00 PM");
  });

  it("offers nothing when a service is longer than the day", () => {
    expect(slots({ durationMin: 9 * 60 })).toEqual([]);
  });

  it("is closed on Sunday and Monday", () => {
    expect(slots({ date: "2026-11-01" })).toEqual([]);
    expect(slots({ date: "2026-11-02" })).toEqual([]);
  });

  it("uses the right clock on the day daylight saving ends", () => {
    const sundayHours = [{ weekday: 0, openTime: "09:00", closeTime: "17:00" }];
    const s = computeDaySlots({ date: "2026-11-01", durationMin: 60, hours: sundayHours, busy: [], timeOff: [], rules: RULES, now: NOW });
    expect(s[0].toISOString()).toBe("2026-11-01T14:00:00.000Z"); // 9:00 AM EST
    expect(s).toHaveLength(29);
  });
});

describe("existing bookings and the cleanup gap", () => {
  // A 10:00–11:00 booking, blocked until 11:15 for cleanup.
  const tenAm = [range("10:00", "11:15")];

  it("hides times that would overlap the booking or its cleanup gap", () => {
    const s = slots({ busy: tenAm });
    expect(s).not.toContain("10:00 AM");
    expect(s).not.toContain("10:30 AM");
    expect(s).not.toContain("11:00 AM");
    expect(s).toContain("11:15 AM");
  });

  it("leaves room for this appointment's own cleanup before the next booking", () => {
    const s = slots({ busy: tenAm });
    // 8:45 isn't open; 9:00–10:00 + 15 min cleanup runs into 10:00, so 9:00 is out too.
    expect(s).not.toContain("9:00 AM");
    expect(s).not.toContain("8:45 AM");
  });

  it("allows an appointment ending exactly when the gap before the next one starts", () => {
    // A booking at 11:15 means 10:00–11:00 (+ cleanup to 11:15) just fits.
    const s = slots({ busy: [range("11:15", "12:30")] });
    expect(s).toContain("10:00 AM");
    expect(s).not.toContain("10:15 AM");
  });
});

describe("time off", () => {
  it("hides times that overlap Jess's lunch break", () => {
    const s = slots({ timeOff: [range("12:00", "13:00")] });
    expect(s).toContain("11:00 AM"); // ends 12:00; cleanup can happen at lunch
    expect(s).not.toContain("11:15 AM");
    expect(s).not.toContain("12:30 PM");
    expect(s).toContain("1:00 PM");
  });

  it("hides the whole day for a day off", () => {
    expect(slots({ timeOff: [{ start: ny("00:00"), end: new Date("2026-11-04T05:00:00Z") }] })).toEqual([]);
  });
});

describe("notice and booking window", () => {
  it("hides past times and the next 2 hours on the same day", () => {
    const now = ny("11:05");
    const s = slots({ now });
    expect(s[0]).toBe("1:15 PM"); // first step at or after 1:05 PM
  });

  it("offers nothing for a day in the past", () => {
    expect(slots({ now: new Date("2026-11-05T12:00:00Z") })).toEqual([]);
  });

  it("offers the last day of the 60-day window but not the day after", () => {
    const now = new Date("2026-09-04T12:00:00Z"); // 60 days before Nov 3
    expect(slots({ now }).length).toBeGreaterThan(0);
    expect(slots({ now: new Date("2026-09-03T12:00:00Z") })).toEqual([]);
  });
});
