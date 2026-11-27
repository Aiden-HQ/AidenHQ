// `local/*` apps (codehost-local): built from their bare repo on this server, and previewed from its change requests
// (refs/changes/<n>/*, which only the runner writes; here written by hand as it does).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { codeHostOps, localChanges, withLocal } from "../src/codehost.js";
import { createEngine } from "../src/deploy.js";
import { checkout, checkoutPr, commitPush, syncRegistry } from "../src/git.js";
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

// GitHub repos: the kernel's typed code host operations, run here against a fake kernel.
type Seen = { op: string; body: any };
async function fakeKernel(answer: (op: string, body: any) => { status?: number; json?: unknown; bytes?: Buffer }) {
  const seen: Seen[] = [];
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const op = req.url!.replace("/v1/codehost/", ""), body = JSON.parse(raw || "{}");
    seen.push({ op, body });
    const a = answer(op, body);
    if (a.bytes) res.writeHead(200, { "content-type": "application/octet-stream" }).end(a.bytes);
    else res.writeHead(a.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(a.json ?? {}));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { seen, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() };
}

describe("code host ops", () => {
  it("registry push is one commit op: on the synced head, with no git push", async () => {
    const t = mkdtempSync(`${tmpdir()}/reg-`);
    sh(t, "init", "-q", "-b", "main", "registry");
    writeFileSync(`${t}/registry/apps.yaml`, "apps: []\n");
    sh(`${t}/registry`, "add", "-A"), sh(`${t}/registry`, "commit", "-qm", "init");
    const head = sh(`${t}/registry`, "rev-parse", "HEAD");
    writeFileSync(`${t}/registry/apps.yaml`, "apps:\n  - name: demo\n");
    const k = await fakeKernel(() => ({ json: { sha: "c".repeat(40) } }));
    try {
      await commitPush({ appsData: "/a", gitDir: "/g", ops: codeHostOps(k.url, "key") }, `${t}/registry`, "apps.yaml", "apps: add demo", "https://github.com/acme/aidenhq-instance.git");
      expect(k.seen).toEqual([{ op: "commit", body: { repo: "acme/aidenhq-instance", branch: "main", path: "apps.yaml", content: "apps:\n  - name: demo\n", parent: head, message: "apps: add demo" } }]);
      expect(sh(`${t}/registry`, "rev-parse", "HEAD")).toBe(head); // nothing committed locally
    } finally { k.close(); }
  });
  it("fetch writes the bundle and fetches it into the app's bare repo; the registry sync resets onto it", async () => {
    const t = mkdtempSync(`${tmpdir()}/bundle-`);
    sh(t, "init", "-q", "-b", "main", "src");
    writeFileSync(`${t}/src/apps.yaml`, "apps: []\n");
    sh(`${t}/src`, "add", "-A"), sh(`${t}/src`, "commit", "-qm", "init");
    const head = sh(`${t}/src`, "rev-parse", "HEAD");
    sh(`${t}/src`, "bundle", "create", "-q", `${t}/main.bundle`, "main");
    const k = await fakeKernel(() => ({ bytes: readFileSync(`${t}/main.bundle`) }));
    try {
      const ops = codeHostOps(k.url, "key");
      sh(t, "init", "-q", "--bare", "app.git");
      await ops.fetch("acme/app", "refs/heads/*", `${t}/app.git`);
      expect(sh(t, "--git-dir", `${t}/app.git`, "rev-parse", "refs/remotes/origin/main")).toBe(head);
      await syncRegistry({ appsData: "/a", gitDir: "/g", ops }, `${t}/registry`, "https://github.com/acme/aidenhq-instance.git");
      expect(readFileSync(`${t}/registry/apps.yaml`, "utf8")).toBe("apps: []\n");
      expect(k.seen.map((x) => [x.op, x.body.repo, x.body.ref])).toEqual([["fetch", "acme/app", "refs/heads/*"], ["fetch", "acme/aidenhq-instance", "refs/heads/main"]]);
    } finally { k.close(); }
  });
});
