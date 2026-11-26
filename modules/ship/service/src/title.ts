// The `policy` job's Conventional Commit title rule (.github/workflows/ci.yml "Conventional Commit title"), the same pattern
// github's retitle.json and pr.json enforce. Ship reads it to tell a title the check rejects from a title step that failed for
// another reason (its request to GitHub, or the run itself): only the first is cleared by a title edit.
const CONVENTIONAL = /^(feat|fix|docs|chore|test|refactor|perf|ci|build|style|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: \S/;

/** Whether `title` is one the `policy` job accepts. A title ship couldn't read (undefined) is no evidence either way. */
export const conventional = (title: string | undefined) => title !== undefined && CONVENTIONAL.test(title);
