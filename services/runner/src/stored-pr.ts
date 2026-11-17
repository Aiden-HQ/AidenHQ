// A PR number a task stored is acted on only when GitHub's own read confirms it: the same head branch the task recorded for
// that url. A recreated repository, a deleted branch or a permission change leaves the number pointing at nothing or at
// another change, and the task is told once that it is stale instead of a rebase, merge or card going out on it.

/** Why a stored PR number is stale — GitHub read another head branch, or none — or undefined when it matches the task's. */
export function staleHead(recorded: string | null | undefined, head: string | null | undefined): string | undefined {
  if (!head) return "GitHub couldn't read its head branch";
  if (String(head) === String(recorded ?? "")) return undefined;
  return `its head branch is \`${head}\`, not the task's \`${recorded ?? ""}\``;
}
