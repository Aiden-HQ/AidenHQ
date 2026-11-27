// A directory's content hash: every file, by its path under the root and its bytes, in a stable order. Computed from the
// files themselves, so it also covers a change no manifest version names (the kernel's Paperclip plugin's post.js).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** sha256 over each file's path (relative to `dir`) and content, hex. */
export function dirHash(dir: string) {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${p.slice(dir.length)}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}
