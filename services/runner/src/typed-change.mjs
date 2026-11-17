// The board's typed settings changes (docs/design/settings-changes.md): the owner files one from a board page as their own
// task (label settings-change, no assignee; the board keeps the typed change itself, by task id), and the runner writes exactly the files
// that change names on a fleet/ branch of the instance repo, then files the usual apply card. No model writes the commit.
// This file is the gate's pure half: who may file one, what each kind may be, and the files each kind may touch.
// The board checks the same shapes for the owner's feedback (services/board/src/settings-change.ts); this check is the gate.
import { createHash } from "node:crypto";
import YAML from "yaml";
import { urlSettingProblem } from "./url-setting.ts";

export class TypedRefused extends Error {}
const refuse = (msg) => {
  throw new TypedRefused(msg);
};

export const SETTINGS_LABEL = "settings-change";

/**
 * The typed changes of a settings task, as the board stored them when the owner filed it (GET /internal/settings-changes/:id,
 * the runner's key): never the task's description, which others may edit. Only the owner's own task counts: made by the
 * owner's Paperclip user (`owner`, the key the board files with), by no agent and not by the runner, and held by no agent.
 */
export function typedTaskChanges(issue, { owner, stored, runnerMade = false }) {
  if (!owner || issue?.createdByUserId !== owner || issue.createdByAgentId || runnerMade) refuse("only the owner's own settings task is written by the runner; this one wasn't made by the owner");
  if (issue.assigneeAgentId) refuse("a settings task held by an agent is the agent's to do, not the runner's");
  if (!Array.isArray(stored) || !stored.length || stored.length > 10) refuse("the board holds no typed change for this task");
  return stored;
}

const KEY = /^[a-z][a-z0-9_]{0,60}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,60}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SHA = /^[0-9a-f]{40}$/;
const MODEL = /^[A-Za-z0-9~][\w./~:@-]{0,119}$/;
const plain = (s) => typeof s === "string" && !/[\x00-\x1f\x7f$]/.test(s);
const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const only = (ch, keys) => Object.keys(ch).every((k) => keys.includes(k)) || refuse(`${ch.kind}: unknown fields (${Object.keys(ch).filter((k) => !keys.includes(k)).join(", ")})`);
/** Handbook texts: Markdown, no NUL or other control characters but tab and newlines. */
const text = (t, max) => (typeof t === "string" && t.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(t)) || refuse(`text must be at most ${max} characters, without control characters`);
const HANDBOOK_MAX = 120_000;
const RULES_MAX = 20_000;

/**
 * One typed change, checked against the compiled config (config/paperclip.yaml: agents, routines, mcp_servers, settings) and
 * the module catalog (config/modules.json): the shape, the values, and that what it names exists. Throws TypedRefused.
 */
export function checkTyped(ch, { compiled, catalog }) {
  if (!isMap(ch) || typeof ch.kind !== "string") refuse("a change is { kind, ... }");
  const agentOf = (key, { module } = {}) => {
    if (!AGENT.test(String(key))) refuse(`${key} isn't an agent key`);
    const a = compiled?.agents?.[key] ?? refuse(`there is no agent ${key}`);
    if (module && a.module === "instance") refuse(`${key} is the instance's own agent: its handbook and grants are its agents/${key}/ files`);
    return a;
  };
  const moduleOf = (name) => (NAME.test(String(name)) && catalog.find((m) => m.name === name)) || refuse(`there is no module ${name}`);
  switch (ch.kind) {
    case "setting": {
      only(ch, ["kind", "key", "value"]);
      if (!KEY.test(String(ch.key)) || /token|secret|password/i.test(ch.key)) refuse(`${ch.key} isn't a setting the board may change`);
      const def = catalog.find((m) => m.enabled && m.settings?.[ch.key])?.settings?.[ch.key];
      if (!def && !compiled?.settings?.[ch.key]) refuse(`there is no setting ${ch.key}`);
      const each = [ch.value].flat();
      if ((Array.isArray(ch.value) && ch.value.length > 50) || each.some((v) => !["string", "number", "boolean"].includes(typeof v) || (typeof v === "string" && (v.length > 500 || !plain(v))))) refuse(`${ch.key}: plain values only`);
      if (def?.values && each.some((v) => !def.values.includes(v))) refuse(`${ch.key}: one of ${def.values.join(", ")}`);
      if (def?.type === "url" && urlSettingProblem(ch.value, def.host)) refuse(`${ch.key}: ${urlSettingProblem(ch.value, def.host)}`);
      return;
    }
    case "agent": {
      only(ch, ["kind", "agent", "field", "value"]);
      agentOf(ch.agent);
      const ok = { model: (v) => typeof v === "string" && MODEL.test(v), reasoning_effort: (v) => typeof v === "string" && /^[a-z]{1,20}$/.test(v), heartbeat: (v) => v === false || (Number.isInteger(v) && v >= 1 && v <= 24) }[ch.field];
      if (!ok) refuse(`${ch.field} isn't an agent field the board may change`);
      if (!ok(ch.value)) refuse(`${ch.agent}.${ch.field} can't be ${JSON.stringify(ch.value)}`);
      return;
    }
    case "caps": {
      only(ch, ["kind", "agent", "value"]);
      agentOf(ch.agent);
      const v = ch.value;
      if (!isMap(v) || !Object.keys(v).length || Object.entries(v).some(([k, x]) => !["run_usd", "task_usd", "day_usd"].includes(k) || typeof x !== "number" || !(x > 0) || x > 1000)) refuse("caps are run_usd, task_usd, day_usd: USD above 0, at most 1000");
      return;
    }
    case "module": {
      only(ch, ["kind", "name", "on"]);
      const m = moduleOf(ch.name);
      if (ch.name === "kernel" || typeof ch.on !== "boolean") refuse("a module is turned on or off");
      if (Boolean(m.chosen) === ch.on) refuse(`${ch.name} is already ${ch.on ? "on" : "off"}`);
      return;
    }
    case "routine": {
      only(ch, ["kind", "routine", "field", "value"]);
      if (!KEY.test(String(ch.routine).replace(/-/g, "_")) || !compiled?.routines?.[ch.routine]) refuse(`there is no routine ${ch.routine}`);
      const v = ch.value;
      const schedule = (s) => isMap(s) && Object.keys(s).every((k) => ["cron", "timezone", "label"].includes(k)) && typeof s.cron === "string" && /^[0-9*/,\- ]{9,100}$/.test(s.cron) && (s.timezone == null || (typeof s.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$|^UTC$/.test(s.timezone))) && (s.label == null || (plain(s.label) && s.label.length <= 60));
      const ok = { schedules: () => Array.isArray(v) && v.length <= 10 && v.every(schedule), status: () => v === "active" || v === "paused", model: () => typeof v === "string" && MODEL.test(v) }[ch.field];
      if (!ok) refuse(`${ch.field} isn't a routine field the board may change`);
      if (!ok()) refuse(`${ch.routine}.${ch.field} can't be ${JSON.stringify(v).slice(0, 200)}`);
      return;
    }
    case "rules": {
      only(ch, ["kind", "agent", "text"]);
      const a = agentOf(ch.agent);
      text(ch.text, a.module === "instance" ? HANDBOOK_MAX : RULES_MAX);
      if (a.module === "instance" && !ch.text.trim()) refuse("an instance agent's handbook can't be empty");
      return;
    }
    case "handbook": {
      only(ch, ["kind", "agent", "text"]);
      agentOf(ch.agent, { module: true });
      text(ch.text, HANDBOOK_MAX);
      if (!ch.text.trim()) refuse("a handbook can't be empty");
      return;
    }
    case "unfork": {
      only(ch, ["kind", "agent"]);
      agentOf(ch.agent, { module: true });
      return;
    }
    case "pin": {
      only(ch, ["kind", "name", "sha"]);
      moduleOf(ch.name);
      if (ch.sha !== null && !SHA.test(String(ch.sha))) refuse("a pin is a 40-character commit, or null to follow the marketplace");
      return;
    }
    case "marketplace": {
      only(ch, ["kind", "op", "name", "source", "sha"]);
      if (!NAME.test(String(ch.name))) refuse(`${ch.name} isn't a marketplace name`);
      if (!["add", "update", "remove"].includes(ch.op)) refuse("a marketplace is added, updated or removed");
      if (ch.op === "add" && !(isMap(ch.source) && Object.keys(ch.source).length === 2 && ch.source.source === "github" && /^[\w.-]+\/[\w.-]+$/.test(String(ch.source.repo)))) refuse("a marketplace comes from a GitHub owner/repo");
      if (ch.op !== "remove" && !SHA.test(String(ch.sha))) refuse("a marketplace is pinned at a 40-character commit");
      if (ch.op !== "add" && ch.source != null) refuse("only adding names the source");
      if (ch.op === "remove" && ch.sha != null) refuse("removing takes no sha");
      return;
    }
    case "grants": {
      only(ch, ["kind", "agent", "connection", "tools"]);
      agentOf(ch.agent, { module: true });
      const c = (KEY.test(String(ch.connection)) && compiled?.mcp_servers?.[ch.connection]) || refuse(`there is no connection ${ch.connection}`);
      const all = [...(c.tools?.read ?? []), ...(c.tools?.write ?? []), ...(c.tools?.destructive ?? [])];
      if (ch.tools !== null && (!Array.isArray(ch.tools) || ch.tools.length > 200 || ch.tools.some((t) => !all.includes(t)) || new Set(ch.tools).size !== ch.tools.length)) refuse(`${ch.connection}: tools it declares, each once`);
      return;
    }
    default:
      refuse(`${ch.kind} isn't a change the board may make`);
  }
}

/** A git blob id of a text (what `git hash-object` gives): the module handbook a fork was copied from. */
export const blobSha = (t) => createHash("sha1").update(`blob ${Buffer.byteLength(t)}\0`).update(t).digest("hex");

/**
 * Kind → the instance repo files it may write (and nothing else). `isInstance(key)`: the agent is the instance's own.
 */
export const PATHS = {
  setting: () => ["instance.yaml"],
  agent: () => ["instance.yaml"],
  caps: () => ["instance.yaml"],
  module: () => ["instance.yaml"],
  routine: () => ["instance.yaml"],
  pin: () => ["instance.yaml"],
  marketplace: () => ["instance.yaml"],
  grants: () => ["instance.yaml"],
  rules: (ch, isInstance) => [isInstance(ch.agent) ? `agents/${ch.agent}/AGENTS.md` : `agents/${ch.agent}.md`],
  handbook: (ch) => [`agents/${ch.agent}/AGENTS.md`, "instance.yaml"],
  unfork: (ch) => [`agents/${ch.agent}/AGENTS.md`, "instance.yaml"],
};
export const allowedPaths = (changes, isInstance) => [...new Set(changes.flatMap((ch) => (PATHS[ch.kind] ?? refuse(`${ch.kind} writes nothing`))(ch, isInstance)))].sort();

/** The commit's changed files, each one a file its changes may write; anything else refuses the whole change. */
export function assertOnly(changed, allowed) {
  const stray = changed.filter((f) => !allowed.includes(f));
  if (stray.length) refuse(`it would change ${stray.join(", ")}, which these changes may not touch`);
  if (!changed.length) refuse("it changes nothing: the instance is already like this");
}

const entryId = (item) => String(YAML.isMap(item) ? item.get("id") : YAML.isScalar(item) ? item.value : item);
const entryName = (item) => entryId(item).split("@")[0];

/**
 * The files these changes write, from the files as they are (`read(path)`: text, or undefined when absent): path → new text,
 * or null to delete. instance.yaml is edited through the yaml Document API, so its comments and layout stay; emptied maps
 * are dropped, so a change and its undo leave it as it was. `isInstance(key)`: the instance's own agent; `moduleHandbook(key)`:
 * the module's handbook text the host runs (a new fork records its blob).
 */
export function planFiles(changes, { read, isInstance, moduleHandbook }) {
  const out = new Map();
  const current = (p) => (out.has(p) ? (out.get(p) ?? undefined) : read(p));
  const docText = current("instance.yaml") ?? refuse("the instance repo has no instance.yaml");
  const doc = YAML.parseDocument(docText);
  if (doc.errors.length) refuse(`instance.yaml doesn't parse (${doc.errors[0].message.split("\n")[0]})`);
  let yamlTouched = false;
  const set = (path, v) => ((yamlTouched = true), doc.setIn(path, doc.createNode(v)));
  const drop = (path) => {
    yamlTouched = true;
    doc.deleteIn(path);
    for (let p = path.slice(0, -1); p.length; p = p.slice(0, -1)) {
      const n = doc.getIn(p, true);
      if (YAML.isMap(n) && !n.items.length) doc.deleteIn(p);
      else break;
    }
  };
  const seq = (key) => {
    const n = doc.get(key, true);
    if (n == null) return (set([key], []), doc.get(key, true));
    return YAML.isSeq(n) ? n : refuse(`instance.yaml ${key}: must be a list`);
  };
  const forkOf = (key) => doc.getIn(["overrides", "agents", key, "handbook_fork"]);
  for (const ch of changes) {
    switch (ch.kind) {
      case "setting":
        set(["settings", ch.key], ch.value);
        break;
      case "agent":
        set(["overrides", "agents", ch.agent, ch.field], ch.value);
        break;
      case "caps":
        for (const [k, v] of Object.entries(ch.value)) set(["overrides", "agents", ch.agent, "caps", k], v);
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
        yamlTouched = true;
        break;
      }
      case "pin": {
        const s = seq("modules");
        const i = s.items.findIndex((x) => entryName(x) === ch.name);
        if (i < 0) refuse(`${ch.name} isn't listed in instance.yaml modules: (turn it on first)`);
        if (YAML.isMap(s.items[i]) && s.items[i].get("fork") != null) refuse(`${ch.name} runs a fork: drop the fork before pinning it`);
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
        else if (ch.op === "update") s.items[i].set("sha", ch.sha);
        else s.items.splice(i, 1);
        if (!s.items.length) doc.delete("marketplaces");
        yamlTouched = true;
        break;
      }
      case "rules": {
        const [p] = PATHS.rules(ch, isInstance);
        out.set(p, !isInstance(ch.agent) && !ch.text.trim() ? null : ch.text.endsWith("\n") ? ch.text : `${ch.text}\n`);
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
    if (YAML.isMap(doc.get("overrides", true)) && !doc.get("overrides", true).items.length) doc.delete("overrides");
    // No re-folding of long lines; a line that differs from one in the file only by its flow spacing ({ a } or {a}) is
    // written as the file had it, so the diff is only the lines the change makes.
    const flat = (l) => l.replace(/([[{]) +/g, "$1").replace(/ +([\]}])/g, "$1");
    const had = new Map(docText.split("\n").map((l) => [flat(l), l]));
    out.set("instance.yaml", doc.toString({ lineWidth: 0 }).split("\n").map((l) => had.get(flat(l)) ?? l).join("\n"));
  }
  // Only real changes: a file written as it already is, or deleted when absent, is no change.
  for (const [p, t] of out) if (t === (read(p) ?? null)) out.delete(p);
  return out;
}
