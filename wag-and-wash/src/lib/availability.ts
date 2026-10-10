// Works out which appointment start times are free (PLAN.md §5.1).
//
// computeDaySlots is pure (no database), so the rules are easy to test.
// The database still has the final say: the no-overlap constraint rejects a
// booking if a slot was taken after it was shown.
import { HOUR, MINUTE, addDays, localDate, weekdayOf, zonedTimeToUtc } from "./time";

export type Range = { start: Date; end: Date };

export type DayHours = { weekday: number; openTime: string; closeTime: string };

export type AvailabilityRules = {
  timezone: string;
  bufferMin: number; // Jess's cleanup gap after each appointment
  slotStepMin: number; // start times are offered every N minutes from opening
  minNoticeHours: number;
  bookingWindowDays: number;
};

export type DaySlotsInput = {
  date: string; // "YYYY-MM-DD" in the shop's timezone
  durationMin: number;
  hours: DayHours[];
  busy: Range[]; // live bookings: [startsAt, blockedUntil)
  timeOff: Range[];
  rules: AvailabilityRules;
  now: Date;
};

const overlaps = (aStart: number, aEnd: number, b: Range) =>
  aStart < b.end.getTime() && b.start.getTime() < aEnd;

/** Free start times on one day, earliest first. */
export function computeDaySlots(input: DaySlotsInput): Date[] {
  const { date, durationMin, hours, busy, timeOff, rules, now } = input;

  const today = localDate(now, rules.timezone);
  if (date < today || date > addDays(today, rules.bookingWindowDays)) return [];

  const dayHours = hours.find((h) => h.weekday === weekdayOf(date));
  if (!dayHours) return []; // closed

  const open = zonedTimeToUtc(date, dayHours.openTime, rules.timezone).getTime();
  const close = zonedTimeToUtc(date, dayHours.closeTime, rules.timezone).getTime();
  const earliest = now.getTime() + rules.minNoticeHours * HOUR;
  const duration = durationMin * MINUTE;
  const buffer = rules.bufferMin * MINUTE;

  const slots: Date[] = [];
  // The appointment must finish by closing time; the cleanup gap may run past it.
  for (let start = open; start + duration <= close; start += rules.slotStepMin * MINUTE) {
    if (start < earliest) continue;
    const end = start + duration;
    // Same rule as the database constraint: this appointment plus its cleanup
    // gap must not overlap another booking plus its cleanup gap.
    if (busy.some((b) => overlaps(start, end + buffer, b))) continue;
    // Time off only needs to avoid the appointment itself; Jess can clean up during it.
    if (timeOff.some((t) => overlaps(start, end, t))) continue;
    slots.push(new Date(start));
  }
  return slots;
}

/** The UTC range covering whole shop-calendar days `from` to `to`, inclusive. */
export function utcRangeForDates(from: string, to: string, timezone: string): Range {
  return {
    start: zonedTimeToUtc(from, "00:00", timezone),
    end: zonedTimeToUtc(addDays(to, 1), "00:00", timezone),
  };
}
