// A PR's facts and diff for the grader, read through the kernel's typed code host operation (POST /v1/codehost/read, under
// this module's `codehost: read` grant): the github module runs the queries as the owner's sign-in, and no token reaches here.
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
    /** One Actions job by id in `repo`, as a report cites it: state, conclusion and name; null when the repo has no such job. */
    async job(repo: string, id: string | number): Promise<Json> {
      if (!/^\d{1,20}$/.test(String(id))) throw new Error(`${repo} with job ${id} is not a readable Actions job`);
      return read(repo, { kind: "job", id: Number(id) });
    },
    /** A workflow run's identity (path, event, head, attempt); null when the repo has no such run. */
    async run(repo: string, id: string | number): Promise<Json> {
      if (!/^\d{1,20}$/.test(String(id))) throw new Error(`${repo} with run ${id} is not a readable workflow run`);
      return read(repo, { kind: "run", id: Number(id) });
    },
    /** A listed file at an exact commit (`evidence`): its text; a file GitHub has no answer for throws. */
    file(repo: string, path: string, ref: string): Promise<string> {
      if (!SLUG.test(repo)) throw new Error(`${repo} is not owner/name`);
      return text("/v1/codehost/read", { repo, kind: "file", path, ref });
    },
  };
}
