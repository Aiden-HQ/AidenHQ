// The image-scan check (the product's CI and the app CI template). Its selection step, run for real on a scratch repo: a
// Dockerfile a PR changes is always selected, whatever its FROM (a `FROM $X` it can't resolve fails the scan; it is never
// skipped), and a change that touches no image selects nothing. And its Dockerfile reader (supply-chain/image-scan.mjs),
// which names the only images grype pulls: it refuses anything but a plain digest-pinned reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { acceptedFor, bases, ignored, readAccepted, readExceptions } from "../supply-chain/image-scan.mjs";

const root = join(import.meta.dirname, "../..");
const files = [".github/workflows/ci.yml", "modules/core/templates/ci/.github/workflows/ci.yml"];
const findStep = (file) => parse(readFileSync(join(root, file), "utf8")).jobs["image-changes"].steps.find((s) => s.id === "find").run;

test("image-changes (the product's CI and the app template's) selects every changed image, FROM an ARG included", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "image-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (...a) => execFileSync("git", a, { cwd: dir, env, stdio: "pipe" }).toString().trim();
  const put = (path, text) => (mkdirSync(join(dir, dirname(path)), { recursive: true }), writeFileSync(join(dir, path), text));
  git("init", "-q", "-b", "main");
  put("web/Dockerfile", "FROM node:24@sha256:" + "0".repeat(64) + "\n");
  put("tool/Dockerfile", "ARG BASE=example/base\nFROM $BASE\n");
  put("README.md", "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  // Both workflows' step on the same scratch repo: one repo built, two reads of it.
  const select = () => {
    const head = git("rev-parse", "HEAD");
    return files.map((file) => {
      const out = join(dir, "out");
      writeFileSync(out, "");
      execFileSync("bash", ["-c", findStep(file)], { cwd: dir, env: { ...env, BASE_SHA: base, PR_BASE: base, HEAD_SHA: head, GITHUB_OUTPUT: out }, stdio: "pipe" });
      return readFileSync(out, "utf8").trim();
    });
  };
  put("README.md", "y\n");
  git("commit", "-qam", "docs");
  assert.deepEqual(select(), ["dockerfiles=", "dockerfiles="]);
  put("tool/Dockerfile", "ARG BASE=example/other\nFROM $BASE\n");
  put("web/package-lock.json", "{}\n");
  git("add", "-A");
  git("commit", "-qm", "images");
  assert.deepEqual(select(), Array(2).fill("dockerfiles=tool/Dockerfile web/Dockerfile"));
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

test("an image-scan exception applies only while every Dockerfile using the image meets its condition", () => {
  const ex = readExceptions([
    "# comment",
    "exceptions:",
    '  - { image: node, path: /usr/local/lib/node_modules/npm/**, when: "RUN npm install -g npm@", reason: "replaced" }',
    '  - { image: node, path: /usr/local/lib/node_modules/npm/**, when: "RUN rm -rf /usr/local/lib/node_modules/npm", reason: "deleted" }',
    '  - { image: docker, path: /lib/apk/db/installed, when: build-stage, reason: "binaries copied out" }',
  ].join("\n"));
  assert.equal(ex.length, 3);
  const d = "@sha256:" + "a".repeat(64);
  const node = `node:24${d}`, docker = `docker:29-cli${d}`;
  const npm = "/usr/local/lib/node_modules/npm/**", apk = "/lib/apk/db/installed";
  // The image's uses across some Dockerfiles, as plan() collects them; then the paths ignored in it.
  const scan = (ref, ...files) => ignored({ ref, uses: files.flatMap((t, k) => { const b = bases(t); return b.refs.flatMap((r, i) => (r.image === ref ? [{ df: `d${k}/Dockerfile`, ...b.uses[i] }] : [])); }) }, ex);
  // Replaced or deleted in the final image's own stages: ignored.
  assert.deepEqual(scan(node, `FROM ${node}\nRUN npm install -g npm@11.21.2 && npm cache clean --force\n`, `FROM ${node}\nRUN apt-get update && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm\n`).ignore, [npm]);
  // One Dockerfile that keeps the bundled npm: the path is scanned again, for every Dockerfile on that image.
  assert.match(scan(node, `FROM ${node}\nRUN npm install -g npm@11.21.2\n`, `FROM ${node}\nRUN apt-get install -y curl\n`).skipped[0], /d1\/Dockerfile meets none/);
  // The text must start a command: not an argument, not after ; or ||, not in a stage the final image doesn't inherit.
  for (const run of ["echo npm install -g npm@1", "true; npm install -g npm@1", "npm install -g npm@1 || true", "npm install -g npm@latest", "rm -rf /usr/local/lib/node_modules/npm-old", "rm -rf /usr/local/lib/node_modules/npm2"])
    assert.deepEqual(scan(node, `FROM ${node}\nRUN ${run}\n`).ignore, [], run);
  // The path may be any argument of the rm, but exactly.
  assert.deepEqual(scan(node, `FROM ${node}\nRUN rm -rf /usr/local/bin/npm /usr/local/lib/node_modules/npm\n`).ignore, [npm]);
  // BuildKit skips a blank line inside a continuation, so this `RUN npm install` is only echo's argument.
  assert.deepEqual(scan(node, `FROM ${node}\nRUN echo \\\n\nRUN npm install -g npm@1\n`).ignore, []);
  assert.deepEqual(scan(node, `FROM ${node} AS fix\nRUN npm install -g npm@1\nFROM ${node}\nCOPY --from=fix /app /app\n`).ignore, []);
  // Copied out of a stage that replaced it: ignored; out of one that didn't: scanned.
  assert.deepEqual(scan(node, `FROM ${node} AS n\nRUN npm install -g npm@1\nFROM scratch\nCOPY --from=n /usr/local/lib/node_modules /lib/\n`).ignore, [npm]);
  assert.deepEqual(scan(node, `FROM ${node} AS n\nFROM scratch\nCOPY --from=n /usr/local/lib/node_modules /lib/\n`).ignore, []);
  // build-stage: only while nothing that can hold the path is copied out, and no final image is built on it.
  assert.deepEqual(scan(docker, `FROM ${docker} AS docker\nFROM scratch\nCOPY --from=docker /usr/local/bin/docker /bin/\n`).ignore, [apk]);
  for (const [why, text] of [
    ["final", `FROM ${docker}\n`],
    ["final through an alias", `FROM ${docker} AS docker\nFROM docker\n`],
    ["the whole image", `FROM ${docker} AS docker\nFROM scratch\nCOPY --from=docker / /\n`],
    ["a parent directory", `FROM ${docker} AS docker\nFROM scratch\nCOPY --from=docker /lib /lib\n`],
    ["a glob", `FROM ${docker} AS docker\nFROM scratch\nCOPY --from=docker /lib/apk/* /x/\n`],
    ["by stage index", `FROM ${docker}\nFROM scratch\nCOPY --from=0 lib/apk /x/\n`],
    ["straight from the image", `FROM scratch\nCOPY --from=${docker} /lib/apk/db /x/\n`],
    ["mounted", `FROM ${docker} AS docker\nFROM scratch\nRUN --mount=from=docker,target=/d cp -r /d /x\n`],
  ]) assert.deepEqual(scan(docker, text).ignore, [], why);
  // Names match exactly: a registry-qualified name gets no exception.
  assert.deepEqual(scan(`docker.io/library/node:24${d}`, `FROM docker.io/library/node:24${d}\nRUN npm install -g npm@1\n`).ignore, []);
  // An accepted advisory with no fix yet: ignored in that image only, until it expires.
  const now = Date.parse("2026-11-14");
  const vuln = readExceptions('  - { image: ghcr.io/acme/runner, vulnerability: GHSA-x33c-w48q-qrgc, expires: 2026-12-14, reason: "no fixed release" }', now);
  const runner = { ref: `ghcr.io/acme/runner:2${d}`, uses: [] };
  assert.deepEqual(ignored(runner, vuln, now).vulnerabilities, ["GHSA-x33c-w48q-qrgc"]);
  assert.match(ignored(runner, vuln, Date.parse("2026-12-15T00:00:01Z")).skipped[0], /expired on 2026-12-14/);
  assert.deepEqual(ignored({ ref: node, uses: [] }, vuln, now).vulnerabilities, []);
  assert.throws(() => readExceptions('  - { image: acme/runner, vulnerability: GHSA-x33c-w48q-qrgc, expires: 2027-06-01, reason: "x" }', now), /at most 90 days/);
  for (const bad of [
    '  - { image: node, path: /**, when: build-stage, reason: "x" }', // a whole image
    '  - { image: node, path: /usr/**, when: build-stage, reason: "x" }', // a whole top-level directory
    '  - { image: node:24, path: /usr/lib/a, when: build-stage, reason: "x" }',
    '  - { image: node, path: /usr/lib/a, reason: "x" }', // no condition
    '  - { image: node, path: /usr/lib/a, when: always, reason: "x" }',
    "ignore: [/usr/lib/a]", // any other shape
  ]) assert.throws(() => readExceptions(bad), /is not \{ image/, bad);
});

test("image-scan fails closed: a quoted or commented RUN never meets an exception; paths after -- are never options", () => {
  const d = "@sha256:" + "a".repeat(64), node = `node:24${d}`;
  const ex = readExceptions('  - { image: node, path: /usr/local/lib/node_modules/npm/**, when: "RUN npm install -g npm@", reason: "replaced" }');
  const scan = (run) => { const b = bases(`FROM ${node}\nRUN ${run}\n`); return ignored({ ref: node, uses: [{ df: "d/Dockerfile", ...b.uses[0] }] }, ex).ignore.length; };
  assert.equal(scan("npm install -g npm@11.21.2 && true"), 1);
  for (const run of ["echo 'a && npm install -g npm@1'", 'echo "x" && npm install -g npm@1', "true # && npm install -g npm@1", "echo `x` && npm install -g npm@1", "echo $(x) && npm install -g npm@1", "echo $X && npm install -g npm@1", "echo x > /f && npm install -g npm@1", "npm install -g npm@1 > /f"]) assert.equal(scan(run), 0, run);
  assert.equal(scan("true\nnpm install -g npm@1"), 0); // a second line is not part of the RUN
  const r = spawnSync(process.execPath, [join(root, "scripts/supply-chain/image-scan.mjs"), "--", "--local"], { cwd: tmpdir(), encoding: "utf8" });
  assert.match(r.stdout, /lstat .*--local/); // treated as a file name, not the --local option
  assert.equal(spawnSync(process.execPath, [join(root, "scripts/supply-chain/image-scan.mjs"), "--bogus"], { cwd: tmpdir(), encoding: "utf8" }).status, 1);
});

test("accepted risks: one id in one exact image, at most 14 days ahead; an expired one is reported to fail the scan", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const d = (c) => `sha256:${c.repeat(64)}`;
  const line = (id, image, expires) => `  - { id: ${id}, image: ${image}, expires: ${expires}, reason: "internal only, no release fixes it" }`;
  const { entries, expired } = readAccepted(["accepted:", "  # a comment", line("GO-2026-6888", `grafana/grafana:13.3.0@${d("a")}`, "2026-11-30"), line("CVE-2026-1234", "prom/x:v1", "2026-11-20"), line("GO-2026-1000", "prom/old:v1", "2026-11-01")].join("\n"), now);
  assert.deepEqual(entries.map((e) => e.id), ["GO-2026-6888", "CVE-2026-1234"]);
  assert.deepEqual(expired.map((e) => e.id), ["GO-2026-1000"]);
  assert.deepEqual(acceptedFor(`grafana/grafana:13.3.0@${d("a")}`, entries), ["GO-2026-6888"]);
  assert.deepEqual(acceptedFor(`grafana/grafana:13.3.0@${d("b")}`, entries), [], "another digest of the same tag");
  assert.deepEqual(acceptedFor(`prom/x:v1@${d("c")}`, entries), ["CVE-2026-1234"], "a name:tag entry covers its pinned digest");
  assert.deepEqual(acceptedFor(`prom/x:v2@${d("c")}`, entries), [], "never another version");
  // Never a bare name, never more than 14 days out, never an odd id or a line in another shape.
  for (const bad of [line("GO-2026-1000", "prom/x", "2026-11-20"), line("GO-2026-1000", "prom/x:v1", "2026-12-15"), line("evil", "prom/x:v1", "2026-11-20"), "  - { id: GO-2026-1000, image: prom/x:v1 }"])
    assert.throws(() => readAccepted(bad, now), /accepted risk/, bad);
});
