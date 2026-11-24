// The gate's view of its compiled config (`GATE_CONFIG`, written by scripts/compile.ts at the owner's apply). It is re-read
// whenever the file's mtime changes, because a settings-only apply turns the test listener on or off without a restart.
//
// The compile writes gate.json in place, so a read can land mid-write: an empty or half-written file is tolerated for a
// moment (the last good config keeps serving, and the next call reads the finished file), and then it fails closed. A file
// that is missing or unreadable is never a torn write — an apply that removed settings.edge removes gate.json — so the gate
// refuses requests rather than serving a policy nothing on disk backs any more.
import { readFileSync, statSync } from "node:fs";
import type { GateConfig } from "./gate.ts";

export interface ConfigReaderDeps {
  stat?: (file: string) => { mtimeMs: number };
  read?: (file: string, encoding: "utf8") => string;
  now?: () => number;
  /** How long a half-written file may keep the last good config serving. */
  graceMs?: number;
}

export function createConfigReader(file: string, { stat = statSync, read = readFileSync, now = Date.now, graceMs = 2000 }: ConfigReaderDeps = {}): () => GateConfig {
  let cfg: GateConfig | undefined, mtime = -1, tornAt: number | undefined;
  return () => {
    const m = stat(file).mtimeMs; // missing: throw (there is no config to serve from)
    if (m === mtime && cfg) return cfg;
    const text = read(file, "utf8");
    let next: GateConfig;
    try {
      next = JSON.parse(text) as GateConfig;
    } catch (e) {
      // An in-place write caught halfway: serve the last good config only briefly, then fail closed.
      const at = (tornAt ??= now());
      if (cfg && now() - at < graceMs) return cfg;
      cfg = undefined;
      mtime = -1;
      throw e;
    }
    tornAt = undefined;
    cfg = next;
    mtime = m;
    return cfg;
  };
}
