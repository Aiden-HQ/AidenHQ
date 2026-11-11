// People across sources (shared sources, phase 2): src_meta.person (one row per human) and src_meta.person_identity (a
// source's user id linked to a person, proposed or approved). apps-mcp is the one writer. It proposes links only where the
// sources themselves agree: the same email (exact, case-insensitive) on users of two or more sources. Everything else stays
// unlinked, and names, above all model-extracted ones, never link anyone. A proposal is never overwritten; deciding one
// (person_identity_decide) is the librarian's, by role, and records who and why.
import type { WarehouseDeps } from "./sources.js";

export interface SourceUser { source: string; user_id: string; email: string | null; display_name: string | null; is_bot: boolean | null }
export interface Linked { source: string; source_user_id: string; person_id: number }
export interface Proposal { email: string; display_name: string | null; person_id: number | null; members: { source: string; user_id: string; display_name: string | null }[] }

const SOURCES = ["slack", "github", "jira"];
const SKIP = /^(no-?reply|notifications?|bot|mailer-daemon)@|@users\.noreply\.github\.com$/;

/**
 * Links to propose: per email, the users not yet linked. They join the person an already-linked user of that email has;
 * with none, a new person, but only when the email spans two or more sources. An email whose users are linked to
 * different people is left alone (the owner sorts it out).
 */
export function proposals(users: SourceUser[], linked: Linked[]): Proposal[] {
  const personOf = new Map(linked.map((l) => [`${l.source}/${l.source_user_id}`, l.person_id]));
  const byEmail = new Map<string, SourceUser[]>();
  for (const u of users) {
    const email = u.email?.trim().toLowerCase();
    if (!email || u.is_bot || SKIP.test(email)) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), u]);
  }
  const out: Proposal[] = [];
  for (const [email, us] of byEmail) {
    const people = new Set(us.map((u) => personOf.get(`${u.source}/${u.user_id}`)).filter((p) => p != null));
    if (people.size > 1) continue;
    const person_id = people.size ? [...people][0]! : null;
    if (person_id == null && new Set(us.map((u) => u.source)).size < 2) continue;
    const members = us.filter((u) => !personOf.has(`${u.source}/${u.user_id}`)).map((u) => ({ source: u.source, user_id: u.user_id, display_name: u.display_name }));
    if (members.length) out.push({ email, display_name: us.find((u) => u.display_name)?.display_name ?? null, person_id, members });
  }
  return out;
}

/** One pass: reads every source's users (sources not set up are skipped) and writes the new proposals. Returns how many links. */
export async function proposeIdentities(d: WarehouseDeps): Promise<number> {
  const users: SourceUser[] = [];
  for (const s of SOURCES) {
    const exists = await d.pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`src_${s}.users`]);
    if (!exists.rows[0]?.ok) continue;
    const r = await d.pool.query(`SELECT user_id, email, coalesce(display_name, handle) AS display_name, is_bot FROM src_${s}.users WHERE email IS NOT NULL`);
    users.push(...r.rows.map((u) => ({ source: s, ...u })));
  }
  const linked = (await d.pool.query("SELECT source, source_user_id, person_id FROM src_meta.person_identity")).rows.map((l) => ({ ...l, person_id: Number(l.person_id) }));
  const todo = proposals(users, linked);
  if (!todo.length) return 0;
  // New people by email (ON CONFLICT: a person left without identities is reused), then their links; existing links untouched.
  // In chunks: the JSON goes to psql as one argument, which Linux caps at 128 KB.
  for (let i = 0; i < todo.length; i += 100) await write(d, todo.slice(i, i + 100));
  return todo.reduce((n, g) => n + g.members.length, 0);
}

function write(d: WarehouseDeps, groups: Proposal[]) {
  return d.sql(
    `WITH g AS (SELECT * FROM jsonb_to_recordset(:'groups'::jsonb) AS x(email text, display_name text, person_id bigint, members jsonb)),
     ins AS (
       INSERT INTO src_meta.person (email, display_name) SELECT email, display_name FROM g WHERE person_id IS NULL
       ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING person_id, email
     ),
     p AS (SELECT g.email, coalesce(g.person_id, ins.person_id) AS person_id, g.members FROM g LEFT JOIN ins USING (email))
     INSERT INTO src_meta.person_identity (source, source_user_id, person_id, confidence, status, evidence, display_name, email)
     SELECT m.source, m.user_id, p.person_id, 1.0, 'proposed', 'exact email match: ' || p.email, m.display_name, p.email
     FROM p, jsonb_to_recordset(p.members) AS m(source text, user_id text, display_name text)
     ON CONFLICT (source, source_user_id) DO NOTHING;`,
    { groups: JSON.stringify(groups) },
  );
}

/** Confirms or rejects one proposed link (and only a proposed one), recording who decided and why. The caller's role is checked in mcp.ts. */
export async function decideIdentity(d: WarehouseDeps, by: string, a: { source: string; source_user_id: string; decision: "confirm" | "reject"; reason: string }) {
  const found = await d.pool.query(
    "SELECT i.status, i.email, p.email AS person_email FROM src_meta.person_identity i JOIN src_meta.person p USING (person_id) WHERE i.source = $1 AND i.source_user_id = $2",
    [a.source, a.source_user_id],
  );
  const row = found.rows[0];
  const status = row?.status;
  if (!status) throw new Error(`no identity link for ${a.source}/${a.source_user_id}`);
  if (status !== "proposed") throw new Error(`${a.source}/${a.source_user_id} is already ${status}; only a proposed link can be decided`);
  // The gate is in code, not the agent's judgment: a confirm needs the link's email to be the person's email exactly.
  const same = (x: unknown) => String(x ?? "").trim().toLowerCase();
  if (a.decision === "confirm" && (!same(row.email) || same(row.email) !== same(row.person_email)))
    throw new Error(`${a.source}/${a.source_user_id}: its email doesn't match the person's email, so it can't be confirmed (reject it or leave it for the owner)`);
  const next = a.decision === "confirm" ? "approved" : "rejected";
  await d.sql(
    `UPDATE src_meta.person_identity SET status = :'status', decided_at = now(), decided_by = :'by', decision_reason = :'reason'
     WHERE source = :'source' AND source_user_id = :'uid' AND status = 'proposed';`,
    { status: next, by, reason: a.reason, source: a.source, uid: a.source_user_id },
  );
  return { source: a.source, source_user_id: a.source_user_id, status: next, decided_by: by };
}

/** Hourly, from start; a pass that fails (warehouse not up yet) is retried on the next. */
export function startPeople(warehouse: () => WarehouseDeps, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }, everyMs = 3_600_000): void {
  const tick = async () => {
    try {
      const n = await proposeIdentities(warehouse());
      if (n) log.info({ proposed: n }, "people: identity links proposed");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 300) }, "people: proposal pass failed");
    }
  };
  setTimeout(tick, 120_000).unref();
  setInterval(tick, everyMs).unref();
}
