// Finds a running Codex agent's session log and reads what it is doing (parsing: codex-activity.ts).
// Two homes: Paperclip's data dir (mounted read-only; agents it runs itself) and, for agents with their own
// computer, the box (the launcher's /progress route tails the log). Never throws: no log, no activity.
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { activityFromSession, type SessionActivity } from "./codex-activity.js";

export interface SessionSources {
  /** Host `data/paperclip/instances/default/companies`, mounted read-only (never Paperclip's db or secrets). */
  dir?: string;
  launcher?: { url: string; token: string };
}

const TAIL_BYTES = 1_000_000;
const CACHE_MS = 5_000;
const names = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** Rollouts live under .../sessions/YYYY/MM/DD/: only the newest two entries per level, so the walk stays small. */
async function rolloutsUnder(sessions: string): Promise<string[]> {
  let dirs = [sessions];
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const d of dirs) for (const n of (await names(d)).sort().slice(-2)) next.push(join(d, n));
    dirs = next;
  }
  return (await Promise.all(dirs.map(async (d) => (await names(d)).filter((n) => /^rollout-.*\.jsonl$/.test(n)).map((n) => join(d, n))))).flat();
}

/** The newest rollout of this agent touched since the run started, under any company of the mounted instances dir. */
async function newestLocal(root: string, agentId: string, since: number): Promise<string | undefined> {
  const sessionDirs: string[] = [];
  for (const company of await names(root)) {
    const c = join(root, company);
    sessionDirs.push(join(c, "agents", agentId, "codex-home", "sessions"));
    const rt = join(c, "codex-home", "skill-runtimes", agentId);
    for (const hash of await names(rt)) sessionDirs.push(join(rt, hash, "sessions"));
  }
  let best: { file: string; at: number } | undefined;
  for (const f of (await Promise.all(sessionDirs.map(rolloutsUnder))).flat()) {
    const at = (await stat(f).catch(() => null))?.mtimeMs ?? 0;
    if (at >= since && (!best || at > best.at)) best = { file: f, at };
  }
  return best?.file;
}

async function tailLines(file: string): Promise<string[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines; // the first line of a tail is cut
  } finally {
    await fh.close();
  }
}

async function fromLauncher(l: NonNullable<SessionSources["launcher"]>, agentId: string): Promise<string[]> {
  const r = await fetch(`${l.url}/progress`, { method: "POST", headers: { authorization: `Bearer ${l.token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId }), signal: AbortSignal.timeout(4000) });
  const j = (await r.json()) as { lines?: string[] };
  return r.ok && Array.isArray(j.lines) ? j.lines : [];
}

export function liveActivity(src: SessionSources | undefined, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: Promise<SessionActivity | null> }>();
  async function read(agentId: string, since: number): Promise<SessionActivity | null> {
    try {
      let lines: string[] = [];
      const file = src?.dir ? await newestLocal(src.dir, agentId, since - 5_000) : undefined;
      if (file) lines = await tailLines(file);
      else if (src?.launcher) lines = await fromLauncher(src.launcher, agentId);
      return lines.length ? activityFromSession(lines) : null;
    } catch {
      return null;
    }
  }
  /** What a live run of this agent is doing, cached a few seconds per run (the page polls). */
  return (agentId: string, startedAt: string | null): Promise<SessionActivity | null> => {
    if (!src) return Promise.resolve(null);
    const key = `${agentId}|${startedAt}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    for (const [k, v] of cache) if (now() - v.at > 60_000) cache.delete(k);
    const value = read(agentId, startedAt ? Date.parse(startedAt) || 0 : 0);
    cache.set(key, { at: now(), value });
    return value;
  };
}
