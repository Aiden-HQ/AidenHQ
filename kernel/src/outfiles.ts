// An Engineer's output files (screenshots, reports: <workspace>/.aidenhq/out/) are attached to its task when its job ends
// (boxes.ts release). The workspace is the agent's to write, so a host process reads it as untrusted: no link on the way to the
// folder, each file opened without following a link and checked on the open descriptor to be a regular file of at most 10 MB,
// at most 20 files, none twice (a name and size the task already has is skipped; the caller's once-key makes it once per job).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";

export const OUT_DIR = join(".aidenhq", "out");
const MAX_BYTES = 10 * 1024 * 1024; // the control plane's limit for one file
const MAX_FILES = 20;
const TYPES: Record<string, string> = { md: "text/markdown", html: "text/html", txt: "text/plain", csv: "text/csv", json: "application/json", yaml: "text/plain", yml: "text/plain", log: "text/plain", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A file's bytes if it is a regular file of at most MAX_BYTES, opened without following a link; else undefined. */
function readRegular(path: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    for (let r; n < st.size && (r = readSync(fd, buf, n, st.size - n, n)); n += r);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The files to attach: [{ name, type, data }], at most 20, none that `have` lists (name:size). */
export function outFiles(workspace: string, have: Set<string> = new Set()): { name: string; type: string; data: Buffer }[] {
  const fds: number[] = [];
  try {
    let dir = workspace; // the host's own path: opened as given, then each agent-writable component without following a link
    for (const part of ["", ...OUT_DIR.split("/")]) {
      const fd = openSync(part ? join(dir, part) : dir, constants.O_RDONLY | constants.O_DIRECTORY | (part ? constants.O_NOFOLLOW : 0));
      fds.push(fd);
      dir = `/proc/self/fd/${fd}`;
    }
    const out: { name: string; type: string; data: Buffer }[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= MAX_FILES) break;
      if (name.startsWith(".") || /[\u0000-\u001f\u007f<>"`|*?:\\/]/.test(name) || name.length > 200) continue;
      const data = readRegular(join(dir, name));
      if (!data || have.has(`${name}:${data.length}`)) continue;
      out.push({ name, type: TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream", data });
    }
    return out;
  } catch {
    return []; // a link (or a file) where a folder should be, or no folder: nothing is read
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}
