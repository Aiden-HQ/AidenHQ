// A settings change from the board's pages (docs/design/settings-changes.md): a typed change, checked against the compiled
// config and the module catalog, and filed as the owner's own task (held by him, off the board's columns). The kernel
// (kernel/src/settings-change.ts) checks it again, has the instance repo's code host write exactly the files the change names
// and files the kernel.apply, decided as the signed-in owner's account; nothing here writes or applies anything.
import { z } from "zod";
import type { Approval } from "./records.js";
import { HEARTBEAT_HOURS, HEARTBEAT_TOOLS, type Compiled } from "./settings.js";
import { EFFORTS, compiledEngine } from "./board.js";
import { urlSettingProblem } from "./url-setting.js";

const KEY = z.string().regex(/^[a-z][a-z0-9_]{0,60}$/);
const AGENT = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const NAME = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const SCALAR = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const MODEL = z.string().regex(/^[A-Za-z0-9~][\w./~:@-]{0,119}$/);
/** Handbook text: Markdown without control characters but tab and newlines. */
const TEXT = (max: number) => z.string().max(max).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/);
const SCHEDULE = z.object({ cron: z.string().regex(/^[0-9*/,\- ]{9,100}$/), timezone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$|^UTC$/).optional(), label: z.string().max(60).regex(/^[^\x00-\x1f\x7f$]*$/).optional() }).strict();
export const ChangeSchema = z.discriminatedUnion("kind", [
  // A setting a module declares `type: object` takes a whole map (settings.code_review); one it declares `entry:` takes a list whose entries may be maps (maintainer_repos). checkChange holds each to its declaration.
  z.object({ kind: z.literal("setting"), key: KEY, value: z.union([SCALAR, z.array(z.union([z.string().max(200), z.number().finite(), z.record(z.string(), z.unknown())])).max(50), z.record(z.string(), z.unknown())]) }).strict(),
  z.object({ kind: z.literal("agent"), agent: AGENT, field: z.enum(["model", "reasoning_effort", "heartbeat", "max_parallel"]), value: SCALAR }).strict(),
  // A module on or off (instance.yaml modules:; the owner's, Tier 2). On for a module of a configured marketplace installs it.
  z.object({ kind: z.literal("module"), name: NAME, on: z.boolean() }).strict(),
  // A routine's schedules or model (overrides.routines.<key>). Pause and resume are the routine's live controls (fleet.ts).
  z.discriminatedUnion("field", [
    z.object({ kind: z.literal("routine"), routine: NAME, field: z.literal("schedules"), value: z.array(SCHEDULE).max(10) }).strict(),
    z.object({ kind: z.literal("routine"), routine: NAME, field: z.literal("model"), value: MODEL.nullable() }).strict(),
  ]),
  // The owner's rules for an agent: agents/<key>.md (a module agent; empty deletes it), or a local agent's whole handbook.
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
  // A local module shared to a public repo (docs/design/sharing.md): the owner's save of one preview, bound to its digest,
  // source commit, repo, ref and base tip. The kernel exports it again and files it as his own github.publish_module.
  z.object({ kind: z.literal("share"), module: NAME, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), ref: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]{1,200}$/), source: SHA, base: SHA, digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]);
export const ChangesSchema = z.object({ changes: z.array(ChangeSchema).min(1).max(10) }).strict();
/** A share's preview request: which local module, to which repo and branch. */
export const SharePreviewSchema = z.object({ module: NAME, repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), ref: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]{1,200}$/) }).strict();
export type Change = z.infer<typeof ChangeSchema>;

interface Catalog {
  name: string;
  enabled: boolean;
  /** A per-module pin (instance.yaml modules: - { id, sha }). */
  pinned?: string;
  /** Listed in instance.yaml modules: (an enabled module that isn't chosen is on as a dependency). */
  chosen?: boolean;
  settings?: Record<string, { default?: unknown; values?: unknown[]; type?: string; host?: string; pattern?: string; entry?: string }>;
}

export class ChangeRefused extends Error {}

const isPlainMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * Why a structured setting's value is refused (kernel/src/settings-change.ts boundedValue is the gate; this is the owner's
 * feedback): at most 6 levels and 2000 values, keys of letters, digits, _ . - / or *, plain strings of at most 500 characters.
 */
export function boundedProblem(v: unknown): string | undefined {
  let n = 0;
  const walk = (x: unknown, depth: number): string | undefined => {
    if (++n > 2000) return "too many values";
    if (depth > 6) return "nested too deep";
    if (x === null || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) return;
    if (typeof x === "string") return x.length > 500 || !plain(x) ? "plain text of at most 500 characters, no control characters or $" : undefined;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1)).find(Boolean);
    if (isPlainMap(x)) return Object.entries(x).map(([k, y]) => (/^[\w.\/*-]{1,64}$/.test(k) ? walk(y, depth + 1) : `${k.slice(0, 40)} isn't a key`)).find(Boolean);
    return "plain values only";
  };
  return walk(v, 0);
}

/** The setting changes grouped by the module that declares each, as its validate hook is asked (module.yaml `validate:`). */
export function settingsByModule(changes: Change[], catalog: Catalog[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const ch of changes) {
    const m = ch.kind === "setting" ? catalog.find((x) => x.enabled && x.settings?.[ch.key]) : undefined;
    if (ch.kind === "setting" && m) out.set(m.name, { ...out.get(m.name), [ch.key]: ch.value });
  }
  return out;
}

export { SETTINGS_LABEL } from "./board.js";

const kindOf = (v: unknown) => (Array.isArray(v) ? "list" : v === null || v === undefined ? "none" : typeof v);
const plain = (s: string) => !/[\x00-\x1f\x7f$]/.test(s);

/** The change, checked; throws ChangeRefused with a reason the owner can act on. */
export function checkChange(ch: Change, compiled: Compiled | null, catalog: Catalog[]): Change {
  // The kernel checks a share whole (the export again, at the previewed source).
  if (ch.kind === "share") return ch;
  if (!compiled) throw new ChangeRefused("the board can't read the compiled config yet");
  if (ch.kind === "setting") {
    if (/token|secret|password/i.test(ch.key)) throw new ChangeRefused(`${ch.key} is a secret: secrets live in the vault, not in settings`);
    const def = catalog.find((m) => m.enabled && m.settings?.[ch.key])?.settings?.[ch.key];
    const current = compiled.settings?.[ch.key];
    if (!def && !current) throw new ChangeRefused(`there is no setting ${ch.key} on this instance`);
    const was = def?.default ?? current?.value;
    if (def?.type === "object") {
      if (!isPlainMap(ch.value)) throw new ChangeRefused(`${ch.key} is a map of entries`);
      const problem = boundedProblem(ch.value);
      if (problem) throw new ChangeRefused(`${ch.key}: ${problem}`);
      return ch;
    }
    if (isPlainMap(ch.value)) throw new ChangeRefused(`${ch.key} isn't a map`);
    if (def?.entry) {
      // A list of entries (maintainer_repos): each a bare name or a map carrying its `entry` field, which `pattern` shapes.
      if (!Array.isArray(ch.value)) throw new ChangeRefused(`${ch.key} is a list of entries`);
      const problem = boundedProblem(ch.value);
      if (problem) throw new ChangeRefused(`${ch.key}: ${problem}`);
      const shape = def.pattern ? new RegExp(def.pattern) : undefined;
      const name = (v: unknown) => (isPlainMap(v) ? v[def.entry!] : v);
      if (ch.value.some((v) => typeof name(v) !== "string" || (shape && !shape.test(name(v) as string)))) throw new ChangeRefused(`${ch.key}: each entry is a name${def.pattern ? ` matching ${def.pattern}` : ""} or a map with its ${def.entry}`);
      // An entry that is a map in the instance stays one: a bare name over it would drop its fields.
      const kept = [current?.value, was].flat().filter(isPlainMap).map((m) => String(m[def.entry!]).toLowerCase());
      const flattened = ch.value.find((v) => typeof v === "string" && kept.includes(v.toLowerCase()));
      if (flattened) throw new ChangeRefused(`${ch.key}: ${String(flattened)} has settings of its own, keep them (send its map)`);
      return ch;
    }
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
    // `pattern` (anchored, module.yaml): the shape of a text value; empty clears a single value, and `[]` empties a list. A list's
    // entries are each checked, an empty one included (compile refuses it, so it could never be saved).
    const shape = def?.pattern ? new RegExp(def.pattern) : undefined;
    const list = Array.isArray(ch.value);
    if (shape && each.some((v) => !(v === "" && !list) && !shape.test(String(v)))) throw new ChangeRefused(`${ch.key} must match ${def!.pattern}`);
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
  const own = a.tier === "local";
  if (ch.kind === "rules") {
    if (own && !ch.text.trim()) throw new ChangeRefused("a local agent's handbook can't be empty");
    if (!own && ch.text.length > 20_000) throw new ChangeRefused("your rules are at most 20,000 characters: a longer change belongs in the main handbook");
    return ch;
  }
  if (ch.kind === "handbook" || ch.kind === "unfork") {
    if (own) throw new ChangeRefused(`${a.name ?? ch.agent} is a local agent: its whole handbook is its rules`);
    if (ch.kind === "unfork" && !a.handbook_fork) throw new ChangeRefused(`${a.name ?? ch.agent}'s handbook isn't forked`);
    return ch;
  }
  if (ch.kind === "grants") {
    if (own) throw new ChangeRefused(`${a.name ?? ch.agent} is a local agent: its grants are in its module.yaml`);
    const c = compiled.mcp_servers?.[ch.connection];
    if (!c) throw new ChangeRefused(`there is no connection ${ch.connection}`);
    const all = [...(c.tools?.read ?? []), ...(c.tools?.write ?? []), ...(c.tools?.destructive ?? [])];
    const bad = (ch.tools ?? []).filter((t) => !all.includes(t));
    if (bad.length) throw new ChangeRefused(`${ch.connection} has no tool ${bad.join(", ")}`);
    if (ch.tools && new Set(ch.tools).size !== ch.tools.length) throw new ChangeRefused("each tool once");
    return ch;
  }
  if (ch.field === "model") {
    if (typeof ch.value !== "string" || !/^[A-Za-z0-9~][\w.\/~:@-]{0,119}$/.test(ch.value)) throw new ChangeRefused("a model is its id, like openrouter/~deepseek/deepseek-flash-latest");
  } else if (ch.field === "reasoning_effort") {
    const efforts = EFFORTS[compiledEngine(a) ?? "codex"] ?? [];
    if (!efforts.includes(String(ch.value))) throw new ChangeRefused(efforts.length ? `effort is one of ${efforts.join(", ")}` : `${a.name ?? ch.agent} has no effort setting`);
  } else if (ch.field === "max_parallel") {
    if (!Number.isInteger(ch.value) || (ch.value as number) < 1 || (ch.value as number) > 10) throw new ChangeRefused("parallel jobs are 1 to 10");
  } else {
    if (a.team || a.member_of) throw new ChangeRefused(`${a.name ?? ch.agent} is on a team: a team's agents have no heartbeat of their own`);
    if (ch.value !== false && !HEARTBEAT_HOURS.includes(Number(ch.value))) throw new ChangeRefused(`a heartbeat is off or every ${HEARTBEAT_HOURS.join(", ")} hours`);
    if (ch.value !== false && (a.profile === "engineer" || a.profile === "session")) throw new ChangeRefused("an Engineer or a session has no heartbeat (it works on the tasks it is given)");
    if (ch.value !== false && !HEARTBEAT_TOOLS.every((t) => a.enabled_tools?.paperclip_tasks?.includes(t))) throw new ChangeRefused(`${a.name ?? ch.agent} lacks the task tools a heartbeat needs (${HEARTBEAT_TOOLS.join(", ")})`);
  }
  return ch;
}

/** One sentence per change, for the task title and the page. */
export function describe(ch: Change, compiled: Compiled | null): string {
  if (ch.kind === "setting" && isPlainMap(ch.value)) return `${ch.key} updated`;
  if (ch.kind === "setting") return `${ch.key} → ${Array.isArray(ch.value) ? ch.value.map((v) => (isPlainMap(v) ? String(v.repo ?? Object.values(v)[0]) : v)).join(", ") || "none" : ch.value === "" ? "not set" : String(ch.value)}`;
  if (ch.kind === "module") return `${ch.on ? "turn on" : "turn off"} the ${ch.name} module`;
  if (ch.kind === "pin") return ch.sha ? `pin the ${ch.name} module at ${ch.sha.slice(0, 12)}` : `the ${ch.name} module follows its marketplace`;
  if (ch.kind === "marketplace") return `${ch.op} the ${ch.name} marketplace${ch.source ? ` (${ch.source.repo})` : ""}${ch.sha ? ` at ${ch.sha.slice(0, 12)}` : ""}`;
  if (ch.kind === "share") return `share the ${ch.module} module to ${ch.repo} (${ch.ref})`;
  if (ch.kind === "routine") return `routine ${compiled?.routines?.[ch.routine]?.title ?? ch.routine}: ${ch.field} → ${ch.field === "schedules" ? ch.value.map((x) => x.label ?? x.cron).join(", ") || "none" : ch.value ?? "the agent's model"}`;
  const name = compiled?.agents?.[ch.agent]?.name ?? ch.agent;
  if (ch.kind === "rules") return `${name}'s rules${ch.text.trim() ? "" : " cleared"}`;
  if (ch.kind === "handbook") return `${name}'s own handbook`;
  if (ch.kind === "unfork") return `${name} back on its module's handbook`;
  if (ch.kind === "grants") return `${name}'s ${ch.connection} tools → ${ch.tools === null ? "the module's" : ch.tools.join(", ") || "none"}`;
  const field = { model: "model", reasoning_effort: "effort", heartbeat: "heartbeat", max_parallel: "parallel jobs" }[ch.field];
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
    "Changed from the board. The kernel writes exactly this change to the instance repo and files the apply here, approved by your save; no agent works on this task, and it closes once the apply ends.",
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

/** A task the kernel filed no apply card on within this long never will: its outcome stays unknown. */
const UNFILED_MS = 10 * 60_000;

/** Where a settings task stands, from its task status and its newest apply card. */
export function stageOf(status: string, cards: Pick<Approval, "action" | "state" | "outcome" | "tier" | "outcomeText" | "id">[] | undefined, createdAt: string): { stage: Stage; tier?: number; approval?: string; detail?: string } {
  // A settings change's apply, or a share's publish.
  const a = cards?.find((c) => c.action === "apply" || c.action === "github.publish_module");
  if (a) {
    if (a.outcome === "applied") return { stage: "applied", approval: a.id };
    if (a.outcome === "failed") return { stage: "failed", approval: a.id, ...(a.outcomeText ? { detail: a.outcomeText.slice(-300) } : {}) };
    if (a.state === "pending") return { stage: "waiting", tier: a.tier, approval: a.id };
    if (a.state === "approved" || a.state === "running") return { stage: "applying", approval: a.id };
    if (a.state === "rejected" || a.state === "stale" || a.state === "expired") return { stage: "rejected", approval: a.id };
  }
  if (status === "done" || status === "cancelled") return { stage: "closed" };
  // No card yet: the kernel is still writing the change, until it plainly never filed one (a lost response); then the owner can save again.
  // Records that couldn't be read (`undefined`) prove nothing, so the change stays working.
  if (!cards) return { stage: "working" };
  return Date.now() - Date.parse(createdAt) > UNFILED_MS ? { stage: "failed", detail: "No apply record was found for this change after 10 minutes. Saving again files a new one." } : { stage: "working" };
}
