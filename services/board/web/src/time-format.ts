// The owner's `time_format` setting (the board read carries it) as Intl options and words for the web app: 12h is the default.
// No browser or board types, so Node tests and the schedule words reach it.
import { clockWords, timeFormatOf } from "../../src/clock.js";

let hour12 = true;
export const setTimeFormat = (f: string | undefined) => void (hour12 = timeFormatOf(f) === "12h");
/** A time of day as words ("8:00 AM" or "08:00"): for an hour and minute with no date, such as a schedule. */
export const clockText = (hour: number, minute = 0) => clockWords(hour, minute, hour12 ? "12h" : "24h");
/** Intl options for a clock time in the owner's format: "8:00 PM" (12h) or "20:00" (24h). Spread them into any date format. */
export const clockOpts = (): Intl.DateTimeFormatOptions => (hour12 ? { hour: "numeric", minute: "2-digit", hourCycle: "h12" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Options for a full date and time (tooltips): "11/27/2026, 8:00:05 PM". */
export const stampOpts = (): Intl.DateTimeFormatOptions => ({ year: "numeric", month: "numeric", day: "numeric", ...clockOpts(), second: "2-digit" });
