// The tools a handbook names: backticked words (`task_create`, or `task_create(...)` with arguments) that are a tool of
// some connection. One parser for every check that compares handbooks with grants (scripts/agent-check.mjs).

/** tool name → the connections that offer it, from the compiled config's mcp_servers ({ tools: { read, write } }). */
export function knownTools(mcpServers = {}) {
  const known = new Map();
  for (const [server, c] of Object.entries(mcpServers)) {
    for (const t of [...(c.tools?.read ?? []), ...(c.tools?.write ?? [])]) known.set(t, [...(known.get(t) ?? []), server]);
  }
  return known;
}

/** The known tools a text names in backticks, in order of first mention. */
export function namedTools(text, known) {
  const found = new Set();
  for (const m of String(text ?? "").matchAll(/`([a-z][a-z0-9_]*)(?:\([^`]*\))?`/g)) if (known.has(m[1])) found.add(m[1]);
  return [...found];
}
