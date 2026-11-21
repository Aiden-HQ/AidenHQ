// A PR's facts and diff for the grader, read through the kernel's typed code host operation (POST /v1/codehost/read, under
// this module's `codehost: read` grant): the github module holds the sign-in, so no token reaches here.
type Json = any;
type KernelCall = (method: string, path: string, body?: unknown) => Promise<Json>;
type KernelText = (path: string, body: unknown) => Promise<string>;

const SLUG = /^[\w.-]+\/[\w.-]+$/;

export function createGithub({ kernel, text }: { kernel: KernelCall; text: KernelText }) {
  const read = (repo: string, body: Record<string, unknown>) => {
    if (!SLUG.test(repo)) throw new Error(`${repo} is not owner/name`);
    return kernel("POST", "/v1/codehost/read", { repo, ...body });
  };
  return {
    /** The PR in the shape evidence.ts reads ({ repository: { pullRequest } }); a PR GitHub has no answer for throws. */
    pr: (repo: string, number: number): Promise<Json> => read(repo, { kind: "pr", number }),
    /** The issue in the shape evidence.ts reads ({ repository: { issue } }); one GitHub has no answer for throws. */
    issue: (repo: string, number: number): Promise<Json> => read(repo, { kind: "issue", number }),
    diff: (repo: string, number: number): Promise<string> => {
      if (!SLUG.test(repo)) throw new Error(`${repo} is not owner/name`);
      return text("/v1/codehost/read", { repo, kind: "diff", number });
    },
    async file(repo: string, path: string, ref: string): Promise<string | null> {
      if (!/^[\w./-]{1,500}$/.test(path) || path.split("/").some((s) => s === ".." || s === "." || !s)) throw new Error(`${repo} with ${path}@${ref} is not a readable file`);
      if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${repo} with ${path}@${ref} is not a readable file`);
      return text("/v1/codehost/read", { repo, kind: "file", path, ref }).then((t) => (t.trim() ? t : null), (e) => {
        if (/\b404\b/.test(String(e?.message ?? ""))) return null;
        throw e;
      });
    },
    /**
     * Whether `repo` has the directory `path` at the commit `ref`: `kind: dir` behind the evidence grant, so a suite's
     * folder can be proved present at the graded head rather than inferred from a diff that may be cut.
     */
    async dir(repo: string, path: string, ref: string): Promise<{ path: string; present: boolean }> {
      if (!/^[\w./-]{1,500}$/.test(path) || path.split("/").some((s) => s === ".." || s === "." || !s)) throw new Error(`${repo} with ${path}@${ref} is not a readable directory`);
      if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${repo} with ${path}@${ref} is not a readable directory`);
      return read(repo, { kind: "dir", path, ref });
    },
    /**
     * One Actions job by id in `repo`, as the command facts read it: its state and conclusion, its steps, the run that owns
     * it (`run_id`, `run_base`, `event`, `head_sha`) and that run's workflow (`workflow_path`, `workflow_state`); null when
     * the repo has no such job.
     */
    async job(repo: string, id: string | number): Promise<Json> {
      if (!/^\d{1,20}$/.test(String(id))) throw new Error(`${repo} with job ${id} is not a readable Actions job`);
      return read(repo, { kind: "job", id: Number(id) });
    },
  };
}
