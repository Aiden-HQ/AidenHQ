import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOrg } from "../src/git.js";
import { appTokens, readAgentsOrg, readOrgs, withGitToken } from "../src/github-app.js";
import type { App } from "../src/registry.js";

const inst = (yaml: string) => {
  const d = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(d, "instance.yaml"), yaml);
  return d;
};
const app = (repo: string) => ({ name: "x", repo, untrusted: false }) as App;
const env = (agentsOrg?: string) => ({ appsData: "/a", gitDir: "/g", orgs: ["example-org"], ...(agentsOrg ? { agentsOrg } : {}) });

describe("agents org from instance settings", () => {
  it("uses github_agents_org, else aidenhq-<instance_name>, else none", () => {
    expect(readAgentsOrg(inst("settings:\n  instance_name: demo\n  github_agents_org: my-agents\n"))).toBe("my-agents");
    expect(readAgentsOrg(inst("settings:\n  instance_name: demo\n"))).toBe("aidenhq-demo");
    expect(readAgentsOrg(inst("modules: []\n"))).toBeUndefined();
    expect(readOrgs(inst("settings:\n  github_orgs: [Example-Org, acme]\n"))).toEqual(["Example-Org", "acme"]);
  });
  it("allows the agents org alongside the configured list, and nothing else", () => {
    const e = env(readAgentsOrg(inst("settings:\n  instance_name: demo\n")));
    expect(() => checkOrg(e, app("aidenhq-demo/roadmap-keeper"))).not.toThrow();
    expect(() => checkOrg(e, app("AidenHQ-Demo/roadmap-keeper"))).not.toThrow();
    expect(() => checkOrg(e, app("example-org/notes"))).not.toThrow();
    expect(() => checkOrg(e, app("EXAMPLE-ORG/x"))).not.toThrow();
    expect(() => checkOrg(e, app("someone/else"))).toThrow(/outside the allowed orgs/);
    expect(() => checkOrg(env(), app("aidenhq-demo/roadmap-keeper"))).toThrow(/outside the allowed orgs/);
  });
});

describe("token git args", () => {
  it("carries the token only in env, behind a reset credential helper and hardened config", () => {
    const { args, env: e } = withGitToken(["fetch", "https://github.com/o/r.git"], { PATH: "/bin" }, "ghs_SECRET");
    expect(args.join(" ")).not.toContain("ghs_SECRET");
    expect(e.AIDENHQ_GIT_TOKEN).toBe("ghs_SECRET");
    expect(e.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(e.PATH).toBe("/bin");
    const reset = args.indexOf("credential.helper=");
    expect(reset).toBeGreaterThan(-1);
    expect(args.findIndex((a) => a.startsWith("credential.helper=!"))).toBeGreaterThan(reset);
    expect(args).toContain("core.hooksPath=/dev/null");
    expect(args).toContain("core.fsmonitor=");
    expect(args.slice(-2)).toEqual(["fetch", "https://github.com/o/r.git"]);
  });
});

describe("registry pull/push args", () => {
  const url = "https://github.com/example-org/aidenhq-instance.git";
  const asked: string[] = [];
  const appToken = async (slug: string, perm = "read") => (asked.push(`${slug}:${perm}`), `ghs_${perm}`);
  const withApp = { appsData: "/a", gitDir: "/g", agentsOrg: "example-org", appToken, sshCommand: "ssh -i k" };

  it("fetches from the https URL with a read token and pushes with a write token, behind a cleared credential helper", async () => {
    const { registryCmd } = await import("../src/git.js");
    const pull = await registryCmd(withApp, "fetch", url);
    expect(pull.args.slice(pull.args.indexOf("credential.helper=") - 1, pull.args.indexOf("credential.helper=") + 1)).toEqual(["-c", "credential.helper="]);
    expect(pull.args.indexOf("credential.helper=")).toBeLessThan(pull.args.findIndex((a) => a.startsWith("credential.helper=!")));
    expect(pull.args.slice(-3)).toEqual(["fetch", url, "main"]);
    expect(pull.env.AIDENHQ_GIT_TOKEN).toBe("ghs_read");
    expect(pull.env.GIT_SSH_COMMAND).toBeUndefined();
    const push = await registryCmd(withApp, "push", url);
    expect(push.args.slice(-3)).toEqual(["push", url, "HEAD:main"]);
    expect(push.env.AIDENHQ_GIT_TOKEN).toBe("ghs_write");
    expect([...pull.args, ...push.args].join(" ")).not.toContain("ghs_");
    expect(asked).toEqual(["example-org/aidenhq-instance:read", "example-org/aidenhq-instance:write"]);
  });
});

describe("registry clone", () => {
  it("pushes only the registration to main while the apply's checkout sits on a local revert commit", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { syncRegistry, commitPush } = await import("../src/git.js");
    const { appendApp } = await import("../src/registry.js");
    const root = mkdtempSync(`${tmpdir()}/reg-`);
    const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
    sh(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    sh(root, "clone", "-q", "remote.git", "checkout");
    writeFileSync(`${root}/checkout/apps.yaml`, "apps: []\n");
    sh(`${root}/checkout`, "add", "."); sh(`${root}/checkout`, "commit", "-qm", "init"); sh(`${root}/checkout`, "push", "-q", "origin", "HEAD:main");
    sh(`${root}/checkout`, "checkout", "-q", "--detach");
    writeFileSync(`${root}/checkout/revert.txt`, "local revert\n");
    sh(`${root}/checkout`, "add", "."); sh(`${root}/checkout`, "commit", "-qm", "local revert");
    const env = { appsData: "/a", gitDir: "/g" }, url = `${root}/remote.git`;
    await syncRegistry(env, `${root}/registry`, url);
    appendApp(`${root}/registry/apps.yaml`, { name: "demo" });
    await commitPush(env, `${root}/registry`, "apps.yaml", "apps: add demo", url);
    expect(sh(root, "-C", "remote.git", "log", "--format=%s", "main")).toBe("apps: add demo\ninit");
    expect(sh(root, "-C", "remote.git", "show", "main:apps.yaml")).toContain("demo");
    expect(readFileSync(`${root}/checkout/revert.txt`, "utf8")).toBe("local revert\n"); // the checkout is untouched
  });
});

describe("the App's bot login", () => {
  it("is the slug the kernel reports with a token, as <slug>[bot]", async () => {
    const tokens = appTokens("http://kernel", "k", (async () => Response.json({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString(), app: { slug: "acme-agents" } })) as typeof fetch);
    expect(tokens.botLogin).toBeUndefined();
    await tokens("acme-agents/aidenhq-instance");
    expect(tokens.botLogin).toBe("acme-agents[bot]");
  });
});
