// src_security writer (shared sources): CVE findings for everything we run. No LLM.
//
// The inventory (SBOMs) is made on the host by ops/security-sbom.sh (a daily user timer running pinned syft over the host
// packages, every running container image, the product and instance checkouts and each app's deployed source), because
// that needs the Docker socket and the host's root filesystem, which this service never gets. This service only matches
// those SBOMs against grype's vulnerability database and keeps one row per (target, package, version, vuln_id).
//
// A pass: refresh grype's DB (a failure fails the pass: transient), then each target oldest-scanned first, within a time
// budget. One target that can't be matched (bad SBOM, grype error) is an error ingest_run row and is skipped; database
// errors rethrow. A finding no longer matched in a target that scanned cleanly is marked present = false. A present
// target missing from a fresh batch is not resolved: it is recorded as absent with its findings unverified. The
// exception is a target in RETIRED_TARGETS whose replacement was scanned cleanly in the same pass: it is recorded as
// retired (src_meta.ingest_run.status) and its findings are settled against the replacement's rows. A stale batch
// resolves nothing.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ZEROWIRE_DDL } from "./zerowire.js";
import { capText, tableDdl, type Row, type SourceStore, type Table } from "./source-store.js";

export const FINDING: Table = {
  name: "finding",
  key: ["target", "package", "version", "vuln_id"],
  cols: {
    target: "text", package: "text", version: "text", vuln_id: "text", finding_id: "text", target_kind: "text", tool: "text",
    pkg_type: "text", purl: "text", locations: "text[]", severity: "text", cvss: "real", fixed_version: "text", fix_state: "text",
    aliases: "text[]", title: "text", description: "text", url: "text", present: "boolean", resolved_at: "timestamptz", resolved_reason: "text", last_seen: "timestamptz",
    // grype's CISA KEV flag (true or null, never false: unlisted stays null) and EPSS (score, percentile).
    kev: "boolean", kev_added: "date", epss: "real", epss_percentile: "real",
  },
  tracked: ["severity", "fixed_version", "fix_state", "present", "kev"],
  scope: "target",
  url: "url",
  search: ["package", "vuln_id", "title", "description"],
};

const common = "baseline, first_seen_at, ingested_at, seq";
export const DDL = `${tableDdl("src_security", FINDING)}
ALTER TABLE src_security.finding ADD COLUMN IF NOT EXISTS resolved_reason text;
ALTER TABLE src_security.finding ADD COLUMN IF NOT EXISTS kev boolean;
ALTER TABLE src_security.finding ADD COLUMN IF NOT EXISTS kev_added date;
ALTER TABLE src_security.finding ADD COLUMN IF NOT EXISTS epss real;
ALTER TABLE src_security.finding ADD COLUMN IF NOT EXISTS epss_percentile real;
CREATE INDEX IF NOT EXISTS finding_present ON src_security.finding (target, tool) WHERE present;
-- Security Watch's verdicts (apps-mcp finding_verdict writes them as the warehouse superuser). at_* is the finding as the
-- verdict saw it: the view shows the verdict only while severity, fix and presence still match, so a changed finding is open again.
CREATE TABLE IF NOT EXISTS src_security.verdict (
  finding_id text PRIMARY KEY, verdict text NOT NULL, reason text NOT NULL, by_agent text NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(),
  at_severity text, at_fixed_version text, at_fix_state text, at_present boolean
);
CREATE OR REPLACE VIEW src_security.findings AS
  SELECT f.finding_id, target, target_kind, tool, package, version, pkg_type, purl, locations, vuln_id, aliases, severity, cvss, fixed_version, fix_state,
    title, description, url, present, resolved_at, last_seen, first_seen_at AS first_seen, ${common}, tsv,
    d.verdict, d.reason AS verdict_reason, d.by_agent AS verdict_by, d.decided_at AS verdict_at, f.resolved_reason, f.kev, f.kev_added, f.epss, f.epss_percentile
  FROM src_security.finding f LEFT JOIN src_security.verdict d ON d.finding_id = f.finding_id
    AND d.at_severity IS NOT DISTINCT FROM f.severity AND d.at_fixed_version IS NOT DISTINCT FROM f.fixed_version
    AND d.at_fix_state IS NOT DISTINCT FROM f.fix_state AND d.at_present IS NOT DISTINCT FROM f.present
    AND (d.verdict <> 'not-affected' OR d.decided_at > now() - interval '30 days');
COMMENT ON VIEW src_security.findings IS 'Vulnerabilities in what we run, one row per (target, package, version, vuln_id). target: host (the VM''s OS packages, kernel, Docker, Node), image:<ref> (a running container image), repo:product, repo:instance, app:<name> (an app''s deployed source). tool grype = a known CVE/GHSA matched against the inventory (severity critical|high|medium|low|negligible|unknown; fixed_version and fix_state fixed|not-fixed|wont-fix|unknown); tool app-auditor = AppSec''s App Auditor vibe audit of an app repo (no fixed_version). finding_id = stable short id (use it in task markers). present false = no longer found by a scan of that same target or settled when the target was retired (resolved_at; resolved_reason names the target''s replacement when retired); a target absent from a pass keeps present = true with an ingest_run row saying its findings are unverified, unless it is a known retired target whose replacement was scanned cleanly (then its ingest_run row says retired). first_seen / last_seen = when our scans first and last saw it. verdict (confirmed|not-affected, with verdict_reason, verdict_by, verdict_at) = Security Watch''s review of this finding as it stands now; null = not reviewed, or the finding changed since, or a not-affected verdict is over 30 days old. kev = CISA lists it as exploited in the wild (true, else null; kev_added = the date CISA added it); epss = FIRST''s probability (0 to 1) it is exploited in the next 30 days and epss_percentile its rank among all CVEs (both refresh daily; an epss of 0.1 or more is high). Both come from grype''s database; null on app-auditor rows. Changes (severity, fix, present, kev): src_security.changes.';
CREATE OR REPLACE VIEW src_security.changes AS
  SELECT seq, entity, entity_id, scope, field, old_value, new_value, url, observed_at, false AS baseline FROM src_security.change;
COMMENT ON VIEW src_security.changes IS 'Finding changes after first sight: field severity, fixed_version, fix_state, kev or present (false = resolved, true = back). scope = the target; entity_id = target/package/version/vuln_id.';
GRANT SELECT ON src_security.findings, src_security.changes TO agents_open;\n${ZEROWIRE_DDL}`;

export const findingId = (target: string, pkg: string, version: string, vuln: string) =>
  createHash("sha256").update(`${target}|${pkg}|${version}|${vuln}`).digest("hex").slice(0, 16);

const kindOf = (target: string) => (target === "host" ? "host" : target.split(":")[0] ?? "other");
const SEVERITIES = ["critical", "high", "medium", "low", "negligible", "unknown"];
const severity = (s: unknown) => (SEVERITIES.includes(String(s ?? "").toLowerCase()) ? String(s).toLowerCase() : "unknown");

type Exploitation = { kev: true | null; kev_added: string | null; epss: number | null; epss_percentile: number | null };

/** KEV and EPSS from a match's vulnerability and its related ones (a GHSA match carries them on the CVE): earliest KEV date, highest EPSS with its percentile. */
function exploitation(vulns: any[]): Exploitation {
  const kevs = vulns.flatMap((x) => (Array.isArray(x?.knownExploited) ? x.knownExploited : []));
  const dates = kevs.map((k) => String(k?.dateAdded ?? "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const epss = vulns.flatMap((x) => (Array.isArray(x?.epss) ? x.epss : [])).filter((e) => Number.isFinite(Number(e?.epss ?? NaN)));
  const top = epss.sort((a, b) => Number(b.epss) - Number(a.epss))[0];
  return { kev: kevs.length ? true : null, kev_added: dates[0] ?? null, epss: top ? Number(top.epss) : null, epss_percentile: top && Number.isFinite(Number(top.percentile)) ? Number(top.percentile) : null };
}

function mergeExploitation(a: Exploitation, b: Exploitation): Exploitation {
  const dates = [a.kev_added, b.kev_added].filter(Boolean).sort() as string[];
  const hi = (b.epss ?? -1) > (a.epss ?? -1) ? b : a;
  return { kev: a.kev || b.kev, kev_added: dates[0] ?? null, epss: hi.epss, epss_percentile: hi.epss_percentile };
}

/** grype's JSON (`-o json`) as finding rows for one target, one per key (a package matched at several paths is one row). */
export function parseGrype(target: string, out: any): Row[] {
  if (!Array.isArray(out?.matches)) throw new Error("grype output has no matches array");
  const rows = new Map<string, Row>();
  for (const m of out.matches) {
    const v = m?.vulnerability ?? {};
    const a = m?.artifact ?? {};
    if (!v.id || !a.name) continue;
    const pkg = String(a.name);
    const version = String(a.version ?? "");
    const key = `${pkg}|${version}|${v.id}`;
    const paths: string[] = (a.locations ?? []).map((l: any) => String(l?.path ?? "")).filter(Boolean);
    const related: any[] = Array.isArray(m.relatedVulnerabilities) ? m.relatedVulnerabilities : [];
    const x = exploitation([v, ...related]);
    const prev = rows.get(key);
    if (prev) {
      Object.assign(prev, mergeExploitation(prev as unknown as Exploitation, x));
      prev.locations = [...new Set([...(prev.locations as string[]), ...paths])].sort().slice(0, 20);
      continue;
    }
    const scores = [v, ...related].flatMap((x) => (x?.cvss ?? []).map((c: any) => Number(c?.metrics?.baseScore))).filter(Number.isFinite);
    rows.set(key, {
      target, package: pkg, version, vuln_id: String(v.id), finding_id: findingId(target, pkg, version, String(v.id)), target_kind: kindOf(target), tool: "grype",
      pkg_type: a.type ?? null, purl: a.purl ?? null, locations: [...new Set(paths)].sort().slice(0, 20), severity: severity(v.severity),
      cvss: scores.length ? Math.max(...scores) : null, fixed_version: (v.fix?.versions ?? []).join(", ") || null, fix_state: v.fix?.state ?? null,
      aliases: [...new Set(related.map((r) => String(r?.id ?? "")).filter((id) => id && id !== v.id))].sort(), title: null,
      description: capText(v.description || related.find((r) => r?.description)?.description || null, 1000).text,
      url: v.dataSource || v.urls?.[0] || related[0]?.dataSource || null, present: true, resolved_at: null, resolved_reason: null, ...x,
    });
  }
  return [...rows.values()];
}

/**
 * Writes one clean scan of a target for one tool: its rows present, its earlier present rows that are gone marked
 * present = false, and last_seen bumped outside upsert (so a daily re-sighting doesn't re-deliver the row to source_new).
 */
export async function syncTarget(store: SourceStore, target: string, tool: string, rows: Row[], now = new Date()): Promise<number> {
  let written = 0;
  const seen = new Set<string>();
  for (const { epss: _e, epss_percentile: _p, ...r } of rows) {
    seen.add(`${r.package}|${r.version}|${r.vuln_id}`);
    if ((await store.upsert(FINDING, r, { baseline: false })) !== "same") written++;
  }
  // EPSS moves daily: written outside upsert (like last_seen) so it doesn't re-deliver every row to source_new each day.
  const scored = rows; // null clears a score grype no longer supplies
  if (scored.length)
    await store.pool.query(
      `UPDATE src_security.finding f SET epss = n.epss, epss_percentile = n.pct
       FROM unnest($3::text[], $4::text[], $5::text[], $6::real[], $7::real[]) AS n(package, version, vuln_id, epss, pct)
       WHERE f.target = $1 AND f.tool = $2 AND f.package = n.package AND f.version = n.version AND f.vuln_id = n.vuln_id
         AND (f.epss IS DISTINCT FROM n.epss OR f.epss_percentile IS DISTINCT FROM n.pct)`,
      [target, tool, scored.map((r) => r.package), scored.map((r) => r.version), scored.map((r) => r.vuln_id), scored.map((r) => r.epss), scored.map((r) => r.epss_percentile)],
    );
  written += await resolveGone(store, target, tool, seen, now);
  await store.pool.query(`UPDATE src_security.finding SET last_seen = $3 WHERE target = $1 AND tool = $2 AND present`, [target, tool, now]);
  return written;
}

/** Marks a target's present rows of `tool` not in `keep` (package|version|vuln_id) as resolved. */
async function resolveGone(store: SourceStore, target: string, tool: string, keep: Set<string>, now: Date): Promise<number> {
  const cur = await store.pool.query(`SELECT package, version, vuln_id FROM src_security.finding WHERE target = $1 AND tool = $2 AND present`, [target, tool]);
  let n = 0;
  for (const r of cur.rows as { package: string; version: string; vuln_id: string }[]) {
    if (keep.has(`${r.package}|${r.version}|${r.vuln_id}`)) continue;
    if ((await store.upsert(FINDING, { target, package: r.package, version: r.version, vuln_id: r.vuln_id, present: false, resolved_at: now, resolved_reason: null }, { baseline: false })) !== "same") n++;
  }
  return n;
}

/** Retired image targets and the live target that replaced them. The cross-repository renames (Slack, codehost, MCP) ship
 * as a mapping: nothing in a batch shows which repository took over another. A renamed tag in the same repository needs
 * no entry (an absent image target retires against the one clean target of its repository in the same pass). */
export const RETIRED_TARGETS: Readonly<Record<string, string>> = {
  "image:aidenhq/channel-slack-slack:local": "image:aidenhq/slack-live:local",
  "image:aidenhq/codehost-github-codehost-github:local": "image:aidenhq/github-github:local",
  "image:aidenhq/github-codehost-github:local": "image:aidenhq/github-github:local",
  "image:aidenhq/github-mcp:local": "image:aidenhq/github-github:local",
  "image:aidenhq/computer-engineer:793c5d759a52": "image:aidenhq/computer-engineer:4e7b73eb627d",
  "image:aidenhq/computer-agent-base:e22cc951334c": "image:aidenhq/computer-agent-base:cb94c7b36572",
  "image:app-roadmap-keeper-app": "image:app-roadmap-keeper/app",
  "image:sha256:1beb013da1202abe6cf6e05c8083c28b9dfbc6018db2013b2f5e8f480467c843": "image:aidenhq/github-github:local",
  "image:sha256:c0639aab7ed2094796afcfc54dbc44112078e713391a75bd4df0c4be19d2cdee": "image:aidenhq/github-github:local",
};

/** The host's SBOM batch (ops/security-sbom.sh): each target's SBOM file, or the reason the host couldn't make one. */
export interface Batch {
  finishedAt: Date | null; // null: no batch yet
  targets: { target: string; file?: string; error?: string; commit?: string }[]; // commit: the checkout's git HEAD
  // True only for a batch whose writer listed every configured image as well as every running one (the marker
  // ops/security-sbom.sh writes when every image it surveyed has a row). Absence is proof an image retired only then:
  // an older or short batch may simply not have listed it, so it must not settle findings.
  imagesComplete?: boolean;
}

/** targets.tsv as written by ops/security-sbom.sh: (target, file, error, commit), one line per target. */
export function parseTargets(text: string, dir: string): Batch["targets"] {
  return text.split("\n").filter(Boolean).map((line) => {
    const [target = "", f = "", error = "", commit = ""] = line.split("\t");
    return { target, ...(f && f !== "-" ? { file: join(dir, f) } : {}), ...(error ? { error } : {}), ...(commit ? { commit } : {}) };
  }).filter((t) => t.target);
}

export interface PassDeps {
  dbUpdate: () => Promise<void>;
  readBatch: () => Promise<Batch>;
  grype: (file: string) => Promise<unknown>;
  now?: () => number;
  deadlineMs?: number; // the pass stops starting targets after this long (the rest go first next time)
  staleMs?: number; // a batch older than this is reported and resolves nothing
  log?: (msg: string, extra: Record<string, unknown>) => void;
}

/** A target that can't be scanned this pass, for a reason a retry won't fix: recorded, skipped, never fails the pass. */
export class Skip extends Error {}

/** The reason a retired image with no replacement carries: its findings are settled because nothing runs or names it. */
export const NO_REPLACEMENT_REASON = "retired: no container runs this image and no configured image names it";

/**
 * The repository an `image:` target names: the reference with its platform suffix (`@linux/arm64/v8`, which the batch
 * adds for a non-native variant), digest and tag removed. Null for a bare image id, which names no repository and so can
 * never be another target's replacement.
 */
export function imageRepository(target: string): string | null {
  const m = /^image:(.+)$/.exec(target);
  if (!m) return null;
  let ref = m[1]!;
  ref = ref.replace(/@.*$/, ""); // the batch's platform suffix, then a digest
  if (/^sha256:[0-9a-f]+$/.test(ref)) return null; // a bare image id names no repository
  const colon = ref.lastIndexOf(":");
  if (colon > ref.lastIndexOf("/")) ref = ref.slice(0, colon);
  return ref || null;
}

/**
 * A retired target's present findings, settled against its replacement's rows from the same pass: the replacement's
 * own rows stay present; the retired target's rows become present = false, with the reason saying covered or gone. With
 * no replacement (null), every row is settled with NO_REPLACEMENT_REASON, claiming no other target for it.
 *
 * The settlements and the retired ingest_run row are one transaction, the row written after them: a target never reads
 * as retired (a success marker) with its findings still present, and its findings are never settled without the marker
 * that makes the retirement durable. A failure rolls both back and the next pass retries. The change log gets the
 * present -> false entry the shared upsert would have written.
 */
async function retireTarget(store: SourceStore, target: string, replacement: string | null, rows: Row[], now: Date): Promise<number> {
  const carried = new Set(rows.map((r) => `${r.package}|${r.version}|${r.vuln_id}`));
  const c = await store.pool.connect();
  try {
    await c.query("BEGIN");
    const cur = await c.query(`SELECT package, version, vuln_id, url FROM src_security.finding WHERE target = $1 AND tool = 'grype' AND present`, [target]);
    const found = cur.rows as { package: string; version: string; vuln_id: string; url: string | null }[];
    for (const r of found) {
      const reason = replacement == null
        ? NO_REPLACEMENT_REASON
        : carried.has(`${r.package}|${r.version}|${r.vuln_id}`)
          ? `covered by replacement ${replacement}: it was scanned in this pass and reports the same package, version and vulnerability`
          : `gone: replacement ${replacement} was scanned in this pass and does not report it`;
      await c.query(
        `UPDATE src_security.finding SET present = false, resolved_at = $4, resolved_reason = $5, baseline = false, ingested_at = now(), seq = nextval('src_meta.seq')
         WHERE target = $1 AND package = $2 AND version = $3 AND vuln_id = $6`,
        [target, r.package, r.version, now, reason, r.vuln_id],
      );
      // The same change entry the shared upsert writes for a tracked "present" difference.
      await c.query(
        `INSERT INTO src_security.change (entity, entity_id, scope, field, old_value, new_value, url) VALUES ('finding', $1, $2, 'present', 'true', 'false', $3)`,
        [[target, r.package, r.version, r.vuln_id].join("/"), target, r.url],
      );
    }
    await c.query(`INSERT INTO src_meta.ingest_run (source, scope, started_at, rows, error, status) VALUES ($1, $2, $3, $4, $5, $6)`, ["security", target, now, found.length, null, "retired"]);
    await c.query("COMMIT");
    return found.length;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function scanPass(store: SourceStore, d: PassDeps): Promise<number> {
  const now = d.now ?? Date.now;
  const start = now();
  await store.migrate(DDL);
  await d.dbUpdate(); // offline or a broken DB download: transient, the whole pass fails and runs again later
  const batch = await d.readBatch();
  d.log?.("sbom batch", { finishedAt: batch.finishedAt?.toISOString() ?? null, targets: batch.targets.map((t) => ({ target: t.target, commit: t.commit ?? null })) });
  const staleMs = d.staleMs ?? 3 * 86_400_000;
  const fresh = !!batch.finishedAt && start - batch.finishedAt.getTime() < staleMs;
  if (!fresh) {
    const why = batch.finishedAt ? `SBOM batch is from ${batch.finishedAt.toISOString()}: is the host timer (aidenhq-security-sbom.timer) running?` : "no SBOM batch yet: run ops/security-sbom.sh on the host (operator step)";
    await store.run("security", "sbom-batch", async () => { throw new Error(why); }).catch(() => undefined);
  }
  const clean = new Map<string, Row[]>(); // targets scanned cleanly this pass, with the rows that scan wrote
  const synced = await store.scopesByPrefix("");
  const order = [...batch.targets].sort((a, b) => (synced.get(a.target)?.syncedAt ?? 0) - (synced.get(b.target)?.syncedAt ?? 0));
  let written = 0;
  for (const t of order) {
    if (now() - start > (d.deadlineMs ?? 50 * 60_000)) break;
    try {
      written += await store.run("security", t.target, async () => {
        if (t.error || !t.file) throw new Skip(`host could not inventory ${t.target}: ${t.error ?? "no SBOM"}`);
        let rows: Row[];
        try {
          rows = parseGrype(t.target, await d.grype(t.file));
        } catch (err) {
          throw new Skip(`grype on ${t.target}: ${String((err as Error).message ?? err).slice(0, 300)}`);
        }
        const n = await syncTarget(store, t.target, "grype", rows, new Date(now()));
        clean.set(t.target, rows);
        return n;
      }, { commit: t.commit });
      await store.saveScope(t.target, new Date(now()).toISOString(), true);
    } catch (err) {
      if (!(err instanceof Skip)) throw err;
    }
  }
  // A present target this batch did not enumerate was not scanned clean. The set of targets the batch covers is complete
  // for `image:` (every running image plus every image config/computers.json names) but not for `host`, `repo:*` and
  // `app:*`, so the two are settled differently:
  //   image:  only in a batch that lists every configured image (imagesComplete) is absence proof its image is no
  //           longer running and no configured image names it, so the target is retired rather than reported as a failing
  //           one. In any other batch it keeps the absent/unverified row: an image it might have listed must not settle. It retires against the one `image:` target of its own repository that was scanned
  //           cleanly in this pass (a tag renamed in place); with none, or with more than one to choose from, it claims no
  //           replacement. Either way status is "retired", error is null, and its findings settle present = false.
  //           One exception: when its repository is in the batch but nothing of it scanned cleanly, the image may be
  //           running under another name whose scan failed (an alias, say), so absence is not proof it is gone: the
  //           target keeps the absent/unverified row until a pass scans its repository again.
  //   other:  the batch does not enumerate these completely, so absence is not proof of retirement: the findings stay
  //           present and unverified, and the absence is an ingest_run error row so readers can see it.
  // A replacement from the shipped map (a cross-repository rename) is used when it was scanned cleanly in this pass.
  if (fresh) {
    const listed = new Set(batch.targets.map((t) => t.target));
    const r = await store.pool.query(`SELECT DISTINCT target FROM src_security.finding WHERE tool = 'grype' AND present`);
    for (const { target } of r.rows as { target: string }[]) {
      if (listed.has(target)) continue;
      const mapped = RETIRED_TARGETS[target];
      // A cross-repository rename that this batch lists but did not scan cleanly is not a replacement yet: its scan may
      // have failed, and retiring against it would close findings nothing verified. Keep the absent row until it scans.
      if (mapped && !clean.has(mapped)) {
        const attempted = batch.targets.some((t) => t.target === mapped);
        if (attempted || !target.startsWith("image:")) {
          await store.run("security", target, async () => { throw new Skip("absent from this pass's SBOM inventory: findings unverified"); }).catch(() => undefined);
          continue;
        }
      }
      let replacement: string | null = mapped && clean.has(mapped) ? mapped : null;
      if (!replacement && target.startsWith("image:") && batch.imagesComplete !== true) {
        await store.run("security", target, async () => { throw new Skip("absent from this pass's SBOM inventory: findings unverified"); }).catch(() => undefined);
        continue;
      }
      if (!replacement && target.startsWith("image:")) {
        const repo = imageRepository(target);
        const same = repo ? [...clean.keys()].filter((t) => t.startsWith("image:") && imageRepository(t) === repo) : [];
        // A same-repository target the batch attempted but did not scan clean: this image may be the one that ran under
        // that name (an alias, say), so its absence this pass does not prove it retired, and a clean sibling does not
        // prove it either. Keep the absent row until a pass scans the whole repository cleanly.
        const failed = repo ? batch.targets.some((t) => t.target.startsWith("image:") && imageRepository(t.target) === repo && !clean.has(t.target)) : false;
        if (failed) {
          await store.run("security", target, async () => { throw new Skip("absent from this pass's SBOM inventory: findings unverified"); }).catch(() => undefined);
          continue;
        }
        if (same.length === 1) replacement = same[0]!;
      }
      // A failed retirement rolls back as a whole and is recorded as absent, so it stays visible and the next pass retries.
      const retired = target.startsWith("image:") || replacement
        ? await retireTarget(store, target, replacement, replacement ? clean.get(replacement)! : [], new Date(now())).catch(() => undefined)
        : undefined;
      if (retired == null) await store.run("security", target, async () => { throw new Skip("absent from this pass's SBOM inventory: findings unverified"); }).catch(() => undefined);
      else written += retired;
    }
  }
  return written;
}
