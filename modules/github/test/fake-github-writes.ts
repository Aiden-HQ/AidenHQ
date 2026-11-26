// GitHub's write API over bare repos, as the code host's signed writes use it: createCommitOnBranch (GitHub's own commit, bound to
// expectedHeadOid, each file replaced in full, an existing file keeping its mode, a new one 100644), and git/refs create, read and
// delete (updateRefs too), git/commits, and the rules that apply to a branch. `originOf(slug)` is the bare repo GitHub holds for a repo; `refuse(input)`
// is a repository rule's words refusing a commit; `signed(slug, branch)` says the branch's rules require signed commits. Any other
// route answers undefined, for the test's own fake.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function githubWrites(originOf, { refuse = (_input) => undefined, signed = (_slug, _branch) => false } = {}) {
  const git = (origin, args, o = {}) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: origin, encoding: "utf8", ...o, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_AUTHOR_NAME: "owner1", GIT_AUTHOR_EMAIL: "owner1@example.com", ...o.env } }).trim();
  const tip = (origin, ref) => { try { return git(origin, ["rev-parse", "--verify", "--quiet", ref]); } catch { return ""; } };
  return (method, path, body) => {
    const rules = method === "GET" && /^\/repos\/([^/]+\/[^/]+)\/rules\/branches\/([^?]+)/.exec(path);
    if (rules) return { status: 200, body: signed(rules[1], decodeURIComponent(rules[2])) ? [{ type: "required_signatures", ruleset_id: 1 }] : [] };
    if (path === "/graphql" && String(body?.query ?? "").includes("createCommitOnBranch")) {
      const { branch, expectedHeadOid, message, fileChanges } = body.variables.input;
      const origin = originOf(branch.repositoryNameWithOwner);
      const said = refuse(body.variables.input);
      if (said) return { status: 200, body: { data: { createCommitOnBranch: null }, errors: [{ type: "UNPROCESSABLE", message: said }] } };
      const ref = `refs/heads/${branch.branchName}`;
      if (tip(origin, ref) !== expectedHeadOid) return { status: 200, body: { data: { createCommitOnBranch: null }, errors: [{ type: "STALE_DATA", message: `Expected branch to point to "${expectedHeadOid}" but it did not. Pull and try again.` }] } };
      const scratch = mkdtempSync(join(tmpdir(), "fake-gh-index-"));
      try {
        const env = { GIT_INDEX_FILE: join(scratch, "index") };
        git(origin, ["read-tree", expectedHeadOid], { env });
        for (const d of fileChanges.deletions ?? []) git(origin, ["update-index", "-z", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${d.path}\0` });
        for (const f of fileChanges.additions ?? []) {
          const mode = git(origin, ["ls-files", "-s", "--", f.path], { env }).split(" ")[0] || "100644";
          git(origin, ["update-index", "--add", "--cacheinfo", `${mode},${git(origin, ["hash-object", "-w", "--stdin"], { input: Buffer.from(f.contents, "base64") })},${f.path}`], { env });
        }
        const tree = git(origin, ["write-tree"], { env });
        const sha = git(origin, ["commit-tree", tree, "-p", expectedHeadOid, "-m", [message.headline, message.body].filter(Boolean).join("\n\n")]);
        git(origin, ["update-ref", ref, sha]);
        return { status: 200, body: { data: { createCommitOnBranch: { commit: { oid: sha, tree: { oid: tree } } } } } };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    // updateRefs, bound to each ref's beforeOid (a mismatch is GitHub's generic error and changes nothing). The test's repository
    // node_id is its slug.
    if (path === "/graphql" && String(body?.query ?? "").includes("updateRefs")) {
      const { repositoryId, refUpdates } = body.variables.input;
      const origin = originOf(repositoryId);
      if (refUpdates.some((u) => tip(origin, u.name) !== u.beforeOid)) return { status: 200, body: { errors: [{ message: "Something went wrong while executing your query." }] } };
      for (const u of refUpdates) git(origin, /^0+$/.test(u.afterOid) ? ["update-ref", "-d", u.name] : ["update-ref", u.name, u.afterOid]);
      return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/git\/(refs\/heads|ref\/heads|refs|commits)(?:\/(.*))?$/.exec(path);
    if (!m) return undefined;
    const origin = originOf(m[1]);
    const name = decodeURIComponent(m[3] ?? "");
    if (method === "POST" && m[2] === "refs") {
      if (tip(origin, body.ref)) return { status: 422, body: { message: "Reference already exists" } };
      git(origin, ["update-ref", body.ref, body.sha]);
      return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
    }
    if (method === "GET" && m[2] === "ref/heads") {
      const sha = tip(origin, `refs/heads/${name}`);
      return sha ? { status: 200, body: { object: { sha } } } : { status: 404, body: { message: "Not Found" } };
    }
    if (method === "DELETE" && m[2] === "refs/heads") {
      if (!tip(origin, `refs/heads/${name}`)) return { status: 422, body: { message: "Reference does not exist" } };
      git(origin, ["update-ref", "-d", `refs/heads/${name}`]);
      return { status: 204, body: {} };
    }
    if (method === "GET" && m[2] === "commits") {
      return { status: 200, body: { sha: name, tree: { sha: git(origin, ["rev-parse", `${name}^{tree}`]) }, parents: git(origin, ["rev-list", "--parents", "-n", "1", name]).split(" ").slice(1).map((p) => ({ sha: p })) } };
    }
    return undefined;
  };
}
