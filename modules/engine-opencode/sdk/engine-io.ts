// An engine's side of engine@1: read job.json, append events, follow inbox.jsonl. Every file is opened without following
// a link and without blocking (the job dir is the job's to write: a FIFO there must not hang the reader), and each event line
// is capped.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, InboxLine, JobSpec } from "./types.ts";

export const LINE_MAX = 256 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A regular file's bytes from `offset`, at most `max`: never through a link. Empty when it doesn't exist yet. */
export function readFrom(path: string, offset = 0, max = 4 << 20): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (e: any) {
    if (e.code === "ENOENT") return Buffer.alloc(0);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    const n = Math.max(0, Math.min(st.size - offset, max));
    const buf = Buffer.alloc(n);
    if (n) readSync(fd, buf, 0, n, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Append one line to a regular file (made 0600 if missing), never through a link. */
export function appendLine(path: string, value: unknown): void {
  let line = JSON.stringify(value);
  if (Buffer.byteLength(line) >= LINE_MAX) {
    const v = value as { text?: unknown };
    line = JSON.stringify({ ...v, text: String(v.text ?? "").slice(0, LINE_MAX / 8), plan: undefined, steps: undefined });
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Whole lines from a byte buffer: the parsed ones and how many bytes they took (a partial last line waits). */
export function lines(buf: Buffer): { values: unknown[]; used: number } {
  const values: unknown[] = [];
  let start = 0;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
    const text = buf.subarray(start, i).toString("utf8");
    start = i + 1;
    if (text.length > LINE_MAX) continue;
    try {
      values.push(JSON.parse(text));
    } catch {}
  }
  return { values, used: start };
}

export function engineIO(jobDir: string, { pollMs = 200 } = {}) {
  const spec = JSON.parse(readFrom(join(jobDir, "job.json")).toString("utf8")) as JobSpec;
  if (spec.contract !== "engine@1") throw new Error(`job.json is ${spec.contract}, not engine@1`);
  const inbox = join(jobDir, "inbox.jsonl");
  return {
    spec,
    emit: (ev: EngineEvent) => appendLine(join(jobDir, "events.jsonl"), ev),
    /** The runner's comments, as they arrive; ends when the caller stops iterating. */
    async *comments(): AsyncGenerator<InboxLine> {
      let offset = 0;
      for (;;) {
        const { values, used } = lines(readFrom(inbox, offset));
        offset += used;
        for (const v of values) if ((v as InboxLine)?.t === "comment" && typeof (v as InboxLine).text === "string") yield v as InboxLine;
        if (!values.length) await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

/**
 * Run the engine's own program: its output goes on to ours (the job log) as it is, each JSON line to `onJson`. `input`: text
 * for its stdin (none: no stdin), or a function given a writer that keeps stdin open (live input) until it calls end(). Resolves with the exit
 * code, or 127 with `error` when the program couldn't start.
 */
export function runProgram(argv: string[], { env, input, onJson }: { env: NodeJS.ProcessEnv; input?: string | ((w: { write(s: string): boolean; end(): void }) => void); onJson: (e: any) => void }): Promise<{ code: number; error?: string }> {
  return new Promise((resolve) => {
    const [cmd = "", ...args] = argv;
    const child: ChildProcess = spawn(cmd, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] });
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      process.stdout.write(d);
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        try {
          onJson(JSON.parse(line));
        } catch {}
      }
    });
    const stdin = child.stdin;
    stdin?.on("error", () => {});
    if (stdin && typeof input === "function") input({ write: (s) => !stdin.writableEnded && (stdin.write(s), true), end: () => stdin.end() });
    else stdin?.end(input);
    child.on("error", (e: any) => resolve({ code: 127, error: `couldn't start ${argv[0]}: ${e.code ?? e.message}` }));
    child.on("close", (code: number | null, signal: string | null) => resolve({ code: code ?? (signal ? 128 + 15 : 1) }));
  });
}
