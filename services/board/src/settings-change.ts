// A settings change from the board's pages (docs/design/settings-changes.md): a typed change, checked against the compiled
// config and the module catalog, and filed as the owner's own task with no assignee. The kernel (kernel/src/settings-change.ts)
// checks it again, has the instance repo's code host write exactly the files the change names and files the kernel.apply,
// tiered by its planner; nothing here writes or applies anything.
import { z } from "zod";
import type { Approval } from "./records.js";
import { HEARTBEAT_HOURS, HEARTBEAT_TOOLS, type Compiled } from "./settings.js";
import { EFFORTS, compiledEngine } from "./board.js";
import { urlSettingProblem } from "./url-setting.js";

const KEY = z.string().regex(/^[a-z][a-z0-9_]{0,60}$/);
const AGENT = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const CAP = z.number().positive().max(1000);
const SCALAR = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const MODEL = z.string().regex(/^[A-Za-z0-9~][\w./~:@-]{0,119}$/);
/** Handbook text: Markdown without control characters but tab and newlines. */
const TEXT = (max: number) => z.string().max(max).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/);
const SCHEDULE = z.object({ cron: z.string().regex(/^[0-9*/,\- ]{9,100}$/), timezone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$|^UTC$/).optional(), label: z.string().max(60).regex(/^[^\x00-\x1f\x7f$]*$/).optional() }).strict();
export const ChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setting"), key: KEY, value: z.union([SCALAR, z.array(z.union([z.string().max(200), z.number().finite()])).max(50)]) }).strict(),
  z.object({ kind: z.literal("agent"), agent: AGENT, field: z.enum(["model", "reasoning_effort", "heartbeat"]), value: SCALAR }).strict(),
  // An agent's own spend caps (overrides.agents.<key>.caps; the owner's, Tier 2), USD.
  z.object({ kind: z.literal("caps"), agent: AGENT, value: z.object({ run_usd: CAP, task_usd: CAP, day_usd: CAP }).partial().strict() }).strict(),
  // A module on or off (instance.yaml modules:; the owner's, Tier 2). On for a module of a configured marketplace installs it.
  z.object({ kind: z.literal("module"), name: NAME, on: z.boolean() }).strict(),
  // A routine's schedules, status or model (overrides.routines.<key>).
  z.discriminatedUnion("field", [
    z.object({ kind: z.literal("routine"), routine: NAME, field: z.literal("schedules"), value: z.array(SCHEDULE).max(10) }).strict(),
    z.object({ kind: z.literal("routine"), routine: NAME, field: z.literal("status"), value: z.enum(["active", "paused"]) }).strict(),
    z.object({ kind: z.literal("routine"), routine: NAME, field: z.literal("model"), value: MODEL }).strict(),
  ]),
  // The owner's rules for an agent: agents/<key>.md (a module agent; empty deletes it), or an instance agent's whole handbook.
  z.object({ kind: z.literal("rules"), agent: AGENT, text: TEXT(120_000) }).strict(),
  // A module agent's own copy of its main handbook (agents/<key>/AGENTS.md + overrides.agents.<key>.handbook_fork).
  z.object({ kind: z.literal("handbook"), agent: AGENT, text: TEXT(120_000).min(1) }).strict(),
  // Back to the module's handbook: the fork and its override go.
  z.object({ kind: z.literal("unfork"), agent: AGENT }).strict(),
  // A module at its own commit, or following its marketplace again (null).
  z.object({ kind: z.literal("pin"), name: NAME, sha: SHA.nullable() }).strict(),
  z.object({ kind: z.literal("marketplace"), op: z.enum(["add", "update", "remove"]), name: NAME, source: z.object({ source: z.literal("github"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict().optional(), sha: SHA.optional() }).strict(),
  // An agent's tools on one connection (overrides.agents.<key>.connections.<id>); null resets it to the module's grant.
  z.object({ kind: z.literal("grants"), agent: AGENT, connection: KEY, tools: z.array(z.string().max(100)).max(200).nullable() }).strict(),
]);
export const ChangesSchema = z.object({ changes: z.array(ChangeSchema).min(1).max(10) }).strict();
export type Change = z.infer<typeof ChangeSchema>;

interface Catalog {
  name: string;
  enabled: boolean;
  /** A per-module pin (instance.yaml modules: - { id, sha }). */
  pinned?: string;
  /** Listed in instance.yaml modules: (an enabled module that isn't chosen is on as a dependency). */
  chosen?: boolean;
  settings?: Record<string, { default?: unknown; values?: unknown[]; type?: string; host?: string }>;
}

export class ChangeRefused extends Error {}

/** The label on the tasks this files, so the page can list them. */
export const SETTINGS_LABEL = "settings-change";

const kindOf = (v: unknown) => (Array.isArray(v) ? "list" : v === null || v === undefined ? "none" : typeof v);
const plain = (s: string) => !/[\x00-\x1f\x7f$]/.test(s);

/** The change, checked; throws ChangeRefused with a reason the owner can act on. */
export function checkChange(ch: Change, compiled: Compiled | null, catalog: Catalog[]): Change {
  if (!compiled) throw new ChangeRefused("the board can't read the compiled config yet");
  if (ch.kind === "setting") {
    if (/token|secret|password/i.test(ch.key)) throw new ChangeRefused(`${ch.key} is a secret: secrets live in the vault, not in settings`);
    const def = catalog.find((m) => m.enabled && m.settings?.[ch.key])?.settings?.[ch.key];
    const current = compiled.settings?.[ch.key];
    if (!def && !current) throw new ChangeRefused(`there is no setting ${ch.key} on this instance`);
    const was = def?.default ?? current?.value;
    // A list of entries ({ repo, label, ... }) would be flattened by a value the page can send: it is edited in instance.yaml.
    if ([current?.value, was].flat().some((v) => v !== null && typeof v === "object")) throw new ChangeRefused(`${ch.key} holds entries: change it in instance.yaml`);
    if (was !== undefined && was !== null && kindOf(was) !== kindOf(ch.value)) throw new ChangeRefused(`${ch.key} is a ${kindOf(was)}`);
    const each = [ch.value].flat();
    if (def?.values) {
      if (Array.isArray(ch.value) && !ch.value.length) throw new ChangeRefused(`${ch.key}: at least one`);
      const bad = each.find((v) => !def.values!.includes(v));
      if (bad !== undefined) throw new ChangeRefused(`${ch.key} can't be ${String(bad)}: one of ${def.values.join(", ")}`);
    }
    if (def?.type === "url") {
      const problem = urlSettingProblem(ch.value, def.host);
      if (problem) throw new ChangeRefused(`${ch.key}: ${problem}`);
    }
    if (each.some((v) => typeof v === "string" && !plain(v))) throw new ChangeRefused(`${ch.key}: no control characters or $`);
    return ch;
  }
  if (ch.kind === "module") {
    const m = catalog.find((x) => x.name === ch.name);
    if (!m) throw new ChangeRefused(`there is no module ${ch.name}`);
    if (ch.name === "kernel") throw new ChangeRefused("the kernel is always on");
    if (Boolean(m.chosen) === ch.on) throw new ChangeRefused(`${ch.name} is already ${ch.on ? "on" : "off"}`);
    return ch;
  }
  if (ch.kind === "pin") {
    const m = catalog.find((x) => x.name === ch.name);
    if (!m || ch.name === "kernel") throw new ChangeRefused(`there is no module ${ch.name}`);
    if (!m.chosen) throw new ChangeRefused(`${ch.name} isn't turned on in instance.yaml: turn it on first`);
    if ((m.pinned ?? null) === ch.sha) throw new ChangeRefused(ch.sha ? `${ch.name} is already at that commit` : `${ch.name} already follows its marketplace`);
    return ch;
  }
  if (ch.kind === "marketplace") {
    if (ch.op === "add" ? !ch.source || !ch.sha : ch.op === "update" ? !ch.sha || ch.source : ch.source || ch.sha) throw new ChangeRefused(ch.op === "add" ? "adding a marketplace names its GitHub owner/repo and a commit" : ch.op === "update" ? "updating a marketplace names only its new commit" : "removing a marketplace names only it");
    return ch;
  }
  if (ch.kind === "routine") {
    if (!compiled.routines?.[ch.routine]) throw new ChangeRefused(`there is no routine ${ch.routine}`);
    return ch;
  }
  const a = compiled.agents?.[ch.agent];
  if (!a) throw new ChangeRefused(`there is no agent ${ch.agent}`);
  const own = a.module === "instance";
  if (ch.kind === "rules") {
    if (own && !ch.text.trim()) throw new ChangeRefused("an instance agent's handbook can't be empty");
    if (!own && ch.text.length > 20_000) throw new ChangeRefused("your rules are at most 20,000 characters: a longer change belongs in the main handbook");
    return ch;
  }
  if (ch.kind === "handbook" || ch.kind === "unfork") {
    if (own) throw new ChangeRefused(`${a.name ?? ch.agent} is the instance's own agent: its whole handbook is its rules`);
    if (ch.kind === "unfork" && !a.handbook_fork) throw new ChangeRefused(`${a.name ?? ch.agent}'s handbook isn't forked`);
    return ch;
  }
  if (ch.kind === "grants") {
    if (own) throw new ChangeRefused(`${a.name ?? ch.agent} is the instance's own agent: its grants are in its agent.yaml`);
    const c = compiled.mcp_servers?.[ch.connection];
    if (!c) throw new ChangeRefused(`there is no connection ${ch.connection}`);
    const all = [...(c.tools?.read ?? []), ...(c.tools?.write ?? []), ...(c.tools?.destructive ?? [])];
    const bad = (ch.tools ?? []).filter((t) => !all.includes(t));
    if (bad.length) throw new ChangeRefused(`${ch.connection} has no tool ${bad.join(", ")}`);
    if (ch.tools && new Set(ch.tools).size !== ch.tools.length) throw new ChangeRefused("each tool once");
    return ch;
  }
  if (ch.kind === "caps") {
    if (!Object.keys(ch.value).length) throw new ChangeRefused("name at least one cap");
    return ch;
  }
  if (ch.field === "model") {
    if (typeof ch.value !== "string" || !/^[A-Za-z0-9~][\w.\/~:@-]{0,119}$/.test(ch.value)) throw new ChangeRefused("a model is its id, like openrouter/~deepseek/deepseek-flash-latest");
  } else if (ch.field === "reasoning_effort") {
    const efforts = EFFORTS[compiledEngine(a) ?? "codex"] ?? [];
    if (!efforts.includes(String(ch.value))) throw new ChangeRefused(efforts.length ? `effort is one of ${efforts.join(", ")}` : `${a.name ?? ch.agent} has no effort setting`);
  } else {
    if (ch.value !== false && !HEARTBEAT_HOURS.includes(Number(ch.value))) throw new ChangeRefused(`a heartbeat is off or every ${HEARTBEAT_HOURS.join(", ")} hours`);
    if (ch.value !== false && a.profile === "engineer") throw new ChangeRefused("an Engineer has no heartbeat (it works on the tasks it is given)");
    if (ch.value !== false && !HEARTBEAT_TOOLS.every((t) => a.enabled_tools?.paperclip_tasks?.includes(t))) throw new ChangeRefused(`${a.name ?? ch.agent} lacks the task tools a heartbeat needs (${HEARTBEAT_TOOLS.join(", ")})`);
  }
  return ch;
}

/** One sentence per change, for the task title and the page. */
export function describe(ch: Change, compiled: Compiled | null): string {
  if (ch.kind === "setting") return `${ch.key} → ${Array.isArray(ch.value) ? ch.value.join(", ") || "none" : ch.value === "" ? "not set" : String(ch.value)}`;
  if (ch.kind === "module") return `${ch.on ? "turn on" : "turn off"} the ${ch.name} module`;
  if (ch.kind === "pin") return ch.sha ? `pin the ${ch.name} module at ${ch.sha.slice(0, 12)}` : `the ${ch.name} module follows its marketplace`;
  if (ch.kind === "marketplace") return `${ch.op} the ${ch.name} marketplace${ch.source ? ` (${ch.source.repo})` : ""}${ch.sha ? ` at ${ch.sha.slice(0, 12)}` : ""}`;
  if (ch.kind === "routine") return `routine ${compiled?.routines?.[ch.routine]?.title ?? ch.routine}: ${ch.field} → ${ch.field === "schedules" ? ch.value.map((x) => x.label ?? x.cron).join(", ") || "none" : ch.value}`;
  const name = compiled?.agents?.[ch.agent]?.name ?? ch.agent;
  if (ch.kind === "rules") return `${name}'s rules${ch.text.trim() ? "" : " cleared"}`;
  if (ch.kind === "handbook") return `${name}'s own handbook`;
  if (ch.kind === "unfork") return `${name} back on its module's handbook`;
  if (ch.kind === "grants") return `${name}'s ${ch.connection} tools → ${ch.tools === null ? "the module's" : ch.tools.join(", ") || "none"}`;
  if (ch.kind === "caps") return `${name}'s caps → ${Object.entries(ch.value).map(([k, v]) => `${k.replace("_usd", "")} $${v}`).join(", ")}`;
  const field = { model: "model", reasoning_effort: "effort", heartbeat: "heartbeat" }[ch.field];
  const v = ch.field === "heartbeat" ? (ch.value === false ? "off" : `every ${ch.value}h`) : String(ch.value);
  return `${name}'s ${field} → ${v}`;
}

const MARK = "aidenhq-settings-change";
/**
 * The owner's settings task: its title, and a description built here from the typed change only (no free text). No agent
 * runs on it: the kernel writes the change the board hands it (kernel/src/settings-change.ts); the hidden marker is for the page.
 */
export function taskFor(changes: Change[], compiled: Compiled | null): { title: string; description: string } {
  const lines = changes.map((c) => describe(c, compiled));
  const title = `Settings: ${lines.join("; ")}`.slice(0, 160);
  const description = [
    "Changed from the board. The kernel writes exactly this change to the instance repo and files the apply here; no agent works on this task.",
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    `<!-- ${MARK} ${Buffer.from(JSON.stringify(changes)).toString("base64")} -->`,
  ].join("\n");
  return { title, description };
}

/** The typed changes a settings task was filed with (its hidden marker), or undefined for any other task. */
export function changesOf(description: string | null | undefined): Change[] | undefined {
  const m = new RegExp(`<!-- ${MARK} ([A-Za-z0-9+/=]+) -->`).exec(description ?? "");
  if (!m) return undefined;
  try {
    return ChangesSchema.parse({ changes: JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) }).changes;
  } catch {
    return undefined;
  }
}

export type Stage = "working" | "waiting" | "applying" | "applied" | "failed" | "rejected" | "closed";

/** Where a settings task stands, from its task status and its newest apply card. */
export function stageOf(status: string, cards: Pick<Approval, "action" | "state" | "outcome" | "tier" | "outcomeText" | "id">[]): { stage: Stage; tier?: number; approval?: string; detail?: string } {
  const a = cards.find((c) => c.action === "apply");
  if (a) {
    if (a.outcome === "applied") return { stage: "applied", approval: a.id };
    if (a.outcome === "failed") return { stage: "failed", approval: a.id, ...(a.outcomeText ? { detail: a.outcomeText.slice(-300) } : {}) };
    if (a.state === "pending") return { stage: "waiting", tier: a.tier, approval: a.id };
    if (a.state === "approved" || a.state === "used") return { stage: "applying", approval: a.id };
    if (a.state === "rejected" || a.state === "stale" || a.state === "expired") return { stage: "rejected", approval: a.id };
  }
  return status === "done" || status === "cancelled" ? { stage: "closed" } : { stage: "working" };
}
