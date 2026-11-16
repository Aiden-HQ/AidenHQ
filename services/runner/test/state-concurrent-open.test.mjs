// Two processes opening one fresh state dir: the first holds the write lock before the file is in WAL mode, and the second
// must not fail on `PRAGMA journal_mode = WAL`, which returns "database is locked" at once instead of waiting out
// busy_timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = new URL("../src/state.ts", import.meta.url).href;
const OPEN = `import { State } from ${JSON.stringify(STATE)}; new State(process.argv[1]);`;
const HOLD = `import { DatabaseSync } from "node:sqlite"; import { mkdirSync } from "node:fs"; import { join } from "node:path";
mkdirSync(process.argv[1], { recursive: true });
const db = new DatabaseSync(join(process.argv[1], "state.sqlite"));
db.exec("BEGIN IMMEDIATE");
console.log("held");
setTimeout(() => { db.exec("COMMIT"); }, 200);`;

function child(source, dir) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", source, dir], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => p.on("exit", (code) => resolve({ code, err })));
  const held = new Promise((resolve) => p.stdout.once("data", () => resolve()));
  return { done, held, error: () => err };
}

test("a second opener of a fresh state dir waits out the first one's write lock instead of failing", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "state-open-")), "state");
  const holder = child(HOLD, dir);
  await holder.held;
  const opener = child(OPEN, dir);
  const [a, b] = await Promise.all([holder.done, opener.done]);
  assert.deepEqual([a.code, b.code], [0, 0], `holder: ${a.err}\nopener: ${b.err}`);
});
