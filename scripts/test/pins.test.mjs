// best-version.mjs (which version to pin) and pins.mjs (everything pinned, nothing new under 7 days), offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bestVersion, publishedAt } from "../supply-chain/best-version.mjs";
import { checkAges, scanFile } from "../supply-chain/pins.mjs";

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
  assert.deepEqual(sh.pins[0].sources, ["https://repo.example/apt noble main"]);

  const pins = scanFile("ops/setup.sh", "npm install -g a@1.0.0 b@2.0.0 c@3.0.0\n").pins;
  const dates = { a: day(30), b: day(2), c: day(1) };
  const date = async (p) => ({ published: dates[p.name], via: "npm publish time" });
  const problems = await checkAges({ pins, basePins: [pins[0]], exceptions: [{ ecosystem: "npm", package: "c", version: "3.0.0", advisory: "GHSA-x" }], date, now });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b 2\.0\.0 was published 2\.0 days ago/);
});
