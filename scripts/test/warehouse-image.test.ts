// The warehouse's Postgres image (modules/warehouse/apps/warehouse/Dockerfile): the glibc packages the pinned trixie base
// ships with fixable high advisories are installed unpinned over that base, and image-scan still reads the base's package
// DB as replaced, so the change does not need an exception of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ignored, plan, readExceptions } from "../supply-chain/image-scan.ts";

const product = join(import.meta.dirname, "../..");
const df = "modules/warehouse/apps/warehouse/Dockerfile";
const lines = readFileSync(join(product, df), "utf8").split("\n");
const BASE = "postgres:17.12@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c";

test("the warehouse image installs the fixed glibc packages unpinned over its pinned base", () => {
  assert.ok(lines.includes(`FROM ${BASE}`), "the base stays pinned by digest");
  assert.ok(lines.includes("RUN apt-get update && apt-get install -y --no-install-recommends zlib1g"), "the zlib1g install stays as it was");
  const installs = lines.filter((l) => /^RUN apt-get .*\binstall\b/.test(l));
  const glibc = installs.find((l) => /\blibc6\b/.test(l));
  assert.ok(glibc, "libc6 is installed over the base");
  assert.match(glibc, /^RUN apt-get update && apt-get install -y --no-install-recommends /);
  const args = glibc.slice(glibc.indexOf("install") + "install".length).trim().split(/\s+/);
  for (const pkg of ["libc6", "libc-bin", "libc-l10n", "locales"]) assert.ok(args.includes(pkg), `${pkg} is installed`);
  assert.ok(!args.some((a) => a.includes("=")), "the install is unpinned: the base's own trixie suite picks +deb13u5");
});

test("image-scan reads the base's package DB as replaced behind that install, with no new exception", () => {
  const { images } = plan([df], { root: product });
  assert.deepEqual(images.map((i) => i.ref), [BASE]);
  const exceptions = readExceptions(readFileSync(join(product, ".github/image-scan-exceptions.yaml"), "utf8"));
  const { ignore, skipped } = ignored(images[0]!, exceptions);
  assert.deepEqual(skipped, []);
  assert.ok(ignore.includes("/var/lib/dpkg/status"), "the trixie package DB is ignored behind the install");
});
