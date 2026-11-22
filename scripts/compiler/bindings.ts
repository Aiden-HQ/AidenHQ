// Virtual capabilities, conflicts and the binding table (spec §3.7, §5.7.1): dependents name a capability (`requires:
// [engine]`), implementations `provides` it, and a single-provider capability adds `conflicts` on the same name. An apply
// that leaves any binding dangling is refused, so a replace (B `replaces` A) or a remove can never strand an agent's engine,
// a grant, a role or a dependency. Pure: the compiler passes the enabled modules' manifests.

type Dict = Record<string, unknown>;
export type ModuleDef = Dict;
export type InstanceDef = { reviewer?: unknown; writes?: unknown };
export type Dangling = { binding: string; owner: string; missing: string };

const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const map = (v: unknown): Dict => (isMap(v) ? v : {});
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const strs = (v: unknown) => list(v).map((x) => String(isMap(x) ? x.id ?? x.name : x));

/** Names no module may take: the kernel's own and the provider slots. */
export const RESERVED = /^(kernel|aidenhq(-.*)?|engine|executor|reviewer|channel)$/;
const CAPABILITY = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/;
/** A slot capability needs the matching provider entry. */
const SLOTS = ["engine", "reviewer", "channel"];

/** Problems in the marketplace's manifests themselves: reserved names, the `provides` grammar, slots, name clashes. */
export function capabilityProblems(all: Record<string, ModuleDef>): string[] {
  const p: string[] = [];
  for (const [name, def] of Object.entries(all)) {
    if (RESERVED.test(name)) p.push(`module ${name}: the name is reserved`);
    for (const c of strs(def.provides)) {
      if (!CAPABILITY.test(c)) p.push(`module ${name}: provides ${c} is not a capability name (a-z, 0-9, -, optionally :<variant>)`);
      else if (Object.hasOwn(all, c)) p.push(`module ${name}: provides ${c}, which is a module's name`);
      else if (SLOTS.includes(c.split(":")[0]!) && !map(def.providers)[c.split(":")[0]!]) p.push(`module ${name}: provides ${c} without a providers.${c.split(":")[0]} entry`);
    }
    for (const r of strs(def.replaces)) if (r === name) p.push(`module ${name}: replaces itself`);
  }
  return p;
}

/** Each virtual capability and the enabled modules that provide it. */
export function virtualProviders(enabled: Record<string, ModuleDef>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, def] of Object.entries(enabled)) for (const c of strs(def.provides)) (out[c] = Object.hasOwn(out, c) ? out[c]! : []).push(name);
  return out;
}

/** Enabled modules that may not sit beside each other: by module name, or by a capability another module provides. */
export function conflictProblems(enabled: Record<string, ModuleDef>): string[] {
  const providers = virtualProviders(enabled);
  const p: string[] = [];
  for (const [name, def] of Object.entries(enabled)) {
    for (const c of strs(def.conflicts)) {
      if (c !== name && Object.hasOwn(enabled, c)) p.push(`module ${name} conflicts with module ${c}`);
      for (const other of (Object.hasOwn(providers, c) ? providers[c]! : []).filter((o) => o !== name)) p.push(`module ${name} conflicts with ${c}, which ${other} also provides`);
    }
  }
  return p;
}

/** Every binding that names something no enabled module declares (spec §5.7.1's table). Empty is required to apply. */
export function danglingBindings(enabled: Record<string, ModuleDef>, instance: InstanceDef): Dangling[] {
  const out: Dangling[] = [];
  const all = Object.values(enabled);
  const engines = new Set(all.flatMap((d) => list(map(d.providers).engine).map((e) => String(map(e).kind))));
  const connections = new Set(all.flatMap((d) => Object.keys(map(d.connections))));
  const jobcaps = new Set(all.flatMap((d) => list(d.jobcaps).map((j) => String(map(j).id))));
  const roles = new Set(all.flatMap((d) => strs(map(d.roles).declares)));
  const kinds = new Set(Object.entries(enabled).flatMap(([n, d]) => Object.keys(map(d.writes)).map((k) => (k.includes(".") ? k : `${n}.${k}`))));
  const providers = virtualProviders(enabled);
  const add = (binding: string, owner: string, missing: string) => out.push({ binding, owner, missing });
  // A role needs the module that declares it (roles.declares); kernel.* are the kernel's. `id?` (an agent's role or a request) is
  // optional: held only while its module is enabled.
  const role = (r: string) => r.startsWith("kernel.") || roles.has(r);

  const agents: [string, Dict][] = Object.values(enabled).flatMap((d) => Object.entries(map(d.agents))).map(([k, a]) => [k, map(a)]);
  for (const [key, a] of agents) {
    if (a.engine != null && !engines.has(String(a.engine))) add("agent engine", `agent ${key}`, `engine ${a.engine}`);
    for (const c of Object.keys(map(a.connections))) if (!c.endsWith("?") && !connections.has(c)) add("agent connections", `agent ${key}`, `connection ${c}`);
    for (const j of strs(a.jobcaps)) if (!j.endsWith("?") && !jobcaps.has(j)) add("agent jobcaps", `agent ${key}`, `jobcap ${j}`);
    for (const r of strs(a.roles)) if (!r.endsWith("?") && !role(r)) add("agent roles", `agent ${key}`, `role ${r}`);
  }
  for (const [name, def] of Object.entries(enabled)) {
    for (const r of strs(map(def.roles).requests)) if (!r.endsWith("?") && !role(r)) add("roles.requests", `module ${name}`, `role ${r}`);
    const services = map(def.services);
    for (const c of Object.keys(map(services.grants))) if (!connections.has(c)) add("services.grants", `module ${name}`, `connection ${c}`);
    for (const svc of Object.values(map(services.run))) for (const j of strs(map(svc).join)) if (!Object.hasOwn(enabled, j)) add("services.run.join", `module ${name}`, `module ${j}`);
    for (const m of [...strs(map(def.workspaces).share_with), ...strs(map(services.workspaces).share_with)]) if (!Object.hasOwn(enabled, m)) add("workspaces.share_with", `module ${name}`, `module ${m}`);
    for (const r of strs(def.requires)) if (!Object.hasOwn(enabled, r) && !(Object.hasOwn(providers, r) && providers[r]!.length)) add("requires", `module ${name}`, r);
  }
  const reviewer = map(instance.reviewer);
  for (const k of ["primary", "panel"]) {
    const m = reviewer[k];
    if (m != null && !map(map(enabled[String(m)]).providers).reviewer) add("instance reviewer", `instance reviewer.${k}`, `module ${m} with a reviewer provider`);
  }
  for (const k of Object.keys(map(instance.writes))) if (!kinds.has(k)) add("instance writes", "instance writes", `write kind ${k}`);
  return out;
}
