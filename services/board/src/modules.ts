// Settings > Modules rows: the compiled catalog (config/modules.json, scripts/modules.mjs) with how each module is on.
export type ModuleState = "core" | "on" | "dependency" | "off";

interface CatalogEntry {
  name: string;
  description: string;
  enabled: boolean;
  /** Listed in instance.yaml `modules` (an enabled module that isn't chosen is there as a dependency). */
  chosen?: boolean;
  requires: string[];
  agents: string[];
  /** Where it comes from and its computed tier (spec §6.5: declared, conformant or official). */
  marketplace?: string;
  tier?: string;
}

export function moduleStates(catalogJson: string) {
  return (JSON.parse(catalogJson) as CatalogEntry[]).map((m) => ({
    name: m.name,
    description: m.description,
    agents: m.agents,
    requires: m.requires,
    marketplace: m.marketplace ?? "aidenhq",
    tier: m.tier ?? "official",
    state: (m.name === "core" ? "core" : !m.enabled ? "off" : m.chosen ? "on" : "dependency") as ModuleState,
  }));
}
