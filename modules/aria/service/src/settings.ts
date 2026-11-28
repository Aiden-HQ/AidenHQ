// Aria's settings as the service holds them: the five module.yaml settings (the instance's value, or the module's default),
// checked whole. One shape per setting; a bad value is refused with a sentence the owner can act on, on every path (the page's
// Save goes through aria_configure, which calls validate before it proposes anything).
type Dict = Record<string, unknown>;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const KEYS = ["aria_working_hours", "aria_stretch_hours", "aria_blocking_calendars", "aria_preferences", "aria_optimizer_prompt"] as const;
export type Key = (typeof KEYS)[number];

/** The module's defaults: modules/aria/module.yaml `settings:` carries the same values (test/settings.test.ts keeps them equal). */
export const DEFAULTS: Record<Key, unknown> = {
  aria_working_hours: { mon: "09:00-18:00", tue: "09:00-18:00", wed: "09:00-18:00", thu: "09:00-18:00", fri: "09:00-18:00", sat: "off", sun: "off" },
  aria_stretch_hours: 2,
  aria_blocking_calendars: ["primary"],
  aria_preferences: { lines: [] },
  aria_optimizer_prompt: "Tighten my next 10 working days: move a meeting to a better window or to close a gap, one occurrence at a time. Move only meetings I organise, never one starting within 24 hours, and only where everyone invited is free; move team-only meetings without asking and leave the rest. Leave alone anything I moved, refused or named a time for. Move at most 3 meetings a night. Note each move and what you left alone on your task.",
};

const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** "09:00-12:00,13:00-18:00" as [start, end] minutes of the day; "off" (or nothing) is no range. Throws on a bad range. */
export function ranges(text: string): [number, number][] {
  const t = text.trim();
  if (t === "off" || t === "") return [];
  const out = t.split(",").map((r) => {
    const x = r.trim();
    if (!RANGE.test(x)) throw new Error(`"${x}" isn't a time range like 09:00-18:00`);
    const [a, b] = x.split("-") as [string, string];
    if (minutes(b) <= minutes(a)) throw new Error(`"${x}" ends before it starts`);
    return [minutes(a), minutes(b)] as [number, number];
  });
  for (let i = 1; i < out.length; i++) if (out[i]![0] < out[i - 1]![1]) throw new Error(`"${t}" has ranges that overlap or are out of order`);
  return out;
}

const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const strings = (v: unknown, max: number, len: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.trim() === s && s.length >= 1 && s.length <= len);
const only = (v: Dict, keys: string[], label: string) => { const x = Object.keys(v).find((k) => !keys.includes(k)); if (x) throw new Error(`${label}: there is no ${x.slice(0, 40)} (${keys.join(", ")})`); };

/** Why `value` isn't a good `key`, or undefined. Whole value, never a partial one. */
export function problem(key: Key, value: unknown): string | undefined {
  try {
    switch (key) {
      case "aria_working_hours": {
        if (!isMap(value)) return "working hours is a map of weekdays";
        only(value, [...DAYS], key);
        for (const d of DAYS) if (typeof value[d] !== "string") return `${d} needs hours like 09:00-18:00, or off`;
        for (const d of DAYS) { try { ranges(value[d] as string); } catch (e) { return `${d}: ${(e as Error).message}`; } }
        return undefined;
      }
      case "aria_stretch_hours":
        return int(value, 0, 6) ? undefined : "stretch hours is 0 to 6";
      case "aria_blocking_calendars":
        return strings(value, 20, 200) && (value as string[]).length >= 1 ? undefined : "blocking calendars is a list of at least one calendar (primary, or its address)";
      case "aria_preferences": {
        if (!isMap(value)) return "preferences is { lines: [...] }";
        only(value, ["lines"], key);
        if (!strings(value.lines, 20, 300)) return "up to 20 lines of at most 300 characters each";
        return undefined;
      }
      case "aria_optimizer_prompt":
        return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 500 && !/[$\r\n]/.test(value) ? undefined : "the tidy-up prompt is one paragraph of 1 to 500 characters, without a line break or a dollar sign";
    }
  } catch (e) { return (e as Error).message; }
}

/** The problems with a whole settings map, by key. */
export function problems(all: Partial<Record<Key, unknown>>): Partial<Record<Key, string>> {
  const out: Partial<Record<Key, string>> = {};
  for (const k of KEYS) { const p = problem(k, all[k]); if (p) out[k] = p; }
  return out;
}

const parse = (text: string | undefined): unknown => { try { return text === undefined || text === "" ? undefined : JSON.parse(text); } catch { return undefined; } };

/** The settings from the service's environment (the instance's values, else the defaults). A list of scalars reaches the service comma-joined. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Record<Key, unknown> {
  const from = (name: string, key: Key) => {
    const raw = env[name];
    const v = key === "aria_optimizer_prompt" ? raw || undefined : key === "aria_blocking_calendars" ? (raw ? raw.split(",").map((x) => x.trim()).filter(Boolean) : undefined) : key === "aria_stretch_hours" ? (raw === undefined || raw === "" ? undefined : Number(raw)) : parse(raw);
    return v === undefined ? DEFAULTS[key] : v;
  };
  return Object.fromEntries(KEYS.map((k) => [k, from(`ARIA_${k.slice(5).toUpperCase()}`, k)])) as Record<Key, unknown>;
}
