import { expect, it } from "vitest";
import { parseTargets, scanPass, type Batch } from "../src/scan.js";
import type { SourceStore } from "../src/source-store.js";

// The writer against an in-memory store that keys rows like Postgres would (the SQL itself follows the other writers).
function fakeStore() {
  const rows = new Map<string, Record<string, any>>();
  const runs: { scope: string; error: string | null; commit: string | null }[] = [];
  const scopes = new Map<string, { baselined: boolean; cursor: string | null; syncedAt: number }>();
  const key = (r: Record<string, any>) => [r.target, r.package, r.version, r.vuln_id].join("|");
  const store = {
    migrate: async () => undefined,
    run: async (_source: string, scope: string, fn: () => Promise<number>, meta: { commit?: string | null } = {}) => {
      try {
        const n = await fn();
        runs.push({ scope, error: null, commit: meta.commit ?? null });
        return n;
      } catch (err) {
        runs.push({ scope, error: String((err as Error).message), commit: meta.commit ?? null });
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
      query: async (sql: string, p: any[] = []) => {
        const all = [...rows.values()];
        if (sql.startsWith("UPDATE")) for (const r of all) if (r.target === p[0] && r.tool === p[1] && r.present) r.last_seen = p[2];
        if (sql.includes("DISTINCT target")) return { rows: [...new Set(all.filter((r) => r.present).map((r) => r.target))].map((target) => ({ target })) };
        return { rows: all.filter((r) => r.target === p[0] && r.tool === p[1] && r.present) };
      },
    },
  };
  return { store: store as unknown as SourceStore, rows, runs };
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

  // A day later: the same findings write nothing (no re-delivery), last_seen still moves; the openssl image is gone.
  now += 86_400_000;
  sboms["repo.json"] = { matches: [match("lodash", "4.17.20", "CVE-2021-23337", "/a/package-lock.json")] };
  delete sboms["image.json"];
  const second = await scanPass(store, { ...deps, readBatch: async () => ({ ...batch(), targets: batch().targets.filter((t) => !t.target.startsWith("image:")) }) });
  expect(second).toBe(3); // lodash's locations changed on both repo targets (one path fewer) + openssl resolved
  expect(rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")!.last_seen).toEqual(new Date(now));
  expect(rows.get("image:aidenhq/board:local|openssl|3.0.1|CVE-2024-0001")).toMatchObject({ present: false, resolved_at: new Date(now) });

  // A stale batch (the host timer stopped) resolves nothing and is reported.
  now += 86_400_000;
  expect(await scanPass(store, { ...deps, readBatch: async () => ({ finishedAt: new Date(now - 5 * 86_400_000), targets: [] }) })).toBe(0);
  expect(rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")!.present).toBe(true);
  expect(runs.find((r) => r.scope === "sbom-batch")?.error).toMatch(/host timer/);
});
