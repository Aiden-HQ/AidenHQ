// The product's own files under modules/: a checkout that tracks one (a test beside the materialised tree, say) keeps it
// across the materialise in materialize.mjs, which replaces the whole directory. A file that is there is never written:
// only one the swap deleted comes back, from the index as it is. Every directory on the way is one this module found or
// made itself, never a symlink the materialised tree could hold, and the file is created (`wx`) rather than opened, so a
// path in that tree can't point the write outside the checkout.
//   node scripts/modules-repo/tracked.mjs <product dir>
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = (product, ...args) => spawnSync("git", ["-C", product, ...args], { encoding: "utf8" });

const stat = (p) => { try { return lstatSync(p); } catch { return undefined; } };

/** The directory `parts` name under `root`, made where missing; undefined when one of them is a symlink or a file. */
function dirsUnder(root, parts) {
  let cur = root;
  for (const part of parts) {
    const next = join(cur, part);
    const st = stat(next);
    if (st && !st.isDirectory()) return undefined; // lstat sees the link itself: never write through it
    if (!st) { try { mkdirSync(next); } catch { return undefined; } }
    cur = next;
  }
  return cur;
}

/** Put back the product-tracked files under modules/ that are missing (none, and a no-op, where it tracks none). */
export function restoreTracked(product) {
  if (git(product, "rev-parse", "--is-inside-work-tree").status !== 0) return;
  const root = realpathSync(product);
  for (const f of git(product, "ls-files", "-z", "--", "modules").stdout.split("\0").filter(Boolean)) {
    const parts = f.split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) continue; // a path the index can't point out of the checkout
    const dir = dirsUnder(root, parts.slice(0, -1));
    if (!dir) continue;
    let fd;
    try { fd = openSync(join(dir, parts.at(-1)), "wx"); } catch { continue; } // there already (a link included), or unreadable
    try { writeSync(fd, git(product, "show", `:${f}`).stdout); } finally { closeSync(fd); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) restoreTracked(resolve(process.argv[2] ?? "."));
