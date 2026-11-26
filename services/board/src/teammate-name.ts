// A teammate's name (its default in the module, or the owner's rename: overrides.agents.<key>.name): one rule for the
// compiler (scripts/modules.ts), the board's settings change and the kernel's (a synced copy, scripts/sync-shared.ts).
// The name must be addressable: chat's @name (services/board/src/chats.ts norm) and the task tools match every agent by
// name or key, so it may not collide with any other agent's, hidden ones included. A task comment's @handle is the name
// without its spaces (services/board/src/crew.ts mentionedAgents): letters, digits and - only, and unique too.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// One space between words: chat's @name parser takes a single separator.
const SHAPE = /^[A-Za-z][A-Za-z0-9 -]{0,23}$/;
const handle = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Why `name` can't be agent `key`'s name among `agents` (every compiled agent), or undefined when it can. */
export function teammateNameProblem(name: unknown, key: string, agents: Record<string, { name: string }>): string | undefined {
  if (typeof name !== "string" || !SHAPE.test(name) || name.trim() !== name || name.includes("  ") || name.split(" ").length > 4) return "a name is 1 to 24 letters, digits, spaces or -, at most 4 words";
  const n = norm(name);
  const h = handle(name);
  for (const [k, a] of Object.entries(agents)) {
    if (k === key) continue;
    if (norm(String(a.name ?? "")) === n || handle(String(a.name ?? "")) === h) return `${name} is already an agent's name`;
    if (norm(k) === n) return `${n} is an agent's key`;
  }
  return undefined;
}
