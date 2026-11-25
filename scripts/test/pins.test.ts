// best-version.ts (which version to pin) and pins.ts (everything pinned, nothing new under 7 days), offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkAges, dateApt, scanFile, wanted } from "../supply-chain/pins.ts";

// Debian publishes its -updates/-security indexes as Packages.xz only, decoded by the system `xz` (no dependency). The
// decoder check skips where it isn't installed, so the suite still runs on a bare Node.
const hasXz = (() => { try { execFileSync("xz", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
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

test("pins: a module.yaml service image is a pin, and an agent-level image line is not", async () => {
  const d = (c: string) => `@sha256:${c.repeat(64)}`;
  const text = [
    "name: primer",
    "agents:",
    "  ui-designer:",
    "    image: agent-base", // a computer image, never a registry pin
    "services:",
    "  data: true",
    "  run:",
    "    primer-server:",
    "      build: ./server", // built here: this repository's own image
    "    primer-db:",
    "      when: { primer_mode: self-host }",
    `      image: postgres:17.12${d("a")}`,
    "      env:",
    "        PGDATA: /var/lib/postgresql/data/pgdata",
    `        REF: "x${d("e")}"`, // a digest-shaped value under a service is not the service's image
    "    plain:",
    "      tmp: 16m", // neither build nor image
  ].join("\n");
  const r = scanFile("modules/primer/module.yaml", text);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.pins.map((p) => [p.kind, p.name, p.version, p.digest, p.at]), [["docker", "postgres:17.12", "17.12", `sha256:${"a".repeat(64)}`, "modules/primer/module.yaml:12"]]);
  // A tag alone is a problem, with the Dockerfile path's message; a flow-style services map is refused rather than read past.
  assert.deepEqual(scanFile("modules/x/module.yaml", "services:\n  run:\n    db:\n      image: postgres:17\n").problems, ["modules/x/module.yaml:4: image postgres:17 has no digest (name:tag@sha256:…)"]);
  assert.match(scanFile("modules/x/module.yaml", `services: { run: { db: { image: postgres:17${d("a")} } } }\n`).problems[0]!, /flow map/);
  // The compiler's YAML: a `>-`/`|` block scalar or a plain scalar continued on the next line is the ref, and a `build:`
  // with nothing after it (or only a comment) is null, so the service names an image.
  for (const form of [
    `image: >-\n        postgres:17.12${d("c")}`,
    `image: |\n        postgres:17.12${d("c")}`,
    `image:\n        postgres:17.12${d("c")}`,
    `image: # pinned\n        postgres:17.12${d("c")}`,
    `image: postgres:17.12${d("c")} # pinned`,
    `build:\n      image: postgres:17.12${d("c")}`,
    `build: # use the published image\n      image: postgres:17.12${d("c")}`,
    `build: ~\n      image: postgres:17.12${d("c")}`,
  ]) {
    const p = scanFile("modules/x/module.yaml", `services:\n  run:\n    db:\n      ${form}\n`);
    assert.deepEqual(p.problems, [], form);
    assert.equal(p.pins.length, 1, form);
    assert.equal(p.pins[0]!.digest, `sha256:${"c".repeat(64)}`, form);
  }
  // A value that is a nested map under `image` (which the schema forbids) is reported, never silently skipped.
  assert.match(scanFile("modules/x/module.yaml", `services:\n  run:\n    db:\n      image:\n        name: x\n`).problems[0]!, /nested value/);
  // A real `build:` value (`.`) still means the image is this repository's own: no pin, no problem.
  assert.deepEqual(scanFile("modules/x/module.yaml", `services:\n  run:\n    db:\n      build: .\n      image: postgres:17${d("a")}\n`).pins, []);
  // Only modules/<name>/module.yaml: a template's manifest is not a service the instance runs.
  assert.equal(wanted("modules/primer/module.yaml"), true);
  assert.equal(wanted("modules/agent-builder/templates/digest-writer/module.yaml"), false);
  // The pin is dated once it changes against the base: scanRef visits the file at both refs, so a re-pin is a new pin.
  const base = scanFile("modules/primer/module.yaml", text.replace(`17.12${d("a")}`, `17.12${d("b")}`)).pins;
  const date = async () => ({ published: day(2), via: "registry" });
  assert.equal((await checkAges({ pins: r.pins, basePins: base, date, now })).length, 1);
  assert.deepEqual(await checkAges({ pins: r.pins, basePins: r.pins, date, now }), []);
});

test("pins: a module.yaml re-pin is dated at the head and not at the base", async () => {
  // The path scanRef walks, on a real repository: wanted() lists the module.yaml at both refs, and only the head's ref is new.
  const dir = mkdtempSync(join(tmpdir(), "pins-module-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" }).trim();
    const manifest = (c: string) => `name: primer\nservices:\n  run:\n    primer-db:\n      image: postgres:17.12@sha256:${c.repeat(64)}\n`;
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "modules/primer"), { recursive: true });
    writeFileSync(join(dir, "modules/primer/module.yaml"), manifest("a"));
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "modules/primer/module.yaml"), manifest("b"));
    git("commit", "-qam", "re-pin");
    const head = git("rev-parse", "HEAD");
    // scanRef: every wanted path at the ref, read from the tree.
    const ref = (r: string) => git("ls-tree", "-r", "--name-only", r).split("\n").filter((f) => wanted(f))
      .flatMap((f) => scanFile(f, execFileSync("git", ["show", `${r}:${f}`], { cwd: dir, encoding: "utf8" })).pins);
    assert.deepEqual(ref(base).map((p) => p.digest), [`sha256:${"a".repeat(64)}`]);
    assert.deepEqual(ref(head).map((p) => p.digest), [`sha256:${"b".repeat(64)}`]);
    // Only the re-pin is dated: the same pin at both refs is old, the head's new digest is not.
    const date = async () => ({ published: day(2), via: "registry" });
    assert.equal((await checkAges({ pins: ref(head), basePins: ref(head), date, now })).length, 0);
    const problems = await checkAges({ pins: ref(head), basePins: ref(base), date, now });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /modules\/primer\/module\.yaml:5: postgres:17\.12@sha256:bbbbbbbbbbbb… was published 2\.0 days ago/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pins: a debian:sid-slim base dates its apt pin from Debian sid", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const sid = `FROM debian:sid-slim${d}\nRUN apt-get update && apt-get install -y --no-install-recommends libkrb5-3=1.22.3-1\n`;
  const [apt] = scanFile("apps-mcp/Dockerfile", sid).pins.filter((p) => p.kind === "apt");
  // The base the file declares, not the Ubuntu default it used to fall back to (#1386).
  assert.equal(apt.release, "sid");
  assert.equal(apt.distro, "debian");
  const tried: string[] = [];
  await dateApt(apt, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(tried, ["http://deb.debian.org/debian sid main"]);
});

test("pins: an ubuntu base dates its apt pin from that release's codename", async () => {
  const d = "@sha256:" + "f".repeat(64);
  // The tag may lead (noble-…) or trail (…-noble) with a suffix; either way the codename is what dates the pin.
  for (const [base, codename] of [["ubuntu:resolute", "resolute"], ["ubuntu:noble-20260101", "noble"], ["ubuntu:oracular-20250101", "oracular"]]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.7.1-3\n`).pins.filter((x) => x.kind === "apt");
    assert.equal(p.release, codename, base);
    assert.equal(p.distro, "ubuntu", base);
  }
});

test("pins: a FROM ${ARG} base still falls back to noble", async () => {
  const d = "@sha256:" + "f".repeat(64);
  // An untracked base records no distro: FROM ${ARG}, a stage extending one, scratch, another image.
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
    const sources: string[] = [];
    await dateApt(p, async (_k, _n, { source }) => { sources.push(source); return { published: day(30), via: "test" }; });
    assert.deepEqual(sources, ["http://archive.ubuntu.com/ubuntu noble-updates main"], why);
  }
});

test("pins: a moving Debian suite alias is dated from that alias, not a codename it would outgrow", async () => {
  const d = "@sha256:" + "f".repeat(64);
  // `stable`, `testing` and `oldstable` move with each release, so the alias itself is the release and Debian resolves
  // it: the pin must not fall back to Ubuntu noble, and must not be frozen to today's codename either.
  for (const [base, release] of [["debian:stable-slim", "stable"], ["debian:nowhere-stable", "stable"], ["debian:oldstable", "oldstable"], ["debian:testing-slim", "testing"], ["debian:unstable", "unstable"]]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.8-1\n`).pins.filter((x) => x.kind === "apt");
    assert.deepEqual([p.distro, p.release], ["debian", release], base);
    const tried: string[] = [];
    await dateApt(p, async (_k, _n, { source }) => { tried.push(source); return { published: day(30), via: "test" }; });
    // Every pocket Debian serves for the alias, not Ubuntu's.
    assert.deepEqual(tried, [`http://deb.debian.org/debian ${release} main`], base);
  }

  // A file's own repository writes `$VERSION_CODENAME`, which means the codename the alias names today — never the
  // alias. Expanding it to `stable` would query a suite a third-party repository does not publish, so the codename is
  // read from Debian's Release file and used only for the custom source; Debian's own pocket keeps the alias.
  const custom = `FROM debian:stable-slim${d}\nRUN echo "deb [trusted=yes] https://repo.example/apt $VERSION_CODENAME main" >/etc/apt/sources.list.d/r.list\nRUN apt-get install -y tool=2.0\n`;
  const [withSource] = scanFile("Dockerfile", custom).pins.filter((x) => x.kind === "apt");
  assert.deepEqual([withSource.distro, withSource.release], ["debian", "stable"]);
  const order: string[] = [];
  await dateApt(withSource, async (_k, _n, { source }) => { order.push(source); throw Object.assign(new Error("not listed"), { notListed: true }); },
    async (alias) => { assert.equal(alias, "stable"); return "trixie"; }).catch(() => {});
  // The custom source is the codename; Debian's own pockets keep the alias for the server to resolve.
  assert.deepEqual(order, [
    "https://repo.example/apt trixie main",
    "http://deb.debian.org/debian stable main",
    "http://deb.debian.org/debian stable-updates main",
    "http://deb.debian.org/debian stable-security main",
  ]);

  // A numeric suite tag is that suite: `debian:12` is bookworm and `ubuntu:24.04` is noble, so neither falls to the
  // default. Without this a Debian 12 stage was dated from Ubuntu's noble pockets — the same mis-dating the FROM base fixes.
  // A point release keeps its suite: Debian by its major (`12.7`), Ubuntu by its year.minor (`24.04.1`).
  for (const [base, distro, codename] of [
    ["debian:12", "debian", "bookworm"], ["debian:12-slim", "debian", "bookworm"], ["debian:13", "debian", "trixie"],
    ["debian:12.7", "debian", "bookworm"], ["debian:12.7-slim", "debian", "bookworm"], ["debian:13.1", "debian", "trixie"],
    ["ubuntu:24.04", "ubuntu", "noble"], ["ubuntu:22.04", "ubuntu", "jammy"], ["ubuntu:24.04.1", "ubuntu", "noble"],
  ]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.6.1-1\n`).pins.filter((x) => x.kind === "apt");
    assert.deepEqual([p.distro, p.release], [distro, codename], base);
  }
  // An end-of-life LTS still maps by its number: `ubuntu:18.04` is bionic, and the archive still serves it.
  for (const [base, codename] of [["ubuntu:18.04", "bionic"], ["ubuntu:18.04.6", "bionic"], ["ubuntu:16.04", "xenial"]]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.5+dfsg-2\n`).pins.filter((x) => x.kind === "apt");
    assert.deepEqual([p.distro, p.release], ["ubuntu", codename], base);
  }
  // A retired interim release is served from old-releases only, so a host that answers 404 for it is skipped rather than
  // ending the lookup: `ubuntu:24.10` still dates from oracular's index on the retirement host.
  {
    const [p] = scanFile("Dockerfile", `FROM ubuntu:24.10${d}\nRUN apt-get install -y jq=1.7.1-3\n`).pins.filter((x) => x.kind === "apt");
    assert.deepEqual([p.distro, p.release], ["ubuntu", "oracular"]);
    const tried: string[] = [];
    const dated = await dateApt(p, async (_k, _n, { source }) => {
      tried.push(source);
      // The archive has no oracular index at all; old-releases does.
      if (source.includes("archive.ubuntu.com")) throw Object.assign(new Error("404"), { status: 404, noIndex: true });
      return { published: day(30), via: "test" };
    });
    assert.equal(dated.published, day(30));
    assert.deepEqual(tried.slice(0, 2), ["http://archive.ubuntu.com/ubuntu oracular-updates main", "http://old-releases.ubuntu.com/ubuntu oracular-updates main"]);
    // Only a missing index is skipped: a package the index lists but whose .deb cannot be fetched still fails, so the
    // age check reports a real lookup failure instead of warning that nothing lists the version.
    const [latent] = scanFile("Dockerfile", `FROM ubuntu:24.04${d}\nRUN apt-get install -y jq=1.7.1-3\n`).pins.filter((x) => x.kind === "apt");
    let n = 0;
    await assert.rejects(() => dateApt(latent, async (_k, _n, { source }) => {
      n++;
      if (source.includes("noble-updates main") && !source.includes("universe")) throw Object.assign(new Error("404 from the .deb"), { status: 404 });
      throw Object.assign(new Error("no such pocket"), { status: 404, noIndex: true });
    }), /404 from the \.deb/);
    assert.ok(n > 0);

    // A file's own repository that 404s still fails: only a distro pocket may be skipped.
    const own = scanFile("Dockerfile", `FROM ubuntu:24.10${d}\nRUN echo "deb [trusted=yes] https://gone.example/apt oracular main" >/etc/apt/sources.list.d/r.list\nRUN apt-get install -y jq=1.7.1-3\n`).pins.filter((x) => x.kind === "apt")[0];
    await assert.rejects(() => dateApt(own, async () => { throw Object.assign(new Error("404"), { status: 404 }); }));
  }

  // A Debian suite deb.debian.org has dropped is read from the archive, where buster's own and security indexes are still
  // served; a current suite keeps deb.debian.org and its debian-security pocket.
  for (const [base, release, sources] of [
    ["debian:10", "buster", ["http://archive.debian.org/debian buster main", "http://archive.debian.org/debian buster-updates main", "http://archive.debian.org/debian-security buster/updates main"]],
    ["debian:12", "bookworm", ["http://deb.debian.org/debian bookworm main", "http://deb.debian.org/debian bookworm-updates main", "http://deb.debian.org/debian bookworm-security main"]],
  ]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.6-1\n`).pins.filter((x) => x.kind === "apt");
    const tried = [];
    // Nothing lists the version: the run ends undated, but every candidate was consulted in order.
    await assert.rejects(() => dateApt(p, async (_k, _n, { source }) => { tried.push(source); throw Object.assign(new Error("not listed"), { notListed: true }); }));
    assert.deepEqual([p.distro, p.release], ["debian", release], base);
    assert.deepEqual(tried, sources, base);
  }

  // An unknown number keeps the default: a tag the map doesn't list is not guessed at, and neither is a non-numeric one
  // that happens to name an Object.prototype key.
  for (const base of ["debian:99", "debian:12a", "debian:constructor", "ubuntu:__proto__", "ubuntu:toString", "ubuntu:24.04.1.5x"]) {
    const [p] = scanFile("Dockerfile", `FROM ${base}${d}\nRUN apt-get install -y jq=1.6.1-1\n`).pins.filter((x) => x.kind === "apt");
    assert.deepEqual([p.distro, p.release], [undefined, "noble"], base);
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
  // A quoted descriptor is the same duplication (`2>&"1"`), so the operand list does not end at its `&`.
  const fdQuoted = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee 2>&"1" /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  const fdQuotedResult = scanFile("Dockerfile", fdQuoted);
  assert.equal(fdQuotedResult.problems.length, 1);
  assert.match(fdQuotedResult.problems[0], /install foo/);
  const fdQuotedPin = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee 2>&"1" /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", fdQuotedPin).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  // The shell accepts whitespace between the duplication operator and its operand, so `2>& 1` and `2>& "1"` are the
  // same redirect as `2>&1` and neither ends the operand list.
  const fdSpaced = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee 2>& 1 /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
  const fdSpacedResult = scanFile("Dockerfile", fdSpaced);
  assert.equal(fdSpacedResult.problems.length, 1);
  assert.match(fdSpacedResult.problems[0], /install foo/);
  const fdSpacedQuoted = `FROM debian:bookworm${d}\nRUN echo 'deb https://repo.example/apt bookworm main' | tee 2>& "1" /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", fdSpacedQuoted).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
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
  // A pass-through that keeps the pipe (`cat | tee`, or `tee a | tee b`) forwards its input. Both files hold the same
  // repository, which is dated once: the sources tried name each repository a single time.
  const passthrough = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' | tee /etc/apt/sources.list.d/a.list | tee /etc/apt/sources.list.d/b.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", passthrough).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
});


test("pins: a quoted descriptor restores stdout, a RUN verb is any case, and races are not claimed empty", () => {
  const d = "@sha256:" + "f".repeat(64);
  const base = `FROM debian:bookworm${d}`;
  const src = "/etc/apt/sources.list.d/vendor.list";
  const D = "echo 'deb https://repo.example/apt bookworm main'";
  const flagged = (line: string) => scanFile("Dockerfile", `${base}\n${line}\nRUN apt-get install -y foo\n`).problems.length;
  // A quoted descriptor operand is the same number: `1>&"3"` puts stdout back on the pipe, so the tee keeps the line.
  assert.equal(flagged(`RUN ${D} 3>&1 >/tmp/log 1>&"3" | tee ${src}`), 1);
  // Dockerfile instructions are case-insensitive: a `RuN`/`run` pipeline stage is still the `cat` it names.
  for (const verb of ["run", "RuN", "rUn"])
    assert.deepEqual(scanFile("Dockerfile", `${base}\n${verb} cat /dev/null /dev/null > ${src}\nRUN apt-get install -y foo\n`).problems, [], verb);
  // Two pipeline stages writing one file are a race, not a sequence (measured in bash: the repository survived in
  // about one run in five), so the later truncation must not be read as clearing the earlier write.
  for (const race of [
    `${D} > ${src} | true > ${src}`,
    `${D} > ${src} | true > ${src} > /tmp/log`,
    `${D} > ${src} | cat /dev/null > ${src}`,
  ]) assert.equal(flagged(`RUN ${race}`), 1, race);
  // A replacing write does not inherit the entries of the write it replaced: the file takes the last command's output.
  assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN ${D} > ${src} > ${src}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  // Two racing stages that each write a repository: bash keeps whichever ran last (`echo a > f | echo b > f` left a in
  // 5 of 40 runs here, b in the rest), so both are possible survivors and the pin is dated from both.
  const both = `RUN ${D} > ${src} | echo 'deb https://other.example/apt bookworm main' > ${src}`;
  assert.deepEqual(scanFile("Dockerfile", `${base}\n${both}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main", "https://other.example/apt bookworm main"]);
  // A racing write whose output we can't read may have left the earlier repository in place, so its URL is kept: the
  // pin is still dated against the vendor repository the first stage wrote.
  assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN ${D} > ${src} | true > ${src}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  // A later write the scanner can't read but which certainly replaces the file (not a race) clears the earlier URL.
  assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN ${D} > ${src}\nRUN cat /tmp/vendor.list > ${src}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, []);
  // A `cat` that copies a file this stage wrote carries that file's repositories: the destination takes the vendor URL
  // the source held, so a pin is still dated from it after the source is removed.
  const dir = "/etc/apt/sources.list.d";
  const copied = [
    `RUN ${D} > ${dir}/vendor.list`,
    `RUN ${D} > ${dir}/other.list`,
    `RUN cat ${dir}/vendor.list > ${dir}/other.list`,
    `RUN rm ${dir}/vendor.list`,
    "RUN apt-get install -y foo=1.0",
  ].join("\n");
  assert.deepEqual(scanFile("Dockerfile", `${base}\n${copied}\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
  // The shell truncates a redirect's destination before the command reads it, so `cat < f > f` writes nothing: the file
  // ends empty and a following install needs no pin (bash leaves f at 0 bytes).
  const selfTruncate = [`RUN ${D} > ${dir}/vendor.list`, `RUN cat < ${dir}/vendor.list > ${dir}/vendor.list`].join("\n");
  assert.deepEqual(scanFile("Dockerfile", `${base}\n${selfTruncate}\nRUN apt-get install -y foo\n`).problems, []);
  // `cat file -` concatenates the file with the pipe, so a pin is dated from both repositories.
  const concat = [
    `RUN ${D} > ${dir}/first.list`,
    `RUN printf '%s\\n' 'deb https://second.example/apt bookworm main' | cat ${dir}/first.list - > ${dir}/combined.list`,
  ].join("\n");
  assert.deepEqual(scanFile("Dockerfile", `${base}\n${concat}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main", "https://second.example/apt bookworm main"]);
  // A descriptor duplication on a `cat` names no input, however its operand is written: the quoted and spaced forms
  // (`3>&"1"`, `3>& 1`) must not leave the quoted number behind to read as a file operand.
  for (const dup of ["3>&\"1\"", "3>& 1"]) {
    const lines = [`RUN ${D} > ${dir}/vendor.list`, `RUN cat ${dir}/vendor.list ${dup} > ${dir}/copy.list`, `RUN rm ${dir}/vendor.list`];
    assert.deepEqual(scanFile("Dockerfile", `${base}\n${lines.join("\n")}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"], dup);
  }
  // The same concatenation happens when `cat file -` sits inside a pipeline instead of before a redirect.
  const pipelineConcat = [
    `RUN ${D} > ${dir}/first.list`,
    `RUN printf '%s\\n' 'deb https://second.example/apt bookworm main' | cat ${dir}/first.list - | tee ${dir}/combined.list`,
  ].join("\n");
  assert.deepEqual(scanFile("Dockerfile", `${base}\n${pipelineConcat}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main", "https://second.example/apt bookworm main"]);
  // A `-` whose stdin is redirected reads that file, not the pipe, so only the tracked operand is the output.
  const redirected = [`RUN ${D} > ${dir}/first.list`, `RUN printf 'x' | cat ${dir}/first.list - </dev/null > ${dir}/combined.list`].join("\n");
  assert.deepEqual(scanFile("Dockerfile", `${base}\n${redirected}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://repo.example/apt bookworm main"]);
});

test("pins: a pin a racing source file feeds is dated from every possible winner", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const dir = "/etc/apt/sources.list.d";
  const raced = `FROM debian:bookworm${d}\nRUN echo 'deb https://old.example/apt bookworm main' > ${dir}/v.list | echo 'deb https://fresh.example/apt bookworm main' > ${dir}/v.list\nRUN apt-get install -y foo=1.0\n`;
  const pin = scanFile("Dockerfile", raced).pins.filter((p) => p.kind === "apt")[0];
  // Either stage's repository can be the one the file ends holding, so both are candidates.
  assert.deepEqual(pin.sources, ["https://old.example/apt bookworm main", "https://fresh.example/apt bookworm main"]);
  const tried: string[] = [];
  const lookup = async (_k, _n, { source }) => {
    tried.push(source);
    if (source.startsWith("https://old.example")) return { published: day(30), via: "test" };
    if (source.startsWith("https://fresh.example")) return { published: day(1), via: "test" };
    throw Object.assign(new Error("not listed"), { notListed: true });
  };
  // The newest record across the candidates is the one that counts: 30 days in one, 1 day in the other, fails.
  assert.equal((await dateApt(pin, lookup)).published, day(1));
  assert.deepEqual(tried, ["https://old.example/apt bookworm main", "https://fresh.example/apt bookworm main"]);
  // A file only one command wrote keeps the old behaviour: the first repository that lists the version answers it.
  const single = scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN echo 'deb https://old.example/apt bookworm main' > ${dir}/v.list\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0];
  tried.length = 0;
  assert.equal((await dateApt(single, lookup)).published, day(30));
  assert.equal(tried.length, 1);
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
  // Its fd 0 is read over the whole command, so a `</dev/null` after the write still empties the file.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${D} | cat > /etc/apt/sources.list.d/vendor.list </dev/null\nRUN apt-get install -y foo\n`).problems, []);
  // `>|` is noclobber, not the end of `tee`'s operand list: the file after it is still written.
  assert.deepEqual(apt(`${D} | tee >| /tmp/log /etc/apt/sources.list.d/vendor.list`), ["https://repo.example/apt bookworm main"]);
});

test("pins: an empty append keeps a file, a mv carries the entries it read, and a valueless COPY flag keeps its source", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `RUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list`;
  const head = `FROM debian:bookworm${d}\n${write}\n`;
  // An append of nothing (`cat </dev/null >> f`, `tee -a f </dev/null`) leaves the file as it was: the repository is
  // still loaded, so the unpinned install is still reported.
  for (const append of ["cat </dev/null >> /etc/apt/sources.list.d/vendor.list", "tee -a /etc/apt/sources.list.d/vendor.list </dev/null"])
    assert.equal(scanFile("Dockerfile", `${head}RUN ${append}\nRUN apt-get install -y foo\n`).problems.length, 1, append);
  // A truncation with no output (`: > f`) does empty it.
  assert.deepEqual(scanFile("Dockerfile", `${head}RUN : > /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  // `mv` to another loaded name reads the source's entries first, so the destination dates a pin from them.
  const renamed = `RUN mv /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/renamed.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", `${head}${renamed}`).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
  // A valueless COPY flag (`--link`) does not swallow the source that follows it; nor does a valued one (`--chown`).
  const builder = `FROM debian:bookworm${d} AS builder\n${write}\n`;
  for (const flags of ["--link --from=builder", "--chown=0:0 --from=builder", "--from=builder --exclude=.git"]) {
    const copy = `FROM debian:bookworm${d}\nCOPY ${flags} /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/\nRUN apt-get install -y foo\n`;
    assert.equal(scanFile("Dockerfile", `${builder}${copy}`).problems.length, 1, flags);
  }
});

test("pins: every cat operand, cp/mv -t targets and the joined COPY --parents destination", () => {
  const d = "@sha256:" + "f".repeat(64);
  const base = `FROM debian:bookworm${d}`;
  const src = "/etc/apt/sources.list.d/vendor.list";
  const unpinned = "RUN apt-get install -y foo";
  // `cat` concatenates its operands: a trailing `/dev/null` erases nothing, so the append still holds what the other
  // input gave it. Only inputs that are all `/dev/null` (or a lone `<`-redirect to it) are known empty.
  assert.equal(scanFile("Dockerfile", `${base}\nRUN cat /tmp/vendor.list /dev/null >> ${src}\n${unpinned}\n`).problems.length, 1);
  assert.equal(scanFile("Dockerfile", `${base}\nRUN cat </dev/null /tmp/vendor.list >> ${src}\n${unpinned}\n`).problems.length, 1);
  for (const empty of ["cat </dev/null", "cat /dev/null", "cat 0</dev/null", "cat - </dev/null", "cat </dev/null /dev/null"]) {
    assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN ${empty} >> ${src}\n${unpinned}\n`).problems, [], empty);
  }
  // A later `<` replaces an earlier one: `cat </tmp/input </dev/null` reads only /dev/null, so its output is empty;
  // the reverse order reads the file and is unknown.
  assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN cat </tmp/input </dev/null > ${src}\n${unpinned}\n`).problems, []);
  assert.equal(scanFile("Dockerfile", `${base}\nRUN cat </dev/null </tmp/input > ${src}\n${unpinned}\n`).problems.length, 1);
  // A `-` operand reads stdin, and a file operand beside it leaves the pipe read as well.
  assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN cat - </dev/null > ${src}\n${unpinned}\n`).problems, []);
  assert.equal(scanFile("Dockerfile", `${base}\nRUN cat </tmp/input /tmp/other.list > ${src}\n${unpinned}\n`).problems.length, 1);
  // `-n` and `--` are options, not files; `cat -- -x` names the file `-x`.
  assert.equal(scanFile("Dockerfile", `${base}\nRUN cat -n /tmp/vendor.list >> ${src}\n${unpinned}\n`).problems.length, 1);
  assert.equal(scanFile("Dockerfile", `${base}\nRUN cat -- /tmp/vendor.list >> ${src}\n${unpinned}\n`).problems.length, 1);
  // `cp`/`mv -t dir` (or `--target-directory`) makes every operand a source, even one. `--suffix` is not a destination.
  for (const flags of ["-t /etc/apt/sources.list.d/", "-t/etc/apt/sources.list.d/", "-rt /etc/apt/sources.list.d/", "-t '/etc/apt/sources.list.d/'", "-f -t /etc/apt/sources.list.d/", "-t /etc/apt/sources.list.d", "--target-directory=/etc/apt/sources.list.d/", "--target-directory /etc/apt/sources.list.d/"]) {
    const shape = `${base}\nRUN cp ${flags} /tmp/vendor.list\n${unpinned}\n`;
    assert.equal(scanFile("Dockerfile", shape).problems.length, 1, flags);
  }
  const moved = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > /tmp/v.list && mv -t /etc/apt/sources.list.d/ /tmp/v.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", moved).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"]);
  assert.deepEqual(scanFile("Dockerfile", `${base}\nRUN cp --suffix=.bak /tmp/vendor.list /tmp/other.list\n${unpinned}\n`).problems, []);
  // A build-context file takes the destination's name: `COPY vendor.conf …/vendor.list` is the repository APT loads.
  assert.equal(scanFile("Dockerfile", `${base}\nCOPY vendor.conf ${src}\n${unpinned}\n`).problems.length, 1);
  // A directory destination keeps the context name (`vendor.conf`), which APT does not load.
  assert.deepEqual(scanFile("Dockerfile", `${base}\nCOPY vendor.conf /etc/apt/sources.list.d/\n${unpinned}\n`).problems, []);
  // What APT loads is the path the destination and the kept parents form together.
  assert.equal(scanFile("Dockerfile", `${base}\nCOPY --parents etc/apt/sources.list.d/vendor.list /\n${unpinned}\n`).problems.length, 1);
  assert.deepEqual(scanFile("Dockerfile", `${base}\nCOPY --parents vendor.list /tmp/\n${unpinned}\n`).problems, []);
});

test("pins: cat reads only /dev/null as empty, mv -n keeps both files, COPY --parents keeps its paths, cp flags", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `RUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list`;
  const unpinned = "RUN apt-get install -y foo";
  // Only `/dev/null` is known empty: appending a file the scanner can't read (`cat /tmp/x >> f`) puts content in f, so
  // the repository may be there and the install needs a pin.
  for (const src of ["/tmp/vendor.list", "/etc/apt/sources.list.d/debian.sources", "vendor.list"]) {
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat ${src} >> /etc/apt/sources.list.d/vendor.list\n${unpinned}\n`).problems.length, 1, src);
  }
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat /dev/null > /etc/apt/sources.list.d/vendor.list\n${unpinned}\n`).problems, []);
  // `mv -n` onto an existing target decides nothing we can see: the source may stay and the target may take its content,
  // so both repositories are kept whichever happens (the pin dates from both).
  const noClobber = `FROM debian:bookworm${d}\n${write}\nRUN echo 'deb https://other.example/apt bookworm main' > /etc/apt/sources.list.d/other.list\nRUN mv -n /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/other.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", noClobber).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main", "https://other.example/apt bookworm main"]);
  // `mv -f`/`-v` take no operand: the move still renames the file away, so the disabled repository is not loaded.
  // `-i` asks, so it may be declined: the repository may stay, and is kept (over-reporting).
  for (const flag of ["-f", "-v", "--no-target-directory"]) {
    const shape = `FROM debian:bookworm${d}\n${write}\nRUN mv ${flag} /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/vendor.list.disabled\n${unpinned}\n`;
    assert.deepEqual(scanFile("Dockerfile", shape).problems, [], flag);
  }
  for (const flag of ["-i", "--interactive"]) {
    const shape = `FROM debian:bookworm${d}\n${write}\nRUN mv ${flag} /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/vendor.list.disabled\n${unpinned}\n`;
    assert.equal(scanFile("Dockerfile", shape).problems.length, 1, flag);
  }
  // A short group with `n` in it is no-clobber: the move may be skipped, so the repository is kept (over-reporting).
  for (const flag of ["-fn", "-n", "--no-clobber"]) {
    const shape = `FROM debian:bookworm${d}\n${write}\nRUN mv ${flag} /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/vendor.list.disabled\n${unpinned}\n`;
    assert.equal(scanFile("Dockerfile", shape).problems.length, 1, flag);
  }
  // `-t dir` is the one that takes an operand: the sources follow it.
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\nRUN cp -t /etc/apt/sources.list.d/ /etc/apt/sources.list.d/vendor.list\n${unpinned}\n`).problems.length, 1);
  // `COPY --parents vendor.list /etc/apt/sources.list.d/` keeps only the bare name, so APT loads it; a source under
  // sources.list.d keeps its whole path, which APT does not load. The `/./` pivot decides which parents are kept.
  const ctx = `FROM debian:bookworm${d}\nCOPY --parents vendor.list /etc/apt/sources.list.d/\n${unpinned}\n`;
  assert.equal(scanFile("Dockerfile", ctx).problems.length, 1);
  for (const src of ["/etc/apt/sources.list.d/vendor.list", "/ctx/./etc/apt/sources.list.d/vendor.list", "./etc/apt/vendor.list"]) {
    const nested = `FROM debian:bookworm${d}\nCOPY --parents ${src} /etc/apt/sources.list.d/\n${unpinned}\n`;
    assert.deepEqual(scanFile("Dockerfile", nested).problems, [], src);
  }
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nCOPY --parents ./ctx/./vendor.list /etc/apt/sources.list.d/\n${unpinned}\n`).problems.length, 1);
});

test("pins: a cat reading /dev/null, a guarded truncation, mv -n, COPY --parents and flagged JSON COPY", () => {
  const d = "@sha256:" + "f".repeat(64);
  const write = `RUN echo 'deb https://vendor.example/apt bookworm main' > /etc/apt/sources.list.d/vendor.list`;
  // `cat </dev/null >> f` appends nothing even on a fresh file: it stays empty, so the next install needs no pin.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat </dev/null >> /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`).problems, []);
  // A guarded truncation may be skipped (`test -f m && : > f || true`): the repository may still be there.
  const guarded = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker && : > /etc/apt/sources.list.d/vendor.list || true\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", guarded).problems.length, 1);
  // `mv -n` never replaces an existing target: both repositories stay, so the pin is dated from both.
  const noClobber = `FROM debian:bookworm${d}\n${write}\nRUN echo 'deb https://other.example/apt bookworm main' > /etc/apt/sources.list.d/other.list\nRUN mv -n /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/other.list\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", noClobber).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main", "https://other.example/apt bookworm main"]);
  // `COPY --parents` keeps the source's directories under the destination, so APT never loads it; a flagged JSON COPY
  // (`--link --chown=… --from=`) still reads its array.
  const builder = `FROM debian:bookworm${d} AS builder\n${write}\n`;
  const parents = `FROM debian:bookworm${d}\nCOPY --parents --from=builder /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/\nRUN apt-get install -y foo\n`;
  assert.deepEqual(scanFile("Dockerfile", `${builder}${parents}`).problems, []);
  for (const flags of ["--link --chown=0:0 --from=builder", "--chown=0:0 --link --from=builder"]) {
    const json = `FROM debian:bookworm${d}\nCOPY ${flags} ["/etc/apt/sources.list.d/vendor.list", "/etc/apt/sources.list.d/"]\nRUN apt-get install -y foo\n`;
    assert.equal(scanFile("Dockerfile", `${builder}${json}`).problems.length, 1, flags);
  }
  // The shell form takes several leading flags too: two valueless ones and a valued one before `--from=` are all
  // consumed, so neither `--follow-link` nor `--chown=0:0` is read as the source path.
  for (const flags of ["--link --follow-link --from=builder", "--link --chown=0:0 --from=builder", "--follow-link --link --from=builder", "--chmod=644 --link --chown 0:0 --from=builder"]) {
    const shell = `FROM debian:bookworm${d}\nCOPY ${flags} /etc/apt/sources.list.d/vendor.list /etc/apt/sources.list.d/vendor.list\nRUN apt-get install -y foo\n`;
    assert.equal(scanFile("Dockerfile", `${builder}${shell}`).problems.length, 1, flags);
  }
});

test("pins: a pipe passes through cat's stdin operand, and a glued cp suffix still leaves -t the destination", () => {
  const d = "@sha256:" + "f".repeat(64);
  const src = "/etc/apt/sources.list.d/vendor.list";
  const line = "echo 'deb https://vendor.example/apt bookworm main'";
  const unpinned = "RUN apt-get install -y foo";
  // `cat -` and a quoted `cat "-"` read stdin exactly as a bare `cat` does: the pipeline's `deb` line reaches the file,
  // so the install after it needs a pin. A `<-`redirect on cat's stdin still overrides the pipe.
  for (const read of ["cat -", "cat -- -", "cat - -", "cat -n -", 'cat "-"', "cat - | cat -"]) {
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${line} | ${read} > ${src}\n${unpinned}\n`).problems.length, 1, read);
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${line} | ${read} | tee ${src}\n${unpinned}\n`).problems.length, 1, read);
  }
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${line} | cat - </dev/null > ${src}\n${unpinned}\n`).problems, []);
  // `-S` takes its suffix glued (`-S.bak`, `--backup -S.bak`) or separate; either way it consumes only its own argument,
  // so `-t` still names the destination and the source is the file, not the directory.
  const write = `RUN echo 'deb https://vendor.example/apt bookworm main' > /tmp/vendor.list`;
  for (const flags of ["-S.bak", "--backup -S.bak", "-S .bak", "-fS.bak", "--suffix=.bak", "--suffix .bak"]) {
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cp ${flags} -t /etc/apt/sources.list.d/ /tmp/vendor.list\n${unpinned}\n`).problems.length, 1, flags);
    const moved = `FROM debian:bookworm${d}\n${write}\nRUN cp ${flags} -t /etc/apt/sources.list.d/ /tmp/vendor.list\nRUN apt-get install -y foo=1.0\n`;
    assert.deepEqual(scanFile("Dockerfile", moved).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"], flags);
  }
});

test("pins: cat's output descriptor is not a file, and a piped line survives beside a /dev/null operand", () => {
  const d = "@sha256:" + "f".repeat(64);
  const src = "/etc/apt/sources.list.d/vendor.list";
  const write = "echo 'deb https://vendor.example/apt bookworm main'";
  const unpinned = "RUN apt-get install -y foo";
  // `2>` is an output redirect with a descriptor, not an input file: `cat /dev/null 2>/tmp/log > f` truncates f to
  // nothing, so the install after it needs no pin.
  for (const shape of [`cat /dev/null 2>/tmp/log > ${src}`, `cat /dev/null 2>/tmp/log | tee ${src}`, `cat 0</dev/null > ${src}`]) {
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} | ${shape}\n${unpinned}\n`).problems, [], shape);
  }
  // `/dev/null` adds no bytes: a `cat` that also reads `-` still passes the piped `deb` line on, so the repository is
  // kept (and dates a later pin), while a `cat` that reads only `/dev/null` writes nothing.
  for (const read of ["cat /dev/null -", "cat - /dev/null", "cat /dev/null - 2>/tmp/log", 'cat /dev/null "-"']) {
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} | ${read} > ${src}\n${unpinned}\n`).problems.length, 1, read);
    const pinned = `FROM debian:bookworm${d}\nRUN ${write} | ${read} > ${src}\nRUN apt-get install -y foo=1.0\n`;
    assert.deepEqual(scanFile("Dockerfile", pinned).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"], read);
  }
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} | cat /dev/null > ${src}\n${unpinned}\n`).problems, []);
  // A `<`-redirect on stdin overrides the pipe even beside a `-` operand: `cat - </dev/null` reads nothing.
  assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${write} | cat - </dev/null > ${src}\n${unpinned}\n`).problems, []);
});

test("pins: a cat whose redirect touches its name, and a write that certainly runs before a semicolon", () => {
  const d = "@sha256:" + "f".repeat(64);
  const src = "/etc/apt/sources.list.d/vendor.list";
  const line = "printf '%s\\n' 'deb https://vendor.example/apt bookworm main'";
  const unpinned = "RUN apt-get install -y foo";
  // A redirect may touch the command name: `cat</dev/null` reads /dev/null, not the pipe, so the file is empty.
  for (const read of ["cat</dev/null", "cat 0</dev/null", "cat</dev/null -"]) {
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${line} | ${read} > ${src}\n${unpinned}\n`).problems, [], read);
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN ${line} | ${read} | tee ${src}\n${unpinned}\n`).problems, [], read);
  }
  // Without the redirect it is still the pass-through the pipe feeds, however it is spelled.
  // Its `deb` line is what dates the pin: the sources carry the URL the pipe fed it.
  for (const shape of [`cat - > ${src}`, `cat>${src}`, `cat > ${src}`, `cat - | tee ${src}`]) {
    const pinned = `FROM debian:bookworm${d}\nRUN ${line} | ${shape}\nRUN apt-get install -y foo=1.0\n`;
    assert.deepEqual(scanFile("Dockerfile", pinned).pins.filter((p) => p.kind === "apt")[0].sources, ["https://vendor.example/apt bookworm main"], shape);
  }
  // A write that certainly runs completes before the `;`: `true && cat /dev/null > f; apt-get install curl` installs with
  // f empty, so the line's own install is no problem.
  const truncated = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > ${src}\nRUN true && cat /dev/null > ${src}; apt-get install -y curl\n`;
  assert.deepEqual(scanFile("Dockerfile", truncated).problems, []);
  // A write behind a `test` may have been skipped, so the repository is still put back at the end of its chain: the next
  // line (and the line's own install, after a `||` path) may still see it.
  const guarded = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > ${src}\nRUN test -f /tmp/m && cat /dev/null > ${src}\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", guarded).problems.length, 1);
  // After a `;` the truncation itself may still have been skipped, so the install there is checked against the file it
  // may have left alone (over-reporting is the safe direction); only a condition that can't fail makes it final.
  const guardedSemi = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > ${src}\nRUN test -f /tmp/m && cat /dev/null > ${src}; apt-get install -y curl\n`;
  assert.equal(scanFile("Dockerfile", guardedSemi).problems.length, 1);
  const colonSemi = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > ${src}\nRUN : && cat /dev/null > ${src}; apt-get install -y curl\n`;
  assert.deepEqual(scanFile("Dockerfile", colonSemi).problems, []);
  // A condition the scanner can't evaluate as always-true (`false`, a `test`) keeps the file: the next line may still
  // see the repository, so over-reporting is the safe answer.
  const miss = `FROM debian:bookworm${d}\nRUN echo 'deb https://vendor.example/apt bookworm main' > ${src}\nRUN false && cat /dev/null > ${src}\nRUN apt-get install -y foo\n`;
  assert.equal(scanFile("Dockerfile", miss).problems.length, 1);
});

test("pins: COPY --parents records only the names APT loads", () => {
  const d = "@sha256:" + "f".repeat(64);
  const unpinned = "RUN apt-get install -y foo";
  // `vendor.list.disabled` sits in sources.list.d, but APT skips it: only `.list` and `.sources` date a pin or require one.
  for (const src of ["vendor.list.disabled", "vendor.sources.disabled"]) {
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\nCOPY --parents ${src} /etc/apt/sources.list.d/\n${unpinned}\n`).problems, [], src);
  }
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nCOPY --parents vendor.sources /etc/apt/sources.list.d/\n${unpinned}\n`).problems.length, 1);
});

test("pins: a normalised COPY path, a guarded mv and the last overwrite flag", () => {
  const d = "@sha256:" + "f".repeat(64);
  const src = "/etc/apt/sources.list.d/vendor.list";
  const write = `RUN echo 'deb https://vendor.example/apt bookworm main' > ${src}`;
  const unpinned = "RUN apt-get install -y foo";
  // `.` components and repeated slashes are the same directory to the shell: APT loads what lands there.
  for (const dest of ["/etc/apt/./sources.list.d/", "/etc//apt/sources.list.d/", "/etc/apt/sources.list.d/."]) {
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nCOPY --parents vendor.list ${dest}\n${unpinned}\n`).problems.length, 1, dest);
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nCOPY vendor.list ${dest}vendor.list\n${unpinned}\n`).problems.length, 1, dest);
  }
  // A guarded move may be skipped: the repository may still be loaded, so the next line is checked against it.
  const guarded = `FROM debian:bookworm${d}\n${write}\nRUN test -f /tmp/marker && mv ${src} ${src}.disabled\n${unpinned}\n`;
  assert.equal(scanFile("Dockerfile", guarded).problems.length, 1);
  // ...and when it certainly runs (`true &&`, or on its own line) the move disables it.
  for (const mv of [`mv ${src} ${src}.disabled`, `true && mv ${src} ${src}.disabled`]) {
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\nRUN ${mv}\n${unpinned}\n`).problems, [], mv);
  }
  // The last overwrite flag wins, as in the shell: `-f` after `-n` forces the rename, `-n` after `-f` keeps the file.
  for (const flags of ["-n -f", "--no-clobber --force", "-nf"]) {
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\nRUN mv ${flags} ${src} ${src}.disabled\n${unpinned}\n`).problems, [], flags);
  }
  // `-fn` is `f` then `n`: the no-clobber stays in force.
  for (const flags of ["-f -n", "--force --no-clobber", "-fn"]) {
    assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\nRUN mv ${flags} ${src} ${src}.disabled\n${unpinned}\n`).problems.length, 1, flags);
  }
  // GNU `cp`'s `-f` does not cancel `-n` (it only retries an unopenable destination), so `cp -n -f` still leaves the
  // target alone, while for `mv` the last flag wins. Both files are known, so the kept repository lines show the mode.
  const dst = "/etc/apt/sources.list.d/other.list";
  const both = (verb: string, flags: string) => scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\nRUN echo 'deb https://other.example/apt bookworm main' > ${dst}\nRUN ${verb} ${flags} ${src} ${dst}\n${unpinned.replace("foo", "foo=1.0")}\n`).pins.filter((p) => p.kind === "apt")[0]!.sources;
  const vendor = "https://vendor.example/apt bookworm main", other = "https://other.example/apt bookworm main";
  for (const flags of ["-f", "--force"]) assert.deepEqual(both("cp", flags), [vendor], flags);
  for (const flags of ["-n -f", "--no-clobber --force", "-nf", "-f -n", "-fn", "-n", "--no-clobber"]) {
    assert.deepEqual([...both("cp", flags)!].sort(), [vendor, other].sort(), flags);
  }
  for (const flags of ["-f", "--no-clobber --force", "-nf", "-n -f"]) assert.deepEqual(both("mv", flags), [vendor], flags);
  for (const flags of ["-f -n", "-fn", "-n", "--no-clobber"]) assert.deepEqual([...both("mv", flags)!].sort(), [vendor, other].sort(), flags);
});

test("pins: a known empty target, clustered -t/-S flags and flags after the paths", () => {
  const d = "@sha256:" + "f".repeat(64);
  const dir = "/etc/apt/sources.list.d";
  const vendor = `${dir}/vendor.list`, other = `${dir}/other.list`;
  const write = `RUN echo 'deb https://vendor.example/apt bookworm main' > ${vendor}`;
  const writeOther = `RUN echo 'deb https://other.example/apt bookworm main' > ${other}`;
  const unpinned = "RUN apt-get install -y foo";
  const problems = (line: string) => scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\n${writeOther}\nRUN ${line}\n${unpinned}\n`).problems;
  const sources = (line: string) => scanFile("Dockerfile", `FROM debian:bookworm${d}\n${write}\n${writeOther}\nRUN ${line}\nRUN apt-get install -y foo=1.0\n`).pins.filter((p) => p.kind === "apt")[0]!.sources!.map((s) => s.split(" ")[0]);
  // A target this stage wrote empty certainly exists, so `-n` skips the copy and adds no repository: GNU `cp -n` leaves
  // an existing file alone (`cp -n -f` too, since `cp`'s `-f` never cancels `-n`), and the install needs no pin.
  for (const flags of ["-n", "-n -f", "-nf", "--no-clobber", "--no-clobber --force"]) {
    const empty = `FROM debian:bookworm${d}\nRUN cat /dev/null > ${vendor}\nRUN cp ${flags} /tmp/from-image.list ${vendor}\n${unpinned}\n`;
    assert.deepEqual(scanFile("Dockerfile", empty).problems, [], flags);
  }
  // ...while a replacing copy of the same known-empty target does record the file (unknown content: a path from the image).
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat /dev/null > ${vendor}\nRUN cp /tmp/from-image.list ${vendor}\n${unpinned}\n`).problems.length, 1);
  // `cp -n` onto a target holding a repository leaves that repository exactly as it was: no merge with the source's.
  assert.deepEqual([...sources(`cp -n ${vendor} ${other}`)!].sort(), ["https://other.example/apt", "https://vendor.example/apt"]);
  assert.deepEqual(sources(`cp -f ${vendor} ${other}`), ["https://vendor.example/apt"]);
  assert.deepEqual([...sources(`cp -n -f ${vendor} ${other}`)!].sort(), ["https://other.example/apt", "https://vendor.example/apt"]);
  // `mv -n` onto a known target certainly does nothing: both files stay, so both repositories are kept and nothing is
  // lost. A plain `mv` renames the source away.
  assert.deepEqual([...sources(`mv -n ${vendor} ${other}`)!].sort(), ["https://other.example/apt", "https://vendor.example/apt"]);
  assert.deepEqual(sources(`mv ${vendor} ${other}`), ["https://vendor.example/apt"]);
  // `-i` asks, so it may go either way: both repositories are kept.
  for (const flags of ["-i", "--interactive", "-n -i -f"]) {
    assert.deepEqual([...sources(`cp ${flags} ${vendor} ${other}`)!].sort(), ["https://other.example/apt", "https://vendor.example/apt"], flags);
  }
  // A cluster that carries `-t`/`-S`'s value still reads the flags before it: `-nt dir` is no-clobber into dir.
  // `vendor.list` is written empty, so it exists: `-nt` into its directory skips it, while `-f -nt` replaces it with
  // content the scanner can't read and the install needs a pin.
  const into = (line: string) => scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cat /dev/null > ${vendor}\nRUN cp ${line}\n${unpinned}\n`).problems;
  // `-t dir` names the target by the source's own name: `/tmp/vendor.list` lands on the existing `vendor.list`.
  // Every flag before `-t` in its cluster is read (`-nt` is `n` then `t`, whose value is the next word), and `-t` as
  // the cluster's first letter takes the whole rest as its value (`-tn` is `-t n`, as GNU reads it).
  for (const flags of ["-nt", "-n -t", "--no-clobber -t", "-nf -nt", "-f -nt", "-fnt", "-nf -f -t"]) {
    assert.equal(into(`${flags} ${dir} /tmp/vendor.list`).length, 0, flags);
  }
  assert.equal(into(`-nt${dir} /tmp/vendor.list`).length, 0);
  // GNU getopt permutes: a flag after the paths still applies, and is not read as a destination.
  assert.deepEqual([...sources(`mv ${vendor} ${other} -n`)!].sort(), ["https://other.example/apt", "https://vendor.example/apt"]);
  assert.deepEqual([...sources(`cp ${vendor} ${other} --no-clobber`)!].sort(), ["https://other.example/apt", "https://vendor.example/apt"]);
  assert.deepEqual(sources(`cp ${vendor} ${other} -f`), ["https://vendor.example/apt"]);
  // No-clobber is decided for each destination on its own: `vendor.list` was written empty (so `-n` skips it), while
  // `other.list` is fresh (so the source lands there). Only the fresh one adds a repository.
  const mixed = `FROM debian:bookworm${d}\nRUN cat /dev/null > ${vendor}\nRUN cp -n /tmp/from-image.list /tmp/other.list ${dir}/\n${unpinned}\n`;
  assert.equal(scanFile("Dockerfile", mixed).problems.length, 1);
  // A conditional empty write may have been skipped, so the file is not known to exist: a later `cp -n` onto it may land
  // its content, and the install still needs a pin.
  const conditional = `FROM debian:bookworm${d}\nRUN test -f /tmp/m && : > ${vendor} || true\nRUN cp -n /tmp/from-image.list ${vendor}\n${unpinned}\n`;
  assert.equal(scanFile("Dockerfile", conditional).problems.length, 1);
  // ...whereas an empty write that certainly ran (`true &&`, or on its own line) is a known file, and `-n` skips it.
  for (const line of [`true && : > ${vendor}`, `: > ${vendor}`]) {
    const known2 = `FROM debian:bookworm${d}\nRUN ${line}\nRUN cp -n /tmp/from-image.list ${vendor}\n${unpinned}\n`;
    assert.deepEqual(scanFile("Dockerfile", known2).problems, [], line);
  }
  // A target from the image is not one the stage knows: only the source's repository is certainly there (over-reporting).
  assert.equal(scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN cp -n /tmp/from-image.list ${vendor}\n${unpinned}\n`).problems.length, 1);
  // A guarded write may not have run, so the file it names is not certainly there: a `cp -n` that follows on the same
  // chain may replace what the write left, so the repository it wrote is kept beside the copy's (both date a pin).
  const chain = `FROM debian:bookworm${d}\nRUN test -f /tmp/m && printf 'deb https://vendor.example/apt stable main\n' > ${vendor} && cp -n /tmp/empty.list ${vendor}\nRUN apt-get install -y foo=1.0\n`;
  assert.deepEqual(scanFile("Dockerfile", chain).pins.filter((p) => p.kind === "apt")[0]!.sources, ["https://vendor.example/apt stable main"]);
  // ...and a `cp -n` on a later line onto that may-be file also records the copy's content (the file may not be there).
  const laterLine = `FROM debian:bookworm${d}\nRUN test -f /tmp/m && printf 'deb https://vendor.example/apt stable main\n' > ${vendor}\nRUN cp -n /tmp/from-image.list ${vendor}\n${unpinned}\n`;
  assert.equal(scanFile("Dockerfile", laterLine).problems.length, 1);
  // A guarded write that may have run still counts as adding a repository: the install after it needs a pin, on its own
  // line and later in the same chain.
  const enabled = `FROM debian:bookworm${d}\nRUN test -f /tmp/enable && echo 'deb https://vendor.example/apt stable main' > ${vendor}`;
  assert.equal(scanFile("Dockerfile", `${enabled} && apt-get update && apt-get install -y foo\n`).problems.length, 1);
  assert.equal(scanFile("Dockerfile", `${enabled}\n${unpinned}\n`).problems.length, 1);
});

test("pins: the four parser cases the WOR-10451 follow-up names, end to end", async () => {
  const d = "@sha256:" + "f".repeat(64);
  const dir = "/etc/apt/sources.list.d";
  // (a) `COPY --from=<stage>` of a sources.list.d file carries the builder's repository into the destination stage: an
  // install there is unpinned, and the exact pin is dated from that repository.
  const carried = `FROM debian:bookworm${d} AS builder\nRUN echo 'deb https://vendor.example/apt bookworm main' > ${dir}/vendor.list\nFROM debian:bookworm${d}\nCOPY --from=builder ${dir}/vendor.list ${dir}/\nRUN apt-get install -y foo`;
  const carriedResult = scanFile("Dockerfile", carried);
  assert.equal(carriedResult.problems.length, 1);
  assert.match(carriedResult.problems[0], /apt install foo after an apt repository is added: pin it/);
  const carriedPin = scanFile("Dockerfile", carried.replace("install -y foo", "install -y foo=1.0")).pins.filter((p) => p.kind === "apt")[0]!;
  assert.deepEqual(carriedPin.sources, ["https://vendor.example/apt bookworm main"]);
  const carriedTried: string[] = [];
  await dateApt(carriedPin, async (_k, _n, { source }) => { carriedTried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(carriedTried, ["https://vendor.example/apt bookworm main"]);

  // (b) A Deb822 `.sources` written by a heredoc dates a pin from its Types/URIs/Suites/Components: the URI, suite and
  // component are exactly the source tried (Components defaults to `main`).
  const deb822 = `FROM debian:bookworm${d}\nRUN tee ${dir}/vendor.sources <<'EOF'\nTypes: deb\nURIs: https://vendor.example/apt\nSuites: bookworm\nComponents: main\nEOF\nRUN apt-get install -y foo=1.0\n`;
  const deb822Pin = scanFile("Dockerfile", deb822).pins.filter((p) => p.kind === "apt")[0]!;
  const deb822Tried: string[] = [];
  await dateApt(deb822Pin, async (_k, _n, { source }) => { deb822Tried.push(source); return { published: day(30), via: "test" }; });
  assert.deepEqual(deb822Tried, ["https://vendor.example/apt bookworm main"]);
  // Several components and suites spell out every combination (a deb-src-only or `Enabled: no` stanza is not one; each
  // is covered in the Deb822 tests above).
  const multi = `FROM debian:bookworm${d}\nRUN tee ${dir}/m.sources <<'EOF'\nTypes: deb\nURIs: https://a.example/apt\nSuites: bookworm bookworm-backports\nComponents: main contrib\nEOF\nRUN apt-get install -y foo=1.0\n`;
  const multiPin = scanFile("Dockerfile", multi).pins.filter((p) => p.kind === "apt")[0]!;
  assert.deepEqual(multiPin.sources, [
    "https://a.example/apt bookworm main", "https://a.example/apt bookworm contrib",
    "https://a.example/apt bookworm-backports main", "https://a.example/apt bookworm-backports contrib",
  ]);

  // (c) A Debian base dates from its release, then -updates, then -security; the security index arrives as Packages.xz
  // only and is decoded by the system `xz` (no package.json dependency), with a pinned exact version landing on it.
  const [debPin] = scanFile("Dockerfile", `FROM debian:bookworm${d}\nRUN apt-get install -y curl=7.88.1-10+deb12u12\n`).pins.filter((p) => p.kind === "apt");
  const pockets: string[] = [];
  await dateApt(debPin, async (_k, _n, { source }) => {
    pockets.push(source);
    if (!source.includes("bookworm-security")) throw Object.assign(new Error(`not in ${source}`), { notListed: true });
    return { published: day(30), via: "test" };
  });
  assert.deepEqual(pockets, ["http://deb.debian.org/debian bookworm main", "http://deb.debian.org/debian bookworm-updates main", "http://deb.debian.org/debian bookworm-security main"]);
  // The xz decoding itself is its own test below, so these cases run on a machine with no `xz`.
  const deps = Object.keys(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies ?? {});
  assert.deepEqual(deps, ["yaml"]);

  // (d) `tee`'s stdin filename ends at an unquoted shell operator: `tee f < /tmp/x</dev/null` is two redirects, and the
  // shell applies the last one, so the file is written empty and its repository is gone.
  const written = `RUN echo 'deb https://vendor.example/apt bookworm main' > ${dir}/vendor.list`;
  for (const line of [`tee ${dir}/vendor.list < /tmp/x</dev/null`, `tee ${dir}/vendor.list </tmp/x</dev/null`, `tee ${dir}/vendor.list < /tmp/x < /dev/null`, `cat </tmp/x</dev/null > ${dir}/vendor.list`]) {
    assert.deepEqual(scanFile("Dockerfile", `FROM debian:bookworm${d}\n${written}\nRUN ${line}\nRUN apt-get install -y foo\n`).problems, [], line);
  }
});

test("pins: Packages.xz decodes with the system xz, without a package.json dependency", { skip: hasXz ? false : "no system xz on PATH" }, async () => {
  const { readAptIndex } = await import("../supply-chain/best-version.ts");
  // A real xz archive built with the system binary: the security index decodes to the package it holds.
  const archive = execFileSync("xz", ["-c"], { input: "Package: curl\nVersion: 7.88.1-10+deb12u12\nFilename: pool/c.deb\n\n" });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) => String(url).endsWith("Packages.xz") ? new Response(archive, { status: 200 }) : new Response("not found", { status: 404 })) as typeof fetch;
    const pkgs = await readAptIndex("https://deb.debian.org/debian bookworm-security main");
    assert.deepEqual(pkgs.filter((p) => p.Package).map((p) => `${p.Package} ${p.Version}`), ["curl 7.88.1-10+deb12u12"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
