// A time of day in the owner's `time_format` setting (kernel/settings.json): the one formatter of a clock time written as
// words, for the board's server and its web app. Machine values (ISO instants, "HH:MM" inputs) stay 24-hour.
export type TimeFormat = "12h" | "24h";

/** The setting's value as a format: 12h unless the owner chose 24h. */
export const timeFormatOf = (v: unknown): TimeFormat => (v === "24h" ? "24h" : "12h");

/** "8:45 AM" (12h) or "08:45" (24h) for an hour (0-23) and minute. */
export function clockWords(hour: number, minute: number, fmt: TimeFormat): string {
  const mm = String(minute).padStart(2, "0");
  return fmt === "24h" ? `${String(hour).padStart(2, "0")}:${mm}` : `${hour % 12 || 12}:${mm} ${hour < 12 ? "AM" : "PM"}`;
}

/** The same for a "HH:MM" string (anything else is returned as it came). */
export function hhmmWords(hhmm: string, fmt: TimeFormat): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? clockWords(Number(m[1]), Number(m[2]), fmt) : hhmm;
}
