import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeed } from "../src/zerowire.js";
import { DDL, parseTargets, readSbomBatch, scanPass, type Batch } from "../src/scan.js";
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
  const batch = (): Batch => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(), "/sbom"), imagesComplete: true });
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
  expect(second).toBe(3); // lodash's locations changed on both repo targets, and the absent image's one finding is settled
  expect(rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")!.last_seen).toEqual(new Date(now));
  // A complete batch with no row that could be this image settles it: no container runs it and no configured image names
  // it, so the target retires with no replacement instead of staying absent with an error. The last row is this pass's
  // (the first pass's clean scan is still in `runs`).
  expect(rows.get("image:aidenhq/board:local|openssl|3.0.1|CVE-2024-0001")).toMatchObject({ present: false, resolved_reason: /retired: no container runs this image and no configured image names it/ });
  expect(runs.filter((r) => r.scope === "image:aidenhq/board:local").at(-1)).toMatchObject({ status: "retired", error: null });

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
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(targets), "/sbom"), imagesComplete: true }),
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
  expect(await scanPass(store, deps([replacement]))).toBe(3); // the retired target's two findings and the unmapped target's one

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

  // An image that is neither mapped nor a configured computer image retires too: the batch is complete and nothing in it
  // could be this image, so no container runs it and no configured image names it.
  expect(runs.find((x) => x.scope === unmapped)).toMatchObject({ status: "retired", error: null });
  expect(rows.get(unmappedRow)).toMatchObject({ present: false, resolved_reason: /retired: no container runs this image and no configured image names it/ });
});

it("src_security: an absent image target retires against the one clean target of its repository in this pass", async () => {
  const { store, rows, runs } = fakeStore();
  const oldTag = "image:aidenhq/computer-engineer:4a2fffc5559e";
  const newTag = "image:aidenhq/computer-engineer:7e675bb4ff85";
  const otherRepo = "image:aidenhq/computer-agent-base:8c5210bf54bb";
  const sboms: Record<string, unknown> = {
    "old.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status"), match("zlib", "1.2.11", "CVE-2022-37434", "/usr/lib/libz.so")] },
    "new.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/usr/bin/git")] },
    "other.json": { matches: [match("curl", "7.88.1", "CVE-2023-0001", "/usr/bin/curl")] },
  };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const index = (targets: string[]): string => targets.map((t) => `${t}\t${t === oldTag ? "old" : t === newTag ? "new" : "other"}.json\t\t`).join("\n");
  const deps = (targets: string[]) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(targets), "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps([oldTag, otherRepo]))).toBe(3);
  const retiredOnly = `${oldTag}|zlib|1.2.11|CVE-2022-37434`;
  const carried = `${oldTag}|openssl|3.0.1|CVE-2024-0001`;

  // Next pass: the tag is gone (the image was rebuilt by content hash and the old one pruned); its repository's new tag
  // was scanned, and the other repository's target is unrelated. Nothing in the shipped map names either tag.
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps([newTag, otherRepo]))).toBe(3); // the new tag's finding, and the retired target's two

  // Exactly one same-repository target was scanned cleanly, so it is the replacement: retired, no error, findings settled
  // against it (one it carries is covered, one it does not is gone).
  const run = runs.find((x) => x.scope === oldTag)!;
  expect(run).toMatchObject({ status: "retired", error: null });
  expect(runs.filter((x) => x.scope === oldTag)).toHaveLength(1);
  expect(rows.get(retiredOnly)).toMatchObject({ present: false, resolved_reason: expect.stringContaining(newTag) });
  expect(rows.get(retiredOnly)!.resolved_reason).toMatch(/does not report/);
  expect(rows.get(carried)).toMatchObject({ present: false, resolved_reason: expect.stringContaining(newTag) });
  expect(rows.get(carried)!.resolved_reason).toMatch(/covered by replacement/);
  expect(rows.get(`${newTag}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: an absent image with no same-repository target in a complete batch retires without claiming one", async () => {
  const { store, rows, runs } = fakeStore();
  const gone = "image:aidenhq/computer-agent-base:cb94c7b36572";
  const mapped = "image:aidenhq/github-mcp:local";
  const sboms: Record<string, unknown> = {
    "gone.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] },
    "mapped.json": { matches: [match("curl", "7.88.1", "CVE-2023-0001", "/usr/bin/curl")] },
    "unrelated.json": { matches: [match("bash", "5.2.15", "CVE-2024-0002", "/usr/bin/bash")] },
  };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const index = (targets: string[]): string => targets.map((t) => `${t}\t${t === gone ? "gone" : t === mapped ? "mapped" : "unrelated"}.json\t\t`).join("\n");
  const deps = (targets: string[]) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(targets), "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps([gone, mapped]))).toBe(2);
  now += 86_400_000;
  runs.length = 0;
  // Only another repository's image is in the batch: neither absent target has a same-repository target to retire against.
  expect(await scanPass(store, deps(["image:aidenhq/board:local"]))).toBe(3); // the board scan and both absent images' retirements

  // An image may retire claiming no replacement: the batch listed every planned unit and nothing in it could be this one.
  const computer = runs.find((x) => x.scope === gone)!;
  expect(computer).toMatchObject({ status: "retired", error: null });
  expect(runs.filter((x) => x.scope === gone)).toHaveLength(1);
  expect(rows.get(`${gone}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: false, resolved_reason: /retired: no container runs this image and no configured image names it/ });

  // Any other image with no same-repository target in the batch retires the same way: the batch listed every planned unit
  // and nothing in it could be this image.
  expect(runs.find((x) => x.scope === mapped)).toMatchObject({ status: "retired", error: null });
  expect(rows.get(`${mapped}|curl|7.88.1|CVE-2023-0001`)).toMatchObject({ present: false, resolved_reason: /retired: no container runs this image and no configured image names it/ });
});

it("src_security: a dead digest-pinned tag with no same-repository scan retires with no replacement", async () => {
  // A replaced database image: its old digest no longer runs and no configured image names it, and the pass scanned no
  // postgres target at all, so there is no replacement to name. A complete batch with no failed row that could be it is
  // proof enough to retire it, exactly as for a computer image or a bare id.
  const { store, rows, runs } = fakeStore();
  const dead = `image:postgres:17.12@sha256:${"d".repeat(64)}`;
  const sboms: Record<string, unknown> = { "dead.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] } };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${dead}\tdead.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps("image:ghcr.io/example/paperclip:2026.1117.0\tdead.json\t\t"))).toBe(2); // the other image's scan and this retirement
  const run = runs.find((x) => x.scope === dead)!;
  expect(run).toMatchObject({ status: "retired", error: null });
  expect(runs.filter((x) => x.scope === dead)).toHaveLength(1);
  expect(rows.get(`${dead}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: false, resolved_reason: /retired: no container runs this image and no configured image names it/ });
});

it("src_security: an image target absent from a batch that does not claim a complete inventory keeps the absent error", async () => {
  // A batch written before the writer listed configured images, or one whose writer could not list all of them, has a
  // freshness stamp like any other. Its absence is not proof: an image it would have listed must not settle its findings.
  const { store, rows, runs } = fakeStore();
  const target = "image:aidenhq/computer-engineer:4a2fffc5559e";
  const sboms: Record<string, unknown> = { "engineer.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] } };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const index = (targets: string[]): string => targets.map((t) => `${t}\tengineer.json\t\t`).join("\n");
  const deps = (targets: string[], imagesComplete?: boolean) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(targets), "/sbom"), ...(imagesComplete ? { imagesComplete } : {}) }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps([target], true))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps([]))).toBe(0);
  expect(runs.find((x) => x.scope === target)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(`${target}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: a clean sibling does not retire an absent image while another target of its repository failed", async () => {
  // The absent hash tag may be the image running under the failed alias (an alias the survey scans in the alias's own
  // name); the clean new hash says nothing about that, so nothing may settle until the repository scans cleanly.
  const { store, rows, runs } = fakeStore();
  const oldHash = "image:aidenhq/computer-browser:b000";
  const alias = "image:aidenhq/computer-browser:current";
  const newHash = "image:aidenhq/computer-browser:h2";
  const sboms: Record<string, unknown> = {
    "old.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] },
    "new.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/usr/bin/openssl")] },
  };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${oldHash}\told.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(`${newHash}\tnew.json\t\t\n${alias}\t-\tdocker save: no room\t`))).toBe(1);
  // The failed alias is itself a present target the batch listed, so it records why it could not scan, and the old hash's
  // finding stays present because the repository did not scan cleanly.
  expect(runs.find((x) => x.scope === alias)?.error).toMatch(/no room/);
  expect(runs.find((x) => x.scope === oldHash)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(`${oldHash}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: a mapped replacement that is listed but did not scan cleanly keeps the mapped target unverified", async () => {
  // A cross-repository rename's replacement is only a replacement once it scanned: a listed target whose export failed
  // verified nothing, so the retired name's findings stay present.
  const { store, rows, runs } = fakeStore();
  const retired = "image:aidenhq/github-mcp:local";
  const replacement = "image:aidenhq/github-github:local";
  const sboms: Record<string, unknown> = { "retired.json": { matches: [match("curl", "7.88.1", "CVE-2023-0001", "/usr/bin/curl")] } };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${retired}\tretired.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(`${replacement}\t-\tdocker save: no room\t`))).toBe(0);
  expect(runs.find((x) => x.scope === retired)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(`${retired}|curl|7.88.1|CVE-2023-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: an absent image whose repository is in the batch but did not scan cleanly keeps the absent error", async () => {
  // A render may run the same image under an alias (`computer-browser:current`) the survey deduplicated away: the alias
  // is in the batch, the hash tag is not, and the alias's scan failed. That is not proof the hash tag's image is gone.
  const { store, rows, runs } = fakeStore();
  const hashTag = "image:aidenhq/computer-browser:h1";
  const alias = "image:aidenhq/computer-browser:current";
  const sboms: Record<string, unknown> = { "hash.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] } };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${hashTag}\thash.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(`${alias}\t-\tdocker save: no room\t`))).toBe(0);
  expect(runs.find((x) => x.scope === hashTag)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(`${hashTag}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: an absent bare digest target retires with no replacement, since no running container or configured image names it", async () => {
  // A container keyed by its own image id names no repository, so no other image can claim to replace it. It is still
  // dead when a complete batch does not list it: the writer keys every running container on the id of the image it runs
  // and every configured image on its tag, so an id the batch omits is one nothing runs and no configured image names.
  const { store, rows, runs } = fakeStore();
  const digest = `image:sha256:${"a".repeat(64)}`;
  const sboms: Record<string, unknown> = { "digest.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] } };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${digest}\tdigest.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps("image:aidenhq/computer-engineer:h2\th2.json\t\t\nimage:aidenhq/computer-engineer:h3\th3.json\t\t"))).toBe(1); // the digest's finding
  const run = runs.find((x) => x.scope === digest)!;
  expect(run).toMatchObject({ status: "retired", error: null });
  expect(runs.filter((x) => x.scope === digest)).toHaveLength(1);
  expect(rows.get(`${digest}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: false, resolved_reason: /retired: no container runs this image and no configured image names it/ });
});

it("src_security: a bare digest target that failed in this batch does not retire", async () => {
  // The row names a running container whose image could not be inventoried, so its absence from the clean rows is not
  // proof it is dead: its findings stay present and the target keeps the failure, exactly as for any other image.
  const { store, rows, runs } = fakeStore();
  const digest = `image:sha256:${"b".repeat(64)}`;
  const sboms: Record<string, unknown> = { "digest.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] } };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${digest}\tdigest.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(`${digest}\t-\tdocker image inspect: invalid reference format\t`))).toBe(0);
  expect(runs.find((x) => x.scope === digest)).toMatchObject({ status: null, error: expect.stringMatching(/invalid reference format/) });
  expect(rows.get(`${digest}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: a running image that failed under its own digest keeps an absent image of its repository unverified", async () => {
  // An old browser image may run under a bare `image:sha256:…` key (a container keyed by its image id), and that row's
  // export failed while the new configured hash scanned cleanly. The digest names no repository, so only its failure says
  // the old hash's image may still be running: it must not be retired against the clean hash.
  const { store, rows, runs } = fakeStore();
  const oldHash = "image:aidenhq/computer-browser:b000";
  const newHash = "image:aidenhq/computer-browser:h2";
  const digest = `image:sha256:${"d".repeat(64)}`;
  const sboms: Record<string, unknown> = {
    "old.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/var/lib/dpkg/status")] },
    "new.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/usr/bin/openssl")] },
  };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${oldHash}\told.json\t\t`))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(`${newHash}\tnew.json\t\t\n${digest}\t-\tdocker save: no room\t`))).toBe(1);
  expect(runs.find((x) => x.scope === digest)?.error).toMatch(/no room/);
  expect(runs.find((x) => x.scope === oldHash)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(`${oldHash}|openssl|3.0.1|CVE-2024-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: a mapped image retirement also needs a batch that claims a complete image inventory", async () => {
  // The map (a cross-repository rename) is evidence of what replaced what, never that the replacement ran: a batch short
  // of its own units may also be one whose writer listed no replacement at all. Only a complete batch may settle.
  const { store, rows, runs } = fakeStore();
  const retired = "image:aidenhq/github-mcp:local";
  const replacement = "image:aidenhq/github-github:local";
  const sboms: Record<string, unknown> = {
    "retired.json": { matches: [match("curl", "7.88.1", "CVE-2023-0001", "/usr/bin/curl")] },
    "replacement.json": { matches: [match("curl", "7.88.1", "CVE-2023-0001", "/usr/bin/curl")] },
  };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const deps = (index: string, imagesComplete?: boolean) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index, "/sbom"), ...(imagesComplete ? { imagesComplete } : {}) }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(`${retired}\tretired.json\t\t`, true))).toBe(1);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(`${replacement}\treplacement.json\t\t`))).toBe(1); // the replacement's own scan
  expect(runs.find((x) => x.scope === retired)).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get(`${retired}|curl|7.88.1|CVE-2023-0001`)).toMatchObject({ present: true, resolved_at: null });
});

it("src_security: a batch is read from one generation, even after the writer swaps current/ mid-read", () => {
  // The writer replaces current/ wholesale (the old one moves to prev/, the new one in). A pass reading targets.tsv,
  // images.complete and the SBOMs through separate opens of the path could pair one generation's target list with
  // another's files, or read a removed file as a missing one. One handle on the directory pins the generation.
  const root = mkdtempSync(join(tmpdir(), "scanner-batch-"));
  const current = join(root, "current");
  const prev = join(root, "prev");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "targets.tsv"), "image:aidenhq/board:local\t001.json\t\t\n");
  writeFileSync(join(current, "001.json"), '{"matches":[{"generation":"old"}]}');
  writeFileSync(join(current, "images.complete"), "");
  const batch = readSbomBatch(current);
  // The writer's swap: current/ becomes the next generation, the generation this pass opened is moved away.
  rmSync(prev, { recursive: true, force: true });
  renameSync(current, prev);
  mkdirSync(current);
  writeFileSync(join(current, "targets.tsv"), "host\t-\tnew pass\t\n");
  writeFileSync(join(current, "images.complete"), "");
  expect(batch.imagesComplete).toBe(true);
  expect(batch.targets.map((t) => t.target)).toEqual(["image:aidenhq/board:local"]);
  // The SBOM path still reaches the generation the index came from, not the new generation's name for it.
  expect(JSON.parse(readFileSync(batch.targets[0]!.file!, "utf8")).matches[0].generation).toBe("old");
  expect(readSbomBatch(join(root, "missing"))).toEqual({ finishedAt: null, targets: [] });
  rmSync(root, { recursive: true, force: true });
});

it("src_security: a non-image target absent from a fresh batch keeps the absent error, since the batch does not enumerate it", async () => {
  const { store, rows, runs } = fakeStore();
  const sboms: Record<string, unknown> = {
    "product.json": { matches: [match("lodash", "4.17.20", "CVE-2021-23337", "/a/package-lock.json")] },
    "host.json": { matches: [match("openssl", "3.0.1", "CVE-2024-0001", "/usr/lib/libssl.so")] },
  };
  let now = Date.parse("2026-11-25T00:00:00Z");
  const index = (targets: string[]): string => targets.map((t) => `${t}\t${t === "repo:product" ? "product" : "host"}.json\t\t`).join("\n");
  const deps = (targets: string[]) => ({
    dbUpdate: async () => undefined,
    readBatch: async (): Promise<Batch> => ({ finishedAt: new Date(now - 3_600_000), targets: parseTargets(index(targets), "/sbom"), imagesComplete: true }),
    grype: async (f: string) => sboms[f.split("/").pop()!],
    now: () => now,
  });

  expect(await scanPass(store, deps(["repo:product", "host"]))).toBe(2);
  now += 86_400_000;
  runs.length = 0;
  expect(await scanPass(store, deps(["host"]))).toBe(0);
  expect(runs.find((x) => x.scope === "repo:product")).toMatchObject({ status: null, error: expect.stringMatching(/absent from this pass's SBOM inventory/) });
  expect(rows.get("repo:product|lodash|4.17.20|CVE-2021-23337")).toMatchObject({ present: true, resolved_at: null });
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
      { ...match("zlib", "1.2.11", "CVE-2022-37434", "/c"), vulnerability: { ...match("x", "1", "CVE-2022-37434", "/c").vulnerability, ...(epss === 0.4 ? { epss: [{ epss: 0.3, percentile: 0.8 }] } : {}) } },
    ],
  });
  let epss = 0.4;
  const deps = {
    dbUpdate: async () => undefined,
    readBatch: async () => ({ finishedAt: new Date(Date.now() - 1000), targets: parseTargets("image:x\tx.json\t\t", "/sbom"), imagesComplete: true }),
    grype: async () => grypeJson(epss),
  };
  expect(await scanPass(store, deps)).toBe(3);
  expect(rows.get("image:x|openssl|3.0.1|CVE-2024-0002")).toMatchObject({ kev: true, kev_added: "2026-10-26", epss: 0.4, epss_percentile: 0.97 });
  expect(rows.get("image:x|lodash|4.17.20|GHSA-aaaa-bbbb-cccc")).toMatchObject({ kev: true, kev_added: "2025-01-02", epss: 0.5, epss_percentile: 0.95 });
  expect(rows.get("image:x|zlib|1.2.11|CVE-2022-37434")).toMatchObject({ kev: null, kev_added: null, epss: 0.3, epss_percentile: 0.8 });
  epss = 0.45; // a daily EPSS move updates the score but is not a change worth re-delivering
  expect(await scanPass(store, deps)).toBe(0);
  expect(rows.get("image:x|openssl|3.0.1|CVE-2024-0002")?.epss).toBe(0.45);
  expect(rows.get("image:x|zlib|1.2.11|CVE-2022-37434")).toMatchObject({ epss: null, epss_percentile: null }); // grype dropped the score: cleared
});

it("src_security: the DDL adds the exploitation columns additively and the view exposes them", () => {
  for (const c of ["kev boolean", "kev_added date", "epss real", "epss_percentile real"]) expect(DDL).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
  expect(DDL).toContain("f.kev, f.kev_added, f.epss, f.epss_percentile");
});

it("zero wire: the feed's briefings become rows with their CVE ids and exploitation sentences", () => {
  const item = (guid: string, title: string, body: string) =>
    `<item><title>${title}</title><link>https://radar.cloudflare.com/zero-wire/${guid}</link><guid isPermaLink="false">${guid}</guid><pubDate>Thu, 19 Nov 2026 00:00:00 GMT</pubDate><description>Prioritize patching. It&apos;s bad.</description><content:encoded><![CDATA[${body}]]></content:encoded></item>`;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>${item("a@2026-11-19", "phpAfterShell", "<p>CVE-2026-126714 and CVE-2026-129289 affect PHP. CISA added CVE-2026-126714 to its Known Exploited Vulnerabilities catalog. Upgrade.</p>")}${item("b@2026-11-18", "WordPress flaw", "<p>No CVE has been assigned. No source reports exploitation in the wild.</p>")}</channel></rss>`;
  const [a, b] = parseFeed(xml);
  expect(a).toMatchObject({ guid: "a@2026-11-19", title: "phpAfterShell", summary: "Prioritize patching. It's bad.", cves: ["CVE-2026-126714", "CVE-2026-129289"], published: new Date("2026-11-19T00:00:00Z") });
  expect(a!.exploitation).toContain("Known Exploited Vulnerabilities");
  expect(b).toMatchObject({ cves: [], exploitation: "No source reports exploitation in the wild." });
  expect(() => parseFeed("<html></html>")).toThrow("not RSS");
  expect(DDL).toContain("src_security.zerowire");
});
