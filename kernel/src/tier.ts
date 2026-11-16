// K5, the tier formula (spec §5.1): every term raises, none lowers. Tier 0 runs at once (still a record), Tier 1 is the
// reviewer's, Tier 2 the owner's after the reviewer. Pure.
export type Tier = 0 | 1 | 2;
export type Autonomy = "off" | "tier0" | "full";
export type Raise = { tier: 1 | 2; panel?: boolean; reason?: string; rule?: string };

export function computeTier({ floor, instanceFloor = 0, raise, checkRaises = [], priorVeto = false, autonomy, routineCap, panel = false }: {
  floor: Tier; instanceFloor?: Tier; raise?: Raise; checkRaises?: Raise[]; priorVeto?: boolean; autonomy?: Autonomy; routineCap?: Autonomy; panel?: boolean;
}): { tier: Tier; panel: boolean } {
  let tier = Math.max(floor, instanceFloor, raise?.tier ?? 0, ...checkRaises.map((r) => r.tier), priorVeto ? 2 : 0) as Tier;
  // off and tier0 lift a reviewed write to the owner (the reviewer still goes first). A Tier 0 write stays Tier 0: the
  // direct tools of today keep running whatever the setting.
  for (const cap of [autonomy, routineCap]) if (tier === 1 && cap && cap !== "full") tier = 2;
  return { tier, panel: panel || raise?.panel === true || checkRaises.some((r) => r.panel === true) };
}
