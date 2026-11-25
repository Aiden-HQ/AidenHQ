// The image-scan check (the product's CI and the app CI template). Its selection step, run for real on a scratch repo: a
// Dockerfile a PR changes is always selected, whatever its FROM (a `FROM $X` it can't resolve fails the scan; it is never
// skipped), a module.yaml-only service image re-pin selects that registry image, and a change that touches no image selects
// nothing. And its Dockerfile reader (supply-chain/image-scan.ts), which names the only images grype pulls: it refuses
// anything but a plain digest-pinned reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { bases, ignored, plan } from "../supply-chain/image-scan.ts";

const root = join(import.meta.dirname, "../..");
// The product's CI: its `find` step selects the service images a module.yaml-only change re-pins (an app repo's template has
// no modules/, so it is unchanged there).
const findStep = () => { const { jobs } = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")); return jobs.checks.steps.find((s: { id: string }) => s.id === "find").run; };
// A scratch repository of its own, with a git and a put bound to it.
const scratch = (t: { after: (f: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "image-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env, stdio: "pipe" }).toString().trim();
  const put = (p: string, text: string) => (mkdirSync(join(dir, dirname(p)), { recursive: true }), writeFileSync(join(dir, p), text));
  git("init", "-q", "-b", "main");
  return { dir, git, put, env };
};

test("image-changes selects a module.yaml-only service image re-pin, and never an agent-level image line", (t) => {
  const { dir, git, put, env } = scratch(t);
  // The step reads services.run through the repository's own parser (scripts/supply-chain/pins.ts), as CI runs it.
  put("scripts/supply-chain/pins.ts", readFileSync(join(root, "scripts/supply-chain/pins.ts"), "utf8"));
  put("scripts/supply-chain/best-version.ts", readFileSync(join(root, "scripts/supply-chain/best-version.ts"), "utf8"));
  const d = (c: string) => `@sha256:${c.repeat(64)}`;
  const manifest = (ref: string, agent = "agent-base") => `name: primer\nagents:\n  ui-designer:\n    image: ${agent}\nservices:\n  run:\n    primer-db:\n      image: ${ref}\n    primer-server:\n      build: ./server\n`;
  // A quoted service key (`"primer-db":`) is the same service to the compiler, so the selector must read it too.
  put("modules/primer/module.yaml", manifest(`postgres:17.12${d("a")}`).replace("    primer-db:", '    "primer-db":'));
  put("modules/design/module.yaml", manifest(`postgres:17.12${d("a")}`, "agent-base"));
  put("README.md", "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  // The step run for real on the scratch repo, as CI runs it: both outputs it writes.
  const select = () => {
    const head = git("rev-parse", "HEAD"), out = join(dir, "out");
    writeFileSync(out, "");
    execFileSync("bash", ["-c", findStep()], { cwd: dir, env: { ...env, BASE_SHA: base, PR_BASE: base, HEAD_SHA: head, GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: "pull_request" }, stdio: "pipe" });
    return readFileSync(out, "utf8").trim();
  };
  // A docs-only change, and a change to the agent-level `image:` line alone, select nothing.
  put("README.md", "y\n");
  git("commit", "-qam", "docs");
  assert.equal(select(), "dockerfiles=\nservices=");
  put("modules/design/module.yaml", manifest(`postgres:17.12${d("a")}`, "engineer"));
  git("commit", "-qam", "agent image");
  assert.equal(select(), "dockerfiles=\nservices=");
  // A module.yaml-only re-pin of the service image selects that registry image (and no Dockerfile).
  put("modules/primer/module.yaml", manifest(`postgres:17.12${d("b")}`).replace("    primer-db:", '    "primer-db":'));
  git("commit", "-qam", "re-pin");
  assert.equal(select(), `dockerfiles=\nservices=postgres:17.12${d("b")}`);
  // The forms the compiler reads as the same ref select too: a plain scalar continued on the next line, and a `build:` with
  // only a comment after it (YAML null, so the service still names an image).
  const multiline = `name: primer\nservices:\n  run:\n    primer-db:\n      build: # use the published image\n      image:\n        postgres:17.12${d("c")}\n`;
  put("modules/primer/module.yaml", multiline);
  git("commit", "-qam", "re-pin, multi-line");
  assert.equal(select(), `dockerfiles=\nservices=postgres:17.12${d("c")}`);
  // A comment line between `image:` and its value is skipped by YAML too: the ref below it is still the service's image.
  put("modules/primer/module.yaml", `name: primer\nservices:\n  run:\n    primer-db:\n      image:\n        # the db\n        postgres:17.12${d("e")}\n`);
  git("commit", "-qam", "re-pin, comment line");
  assert.equal(select(), `dockerfiles=\nservices=postgres:17.12${d("e")}`);
  // A bare `build:` with a real value is this repository's own image: it selects nothing.
  put("modules/primer/module.yaml", `name: primer\nservices:\n  run:\n    primer-db:\n      build: ./server\n      image: postgres:17.12${d("d")}\n`);
  git("commit", "-qam", "built");
  assert.equal(select(), "dockerfiles=\nservices=");
});

test("plan scans a selected service image from the registry, never as a build", (t) => {
  const d = "@sha256:" + "a".repeat(64);
  const ref = `postgres:17.12${d}`;
  // A service image with no Dockerfile is a registry target, whole: no per-path Dockerfile exception can hold for it.
  const p = plan([], { root, services: [ref] });
  assert.deepEqual(p.dirs, []);
  assert.deepEqual(p.images, [{ ref, uses: [], service: true }]);
  // A Dockerfile that also names the image keeps its uses, but the image stays a service target: its direct use is kept so a
  // Dockerfile-only path exception can never hide a finding in the registry image the service actually runs.
  const { dir, put } = scratch(t);
  put("db/Dockerfile", `FROM ${ref}\n`);
  const both = plan(["db/Dockerfile"], { root: dir, services: [ref] });
  assert.deepEqual(both.images, [{ ref, uses: [{ final: true, finalRuns: [], copies: [], mounted: false, df: "db/Dockerfile" }], service: true }]);
  // And such an image ignores no path: its registry copy ships as published, whatever a Dockerfile does to its own.
  assert.deepEqual(ignored(both.images[0]!, [{ image: "postgres", path: "/var/lib/dpkg/status", when: "RUN true", reason: "a Dockerfile fix" }]).ignore, []);
});

test("the image-scan reader passes grype digest-pinned references only, and refuses injected or odd ones", () => {
  const d = "@sha256:" + "a".repeat(64);
  const node = `node:24.22.2-bookworm-slim${d}`;
  const text = [
    `# syntax=docker/dockerfile:1${d}`,
    `ARG BASE=${node}`,
    "# a comment inside the continuation",
    "FROM --platform=$BUILDPLATFORM \\",
    "  ${BASE} AS build",
    "RUN npm install -g npm@11.21.2",
    `from ghcr.io/acme/tool:1.2${d} AS tool`,
    "COPY --from=build /a /a",
    "COPY --from=0 /b /b",
    `COPY --from=docker.io/library/busybox:1${d} /bin/sh /sh`,
    "FROM build AS final",
  ].join("\r\n");
  // The final image is built on node (through the `build` alias); the other two only have files copied out of them.
  assert.deepEqual(bases(text).refs, [{ image: node, final: true }, { image: `ghcr.io/acme/tool:1.2${d}`, final: false }, { image: `docker.io/library/busybox:1${d}`, final: false }]);
  assert.deepEqual(bases("ARG BASE=acme/base\nFROM ${BASE}\n", new Set(["acme/base"])).refs, [{ local: "acme/base", final: true }]);
  assert.deepEqual(bases(`FROM ${node}\nRUN --mount=type=bind,FROM=ghcr.io/acme/x:1${d},target=/x true\n`).refs.map((r) => r.image), [node, `ghcr.io/acme/x:1${d}`]);
  for (const [bad, why] of [
    ["FROM node:24\n", /pinned by digest/], // a tag alone
    ["FROM acme/base\n", /pinned by digest/], // a name not declared --local is never pulled from a registry
    ["ARG BASE\nFROM $BASE\n", /no default/],
    [`FROM node${d}\nARG BASE=x\nFROM $BASE\n`, /no default/], // an ARG after the first FROM is a stage's, not global
    [`ARG B=node${d}\nFROM \${B:-evil}\n`, /plain ARG reference/],
    [`ARG B="node${d}"\nFROM $B\n`, /plain, unquoted/],
    [`ARG B=$(id)\nFROM node${d}\n`, /plain, unquoted/],
    [`FROM node${d};id\n`, /pinned by digest/],
    [`FROM node${d} AS x y\n`, /FROM <image>/],
    [`FROM --network=host node${d}\n`, /only --platform/],
    [`FROM -c${d}\n`, /only --platform/],
    [`FROM Node${d}\n`, /pinned by digest/],
    [`FROM node${d}\nCOPY --from=$X /a /a\n`, /variable/],
    [`FROM node${d}\nCOPY --from=evil:latest /a /a\n`, /pinned by digest/],
    // Directives BuildKit reads: indented, after a shebang, `//` style. Another escape or frontend changes the whole file.
    [`  # escape=\`\nFROM node${d}\n`, /no escape directive/],
    [`# syntax=acme/frontend:1${d}\nFROM node${d}\n`, /only docker\/dockerfile/],
    [`#!/bin/sh\n# syntax=acme/frontend:1${d}\nFROM scratch\n`, /only docker\/dockerfile/],
    [`// syntax=acme/frontend:1${d}\nFROM scratch\n`, /only docker\/dockerfile/],
    [`FROM --platform=linux/arm64 node${d}\n`, /only --platform=linux\/amd64/],
    // A heredoc's body could hide a stage name (`FROM scratch AS alpine`) that makes a real `FROM alpine` look local.
    [`FROM scratch\nCOPY <<EOF /data\nFROM scratch AS alpine\nEOF\nFROM alpine\n`, /heredoc/],
    [`FROM node${d}\nRUN --mount=type=bind,from=evil:1,target=/x true\n`, /pinned by digest/],
    [`FROM scratch\nRUN --mount=type=bind,FROM=evil:latest,target=/x true\n`, /pinned by digest/], // keys are case-insensitive
    [`FROM scratch\nRUN --mount=type=bind,"from=evil:latest",target=/x true\n`, /quoted/],
    [`FROM node${d}\nONBUILD COPY --from=evil:1 / /\n`, /ONBUILD/],
    ["FROM 0\n", /pinned by digest/], // FROM never takes a stage index: an image named 0
    ["RUN id\n", /before the first FROM/],
  ]) assert.throws(() => bases(bad), why, bad);
});
