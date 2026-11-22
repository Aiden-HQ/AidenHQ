// Settings in the owner's words: a schedule's cron as "weekdays 8:45", a model id as its short name, a change as the exact
// instance.yaml lines it asks for. Pure, so it is tested without a browser (test/settings-format.test.ts).
import type { AgentSettings, SettingChange, SettingRow } from "./types.js";

const DAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

function days(dow: string): string | null {
  if (dow === "*") return "daily";
  if (dow === "1-5") return "weekdays";
  if (dow === "0,6" || dow === "6,0" || dow === "6-7" || dow === "6,7") return "weekends";
  const list = dow.split(",").map((d) => num(d) % 7);
  if (list.some(Number.isNaN)) return null;
  return list.length === 1 ? DAY[list[0]!]! : list.map((d) => SHORT[d]).join(", ");
}

/** A cron line in plain words ("weekdays 8:45", "every 4h", "every 30 min, 8:00 to 20:59"); the cron itself when it's unusual. */
export function cronText(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (mon !== "*") return cron;
  const on = days(dow);
  if (!on) return cron;
  const tail = on === "daily" ? "" : `, ${on}`;
  let every;
  if ((every = /^\*\/(\d+)$/.exec(m)) && dom === "*") {
    const range = /^(\d+)-(\d+)$/.exec(h);
    if (h === "*") return `every ${every[1]} min${tail}`;
    if (range) return `every ${every[1]} min, ${range[1]}:00 to ${range[2]}:59${tail}`;
    return cron;
  }
  if (!/^\d+$/.test(m)) return cron;
  if ((every = /^\*\/(\d+)$/.exec(h)) && dom === "*") return `${every[1] === "1" ? "hourly" : `every ${every[1]}h`}${tail}`;
  if (h === "*" && dom === "*") return `hourly${tail}`;
  const hours = h.split(",").map(num);
  if (hours.some(Number.isNaN)) return cron;
  const times = hours.map((x) => `${x}:${pad(Number(m))}`).join(" and ");
  if (dom !== "*") {
    const d = num(dom);
    if (Number.isNaN(d) || dow !== "*") return cron;
    const nth = d === 1 || d === 21 || d === 31 ? "st" : d === 2 || d === 22 ? "nd" : d === 3 || d === 23 ? "rd" : "th";
    return `monthly on the ${d}${nth}, ${times}`;
  }
  return `${on} ${times}`;
}

/** "openrouter/~deepseek/deepseek-flash-latest" → "deepseek-flash": the part a person recognizes. */
export const modelShort = (id: string) => (id ? id.split("/").at(-1)!.replace(/^~/, "").replace(/-latest$/, "") : "");

/** When an agent wakes, in a few words: its heartbeat and its routines' schedules, the rest as "+N". */
export function wakeText(a: AgentSettings): { text: string; full: string[] } {
  const parts: { text: string; raw: string }[] = [];
  if (a.heartbeatHours) parts.push({ text: `every ${a.heartbeatHours}h`, raw: "heartbeat" });
  for (const r of a.routines.filter((x) => !x.key.startsWith("heartbeat-")))
    for (const s of r.schedules) parts.push({ text: cronText(s.cron), raw: `${r.title}: ${s.cron}${s.timezone ? ` (${s.timezone})` : ""}` });
  if (!parts.length) return { text: a.routines.some((r) => r.webhook) ? "on an event" : "when asked", full: [] };
  const shown = [...new Set(parts.map((p) => p.text))];
  return { text: shown.length > 2 ? `${shown.slice(0, 2).join(", ")} +${shown.length - 2}` : shown.join(", "), full: parts.map((p) => `${p.text}  (${p.raw})`) };
}

/** A value as YAML would write it, for the preview (the board writes the real lines with a YAML library). */
export function yamlValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(not set)";
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${yamlValue(x)}`).join(", ")} }`;
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** What a value shows as on the page. */
export const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "not set" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** The preview lines of a change: where in instance.yaml, what it was, what it becomes. */
export function changeLines(ch: SettingChange, was: unknown): { path: string; from: string; to: string } {
  if (ch.kind === "setting") return { path: `settings.${ch.key}`, from: yamlValue(was), to: yamlValue(ch.value) };
  if (ch.kind === "module") return { path: "modules", from: ch.on ? "(without it)" : `(with ${ch.name})`, to: ch.on ? `+ ${ch.name}` : `- ${ch.name}` };
  if (ch.kind === "routine") return { path: `overrides.routines.${ch.routine}.${ch.field}`, from: yamlValue(was), to: yamlValue(ch.value) };
  if (ch.kind === "agent") return { path: `overrides.agents.${ch.agent}.${ch.field}`, from: yamlValue(was), to: yamlValue(ch.value) };
  if (ch.kind === "pin") return { path: `modules.${ch.name}`, from: yamlValue(was), to: ch.sha ?? "(follows its marketplace)" };
  if (ch.kind === "grants") return { path: `overrides.agents.${ch.agent}.connections.${ch.connection}`, from: yamlValue(was), to: ch.tools === null ? "(the module's)" : yamlValue(ch.tools) };
  if (ch.kind === "marketplace") return { path: `marketplaces.${ch.name}`, from: yamlValue(was), to: ch.op };
  if (ch.kind === "share") return { path: `${ch.repo} ${ch.ref}`, from: ch.base.slice(0, 12), to: `+ ${ch.module}/` };
  if (ch.kind === "unfork") return { path: `overrides.agents.${ch.agent}.handbook_fork`, from: "(own copy)", to: "(the module's handbook)" };
  return { path: ch.kind === "rules" ? `agents/${ch.agent}.md` : `agents/${ch.agent}/AGENTS.md`, from: yamlValue(was), to: ch.text.slice(0, 80) };
}


/** A setting row's value as the change sends it: the input's text back to the setting's type. */
export function parseInput(s: SettingRow, text: string): unknown {
  const like = s.default ?? s.value;
  if (typeof like === "number") return Number(text);
  if (Array.isArray(like)) return text.split(",").map((x) => x.trim()).filter(Boolean);
  if (typeof like === "boolean") return text === "true";
  return text.trim();
}
