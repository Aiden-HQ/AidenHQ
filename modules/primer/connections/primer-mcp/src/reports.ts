// Which Primer document holds each private report (publish.ts `repo_key`): the one document a repo's reports are versions of.
// The file is `reports.json` in primer-mcp's state dir (PRIMER_STATE_DIR, /state): { [repo_key]: documentId }.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Reports { get(key: string): string | undefined; set(key: string, documentId: string): void }

export function fileReports(dir = process.env.PRIMER_STATE_DIR ?? "/state"): Reports {
  const file = join(dir, "reports.json");
  const read = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  return {
    get: (key) => read()[key.toLowerCase()],
    set(key, id) {
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...read(), [key.toLowerCase()]: id }));
      renameSync(`${file}.tmp`, file);
    },
  };
}
