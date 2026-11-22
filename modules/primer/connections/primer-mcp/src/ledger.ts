// What a private report's publication has already done, by its key (publish.ts: the repo and the report's own version note, which
// names its batch): { [key]: text }. A report is a document of its own, so a write filed again (its first answer lost, a restart)
// must find the document it made, never make another. The file is `published.json` in primer-mcp's state dir (PRIMER_STATE_DIR, /state).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Ledger { get(key: string): string | undefined; set(key: string, value: string): void }

export function fileLedger(dir = process.env.PRIMER_STATE_DIR ?? "/state"): Ledger {
  const file = join(dir, "published.json");
  const read = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  return {
    get: (key) => read()[key],
    set(key, value) {
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...read(), [key]: value }));
      renameSync(`${file}.tmp`, file);
    },
  };
}
