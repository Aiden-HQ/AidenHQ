// `local/*` apps (codehost-local): built from their bare repo on this server, and previewed from its change requests
// (refs/changes/<n>/*, which only the runner writes; here written by hand as it does).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { localChanges, withLocal } from "../src/codehost.js";
import { createEngine } from "../src/deploy.js";
import { checkout, checkoutPr } from "../src/git.js";
import { previewApp, previewTick, type PreviewDeps } from "../src/previews.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", input: "" }).trim();

/** /codehost with local/app.git: main has app.txt, change 1 (branch feat/x) adds feature.txt. */
function server() {
  const t = mkdtempSync(`${tmpdir()}/codehost-`);
  const root = `${t}/codehost`;
  const bare = `${root}/local/app.git`;
  mkdirSync(`${root}/local`, { recursive: true });
  sh(t, "init", "-q", "-b", "main", "work");
  writeFileSync(`${t}/work/app.txt`, "main\n");
  sh(`${t}/work`, "add", "-A"), sh(`${t}/work`, "commit", "-qm", "main");
  const base = sh(`${t}/work`, "rev-parse", "HEAD");
  sh(`${t}/work`, "checkout", "-q", "-b", "feat/x");
  writeFileSync(`${t}/work/feature.txt`, "change\n");
  sh(`${t}/work`, "add", "-A"), sh(`${t}/work`, "commit", "-qm", "feature");
  const head = sh(`${t}/work`, "rev-parse", "HEAD");
  sh(t, "clone", "-q", "--bare", `${t}/work`, bare);
  const meta = execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], { input: JSON.stringify({ title: "x", body: "", branch: "feat/x", base: "main", opened_at: "2026-11-17T00:00:00Z", draft: true }), encoding: "utf8" }).trim();
  for (const [ref, sha] of [["head", head], ["base", base], ["meta", meta]]) sh(t, "--git-dir", bare, "update-ref", `refs/changes/1/${ref}`, sha!);
  return { t, root, bare, base, head };
}

const app = parseApp({ name: "app", repo: "local/app", owner: "a", description: "d", port: 8080, health: { url: "http://web:8080/health" } });

describe("local/* apps", () => {
  it("deploy from their bare repo on this server, and a change's preview checks out exactly its head", async () => {
    const s = server();
    const env = { appsData: `${s.t}/apps`, gitDir: `${s.t}/git`, localRoot: s.root };
    const co = await checkout(env, app);
    expect(co.sha).toBe(s.base);
    expect(readFileSync(`${co.dir}/app.txt`, "utf8")).toBe("main\n");
    const pr = await checkoutPr(env, previewApp(app, 1, 39101), s.head);
    expect(readFileSync(`${pr.dir}/feature.txt`, "utf8")).toBe("change\n");
    // Without codehost-local the org `local` is no allowed org.
    await expect(checkout({ appsData: `${s.t}/apps2`, gitDir: `${s.t}/git2` }, app)).rejects.toThrow(/outside the allowed orgs/);
    expect((await localChanges(s.root, "local/app")).map((c) => [c.number, c.state, c.into, c.draft])).toEqual([[1, "open", "main", true]]);
  });

  it("a preview of an open change comes up and is removed once the change merges", async () => {
    const s = server();
    const src = `${s.t}/src`;
    mkdirSync(src);
    writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
    const store = openStore(":memory:");
    const deployed: string[] = [];
    const engine = createEngine({
      store, appsData: `${s.t}/apps`, secretsDir: `${s.t}/secrets`, hostSecretsDir: "/host/secrets", identityKeysHostFile: "/host/keys.json", tailnetNode: () => true,
      exec: async (args) => (args.includes("config") ? JSON.stringify({ services: { web: { image: "x", ports: [{ mode: "ingress", target: 8080, published: "8080", protocol: "tcp" }] } } }) : args[0] === "compose" && args[1] === "ls" ? "[]" : ""),
      checkout: async (_a, sha) => (deployed.push(sha!), { sha: sha!, dir: src }),
      probe: async () => ({ ok: true, ms: 1 }),
      provisionDb: async () => undefined,
    });
    const d: PreviewDeps = {
      apps: () => [app], store, engine, secretsDir: `${s.t}/secrets`, gitDir: `${s.t}/git`,
      github: withLocal(s.root, undefined),
      agentsRepo: () => true,
      url: (a) => `https://apps.example.ts.net:${a.port}`,
      syncEdge: async () => undefined,
      dropDb: async () => undefined,
      log: { warn: () => undefined, info: () => undefined },
    };
    await previewTick(d);
    expect(store.previews().map((r) => [r.name, r.status, r.sha])).toEqual([["app-pr-1", "healthy", s.head]]);
    expect(deployed).toEqual([s.head]);
    // The runner merges change 1 (refs/changes/1/merged): the next pass removes its preview.
    sh(s.t, "--git-dir", s.bare, "update-ref", "refs/changes/1/merged", s.head);
    await previewTick(d);
    expect(store.previews()).toEqual([]);
  });
});
