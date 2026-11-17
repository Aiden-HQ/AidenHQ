// Runs locally what CI would run for your diff: node scripts/ci-local.mjs [--base <ref>] [--list]
// The selection is CI's own (.github/ci/select.mjs over .github/ci/areas.json) and each suite's command is its `run` there,
// the same one ci.yml executes (the flows suite's `run` is the unsharded form of CI's four shards). The diff is the
// merge-base with the base (default origin/main) plus uncommitted and untracked files. The supply-chain checks run on
// every change, as in CI. --list prints the selection only.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suitesFor } from "../.github/ci/select.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const list = args.includes("--list");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "origin/main";

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const lines = (s) => s.split("\n").filter(Boolean);

/** The changed files, as CI's selector gets them, plus the working tree. */
export function changedFiles(mergeBase) {
  return [...new Set([...lines(git("diff", "--name-only", mergeBase)), ...lines(git("ls-files", "--others", "--exclude-standard"))])];
}

/** The suites to run for these files, from CI's selector and map. */
export function select(files) {
  const map = JSON.parse(readFileSync(join(root, ".github/ci/areas.json"), "utf8"));
  const sel = suitesFor(map, files);
  return { ...sel, suites: map.suites.filter((s) => sel.names.includes(s.name)) };
}

async function main() {
  const mergeBase = git("merge-base", base, "HEAD");
  const files = changedFiles(mergeBase);
  const sel = select(files);
  console.log(`Diff against ${base} (merge-base ${mergeBase.slice(0, 12)}): ${files.length} file(s)`);
  console.log(sel.all ? `Every suite: ${sel.why}` : sel.names.length ? "Suites touched by the changed files" : "No suite needs testing");
  for (const s of sel.suites) console.log(`  ${s.name}${s.job ? ` (CI job ${s.job})` : ""}: ${s.run ?? "npm test"}`);
  console.log("  supply-chain (always): npm-age.mjs, pins.mjs");
  if (list) return;

  // The official modules at the product's pin, as CI checks them out.
  const pin = JSON.parse(readFileSync(join(root, "modules-pin.json"), "utf8")).sha;
  const mark = join(root, "modules/.sha");
  if (sel.suites.length && !(existsSync(mark) && readFileSync(mark, "utf8").trim() === pin)) {
    console.log(`modules/ is missing or not at ${pin.slice(0, 12)}: materializing`);
    execFileSync("node", ["scripts/modules-repo/materialize.mjs", "."], { cwd: root, stdio: "inherit" });
  }

  // `npm ci` once per package (a suite's own `npm ci` is a no-op below): suites share kernel/ and services/runner/.
  const installs = new Set(sel.suites.length ? ["scripts"] : []);
  for (const s of sel.suites) {
    const dir = s.name.split("#")[0];
    for (const [, cd] of (s.run ?? "").matchAll(/cd (\S+) && npm ci/g)) installs.add(join(dir, cd));
    if (/^npm ci|\) && npm ci/.test(s.run ?? "")) installs.add(dir);
    if (s.name === "scripts") installs.add("services/runner");
  }
  for (const d of installs) {
    const dir = resolve(root, d);
    const have = join(dir, "node_modules/.package-lock.json");
    if (existsSync(have) && statSync(have).mtimeMs >= statSync(join(dir, "package-lock.json")).mtimeMs) continue;
    console.log(`npm ci in ${d}`);
    execFileSync("npm", ["ci"], { cwd: dir, stdio: "inherit" });
  }

  const tmp = mkdtempSync(join(tmpdir(), "ci-local-"));
  const shim = join(tmp, "bin");
  mkdirSync(shim);
  writeFileSync(join(shim, "npm"), `#!/bin/sh\n[ "$1" = ci ] && exit 0\nPATH="\${PATH#${shim}:}" exec npm "$@"\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${shim}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci@example.com", GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci@example.com",
  };

  const jobs = sel.suites.map((s) => ({ name: s.name, cwd: join(root, s.name.split("#")[0]), cmd: s.run ?? "npm test" }));
  jobs.push({ name: "supply-chain", cwd: root, cmd: `s=0; node scripts/supply-chain/npm-age.mjs ${mergeBase} HEAD || s=1; node scripts/supply-chain/pins.mjs ${mergeBase} HEAD || s=1; exit $s` });
  const results = await Promise.all(jobs.map((j) => new Promise((done) => {
    const log = join(tmp, `${j.name.replace(/\W/g, "_")}.log`);
    const t0 = Date.now();
    const out = [];
    const p = spawn("bash", ["-eo", "pipefail", "-c", j.cmd], { cwd: j.cwd, env });
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => out.push(d));
    p.on("close", (code) => {
      const text = Buffer.concat(out).toString();
      writeFileSync(log, text);
      const failed = text.split("\n").filter((l) => /^\s*✖/.test(l));
      // The flock apply tests can't pass on macOS: shown, never hidden, and judged by CI.
      const expected = code !== 0 && process.platform === "darwin" && failed.length > 0 && failed.every((l) => /flock|apply/i.test(l));
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`${code === 0 ? "ok  " : expected ? "EXPECTED on macOS (flock apply tests, judged in CI)" : "FAIL"} ${j.name} (${secs}s)${code === 0 ? "" : ` log: ${log}`}`);
      if (code !== 0 && !expected) console.log(text.split("\n").slice(-30).join("\n"));
      done(code === 0 || expected);
    });
  })));
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `${bad} suite(s) failed` : "All selected suites passed");
  process.exitCode = bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
