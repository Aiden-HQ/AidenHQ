// Quality checks (docs/design/agent-coach.md): an app's /api/health may return `checks: [{name, ok, count, sample}]`, rules about
// its own data it can evaluate (e.g. "every ETA has a source"). They are findings, never availability: health stays the HTTP
// status alone, so bad data never opens an incident or rolls a deploy back. The board's detector raises failing ones as
// quality:<app>:<check> for Fleet Ops to route to the app's owner. Everything here is app-authored data, bounded.

/**
 * The probe, run with node inside a one-shot container on the app's network: exit 0 when the status is under 400 (healthy),
 * else 1, exactly as before; on success it prints the body's `checks` (or null) for parseChecks.
 */
export const PROBE =
  "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{if(r.status>=400)process.exit(1);let c=null;try{const j=JSON.parse((await r.text()).slice(0,200000));c=j&&j.checks!==undefined?j.checks:null}catch{}process.stdout.write(JSON.stringify(c)??'null',()=>process.exit(0))}).catch(()=>process.exit(1))";

export const MAX_CHECKS = 20;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

export interface Check { name: string; ok: boolean; count: number | null; sample: string | null }
/** none: the app has no checks; ok: they evaluated (some may fail); unknown: they couldn't be read or evaluated. */
export type Quality = { state: "none" } | { state: "ok"; checks: Check[] } | { state: "unknown"; why: string };

/** The probe's stdout → the app's checks. Anything malformed (or a check that couldn't evaluate, ok not a boolean) is unknown. */
export function parseChecks(stdout: string): Quality {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || "null");
  } catch {
    return { state: "unknown", why: "the probe's output wasn't JSON" };
  }
  if (raw === null) return { state: "none" };
  if (!Array.isArray(raw)) return { state: "unknown", why: "checks is not a list" };
  if (raw.length > MAX_CHECKS) return { state: "unknown", why: `more than ${MAX_CHECKS} checks` };
  const out: Check[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || typeof c.name !== "string" || !NAME.test(c.name)) return { state: "unknown", why: "a check has no usable name (letters, digits, _ . -; up to 60)" };
    if (typeof c.ok !== "boolean") return { state: "unknown", why: `check ${c.name} didn't evaluate` };
    const sample = c.sample === undefined || c.sample === null ? null : (typeof c.sample === "string" ? c.sample : JSON.stringify(c.sample)).replace(/\s+/g, " ").slice(0, 200);
    out.push({ name: c.name, ok: c.ok, count: typeof c.count === "number" && Number.isFinite(c.count) ? c.count : null, sample });
  }
  if (new Set(out.map((c) => c.name)).size !== out.length) return { state: "unknown", why: "two checks share a name" };
  return { state: "ok", checks: out };
}

/**
 * What leaves apps-mcp on the internal route (the board's detector, then fleet_status): app, check name, ok and count only.
 * Samples are app data: they are read through app_status, which checks the caller may read that app.
 */
export function withoutSamples(q: Quality): Quality {
  return q.state === "ok" ? { state: "ok", checks: q.checks.map(({ name, ok, count }) => ({ name, ok, count, sample: null })) } : q;
}
