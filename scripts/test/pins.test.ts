// best-version.ts (which version to pin) and pins.ts (everything pinned, nothing new under 7 days), offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bestVersion, publishedAt } from "../supply-chain/best-version.ts";
import { checkAges, dateApt, scanFile } from "../supply-chain/pins.ts";

test("pins: an apt pin falls back to the distro only when the file's own repository cleanly doesn't list it", async () => {
  const pin = { name: "tool", version: "1.2.3", sources: ["https://repo.example/apt noble main"] };
  const notListed = () => Object.assign(new Error("not in"), { notListed: true });
  const ok = { published: "2020-01-01T00:00:00Z", via: "test" };
  const tried = [];
  const lookup = (behaviour) => async (_kind, _name, { source }) => {
    tried.push(source);
    const b = behaviour(source);
    if (b instanceof Error) throw b;
    return b;
  };
  // The file's repository can't be read: fail, never date the package from Ubuntu.
  await assert.rejects(dateApt(pin, lookup((s) => (s.includes("repo.example") ? new Error("fetch failed") : ok))), /fetch failed/);
  assert.deepEqual(tried, ["https://repo.example/apt noble main"]);
  // Read fine and not there: the distro's pockets date it.
  assert.equal(await dateApt(pin, lookup((s) => (s.includes("repo.example") ? notListed() : ok))), ok);
  // Listed nowhere.
  await assert.rejects(dateApt(pin, lookup(() => notListed())), /no apt repository/);
});

const now = Date.parse("2026-11-13T00:00:00Z");
const day = (n) => new Date(now - n * 86400000).toISOString();
const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

test("best-version: newest 7+ days old; a known vulnerability or a listed exception returns the newer fix", async (t) => {
  const vulns = {};
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).startsWith("https://registry.npmjs.org/")) return json({ time: { "1.0.0": day(90), "1.1.0": day(20), "1.1.1": day(3), "2.0.0-rc.1": day(30) } });
    if (url === "https://api.osv.dev/v1/query") return json({ vulns: vulns[JSON.parse(init.body).version] || [] });
    throw new Error(`unexpected ${url}`);
  });
  assert.equal((await bestVersion("npm", "tiny", { now })).version, "1.1.0");
  vulns["1.1.0"] = [{ id: "GHSA-aaaa-bbbb-cccc", affected: [{ package: { name: "tiny" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "1.1.1" }] }] }] }];
  const fix = await bestVersion("npm", "tiny", { now });
  assert.equal(fix.version, "1.1.1");
  assert.match(fix.note, /security fix: under 7 days \(GHSA-aaaa-bbbb-cccc\)/);
  delete vulns["1.1.0"];
  const listed = await bestVersion("npm", "tiny", { now, exceptions: [{ ecosystem: "npm", package: "tiny", version: "1.1.1", advisory: "GHSA-x" }] });
  assert.equal(listed.version, "1.1.1");
  assert.match(listed.note, /GHSA-x/);
  // a listed version older than what the rule now allows no longer wins
  assert.equal((await bestVersion("npm", "tiny", { now, exceptions: [{ ecosystem: "npm", package: "tiny", version: "1.0.0", advisory: "GHSA-x" }] })).version, "1.1.0");
});

test("image dates come only from registry push records: a moved tag with no other holder, or another registry, fails closed", async (t) => {
  const d = "sha256:" + "c".repeat(64);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/tags/17.11")) return json({ digest: "sha256:" + "d".repeat(64), tag_last_pushed: day(1) }); // the tag moved on
    if (String(url).includes("hub.docker.com")) return json({ results: [{ name: "17.11-old", digest: d, tag_last_pushed: day(20) }], next: null });
    throw new Error(`unexpected ${url}`);
  });
  assert.equal((await publishedAt("docker", "postgres:17.11", { digest: d })).published, day(20));
  await assert.rejects(publishedAt("docker", "postgres:17.11", { digest: "sha256:" + "e".repeat(64) }), /can't establish its publish time/);
  await assert.rejects(publishedAt("docker", "quay.io/acme/app:1.0", { digest: d }), /can't establish its publish time/);
});

test("ghcr images are dated across Packages API pages, with the read token sent to that API only", async (t) => {
  const d = "sha256:" + "f".repeat(64);
  const v = (name, tag) => ({ name, created_at: day(20), metadata: { container: { tags: [tag] } } });
  const page1 = Array.from({ length: 100 }, (_, i) => v("sha256:" + String(i).padStart(64, "0"), `t${i}`));
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push([String(url), init.headers.authorization]);
    if (String(url).startsWith("https://api.github.com/orgs/acme/packages/container/app/versions")) {
      return json(new URL(url).searchParams.get("page") === "1" ? page1 : [v(d, "1.0")]);
    }
    throw new Error(`unexpected ${url}`);
  });
  process.env.PACKAGES_READ_TOKEN = "pkg-token";
  try { assert.equal((await publishedAt("docker", "ghcr.io/acme/app:1.0", { digest: d })).published, day(20)); } finally { delete process.env.PACKAGES_READ_TOKEN; }
  assert.equal(seen.length, 2);
  for (const [url, auth] of seen) assert.ok(url.startsWith("https://api.github.com/") && auth === "Bearer pkg-token", url);
});

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
  // A registry that keeps no push record for a pin fails it, unless a security exception names it exactly (its digest too).
  const [img] = scanFile("Dockerfile", `FROM postgres:17.12@sha256:${"d".repeat(64)}\n`).pins;
  const undatable = async () => { throw Object.assign(new Error("no push record"), { undated: true }); };
  const ex = { ecosystem: "docker", package: "postgres", version: "17.12", advisory: "CVE-x" };
  assert.match((await checkAges({ pins: [img], exceptions: [ex], date: undatable, now }))[0], /could not be dated/, "the version alone doesn't vouch for a digest");
  assert.deepEqual(await checkAges({ pins: [img], exceptions: [{ ...ex, digest: img.digest }], date: undatable, now }), []);
  assert.match((await checkAges({ pins: [img], exceptions: [{ ...ex, digest: img.digest }], date: async () => { throw new Error("503"); }, now }))[0], /could not be dated: 503/, "a lookup error stands");
  // An owner-approved exception covers a too-new pin only for its exact digest, and only until it expires (14 days at most).
  const fresh = async () => ({ published: day(2), via: "registry" });
  const owner = (over) => [{ ecosystem: "docker", package: "postgres", version: "17.12", owner: "approved", digest: img.digest, expires: new Date(now + 3 * 86400000).toISOString().slice(0, 10), ...over }];
  assert.deepEqual(await checkAges({ pins: [img], exceptions: owner({}), date: fresh, now }), []);
  for (const over of [{ digest: undefined }, { digest: `sha256:${"e".repeat(64)}` }, { expires: "2020-01-01" }, { expires: new Date(now + 30 * 86400000).toISOString().slice(0, 10) }]) {
    assert.equal((await checkAges({ pins: [img], exceptions: owner(over), date: fresh, now })).length, 1, JSON.stringify(over));
  }
});

test("pins: ops/vm/pins.json with no releases dates its apt for the default release; a changed repo or distro is dated again", async () => {
  const text = (repos, extra = {}) => JSON.stringify({ repos, apt: { tailscale: "1.0.0" }, ...extra }, null, 2);
  const one = scanFile("ops/vm/pins.json", text({ t: "https://pkgs.tailscale.com/stable/{distro} {codename} main" }));
  assert.deepEqual([one.problems, one.pins.map((p) => `${p.name}=${p.version} ${p.release} ${p.sources}`)], [[], ["tailscale=1.0.0 noble https://pkgs.tailscale.com/stable/ubuntu noble main"]]);
  assert.deepEqual(scanFile("ops/vm/pins.json", text({}, { releases: {} })).pins.map((p) => p.release), ["noble"]);
  // The same version from another repository: not the base's pin, so it is dated.
  const moved = scanFile("ops/vm/pins.json", text({ t: "https://evil.example.com/{distro} {codename} main" })).pins;
  const dated = [];
  await checkAges({ pins: moved, basePins: one.pins, date: async (p) => { dated.push(p.name); return { published: "2020-01-01", via: "test" }; } });
  assert.deepEqual(dated, ["tailscale"]);
  // An apt block no release can read is a problem, never skipped.
  assert.equal(scanFile("ops/vm/pins.json", text({}, { releases: ["noble"] })).problems.length, 1);
  assert.equal(scanFile("ops/vm/pins.json", text({}, { releases: { noble: "x" } })).problems.length, 1);
});

test("pins: ops/vm/pins.json pins each release from its repos as that release reads them, then its distro", async () => {
  const text = JSON.stringify({
    repos: { docker: "https://download.docker.com/linux/{distro} {codename} stable" },
    apt: { nodejs: "24.0.0-1nodesource1" },
    releases: { noble: { distro: "ubuntu", apt: { "docker-ce": "5:1-1~ubuntu.24.04~noble" } }, trixie: { distro: "debian", apt: { fail2ban: "1.1.0-8" } } },
  }, null, 2);
  const pins = scanFile("ops/vm/pins.json", text).pins;
  assert.deepEqual(pins.map((p) => `${p.name}=${p.version} ${p.release}`), ["nodejs=24.0.0-1nodesource1 noble", "docker-ce=5:1-1~ubuntu.24.04~noble noble", "nodejs=24.0.0-1nodesource1 trixie", "fail2ban=1.1.0-8 trixie"]);
  const tried = [];
  const notListed = async (_k, _n, { source }) => { tried.push(source); throw Object.assign(new Error("not in"), { notListed: true }); };
  await assert.rejects(dateApt(pins[3], notListed), /no apt repository/);
  assert.deepEqual(tried, ["https://download.docker.com/linux/debian trixie stable", "http://deb.debian.org/debian trixie main"]);
});
