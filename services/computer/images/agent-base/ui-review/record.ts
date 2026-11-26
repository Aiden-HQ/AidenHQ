// Recordings of the clicking pass's flows (an app's `recording: true`): every page of the run's Chrome is screencast over CDP
// (Page.startScreencast) and its frames fed, at a steady FPS, to ffmpeg as VP8 webm at 256 kbps. A clip is one flow: it starts
// at a page's first frame and ends when the clicking agent marks the next flow (`ui-review browser flow "<title>"`, a file the
// recorder watches), at a top-level document load, at 2 minutes or at the 4 MB file cap, whichever comes first: every clip fits
// one design_evidence_put on its own. Each clip also carries the layout shifts and long animation frames of its flow (Motion's
// `shifts` and `longFrames`). recordings.json lists the clips; a second browser recording into the same folder (a thorough
// pass's second clicking pass) adds its own, under names of its own.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, initScript } from "./browser.ts";
import { putBytes, PUT_MAX } from "./evidence.ts";
import { type Mode, pageOf } from "./guard.ts";
import { runStep } from "./repro.ts";
import type { Motion, Step } from "./types.ts";

export const CLIP_SECONDS = 120;
/** The file cap: ffmpeg's -fs stops a little past its limit, so the limit sits under 4 MB. */
export const CLIP_BYTES = 4_000_000;
const FS_LIMIT = 3_800_000;
const FPS = 5;
/** At most this many clips per browser: a long clicking pass keeps its first flows. */
const MAX_CLIPS = 12;
const MIN_SECONDS = 1;
const SIZE = { w: 1280, h: 800 };

export type Recording = { file: string; page: string; flow?: string; seconds: number; bytes: number; motion: Pick<Motion, "shifts" | "longFrames"> };

/** What a flow's document reports: its layout shifts and long animation frames since the last read (read once a second). */
const FLOW_MOTION = `(() => { if (window.__uiReviewFlow) return; const f = (window.__uiReviewFlow = { shifts: [], longFrames: [] });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) f.shifts.push(Math.round(e.value * 10000) / 10000); }).observe({ type: "layout-shift" }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) f.longFrames.push(Math.round(e.duration)); }).observe({ type: "long-animation-frame" }); } catch {}
})();`;
const DRAIN = `(() => { const f = window.__uiReviewFlow; if (!f) return { shifts: [], longFrames: [] }; const out = { shifts: f.shifts.splice(0), longFrames: f.longFrames.splice(0) }; return out; })()`;

type Msg = { id?: number; method?: string; params?: Record<string, any>; sessionId?: string; result?: any; error?: { message: string } };

class Clip {
  ff: ChildProcess; frames = 0; ended: Promise<void>; dead = false; motion = { shifts: [] as number[], longFrames: [] as number[] };
  readonly file: string; readonly page: string; readonly flow?: string;
  constructor(file: string, page: string, flow?: string) {
    this.file = file; this.page = page; this.flow = flow;
    this.ff = spawn("ffmpeg", ["-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-vf", `scale=${SIZE.w}:${SIZE.h}:force_original_aspect_ratio=decrease,pad=${SIZE.w}:${SIZE.h}:(ow-iw)/2:(oh-ih)/2`,
      "-c:v", "libvpx", "-b:v", "256k", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0",
      "-t", String(CLIP_SECONDS), "-fs", String(FS_LIMIT), "-an", "-y", file], { stdio: ["pipe", "ignore", "inherit"] });
    this.ff.stdin!.on("error", () => { this.dead = true; }); // ffmpeg stopped at -t or -fs: the clip is done
    this.ended = new Promise((ok) => this.ff.once("close", () => { this.dead = true; ok(); }));
  }
  /** One tick's frame; false once the clip is full (time or size). */
  write(jpeg: Buffer): boolean {
    if (this.dead || this.frames >= CLIP_SECONDS * FPS) return false;
    this.frames++;
    this.ff.stdin!.write(jpeg);
    return true;
  }
  async close(): Promise<void> { if (!this.ff.stdin!.destroyed) this.ff.stdin!.end(); await this.ended; }
}

/**
 * Records every page of the Chrome at `cdp` into `dir` until stop(), which ends the open clips (waiting for ffmpeg) and adds them
 * to <dir>/recordings.json. A clip under a second, or one whose design_evidence_put request would pass 8 MB, is dropped. `marks`:
 * the file whose every change starts a new flow (its text is the flow's title).
 */
export async function recordPages(cdp: string, dir: string, o: { marks?: string } = {}): Promise<{ stop: () => Promise<Recording[]> }> {
  mkdirSync(dir, { recursive: true });
  const ws = new WebSocket(cdp);
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error("the recorder could not reach Chrome's CDP")); });
  let next = 0;
  const waiting = new Map<number, (m: Msg) => void>();
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<Msg>((ok) => {
    const id = ++next; waiting.set(id, ok);
    try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch { waiting.delete(id); ok({ error: { message: "closed" } }); }
  });
  type Tab = { session: string; target: string; url: string; frame?: Buffer; clip?: Clip; full: boolean };
  const tabs = new Map<string, Tab>(), done: Recording[] = [], closing: Promise<void>[] = [];
  // Clip names of their own: a second recorder into the same folder never replaces the first one's.
  // A mark left by an earlier browser of the same folder is not this one's flow.
  let n = 0, flow: string | undefined, markAt = 0;
  try { if (o.marks) markAt = statSync(o.marks).mtimeMs; } catch { /* none yet */ }
  // The acknowledgement `browser flow` waits for: the mark time the recorder has applied.
  const ack = (at: number) => { if (o.marks) try { writeFileSync(`${o.marks}.ack`, String(at)); } catch { /* the mark still applies */ } };
  ack(markAt);
  const stamp = Date.now().toString(36);
  const finish = (t: Tab) => {
    const c = t.clip;
    if (!c) return;
    t.clip = undefined;
    closing.push(c.close().then(() => {
      const bytes = existsSync(c.file) ? statSync(c.file).size : 0, seconds = c.frames / FPS;
      const fits = bytes > 0 && bytes <= CLIP_BYTES && putBytes("r-xxxxxxxxxxxx-xxxxxxxx", [{ name: "flow-00.webm", data: "A".repeat(Math.ceil(bytes / 3) * 4) }]) <= PUT_MAX;
      if (seconds < MIN_SECONDS || !fits) { rmSync(c.file, { force: true }); return; }
      done.push({ file: c.file.split("/").pop()!, page: c.page, ...(c.flow ? { flow: c.flow } : {}), seconds, bytes, motion: c.motion });
    }));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
    const p = m.params ?? {};
    if (m.method === "Target.targetCreated" && p.targetInfo.type === "page") {
      void send("Target.attachToTarget", { targetId: p.targetInfo.targetId, flatten: true }).then(async (r) => {
        const session = r.result?.sessionId as string | undefined;
        if (!session) return;
        tabs.set(session, { session, target: p.targetInfo.targetId, url: p.targetInfo.url, full: false });
        await send("Page.enable", {}, session);
        await send("Page.addScriptToEvaluateOnNewDocument", { source: FLOW_MOTION }, session);
        await send("Runtime.evaluate", { expression: FLOW_MOTION }, session);
        await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: SIZE.w, maxHeight: SIZE.h, everyNthFrame: 1 }, session);
      });
    } else if (m.method === "Page.screencastFrame" && m.sessionId) {
      void send("Page.screencastFrameAck", { sessionId: p.sessionId }, m.sessionId);
      const t = tabs.get(m.sessionId);
      if (t) t.frame = Buffer.from(p.data, "base64");
    } else if (m.method === "Page.frameNavigated" && m.sessionId && !p.frame.parentId) {
      // A new document: the flow before it ends; the next frame starts the next clip.
      const t = tabs.get(m.sessionId);
      if (t) { finish(t); t.url = p.frame.url + (p.frame.urlFragment ?? ""); t.frame = undefined; t.full = false; }
    } else if (m.method === "Page.navigatedWithinDocument" && m.sessionId) {
      const t = tabs.get(m.sessionId); if (t && p.frameId === t.target) t.url = p.url; // a client-side route: the next clip's page (an open clip keeps its own)
    } else if (m.method === "Target.detachedFromTarget") {
      const t = tabs.get(p.sessionId); if (t) { finish(t); tabs.delete(p.sessionId); }
    }
  };
  // Reports every page, the ones already open included (targetCreated for each).
  await send("Target.setDiscoverTargets", { discover: true });
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    // A new flow marked: every open clip ends, and each page's next frame starts the flow's clip.
    if (o.marks) {
      let at = 0;
      try { at = statSync(o.marks).mtimeMs; } catch { /* not marked yet */ }
      if (at > markAt) {
        markAt = at;
        try { flow = readFileSync(o.marks, "utf8").replace(/\s+/g, " ").trim().slice(0, 200) || undefined; } catch { flow = undefined; }
        for (const t of tabs.values()) { finish(t); t.full = false; }
        ack(at);
      }
    }
    for (const t of tabs.values()) {
      if (!t.frame || t.full) continue;
      if (!t.clip) {
        if (n >= MAX_CLIPS || /^(about|chrome|data):/.test(t.url)) continue;
        t.clip = new Clip(join(dir, `flow-${stamp}-${String(++n).padStart(2, "0")}.webm`), pageOf(t.url), flow);
      }
      if (!t.clip.write(t.frame) || (existsSync(t.clip.file) && statSync(t.clip.file).size >= FS_LIMIT)) { t.full = true; finish(t); continue; }
      if (ticks % FPS === 0) {
        const c = t.clip;
        void send("Runtime.evaluate", { expression: DRAIN, returnByValue: true }, t.session).then((r) => {
          const v = r.result?.result?.value as { shifts?: number[]; longFrames?: number[] } | undefined;
          if (v) { c.motion.shifts.push(...(v.shifts ?? [])); c.motion.longFrames.push(...(v.longFrames ?? [])); }
        });
      }
    }
  }, 1000 / FPS);
  return {
    stop: async () => {
      clearInterval(timer);
      for (const t of tabs.values()) finish(t);
      await Promise.all(closing);
      try { ws.close(); } catch { /* gone */ }
      if (o.marks) rmSync(`${o.marks}.ack`, { force: true }); // no recorder now: a later `browser flow` waits for none
      done.sort((a, b) => a.file.localeCompare(b.file));
      const list = join(dir, "recordings.json");
      let before: Recording[] = [];
      try { before = JSON.parse(readFileSync(list, "utf8")) as Recording[]; } catch { /* the folder's first recorder */ }
      writeFileSync(list, JSON.stringify([...before, ...done], null, 2));
      return done;
    },
  };
}

/**
 * One flow, recorded: a guarded Chrome (mode as capture reads it, signed in with `session` when given), the page at `url`, the
 * steps run as repro runs them. Returns the flow's clip (undefined when it was too short to keep).
 */
export async function recordFlow(url: string, steps: Step[], o: { out: string; mode?: Mode; width?: number }): Promise<Recording | undefined> {
  const l = await launch({ mode: o.mode ?? "any" });
  try {
    const rec = await recordPages(l.cdp, o.out);
    const width = o.width ?? 1280;
    const ctx = await l.browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(initScript(new Date().toISOString()));
    const page = await ctx.newPage();
    await runStep(page, url, { open: url });
    for (const s of steps) await runStep(page, url, s);
    await new Promise((ok) => setTimeout(ok, 400)); // the last step's result on screen
    const [clip] = await rec.stop();
    await ctx.close().catch(() => {});
    return clip && { ...clip, file: join(o.out, clip.file) };
  } finally { await l.close(); }
}
