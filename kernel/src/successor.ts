// Where a removed module's claimed record goes on an apply: the staged module that alone lists it in `replaces`, and only when
// that module's own registry defines the kind (`<successor>.<action>`). Anything else is not carried (reconcile closes it as unknown).
import type { Kind } from "./writes.ts";

export type Entry = { name: string; enabled?: boolean; replaces?: string[] };

/** The one enabled staged module that lists `removed` in `replaces`; none, or two, is no successor. */
export function heir(staged: Entry[], removed: string): string | undefined {
  const heirs = staged.filter((n) => n.enabled && n.replaces?.includes(removed));
  return heirs.length === 1 ? heirs[0]!.name : undefined;
}

export function carryTarget(staged: Entry[], registry: Record<string, Kind>, removed: string, kind: string): { kind: string; module: string; executor: { module: string; url?: string; rev?: string } } | undefined {
  const module = heir(staged, removed);
  if (!module || !kind.startsWith(`${removed}.`)) return undefined;
  const to = `${module}${kind.slice(removed.length)}`;
  const k = registry[to];
  if (!k || k.module !== module) return undefined;
  return { kind: to, module, executor: { module, ...(k.executor?.url ? { url: k.executor.url } : {}), ...(k.executor?.rev ? { rev: k.executor.rev } : {}) } };
}
