export { clockOpts, clockText, setTimeFormat, stampOpts } from "./time-format.js";
import { clockOpts } from "./time-format.js";
import type { Assignee, Bucket, Card } from "./types.js";

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "5m ago", or the date ("Nov 18") once `ago` has fallen back to one. */
export function agoLabel(iso: string, now = Date.now()): string {
  const a = ago(iso, now);
  return a === "now" ? "just now" : /^\d+[mhd]$/.test(a) ? `${a} ago` : a;
}

/** How long something has been running: "40s", "12m", "1h 5m". */
export function elapsed(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "Researcher", or "Codex" for "Engineer · Codex (gpt-5.5, high effort)". */
export function agentShort(agent: string): string {
  return agent.replace(/^Engineer · /, "").replace(/ \(.*\)$/, "");
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts() });
}

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const PRIORITY_NAMES: Record<string, string> = { critical: "Urgent", high: "High", medium: "Normal", low: "Low" };

/** Short names on cards: "Codex" for "Engineer · Codex". */
export function shortName(a: Assignee | undefined): string {
  if (!a) return "";
  if (a.kind === "me") return "You";
  return a.name.replace(/^Engineer · /, "");
}

/** What an agent is @-mentioned by: its name without spaces (the server matches it). */
export const handleOf = (a: Assignee) => a.name.replace(/\s+/g, "");

/** Labels that say where a task came from; the rest are shown as plain tags. */
export const SOURCE_NAMES: Record<string, string> = {
  "needs-response": "Reply",
  email: "Email",
  "meeting-action": "Meeting",
  todo: "Todo",
  engineer: "Code",
  "needs-review": "Review",
};

export function matches(card: Card, q: string): boolean {
  if (!q) return true;
  const hay = `${card.title} ${card.identifier} ${card.labels.map((l) => l.name).join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

/** "Oct 15" for a YYYY-MM-DD date (as written) or an instant (local). */
export function shortDate(d: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date(d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Paperclip's limit for one attached file. */
export const MAX_FILE = 10 * 1024 * 1024;
export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** "Thu, Oct 15" for a YYYY-MM-DD date. */
export const dayDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "Thu, Oct 15, 7:00 AM" for an instant, in the board's timezone. */
export function runTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", ...clockOpts(), timeZone });
}

/** The date `n` days after a YYYY-MM-DD date. */
export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Today's YYYY-MM-DD in the board's timezone (or the date of `at`). */
export function todayIn(timeZone: string | undefined, at = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** When an instant falls, in the board's timezone: "today 8:00 AM", "tomorrow 8:00 AM", "Thu 8:00 AM" within a week, else "Oct 15, 8:00 AM". */
export function dueWords(iso: string, timeZone: string | undefined, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { ...clockOpts(), timeZone });
  const today = todayIn(timeZone, now), day = todayIn(timeZone, at);
  if (day === today) return `today ${time}`;
  if (day === addDays(today, 1)) return `tomorrow ${time}`;
  if (day > today && day <= addDays(today, 6)) return `${at.toLocaleDateString(undefined, { weekday: "short", timeZone })} ${time}`;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone })}, ${time}`;
}

/** Where Snooze parks a task until `date`: tomorrow waits in Tomorrow, 2 to 7 days out in Later, further out in Backlog. */
export function parkBucket(today: string, date: string): Bucket {
  return date <= addDays(today, 1) ? "tomorrow" : date <= addDays(today, 7) ? "later" : "backlog";
}

/** "Thu" for a date within a week of `today`, else "Oct 15". */
export const untilLabel = (today: string, date: string) =>
  date <= addDays(today, 7) ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" }) : shortDate(date);

/**
 * Snooze's presets from `today`: tomorrow, in 2 days, Friday (when it's later than that) and next
 * Monday, each date offered once.
 */
export function snoozeOptions(today: string): { label: string; date: string }[] {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const options = [
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "In 2 days", date: addDays(today, 2) },
    ...(dow >= 1 && dow <= 2 ? [{ label: "Later this week", date: addDays(today, 5 - dow) }] : []),
    { label: "Next week", date: addDays(today, (8 - dow) % 7 || 7) },
  ];
  return options.filter((o, i) => options.findIndex((x) => x.date === o.date) === i);
}

/**
 * A local install's app door (`http://<app>.localhost:<port>`, docs/design/app-doors.md). Its sign-in lives in Secure
 * cookies on plain http, which Chrome and Firefox keep on localhost and Safari doesn't.
 */
export const isLocalDoor = (url?: string): boolean => !!url && /^http:\/\/[a-z][a-z0-9-]*\.localhost:\d+\/?$/.test(url);
let secureOnHttp: boolean | undefined;
/** Does this browser keep a Secure cookie on this plain-http page (the board on loopback)? Checked once, with a throwaway cookie. */
export function keepsSecureCookies(): boolean {
  if (secureOnHttp !== undefined) return secureOnHttp;
  if (typeof document === "undefined" || location.protocol !== "http:") return (secureOnHttp = true);
  const probe = "aidenhq-secure-probe";
  document.cookie = `${probe}=1; Path=/; Secure; SameSite=Strict; Max-Age=5`;
  secureOnHttp = document.cookie.split("; ").includes(`${probe}=1`);
  document.cookie = `${probe}=; Path=/; Secure; SameSite=Strict; Max-Age=0`;
  return secureOnHttp;
}

/** Whether the browser knows this IANA zone (a typo in a schedule's zone must not break the page that shows it). */
export const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** A run time: the clock time, with the weekday when it isn't today; in `zone` when given and valid, else the browser's. */
export const runAt = (iso: string, zone?: string) => {
  const d = new Date(iso);
  const timeZone = zone && validZone(zone) ? zone : undefined;
  const dayOf = (x: Date) => x.toLocaleDateString("en-CA", { timeZone });
  const day = dayOf(d) === dayOf(new Date()) ? "" : `${d.toLocaleDateString(undefined, { weekday: "short", timeZone })} `;
  return `${day}${d.toLocaleTimeString(undefined, { ...clockOpts(), timeZone })}`;
};
