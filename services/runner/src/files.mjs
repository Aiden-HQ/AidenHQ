// Files the user attached to a task, copied into the workspace before each run so every engine
// can read them like any other file. A sub-task also gets its parent's: the Researcher splits a task
// into Engineer sub-tasks, and the files that came with the request belong to all of them.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

export const FILES_DIR = join(".aidenhq", "files");
/** Files an Engineer makes for the user and the other agents: attached to its part after each run. */
export const OUT_DIR = join(".aidenhq", "out");
const MAX_SHARED = 10 * 1024 * 1024; // Paperclip's limit for one file
const MAX_SHARED_FILES = 20;
const TYPES = { md: "text/markdown", html: "text/html", txt: "text/plain", csv: "text/csv", json: "application/json", yaml: "text/plain", yml: "text/plain", log: "text/plain", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * Whether `rel` under the workspace has no symlink on the way (the parts that exist). The workspace is the agent's to write
 * (the jail's or a box's), so a link in `.aidenhq/…` could point the runner's reads and writes at any host file.
 */
export function noLink(workspace, rel) {
  let p = workspace;
  for (const part of rel.split(sep).filter(Boolean)) {
    p = join(p, part);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) return true;
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

/** A file name that is safe on disk: no paths, control characters or leading dots. */
export function diskName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>"`|*?:]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 200);
  return clean || "file";
}

/**
 * The files to copy, with their names in the workspace: the task's own, then its parent's, each
 * oldest first. Names stay the same from run to run; a clash gets the file's short id.
 */
export function plan(own, parent = []) {
  const taken = new Map();
  const byAge = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  const out = [];
  for (const [from, list] of [["task", own], ["parent", parent]]) {
    for (const a of [...list].sort(byAge)) {
      let name = diskName(a.originalFilename);
      if (taken.has(name.toLowerCase())) {
        const ext = extname(name);
        name = `${name.slice(0, name.length - ext.length)}-${String(a.id).slice(0, 8)}${ext}`;
      }
      taken.set(name.toLowerCase(), a.id);
      out.push({ id: a.id, name, type: a.contentType, size: a.byteSize, from });
    }
  }
  return out;
}

/**
 * Copy the task's files (and its parent's) into the workspace. Returns what's there, for the prompt.
 * `skip`: the IDs of files the Engineer shared itself (`shareOutputs`), which aren't the user's.
 */
export async function syncFiles(pc, issue, workspace, log = () => {}, skip = new Set()) {
  const list = (id) => pc.attachments(id).catch((err) => (log("couldn't list a task's files", { issue: id, err: String(err.message ?? err).slice(0, 200) }), []));
  const files = plan((await list(issue.id)).filter((a) => !skip.has(a.id)), issue.parentId ? await list(issue.parentId) : []);
  if (!files.length) return [];
  const dir = join(workspace, FILES_DIR);
  if (!noLink(workspace, FILES_DIR)) {
    log("task files skipped: a link in the workspace's .aidenhq", { issue: issue.identifier });
    return [];
  }
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of files) {
    const path = join(dir, f.name);
    try {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st?.isFile() || st.size !== f.size) {
        const data = await pc.attachmentContent(f.id);
        // Never written through a link (the agent's): the folder checked again right before, really where it should be,
        // whatever is at the name removed, and the file created new (O_CREAT|O_EXCL: a link planted since fails).
        if (!noLink(workspace, FILES_DIR) || realpathSync(dir) !== join(realpathSync(workspace), FILES_DIR)) throw new Error("a link in the workspace's .aidenhq");
        rmSync(path, { recursive: true, force: true });
        writeFileSync(path, data, { flag: "wx" });
      }
      out.push({ ...f, path: join(FILES_DIR, f.name) });
    } catch (err) {
      log("couldn't copy a task's file", { issue: issue.identifier, file: f.id, err: String(err.message ?? err).slice(0, 200) });
    }
  }
  return out;
}

/**
 * What the Engineer made for others to read: its Primer document (as `<title>.md`) and the files
 * in `.aidenhq/out/`, which only it could see in the workspace before. Size-limited, no subdirectories.
 */
export function outputs(workspace, primer) {
  const out = [];
  if (primer) {
    const ext = extname(primer.path);
    out.push({ name: `${diskName(primer.title).replace(/\.(md|html?)$/i, "")}${ext}`, path: primer.path, rel: relative(workspace, primer.path) });
  }
  const dir = join(workspace, OUT_DIR);
  if (existsSync(dir) && noLink(workspace, OUT_DIR)) {
    for (const name of readdirSync(dir).sort()) if (!name.startsWith(".")) out.push({ name: diskName(name), path: join(dir, name), rel: join(OUT_DIR, name) });
  }
  // Read here, safely (readOwn): a link, a non-file or anything too big is never shared.
  return out
    .map((f) => ({ ...f, data: readOwn(workspace, f.rel) }))
    .filter((f) => f.data)
    .slice(0, MAX_SHARED_FILES)
    .map(({ rel, ...f }) => ({ ...f, type: TYPES[extname(f.name).slice(1).toLowerCase()] ?? "application/octet-stream" }));
}

/**
 * A workspace file's bytes, read safely (the workspace is the agent's): its folder reached with no link and really where it
 * should be (real path = the workspace's real path + the folder), the file opened without following a link, checked on the
 * open descriptor (a regular file of at most `max` bytes, the same inode as the checked path) and read from it. Undefined for
 * anything else.
 */
export function readOwn(workspace, rel, max = MAX_SHARED) {
  let fd;
  try {
    if (!rel || rel.startsWith("..") || !noLink(workspace, rel)) return undefined;
    const real = realpathSync(workspace);
    if (realpathSync(join(workspace, dirname(rel))) !== join(real, dirname(rel))) return undefined;
    fd = openSync(join(real, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const here = lstatSync(join(real, rel));
    if (here.ino !== st.ino || here.dev !== st.dev) return undefined;
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

/**
 * Attach the Engineer's outputs to its task when they changed since the last run, replacing the earlier
 * version. `shared` is the record of what's attached ({ name: { id, hash } }); resolves with the new one
 * and the names attached now.
 */
export async function shareOutputs(pc, issue, files, shared = {}, log = () => {}) {
  const next = { ...shared };
  const attached = [];
  for (const f of files) {
    const data = f.data; // read by outputs (readOwn)
    if (!data.length || data.length > MAX_SHARED) continue;
    const hash = createHash("sha256").update(data).digest("hex");
    if (shared[f.name]?.hash === hash) continue;
    try {
      const a = await pc.addAttachment(issue.id, f.name, f.type, data);
      if (shared[f.name]?.id) await pc.deleteAttachment(shared[f.name].id).catch((err) => log("couldn't remove an earlier version", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }));
      next[f.name] = { id: a.id, hash };
      attached.push(f.name);
    } catch (err) {
      log("couldn't attach an output", { issue: issue.identifier, file: f.name, err: String(err.message ?? err).slice(0, 200) });
    }
  }
  return { shared: next, attached };
}
