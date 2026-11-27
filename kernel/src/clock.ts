// A time of day in the owner's `time_format` setting (kernel/settings.json), as the kernel's own pages and notices write it.
// A leaf module on purpose: the contract lock imports kernel/src/backplane.ts (and so admin.ts) with only the scripts package
// installed, so a page's helpers must not pull in updates.ts's dependencies (yaml, the compiler).
// Machine values (ISO instants, "HH:MM" inputs, cron lines) stay 24-hour.

/** The night, in the owner's timezone: an automatic install starts at or after FROM and before TO. */
export const NIGHT = { from: 2, to: 5 };

/** An hour of the owner's day as he reads it: "2:00 AM" (time_format 12h, the default) or "02:00" (24h). */
export const hourWords = (hour: number, format?: string) => (format === "24h" ? `${String(hour).padStart(2, "0")}:00` : `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`);
