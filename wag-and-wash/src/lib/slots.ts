// Loads what the slot finder needs from the database (PLAN.md §5.1).
import { prisma } from "./prisma";
import { computeDaySlots, utcRangeForDates, type AvailabilityRules } from "./availability";
import { addDays, daysBetween, formatTime } from "./time";

export const MAX_RANGE_DAYS = 62;

export type Slot = { startsAt: string; label: string };
export type DaySlots = { date: string; slots: Slot[] };

export async function getSettings() {
  return prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
}

/**
 * Free slots for a service on each shop-calendar day from `from` to `to`.
 * Returns null if the service doesn't exist or isn't offered.
 */
export async function getSlots(serviceId: string, from: string, to: string, now = new Date()): Promise<DaySlots[] | null> {
  const [service, settings, hours] = await Promise.all([
    prisma.service.findFirst({ where: { id: serviceId, active: true } }),
    getSettings(),
    prisma.businessHours.findMany(),
  ]);
  if (!service) return null;

  const rules: AvailabilityRules = settings;
  const range = utcRangeForDates(from, to, rules.timezone);
  // Widen by the longest booking so one that starts the day before and runs
  // over midnight (unlikely, but possible) is still seen.
  const lookback = new Date(range.start.getTime() - 24 * 60 * 60_000);

  const [bookings, timeOff] = await Promise.all([
    prisma.booking.findMany({
      where: {
        startsAt: { lt: range.end, gte: lookback },
        blockedUntil: { gt: range.start },
        // Holds whose 15 minutes have run out are free again, even before the
        // clean-up job marks them expired. Booking (step 3) expires them first.
        OR: [{ status: "confirmed" }, { status: "pending_payment", holdExpiresAt: { gt: now } }],
      },
      select: { startsAt: true, blockedUntil: true },
    }),
    prisma.timeOff.findMany({
      where: { startsAt: { lt: range.end }, endsAt: { gt: range.start } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);

  const busy = bookings.map((b) => ({ start: b.startsAt, end: b.blockedUntil }));
  const off = timeOff.map((t) => ({ start: t.startsAt, end: t.endsAt }));

  const days: DaySlots[] = [];
  for (let i = 0; i <= daysBetween(from, to); i++) {
    const date = addDays(from, i);
    const starts = computeDaySlots({
      date,
      durationMin: service.durationMin,
      hours,
      busy,
      timeOff: off,
      rules,
      now,
    });
    days.push({
      date,
      slots: starts.map((s) => ({ startsAt: s.toISOString(), label: formatTime(s, rules.timezone) })),
    });
  }
  return days;
}
