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
    `image:\n        # pinned\n        postgres:17.12${d("c")}`,
    `image:\n\n        postgres:17.12${d("c")}`,
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
  // An `image:` whose value the walk cannot read as a plain reference is a problem, never a silent skip: an interpolated
  // ref (the compiler would expand it), a key with no value at all, and a comment-only block scalar.
  assert.match(scanFile("modules/x/module.yaml", `services:\n  run:\n    db:\n      image: \${REG}/postgres:17${d("a")}\n`).problems[0]!, /not a plain reference/);
  assert.match(scanFile("modules/x/module.yaml", `services:\n  run:\n    db:\n      image:\n        # nothing\n`).problems[0]!, /image has no value/);
  assert.match(scanFile("modules/x/module.yaml", `services:\n  run:\n    db:\n      image: |\n        # nothing\n`).problems[0]!, /image has no value/);
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
