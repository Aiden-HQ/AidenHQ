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
test("pins: a sources.list.d file copied from another stage carries its repository into the destination", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const copy = [
    `FROM debian:bookworm${d} AS builder`,
    "RUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list",
    `FROM debian:bookworm${d} AS final`,
    "COPY --from=builder /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/",
    "RUN apt-get install -y foo",
  ].join("\n");
  const copied = scanFile("Dockerfile", copy);
  assert.equal(copied.problems.length, 1);
  assert.match(copied.problems[0], /apt install foo/);
  const [pin] = scanFile("Dockerfile", copy.replace("install -y foo", "install -y foo=1.2")).pins.filter((p) => p.kind === "apt");
  const tried = [];
  await dateApt(pin, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(tried, ["https://vendor.example/apt bookworm main"]);
  // A copy appended to what the destination already holds keeps both, and a copy of a file the source stage has not
  // added, or from outside sources.list.d, changes nothing.
  const appended = [
    `FROM debian:bookworm${d} AS builder`,
    "RUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list",
    `FROM debian:bookworm${d}`,
    "RUN echo 'deb https://own.example/apt bookworm main' > /etc/apt/sources.list.d/own.list",
    "COPY --from=builder /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/",
    "RUN apt-get install -y foo=1.2",
  ].join("\n");
  assert.deepEqual(scanFile("Dockerfile", appended).pins.filter((p) => p.kind === "apt")[0].sources, ["https://own.example/apt bookworm main", "https://vendor.example/apt bookworm main"]);
  const missing = [
    `FROM debian:bookworm${d} AS builder`,
    `FROM debian:bookworm${d}`,
    "COPY --from=builder /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/",
    "RUN apt-get install -y foo",
  ].join("\n");
  assert.deepEqual(scanFile("Dockerfile", missing).problems, []);
  // A stage that extends the builder already has the file: a copy alongside does not count it twice.
  const extended = [
    `FROM debian:bookworm${d} AS builder`,
    "RUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list",
    "FROM builder",
    "COPY --from=builder /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/",
    "RUN apt-get install -y foo=1.2",
  ].join("\n");
  assert.deepEqual(scanFile("Dockerfile", extended).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
});


test("pins: a Deb822 .sources heredoc dates a pin from its URIs, Suites and Components", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const text = [`FROM debian:bookworm${d}`, `RUN tee /etc/apt/sources.list.d/vendor.sources <<'EOF'
Types: deb
URIs: https://vendor.example/apt
Suites: stable
Components: main
EOF`, "RUN apt-get install -y foo=1.2"].join("\n");
  const [pin] = scanFile("Dockerfile", text).pins.filter((p) => p.kind === "apt");
  assert.deepEqual(pin.sources, ["https://vendor.example/apt stable main"]);
  assert.deepEqual([pin.distro, pin.release], ["debian", "bookworm"]);
  const tried = [];
  await dateApt(pin, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  // The vendor repository answers first; the base's own pockets are never the source the pin is dated from.
  assert.equal(tried[0], "https://vendor.example/apt stable main");
  // Whitespace-separated lists are several repositories, each stanza is its own, a continued line keeps its field, and
  // a disabled stanza adds none.
  const fields = [`FROM debian:bookworm${d}`, `RUN cat > /etc/apt/sources.list.d/vendor.sources <<EOF
Types: deb deb-src
URIs: https://one.example/apt https://two.example/apt
Suites: stable
  testing
Components: main contrib
X-Other: ignored

Enabled: no
URIs: https://disabled.example/apt
Suites: stable
Components: main
EOF`, "RUN apt-get install -y foo=1.2"].join("\n");
  assert.deepEqual(scanFile("Dockerfile", fields).pins.filter((p) => p.kind === "apt")[0].sources, [
    "https://one.example/apt stable main", "https://one.example/apt stable contrib",
    "https://one.example/apt testing main", "https://one.example/apt testing contrib",
    "https://two.example/apt stable main", "https://two.example/apt stable contrib",
    "https://two.example/apt testing main", "https://two.example/apt testing contrib",
  ]);
  // A stanza with no Components defaults to main, and a deb-src-only one is not a binary repository.
  const defaults = [`FROM debian:bookworm${d}`, `RUN tee /etc/apt/sources.list.d/vendor.sources <<EOF
Types: deb
URIs: https://one.example/apt
Suites: stable

Types: deb-src
URIs: https://source.example/apt
Suites: stable
Components: main
EOF`, "RUN apt-get install -y foo=1.2"].join("\n");
  assert.deepEqual(scanFile("Dockerfile", defaults).pins.filter((p) => p.kind === "apt")[0].sources, ["https://one.example/apt stable main"]);
});


test("pins: Debian -updates and -security are tried, and -security xz decodes without a dependency", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const [pin] = scanFile("Dockerfile", `FROM debian:bookworm-slim${d}\nRUN apt-get install -y openssl=3.0.22-1~deb12u2\n`).pins.filter((p) => p.kind === "apt");
  assert.deepEqual([pin.distro, pin.release], ["debian", "bookworm"]);
  const tried = [];
  // Only bookworm-security carries the version: the release and -updates pockets are read and miss it first.
  const dated = await dateApt(pin, async (_k, _n, { source }) => {
    tried.push(source);
    if (!source.includes("bookworm-security")) throw Object.assign(new Error(`not in ${source}`), { notListed: true });
    return { published: day(30), via: "test" };
  });
  assert.equal(dated.published, day(30));
  assert.deepEqual(tried, ["http://deb.debian.org/debian bookworm main", "http://deb.debian.org/debian bookworm-updates main", "http://deb.debian.org/debian bookworm-security main"]);
  // Without `xz` on PATH (or when it cannot decode), the security index is unreadable: the same fail-open warning as
  // any undatable pin. The lookup is the real one against a stub: `.gz` and plain 404, `Packages.xz` a broken archive.
  const { readAptIndex } = await import("../supply-chain/best-version.ts");
  const { execFileSync } = await import("node:child_process");
  const realFetch = globalThis.fetch;
  const xz = (() => { try { return execFileSync("xz", ["-c"], { input: "Package: openssl\nVersion: 3.0.22-1~deb12u2\nFilename: pool/x.deb\n\n" }); } catch { return undefined; } })();
  const stub = (archive: Buffer) => (async (url: string) => {
    if (String(url).endsWith("Packages.xz")) return new Response(archive, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    globalThis.fetch = stub(Buffer.from("not an xz archive"));
    const warned: string[] = [];
    assert.deepEqual(await checkAges({ pins: [pin], now, warn: (l) => warned.push(l), date: dateApt }), []);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /could not be dated, not checked/);
    // No `xz` on PATH: the point is a warning, never a failure. The system `xz` is the route when it is there.
    const saved = process.env.PATH;
    process.env.PATH = "";
    await assert.rejects(readAptIndex("https://repo.example/apt bookworm-security main"), /xz/);
    const unreadable: string[] = [];
    assert.deepEqual(await checkAges({ pins: [pin], now, warn: (l) => unreadable.push(l), date: dateApt }), []);
    assert.equal(unreadable.length, 1);
    assert.match(unreadable[0], /could not be dated, not checked/);
    process.env.PATH = saved;
    if (xz) {
      globalThis.fetch = stub(xz);
      const pkgs = await readAptIndex("https://repo.example/apt bookworm-security main");
      assert.deepEqual(pkgs.filter((p) => p.Package).map((p) => `${p.Package} ${p.Version}`), ["openssl 3.0.22-1~deb12u2"]);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});


test("pins: tee reads the last fd-0 redirect, which ends at an unquoted operator; quoted append options", () => {
  const d = "@sha256:" + "f".repeat(64);
  const stage = (lines: string[]) => `FROM debian:bookworm${d}\n${lines.join("\n")}\nRUN apt-get install -y foo\n`;
  // `< /tmp/x</dev/null` is two redirects: the shell applies `< /dev/null` last, so the file is written empty.
  const consecutive = stage(["RUN printf 'prepared\\n' > /tmp/vendor.list", "RUN tee /etc/apt/sources.list.d/vendor.list < /tmp/vendor.list</dev/null"]);
  assert.deepEqual(scanFile("Dockerfile", consecutive).problems, []);
  assert.deepEqual(scanFile("Dockerfile", consecutive.replace("install -y foo", "install -y foo=1.0")).pins.filter((p) => p.kind === "apt")[0].sources, []);
  // The same with a space before the second redirect still reads /dev/null, and `0<` is the same stdin.
  for (const redirect of ["< /tmp/vendor.list</dev/null", "< /tmp/vendor.list </dev/null", "0< /tmp/vendor.list 0</dev/null"]) {
    const text = stage(["RUN printf 'prepared\\n' > /tmp/vendor.list", `RUN tee /etc/apt/sources.list.d/vendor.list ${redirect}`]);
    assert.deepEqual(scanFile("Dockerfile", text).problems, [], redirect);
  }
  // A quoted `-a` appends, and so does one in a group; `-i`/`-p` groups do not.
  const write = "RUN echo 'deb https://one.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list";
  for (const [option, expected] of [
    ['"-a"', ["https://one.example/apt bookworm main", "https://two.example/apt bookworm main"]],
    ["'--append'", ["https://one.example/apt bookworm main", "https://two.example/apt bookworm main"]],
    ["-ia", ["https://one.example/apt bookworm main", "https://two.example/apt bookworm main"]],
    ["-i", ["https://two.example/apt bookworm main"]],
    ["-p", ["https://two.example/apt bookworm main"]],
    ["-ai", ["https://one.example/apt bookworm main", "https://two.example/apt bookworm main"]],
  ] as const) {
    const text = `FROM debian:bookworm${d}\n${write}\nRUN echo 'deb https://two.example/apt bookworm main' | tee ${option} /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
    assert.deepEqual(scanFile("Dockerfile", text).pins.filter((p) => p.kind === "apt")[0].sources, expected, option);
  }
  // A producer's stdout a deeper redirect sent elsewhere leaves the pipe empty: `tee` writes its file empty, while the
  // destination the redirect fed does hold the repository — the write is attributed to the file `tee` was actually fed
  // (nothing), not to the source file the whole pipeline mentions.
  const deeper = stage([
    "RUN echo 'deb https://vendor.example/apt bookworm main' > /tmp/vendor.list | cat | tee /etc/apt/sources.list.d/empty.list",
  ]);
  assert.deepEqual(scanFile("Dockerfile", deeper).problems, []);
  const deeperSource = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list | cat | tee /etc/apt/sources.list.d/empty.list\nRUN apt-get install -y foo=1.0\n`;
  const deeperResult = scanFile("Dockerfile", deeperSource);
  // The `>` wrote the entry to vendor.list; `tee`'s file got nothing, and is never dated from the vendor entry.
  assert.deepEqual(deeperResult.pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
  // Removing the vendor file leaves only the empty `tee` target: it holds no repository, so the pin dates from nowhere.
  const deeperEmpty = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list | cat | tee /etc/apt/sources.list.d/empty.list\nRUN rm /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", deeperEmpty).pins.filter((p) => p.kind === "apt")[0].sources, []);
  // A pipeline whose tee is fed by a redirected deeper command writes its file empty (nothing to date a pin from).
  const deeperUnpinned = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /tmp/vendor.list | cat | tee /etc/apt/sources.list.d/empty.list\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", deeperUnpinned).problems, []);
  // A pass-through that keeps the pipe (`cat | tee`, or `tee a | tee b`) forwards its input.
  const passthrough = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/a.list | tee /etc/apt/sources.list.d/b.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", passthrough).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main", "https://vendor.example/apt bookworm main"]);
});


test("pins: a removal's reach ends at each install, not at any later ||", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = "RUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list";
  const remove = "rm -f /etc/apt/sources.list.d/vendor.list";
  // The install runs only after the removal succeeded; the logging fallback belongs to another chain and cannot undo that.
  const logged = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker && ${remove} && apt-get install -y foo; echo done || true\n`;
  assert.deepEqual(scanFile("Dockerfile", logged).problems, []);
  // The plain `&&` form is the same, and a later line still sees the file (the removal may have been skipped).
  const plain = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker && ${remove} && apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", plain).problems, []);
  assert.equal(scanFile("Dockerfile", `${plain}RUN apt-get install -y foo\n`).problems.length, 1);
  // A removal after `||` may itself have been skipped (`(test || rm) && install`), so it never excuses an install.
  const skipped = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker || ${remove} && apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", skipped).problems.length, 1);
  // A `||` before the install is a path that skipped the removal: the repository may still be there.
  const reopened = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker && ${remove} || true && apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", reopened).problems.length, 1);
  // `rm x && apt install || true` reaches the install only when the removal ran, so it does not need the pin; the
  // fallback may have skipped the removal, so the next line still does.
  const fallback = `FROM debian:bookworm${d}\n${write}\nRUN ${remove} && apt-get install -y foo || true\n`;
  assert.deepEqual(scanFile("Dockerfile", fallback).problems, []);
  // The removal is unconditional (the line's first command), so the next line sees no repository either.
  assert.deepEqual(scanFile("Dockerfile", `${fallback}RUN apt-get install -y foo\n`).problems, []);
  // A conditional removal with a fallback: the install needs it, the next line may have skipped it.
  const conditional = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker && ${remove} && apt-get install -y foo || true\n`;
  assert.deepEqual(scanFile("Dockerfile", conditional).problems, []);
  assert.equal(scanFile("Dockerfile", `${conditional}RUN apt-get install -y foo\n`).problems.length, 1);
  // A repository write after a conditional removal on the same line survives the removal's undo at line end.
  const late = `FROM debian:bookworm${d}\nRUN test -f /tmp/marker && ${remove} && echo 'deb https://late.example/apt bookworm main' | tee /etc/apt/sources.list.d/late.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", late).pins.filter((p) => p.kind === "apt")[0].sources, ["https://late.example/apt bookworm main"]);
});


test("pins: COPY reads both forms, numeric stages, loaded names only, per-file names and overwrites", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const builder = `FROM debian:bookworm${d} AS builder\nRUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\n`;
  const unpinned = "RUN apt-get install -y foo\n";
  // The JSON operand form is the same copy as the shell form.
  assert.equal(scanFile("Dockerfile", `${builder}FROM debian:bookworm${d}\nCOPY --from=builder ["/etc/apt/sources.list.d/vendor.list", "/etc/apt/sources.list.d/"]\n${unpinned}`).problems.length, 1);
  // An unnamed first stage is `--from=0`.
  const indexed = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/vendor.list\nFROM debian:bookworm${d}\nCOPY --from=0 /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/\n${unpinned}`;
  assert.equal(scanFile("Dockerfile", indexed).problems.length, 1);
  // A copy into /tmp or under a name APT ignores adds nothing.
  for (const dest of ["/tmp/", "/etc/apt/sources.list.d/vendor.list.disabled"]) {
    assert.deepEqual(scanFile("Dockerfile", `${builder}FROM debian:bookworm${d}\nCOPY --from=builder /etc/apt/sources.list.d/vendor.list ${dest}\n${unpinned}`).problems, [], dest);
  }
  // Each of several sources keeps its own destination name: removing one leaves the other's repository.
  const two = [
    `FROM debian:bookworm${d} AS builder`,
    "RUN echo 'deb https://a.example/apt bookworm main' > /etc/apt/sources.list.d/a.list",
    "RUN echo 'deb https://b.example/apt bookworm main' > /etc/apt/sources.list.d/b.list",
    `FROM debian:bookworm${d}`,
    "COPY --from=builder /etc/apt/sources.list.d/a.list /etc/apt/sources.list.d/b.list /etc/apt/sources.list.d/",
    "RUN rm /etc/apt/sources.list.d/a.list",
    "RUN apt-get install -y foo",
  ].join("\n");
  assert.equal(scanFile("Dockerfile", two).problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", two.replace("install -y foo", "install -y foo=1.0")).pins.filter((p) => p.kind === "apt")[0].sources, ["https://b.example/apt bookworm main"]);
  // An overwrite replaces the destination file's repository rather than keeping the old one beside it.
  const overwritten = `${builder}FROM debian:bookworm${d}\nRUN echo 'deb https://old.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list\nCOPY --from=builder /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", overwritten).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
});


test("pins: cp and mv into sources.list.d add the repository a following install must be pinned for", () => {
  const d = "@sha256:" + "f".repeat(64);
  // A file this stage wrote carries its repositories; one it got from outside the stage is a repository it can't read.
  const tracked = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /tmp/vendor.list\nRUN cp /tmp/vendor.list /etc/apt/sources.list.d/\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", tracked).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
  const untracked = `FROM debian:bookworm${d}\nRUN cp /tmp/vendor.sources /etc/apt/sources.list.d/\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", untracked).problems.length, 1);
  assert.match(scanFile("Dockerfile", untracked).problems[0], /apt install foo/);
  // `mv` is the same, and the exact pin's sources are the tracked file it moved.
  const moved = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /tmp/vendor.list && mv /tmp/vendor.list /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", moved).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
  // `mv` renames the file away: a move onto a name APT ignores drops the original, so the install needs no pin. A `cp`
  // leaves the original in place, so the same shape still needs one.
  const disabled = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list\nRUN ${"MOVE"} /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/vendor.list.disabled\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", disabled.replace("MOVE", "mv")).problems, []);
  assert.equal(scanFile("Dockerfile", disabled.replace("MOVE", "cp")).problems.length, 1);
  // A copy to /tmp is not a repository, and the destination APT ignores adds none.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cp /tmp/vendor.list /tmp/vendor.list.bak\nRUN apt-get install -y foo\n`).problems, []);
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cp /tmp/vendor.list /etc/apt/sources.list.d/vendor.list.disabled\nRUN apt-get install -y foo\n`).problems, []);
});


test("pins: a tee whose stdout is redirected, a tab-stripped <<- body, and removals joined by && or rewritten", () => {
  const d = "@sha256:" + "f".repeat(64);
  // `tee /tmp/log >/dev/null | tee f` sends nothing down the pipe: f is written empty.
  const redirected = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' | tee /tmp/log >/dev/null | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", redirected).problems, []);
  // `<<-` strips leading tabs from the body: its Deb822 fields are still read.
  const tabbed = `FROM debian:bookworm${d}\nRUN cat > /etc/apt/sources.list.d/vendor.sources <<-EOF\n\tTypes: deb\n\tURIs: https://vendor.example/apt\n\tSuites: bookworm\n\tComponents: main\n\tEOF\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", tabbed).problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", tabbed.replace("install -y foo", "install -y foo=1.0")).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
  // Two removals joined by `&&` are both conditions of the install: neither is restored.
  const both = `FROM debian:bookworm${d}\nRUN echo 'deb https://a.example/apt bookworm main' > /etc/apt/sources.list.d/a.list\nRUN echo 'deb https://b.example/apt bookworm main' > /etc/apt/sources.list.d/b.list\nRUN test -f /tmp/marker && rm -f /etc/apt/sources.list.d/a.list && rm -f /etc/apt/sources.list.d/b.list && apt-get install -y curl\n`;
  assert.deepEqual(scanFile("Dockerfile", both).problems, []);
  // A rewrite behind a conditional removal that may be skipped keeps both possible repositories: the pin is checked
  // against the old one too.
  const rewritten = `FROM debian:bookworm${d}\nRUN echo 'deb https://old.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list\nRUN test -f /tmp/marker && rm -f /etc/apt/sources.list.d/vendor.list && printf 'deb https://new.example/apt bookworm main\\n' > /etc/apt/sources.list.d/vendor.list || true\nRUN apt-get install -y foo=1.0\n`;
  const sources = scanFile("Dockerfile", rewritten).pins.filter((p) => p.kind === "apt")[0].sources;
  assert.ok(sources.includes("https://old.example/apt bookworm main"), JSON.stringify(sources));
  assert.ok(sources.includes("https://new.example/apt bookworm main"), JSON.stringify(sources));
});


test("pins: a flat APT suite and the Debian-security scheme are read at the URL APT uses", async () => {
  const { readAptIndex } = await import("../supply-chain/best-version.ts");
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  const body = "Package: foo\nVersion: 1.0\nFilename: pool/foo.deb\n\n";
  globalThis.fetch = (async (url: string) => (seen.push(String(url)), String(url).endsWith("Packages") ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 }))) as typeof fetch;
  try {
    // `Suites: /` is a flat repository: Packages sits under the URL itself, with no component or architecture segments.
    const flat = await readAptIndex("https://flat.example/apt /");
    assert.deepEqual(flat.map((p) => `${p.Package} ${p.Version}`), ["foo 1.0"]);
    assert.equal(seen[0], "https://flat.example/apt/Packages.gz");
    // A relative suite keeps the URI's slash: `URIs: …/apt/` with `Suites: stable/` reads `…/apt/stable/Packages`.
    seen.length = 0;
    const relative = await readAptIndex("https://repo.example/apt/ stable/");
    assert.deepEqual(relative.map((p) => `${p.Package} ${p.Version}`), ["foo 1.0"]);
    assert.equal(seen[0], "https://repo.example/apt/stable/Packages.gz");
    assert.ok(!seen.some((u) => /dists\/(?:\/|\/\/)/.test(u)), seen.join(", "));
    // A Debian security line keeps the caller's scheme when it moves to the debian-security archive.
    seen.length = 0;
    const [pin] = await readAptIndex("https://deb.debian.org/debian bookworm-security main");
    assert.equal(pin!.url, "https://deb.debian.org/debian-security");
    assert.ok(seen.every((u) => u.startsWith("https://deb.debian.org/debian-security/dists/bookworm-security/")), seen.join(", "));
    // An unreadable .xz falls back to the plain index before giving up.
    seen.length = 0;
    globalThis.fetch = (async (url: string) => (seen.push(String(url)), String(url).endsWith("/Packages") ? new Response(body, { status: 200 }) : String(url).endsWith(".xz") ? new Response("bad archive", { status: 200 }) : new Response("not found", { status: 404 }))) as typeof fetch;
    const saved = process.env.PATH;
    process.env.PATH = "";
    const fallback = await readAptIndex("https://repo.example/apt bookworm-security main");
    process.env.PATH = saved;
    assert.deepEqual(fallback.map((p) => `${p.Package} ${p.Version}`), ["foo 1.0"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});


test("pins: quoted operators, per-command redirects and descriptor numbers keep a write that a later command cannot take", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list`;
  const problems = (line: string, extra = "") => scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write}\nRUN ${line}\n${extra}`).problems;
  // A quoted `;` or `&&` is text: `echo 'note; rm …'` prints a message and removes nothing, so the repository still needs
  // a pin (ported from #1424).
  for (const message of [`echo 'note; rm -f /etc/apt/sources.list.d/vendor.list'`, `echo 'test && rm -f /etc/apt/sources.list.d/vendor.list'`])
    assert.equal(problems(message, "RUN apt-get install -y foo\n").length, 1, message);
  // A `|` starts another command whose stdout is its own: `echo … > v.list | cat > /tmp/log` still writes v.list.
  assert.equal(problems(`echo 'deb https://repo.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list | cat > /tmp/log`, "RUN apt-get install -y foo\n").length, 1);
  // Only fd 1 takes the stdout: a later `2>` or `3>` names another descriptor and leaves the write intact, while a later
  // `1>` (or bare `>`) empties the file.
  const direct = `echo 'deb https://repo.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list`;
  for (const fd of ["2>", "3>"]) assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${direct} ${fd} /tmp/log\nRUN apt-get install -y foo\n`).problems.length, 1, fd);
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${direct} 1> /tmp/log\nRUN apt-get install -y foo\n`).problems, []);
  // Only fd 1 takes a command's stdout in a pipeline too: `echo … 3> /tmp/log | tee vendor.list` still feeds `tee`, so
  // the repository exists; a `cat` whose producer sent its output elsewhere writes an empty file, while a fed `cat`
  // carries the repository (ported from #1424).
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' 3> /tmp/log | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' > /tmp/tmp.list | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1);
  // A redirect glued to a pinned argument is not part of the version.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write}\nRUN apt-get install -y foo=1.2.3>/tmp/log\n`).pins.filter((p) => p.kind === "apt")[0].version, "1.2.3");
});


test("pins: a directory COPY, a heredoc that is only a comment or arithmetic, and a heredoc body of shell code", () => {
  const d = "@sha256:" + "f".repeat(64);
  // Copying the directory itself brings each of the builder's source files, so an unpinned install after it is a problem.
  const dirCopy = `FROM debian:bookworm${d} AS builder\nRUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list\nFROM debian:bookworm${d}\nCOPY --from=builder /etc/apt/sources.list.d/ /etc/apt/sources.list.d/\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", dirCopy).problems.length, 1);
  // A `<<WORD` in a comment or arithmetic opens no here-document, so the rest of the file is still read: the repository
  // written after it must keep the following install pinned.
  for (const opener of ["# cat <<EOF", "x=$((1 << 2))", "cat <<< 'a <<b'"])
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${opener}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1, opener);
  // A `#` line in a heredoc body is not a repository: the file holds nothing APT loads.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat > /etc/apt/sources.list.d/vendor.list <<'EOF'\n# deb https://old.example/apt bookworm main\nEOF\nRUN apt-get install -y foo\n`).problems, []);
  // A heredoc fed to a shell is shell code: its unpinned installs and downloaded scripts are checked too.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN bash <<'EOF'\nnpm i -g foo\nEOF\n`).problems.length, 1);
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN bash <<'EOF'\ncurl https://example.invalid/install.sh | sh\nEOF\n`).problems.length, 1);
});

test("pins: noclobber writes and a restored stdout still count as a repository", () => {
  const d = "@sha256:" + "f".repeat(64);
  const D = "echo 'deb https://repo.example/apt bookworm main'";
  // `>|` is bash's noclobber override: it truncates the file it names, so the repository is added.
  const noclobber = `FROM debian:bookworm${d}\nRUN ${D} >| /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", noclobber).problems.length, 1);
  // A duplication can put stdout back on the pipe after a file redirect, so the copy stage holds the repository and the
  // next unpinned install is a problem — through `cat` and through `tee`.
  for (const sink of ["cat > /etc/apt/sources.list.d/vendor.list", "tee /etc/apt/sources.list.d/vendor.list"])
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} 3>&1 >/tmp/log 1>&3 | ${sink}\nRUN apt-get install -y foo\n`).problems.length, 1, sink);
  // Without the restore the file redirect keeps the stdout, so the file is empty and no pin is needed.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} 3>&1 >/tmp/log | cat > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  // Adjacent redirects are still two: the shell does not need whitespace to tell `1>/tmp/log` from a file named
  // `1>/tmp/log`, so a duplication followed straight by a redirect is read the same as the spaced form.
  for (const sink of ["cat > /etc/apt/sources.list.d/vendor.list", "tee /etc/apt/sources.list.d/vendor.list"])
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} 3>&1>/tmp/log 1>&3 | ${sink}\nRUN apt-get install -y foo\n`).problems.length, 1, sink);
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} >/tmp/log>/etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} >/etc/apt/sources.list.d/vendor.list>/tmp/log\nRUN apt-get install -y foo\n`).problems, []);
  // Here `3>&1` captures vendor.list, not the pipe, so `1>&3` puts stdout back on it: the file holds the repository.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} >/etc/apt/sources.list.d/vendor.list 3>&1 >/tmp/log 1>&3\nRUN apt-get install -y foo\n`).problems.length, 1);
  // And with the restore dropped, stdout stays on the log: vendor.list is truncated but gets no bytes.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} >/etc/apt/sources.list.d/vendor.list >/tmp/log\nRUN apt-get install -y foo\n`).problems, []);
  // Only the repository the writing command prints reaches its file: an earlier stage of the pipeline printing a
  // different one is not credited to the copy, so it cannot be tried first when the pin is dated.
  const apt = (line: string) => scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${line}\nRUN apt-get install -y foo=1.0\n`).pins.find((p) => p.kind === "apt")?.sources ?? [];
  for (const sink of ["cat > /etc/apt/sources.list.d/vendor.list", "tee /etc/apt/sources.list.d/vendor.list"])
    assert.deepEqual(apt(`echo 'deb https://a.example/apt bookworm main' | echo 'deb https://b.example/apt bookworm main' | ${sink}`), ["https://b.example/apt bookworm main"], sink);
  // A `cat` whose own fd 0 a redirect moved reads that file, not the pipe: `</dev/null` writes nothing, so the file adds
  // no repository. A file it can't read is content we can't rule out, so that one still counts.
  assert.deepEqual(apt(`${D} | cat </dev/null > /etc/apt/sources.list.d/vendor.list`), []);
  // A `cat` with a file operand reads that file, which we can't read: the file it writes is unknown content, not the
  // upstream line.
  assert.deepEqual(apt(`${D} | cat /tmp/x > /etc/apt/sources.list.d/vendor.list`), []);
  // The file that takes the bytes is the one fd 1 ends on, not the one the redirect was opened with: `2> f 1>&2` writes
  // the line to f, while `2> f` alone sends stdout nowhere near it.
  assert.deepEqual(apt(`${D} 2>/etc/apt/sources.list.d/vendor.list 1>&2`), ["https://repo.example/apt bookworm main"]);
  // A `2>` destination may still be fed by the command's stderr, which we can't read, so it counts as an added
  // repository rather than being claimed empty when stdout goes elsewhere.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} 2>/etc/apt/sources.list.d/vendor.list 1>&2 >/dev/null\nRUN apt-get install -y foo\n`).problems.length, 1);
  // A `cat` with its own file operand reads that file, not the pipe.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat /tmp/vendor.list > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1);
  // Every operand counts, not just the first: `-` is stdin, and one readable file among `/dev/null`s still writes
  // that file's content.
  for (const operands of ["-", "/dev/null /tmp/vendor.list", "/tmp/vendor.list /dev/null", "- /tmp/vendor.list"])
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat ${operands} > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1, operands);
  // `/dev/null` operands contribute nothing however many there are, so two of them write an empty file — a truncate-to-
  // empty is not an added repository, and an install after it needs no pin.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat /dev/null > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat /dev/null /dev/null > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  // A `cat` option is not a file operand: `-n /dev/null` still writes nothing, while an unreadable file is still unknown.
  for (const operands of ["-n /dev/null", "-A /dev/null", "--number /dev/null"])
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat ${operands} > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, [], operands);
  // Dockerfile instructions are case-insensitive, so `run`/`Run` classify the same as `RUN` and `cat` is still a `cat`.
  for (const verb of ["run", "Run", "rUn"])
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\n${verb} cat -n /dev/null > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, [], verb);
  // `-` names stdin even when its own `<` redirect makes that empty.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat - < /dev/null > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  // Two commands are not one: bash opens each pipeline stage's redirects just before that stage runs, left to right, so
  // a later stage's truncation follows an earlier stage's write (`a > f | b > f > log` leaves f empty). Only one
  // command's own redirects are reordered.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} > /etc/apt/sources.list.d/vendor.list && cat /dev/null > /etc/apt/sources.list.d/vendor.list > /tmp/log\nRUN apt-get install -y foo\n`).problems, []);
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} > /etc/apt/sources.list.d/vendor.list | cat /dev/null > /etc/apt/sources.list.d/vendor.list > /tmp/log\nRUN apt-get install -y foo\n`).problems, []);
  // `-` reads stdin even beside a `/dev/null` operand, so the line still reaches the file.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat /dev/null - > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1);
  // A quoted descriptor operand is the same number: `1>&"3"` puts stdout back on the pipe, so the tee keeps the line.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} 3>&1 >/tmp/log 1>&"3" | tee /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems.length, 1);
  // A `cat` in a pipeline stage reads its stdin whatever other redirects it carries: `cat 2>&1` still passes the line.
  assert.deepEqual(apt(`${D} | cat 2>&1 | tee /etc/apt/sources.list.d/vendor.list`), ["https://repo.example/apt bookworm main"]);
  // The shell opens every destination before the command runs, so a truncation lands before the write that takes stdout:
  // `> v.list 3>&1 > v.list 1>&3` still leaves the line in v.list.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} >/etc/apt/sources.list.d/vendor.list 3>&1 >/etc/apt/sources.list.d/vendor.list 1>&3\nRUN apt-get install -y foo\n`).problems.length, 1);
  // Its fd 0 is read over the whole command, so a `</dev/null` after the write still empties the file.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat > /etc/apt/sources.list.d/vendor.list </dev/null\nRUN apt-get install -y foo\n`).problems, []);
  // `>|` is noclobber, not the end of `tee`'s operand list: the file after it is still written.
  assert.deepEqual(apt(`${D} | tee >| /tmp/log /etc/apt/sources.list.d/vendor.list`), ["https://repo.example/apt bookworm main"]);
});
