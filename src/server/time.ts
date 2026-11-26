/**
 * Asia/Kolkata time helpers.
 *
 * Two kinds of values:
 * - **Timestamps** (`DateTime` columns): real instants. Format with `formatIST()`.
 * - **Calendar dates** (`@db.Date` columns): an IST calendar day, represented as a JS Date at
 *   00:00:00 UTC of that day (this is what Prisma reads/writes for `@db.Date`).
 *   Build with `dateOnly()` / `todayIST()`, format with `formatDate()`.
 *
 * Never call `new Date().getDate()` (or other local-time getters) on server data.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const IST = "Asia/Kolkata";
const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The IST calendar day of an instant, as "YYYY-MM-DD". */
export function istDateString(at: Date = new Date()): string {
  return formatInTimeZone(at, IST, "yyyy-MM-dd");
}

/** "YYYY-MM-DD" → calendar date (UTC midnight). */
export function dateOnly(ymd: string): Date {
  const m = YMD.exec(ymd);
  if (!m) throw new RangeError(`Expected YYYY-MM-DD, got "${ymd}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (istDateStringOf(d) !== ymd) throw new RangeError(`Invalid calendar date "${ymd}"`);
  return d;
}

/** Calendar date → "YYYY-MM-DD". */
export function istDateStringOf(calendarDate: Date): string {
  return calendarDate.toISOString().slice(0, 10);
}

/** Today in Asia/Kolkata as a calendar date. */
export function todayIST(now: Date = new Date()): Date {
  return dateOnly(istDateString(now));
}

/** Add whole days to a calendar date. */
export function addDays(calendarDate: Date, days: number): Date {
  if (!Number.isInteger(days)) throw new TypeError("days must be an integer");
  return new Date(calendarDate.getTime() + days * DAY_MS);
}

/** Whole days from `from` to `to` (both calendar dates). Positive when `to` is later. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** Days from today (IST) until a calendar date. Negative when it has passed. */
export function daysUntil(calendarDate: Date, now: Date = new Date()): number {
  return daysBetween(todayIST(now), calendarDate);
}

/** Format a calendar date, e.g. formatDate(d) → "28 Nov". */
export function formatDate(calendarDate: Date, pattern = "d MMM"): string {
  return formatInTimeZone(calendarDate, "UTC", pattern);
}

/** Format an instant in IST, e.g. formatIST(t, "h:mm a") → "11:42 PM". */
export function formatIST(at: Date, pattern = "d MMM, h:mm a"): string {
  return formatInTimeZone(at, IST, pattern);
}

/** An IST wall-clock time on a calendar day → instant. istDateTime("2026-11-10", "08:00"). */
export function istDateTime(ymd: string, hhmm: string): Date {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new RangeError(`Expected HH:mm, got "${hhmm}"`);
  dateOnly(ymd);
  return fromZonedTime(`${ymd}T${hhmm}:00`, IST);
}

/** Current hour (0–23) in IST. */
export function istHour(now: Date = new Date()): number {
  return Number(formatInTimeZone(now, IST, "H"));
}

export function greeting(now: Date = new Date()): string {
  const h = istHour(now);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** The instant an IST calendar day starts (00:00 Asia/Kolkata). */
export function istStartOfDay(calendarDate: Date): Date {
  return istDateTime(istDateStringOf(calendarDate), "00:00");
}

/** First day of the IST calendar month containing `calendarDate`, shifted by `monthsBack`. */
export function monthStart(calendarDate: Date, monthsBack = 0): Date {
  return new Date(Date.UTC(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth() - monthsBack, 1));
}

/** Monday of the IST calendar week containing `calendarDate`. */
export function weekStart(calendarDate: Date): Date {
  const dow = (calendarDate.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(calendarDate, -dow);
}
