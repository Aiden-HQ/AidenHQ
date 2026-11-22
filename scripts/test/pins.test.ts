// best-version.ts (which version to pin) and pins.ts (everything pinned, nothing new under 7 days), offline.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAges, dateApt, scanFile } from "../supply-chain/pins.ts";

const now = Date.parse("2026-11-13T00:00:00Z");
const day = (n) => new Date(now - n * 86400000).toISOString();

test("pins: unpinned images, actions, installs and apt after a repo fail; new pins are dated, old ones are not", async () => {
  const d = "@sha256:" + "a".repeat(64);
  assert.deepEqual(scanFile("x/Dockerfile", `# syntax=docker/dockerfile:1.28${d}\nFROM node:24${d} AS build\nFROM build\nCOPY --from=build /a /a\nRUN npm i -g npm@11.21.2 && pip install "x==1.0"\n`).problems, []);
  const bad = scanFile("x/Dockerfile", "FROM node:24\nRUN npm i -g codex && curl -fsSL https://x.example/i.sh | sh\n").problems;
  assert.equal(bad.length, 3);
  assert.equal(scanFile("compose.yaml", "services:\n  a:\n    build: .\n    image: acme/a:local\n  b:\n    image: postgres:17\n").problems.length, 1);
  const wf = scanFile(".github/workflows/ci.yml", `steps:\n  - uses: actions/checkout@${"b".repeat(40)} # v7.0.1\n  - uses: actions/setup-node@v7\n  - uses: ./local\n`);
  assert.equal(wf.problems.length, 1);
  assert.equal(wf.pins[0].version, "v7.0.1");
  const sh = scanFile("ops/setup.sh", "apt-get install -y jq\necho \"deb [arch=$arch] https://repo.example/apt $codename main\" >/etc/apt/sources.list.d/r.list\napt-get install -y \\\n  tool=1.2.3 other\n");
  assert.equal(sh.problems.length, 1);
  assert.equal(sh.pins[0].release, "noble");
  const tried = [];
  await dateApt(sh.pins[0], async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(tried, ["https://repo.example/apt noble main"]);
  // Pinned per release: an arm's pins are that release's; a shared pin is dated for every release the file names.
  const rel = scanFile("ops/setup.sh", [
    "echo \"deb https://repo.example/apt $codename main\" >/etc/apt/sources.list.d/r.list",
    "case \"$codename\" in",
    "  noble) apt-get -y install tool=1.0~noble ;;",
    "  resolute)",
    "    apt-get -y install tool=1.0~resolute",
    "    ;;",
    "esac",
    "apt-get -y install shared=2.0",
  ].join("\n")).pins.map((p) => `${p.name}=${p.version} ${p.release}`);
  assert.deepEqual(rel, ["tool=1.0~noble noble", "tool=1.0~resolute resolute", "shared=2.0 noble", "shared=2.0 resolute"]);

  const pins = scanFile("ops/setup.sh", "npm install -g a@1.0.0 b@2.0.0 c@3.0.0\n").pins;
  const dates = { a: day(30), b: day(2), c: day(1) };
  const date = async (p) => ({ published: dates[p.name], via: "npm publish time" });
  const problems = await checkAges({ pins, basePins: [pins[0]], exceptions: [{ ecosystem: "npm", package: "c", version: "3.0.0", advisory: "GHSA-x" }], date, now });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b 2\.0\.0 was published 2\.0 days ago/);
  // A pin that can't be dated (no push record, a lookup error) is a printed warning, never a failure.
  const [img] = scanFile("Dockerfile", `FROM postgres:17.12@sha256:${"d".repeat(64)}\n`).pins;
  const warned: string[] = [];
  for (const err of [Object.assign(new Error("no push record"), { undated: true }), new Error("503")]) {
    assert.deepEqual(await checkAges({ pins: [img], date: async () => { throw err; }, now, warn: (l) => warned.push(l) }), []);
  }
  assert.equal(warned.length, 2);
  const [act] = scanFile(".github/workflows/a.yml", `      - uses: o/r@${"a".repeat(40)} # v1.0.0\n`).pins;
  assert.match((await checkAges({ pins: [act], date: async () => { throw Object.assign(new Error("tag is another commit"), { mismatch: true }); }, now }))[0], /tag is another commit/);
  assert.match(warned[1], /could not be dated, not checked: 503/);
  // An owner-approved exception covers a too-new pin only for its exact digest, and only until it expires (14 days at most).
  const fresh = async () => ({ published: day(2), via: "registry" });
  const owner = (over) => [{ ecosystem: "docker", package: "postgres", version: "17.12", owner: "approved", digest: img.digest, expires: new Date(now + 3 * 86400000).toISOString().slice(0, 10), ...over }];
  assert.deepEqual(await checkAges({ pins: [img], exceptions: owner({}), date: fresh, now }), []);
  for (const over of [{ digest: undefined }, { digest: `sha256:${"e".repeat(64)}` }, { expires: "2020-01-01" }, { expires: new Date(now + 30 * 86400000).toISOString().slice(0, 10) }]) {
    assert.equal((await checkAges({ pins: [img], exceptions: owner(over), date: fresh, now })).length, 1, JSON.stringify(over));
  }
});

test("pins: a Dockerfile apt pin is dated from its FROM base's distro and codename", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const sid = `FROM debian:sid-slim${d}\nRUN apt-get update && apt-get install -y --no-install-recommends libkrb5-3=1.22.3-1\n`;
  const [apt] = scanFile("apps-mcp/Dockerfile", sid).pins.filter((p) => p.kind === "apt");
  assert.equal(apt.release, "sid");
  assert.equal(apt.distro, "debian");
  const tried = [];
  await dateApt(apt, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(tried, ["http://deb.debian.org/debian sid main"]);

  // An Ubuntu base is dated from its own codename, whether the tag leads (noble-…) or trails (…-noble) with a suffix.
  for (const [base, codename] of [["ubuntu:resolute", "resolute"], ["ubuntu:noble-20260101", "noble"], ["ubuntu:oracular-20250101", "oracular"]]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.7.1-3\n`).pins.filter((x) => x.kind === "apt");
    assert.equal(p.release, codename, base);
    assert.equal(p.distro, "ubuntu", base);
  }

  // Untracked bases keep DEFAULT_RELEASE, with no distro recorded: FROM ${ARG}, a local stage, scratch, another image.
  const fallbacks: [string, string][] = [
    ["FROM ${BASE}\nRUN apt-get install -y jq=1.7.1-3\n", "FROM ${BASE}"],
    ["FROM debian:sid-slim" + d + " AS build\nFROM build\nRUN apt-get install -y jq=1.7.1-3\n", "FROM build"],
    ["FROM scratch\nRUN apt-get install -y jq=1.7.1-3\n", "FROM scratch"],
    [`FROM node:24.22.3-bookworm-slim${d}\nRUN apt-get install -y jq=1.7.1-3\n`, "FROM node"],
  ];
  for (const [text, why] of fallbacks) {
    const [p] = scanFile("Dockerfile", text).pins.filter((x) => x.kind === "apt");
    assert.equal(p.release, "noble", why);
    assert.equal(p.distro, undefined, why);
    const sources = [];
    await dateApt(p, async (_k, _n, { source }) => { sources.push(source); return { published: day(30), via: "test" }; });
    assert.deepEqual(sources, ["http://archive.ubuntu.com/ubuntu noble-updates main"], why);
  }

  // The last FROM is the stage the pin runs in: an earlier Debian base doesn't date a later Ubuntu one, and vice versa.
  const [last] = scanFile("Dockerfile", `FROM debian:bookworm${d} AS tools\nFROM ubuntu:jammy${d}\nRUN apt-get install -y jq=1.6.1-1\n`).pins.filter((x) => x.kind === "apt");
  assert.deepEqual([last.distro, last.release], ["ubuntu", "jammy"]);

  // A source the file adds is tried first, then the base's own pockets.
  const own = `FROM debian:trixie-slim${d}\nRUN echo "deb [trusted=yes] https://repo.example/apt trixie main" >/etc/apt/sources.list.d/r.list\nRUN apt-get install -y tool=2.0\n`;
  const [ownPin] = scanFile("Dockerfile", own).pins.filter((x) => x.kind === "apt");
  assert.deepEqual([ownPin.distro, ownPin.release], ["debian", "trixie"]);
  const triedOwn = [];
  await dateApt(ownPin, async (_k, _n, { source }) => { triedOwn.push(source); if (triedOwn.length === 1) throw Object.assign(new Error("not listed"), { notListed: true }); return { published: day(30), via: "test" }; });
  assert.deepEqual(triedOwn, ["https://repo.example/apt trixie main", "http://deb.debian.org/debian trixie main"]);
});
