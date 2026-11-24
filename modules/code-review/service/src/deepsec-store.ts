// deepsec's records per repo, kept on this service's own storage (/data), never in the repo: they hold unfixed vulnerability
// write-ups. Every deepsec check (a PR's or a repo review's) is handed the repo's records as an uploaded input and leaves the ones
// it changed (recipe/deepsec.ts leave), which are laid over what is held here: a PR check that ran beside a repo review never
// erases the review's progress. A tree run also names the records of files gone, which are dropped. The box's file is data: only
// a gzipped { records: { path: record }, removed: [path] } whose paths are relative and whose records name their own path is taken.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** The most a check input may be (the kernel's INPUT_MAX): records past it are not handed in, and the run starts afresh. */
export const INPUT_MAX = 64 * 1024 * 1024;
/** The most a records file unpacks to. */
const UNPACKED_MAX = 512 << 20;
/** A record's path as deepsec takes one (recipe/deepsec.ts recordPath). */
const recordPath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 1000 && !/[\\\0]/.test(p) && !p.startsWith("/") && p.split("/").every((x) => x && x !== "." && x !== "..");

/** `held` (what the service holds, or none) with a run's left records laid over it: a new gzipped file. Throws on a file that isn't one. */
export function mergeRecords(held: Buffer | undefined, left: Buffer, tree: boolean): Buffer {
  const j = JSON.parse(gunzipSync(left, { maxOutputLength: UNPACKED_MAX }).toString("utf8"));
  if (!j || typeof j !== "object" || !j.records || typeof j.records !== "object" || Array.isArray(j.records)) throw new Error("deepsec's records aren't { records }");
  const records: Record<string, unknown> = held ? JSON.parse(gunzipSync(held, { maxOutputLength: UNPACKED_MAX }).toString("utf8")).records ?? {} : {};
  for (const [p, r] of Object.entries<Record<string, unknown>>(j.records)) if (recordPath(p) && r && typeof r === "object" && r.filePath === p) records[p] = r;
  if (tree && Array.isArray(j.removed)) for (const p of j.removed) if (recordPath(p)) delete records[p];
  return gzipSync(JSON.stringify({ records }));
}

/** The records per repo under `dir` (one gzipped file each). */
export function deepsecStore(dir: string) {
  const file = (repo: string) => join(dir, `${repo.toLowerCase().replace(/\//g, "__")}.json.gz`);
  return {
    read(repo: string): Buffer | undefined { try { return readFileSync(file(repo)); } catch { return undefined; } },
    write(repo: string, data: Buffer) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file(repo)}.tmp`, data);
      renameSync(`${file(repo)}.tmp`, file(repo));
    },
  };
}
export type DeepsecStore = ReturnType<typeof deepsecStore>;
