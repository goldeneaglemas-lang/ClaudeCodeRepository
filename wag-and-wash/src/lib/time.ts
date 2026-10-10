// Date helpers that work in the shop's timezone, whatever timezone the server
// or the customer's phone is in. Dates are "YYYY-MM-DD" strings and times are
// "HH:MM" strings, both as a clock on the shop wall would show them.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m || !isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  return [+m[1], +m[2], +m[3]];
}

function parseTime(time: string): [number, number] {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time: ${time}`);
  return [+m[1], +m[2]];
}

/** Minutes the timezone is ahead of UTC at that instant (e.g. -240 for New York in summer). */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const instantToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - instantToSecond) / MINUTE);
}

/** The instant when the shop's clock reads `time` on `date`. Handles daylight saving. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = parseDate(date);
  const [h, mi] = parseTime(time);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Guess with the offset at the wall time, then correct once with the offset
  // at the guessed instant (they differ only around a daylight-saving change).
  let guess = wall - tzOffsetMinutes(new Date(wall), timeZone) * MINUTE;
  guess = wall - tzOffsetMinutes(new Date(guess), timeZone) * MINUTE;
  return new Date(guess);
}

/** The shop's calendar date at that instant, as "YYYY-MM-DD". */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** e.g. "10:15 AM" on the shop's clock. */
export function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(instant);
}

/** e.g. "Tuesday, November 3" on the shop's calendar. */
export function formatDateLong(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(instant);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. A calendar date's weekday doesn't depend on timezone. */
export function weekdayOf(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Number of days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parseDate(a);
  const [by, bm, bd] = parseDate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY);
}
