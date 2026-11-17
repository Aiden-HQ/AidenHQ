// Gate modes. A new gate that isn't a security gate ships in observe mode. While it observes, a refusal becomes a
// `gate.would_block` event (kernel.db's events table, with a log line) and the action goes ahead. Once its would-block
// entries have been reviewed and the false ones fixed, it is promoted to enforce. A gate with no mode enforces.
// Security gates enforce from day one and refuse observe: that covers secrets, outbound sends, merges and pushes without
// approval, and credential scoping.

export type GateMode = "observe" | "enforce";

/** Gate ids that never observe: `<module>.<check id>` for a module's check. */
export const SECURITY_GATES = new Set(["platform.product-gate"]);

/** A gate's mode: enforce when unset. Throws on an unknown mode, or on observe for a security gate. */
export function gateMode(id: string, mode: unknown): GateMode {
  if (mode == null || mode === "enforce") return "enforce";
  if (mode !== "observe") throw new Error(`gate ${id}: mode is observe or enforce`);
  if (SECURITY_GATES.has(id)) throw new Error(`gate ${id} is a security gate: it always enforces`);
  return "observe";
}
