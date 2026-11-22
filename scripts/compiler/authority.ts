// The authority diff (spec §5.7): what a module change hands out that it did not before, read from its manifest and its
// code diff, never from its own description. Every module change goes to the AI reviewer, which reads these lines (new
// authority marked `owner`, a module that isn't official's or new spend `ownerOnly`, listed first) and blocks only malice.
// Pure: callers read the manifests.
//
// Lines are built from code-chosen words and ids cleaned to [\w.:@/-], never from manifest prose, because they are shown on
// the owner's card and in the apply log.
import { ownSecrets } from "./services.ts";
import { forksOf, marketplacesOf, OFFICIAL, OFFICIAL_URL } from "./sources.ts";
import { heir } from "../../kernel/src/successor.ts";

type Dict = Record<string, unknown>;
export type ModuleDef = Dict;
/**
 * `ownerOnly`: new authority from a module that isn't official, or new spend (listed first for the reviewer). `spend`: a
 * spend or limit increase, which the card names as one.
 */
export type Change = { what: string; owner: boolean; ownerOnly?: true };
/** `official`: the module is read from the product's own modules/ (ModuleInput.official); marketplace and fork lines never are. */
export type ModuleDiff = { module: string; changes: Change[]; code: boolean; official?: true };
/**
 * `origin`: where a third-party module comes from on each side (marketplace, sha, computed tier), for the card. `official`:
 * it is read from the product's own modules/ at the pinned commit (sources.ts officialSides), so CI, the AI reviewer and
 * its eval passed it at merge; absent is not official.
 */
export type ModuleInput = { base?: ModuleDef; head?: ModuleDef; codeChanged: boolean; textChanged?: boolean; replacing?: { name: string; def?: ModuleDef }[]; origin?: { base?: string; head?: string }; conns?: Dict; official?: boolean };

const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const map = (v: unknown): Dict => (isMap(v) ? v : {});
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keys = (...ds: unknown[]) => [...new Set(ds.flatMap((d) => Object.keys(map(d))))];
/** An id as shown: printable, short, no spaces. */
export const id = (v: unknown) => String(v).replace(/[^\w.:@/~-]/g, "_").slice(0, 80) || "_";
const added = (b: unknown, h: unknown) => list(h).map((x) => (isMap(x) ? x.name ?? x.id : x)).filter((x) => !list(b).map((y) => (isMap(y) ? y.name ?? y.id : y)).includes(x));

/** Top-level keys that never hand out authority by themselves (their contents are checked where they can). */
const PLAIN = new Set(["stages", "journeys", "name", "version", "description", "license", "publisher", "homepage", "kernel", "requires", "provides", "conflicts", "replaces", "data_version", "labels", "company", "departments", "setup", "apps", "events", "checks", "points", "contributes", "prompts", "skills", "jobcaps"]);
/** Checked below, field by field. */
const CHECKED = new Set(["facts", "writes", "privileged", "secrets", "generated_secrets", "optional_secrets", "roles", "default_grants", "connections", "services", "agents", "providers", "isolation", "routines", "board_env", "workspaces", "codehost", "check_jobs", "settings", "validate"]);
/** Every top-level module.yaml key the kernel knows: any other is a compile error (module.yaml is strict, spec §3.1). */
export const MANIFEST_KEYS = new Set([...PLAIN, ...CHECKED]);
/** Agent fields that hand out nothing (model and engine choice, scheduling, presentation, the module text it reads: skills, like
 * prompts). Others are new authority. */
const AGENT_PLAIN = new Set(["department", "adapter", "max_parallel", "model", "models", "reasoning_effort", "timeout_sec", "heartbeat", "persona", "graded", "brief", "engine", "dispatch", "image", "web_search", "delegate_to", "jobcaps", "builder", "description", "name", "title", "skills", "engines"]);
/** Service fields that change what runs or how much, not what it may reach (the code diff and the panel judge those). */
const SERVICE_PLAIN = new Set(["image", "build", "command", "entrypoint", "env", "secrets", "port", "healthcheck", "cpus", "memory", "pids", "tmp", "on_demand"]);
/** What each kernel role a module requests opens (kinds.ts KERNEL_ROLES, backplane.ts), as its line on the card says. */
const KERNEL_ROLE_GRANTS: Record<string, string> = {
  "kernel.apply": "files instance applies",
  "kernel.checks": "runs check jobs",
  "kernel.cp-read": "reads the control plane as the owner",
  "kernel.facts": "records flow facts of the types it declares",
  "kernel.flow-read": "reads the fleet's flow timelines and metrics",
  "kernel.grader": "mints grader tokens",
  "kernel.jobs": "runs agents' jobs",
  "kernel.lane": "writes fast-lane turns to an agent's chat",
  "kernel.memory": "writes the calling agent's own memory, for its memory tools",
  "kernel.notify": "takes and sends the owner's messages",
  "kernel.owner-notice": "messages the owner",
  "kernel.routines": "pauses a routine (never resumes one)",
  "kernel.routing": "files team routing changes (members' repos, routing weights) as reviewed applies, for its routing-tuner agents",
  "kernel.settings": "files its agents' changes to the settings its module names them writers of, as reviewed applies",
  "kernel.tasks": "files and closes tasks",
  "kernel.wake": "schedules wakes",
  "kernel.work-read": "reads the kernel's jobs and records",
};
const ISOLATION_RANK: Record<string, number> = { untrusted: 0, "code-exec": 1, trusted: 2 };

/** Each setting a module lets roles write (settings.<key>.writers), as [key, roles]. */
const settingWriters = (def: Dict) => Object.entries(map(def.settings)).flatMap(([k, d]) => (isMap(d) && d.writers != null ? [[k, list(d.writers).map(String)] as [string, string[]]] : []));

/**
 * A grant is wider when it newly reaches tools it did not: a new connection, read → write or a list, a list with new names,
 * or write → a list naming a tool outside the read and write tags (fail closed when the tags aren't known).
 */
function widerGrant(was: unknown, now: unknown, tags?: Dict): boolean {
  if (eq(was, now)) return false;
  if (was == null) return true;
  if (now === "read") return false;
  if (was === "write") return Array.isArray(now) && (!tags || now.some((t) => ![...list(tags.read), ...list(tags.write)].includes(t)));
  if (Array.isArray(was) && Array.isArray(now)) return now.some((t) => !was.includes(t));
  return true;
}

/** Tools a connection grant reaches that are tagged write or destructive (fail closed: unknown tags count as writes). */
function writesOf(grant: unknown, tags: Dict | undefined): string[] {
  if (grant === "read") return [];
  if (grant === "write") return ["write"];
  if (!Array.isArray(grant)) return grant == null ? [] : [String(grant)];
  if (!tags) return grant.map(String);
  const w = [...list(tags.write), ...list(tags.destructive)];
  return grant.filter((t) => w.includes(t)).map(String);
}

/**
 * A's def with the ids A declares (connections, secrets, write kinds, roles, jobcaps) renamed into B's namespace (spec A24),
 * so equal authority shows as no change. Only ids A declares under its own prefix (`a.x`, `a-x`, `a_x`) are renamed, through
 * an explicit map, and only where the manifest names an id; two ids landing on one name, or on another id A declares, is
 * ambiguous and refused (the apply is refused, never guessed).
 */
export function renamed(def: ModuleDef, from: string, to: string): ModuleDef {
  const s = map(def.secrets), roles = map(def.roles);
  const declared = new Set([...keys(def.connections), ...ownSecrets(def), ...keys(def.writes), ...list(roles.declares).map((r) => String(isMap(r) ? r.id : r)), ...list(def.jobcaps).map((j) => String(map(j).id))]);
  const prefixes = [[from, to], [from.replace(/-/g, "_"), to.replace(/-/g, "_")]] as const;
  const m = new Map<string, string>();
  for (const x of declared) {
    const p = prefixes.find(([a]) => x === a || (x.startsWith(a) && /[._-]/.test(x[a.length] ?? "")));
    if (p) m.set(x, p[1] + x.slice(p[0].length));
  }
  const seen = new Map<string, string>();
  for (const [k, v] of m) {
    if (seen.has(v) || (declared.has(v) && !m.has(v))) throw new Error(`replacing ${from} with ${to}: ${k} and ${seen.get(v) ?? v} would both be ${v}`);
    seen.set(v, k);
  }
  const r = (x: unknown) => { const t = String(x); const opt = t.endsWith("?") ? "?" : ""; return (m.get(opt ? t.slice(0, -1) : t) ?? t.slice(0, t.length - opt.length)) + opt; };
  // Any two names landing on one after the rename (map keys or list items) would hide one of them: refused.
  const once = <T>(pairs: [string, T][], where: string): [string, T][] => {
    const got = new Set<string>();
    for (const [k] of pairs) {
      if (got.has(k)) throw new Error(`replacing ${from} with ${to}: two entries of ${where} would both be ${k}`);
      got.add(k);
    }
    return pairs;
  };
  const rk = (o: unknown, where: string) => Object.fromEntries(once(Object.entries(map(o)).map(([k, v]) => [r(k), v]), where));
  const rl = (l: unknown[], where: string) => once(l.map((x) => [r(x), x] as [string, unknown]), where).map(([k]) => k);
  const out: Dict = structuredClone(def);
  if (isMap(def.connections)) out.connections = Object.fromEntries(once(Object.entries(def.connections).map(([k, c]) => [r(k), isMap(c) && c.auth != null ? { ...c, auth: r(c.auth) } : c]), "connections"));
  if (isMap(def.writes)) out.writes = rk(def.writes, "writes");
  for (const k of ["generated_secrets", "optional_secrets"]) if (Array.isArray(def[k])) out[k] = (def[k] as unknown[]).map(r);
  if (isMap(def.secrets)) out.secrets = { ...s, ...(Array.isArray(s.generated) ? { generated: s.generated.map(r) } : {}), ...(Array.isArray(s.provided) ? { provided: s.provided.map((p) => (isMap(p) ? { ...p, name: r(p.name) } : r(p))) } : {}) };
  if (isMap(def.roles)) out.roles = { ...roles, ...(Array.isArray(roles.declares) ? { declares: roles.declares.map((d) => (isMap(d) ? { ...d, id: r(d.id) } : r(d))) } : {}), ...(Array.isArray(roles.requests) ? { requests: roles.requests.map(r) } : {}) };
  if (Array.isArray(def.jobcaps)) out.jobcaps = def.jobcaps.map((j) => (isMap(j) ? { ...j, id: r(j.id), ...(j.connection != null ? { connection: r(j.connection) } : {}), ...(j.read_secret != null ? { read_secret: r(j.read_secret) } : {}) } : j));
  if (isMap(def.agents)) out.agents = Object.fromEntries(Object.entries(def.agents).map(([k, a]) => [k, isMap(a) ? { ...a, ...(isMap(a.connections) ? { connections: rk(a.connections, `agent ${k} connections`) } : {}), ...(Array.isArray(a.roles) ? { roles: rl(a.roles, `agent ${k} roles`) } : {}), ...(Array.isArray(a.jobcaps) ? { jobcaps: rl(a.jobcaps, `agent ${k} jobcaps`) } : {}) } : a]));
  const sv = map(def.services);
  if (isMap(sv.grants)) out.services = { ...sv, grants: rk(sv.grants, "services.grants") };
  return out;
}

/** Sections joined entry by entry (an entry is compared whole), and sections joined key by key, when B takes A's place. */
const KEYED = new Set(["connections", "writes", "settings", "agents", "providers", "facts", "services.run", "services.grants"]);
const NESTED = new Set(["secrets", "roles", "services"]);

/**
 * B's base joined with A's def (renamed into B's namespace), for a replace: what either had is not new in `head`. Lists are
 * joined as sets. An entry (a connection, write kind, setting, agent, provider, service, grant) or a value both define and
 * that differs counts as had only when B's head equals one of the two whole; otherwise `conflict` names it, the owner's,
 * and B's own is kept. Keys that hand out nothing (PLAIN) stay B's.
 */
function join(b: Dict, a: Dict, h: Dict, conflict: (where: string) => void, path = ""): Dict {
  const out: Dict = { ...b };
  const pick = (bv: unknown, av: unknown, hv: unknown, where: string) => (eq(hv, bv) ? bv : eq(hv, av) ? av : (conflict(where), bv));
  for (const k of Object.keys(a)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in b)) out[k] = a[k];
    else if (eq(b[k], a[k])) continue;
    else if (Array.isArray(b[k]) && Array.isArray(a[k])) out[k] = [...(b[k] as unknown[]), ...(a[k] as unknown[]).filter((x) => !(b[k] as unknown[]).some((y) => eq(x, y)))];
    else if (!path && PLAIN.has(k)) continue;
    else if (NESTED.has(p) && isMap(b[k]) && isMap(a[k])) out[k] = join(b[k], a[k], map(h[k]), conflict, p);
    else if (KEYED.has(p) && isMap(b[k]) && isMap(a[k])) {
      const [be, ae, he] = [b[k] as Dict, a[k] as Dict, map(h[k])];
      out[k] = { ...be, ...Object.fromEntries(Object.keys(ae).map((e) => [e, e in be ? pick(be[e], ae[e], he[e], `${p} ${e}`) : ae[e]])) };
    } else out[k] = pick(b[k], a[k], h[k], p);
  }
  return out;
}

/**
 * What `head` hands out that `base` did not. `base` undefined: an install (diffed against nothing); `head` undefined: a
 * remove. `replacing`: B takes each A's place in this change. With A's def (moduleInputs: its successor), B is diffed against
 * its own base joined with A's def renamed into B's namespace (join), so authority moved from A is not new; without it, the
 * claim alone is the owner's.
 */
export function authorityDiff(name: string, base: ModuleDef | undefined, head: ModuleDef | undefined, codeChanged: boolean, replacing: { name: string; def?: ModuleDef }[] = [], origin: { base?: string; head?: string } = {}, conns: Dict = {}, official = false): ModuleDiff {
  const changes: Change[] = [];
  const owner = (what: string) => changes.push({ what, owner: true, ...(official ? {} : { ownerOnly: true as const }) });
  const review = (what: string) => changes.push({ what, owner: false });
  if (head) {
    for (const r of replacing) {
      if (!r.def) {
        owner(`replaces ${id(r.name)}, but is not its one official successor: nothing it had carries over`);
        continue;
      }
      base = join(base ?? {}, renamed(r.def, r.name, name), head, (w) => owner(`${w}: ${id(name)} and ${id(r.name)} both had it, and it is neither one now`));
      review(`replaces ${id(r.name)}`);
    }
  }
  if (!head) {
    const enforces = [list(base?.checks).length && "a check", map(map(base?.providers)).reviewer && "a reviewer", map(map(base?.providers)).executor && "an executor"].filter(Boolean);
    if (enforces.length) owner(`removed, and it declares ${enforces.join(", ")}`);
    else review("removed");
    return { module: name, changes, code: false, ...(official ? { official: true as const } : {}) };
  }
  const b = base ?? {};
  // Code from off the official repository's main (sources.ts onOfficialMain: "unreviewed") is the owner's, as a fork is.
  const from = origin.head && /, unreviewed:/.test(origin.head) ? owner : review;
  if (!base) from(`installed${origin.head ? ` from ${origin.head}` : ""}`);
  else if (origin.head && origin.head !== origin.base) from(`now from ${origin.head}`);
  // Enforcement it drops (a check, its reviewer or executor provider) is authority too: the owner's, as on a remove. A check
  // moved to observe mode (gates.ts) no longer enforces, so it counts as dropped.
  const checkIds = (x: Dict) => list(x.checks).filter((c) => !(isMap(c) && c.mode === "observe")).map((c) => JSON.stringify(isMap(c) ? c.id ?? c : c));
  const gone = checkIds(b).filter((c) => !checkIds(head).includes(c));
  if (gone.length) owner(`drops ${gone.length} check${gone.length === 1 ? "" : "s"}`);
  // A validate hook is sent the values of the settings and secrets the owner saves for the module: a new or changed one is the owner's.
  if (head.validate != null && !eq(b.validate, head.validate)) owner(`validate hook ${id(String(map(head.validate).post ?? ""))}: receives the module's pasted secrets and settings`);
  for (const k of ["reviewer", "executor"]) if (map(b.providers)[k] && !map(head.providers)[k]) owner(`drops its ${k} provider`);

  for (const k of keys(b, head)) {
    if (PLAIN.has(k) || CHECKED.has(k) || eq(b[k], head[k])) continue;
    owner(`unrecognised key ${id(k)}`);
  }

  // Write kinds: a new kind or a lowered floor is the owner's; other changes to a kind are the reviewer's.
  const [bw, hw] = [map(b.writes), map(head.writes)];
  for (const k of keys(hw)) {
    if (!(k in bw)) owner(`adds write kind ${id(k)}`);
    else if (Number(map(hw[k]).floor ?? 1) < Number(map(bw[k]).floor ?? 1)) owner(`lowers the floor of write kind ${id(k)}`);
    else if (!eq(bw[k], hw[k])) review(`changes write kind ${id(k)}`);
  }
  for (const p of added(b.privileged, head.privileged)) owner(`adds privileged ${id(p)}`);
  // Its code host grant (codehost:): the typed operations it may ask for, run as the owner's GitHub sign-in. Any new or
  // changed grant is the owner's; dropping it hands out nothing.
  if (head.codehost != null && !eq(b.codehost, head.codehost)) owner("changes its code host grant (codehost: operations on repos as the owner)");
  else if (!eq(b.codehost, head.codehost)) review("drops its code host grant");
  // Its check job recipes (check_jobs:, kernel/src/checkjobs.ts): what runs credential-free and decides a receipt the code host
  // lands on. Any new or changed recipe is the owner's; dropping one hands out nothing.
  if (head.check_jobs != null && !eq(b.check_jobs, head.check_jobs)) owner("changes its check job recipes (check_jobs: what a signed receipt means)");
  else if (!eq(b.check_jobs, head.check_jobs)) review("drops its check job recipes");
  for (const p of added(head.privileged, b.privileged)) owner(`drops privileged ${id(p)}`);

  // Secrets: every name it may mount (generated, optional, provided, connection service keys, jobcap read secrets).
  for (const s of ownSecrets(head).filter((x) => !ownSecrets(b).includes(x))) owner(`adds secret ${id(s)}`);
  if (map(head.secrets).state === true && map(b.secrets).state !== true) owner("gets its own vault dir read-write (secrets.state)");

  const [br, hr] = [map(b.roles), map(head.roles)];
  for (const r of added(br.declares, hr.declares)) owner(`declares role ${id(r)}`);
  for (const r of added(br.requests, hr.requests)) owner(`requests role ${id(r)}${KERNEL_ROLE_GRANTS[String(r)] ? ` (${KERNEL_ROLE_GRANTS[String(r)]}${r === "kernel.settings" ? `: ${settingWriters(head).map(([k, w]) => `${id(k)} by ${w.map(id).join(", ")}`).join("; ") || "none yet"}` : ""})` : ""}`);
  // A setting's writers (settings.<key>.writers: roles whose agents may file changes to it, kernel.settings): a role added is
  // the owner's; the rest of a setting (its default, doc, values) hands out nothing.
  const was = new Map(settingWriters(b));
  for (const [k, w] of settingWriters(head)) {
    const more = w.filter((r) => !(was.get(k) ?? []).includes(r));
    if (more.length) owner(`lets roles ${more.map(id).join(", ")} write setting ${id(k)}`);
    // Its owner rules (settings.<key>.owner) are what an agent's change may not do alone: any change to them is the owner's.
    if (!eq(map(map(b.settings)[k]).owner, map(map(head.settings)[k]).owner)) owner(`changes what agents may change in setting ${id(k)} without the owner`);
  }
  // Each fact type it may record (POST /v1/facts) is a claim on the shared log Flow's views and deploy checks read: the reviewer's.
  const [bf, hf] = [map(b.facts), map(head.facts)];
  for (const t of keys(hf).filter((t) => !(t in bf))) review(`declares fact ${id(t)}`);
  if (keys(hf).every((t) => t in bf) && !eq(bf, hf)) review("changes its fact declarations");
  // A default grant hands its tools to every agent its tests match: any change to them is the owner's.
  if (!eq(b.default_grants ?? [], head.default_grants ?? [])) owner("changes its default grants (tools every matching agent gets)");

  const [bc, hc] = [map(b.connections), map(head.connections)];
  for (const c of keys(hc)) {
    const [was, now] = [map(bc[c]), map(hc[c])];
    if (!(c in bc)) review(`adds connection ${id(c)}`);
    const tools = (x: Dict, ...tags: string[]) => tags.flatMap((t) => list(map(x.tools)[t]).map(String));
    for (const t of tools(now, "write", "destructive").filter((t) => !tools(was, "write", "destructive").includes(t))) owner(`connection ${id(c)}: adds write tool ${id(t)}`);
    for (const t of tools(now, "read").filter((t) => !tools(was, "read", "write", "destructive").includes(t))) review(`connection ${id(c)}: adds read tool ${id(t)}`);
    for (const t of tools(now, "unreviewed").filter((t) => !tools(was, "unreviewed").includes(t))) owner(`connection ${id(c)}: ${id(t)} skips the AI reviewer`);
    // A retag widens every grant that names its tag: a write tool tagged read reaches `read` grants, a destructive one tagged
    // write reaches `write` grants. Any tag change of an existing tool is the owner's.
    const tagOf = (x: Dict, t: string) => ["destructive", "write", "read"].find((g) => tools(x, g).includes(t));
    for (const t of tools(was, "read", "write", "destructive")) {
      const [from, to] = [tagOf(was, t), tagOf(now, t)];
      if (to && from !== to) owner(`connection ${id(c)}: retags ${id(t)} from ${from} to ${to}`);
    }
    if (now.returns === "trusted" && was.returns !== "trusted") owner(`connection ${id(c)}: returns trusted (no fencing)`);
    if (now.model_as_caller === true && was.model_as_caller !== true) owner(`connection ${id(c)}: model_as_caller`);
    if (c in bc && keys(was, now).some((f) => !["tools", "returns", "model_as_caller", "guide", "setup", "health_probes"].includes(f) && !eq(was[f], now[f]))) review(`connection ${id(c)}: changes its endpoint or settings`);
  }

  // Services: what they may reach (network, mounts, user, a published port, another module's network) is the owner's.
  const [bs, hs] = [map(b.services), map(head.services)];
  const [brun, hrun] = [map(bs.run), map(hs.run)];
  for (const s of keys(hrun)) {
    const [was, now] = [map(brun[s]), map(hrun[s])];
    const at = `service ${id(s)}`;
    if (!(s in brun)) review(`adds ${at}`);
    if (now.user === "image" && was.user !== "image") owner(`${at}: runs as the image's user`);
    if (now.read_only === false && was.read_only !== false) owner(`${at}: writable root filesystem`);
    if (now.egress === true && was.egress !== true) owner(`${at}: outbound network`);
    if (now.ui_port != null && !eq(now.ui_port, was.ui_port)) owner(`${at}: publishes ui_port ${id(now.ui_port)}`);
    if (now.state != null && !eq(now.state, was.state)) owner(`${at}: mounts its vault dir`);
    for (const j of added(was.join, now.join)) owner(`${at}: joins ${id(j)}'s network`);
    for (const l of added(was.links, now.links)) owner(`${at}: links ${id(l)}`);
    for (const m of added(was.host_mounts, now.host_mounts)) owner(`${at}: host mount ${id(String(m).split(":")[0])}`);
    // The job workspaces (they need privileged git-credential) are the owner's; its own points file
    // (config/points/<module>.json, read-only: what modules contributed to the points it defines) the reviewer's.
    if (now.workspaces != null && !eq(now.workspaces, was.workspaces)) owner(`${at}: job workspaces read-only`);
    if (now.points != null && !eq(now.points, was.points)) review(`${at}: reads its points file`);
    for (const d of added(was.data, now.data)) (String(d).endsWith(":ro") ? review : owner)(`${at}: data ${id(String(d).split(":")[0])}${String(d).endsWith(":ro") ? " read-only" : " read-write"}`);
    for (const f of keys(was, now)) {
      if (eq(was[f], now[f]) || SERVICE_PLAIN.has(f) || ["user", "read_only", "egress", "ui_port", "state", "join", "links", "host_mounts", "data", "workspaces", "points"].includes(f)) continue;
      owner(`${at}: unrecognised field ${id(f)}`);
    }
    if (s in brun && keys(was, now).some((f) => SERVICE_PLAIN.has(f) && !eq(was[f], now[f]))) review(`${at}: changes its image, command, env or limits`);
  }
  if (hs.data === true && bs.data !== true) review("gets a data dir");
  const [bg, hg] = [map(bs.grants), map(hs.grants)];
  for (const c of keys(hg)) if (widerGrant(bg[c], hg[c])) owner(`services.grants: writes or reads more of ${id(c)}`);
  const share = (x: Dict) => list(map(x.workspaces).share_with).concat(list(map(map(x.services).workspaces).share_with));
  for (const m of added(share(b), share(head))) owner(`shares its workspace with ${id(m)}`);
  for (const k of keys(hs).filter((k) => !["run", "data", "grants", "workspaces"].includes(k) && !eq(bs[k], hs[k]))) owner(`services: unrecognised key ${id(k)}`);

  if (!eq(b.board_env, head.board_env)) owner("changes the board's environment (board_env)");
  // Isolation: an install is measured from the most restrictive level, so a trusted install says so; agents and apps inherit
  // the module's unless they set their own.
  const iso = (x: unknown) => ISOLATION_RANK[String(x ?? "trusted")] ?? 3;
  const floor = base ? b.isolation : "untrusted";
  if (iso(head.isolation) > iso(floor)) owner(`isolation ${id(head.isolation ?? "trusted")}`);
  const apps = (x: Dict) => new Map(list(x.apps).map((a) => [String(map(a).name), map(a)]));
  const [bap, hap] = [apps(b), apps(head)];
  for (const [n, a] of hap) {
    const was = bap.get(n);
    if (iso(a.isolation ?? head.isolation) > iso(was ? was.isolation ?? b.isolation : base ? head.isolation : "untrusted")) owner(`app ${id(n)}: isolation ${id(a.isolation ?? head.isolation ?? "trusted")}`);
  }

  // Engines: secrets handed to the job as env, and home folders it writes.
  const engines = (x: Dict) => new Map(list(map(x.providers).engine).map((e) => [String(map(e).kind), map(e)]));
  const [be, he] = [engines(b), engines(head)];
  for (const [kind, e] of he) {
    const was = be.get(kind) ?? {};
    for (const s of keys(e.secret_env).filter((k) => !(k in map(was.secret_env)))) owner(`engine ${id(kind)}: secret ${id(s)} as env`);
    for (const r of added(was.rw, e.rw)) owner(`engine ${id(kind)}: writes ${id(r)}`);
    if (!be.has(kind)) review(`adds engine ${id(kind)}`);
  }
  const [bpv, hpv] = [map(b.providers), map(head.providers)];
  for (const k of keys(hpv).filter((k) => k !== "engine" && !eq(bpv[k], hpv[k]))) review(`${k in bpv ? "changes provider" : "provides"} ${id(k)}`);
  // A channel's transport gets the owner's messages and the channel's token from the kernel: the owner's.
  const [bch, hch] = [map(bpv.channel), map(hpv.channel)];
  if (hch.transport != null && !eq(hch.transport, bch.transport)) owner(`channel: the kernel sends the owner's messages and its token to ${id(hch.transport)}`);

  // Agents: a write or destructive grant, a role, an isolation toward trusted, or an unknown field is the owner's.
  // A grant is judged by the highest tag a tool has on either side: a tool that was a write still counts as one when retagged.
  // Another module's connection is judged by its tags on either side of the change (`conns`, moduleInputs); unknown fails closed.
  const tags = (c: string) => {
    const n = c.replace(/\?$/, "");
    const own = isMap(bc[n]) || isMap(hc[n]);
    const [x, y] = own ? [map(map(bc[n]).tools), map(map(hc[n]).tools)] : [map(map(map(conns[n]).base).tools), map(map(map(conns[n]).head).tools)];
    const destructive = [...list(x.destructive), ...list(y.destructive)];
    const write = [...list(x.write), ...list(y.write)].filter((t) => !destructive.includes(t));
    return { read: [...list(x.read), ...list(y.read)].filter((t) => !write.includes(t) && !destructive.includes(t)), write, destructive };
  };
  const known = (c: string) => isMap(hc[c.replace(/\?$/, "")]) || isMap(bc[c.replace(/\?$/, "")]) || isMap(conns[c.replace(/\?$/, "")]);
  const [ba, ha] = [map(b.agents), map(head.agents)];
  for (const key of keys(ha)) {
    const [was, now] = [map(ba[key]), map(ha[key])];
    const at = `agent ${id(key)}`;
    if (!(key in ba)) review(`adds ${at}`);
    const [wg, ng] = [map(was.connections), map(now.connections)];
    for (const c of keys(ng)) {
      const t = known(c) ? tags(c) : undefined;
      if (!widerGrant(wg[c], ng[c], t)) continue;
      const w = writesOf(ng[c], t).filter((x) => !writesOf(wg[c], t).includes(x) && !(wg[c] === "write" && x === "write"));
      (w.length ? owner : review)(`${at}: ${w.length ? "write grant on" : "reads"} ${id(c)}${w.length && w[0] !== "write" ? ` (${w.map(id).join(", ")})` : ""}`);
    }
    for (const r of added(was.roles, now.roles)) owner(`${at}: role ${id(r)}`);
    const eff = (a: Dict, m: Dict) => a.isolation ?? m.isolation;
    if (iso(eff(now, head)) > iso(key in ba ? eff(was, b) : base ? head.isolation : "untrusted")) owner(`${at}: isolation ${id(eff(now, head) ?? "trusted")}`);
    // Its profile decides the tools, writes and computer its jobs get (admission.ts): any but check (none of them) is the
    // owner's.
    const profile = (x: Dict) => String(x.profile ?? "crew");
    if (profile(now) !== profile(was) && profile(now) !== "check") owner(`${at}: profile ${id(profile(now))} (the tools, writes and computer its jobs get)`);
    else if (profile(now) !== profile(was)) review(`${at}: profile check (its jobs get no tools or writes)`);
    for (const f of keys(was, now).filter((f) => !eq(was[f], now[f]) && !AGENT_PLAIN.has(f) && !["connections", "roles", "isolation", "profile"].includes(f))) owner(`${at}: unrecognised field ${id(f)}`);
  }
  if (base) for (const k of [...PLAIN].filter((k) => !eq(b[k], head[k]) && k !== "name")) review(`changes ${id(k)}`);
  if (codeChanged) review("code changes");
  if (!changes.length) review("text only");
  return { module: name, changes, code: codeChanged, ...(official ? { official: true as const } : {}) };
}

export type Classified = { tier: 1 | 2; rule: "module-authority" | "module-config"; reason: string };

/**
 * The tier of a set of module changes (the AI reviewer's either way): 2 when any change is new authority, its lines first in
 * the reason (`ownerOnly` ones first of all).
 */
export function classifyModules(diffs: ModuleDiff[]): Classified {
  const lines = (only: boolean) => diffs.flatMap((d) => d.changes.filter((c) => c.owner && Boolean(c.ownerOnly) === only).map((c) => `${d.module}: ${c.what}`));
  const owners = [...lines(true), ...lines(false)];
  const all = owners.length ? owners : diffs.map((d) => `${d.module}: ${d.changes.map((c) => c.what).join(", ")}`);
  const reason = `${owners.length ? "new module authority" : "module changes without new authority"}: ${all.slice(0, 8).join("; ")}${all.length > 8 ? `; and ${all.length - 8} more` : ""}`;
  return owners.length ? { tier: 2, rule: "module-authority", reason } : { tier: 1, rule: "module-config", reason };
}

/** One line per change, as the apply log and the card show it: `<module>: <change> (owner|review)`. */
export const authorityLines = (diffs: ModuleDiff[]) => diffs.flatMap((d) => d.changes.map((c) => `${d.module}: ${c.what} (${c.owner ? "owner" : "review"})`));

/** A module entry in instance.yaml `modules:` (`name`, `name@marketplace` or `{ id }`), as a module name. */
export const moduleName = (m: unknown) => String(isMap(m) ? m.id : m).split("@")[0]!;

/**
 * The listed modules' names as these manifests know them. A module folded into another says so in its module.yaml
 * (`replaces`): a listed name no manifest has becomes its replacement, so an instance written for an older product runs on a
 * newer one with no rewrite of instance.yaml (no updater and no apply writes it).
 */
export function current(listed: unknown[], defs: Record<string, ModuleDef>): string[] {
  const replacement = (n: string) => Object.keys(defs).find((d) => list(defs[d]!.replaces).map(String).includes(n)) ?? n;
  return [...new Set(listed.map(moduleName).map((n) => (n in defs ? n : replacement(n))))];
}

/**
 * Enabled modules: `always` (the default module), the instance's `modules:` and every `requires` they name, closed over. A
 * virtual name (one some module `provides`) never enables a module: the provider is listed itself (spec §5.7.1).
 */
export function enabledModules(instance: Dict, defs: Record<string, ModuleDef>, always: string[] = []): string[] {
  const virtual = new Set(Object.values(defs).flatMap((d) => list(d.provides).map(String)));
  const out = new Set<string>();
  const visit = (n: string) => {
    if (out.has(n) || !defs[n]) return;
    out.add(n);
    for (const r of list(defs[n]!.requires).map(String)) if (!virtual.has(r)) visit(r);
  };
  for (const n of [...always, ...current(list(instance.modules), defs)]) visit(n);
  return [...out].sort();
}

/**
 * The module side of an apply: for each module enabled before or after, or whose folder changed, its def on each side it is
 * enabled on and whether code (anything but module.yaml and Markdown) changed. `replacing` lists each A that B `replaces` and
 * this very change stops running (spec §5.7.1); its def only when B is A's one enabled successor (successor.ts heir) and both
 * are official (A at the old commit, B at the new): then B is diffed against A's authority too, else the claim is the owner's.
 */
export function moduleInputs(a: { baseInstance: Dict; headInstance: Dict; baseDefs: Record<string, ModuleDef>; headDefs: Record<string, ModuleDef>; changed: string[]; always?: string[]; origins?: { base: Record<string, string>; head: Record<string, string> }; official?: { base: string[]; head: string[] } }): Record<string, ModuleInput> {
  const before = new Set(enabledModules(a.baseInstance, a.baseDefs, a.always));
  const after = new Set(enabledModules(a.headInstance, a.headDefs, a.always));
  const files = (m: string) => a.changed.filter((f) => f.startsWith(`modules/${m}/`));
  // Every connection's tags on each side, so an agent's grant on another module's connection is judged by them.
  const tagsOf = (defs: Record<string, ModuleDef>) => Object.fromEntries(Object.values(defs).flatMap((d) => Object.entries(map(d?.connections))));
  const [bt, ht] = [tagsOf(a.baseDefs), tagsOf(a.headDefs)];
  const conns = Object.fromEntries(keys(bt, ht).map((c) => [c, { base: bt[c], head: ht[c] }]));
  const staged = [...after].map((n) => ({ name: n, enabled: true, replaces: list(a.headDefs[n]?.replaces).map(String) }));
  const out: Record<string, ModuleInput> = {};
  for (const m of [...new Set([...before, ...after])].sort()) {
    const fs = files(m);
    const base = before.has(m) ? a.baseDefs[m] : undefined;
    const head = after.has(m) ? a.headDefs[m] : undefined;
    const from = head ? list(head.replaces).map(String).filter((r) => before.has(r) && !after.has(r) && a.baseDefs[r]) : [];
    if (!from.length && !fs.length && before.has(m) === after.has(m) && eq(base, head) && a.origins?.base[m] === a.origins?.head[m]) continue;
    const input: ModuleInput = { base, head, codeChanged: Boolean(head) && fs.some((f) => f !== `modules/${m}/module.yaml` && !f.endsWith(".md")), textChanged: fs.length > 0, conns };
    // Official on the side it comes from now (base for a removal).
    if ((head ? a.official?.head : a.official?.base)?.includes(m)) input.official = true;
    const origin = { base: base && a.origins?.base[m], head: head && a.origins?.head[m] };
    if (origin.base || origin.head) input.origin = origin;
    const heirOf = (r: string) => heir(staged, r) === m && a.official?.base.includes(r) && a.official.head.includes(m);
    if (from.length) input.replacing = from.map((r) => (heirOf(r) ? { name: r, def: a.baseDefs[r]! } : { name: r }));
    out[m] = input;
  }
  // A replaced module is not also removed on its own: its authority is B's diff.
  for (const i of Object.values(out)) for (const r of i.replacing ?? []) if (r.def) delete out[r.name];
  return out;
}

/** The authority diff of every module input. */
export const diffAll = (inputs: Record<string, ModuleInput>) => Object.entries(inputs).map(([m, i]) => authorityDiff(m, i.base, i.head, i.codeChanged, i.replacing, i.origin, i.conns, i.official === true));

/**
 * Module defs as an instance runs them: each agent's `overrides.agents.<key>.connections` merged per connection over its
 * module's grants (a key replaces the module's `key?` too), as the compiler does before resolving grants. So a grants
 * override is diffed by authorityDiff like any module grant change. An override on an agent no module defines is refused.
 */
export function withGrantOverrides(defs: Record<string, ModuleDef>, instance: Dict): Record<string, ModuleDef> {
  const out = { ...defs };
  // The module the compiler takes the agent from: one enabled on this side (two defining it don't compile).
  const enabled = enabledModules(instance, defs);
  for (const [key, o] of Object.entries(map(map(instance.overrides).agents))) {
    if (map(o).connections == null) continue;
    if (!isMap(map(o).connections)) throw new Error(`overrides.agents.${key}.connections must be a map`);
    const found = enabled.filter((n) => isMap(map(out[n]?.agents)[key]));
    if (found.length !== 1) throw new Error(`overrides.agents.${key}.connections: ${found.length ? `modules ${found.join(", ")} all define` : "no enabled module defines"} agent ${key}`);
    const m = found[0]!;
    const def = out[m]!;
    const a = map(map(def.agents)[key]);
    const conns = { ...map(a.connections) };
    for (const [c, g] of Object.entries(map(map(o).connections))) {
      delete conns[`${c}?`];
      conns[c] = g;
    }
    out[m] = { ...def, agents: { ...map(def.agents), [key]: { ...a, connections: conns } } };
  }
  return out;
}

/** The connections overrides of every agent, as one comparable value. */
export const grantOverrides = (instance: Dict) => Object.fromEntries(Object.entries(map(map(instance.overrides).agents)).filter(([, o]) => map(o).connections != null).map(([k, o]) => [k, map(o).connections]));

/**
 * instance.yaml `marketplaces:` changes (spec §5.7, §6.4): a new marketplace, or one moved to another repository or folder,
 * is where code comes from, so the owner's; a sha bump is only the AI reviewer's here, its modules' own diffs carry their
 * authority; a removal is the reviewer's (compile refuses one whose modules are still listed). The official `aidenhq`
 * marketplace moving between the product's ./modules and the official repository, or along it, is no line of its own: its
 * modules' diffs (by folder tree id, sources.ts officialSides) carry every change; pointed anywhere else, it is the owner's.
 */
export function marketplaceChanges(base: Dict, head: Dict): ModuleDiff[] {
  const [b, h] = [marketplacesOf(base), marketplacesOf(head)].map((l) => new Map(l.map((m) => [m.name, m.at])));
  const changes: Change[] = [];
  const at = (w: { url: string; path: string; sha: string }) => `${id(w.url)}${w.path ? `:${id(w.path)}` : ""} at ${w.sha.slice(0, 12)}`;
  const [ob, oh] = [b!.get(OFFICIAL), h!.get(OFFICIAL)];
  if (oh && (oh.url !== OFFICIAL_URL || oh.path) && (ob?.url !== oh.url || ob?.path !== oh.path)) changes.push({ what: `moves marketplace ${OFFICIAL} to ${at(oh)}`, owner: true, ownerOnly: true });
  [b!, h!].forEach((m) => m.delete(OFFICIAL));
  for (const [n, w] of h!) {
    const was = b!.get(n);
    if (!was) changes.push({ what: `adds marketplace ${id(n)} (${at(w)})`, owner: true, ownerOnly: true });
    else if (was.url !== w.url || was.path !== w.path) changes.push({ what: `moves marketplace ${id(n)} to ${at(w)}`, owner: true, ownerOnly: true });
    else if (was.sha !== w.sha) changes.push({ what: `marketplace ${id(n)} moves to ${w.sha.slice(0, 12)}`, owner: false });
  }
  for (const n of b!.keys()) if (!h!.has(n)) changes.push({ what: `removes marketplace ${id(n)}`, owner: false });
  return changes.length ? [{ module: "marketplaces", changes, code: false }] : [];
}

/**
 * instance.yaml fork changes (spec §6.9b): entering a fork, or moving one to another repository or sha, is new code
 * provenance, so the owner's (as a new marketplace); leaving one returns to official code, the reviewer's ("fork →
 * official"); a changed branch or upstream_pr alone is the reviewer's. Read from both instance.yaml sides, so a fork whose
 * code reads as unchanged still has its line.
 */
export function forkChanges(base: Dict, head: Dict): ModuleDiff[] {
  const [b, h] = [forksOf(base), forksOf(head)];
  const out: ModuleDiff[] = [];
  const add = (module: string, what: string, owner: boolean) => out.push({ module, changes: [{ what, owner, ...(owner ? { ownerOnly: true as const } : {}) }], code: false });
  const at = (k: (typeof h)[number]) => `${id(k.at.url)} at ${k.at.sha.slice(0, 12)}`;
  for (const k of h) {
    const was = b.find((x) => x.target === k.target);
    if (!was) add(k.target, `runs fork ${at(k)} (tier no longer official)`, true);
    else if (was.at.url !== k.at.url || was.at.sha !== k.at.sha) add(k.target, `fork moves to ${at(k)}`, true);
    else if (was.branch !== k.branch || was.upstream_pr !== k.upstream_pr) add(k.target, "fork branch or upstream_pr changes", false);
  }
  for (const k of b) if (!h.some((x) => x.target === k.target)) add(k.target, "fork → official", false);
  return out;
}
