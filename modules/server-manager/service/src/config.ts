// The servers this module maintains: settings.servers_machines as the instance holds it (a JSON list of entries), each entry's
// defaults, and the rules an entry follows (spec §9). One function is the reader for the page, the validate hook and (slice 2) the
// scheduler, so a machine the owner saves is the machine every path acts on.
//
// Nothing here holds or echoes a key: an entry names a key (`key`), and the value lives only in the servers_keys vault map, which
// the SSH transport reads by that name at connect time.

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type RebootPolicy = "auto" | "ask";

/** An entry after its defaults: the whole of one machine's configuration. */
export interface Machine {
  name: string;
  address: string;
  port: number;
  user: string;
  key: string;
  enabled: boolean;
  expected_fingerprint: string;
  security_minutes: number;
  weekly_day: Weekday;
  weekly_time: string;
  reboot_policy: RebootPolicy;
  quiet_start: string;
  quiet_end: string;
}

/** What an entry says when it leaves a field out: four fields are all a new machine needs (name, address, user, key). */
export const DEFAULTS = {
  port: 22,
  enabled: true,
  expected_fingerprint: "",
  security_minutes: 60,
  weekly_day: "mon" as Weekday,
  weekly_time: "03:00",
  reboot_policy: "auto" as RebootPolicy,
  quiet_start: "03:00",
  quiet_end: "05:00",
};

/** Every field an entry may carry, and the one field a machine identity is (`entry: name` in module.yaml). */
export const MACHINE_FIELDS = ["name", "address", "port", "user", "key", "enabled", "expected_fingerprint", "security_minutes", "weekly_day", "weekly_time", "reboot_policy", "quiet_start", "quiet_end"] as const;
export const REQUIRED_FIELDS = ["name", "address", "user", "key"] as const;

// The patterns are module.yaml's and spec §9's, one shape each; `address` never carries a user or a URL, so the SSH target is
// always built as user@address with -p port.
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS = /^[A-Za-z0-9.:[\]-]{1,253}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FINGERPRINT = /^(SHA256:[A-Za-z0-9+/]{43})?$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export type Problem = { field: string; message: string };
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The problems with one entry, each under `<list>[<index>].<field>` (or `<list>.<field>` at the top). */
export function entryProblems(entry: unknown, at: string): Problem[] {
  if (!isMap(entry)) return [{ field: at, message: "an entry is an object (name, address, user, key, and any schedule or reboot setting)" }];
  const out: Problem[] = [];
  for (const k of Object.keys(entry)) if (!(MACHINE_FIELDS as readonly string[]).includes(k)) out.push({ field: `${at}.${k}`, message: `isn't a server setting (one of ${MACHINE_FIELDS.join(", ")})` });
  for (const k of REQUIRED_FIELDS) if (entry[k] == null) out.push({ field: `${at}.${k}`, message: "is required" });
  // An explicit null would override the default (`port: null` reaches ssh as `-p null`); leave a field out to use its default.
  for (const [k, v] of Object.entries(entry)) if (v === null && !(REQUIRED_FIELDS as readonly string[]).includes(k)) out.push({ field: `${at}.${k}`, message: "has no value: leave it out to use the default" });
  const text = (k: string, re: RegExp, why: string) => {
    const v = entry[k];
    if (v == null) return;
    if (typeof v !== "string" || !re.test(v)) out.push({ field: `${at}.${k}`, message: why });
  };
  text("name", NAME, "is lowercase letters, digits and -, up to 32 characters");
  text("address", ADDRESS, "is a host name or address (letters, digits, . : [ ] -), never a user or a URL");
  text("user", USER, "is the login name: lowercase letters, digits, _ and -, up to 32 characters, not starting with a digit or -");
  text("key", KEY, "is the name of one key in the Sign-ins panel: lowercase letters, digits, _ and -, up to 63 characters");
  text("expected_fingerprint", FINGERPRINT, "is empty, or an SSH fingerprint as SHA256:<43 characters>");
  text("weekly_time", HHMM, "is a 24-hour time, HH:MM");
  text("quiet_start", HHMM, "is a 24-hour time, HH:MM");
  text("quiet_end", HHMM, "is a 24-hour time, HH:MM");
  const port = entry.port;
  if (port != null && !(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535)) out.push({ field: `${at}.port`, message: "is a port, 1 to 65535" });
  const minutes = entry.security_minutes;
  if (minutes != null && !(typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440)) out.push({ field: `${at}.security_minutes`, message: "is how often to check, in minutes: 15 to 1440" });
  if (entry.enabled != null && typeof entry.enabled !== "boolean") out.push({ field: `${at}.enabled`, message: "is true or false" });
  if (entry.weekly_day != null && !(WEEKDAYS as readonly unknown[]).includes(entry.weekly_day)) out.push({ field: `${at}.weekly_day`, message: `is one of ${WEEKDAYS.join(", ")}` });
  if (entry.reboot_policy != null && entry.reboot_policy !== "auto" && entry.reboot_policy !== "ask") out.push({ field: `${at}.reboot_policy`, message: "is auto (reboot in the window) or ask (ask the owner first)" });
  return out;
}

/** The problems with the whole list: each entry, and a name listed twice (a name is a machine's identity). */
export function listProblems(list: unknown, at = "servers_machines"): Problem[] {
  if (list == null) return [];
  if (!Array.isArray(list)) return [{ field: at, message: "is a list of servers, one entry each" }];
  const out = list.flatMap((e, i) => entryProblems(e, `${at}[${i}]`));
  const seen = new Set<string>();
  list.forEach((e, i) => {
    if (!isMap(e) || typeof e.name !== "string") return;
    if (seen.has(e.name)) out.push({ field: `${at}[${i}].name`, message: `${e.name} is listed twice: a machine is named once` });
    seen.add(e.name);
  });
  return out;
}

/** One entry with its defaults applied (the caller checked it first: a bad value is kept as it is and reported). */
export function withDefaults(entry: Record<string, unknown>): Machine {
  const m = { ...DEFAULTS, ...entry } as Machine;
  return m;
}

/** settings.servers_machines as a service reads it: the machines that pass, and the problems (never a guess at a bad entry). */
export function readMachines(text: string | undefined): { machines: Machine[]; problems: Problem[] } {
  let list: unknown = [];
  try {
    list = text && text.trim() ? JSON.parse(text) : [];
  } catch {
    return { machines: [], problems: [{ field: "servers_machines", message: "isn't JSON; the servers list can't be read" }] };
  }
  const problems = listProblems(list);
  const bad = new Set(problems.map((p) => /\[(\d+)\]/.exec(p.field)?.[1]).filter((x): x is string => x !== undefined));
  const machines = (Array.isArray(list) ? list : []).flatMap((e, i) => (isMap(e) && !bad.has(String(i)) ? [withDefaults(e)] : []));
  return { machines, problems };
}

/** The names of the machines that sign in with this key (for the validate hook's "still in use" answer). */
export function machinesUsingKey(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => (isMap(e) && e.key === key && typeof e.name === "string" ? [e.name] : []));
}

/**
 * The names of every saved entry that still names this key, valid or not: `readMachines` drops an entry with a bad field, but the
 * entry is still in the instance's list with its key, so a clear of that key must still be refused (the key would be gone before
 * the owner fixes the bad field). A nameless entry is reported under its position, since the Sign-ins panel names keys by entry.
 */
export function savedUsersOfKey(text: string | undefined, key: string): string[] {
  let list: unknown = [];
  try { list = text && text.trim() ? JSON.parse(text) : []; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.flatMap((e, i) => (isMap(e) && e.key === key ? [typeof e.name === "string" && e.name ? e.name : `entry ${i + 1}`] : []));
}

/** The list the instance holds, as entries (a broken saved list is not one to compare a draft against). */
export function savedList(text: string | undefined): Record<string, unknown>[] | undefined {
  try {
    const list = text && text.trim() ? JSON.parse(text) : [];
    if (!Array.isArray(list)) return undefined;
    return list.filter(isMap);
  } catch { return undefined; }
}
