/** One open PR in the rows the Fleet Steward's `pr` check reads; `ready_at` is when a draft was last marked ready, where the warehouse saw it. */
export type OpenPr = { repo: string; number: number; opened_at: string; draft: boolean; ready_at?: string | null; preview_url?: string };

/**
 * The open PRs the fleet opened: this server's own change requests, and the GitHub ones the kernel's records name (any repo). The two
 * are read independently: a failed GitHub read still returns the local rows, marked `github_error` so the detector keeps its open
 * GitHub incidents open instead of reporting them recovered. A PR made by hand has no record and is never listed.
 */
export async function openPrs(local: () => Promise<OpenPr[]>, github: () => Promise<OpenPr[]>, warn: (err: unknown) => void): Promise<{ prs: OpenPr[]; github_error?: true }> {
  const own = await local();
  try {
    return { prs: [...(await github()), ...own] };
  } catch (err) {
    warn(err);
    return { prs: own, github_error: true };
  }
}
