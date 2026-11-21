import { createHash } from "node:crypto";
type CaseFile = { padTo?: number; text: string; [k: string]: unknown };
type Deletion = { path: string; lines: number };
type Case = { diff: string; deletions?: Deletion[]; lockfilePad?: number; files?: CaseFile[]; [k: string]: unknown };
// A planted case stays small on disk (a case file over the diff size cap would make its own PR unreviewable): a changed
// file may give `padTo` instead of its full text, and the text is padded with spaces to exactly that many characters.
// Two files with the same text and `padTo` are byte-identical, as the app starter's two lockfile copies are.
export const padFile = ({ padTo, ...f }: CaseFile) => (padTo === undefined ? f : { ...f, text: (f.text + " ".repeat(padTo)).slice(0, padTo) });
// A diff may hold `@@LOCKFILE_PAD@@` and give `lockfilePad` (a count): that many added default-registry package-lock.json
// entries go there, so a case can carry a lockfile far over the diff cap and still be a small file. Each is a transitive
// dependency of the app's own devDependency (vite), as a real lockfile's bulk is: the reviewer reads every line of it now.
const lockEntry = (i: number) => [`"node_modules/vite/node_modules/vite-dep-${i}": {`, `  "version": "1.${i % 50}.${i % 7}",`, `  "resolved": "https://registry.npmjs.org/vite-dep-${i}/-/vite-dep-${i}-1.${i % 50}.${i % 7}.tgz",`, `  "integrity": "sha512-${createHash("sha512").update(`vite-dep-${i}`).digest("base64")}",`, `  "license": "MIT"`, "},"].map((l) => `+    ${l}`).join("\n");
// A diff may hold `@@DELETIONS@@` and give `deletions` ([{ path, lines }]): each becomes a whole-file deletion of that many
// lines there, so a case can delete thousands of lines (a minimal app trimming the starter's demo) and still be a small file.
const deletedLine = (path: string, i: number) => `-  const row${i} = rows.filter((r) => r.status === "s${i % 4}" && r.team !== "${path.length}"); // ${i}`;
const deletion = ({ path, lines }: Deletion) => [`diff --git a/${path} b/${path}`, "deleted file mode 100644", "index 1a2b3c4..0000000", `--- a/${path}`, "+++ /dev/null", `@@ -1,${lines} +0,0 @@`, ...Array.from({ length: lines }, (_, i) => deletedLine(path, i))].join("\n");
const padDeletions = (c: Case): Case => (c.deletions ? { ...c, diff: c.diff.replace("@@DELETIONS@@", c.deletions.map(deletion).join("\n") + "\n") } : c);
const padDiff = (c0: Case) => {
  const c = padDeletions(c0);
  return c.lockfilePad ? { ...c, diff: c.diff.replace("@@LOCKFILE_PAD@@", Array.from({ length: c.lockfilePad }, (_, i) => lockEntry(i)).join("\n")) } : c;
};
export const padCase = <C extends Case>(c0: C): C => {
  const c = padDiff(c0);
  return (c.files ? { ...c, files: c.files.map(padFile) } : c) as C;
};
