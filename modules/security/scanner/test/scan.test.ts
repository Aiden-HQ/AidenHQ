import { expect, it } from "vitest";
import { DDL, parseTargets, scanPass, type Batch } from "../src/scan.js";
import type { SourceStore } from "../src/source-store.js";

// The writer against an in-memory store that keys rows like Postgres would (the SQL itself follows the other writers).
function fakeStore(failIngestInsert = { value: false }) {
  const rows = new Map<string, Record<string, any>>();
  const runs: { scope: string; error: string | null; commit: string | null; status: string | null }[] = [];
  const scopes = new Map<string, { baselined: boolean; cursor: string | null; syncedAt: number }>();
  const key = (r: Record<string, any>) => [r.target, r.package, r.version, r.vuln_id].join("|");
  const store = {
    migrate: async () => undefined,
    run: async (_source: string, scope: string, fn: () => Promise<number>, meta: { commit?: string | null } = {}) => {
      try {
        const n = await fn();
        runs.push({ scope, error: null, commit: meta.commit ?? null, status: null });
        return n;
      } catch (err) {
        runs.push({ scope, error: String((err as Error).message), commit: meta.commit ?? null, status: null });
        throw err;
      }
    },
    scopesByPrefix: async () => scopes,
    saveScope: async (s: string, cursor: string | null) => void scopes.set(s, { baselined: true, cursor, syncedAt: Date.now() }),
    upsert: async (_t: unknown, row: Record<string, any>) => {
      const cur = rows.get(key(row));
      if (!cur) return (rows.set(key(row), { ...row }), "new");
      const changed = Object.keys(row).some((k) => JSON.stringify(cur[k]) !== JSON.stringify(row[k]));
      Object.assign(cur, row);
      return changed ? "changed" : "same";
    },
    pool: {
      query: async (sql: string, p: any[] = []) => query(sql, p),
      connect: async () => {
        let snapshot: { rows: [string, Record<string, any>][]; runs: number } | null = null;
        return {
          query: async (sql: string, p: any[] = []) => {
            if (sql === "BEGIN") snapshot = { rows: [...rows].map(([k, v]) => [k, { ...v }]), runs: runs.length };
            if (sql === "ROLLBACK" && snapshot) {
              rows.clear();
              for (const [k, v] of snapshot.rows) rows.set(k, v);
              runs.length = snapshot.runs;
              snapshot = null;
            }
            if (sql === "COMMIT") snapshot = null;
            return query(sql, p);
          },
          release: () => undefined,
        };
      },
    },
  };
  async function query(sql: string, p: any[] = []) {
    const all = [...rows.values()];
    if (sql.startsWith("INSERT INTO src_meta.ingest_run") && p[5] != null && failIngestInsert.value) throw new Error("column status does not exist");
    if (sql.startsWith("INSERT INTO src_meta.ingest_run") && p[5] != null) runs.push({ scope: p[1], error: p[4] ?? null, commit: null, status: p[5] });
    else if (sql.startsWith("INSERT INTO src_meta.ingest_run")) runs.push({ scope: p[1], error: p[4] ?? null, commit: null, status: null });
    if (sql.includes("SET present = false")) {
      const r = rows.get(`${p[0]}|${p[1]}|${p[2]}|${p[5]}`);
      if (r) Object.assign(r, { present: false, resolved_at: p[3], resolved_reason: p[4] });
    }
    if (sql.includes("SELECT package, version, vuln_id, url FROM src_security.finding")) return { rows: all.filter((r) => r.target === p[0] && r.tool === "grype" && r.present).map((r) => ({ package: r.package, version: r.version, vuln_id: r.vuln_id, url: r.url ?? null })) };
    if (sql.includes("SET epss")) for (const r of all) {
      const i = r.target === p[0] && r.tool === p[1] ? (p[2] as string[]).findIndex((pkg, j) => pkg === r.package && p[3][j] === r.version && p[4][j] === r.vuln_id) : -1;
      if (i >= 0) Object.assign(r, { epss: p[5][i], epss_percentile: p[6][i] });
    }
    if (sql.includes("SET last_seen")) for (const r of all) if (r.target === p[0] && r.tool === p[1] && r.present) r.last_seen = p[2];
    if (sql.includes("DISTINCT target")) return { rows: [...new Set(all.filter((r) => r.present).map((r) => r.target))].map((target) => ({ target })) };
    return { rows: all.filter((r) => r.target === p[0] && r.tool === p[1] && r.present) };
  }
  return { store: store as unknown as SourceStore, rows, runs, failIngestInsert };
}

const match = (pkg: string, version: string, id: string, path: string, fixed = "1.2.4") => ({
  vulnerability: { id, severity: "High", fix: { versions: [fixed], state: "fixed" }, dataSource: `https://nvd.nist.gov/vuln/detail/${id}`, cvss: [{ metrics: { baseScore: 7.5 } }] },
  relatedVulnerabilities: [{ id: "GHSA-xxxx-yyyy-zzzz" }],
  artifact: { name: pkg, version, type: "npm", purl: `pkg:npm/${pkg}@${version}`, locations: [{ path }] },
});

it("src_security: one row per finding key across passes and paths, gone findings resolved, a bad target never fails the pass", async () => {
  const { store, rows, runs } = fakeStore();
  const sboms: Record<string, unknown> = {
    "repo.json": { matches: [match("lodash", "4.17.20", "CVE-2021-23337", "/a/package-lock.json"), match("lodash", "4.17.20", "CVE-2021-23337", "/b/package-lock.json")] },
    "image.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] },
  };
  let now = Date.parse("2026-11-11T00:00:00Z");
  const head = "1".repeat(40);
  const inst = "2".repeat(40);
  const logs: Record<string, unknown>[] = [];
  // What ops/security-sbom.sh writes: (target, file, error, commit), commit for the repo checkouts.
  const index = (): string => [
    `repo:product\trepo.json\t\t${head}`,
    `repo:instance\trepo.json\t\t${inst}`,
    "image:aidenhq/board:local\timage.json\t\t",
    "app:broken\tbroken.json\t\t", // grype chokes on it
    "host\t-\tsyft exited 1\t", // the host couldn't inventory it
  ].join("\n");
  const batch = (): Batch => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(), "/sbom") });
  const deps = {
    dbUpdate: async () => undefined,
    readBatch: async () => batch(),
    grype: async (f: string) => { const name = f.split("/").pop()!; if (!(name in sboms)) throw new Error("unable to decode sbom"); return sboms[name]; },
    now: () => now,
    log: (msg: string, extra: Record<string, unknown>) => logs.push({ msg, ...extra }),
  };

  expect(await scanPass(store, deps)).toBe(3);
  expect(rows.size).toBe(3); // lodash at two paths is one finding, per repo target
  const lodash = rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")!;
  expect(lodash).toMatchObject({ present: true, severity: "high", fixed_version: "1.2.4", fix_state: "fixed", cvss: 7.5, aliases: ["GHSA-xxxx-yyyy-zzzz"], locations: ["/a/package-lock.json", "/b/package-lock.json"], target_kind: "repo", tool: "grype" });
  expect(lodash.finding_id).toMatch(/^[0-9a-f]{16}$/);
  expect(lodash.last_seen).toEqual(new Date(now));
  expect(runs.filter((r) => r.error).map((r) => r.scope).sort()).toEqual(["app:broken", "host"]);
  // Every repo pass records the checkout's commit, in the target's ingest_run row and in the scanner's log.
  expect(runs.find((r) => r.scope === "repo:product")?.commit).toBe(head);
  expect(runs.find((r) => r.scope === "repo:instance")?.commit).toBe(inst);
  expect(logs.find((l) => l.msg === "sbom batch")?.targets).toEqual(expect.arrayContaining([{ target: "repo:product", commit: head }, { target: "repo:instance", commit: inst }]));

  // A day later: the same findings write nothing (no re-delivery), last_seen still moves; the openssl image is not in the batch.
  now += 86_400_000;
  sboms["repo.json"] = { matches: [match("lodash", "4.17.20", "CVE-2021-23337", "/a/package-lock.json")] };
  delete sboms["image.json"];
  const second = await scanPass(store, { ...deps, readBatch: async () => ({ ...batch(), targets: batch().targets.filter((t) => !t.target.startsWith("image:")) }) });
  expect(second).toBe(2); // lodash's locations changed on both repo targets (one path fewer); an absent target writes no finding
  expect(rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")!.last_seen).toEqual(new Date(now));
  // Not enumerated is not clean: the image's finding stays present and unverified, and the absence is an error run row.
  expect(rows.get("image:aidenhq/board:local|openssl|3.0.1|CVE-2024-0001")).toMatchObject({ present: true, resolved_at: null });
  expect(runs.find((r) => r.scope === "image:aidenhq/board:local" && r.error)?.error).toMatch(/absent/);

  // A stale batch (the host timer stopped) resolves nothing and is reported.
  now += 86_400_000;
  expect(await scanPass(store, { ...deps, readBatch: async () => ({ finishedAt: new Date(now - 5 * 86_400_000), targets: [] }) })).toBe(0);
  expect(rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")!.present).toBe(true);
  expect(runs.find((r) => r.scope === "sbom-batch")?.error).toMatch(/host timer/);
});

it("src_security: a mapped target absent from a fresh batch is retired against its clean replacement and its findings settled", async () => {
  const { store, rows, runs } = fakeStore();
  const retired = "image:aidenhq/github-mcp:local";
  const replacement = "image:aidenhq/github-github:local";
  const unmapped = "image:aidenhq/board:local";
  const sboms: Record<string, unknown> = {
    // First pass: both targets exist; the retired one also has a finding the replacement does not carry.
    "retired.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status"), match("zlib", "1.2.11", "CVE-2022-37434", "/usr/lib/libz.so")] },
    "replacement.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/usr/bin/git")] },
    "unmapped.json": { matches: [match("curl", "7.88.1", "CVE-2023-0001", "/usr/bin/curl")] },
  };
  let now = Date.parse("2026-11-11T00:00:00Z");
  const index = (targets: string[]): string => targets.map((t) => `${t}\t${t === retired ? "retired" : t === replacement ? "replacement" : "unmapped"}.json\t\t`).join("\n");
  const deps = (targets: string[]) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(targets), "/sbom") }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps([retired, replacement, unmapped]))).toBe(4);
  const retiredOnly = `${retired}|zlib|1.2.11|CVE-2022-37434`;
  const carried = `${retired}|openssl|3.0.1|CVE-2024-0001`;
  const replacementRow = `${replacement}|openssl|3.0.1|CVE-2024-0001`;
  const unmappedRow = `${unmapped}|curl|7.88.1|CVE-2023-0001`;
  expect(rows.get(retiredOnly)).toMatchObject({ present: true });
  expect(rows.get(replacementRow)).toMatchObject({ present: true });

  // Next pass: the retired and the unmapped target are gone from the inventory; only the replacement is scanned.
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps([replacement]))).toBe(2); // the two present findings on the retired target

  // Retired, not absent: a status marker with no error, so scan-health does not read it as a failing target.
  const run = runs.find((x) => x.scope === retired)!;
  expect(run).toMatchObject({ status: "retired", error: null });
  expect(runs.filter((x) => x.scope === retired)).toHaveLength(1);

  // The finding the replacement does not carry is gone, with the replacement named as the reason.
  expect(rows.get(retiredOnly)).toMatchObject({ present: false, resolved_reason: expect.stringContaining(replacement) });
  expect(rows.get(retiredOnly)!.resolved_at).toEqual(new Date(now));
  expect(rows.get(retiredOnly)!.resolved_reason).toMatch(/does not report/);
  // The finding the replacement carries is settled on the retired target as covered, and stays present on the replacement.
  expect(rows.get(carried)).toMatchObject({ present: false, resolved_reason: expect.stringContaining(replacement) });
  expect(rows.get(carried)!.resolved_reason).toMatch(/covered by replacement/);
  expect(rows.get(replacementRow)).toMatchObject({ present: true, resolved_at: null });

  // A target with no mapping keeps the existing absent/unverified path and its finding stays present.
  expect(runs.find((x) => x.scope === unmapped)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(unmappedRow)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: DDL single-quoted literals stay closed (a bare apostrophe in the findings COMMENT breaks migrate())", () => {
  // A static check: is the text balanced as SQL? It has to read -- comments (which contain apostrophes) and '' escapes, and
  // must not split on ';' because the findings COMMENT contains one. An unterminated literal is reported at its opening
  // quote, so a newly added bare apostrophe names a line and offset in DDL.
  function assertLiteralsClosed(ddl: string): void {
    let i = 0;
    let line = 1;
    let column = 1;
    let open: { line: number; column: number; offset: number } | null = null;
    while (i < ddl.length) {
      const c = ddl[i]!;
      if (open === null && c === "-" && ddl[i + 1] === "-") {
        const newline = ddl.indexOf("\n", i);
        if (newline === -1) break;
        i = newline + 1;
        line++;
        column = 1;
        continue;
      }
      if (c === "'") {
        if (open === null) open = { line, column, offset: i + 1 };
        else if (ddl[i + 1] === "'") {
          i++;
          column++;
        } else open = null;
      }
      if (c === "\n") {
        line++;
        column = 1;
      } else column++;
      i++;
    }
    if (open) throw new Error(`unterminated single-quoted literal at line ${open.line}, offset ${open.offset} (column ${open.column})`);
  }

  expect(() => assertLiteralsClosed(DDL)).not.toThrow();
  // The case that broke migrate(): a quote escaped inside a literal by doubling it (VM''s) with the second quote removed, so
  // the literal closes early. It is made from the DDL itself, so no wording is pinned. A doubled quote after nothing or a
  // space is left out: '' as a whole value opens and closes one empty literal.
  const escaped = [...DDL.matchAll(/([A-Za-z0-9])''/g)];
  expect(escaped.length).toBeGreaterThan(0);
  for (const m of escaped) {
    const bare = DDL.slice(0, m.index! + 2) + DDL.slice(m.index! + 3);
    expect(() => assertLiteralsClosed(bare)).toThrow(/unterminated single-quoted literal at line \d+, offset \d+/);
  }
});

it("src_security: KEV and EPSS from grype land on the finding (GHSA match: on the related CVE), EPSS moves without re-delivering the row", async () => {
  const { store, rows } = fakeStore();
  const kev = { cve: "CVE-2024-0002", dateAdded: "2026-10-26", knownRansomwareCampaignUse: "Unknown" };
  const grypeJson = (epss: number) => ({
    matches: [
      { ...match("openssl", "3.0.1", "CVE-2024-0002", "/a"), vulnerability: { ...match("x", "1", "CVE-2024-0002", "/a").vulnerability, knownExploited: [kev], epss: [{ cve: "CVE-2024-0002", epss, percentile: 0.97, date: "2026-11-22" }] } },
      { ...match("lodash", "4.17.20", "GHSA-aaaa-bbbb-cccc", "/b"), relatedVulnerabilities: [{ id: "CVE-2021-23337", knownExploited: [{ cve: "CVE-2021-23337", dateAdded: "2025-01-02" }, kev], epss: [{ epss: 0.2, percentile: 0.9 }, { epss: 0.5, percentile: 0.95 }] }] },
      match("zlib", "1.2.11", "CVE-2022-37434", "/c"),
    ],
  });
  let epss = 0.4;
  const deps = {
    dbUpdate: async () => undefined,
    readBatch: async () => ({ finishedAt: new Date(Date.now() - 1000), targets: parseTargets("image:x\tx.json\t\t", "/sbom") }),
    grype: async () => grypeJson(epss),
  };
  expect(await scanPass(store, deps)).toBe(3);
  expect(rows.get("image:x|openssl|3.0.1|CVE-2024-0002")).toMatchObject({ kev: true, kev_added: "2026-10-26", epss: 0.4, epss_percentile: 0.97 });
  expect(rows.get("image:x|lodash|4.17.20|GHSA-aaaa-bbbb-cccc")).toMatchObject({ kev: true, kev_added: "2025-01-02", epss: 0.5, epss_percentile: 0.95 });
  expect(rows.get("image:x|zlib|1.2.11|CVE-2022-37434")).toMatchObject({ kev: null, kev_added: null });
  epss = 0.45; // a daily EPSS move updates the score but is not a change worth re-delivering
  expect(await scanPass(store, deps)).toBe(0);
  expect(rows.get("image:x|openssl|3.0.1|CVE-2024-0002")?.epss).toBe(0.45);
  expect(rows.get("image:x|zlib|1.2.11|CVE-2022-37434")?.epss).toBeNull();
});

it("src_security: the DDL adds the exploitation columns additively and the view exposes them", () => {
  for (const c of ["kev boolean", "kev_added date", "epss real", "epss_percentile real"]) expect(DDL).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
  expect(DDL).toContain("f.kev, f.kev_added, f.epss, f.epss_percentile");
});
