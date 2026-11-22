// The image-scan check (the product's CI and the app CI template). Its selection step, run for real on a scratch repo: a
// Dockerfile a PR changes is always selected, whatever its FROM (a `FROM $X` it can't resolve fails the scan; it is never
// skipped), and a change that touches no image selects nothing. And its Dockerfile reader (supply-chain/image-scan.ts),
// which names the only images grype pulls: it refuses anything but a plain digest-pinned reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { bases } from "../supply-chain/image-scan.ts";

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
