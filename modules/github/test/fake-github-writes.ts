// GitHub's write API over bare repos, as the code host's signed writes use it: createCommitOnBranch (GitHub's own commit, bound to
// expectedHeadOid, each file replaced in full, an existing file keeping its mode, a new one 100644), git data (blobs, trees on a
// base_tree, commits with their parents, read back too), git/refs create, read and delete (updateRefs too, bound to each
// beforeOid), and the rules that apply to a branch. `originOf(slug)` is the bare repo GitHub holds for a repo; `refuse(input)` is a
// repository rule's words refusing a commit or a ref update; `signed(slug, branch)` says the branch's rules require signed commits;
// `verified(as)` whether GitHub signs a git-data commit made by `as` (the caller's actor mark: GitHub signs the App's own, never
// the owner's). Any other route answers undefined, for the test's own fake.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function githubWrites(originOf, { refuse = (_input) => undefined, signed = (_slug, _branch) => false, verified = (as) => as === "app" } = {}) {
  const git = (origin, args, o = {}) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: origin, encoding: "utf8", ...o, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_AUTHOR_NAME: "owner1", GIT_AUTHOR_EMAIL: "owner1@example.com", ...o.env } }).trim();
  const tip = (origin, ref) => { try { return git(origin, ["rev-parse", "--verify", "--quiet", ref]); } catch { return ""; } };
  return (method, path, body, as = undefined) => {
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
      const said = refuse(body.variables.input);
      if (said) return { status: 200, body: { data: { updateRefs: null }, errors: [{ type: "UNPROCESSABLE", message: said }] } };
      for (const u of refUpdates) git(origin, /^0+$/.test(u.afterOid) ? ["update-ref", "-d", u.name] : ["update-ref", u.name, u.afterOid]);
      return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/git\/(refs\/heads|ref\/heads|refs|commits|blobs|trees)(?:\/(.*))?$/.exec(path);
    if (!m) return undefined;
    const origin = originOf(m[1]);
    const name = (m[3] ?? "").split("/").map(decodeURIComponent).join("/");
    if (method === "POST" && m[2] === "blobs") return { status: 201, body: { sha: git(origin, ["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8") }) } };
    // A tree on `base_tree`: each entry an object GitHub holds (`sha`), inline `content`, or a removal (`sha: null`).
    if (method === "POST" && m[2] === "trees") {
      const scratch = mkdtempSync(join(tmpdir(), "fake-gh-tree-"));
      try {
        const env = { GIT_INDEX_FILE: join(scratch, "index") };
        git(origin, ["read-tree", body.base_tree], { env });
        for (const e of body.tree) {
          if (e.sha === null) { git(origin, ["update-index", "-z", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${e.path}\0` }); continue; }
          const sha = e.content !== undefined ? git(origin, ["hash-object", "-w", "--stdin"], { input: Buffer.from(e.content, "utf8") }) : e.sha;
          if (e.type === "blob" && git(origin, ["cat-file", "-t", sha]) !== "blob") return { status: 422, body: { message: `tree.sha ${sha} is not a valid blob` } };
          git(origin, ["update-index", "--add", "--replace", "--cacheinfo", `${e.mode},${sha},${e.path}`], { env });
        }
        return { status: 201, body: { sha: git(origin, ["write-tree"], { env }) } };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    if (method === "POST" && m[2] === "commits") {
      const sha = git(origin, ["commit-tree", body.tree, ...body.parents.flatMap((p) => ["-p", p]), "-m", body.message]);
      const ok = verified(as);
      return { status: 201, body: { sha, tree: { sha: body.tree }, parents: body.parents.map((p) => ({ sha: p })), verification: { verified: ok, reason: ok ? "valid" : "unsigned" } } };
    }
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
