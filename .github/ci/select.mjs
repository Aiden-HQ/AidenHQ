// Which test suites a change needs (ci.yml's image-changes job), from the map in areas.json. On a pull request both files
// are read from the base commit, so a PR can't shrink its own test set. No dependencies: it runs before anything is installed.
//
// A file counts unless it is under docs/ or is Markdown outside the map's `markdown` list (Markdown the tests read). A
// counted file under `everything` (CI's own definition, shared code, the modules pin) or under no suite's paths selects
// every suite: the filter never fails open. A suite whose paths are "*" runs for any counted file.
//
// Reuse after a rebase: when the PR's patch (git patch-id) equals that of an earlier head whose ci run passed, only the
// suites both the PR and the commits main gained since that head touch run again. The rest passed on that head with the
// same inputs, and main's own full run covers main's side. Anything unsure (no earlier green, an unfetchable head, an API
// error, a patch that changes CI itself) falls back to the PR's normal selection.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const under = (f, p) => f === p || f.startsWith(`${p}/`);
const counted = (map, f) => !under(f, "docs") && (!f.endsWith(".md") || map.markdown.some((p) => under(f, p)));

/** { all, why, names }: the suites these changed files need. */
export function suitesFor(map, files) {
  const every = (why) => ({ all: true, why, names: map.suites.map((s) => s.name) });
  const code = files.filter((f) => counted(map, f));
  const ci = code.find((f) => map.everything.some((p) => under(f, p)));
  if (ci) return every(`${ci} changes CI or shared code`);
  const known = map.suites.flatMap((s) => s.paths).filter((p) => p !== "*").concat(map.markdown);
  const stray = code.find((f) => !known.some((p) => under(f, p)));
  if (stray) return every(`${stray} is under no suite`);
  const names = map.suites
    .filter((s) => code.some((f) => !(s.ignore ?? []).includes(f) && s.paths.some((p) => p === "*" || under(f, p))))
    .map((s) => s.name);
  return { all: false, names };
}

/** The suites to run again on a rebased head: those both the PR and main's gained commits touch. */
export function reuse(map, prFiles, gainedFiles) {
  const pr = suitesFor(map, prFiles).names;
  const gained = suitesFor(map, gainedFiles);
  return gained.all ? pr : pr.filter((n) => gained.names.includes(n));
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const changed = (a, b) => git("diff", "--name-only", a, b).split("\n").filter(Boolean);
const patchId = (base, head) => {
  const mb = git("merge-base", base, head);
  const diff = execFileSync("git", ["diff", mb, head], { maxBuffer: 256 << 20 });
  return execFileSync("git", ["patch-id", "--stable"], { input: diff, encoding: "utf8" }).split(" ")[0] || undefined;
};

/** The newest earlier head of this PR whose ci run passed, else undefined. */
async function earlierGreen({ repo, number, headRef, head, token }) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=30&branch=${encodeURIComponent(headRef)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`listing runs: ${res.status}`);
  const run = (await res.json()).workflow_runs.find((r) => r.head_sha !== head && r.pull_requests?.some((p) => p.number === number));
  return run?.head_sha;
}

async function main() {
  const env = process.env;
  const map = JSON.parse(readFileSync(env.MAP, "utf8"));
  // Run commands come from the PR's own map: a PR may change how a suite runs, never which suites it gets.
  const runs = env.HEAD_MAP ? JSON.parse(readFileSync(env.HEAD_MAP, "utf8")).suites : [];
  const files = changed(env.BASE, env.HEAD);
  let names;
  if (env.ALL) {
    names = map.suites.map((s) => s.name);
    console.error(`Every suite: ${env.ALL}`);
  } else {
    const sel = suitesFor(map, files);
    names = sel.names;
    if (sel.all) console.error(`Every suite: ${sel.why}`);
    const prFiles = changed(git("merge-base", env.BASE, env.PR_HEAD), env.PR_HEAD);
    if (names.length && !prFiles.some((f) => map.everything.some((p) => under(f, p)))) {
      try {
        const old = await earlierGreen({ repo: env.REPO, number: Number(env.PR_NUMBER), headRef: env.PR_HEAD_REF, head: env.PR_HEAD, token: env.GH_TOKEN });
        if (old) {
          const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64")}`;
          git("-c", `http.extraheader=${auth}`, "fetch", "--no-tags", "--quiet", "origin", old);
          const now = patchId(env.BASE, env.PR_HEAD);
          if (now && now === patchId(env.BASE, old)) {
            const gained = changed(git("merge-base", env.BASE, old), env.BASE);
            names = reuse(map, files, gained);
            console.error(`Same patch as ${old.slice(0, 12)}, which passed; main gained ${gained.length} file(s) since: re-running ${names.join(" ") || "nothing"}`);
          } else console.error(`The patch changed since ${old.slice(0, 12)}, the last green head: no reuse`);
        }
      } catch (err) {
        console.error(`No reuse: ${String(err.message || err).split("\n")[0]}`);
      }
    }
  }
  // A slow suite (`main: true`) runs only on a push to main (MAIN): a flake there never holds a PR or a merge train.
  const tests = map.suites
    .filter((s) => names.includes(s.name) && (!s.main || env.MAIN))
    .map((s) => {
      const own = runs.find((r) => r.name === s.name) ?? s;
      return { name: s.name, dir: s.name.split("#")[0], ...(own.job ? { job: own.job } : { run: own.run }) };
    });
  process.stdout.write(`${JSON.stringify({ tests, packages: tests.some((t) => !t.job) })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
