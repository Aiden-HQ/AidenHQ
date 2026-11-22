// The owner's typed settings changes (docs/design/settings-changes.md). The owner files one from a board page: the board
// checks it, files it as the owner's own task (label settings-change, held by the owner) and hands the typed change to the kernel
// (POST /v1/settings/change, the board's key). Here it is checked again (the gate: known kinds, schema-checked values, what
// it names exists, no free-form YAML), written as exactly the files its kind allows (instance.yaml through the yaml Document
// API, so comments stay; handbook texts verbatim) by the instance repo's code host (apply.ts hostApply: codehost-local for a
// `local/…` instance, codehost-github otherwise), and filed as a kernel.apply on the task. A change saved in the owner's
// signed-in board session, or through his MCP client's own sign-in (the board forwards the credential; the kernel checks it
// here), is his own approval: the record is decided as his account at filing (via "save") and its outcome notice closes the
// task (writes.ts outcomeOf). Any other filing (an agent's asAgent) is tiered on its merits by the kernel's planner like any
// instance change. No model writes the commit.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { urlSettingProblem } from "../../services/shared/url-setting.ts";
import type { Write } from "./apply.ts";
import type { Requester } from "./records.ts";

/** What the board forwards of the owner's sign-in: his board session token, or his MCP client's bearer and the resource it was minted for. */
export type Credential = { board: string } | { mcp: { token: string; resource: string } };
const isCredential = (c: unknown): c is Credential => {
  const v = c as { board?: unknown; mcp?: { token?: unknown; resource?: unknown } } | null;
  if (!v || typeof v !== "object") return false;
  if (typeof v.board === "string") return v.board.length <= 200;
  return typeof v.mcp?.token === "string" && v.mcp.token.length <= 200 && typeof v.mcp.resource === "string" && v.mcp.resource.length <= 300;
};

export class Refused extends Error { status = 422; }
/** The label the board files a settings task with (services/board/src/board.ts SETTINGS_LABEL). */
const SETTINGS_LABEL = "settings-change";
const refuse = (msg: string): never => {
  throw new Refused(msg);
};

type Dict = Record<string, any>;
export type Change = Dict & { kind: string };
type Sources = { compiled: Dict; catalog: Dict[] };

const KEY = /^[a-z][a-z0-9_]{0,60}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,60}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SHA = /^[0-9a-f]{40}$/;
const MODEL = /^[A-Za-z0-9~][\w./~:@-]{0,119}$/;
const plain = (s: unknown) => typeof s === "string" && !/[\x00-\x1f\x7f$]/.test(s);
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
/** An own key of a map (never `constructor` or another prototype key). */
const has = (o: unknown, k: string) => isMap(o) && Object.hasOwn(o, k);
const only = (ch: Dict, keys: string[]) => Object.keys(ch).every((k) => keys.includes(k)) || refuse(`${ch.kind}: unknown fields (${Object.keys(ch).filter((k) => !keys.includes(k)).join(", ")})`);
/** Handbook texts: Markdown, no NUL or other control characters but tab and newlines. */
const text = (t: unknown, max: number) => (typeof t === "string" && t.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(t)) || refuse(`text must be at most ${max} characters, without control characters`);
const HANDBOOK_MAX = 120_000;
/** A structured setting's value: at most 6 levels and 2000 values, keys of letters, digits, _ . - / or *, plain strings (no $). */
function boundedValue(key: string, v: unknown): void {
  let n = 0;
  const walk = (x: unknown, depth: number): void => {
    if (++n > 2000 || depth > 6) refuse(`${key}: at most 6 levels and 2000 values`);
    if (x === null || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) return;
    if (typeof x === "string") return void ((x.length <= 500 && plain(x)) || refuse(`${key}: plain text of at most 500 characters, no control characters or $`));
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    if (!isMap(x)) refuse(`${key}: plain values only`);
    for (const [k, y] of Object.entries(x as Dict)) (/^[\w.\/*-]{1,64}$/.test(k) || refuse(`${key}: ${k.slice(0, 40)} isn't a key`), walk(y, depth + 1));
  };
  walk(v, 0);
}
const RULES_MAX = 20_000;

/**
 * One typed change, checked against the compiled config (config/paperclip.yaml: agents, routines, mcp_servers, settings) and
 * the module catalog (config/modules.json): the shape, the values, and that what it names exists. Throws Refused.
 */
export function checkTyped(ch: unknown, { compiled, catalog }: Sources): void {
  if (!isMap(ch) || typeof ch.kind !== "string") refuse("a change is { kind, ... }");
  const c = ch as Change;
  const agentOf = (key: unknown, { module = false } = {}) => {
    if (!AGENT.test(String(key))) refuse(`${key} isn't an agent key`);
    const a = (has(compiled?.agents, String(key)) && compiled.agents[String(key)]) || refuse(`there is no agent ${key}`);
    if (module && a.tier === "local") refuse(`${key} is a local agent: its handbook and grants are its modules/${a.module}/ files`);
    return a;
  };
  const moduleOf = (name: unknown) => (NAME.test(String(name)) && catalog.find((m) => m.name === name)) || refuse(`there is no module ${name}`);
  switch (c.kind) {
    case "setting": {
      only(c, ["kind", "key", "value"]);
      if (!KEY.test(String(c.key)) || /token|secret|password/i.test(c.key)) refuse(`${c.key} isn't a setting the board may change`);
      const def = catalog.find((m) => m.enabled && has(m.settings, c.key))?.settings?.[c.key];
      if (!def && !has(compiled?.settings, c.key)) refuse(`there is no setting ${c.key}`);
      // A setting its module declares `type: object` (settings.code_review) takes a whole map, bounded here; its module checks the shape.
      if (def?.type === "object") return void (isMap(c.value) || refuse(`${c.key} is a map`), boundedValue(c.key, c.value));
      const each = [c.value].flat();
      if ((Array.isArray(c.value) && c.value.length > 50) || each.some((v) => !["string", "number", "boolean"].includes(typeof v) || (typeof v === "string" && (v.length > 500 || !plain(v))))) refuse(`${c.key}: plain values only`);
      if (def?.values && each.some((v) => !def.values.includes(v))) refuse(`${c.key}: one of ${def.values.join(", ")}`);
      if (def?.type === "url" && urlSettingProblem(c.value, def.host)) refuse(`${c.key}: ${urlSettingProblem(c.value, def.host)}`);
      return;
    }
    case "agent": {
      only(c, ["kind", "agent", "field", "value"]);
      const a = agentOf(c.agent);
      const okFor = ({ model: (v: unknown) => typeof v === "string" && MODEL.test(v), reasoning_effort: (v: unknown) => typeof v === "string" && /^[a-z]{1,20}$/.test(v), heartbeat: (v: unknown) => v === false || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 24), max_parallel: (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10 } as Record<string, (v: unknown) => boolean>);
      const ok = Object.hasOwn(okFor, c.field) ? okFor[c.field] : undefined;
      if (!ok) refuse(`${c.field} isn't an agent field the board may change`);
      if (c.field === "heartbeat" && (a.team || a.member_of)) refuse(`${c.agent} is on a team: a team's agents have no heartbeat of their own`);
      if (!ok!(c.value)) refuse(`${c.agent}.${c.field} can't be ${JSON.stringify(c.value)}`);
      return;
    }
    case "module": {
      only(c, ["kind", "name", "on"]);
      const m = moduleOf(c.name);
      if (c.name === "kernel" || typeof c.on !== "boolean") refuse("a module is turned on or off");
      if (Boolean(m.chosen) === c.on) refuse(`${c.name} is already ${c.on ? "on" : "off"}`);
      return;
    }
    case "routine": {
      only(c, ["kind", "routine", "field", "value"]);
      if (!KEY.test(String(c.routine).replace(/-/g, "_")) || !has(compiled?.routines, c.routine)) refuse(`there is no routine ${c.routine}`);
      const v = c.value;
      const schedule = (s: unknown) => isMap(s) && Object.keys(s).every((k) => ["cron", "timezone", "label"].includes(k)) && typeof s.cron === "string" && /^[0-9*/,\- ]{9,100}$/.test(s.cron) && (s.timezone == null || (typeof s.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$|^UTC$/.test(s.timezone))) && (s.label == null || (plain(s.label) && s.label.length <= 60));
      const okFor = ({ schedules: () => Array.isArray(v) && v.length <= 10 && v.every(schedule), model: () => typeof v === "string" && MODEL.test(v) } as Record<string, () => boolean>);
      const ok = Object.hasOwn(okFor, c.field) ? okFor[c.field] : undefined;
      if (!ok) refuse(`${c.field} isn't a routine field the board may change`);
      if (!ok!()) refuse(`${c.routine}.${c.field} can't be ${JSON.stringify(v).slice(0, 200)}`);
      return;
    }
    case "rules": {
      only(c, ["kind", "agent", "text"]);
      const a = agentOf(c.agent);
      text(c.text, a.tier === "local" ? HANDBOOK_MAX : RULES_MAX);
      if (a.tier === "local" && !c.text.trim()) refuse("a local agent's handbook can't be empty");
      return;
    }
    case "handbook": {
      only(c, ["kind", "agent", "text"]);
      agentOf(c.agent, { module: true });
      text(c.text, HANDBOOK_MAX);
      if (!c.text.trim()) refuse("a handbook can't be empty");
      return;
    }
    case "unfork": {
      only(c, ["kind", "agent"]);
      agentOf(c.agent, { module: true });
      return;
    }
    case "pin": {
      only(c, ["kind", "name", "sha"]);
      moduleOf(c.name);
      if (c.sha !== null && !SHA.test(String(c.sha))) refuse("a pin is a 40-character commit, or null to follow the marketplace");
      return;
    }
    case "marketplace": {
      only(c, ["kind", "op", "name", "source", "sha"]);
      if (!NAME.test(String(c.name))) refuse(`${c.name} isn't a marketplace name`);
      if (!["add", "update", "remove"].includes(c.op)) refuse("a marketplace is added, updated or removed");
      if (c.op === "add" && !(isMap(c.source) && Object.keys(c.source).length === 2 && c.source.source === "github" && /^[\w.-]+\/[\w.-]+$/.test(String(c.source.repo)))) refuse("a marketplace comes from a GitHub owner/repo");
      if (c.op !== "remove" && !SHA.test(String(c.sha))) refuse("a marketplace is pinned at a 40-character commit");
      if (c.op !== "add" && c.source != null) refuse("only adding names the source");
      if (c.op === "remove" && c.sha != null) refuse("removing takes no sha");
      return;
    }
    case "grants": {
      only(c, ["kind", "agent", "connection", "tools"]);
      agentOf(c.agent, { module: true });
      const conn = (KEY.test(String(c.connection)) && has(compiled?.mcp_servers, c.connection) && compiled.mcp_servers[c.connection]) || refuse(`there is no connection ${c.connection}`);
      const all = [...(conn.tools?.read ?? []), ...(conn.tools?.write ?? []), ...(conn.tools?.destructive ?? [])];
      if (c.tools !== null && (!Array.isArray(c.tools) || c.tools.length > 200 || c.tools.some((t: unknown) => !all.includes(t)) || new Set(c.tools).size !== c.tools.length)) refuse(`${c.connection}: tools it declares, each once`);
      return;
    }
    default:
      refuse(`${c.kind} isn't a change the board may make`);
  }
}

/** A git blob id of a text (what `git hash-object` gives): the module handbook a fork was copied from. */
export const blobSha = (t: string) => createHash("sha1").update(`blob ${Buffer.byteLength(t)}\0`).update(t).digest("hex");

/**
 * An edited instance.yaml as text: no re-folding of long lines, and a line that differs from one in the file only by its flow
 * spacing ({ a } or {a}) is written as the file had it, so the diff is only the lines the change makes.
 */
export function yamlText(doc: YAML.Document, docText: string): string {
  const flat = (l: string) => l.replace(/([[{]) +/g, "$1").replace(/ +([\]}])/g, "$1");
  const had = new Map(docText.split("\n").map((l) => [flat(l), l]));
  return doc.toString({ lineWidth: 0 }).split("\n").map((l) => had.get(flat(l)) ?? l).join("\n");
}

/** A local agent's module (its handbook is modules/<module>/agents/<key>/AGENTS.md), or undefined for a module agent. */
type LocalOf = (key: string) => string | undefined;
/** An agent on a team: the team's name and whether it is the record (else a member). */
type TeamOf = (key: string) => { team: string; record: boolean } | undefined;
/** Kind → the instance repo files it may write (and nothing else). */
const PATHS: Record<string, (ch: Change, localOf: LocalOf) => string[]> = {
  setting: () => ["instance.yaml"],
  agent: () => ["instance.yaml"],
  module: () => ["instance.yaml"],
  routine: () => ["instance.yaml"],
  pin: () => ["instance.yaml"],
  marketplace: () => ["instance.yaml"],
  grants: () => ["instance.yaml"],
  rules: (ch, localOf) => [localOf(ch.agent) ? `modules/${localOf(ch.agent)}/agents/${ch.agent}/AGENTS.md` : `agents/${ch.agent}.md`],
  handbook: (ch) => [`agents/${ch.agent}/AGENTS.md`, "instance.yaml"],
  unfork: (ch) => [`agents/${ch.agent}/AGENTS.md`, "instance.yaml"],
};
export const allowedPaths = (changes: Change[], localOf: LocalOf) => [...new Set(changes.flatMap((ch) => ((Object.hasOwn(PATHS, ch.kind) && PATHS[ch.kind]) || refuse(`${ch.kind} writes nothing`))(ch, localOf)))].sort();

const entryId = (item: unknown) => String(YAML.isMap(item) ? item.get("id") : YAML.isScalar(item) ? item.value : item);
const entryName = (item: unknown) => entryId(item).split("@")[0];

/**
 * The files these changes write, from the files as they are (`read(path)`: text, or undefined when absent): path → new text,
 * or null to delete. instance.yaml is edited through the yaml Document API, so its comments and layout stay; emptied maps
 * and lists are dropped, so a change and its undo leave it as it was. `localOf(key)`: a local agent's module;
 * `moduleHandbook(key)`: the module's handbook text the host runs (a new fork records its blob); `bundle`: the default
 * module set (modules/marketplace.json), whose members a turn-off also lists in `modules_removed` so an upgrade never
 * adds them back.
 */
export function planFiles(changes: Change[], { read, localOf, teamOf, moduleHandbook, bundle }: { read: (p: string) => string | undefined; localOf: LocalOf; teamOf: TeamOf; moduleHandbook: (key: string) => string | undefined; bundle: string[] }): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const current = (p: string) => (out.has(p) ? (out.get(p) ?? undefined) : read(p));
  const docText = current("instance.yaml") ?? refuse("the instance repo has no instance.yaml");
  const doc = YAML.parseDocument(docText);
  if (doc.errors.length) refuse(`instance.yaml doesn't parse (${doc.errors[0]!.message.split("\n")[0]})`);
  let yamlTouched = false;
  const set = (path: string[], v: unknown) => ((yamlTouched = true), doc.setIn(path, doc.createNode(v)));
  const drop = (path: string[]) => {
    yamlTouched = true;
    doc.deleteIn(path);
    for (let p = path.slice(0, -1); p.length; p = p.slice(0, -1)) {
      const n = doc.getIn(p, true);
      if (YAML.isMap(n) && !n.items.length) doc.deleteIn(p);
      else break;
    }
  };
  const seq = (key: string): YAML.YAMLSeq => {
    const n = doc.get(key, true);
    if (n == null) return (set([key], []), doc.get(key, true) as YAML.YAMLSeq);
    return YAML.isSeq(n) ? n : refuse(`instance.yaml ${key}: must be a list`);
  };
  const dropEmpty = (key: string) => { const n = doc.get(key, true); if (YAML.isSeq(n) && !n.items.length) doc.delete(key); };
  // Where an agent's own fields live: a team record's agent-level settings are its team's `defaults` (every member takes
  // them), a member's are its entry under the team, and any other agent's are its override (compile refuses overrides
  // on a team record).
  const fieldsOf = (key: string) => {
    const t = teamOf(key);
    return t ? (t.record ? ["teams", t.team, "defaults"] : ["teams", t.team, "members", key]) : ["overrides", "agents", key];
  };
  const forkOf = (key: string) => doc.getIn(["overrides", "agents", key, "handbook_fork"]);
  for (const ch of changes) {
    switch (ch.kind) {
      case "setting":
        set(["settings", ch.key], ch.value);
        break;
      case "agent":
        set([...fieldsOf(ch.agent), ch.field], ch.value);
        break;
      case "routine":
        set(["overrides", "routines", ch.routine, ch.field], ch.value);
        break;
      case "grants":
        if (ch.tools === null) drop(["overrides", "agents", ch.agent, "connections", ch.connection]);
        else set(["overrides", "agents", ch.agent, "connections", ch.connection], ch.tools);
        break;
      case "module": {
        const s = seq("modules");
        const i = s.items.findIndex((x) => entryName(x) === ch.name);
        if (ch.on && i < 0) s.items.push(doc.createNode(ch.name));
        if (!ch.on && i >= 0) s.items.splice(i, 1);
        // modules_removed: a default module the owner turned off stays off across upgrades; turning it on takes it off the list.
        const removed = seq("modules_removed");
        const j = removed.items.findIndex((x) => entryId(x) === ch.name);
        if (ch.on && j >= 0) removed.items.splice(j, 1);
        if (!ch.on && j < 0 && bundle.includes(ch.name)) removed.items.push(doc.createNode(ch.name));
        dropEmpty("modules_removed");
        yamlTouched = true;
        break;
      }
      case "pin": {
        const s = seq("modules");
        const i = s.items.findIndex((x) => entryName(x) === ch.name);
        if (i < 0) refuse(`${ch.name} isn't listed in instance.yaml modules: (turn it on first)`);
        if (YAML.isMap(s.items[i]) && (s.items[i] as YAML.YAMLMap).get("fork") != null) refuse(`${ch.name} runs a fork: drop the fork before pinning it`);
        const id = entryId(s.items[i]);
        s.items[i] = doc.createNode(ch.sha ? { id, sha: ch.sha } : id);
        yamlTouched = true;
        break;
      }
      case "marketplace": {
        const s = seq("marketplaces");
        const i = s.items.findIndex((x) => YAML.isMap(x) && x.get("name") === ch.name);
        if (ch.op === "add") {
          if (i >= 0) refuse(`marketplace ${ch.name} is already configured`);
          s.items.push(doc.createNode({ name: ch.name, source: ch.source, sha: ch.sha }));
        } else if (i < 0) refuse(`there is no marketplace ${ch.name}`);
        else if (ch.op === "update") (s.items[i] as YAML.YAMLMap).set("sha", ch.sha);
        else s.items.splice(i, 1);
        dropEmpty("marketplaces");
        yamlTouched = true;
        break;
      }
      case "rules": {
        const [p] = PATHS.rules!(ch, localOf);
        out.set(p!, !localOf(ch.agent) && !ch.text.trim() ? null : ch.text.endsWith("\n") ? ch.text : `${ch.text}\n`);
        break;
      }
      case "handbook": {
        // A fork keeps the blob it was first copied from; a new one records the module's handbook as the host runs it.
        if (forkOf(ch.agent) == null) {
          const t = moduleHandbook(ch.agent) ?? refuse(`can't read ${ch.agent}'s module handbook to fork it`);
          set(["overrides", "agents", ch.agent, "handbook_fork"], blobSha(t));
        }
        out.set(`agents/${ch.agent}/AGENTS.md`, ch.text.endsWith("\n") ? ch.text : `${ch.text}\n`);
        break;
      }
      case "unfork":
        if (forkOf(ch.agent) == null && current(`agents/${ch.agent}/AGENTS.md`) === undefined) refuse(`${ch.agent}'s handbook isn't forked`);
        drop(["overrides", "agents", ch.agent, "handbook_fork"]);
        out.set(`agents/${ch.agent}/AGENTS.md`, null);
        break;
      default:
        refuse(`${ch.kind} isn't a change the board may make`);
    }
  }
  if (yamlTouched) {
    const o = doc.get("overrides", true);
    if (YAML.isMap(o) && !o.items.length) doc.delete("overrides");
    out.set("instance.yaml", yamlText(doc, docText));
  }
  // Only real changes: a file written as it already is, or deleted when absent, is no change.
  for (const [p, t] of out) if (t === (read(p) ?? null)) out.delete(p);
  return out;
}

export type SettingsDeps = {
  /** The product checkout (module handbooks, the default bundle) and the compiled config dir (paperclip.yaml, modules.json). */
  product: string; configDir: string;
  /** The instance repo (owner/name or local/name) and its files on main: { base: main's commit, read(path) }. */
  instanceRepo: () => string | undefined;
  main: (paths: string[]) => Promise<{ base: string; texts: Map<string, string> }>;
  /** The control plane's task, as the owner reads it, and the owner's Paperclip user (the board's key, which files the task). */
  task: (id: string) => Promise<Dict | undefined>;
  owner: () => Promise<string>;
  /** Whether a settings change was already filed on this task (a kernel.apply with requester SETTINGS). */
  filed: (task: string) => boolean;
  /** The code host's write (apply.ts hostApply): the commit, on `branch`. */
  write: (w: Write) => Promise<{ sha: string }>;
  /** Files the kernel.apply on the task (writes.fileKernel with SETTINGS, or the agent that asked); `owner`: decided as that account at filing. */
  file: (args: { repo: string; branch: string; sha: string }, task: string, requester?: Requester, owner?: { account: string; via: string }) => Promise<{ id: string; tier: number; state: string }>;
  /** The ready admin account (every admin is an owner) behind a credential, or undefined: an ended, revoked, unknown or non-admin one. */
  credentialAccount: (c: Credential) => Promise<string | undefined>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
};

/**
 * POST /v1/settings/change: the owner's typed change on their settings task, written and filed as one kernel.apply. `asAgent`
 * (POST /v1/settings/agent): an agent's typed `setting` change on its own task, for a setting whose module lets one of the
 * agent's roles write it (module.yaml settings.<key>.writers), filed with the agent as requester and tiered on its merits.
 */
export function createSettingsChanges(d: SettingsDeps) {
  const sources = (): Sources => ({ compiled: YAML.parse(readFileSync(join(d.configDir, "paperclip.yaml"), "utf8")) ?? {}, catalog: JSON.parse(readFileSync(join(d.configDir, "modules.json"), "utf8")) });
  const count = (changes: unknown) => ((Array.isArray(changes) && changes.length && changes.length <= 10) || refuse("changes: one to ten typed changes"));
  async function apply(taskId: unknown, changes: unknown, credential?: unknown): Promise<{ record: string; tier: number; state: string; sha: string }> {
    if (typeof taskId !== "string" || !/^[0-9a-f-]{36}$/.test(taskId)) refuse("task is the settings task's id");
    count(changes);
    // The owner's sign-in (board session or MCP client), checked here: its account decides the record. A credential that doesn't check out is
    // refused, never quietly put to the reviewer instead.
    const account = credential === undefined ? undefined : (isCredential(credential) && (await d.credentialAccount(credential))) || refuse("that sign-in has ended: sign in again");
    // The owner's own task, held by no agent: the board filed it a moment ago with the owner's key.
    const issue = (await d.task(taskId as string)) ?? refuse("no such task");
    const owner = await d.owner();
    if (!owner || issue.createdByUserId !== owner || issue.createdByAgentId || issue.assigneeAgentId) refuse("a settings change is the owner's own task, made by the board and held by no agent");
    if (!(issue.labels ?? []).some((l: Dict) => l?.name === SETTINGS_LABEL)) refuse(`that task isn't a settings change (no ${SETTINGS_LABEL} label)`);
    if (["done", "cancelled"].includes(String(issue.status))) refuse("that task is closed");
    if (d.filed(taskId as string)) refuse("a settings change was already written on that task: file a new one");
    return write(taskId as string, issue, changes as unknown[], sources(), undefined, account ? { account, via: "save" } : undefined);
  }
  async function asAgent(requester: Requester, taskId: string, changes: unknown, module: string): Promise<{ record: string; tier: number; state: string; sha: string }> {
    count(changes);
    const src = sources();
    // The filing module speaks only for its own agents, and only of its own settings.
    const agent = has(src.compiled.agents, requester.key) ? src.compiled.agents[requester.key] : undefined;
    if (!module || agent?.module !== module) refuse(`${module} files settings changes only for its own agents, and ${requester.key || requester.name} isn't one`);
    for (const ch of changes as Dict[]) {
      if (!isMap(ch) || ch.kind !== "setting") refuse("an agent changes settings only: { kind: setting, key, value }");
      const writers: unknown = src.catalog.find((m) => m.enabled && m.name === module && has(m.settings, ch.key))?.settings?.[ch.key]?.writers;
      if (!Array.isArray(writers) || !writers.some((r) => requester.roles.includes(r))) refuse(`${requester.key || requester.name} may not change ${ch.key} (only a setting ${module} declares, whose settings.${ch.key}.writers names one of the agent's roles)`);
    }
    const issue = (await d.task(taskId)) ?? refuse("no such task");
    return write(taskId, issue, changes as unknown[], src, requester);
  }
  async function write(taskId: string, issue: Dict, changes: unknown[], src: Sources, requester?: Requester, owner?: { account: string; via: string }) {
    const repo = d.instanceRepo() ?? refuse("this kernel has no instance repo (AIDENHQ_INSTANCE_REPO)");
    for (const ch of changes) checkTyped(ch, src);
    const typed = changes as Change[];
    const localOf = (key: string) => (has(src.compiled.agents, key) && src.compiled.agents[key].tier === "local" ? String(src.compiled.agents[key].module) : undefined);
    const allowed = allowedPaths(typed, localOf);
    const { base, texts } = await d.main(allowed);
    const moduleHandbook = (key: string) => {
      const a = has(src.compiled.agents, key) ? src.compiled.agents[key] : undefined;
      try { return readFileSync(a?.handbook_fork ? join(d.product, "modules", a.module, "agents", key, "AGENTS.md") : String(a?.instructions), "utf8"); } catch { return undefined; }
    };
    const bundle: string[] = JSON.parse(readFileSync(join(d.product, "modules", "marketplace.json"), "utf8")).bundle ?? [];
    const teamOf: TeamOf = (key) => {
      const a = has(src.compiled.agents, key) ? src.compiled.agents[key] : undefined;
      return a?.team ? { team: a.team.name, record: true } : a?.member_of ? { team: src.compiled.agents[a.member_of]?.team?.name, record: false } : undefined;
    };
    const files = planFiles(typed, { read: (p) => texts.get(p), localOf, teamOf, moduleHandbook, bundle });
    const stray = [...files.keys()].filter((f) => !allowed.includes(f));
    if (stray.length) refuse(`it would change ${stray.join(", ")}, which these changes may not touch`);
    if (!files.size) refuse("it changes nothing: the instance is already like this");
    const ident = String(issue.identifier ?? taskId).toLowerCase();
    // An agent may change settings more than once on its task: each change its own branch.
    const branch = requester ? `settings/${ident}-${Date.now().toString(36)}` : `settings/${ident}`;
    const by = requester ? `${requester.key || requester.name}'s` : "the owner's";
    const { sha } = await d.write({ repo, base, branch, files: Object.fromEntries(files), message: `settings: ${typed.map((c) => c.kind).join(", ")} (${issue.identifier ?? taskId})\n\nWritten by the kernel from ${by} typed change on ${issue.identifier ?? taskId}; no agent wrote it.` });
    const r = await d.file({ repo, branch, sha }, taskId, requester, owner);
    d.log?.("settings change filed", { task: issue.identifier, kinds: typed.map((c) => c.kind), record: r.id, tier: r.tier, ...(requester ? { agent: requester.key } : {}) });
    return { record: r.id, tier: r.tier, state: r.state, sha };
  }
  return Object.assign(apply, { asAgent });
}

/** The instance repo's main, read from the kernel's instance checkout (fetched first): its commit and the regular files asked for. */
export function checkoutMain(dir: string) {
  const git = (args: string[]) => new Promise<string>((ok, no) => execFile("git", ["-C", dir, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? no(e) : ok(String(out)))));
  return async (paths: string[]) => {
    await git(["fetch", "-q", "origin", "main"]);
    const base = (await git(["rev-parse", "--verify", "origin/main^{commit}"])).trim();
    const texts = new Map<string, string>();
    for (const p of paths) {
      const entry = (await git(["ls-tree", base, "--", p])).trim();
      if (!entry) continue;
      if (!entry.startsWith("100644 blob ")) refuse(`${p} in the instance repo isn't a plain file`);
      texts.set(p, await git(["cat-file", "blob", `${base}:${p}`]));
    }
    return { base, texts };
  };
}
