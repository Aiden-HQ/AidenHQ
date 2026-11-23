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
// An agent's change to itself (self_change: its handbook, a library skill, its skill list, its library routines, the owner's
// profile for fleet-admin) takes the same path: checked against the instance tree at the main it fetched, compiled there before
// and after (a compile error is the refusal), written on that base and filed as the one kernel.apply with the agent as requester.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { urlSettingProblem } from "../../services/shared/url-setting.ts";
import { compile } from "../../scripts/modules.ts";
import { loadInputs } from "../../scripts/compiler/inputs.ts";
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
/** `self`: the agent filing a change to itself (self_change): its key and live roles. Only it may file the self kinds. */
type Sources = { compiled: Dict; catalog: Dict[]; self?: { key: string; roles: string[] } };
/** The kinds an agent files about itself (self_change). */
export const SELF_KINDS = ["rules", "skill", "skills", "routine_def", "profile"];
/** The agents' own local module: their skills and routines. */
const LIBRARY = "modules/library/module.yaml";
const LIBRARY_TEXT = "name: library\ndescription: The agents' own skills and routines.\n";
const PROFILE_MAX = 20_000;
const SKILL_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

const KEY = /^[a-z][a-z0-9_]{0,60}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,60}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SHA = /^[0-9a-f]{40}$/;
const MODEL = /^[A-Za-z0-9~][\w./~:@-]{0,119}$/;
const plain = (s: unknown) => typeof s === "string" && !/[\x00-\x1f\x7f$]/.test(s);
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
/** An own key of a map (never `constructor` or another prototype key). */
const has = (o: unknown, k: string) => isMap(o) && Object.hasOwn(o, k);
/**
 * The profile with one standing decision under its "Owner decisions" heading (made when missing): `replaces` names the line
 * it supersedes, replaced in place (with or without its "- "), else the decision is added at the end of that section.
 */
export function withDecision(profile: string, decision: string, replaces?: string): string {
  const lines = profile.replace(/\n+$/, "").split("\n");
  const entry = `- ${decision.trim().replace(/^-\s+/, "")}`;
  if (replaces !== undefined) {
    const old = replaces.trim().replace(/^-\s+/, "");
    const at = lines.findIndex((l) => l.trim().replace(/^-\s+/, "") === old);
    if (at < 0) refuse("profile: the decision `replaces` names isn't in the profile now: read it again");
    lines[at] = entry;
    return `${lines.join("\n")}\n`;
  }
  let head = lines.findIndex((l) => /^#{1,6}\s+Owner decisions\s*$/i.test(l));
  if (head < 0) { if (lines.length && lines.at(-1)!.trim()) lines.push(""); lines.push("## Owner decisions"); head = lines.length - 1; }
  let end = lines.findIndex((l, i) => i > head && /^#{1,6}\s/.test(l));
  if (end < 0) end = lines.length;
  while (end > head + 1 && !lines[end - 1]!.trim()) end--;
  // An empty section gets a blank line under its heading first.
  lines.splice(end, 0, ...(end === head + 1 ? ["", entry] : [entry]));
  return `${lines.join("\n")}\n`;
}
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
export function checkTyped(ch: unknown, { compiled, catalog, self }: Sources): void {
  if (!isMap(ch) || typeof ch.kind !== "string") refuse("a change is { kind, ... }");
  const c = ch as Change;
  // A self kind names only its filer; the board files none but `rules`.
  const me = (key: unknown) => self && key !== self.key && refuse(`${self.key} changes only itself`);
  const agentsOwn = () => self || refuse(`${c.kind} is an agent's change to itself`);
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
      me(c.agent);
      const a = agentOf(c.agent);
      text(c.text, a.tier === "local" ? HANDBOOK_MAX : RULES_MAX);
      if (a.tier === "local" && !c.text.trim()) refuse("a local agent's handbook can't be empty");
      if (a.tier === "local" && /^---\s*\n/.test(c.text)) refuse("a local handbook has no frontmatter: identity is in module.yaml");
      return;
    }
    case "skill": {
      agentsOwn();
      only(c, ["kind", "name", "text"]);
      if (!NAME.test(String(c.name))) refuse(`${c.name} isn't a skill name (a-z, 0-9 and -)`);
      text(c.text, RULES_MAX);
      return;
    }
    case "skills": {
      agentsOwn();
      only(c, ["kind", "agent", "add", "remove"]);
      me(c.agent);
      agentOf(c.agent);
      const ids = (v: unknown) => v == null || (Array.isArray(v) && v.length <= 50 && v.every((id) => typeof id === "string" && SKILL_ID.test(id))) || refuse("add and remove are lists of skill ids (<module>.<name>)");
      ids(c.add), ids(c.remove);
      if (![...(c.add ?? []), ...(c.remove ?? [])].length) refuse("skills: add or remove at least one skill");
      return;
    }
    case "routine_def": {
      agentsOwn();
      only(c, ["kind", "key", "routine", "delete"]);
      if (!NAME.test(String(c.key)) || String(c.key).length > 40) refuse(`${c.key} isn't a routine key (a-z, 0-9 and -)`);
      if ((c.delete === true) === isMap(c.routine) || (c.delete != null && c.delete !== true)) refuse("routine_def: a routine, or delete: true");
      const full = `${self!.key}-${c.key}`, had = has(compiled?.routines, full) ? compiled.routines[full] : undefined;
      if (had && had.tier !== "local") refuse(`routine key ${full} is a product routine`);
      if (had && had.agent !== self!.key) refuse(`routine ${full} belongs to ${had.agent}`);
      return;
    }
    case "profile": {
      agentsOwn();
      only(c, ["kind", "text", "decision", "replaces"]);
      if (!self!.roles.includes("fleet-admin")) refuse("only fleet-admin (Aiden) changes the owner profile: ask Aiden");
      // The whole profile, or one standing decision written into the profile as it is at the base (so a decision recorded
      // meanwhile is never overwritten by a stale copy).
      if ((c.text === undefined) === (c.decision === undefined)) refuse("profile: the whole `text`, or one `decision` (with `replaces`, the line it supersedes)");
      if (c.text !== undefined) {
        text(c.text, PROFILE_MAX);
        if (Buffer.byteLength(c.text) > PROFILE_MAX) refuse(`the owner profile is at most ${PROFILE_MAX} bytes`);
        if (c.replaces !== undefined) refuse("profile: `replaces` goes with a `decision`");
      }
      for (const f of ["decision", "replaces"]) if (c[f] !== undefined && !(typeof c[f] === "string" && c[f].trim() && c[f].length <= 500 && !/[\n\r]/.test(c[f]))) refuse(`profile: ${f} is one line of at most 500 characters`);
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
  skill: (ch) => [`modules/library/skills/${ch.name}/SKILL.md`, LIBRARY],
  skills: () => ["instance.yaml"],
  routine_def: () => [LIBRARY],
  profile: () => ["owner/profile.md"],
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
  // instance.yaml is read only when a change writes it (an agent's own handbook, skill or routine doesn't).
  const docText = changes.some((ch) => PATHS[ch.kind]?.(ch, localOf).includes("instance.yaml")) ? (current("instance.yaml") ?? refuse("the instance repo has no instance.yaml")) : "{}\n";
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
      case "skill":
        out.set(`modules/library/skills/${ch.name}/SKILL.md`, ch.text.endsWith("\n") ? ch.text : `${ch.text}\n`);
        if (current(LIBRARY) === undefined) out.set(LIBRARY, LIBRARY_TEXT);
        break;
      case "skills": {
        // The one override shape (overrides.agents.<k>.skills): an add takes the id off remove, and a remove takes it off add.
        const at = ["overrides", "agents", ch.agent, "skills"];
        const was = (doc.getIn(at) as YAML.YAMLMap | undefined)?.toJSON?.() ?? {};
        const [add, remove] = [new Set<string>(ch.add ?? []), new Set<string>(ch.remove ?? [])];
        const next = { add: [...new Set([...(was.add ?? []), ...add])].filter((id) => !remove.has(id)), remove: [...new Set([...(was.remove ?? []), ...remove])].filter((id) => !add.has(id)) };
        const v = Object.fromEntries(Object.entries(next).filter(([, l]) => l.length));
        if (Object.keys(v).length) set(at, v);
        else drop(at);
        break;
      }
      case "routine_def": {
        const libText = current(LIBRARY) ?? LIBRARY_TEXT;
        const lib = YAML.parseDocument(libText);
        if (lib.errors.length) refuse(`${LIBRARY} doesn't parse`);
        const full = `${ch.agent}-${ch.key}`;
        if (ch.delete) {
          if (!lib.hasIn(["routines", full])) refuse(`there is no routine ${full}`);
          lib.deleteIn(["routines", full]);
          const rs = lib.get("routines", true);
          if (YAML.isMap(rs) && !rs.items.length) lib.delete("routines");
        } else lib.setIn(["routines", full], lib.createNode({ ...ch.routine, agent: ch.agent }));
        out.set(LIBRARY, lib.toString({ lineWidth: 0 }));
        break;
      }
      case "profile":
        out.set("owner/profile.md", ch.decision !== undefined ? withDecision(current("owner/profile.md") ?? "", ch.decision, ch.replaces) : ch.text.endsWith("\n") ? ch.text : `${ch.text}\n`);
        break;
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
  /** The instance's config files at commit `base`, written into the empty folder `to` (checkoutTree). */
  tree: (base: string, to: string) => Promise<void>;
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

/** An instance tree compiled as this host compiles it (the staged compiler's own inputs, scripts/compiler/inputs.ts). */
export const compileTree = (product: string, dir: string) => compile(product, dir, loadInputs(product));

/**
 * POST /v1/settings/change: the owner's typed change on their settings task, written and filed as one kernel.apply. `asAgent`
 * (POST /v1/settings/agent): an agent's typed change on its own task. Through `self_change` (the signed tool), one of the self
 * kinds about the agent itself; through any other tool, a `setting` whose module lets one of the agent's roles write it
 * (module.yaml settings.<key>.writers). Either is filed with the agent as requester and tiered like any instance change.
 */
export function createSettingsChanges(d: SettingsDeps) {
  const sources = (): Sources => ({ compiled: YAML.parse(readFileSync(join(d.configDir, "paperclip.yaml"), "utf8")) ?? {}, catalog: JSON.parse(readFileSync(join(d.configDir, "modules.json"), "utf8")) });
  const count = (changes: unknown) => ((Array.isArray(changes) && changes.length && changes.length <= 10) || refuse("changes: one to ten typed changes"));
  const bundle = (): string[] => JSON.parse(readFileSync(join(d.product, "modules", "marketplace.json"), "utf8")).bundle ?? [];
  const localOfIn = (compiled: Dict) => (key: string) => (has(compiled.agents, key) && compiled.agents[key].tier === "local" ? String(compiled.agents[key].module) : undefined);
  const teamOfIn = (compiled: Dict): TeamOf => (key) => {
    const a = has(compiled.agents, key) ? compiled.agents[key] : undefined;
    return a?.team ? { team: a.team.name, record: true } : a?.member_of ? { team: compiled.agents[a.member_of]?.team?.name, record: false } : undefined;
  };
  /**
   * The owner's own open settings task (the board filed it a moment ago with the owner's key, held by no agent) and the account
   * behind his sign-in (board session or MCP client), checked here: that account decides the record. A credential that doesn't
   * check out is refused, never quietly put to the reviewer instead.
   */
  async function ownerTask(taskId: unknown, credential?: unknown): Promise<{ issue: Dict; account?: string }> {
    if (typeof taskId !== "string" || !/^[0-9a-f-]{36}$/.test(taskId)) refuse("task is the settings task's id");
    const account = credential === undefined ? undefined : (isCredential(credential) && (await d.credentialAccount(credential))) || refuse("that sign-in has ended: sign in again");
    const issue = (await d.task(taskId as string)) ?? refuse("no such task");
    const owner = await d.owner();
    if (!owner || issue.createdByUserId !== owner || issue.createdByAgentId || issue.assigneeAgentId) refuse("a settings change is the owner's own task, made by the board and held by no agent");
    if (!(issue.labels ?? []).some((l: Dict) => l?.name === SETTINGS_LABEL)) refuse(`that task isn't a settings change (no ${SETTINGS_LABEL} label)`);
    if (["done", "cancelled"].includes(String(issue.status))) refuse("that task is closed");
    return { issue, account };
  }
  async function apply(taskId: unknown, changes: unknown, credential?: unknown): Promise<{ record: string; tier: number; state: string; sha: string }> {
    count(changes);
    const { issue, account } = await ownerTask(taskId, credential);
    if (d.filed(taskId as string)) refuse("a settings change was already written on that task: file a new one");
    return write(taskId as string, issue, changes as unknown[], sources(), undefined, account ? { account, via: "save" } : undefined);
  }
  async function asAgent(requester: Requester, taskId: string, changes: unknown, module: string, { tool, why }: { tool?: string; why?: unknown } = {}): Promise<{ record: string; tier: number; state: string; sha: string }> {
    count(changes);
    if (tool === "self_change") return self(requester, taskId, changes as unknown[], why);
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
  /**
   * An agent's change to itself, validated at the instance main it fetched (`base`), never on the live config: the instance's
   * config files at base go into a scratch folder, compile there (paths, ownership and roles come from that compile), the
   * changes are written into it and it compiles again; any refusal or compile error comes before a branch is written. The
   * commit is written on that same base, so a main that moved since is the code host's "file again".
   */
  async function self(requester: Requester, taskId: string, changes: unknown[], why: unknown) {
    const key = requester.key || refuse("the job's agent has no key");
    for (const ch of changes) if (!isMap(ch) || !SELF_KINDS.includes(String(ch.kind))) refuse(`self_change takes ${SELF_KINDS.join(", ")} changes`);
    if (why != null && (typeof why !== "string" || why.length > 500 || !plain(why.replace(/\n/g, " ")))) refuse("why: one plain line of at most 500 characters");
    const issue = (await d.task(taskId)) ?? refuse("no such task");
    const repo = d.instanceRepo() ?? refuse("this kernel has no instance repo (AIDENHQ_INSTANCE_REPO)");
    const { base } = await d.main([]);
    const dir = mkdtempSync(join(tmpdir(), "aidenhq-self-"));
    try {
      await d.tree(base, dir);
      const compiled = (() => { try { return compileTree(d.product, dir); } catch (e) { return refuse(`the instance doesn't compile at ${base.slice(0, 12)}: ${(e as Error).message}`); } })();
      const src: Sources = { compiled: compiled.paperclip, catalog: compiled.catalog, self: { key, roles: requester.roles } };
      for (const ch of changes) checkTyped(ch, src);
      const typed = (changes as Change[]).map((ch) => (ch.kind === "routine_def" ? { ...ch, agent: key } : ch));
      const localOf = localOfIn(src.compiled);
      const allowed = allowedPaths(typed, localOf);
      const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : undefined);
      const files = planFiles(typed, { read, localOf, teamOf: teamOfIn(src.compiled), moduleHandbook: () => undefined, bundle: bundle() });
      const stray = [...files.keys()].filter((f) => !allowed.includes(f));
      if (stray.length) refuse(`it would change ${stray.join(", ")}, which these changes may not touch`);
      if (!files.size) refuse("it changes nothing: the instance is already like this");
      for (const [p, t] of files) {
        if (t === null) rmSync(join(dir, p), { force: true });
        else (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), t));
      }
      try { compileTree(d.product, dir); } catch (e) { refuse(`it doesn't compile: ${(e as Error).message}`); }
      return commit(repo, base, taskId, issue, typed, files, requester, undefined, typeof why === "string" ? why : undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async function write(taskId: string, issue: Dict, changes: unknown[], src: Sources, requester?: Requester, owner?: { account: string; via: string }) {
    const repo = d.instanceRepo() ?? refuse("this kernel has no instance repo (AIDENHQ_INSTANCE_REPO)");
    for (const ch of changes) checkTyped(ch, src);
    const typed = changes as Change[];
    const localOf = localOfIn(src.compiled);
    const allowed = allowedPaths(typed, localOf);
    const { base, texts } = await d.main(allowed);
    const moduleHandbook = (key: string) => {
      const a = has(src.compiled.agents, key) ? src.compiled.agents[key] : undefined;
      try { return readFileSync(a?.handbook_fork ? join(d.product, "modules", a.module, "agents", key, "AGENTS.md") : String(a?.instructions), "utf8"); } catch { return undefined; }
    };
    const files = planFiles(typed, { read: (p) => texts.get(p), localOf, teamOf: teamOfIn(src.compiled), moduleHandbook, bundle: bundle() });
    const stray = [...files.keys()].filter((f) => !allowed.includes(f));
    if (stray.length) refuse(`it would change ${stray.join(", ")}, which these changes may not touch`);
    if (!files.size) refuse("it changes nothing: the instance is already like this");
    return commit(repo, base, taskId, issue, typed, files, requester, owner);
  }
  /** The commit on `base` (the code host's write) and its one kernel.apply on the task. */
  async function commit(repo: string, base: string, taskId: string, issue: Dict, typed: Change[], files: Map<string, string | null>, requester?: Requester, owner?: { account: string; via: string }, why?: string) {
    const ident = String(issue.identifier ?? taskId).toLowerCase();
    // An agent may change settings more than once on its task: each change its own branch.
    const branch = requester ? `settings/${ident}-${Date.now().toString(36)}` : `settings/${ident}`;
    const by = requester ? `${requester.key || requester.name}'s` : "the owner's";
    const { sha } = await d.write({ repo, base, branch, files: Object.fromEntries(files), message: `settings: ${typed.map((c) => c.kind).join(", ")} (${issue.identifier ?? taskId})\n\n${why ? `${why}\n\n` : ""}Written by the kernel from ${by} typed change on ${issue.identifier ?? taskId}; no agent wrote it.` });
    const r = await d.file({ repo, branch, sha }, taskId, requester, owner);
    d.log?.("settings change filed", { task: issue.identifier, kinds: typed.map((c) => c.kind), record: r.id, tier: r.tier, ...(requester ? { agent: requester.key } : {}) });
    return { record: r.id, tier: r.tier, state: r.state, sha };
  }
  return Object.assign(apply, { asAgent, ownerTask });
}

/**
 * The compiled effective skill lists (agent key → skill ids) of the instance at an apply's base and with its commit's files
 * on top, and the commit's files with every file of each skill folder it touches (apply-tier.ts skill lines). `fetch` brings
 * the kernel's instance checkout up to main first (the base is on it); `tree` is checkoutTree.
 */
export function skillSides({ product, fetch, tree }: { product: string; fetch: () => Promise<unknown>; tree: (base: string, to: string) => Promise<void> }) {
  return async (c: { base?: string; files: string[]; texts: { head: Record<string, string> } }) => {
    if (!c.base) throw new Error("the commit's base isn't known");
    await fetch();
    const dir = mkdtempSync(join(tmpdir(), "aidenhq-skills-"));
    try {
      await tree(c.base, dir);
      const lists = (): Record<string, string[]> => Object.fromEntries(Object.entries<Dict>(compileTree(product, dir).paperclip.agents).map(([k, a]) => [k, a.skills ?? []]));
      // A base that doesn't compile counts as no skills: an apply may repair it (the head must compile).
      const before = (() => { try { return lists(); } catch { return {}; } })();
      for (const f of c.files) {
        const t = Object.hasOwn(c.texts.head, f) ? c.texts.head[f] : undefined;
        if (t === undefined) rmSync(join(dir, f), { force: true });
        else (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
      }
      const after = lists();
      const folders = new Set(c.files.map((f) => /^modules\/[^/]+\/skills\/[^/]+(?=\/)/.exec(f)?.[0]).filter((d): d is string => !!d && existsSync(join(dir, d))));
      const inFolders = [...folders].flatMap((d) => readdirSync(join(dir, d), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${join(e.parentPath, e.name).slice(dir.length + 1)}`));
      // Each local skill an agent starts using, with its text (the reviewer reads what it newly steers).
      const newly = new Set(Object.entries(after).flatMap(([k, ids]) => ids.filter((id) => !(before[k] ?? []).includes(id))));
      const enabledTexts = Object.fromEntries([...newly].flatMap((id) => { const [m, n] = [id.slice(0, id.indexOf(".")), id.slice(id.indexOf(".") + 1)]; const f = join(dir, "modules", m, "skills", n, "SKILL.md"); return existsSync(f) ? [[id, readFileSync(f, "utf8")]] : []; }));
      return { before, after, files: [...new Set([...c.files, ...inFolders])], enabledTexts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The instance's config files (instance.yaml, apps.yaml, owner/, agents/, modules/) at a commit of the kernel's instance
 * checkout, written into an empty folder: regular files only, at most 2 MB in all (checked before anything is written).
 */
export function checkoutTree(dir: string) {
  const git = (args: string[]) => new Promise<string>((ok, no) => execFile("git", ["-C", dir, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? no(e) : ok(String(out)))));
  return async (base: string, to: string) => {
    if (!SHA.test(base)) refuse("the instance base isn't a commit");
    const entries = (await git(["ls-tree", "-r", "-l", "-z", base, "--", "instance.yaml", "apps.yaml", "owner", "agents", "modules"])).split("\0").filter(Boolean).map((l) => {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(-|\d+)\t(.+)$/s.exec(l) ?? refuse("the instance tree didn't read");
      return { mode: m[1]!, type: m[2]!, sha: m[3]!, size: Number(m[4]), path: m[5]! };
    }).filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755"));
    if (entries.reduce((n, e) => n + e.size, 0) > 2 * 1024 * 1024) refuse("the instance's config is over 2 MB");
    for (const e of entries) {
      if (e.path.split("/").some((part) => part === ".." || part === "")) continue;
      mkdirSync(dirname(join(to, e.path)), { recursive: true });
      writeFileSync(join(to, e.path), await git(["cat-file", "blob", e.sha]));
    }
  };
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
