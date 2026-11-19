// Where a removed module's claimed record goes on an apply: the staged module that alone lists it in `replaces`, and only when
// that module's own registry defines the kind (`<successor>.<action>`). Anything else is not carried (reconcile closes it as unknown).
import type { Kind } from "./writes.ts";

export type Entry = { name: string; enabled?: boolean; replaces?: string[] };

export function carryTarget(staged: Entry[], registry: Record<string, Kind>, removed: string, kind: string): { kind: string; module: string; executor: { module: string; url?: string; rev?: string } } | undefined {
  const heirs = staged.filter((n) => n.enabled && n.replaces?.includes(removed));
  if (heirs.length !== 1 || !kind.startsWith(`${removed}.`)) return undefined;
  const module = heirs[0]!.name;
  const to = `${module}${kind.slice(removed.length)}`;
  const k = registry[to];
  if (!k || k.module !== module) return undefined;
  return { kind: to, module, executor: { module, ...(k.executor?.url ? { url: k.executor.url } : {}), ...(k.executor?.rev ? { rev: k.executor.rev } : {}) } };
}
