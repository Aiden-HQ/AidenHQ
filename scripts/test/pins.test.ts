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

  // Untracked bases keep DEFAULT_RELEASE, with no distro recorded: FROM ${ARG}, a stage extending one, scratch, another image.
  const fallbacks: [string, string][] = [
    ["FROM ${BASE}\nRUN apt-get install -y jq=1.7.1-3\n", "FROM ${BASE}"],
    ["FROM alpine:3.24 AS build\nFROM build\nRUN apt-get install -y jq=1.7.1-3\n", "FROM build"],
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

test("pins: a Dockerfile FROM that names an Object.prototype key is just an unknown base", () => {
  const d = "@sha256:" + "f".repeat(64);
  for (const name of ["constructor", "__proto__", "toString"]) {
    const [p] = scanFile("Dockerfile", `FROM ${name}:sid-slim${d}\nRUN apt-get install -y jq=1.7.1-3\n`).pins.filter((x) => x.kind === "apt");
    assert.equal(p.release, "noble", name);
    assert.equal(p.distro, undefined, name);
  }
});

test("pins: apt repositories and install rules are scoped to their own Docker stage", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const text = [
    `FROM debian:trixie-slim${d} AS tools`,
    `RUN echo "deb [trusted=yes] https://repo.example/apt trixie main" >/etc/apt/sources.list.d/r.list`,
    "RUN apt-get install -y tool=2.0 unpinned-tool",
    `FROM ubuntu:jammy${d}`,
    "RUN apt-get install -y jq=1.6.1-1 unpinned-ok",
  ].join("\n");
  const r = scanFile("Dockerfile", text);
  const [tool, jq] = r.pins.filter((p) => p.kind === "apt");
  assert.deepEqual([tool.sources, tool.distro, tool.release], [["https://repo.example/apt trixie main"], "debian", "trixie"]);
  assert.deepEqual([jq.sources, jq.distro, jq.release], [[], "ubuntu", "jammy"]);
  // The earlier stage's repo doesn't leak: its unpinned install is a problem, the later stage's isn't.
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /unpinned-tool/);
  const tried = [];
  await dateApt(jq, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.equal(tried[0], "http://archive.ubuntu.com/ubuntu jammy-updates main");
});

test("pins: a stage extending another inherits its apt repositories, and siblings stay separate", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const text = [
    `FROM debian:trixie-slim${d} AS base`,
    `RUN echo "deb [trusted=yes] https://repo.example/apt trixie main" >/etc/apt/sources.list.d/r.list`,
    `FROM base AS extended`,
    "RUN apt-get install -y inherited=1.0",
    `FROM ubuntu:jammy${d} AS sibling`,
    "RUN apt-get install -y jq=1.6.1-1",
  ].join("\n");
  const r = scanFile("Dockerfile", text);
  const [inherited, sibling] = r.pins.filter((p) => p.kind === "apt");
  assert.deepEqual([inherited.distro, inherited.release], ["debian", "trixie"]);
  assert.deepEqual(inherited.sources, ["https://repo.example/apt trixie main"]);
  assert.deepEqual([sibling.distro, sibling.release, sibling.sources], ["ubuntu", "jammy", []]);
  const tried = [];
  await dateApt(inherited, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(tried, ["https://repo.example/apt trixie main"]);

  // A child's additions don't reach back into its parent, and an unpinned install stays a problem in the stage whose
  // filesystem actually has the repository.
  const child = [
    `FROM debian:trixie-slim${d} AS base`,
    "RUN apt-get install -y unpinned-ok",
    `FROM base AS child`,
    `RUN echo "deb [trusted=yes] https://repo.example/apt trixie main" >/etc/apt/sources.list.d/r.list`,
    "RUN apt-get install -y unpinned-now-a-problem",
    `FROM base AS other`,
    "RUN apt-get install -y still-unpinned-ok",
  ].join("\n");
  const problems = scanFile("Dockerfile", child).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unpinned-now-a-problem/);
});

test("pins: a stage extending another keeps only the apt repositories it still has", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `RUN echo "deb [trusted=yes] https://repo.example/apt trixie main" >/etc/apt/sources.list.d/r.list`;
  const pkg = "RUN apt-get install -y jq=1.7.1-3";
  const cases: [string, string[], string[]][] = [
    ["kept", [write], ["https://repo.example/apt trixie main"]],
    [`removed`, [write, "RUN rm -f /etc/apt/sources.list.d/r.list"], []],
    ["rewritten", [write, 'RUN echo "deb [trusted=yes] https://repo.example/other trixie main" >/etc/apt/sources.list.d/r.list'], ["https://repo.example/other trixie main"]],
  ];
  for (const [why, lines, expected] of cases) {
    const text = [`FROM debian:trixie-slim${d} AS base`, ...lines, "FROM base AS child", pkg].join("\n");
    const r = scanFile("Dockerfile", text);
    const [pin] = r.pins.filter((p) => p.kind === "apt");
    assert.deepEqual(pin.sources, expected, why);
    assert.deepEqual([pin.distro, pin.release], ["debian", "trixie"], why);
    const tried = [];
    await dateApt(pin, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
    // The file's own entry answers first; only without one does the base's Debian pocket.
    assert.deepEqual(tried, expected.length ? expected : ["http://deb.debian.org/debian trixie main"], why);
    // A removed repository no longer makes a later unpinned install a problem; a kept or rewritten one does.
    const withUnpinned = scanFile("Dockerfile", [`FROM debian:trixie-slim${d} AS base`, ...lines, "FROM base AS child", "RUN apt-get install -y unpinned", pkg].join("\n"));
    assert.equal(withUnpinned.problems.length, expected.length ? 1 : 0, why);
  }
});

test("pins: repository writes and apt installs are checked in the order a line runs them", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `echo "deb [trusted=yes] https://repo.example/apt bookworm main" >/etc/apt/sources.list.d/vendor.list`;
  // An install before the repository is added is fine; the same install after it must be pinned.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN apt-get install -y foo && ${write}\n`).problems, []);
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} && apt-get install -y foo\n`).problems.length, 1);
  // Removing the repository later in the same line doesn't excuse an install that ran while it was there.
  const removedAfter = scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} && apt-get install -y foo && rm /etc/apt/sources.list.d/vendor.list\n`).problems;
  assert.equal(removedAfter.length, 1);
  assert.match(removedAfter[0], /apt install foo/);
  // A repository removed before an install is no longer one it must be pinned for.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} && rm /etc/apt/sources.list.d/vendor.list && apt-get install -y foo\n`).problems, []);
});

test("pins: a Deb822 source file counts as an added repository, and untracked writes accumulate", () => {
  const d = "@sha256:" + "f".repeat(64);
  // Deb822 carries the repository in Types/URIs rather than a `deb` line: still an added repository.
  const deb822 = [`FROM debian:bookworm${d}`, `RUN tee /etc/apt/sources.list.d/vendor.sources <<'EOF'
Types: deb
URIs: https://repo.example/apt
Suites: bookworm
Components: main
EOF`, "RUN apt-get install -y foo"].join("\n");
  const r = scanFile("Dockerfile", deb822);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /apt install foo/);
  // A second source file doesn't replace the first's entries.
  const two = [`FROM debian:bookworm${d}`,
    'RUN echo "deb https://one.example/apt bookworm main" >/etc/apt/sources.list.d/a.list',
    'RUN echo "deb https://two.example/apt bookworm main" >/etc/apt/sources.list.d/b.list',
    "RUN apt-get install -y foo=1.0"].join("\n");
  const [pin] = scanFile("Dockerfile", two).pins.filter((p) => p.kind === "apt");
  assert.deepEqual(pin.sources, ["https://one.example/apt bookworm main", "https://two.example/apt bookworm main"]);
  // A destination outside sources.list.d that the scanner can't attribute to a file keeps both deb lines.
  const untracked = `FROM debian:bookworm${d}\nRUN echo "deb https://one.example/apt bookworm main" >/etc/apt/one.list && echo "deb https://two.example/apt bookworm main" >/etc/apt/two.list && apt-get install -y foo=1.0\n`;
  const [untrackedPin] = scanFile("Dockerfile", untracked).pins.filter((p) => p.kind === "apt");
  assert.deepEqual(untrackedPin.sources, ["https://one.example/apt bookworm main", "https://two.example/apt bookworm main"]);
});

test("pins: a piped write files its deb line under the file, and only files APT loads count", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const piped = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  const [pin] = scanFile("Dockerfile", piped).pins.filter((p) => p.kind === "apt");
  assert.deepEqual(pin.sources, ["https://repo.example/apt bookworm main"]);
  const tried = [];
  await dateApt(pin, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(tried, ["https://repo.example/apt bookworm main"]);

  // The piped URL belongs to the file: overwriting it replaces the entry, and removing it drops the entry and the
  // requirement for exact pins.
  const rewritten = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN echo 'deb https://other.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", rewritten).pins.filter((p) => p.kind === "apt")[0].sources, ["https://other.example/apt bookworm main"]);
  const removed = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN rm /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0 unpinned\n`;
  const removedResult = scanFile("Dockerfile", removed);
  assert.deepEqual(removedResult.problems, []);
  assert.deepEqual(removedResult.pins.filter((p) => p.kind === "apt")[0].sources, []);

  // A file APT doesn't load (`vendor.list.disabled`) is no repository: writing it doesn't require pins, and removing
  // it doesn't drop the ones a real file holds.
  const disabled = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list.disabled\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", disabled).problems, []);
  const disabledRemoved = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN rm /etc/apt/sources.list.d/vendor.list.disabled\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", disabledRemoved).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
});

test("pins: only a file a pipeline writes counts, not one it copies", () => {
  const d = "@sha256:" + "f".repeat(64);
  // Copying the stock configuration for diagnostics writes only /tmp: no repository is added.
  const diag = `FROM debian:bookworm${d}\nRUN cat /etc/apt/sources.list.d/debian.sources | tee /tmp/apt-sources.log\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", diag).problems, []);
  // A `deb` line written outside sources.list.d still dates its pin, whether or not the same line names a source file.
  const untracked = `FROM debian:bookworm${d}\nRUN echo "deb https://one.example/apt bookworm main" >/etc/apt/one.list && apt-get install -y foo=1.0\n`;
  const [pin] = scanFile("Dockerfile", untracked).pins.filter((p) => p.kind === "apt");
  assert.deepEqual(pin.sources, ["https://one.example/apt bookworm main"]);
  // A quoted or `tee`-piped destination is the write; reading another source file in the same line adds nothing for it.
  const both = `FROM debian:bookworm${d}\nRUN cat /etc/apt/sources.list.d/debian.sources | tee "/etc/apt/sources.list.d/mine.sources"\nRUN apt-get install -y foo\n`;
  const bothResult = scanFile("Dockerfile", both);
  assert.equal(bothResult.problems.length, 1);
  assert.match(bothResult.problems[0], /install foo/);
  // An input redirection is read, not written: `tee /tmp/log < …/debian.sources` only copies the stock file.
  const input = `FROM debian:bookworm${d}\nRUN tee /tmp/apt-sources.log < /etc/apt/sources.list.d/debian.sources\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", input).problems, []);
  const inputPiped = `FROM debian:bookworm${d}\nRUN printf 'deb https://repo.example/apt bookworm main\\n' | tee /etc/apt/sources.list.d/vendor.list < /dev/null\nRUN apt-get install -y foo\n`;
  const inputPipedResult = scanFile("Dockerfile", inputPiped);
  // `< /dev/null` overrides the pipe, so the file is written empty: no repository, so an unpinned install is fine.
  assert.deepEqual(inputPipedResult.problems, []);
  // A file-descriptor redirect inside the operand list must not cut it short, and a `tee` fed from a file writes that
  // file empty, so it carries no `deb` line to date a pin from.
  const fd = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee 2>&1 /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  const fdResult = scanFile("Dockerfile", fd);
  assert.equal(fdResult.problems.length, 1);
  assert.match(fdResult.problems[0], /install foo/);
  const fdPin = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee 2>&1 /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", fdPin).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  const unfed = `FROM debian:bookworm${d}\nRUN echo 'deb https://discarded.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list < /dev/null\nRUN apt-get install -y foo=1.0\n`;
  const unfedResult = scanFile("Dockerfile", unfed);
  assert.deepEqual(unfedResult.problems, []);
  assert.deepEqual(unfedResult.pins.filter((p) => p.kind === "apt")[0].sources, []);
  // A file written empty is not an added repository: it neither requires a pin nor dates one.
  const empty = `FROM debian:bookworm${d}\nRUN tee /etc/apt/sources.list.d/vendor.list < /dev/null\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", empty).problems, []);
  // A producer whose stdout a `>` sent elsewhere leaves the pipe empty, so `tee` writes no repository either.
  const bypassed = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /tmp/repo.log | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  const bypassedResult = scanFile("Dockerfile", bypassed);
  assert.deepEqual(bypassedResult.problems, []);
  assert.deepEqual(bypassedResult.pins.filter((p) => p.kind === "apt")[0].sources, []);
  // Append mode belongs to the file it names: a plain `tee` replaces the file even when another target appends.
  const perTarget = `FROM debian:bookworm${d}\nRUN echo 'deb https://a.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN echo 'deb https://b.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list >> /tmp/log\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", perTarget).pins.filter((p) => p.kind === "apt")[0].sources, ["https://b.example/apt bookworm main"]);
  const appended = `FROM debian:bookworm${d}\nRUN echo 'deb https://a.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN echo 'deb https://b.example/apt bookworm main' | tee -a /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", appended).pins.filter((p) => p.kind === "apt")[0].sources, ["https://a.example/apt bookworm main", "https://b.example/apt bookworm main"]);
  // A command's output goes to the last `>` it names: an earlier one truncates its file but gets no `deb` line.
  const twoRedirects = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' >/etc/apt/sources.list.d/vendor.list >/tmp/repo.log\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", twoRedirects).problems, []);
  // An append that adds no bytes leaves the file's entry and its pin requirement as they were.
  const emptyAppend = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN tee -a /etc/apt/sources.list.d/vendor.list < /dev/null\nRUN apt-get install -y foo\n`;
  const emptyAppendResult = scanFile("Dockerfile", emptyAppend);
  assert.equal(emptyAppendResult.problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", emptyAppend.replace("install -y foo", "install -y foo=1.0")).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
});

test("pins: a removal runs only where the shell runs it, and redirects are not apt packages", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list`;
  // `test -f x || rm x` skips the removal when the file is there: the repository survives, so the install must be pinned.
  const conditional = `FROM debian:bookworm${d}\nRUN ${write}\nRUN test -f /etc/apt/sources.list.d/vendor.list || rm -f /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", conditional).problems.length, 1);
  // A message that mentions `rm` removes nothing.
  const message = `FROM debian:bookworm${d}\nRUN ${write}\nRUN echo 'To disable this repository, rm /etc/apt/sources.list.d/vendor.list'\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", message).problems.length, 1);
  // A plain removal, or one an `&&` chain makes a condition of the install, still clears it.
  for (const line of [`rm -f /etc/apt/sources.list.d/vendor.list`, `true; rm -f /etc/apt/sources.list.d/vendor.list`])
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write}\nRUN ${line} && apt-get install -y foo\n`).problems, []);
  // A removal behind `&&` or `||` may be skipped, so the repository may survive: the pin requirement stays — including
  // within the same line, where `… && rm x || true && apt install` still reaches the install with x in place.
  for (const [line, count] of [
    [`test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list`, 1],
    // The install is reached with the file untouched, so both it and the next line's are unpinned.
    [`test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list || true && apt-get install -y foo`, 2],
    // The `&&` guarantees the removal ran, so the line's own install is fine — but a failed test skips it, so the next
    // line's install is still checked.
    [`test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list && apt-get install -y foo`, 1],
  ] as const)
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write}\nRUN ${line}\nRUN apt-get install -y foo\n`).problems.length, count);
  // A `;` starts a fresh chain, so a `||` after it doesn't reopen a path past the install it follows:
  // `rm x && apt install …; echo done || true` still guarantees the removal before the install.
  const newChain = `FROM debian:bookworm${d}\nRUN ${write}\nRUN test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list && apt-get install -y foo; echo done || true\n`;
  assert.deepEqual(scanFile("Dockerfile", newChain).problems, []);
  // A repository written after a conditional removal is not the one the restore puts back: the line's own write
  // survives the line, so an unpinned install on the next line is still a problem.
  for (const [after, wrote] of [
    [`echo 'deb https://new.example/apt bookworm main' > /etc/apt/sources.list.d/new.list`, ">"],
    [`echo 'deb https://new.example/apt bookworm main' | tee /etc/apt/sources.list.d/new.list`, "| tee"],
  ] as const)
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list; ${after}\nRUN apt-get install -y foo\n`).problems.length, 1, wrote);
  // The removed file itself is still put back: the line's install may have skipped the removal, and the next line sees
  // the repository either way.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write}\nRUN test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list; echo done\nRUN apt-get install -y foo\n`).problems.length, 1);
  // A `;` ends the `&&`/`||` chain, so a conditional removal before it is put back before the next command is checked:
  // the install after `;` may still see the repository.
  const chainEnd = `FROM debian:bookworm${d}\nRUN ${write}\nRUN test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list; apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", chainEnd).problems.length, 1);
  // Only fd 1 takes a command's stdout, here too: `echo … 3> /tmp/log | tee vendor.list` still feeds `tee`, so the
  // repository exists and the next install must be pinned.
  const fdPipe = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' 3> /tmp/log | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", fdPipe).problems.length, 1);
  // A later pipeline stage owns its own redirect: `echo … > /tmp/x | cat > vendor.list` gives `cat` nothing, so the file
  // is empty and a following install needs no pin — while a `cat` fed by a producer that did write its stdout does hold
  // whatever that producer wrote.
  const drained = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /tmp/tmp.list | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", drained).problems, []);
  const carried = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", carried).problems.length, 1);
  // A copy-only stage passes on what the pipe gives it, repository line included, so a pin after it still dates from
  // that repository rather than from nothing.
  const copied = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", copied).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  // Descriptor duplication is read in shell order: `3>&1 … 1>&3` puts stdout back on the pipe, so the copy stage holds
  // the repository and the next unpinned install is a problem.
  const restored = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' 3>&1 >/tmp/log 1>&3 | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", restored).problems.length, 1);
  // A quoted `;` or `&&` is text: it does not start a new command, so a message naming `rm` removes nothing.
  for (const message of [`echo 'note; rm -f /etc/apt/sources.list.d/vendor.list'`, `echo 'test && rm -f /etc/apt/sources.list.d/vendor.list'`])
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write}\nRUN ${message}\nRUN apt-get install -y foo\n`).problems.length, 1, message);
  // A redirect belongs to the command it is in: `a > f | b` still writes f, so its `deb` line counts.
  const perCommand = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list | cat > /tmp/log\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", perCommand).problems.length, 1);
  // `tee`'s stdin redirect may sit straight against an operand, and a redirect glued to a pinned argument is not part of
  // the version.
  const adjacent = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /tmp/vendor.list\nRUN tee /etc/apt/sources.list.d/vendor.list</tmp/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", adjacent).problems.length, 1);
  const glued = `FROM debian:bookworm${d}\nRUN ${write}\nRUN apt-get install -y foo=1.2.3>/tmp/log\n`;
  assert.deepEqual(scanFile("Dockerfile", glued).pins.filter((p) => p.kind === "apt")[0].version, "1.2.3");
  // Only fd 1 takes a command's stdout, so a later `2>` or `3>` names another descriptor and leaves the write intact.
  const direct = `echo 'deb https://repo.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list`;
  for (const fd of ["2>", "3>"])
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${direct} ${fd} /tmp/log\nRUN apt-get install -y foo\n`).problems.length, 1, fd);
  // A later `1>` (the default) does take it: the file is truncated and gets no line.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${direct} 1> /tmp/log\nRUN apt-get install -y foo\n`).problems, []);
  // A redirect on the install line is not a package to pin.
  const redirected = `FROM debian:bookworm${d}\nRUN ${write}\nRUN apt-get install -y example=1.2 >/dev/null 2>&1\n`;
  assert.deepEqual(scanFile("Dockerfile", redirected).problems, []);
  // Only the command feeding `tee` decides what it writes: an earlier stage of the pipeline redirecting its own stdout
  // leaves this one's line intact.
  const upstream = `FROM debian:bookworm${d}\nRUN printf x > /tmp/log | printf '%s\\n' 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", upstream).problems.length, 1);
  // Only fd 0 overrides `tee`'s stdin and only `-a` in a short-option group means append.
  const otherFd = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list 3< /dev/null\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", otherFd).problems.length, 1);
  const grouped = `FROM debian:bookworm${d}\nRUN echo 'deb https://a.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nRUN echo 'deb https://b.example/apt bookworm main' | tee -ai /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", grouped).pins.filter((p) => p.kind === "apt")[0].sources, ["https://a.example/apt bookworm main", "https://b.example/apt bookworm main"]);
  // A `>` inside quotes is text, not a redirect: it must not turn the real write into an earlier one.
  const quotedGt = `FROM debian:bookworm${d}\nRUN echo > /etc/apt/sources.list.d/vendor.list 'deb https://repo.example/apt bookworm main # see version > 1'\nRUN apt-get install -y foo\n`;
  const quotedGtResult = scanFile("Dockerfile", quotedGt);
  assert.equal(quotedGtResult.problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", quotedGt.replace("install -y foo", "install -y foo=1.0")).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  // The last stdin redirect is the one the shell applies: `tee x < /dev/null < /tmp/vendor.list` reads the prepared file
  // and writes a repository, so an unpinned install after it is a problem.
  const lastStdin = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /tmp/vendor.list\nRUN tee /etc/apt/sources.list.d/vendor.list < /dev/null < /tmp/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", lastStdin).problems.length, 1);
});

test("pins: a disabled source file leaves no entry behind in apt dating", () => {
  const d = "@sha256:" + "f".repeat(64);
  // A `deb` line written to a name APT ignores is not a repository, so it neither dates a pin nor keeps a removed
  // file's requirement alive.
  const ignored = `FROM debian:bookworm${d}\nRUN echo 'deb https://disabled.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list.disabled\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", ignored).pins.filter((p) => p.kind === "apt")[0].sources, []);
  const mixed = `FROM debian:bookworm${d}\nRUN echo 'deb https://active.example/apt bookworm main' > /etc/apt/sources.list.d/active.list\nRUN echo 'deb https://disabled.example/apt bookworm main' >> /etc/apt/sources.list.d/vendor.list.disabled\nRUN rm /etc/apt/sources.list.d/active.list\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", mixed).problems, []);
});
