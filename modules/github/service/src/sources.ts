// The owner-approved source exceptions a change's review reads (reviewer@1's `sources`): `.github/supply-chain-source-exceptions.yaml`
// at each base the change targets, never at the change itself, so a change can never record its own approval.
import { readExceptions } from "./best-version.ts";

export const SOURCE_EXCEPTIONS_FILE = ".github/supply-chain-source-exceptions.yaml";

/**
 * The owner-approved source records: the same flow style, one per line, the version exceptions use, kept only when one says
 * `approved_by: owner` and names a package and the source it moves to. Anything else is not an approval; an absent file is no
 * records.
 */
export const readSourceExceptions = (text: string) =>
  readExceptions(text).filter((e) => String(e.approved_by ?? "").trim().toLowerCase() === "owner" && e.package && e.to);

/**
 * A change's source records, read from its bases by `read(repo, base)` (the file's text at that base): each keeps its repo and
 * base, so it covers only that repo's own change off that base. A base code couldn't name, or a file it couldn't read, is no
 * records, so no record ever passes a new source unread; `where` names only the bases read. No base at all: undefined.
 */
export async function readCardSourceExceptions(bases: { repo: string; base?: string }[], read: (repo: string, base: string) => Promise<string>) {
  if (!bases.length) return undefined;
  const known = bases.filter((b) => b.base);
  const rows = await Promise.all(known.map((b) => read(b.repo, b.base!).catch(() => "").then((text) => readSourceExceptions(text).map((r) => ({ ...r, repo: b.repo, base: b.base })))));
  return { where: known.map((b) => `${b.repo} ${b.base} ${SOURCE_EXCEPTIONS_FILE}`).join("; "), records: rows.flat() };
}
