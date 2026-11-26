// The Modules tab and a module's page: the compiled catalog (config/modules.json, scripts/modules.ts) with how each module is on.
import type { SettingDef } from "./settings.js";
export type ModuleState = "core" | "on" | "dependency" | "off";

interface CatalogEntry {
  name: string;
  description: string;
  enabled: boolean;
  /** Listed in instance.yaml `modules` (an enabled module that isn't chosen is there as a dependency). */
  chosen?: boolean;
  requires: string[];
  agents: string[];
  routines?: string[];
  connections?: string[];
  apps?: string[];
  settings?: Record<string, SettingDef>;
  revision?: string;
  source?: { url: string; path: string };
  setup?: string;
  /** The sha instance.yaml pins this module at (`modules: [{ name, sha }]`), when it does. */
  pinned?: string | null;
  /** What it may write (kind and tier) and the secrets it needs, where the compile records them. */
  writes?: Record<string, { floor: number; panel?: boolean }>;
  secrets?: string[];
  /** Its handbook sections (id and file) and the start of its README. */
  prompts?: { id: string; file: string }[];
  readme?: string;
  /** Where it comes from and its computed tier (spec §6.5: declared or official). */
  marketplace?: string;
  tier?: string;
  /** A third-party listing the instance doesn't install (compile's browse): shown as Available, turned on by its `id`. */
  browse?: boolean;
}

/** How a module change names a catalog module (D1): `name`, or `name@marketplace` for a third-party one. */
export const moduleId = (m: { name: string; marketplace?: string }) => (m.marketplace && m.marketplace !== "aidenhq" && m.marketplace !== "local" ? `${m.name}@${m.marketplace}` : m.name);

export function moduleStates(catalogJson: string) {
  const catalog = JSON.parse(catalogJson) as CatalogEntry[];
  return catalog.map((m) => ({
    name: m.name,
    id: moduleId(m),
    browse: Boolean(m.browse),
    description: m.description,
    agents: m.agents,
    requires: m.requires,
    /** The enabled modules that need this one (why a dependency is on). */
    neededBy: catalog.filter((o) => o.enabled && o.requires.includes(m.name)).map((o) => o.name),
    marketplace: m.marketplace ?? "aidenhq",
    tier: m.tier ?? "official",
    state: (m.name === "kernel" ? "core" : !m.enabled ? "off" : m.chosen ? "on" : "dependency") as ModuleState,
    connections: m.connections ?? [],
    routines: m.routines ?? [],
    apps: m.apps ?? [],
    settings: m.settings ?? {},
    revision: m.revision?.slice(0, 7) ?? null,
    pinned: m.pinned ? m.pinned.slice(0, 7) : null,
    source: m.source ?? null,
    setup: m.setup ?? null,
  }));
}

export type ModuleRow = ReturnType<typeof moduleStates>[number];

/** What a module may do, as far as the catalog says: its connections, the write kinds it declares and its secrets. */
export function moduleAuthority(catalogJson: string, row: { name: string; browse: boolean }) {
  // A browse listing declares nothing yet (it is read for browsing only); never the same-named installed module's.
  const m = row.browse ? undefined : (JSON.parse(catalogJson) as CatalogEntry[]).find((e) => e.name === row.name && !e.browse);
  return {
    connections: m?.connections ?? [],
    writes: Object.entries(m?.writes ?? {}).map(([kind, w]) => ({ kind, tier: w.floor, ...(w.panel ? { panel: true } : {}) })),
    secrets: m?.secrets ?? [],
    prompts: m?.prompts ?? [],
    readme: m?.readme ?? null,
  };
}
