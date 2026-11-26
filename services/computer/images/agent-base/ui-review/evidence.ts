// A run's evidence between the box and the design module's store, file to tool, never through the model: `ui-review put` sends
// files with design_evidence_put (at most 8 MB per call, a recording in a call of its own) and `ui-review get` saves a run's
// files from design_image, in parts of PART bytes (a pass restores the previous pass's coverage queue; the kernel's proxy answers
// at most 1 MB of text). Both call the design connection as the job, through
// the box's one MCP client (tools-client.ts: the kernel's proxy decides each call by the job's grants).
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { call } from "./tools-client.ts";

/** design_evidence_put's limit per call, and the names the store takes. */
export const PUT_MAX = 8 * 1024 * 1024;
export const NAME = /^[\w-][\w.-]{0,119}\.(png|jpg|webp|json|md|diff|webm)$/;
/** Room for the call's envelope (run id, names, the JSON-RPC and MCP wrappers) beside the base64. */
const ENVELOPE = 4096;

type File = { name: string; data: string };
/** A put's JSON as it goes over the wire, measured against the 8 MB limit before it is sent. */
export const putBytes = (run: string, files: File[]) => Buffer.byteLength(JSON.stringify({ run, files })) + ENVELOPE;

/**
 * The calls a put makes: `<path>[=<name>]` arguments grouped so each call's request stays within 8 MB, a .webm alone. A file
 * that can't fit one call on its own is refused before anything is sent.
 */
export function batches(run: string, args: string[]): File[][] {
  const out: File[][] = [];
  let cur: File[] = [];
  for (const a of args) {
    const at = a.lastIndexOf("="), path = at > 0 ? a.slice(0, at) : a, name = at > 0 ? a.slice(at + 1) : basename(a);
    if (!NAME.test(name)) throw new Error(`${name}: names are letters, digits, . _ -, ending .png .jpg .webp .json .md .diff or .webm`);
    if (statSync(path).size > PUT_MAX) throw new Error(`${path} is over 8 MB`);
    const f = { name, data: readFileSync(path).toString("base64") };
    if (putBytes(run, [f]) > PUT_MAX) throw new Error(`${path}: its call would be over 8 MB`);
    if (name.endsWith(".webm")) { out.push([f]); continue; }
    if (cur.length && putBytes(run, [...cur, f]) > PUT_MAX) { out.push(cur); cur = []; }
    cur.push(f);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Bytes per design_image call: their base64 and the fence stay well under the proxy's 1 MB answer. */
export const PART = 600_000;

/** A design tool's answer: the JSON inside the proxy's untrusted-data fence. */
export function unfence(text: string): unknown {
  const open = text.indexOf("<untrusted-data"), start = open < 0 ? 0 : text.indexOf(">", open) + 1, end = text.lastIndexOf("</untrusted-data>");
  return JSON.parse(text.slice(start, end < 0 ? undefined : end).trim());
}

/** `ui-review put --run <id> <file>[=<name>]...` and `ui-review get --run <id> --out <dir> <name>...` */
export async function putCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { run: { type: "string" } } });
  if (!v.run || !positionals.length) { console.error("usage: ui-review put --run <id> <file>[=<name>]..."); return 2; }
  try {
    let n = 0;
    for (const files of batches(v.run, positionals)) { await call("design", "design_evidence_put", { run: v.run, files }, { timeoutS: 300 }); n += files.length; }
    console.log(`${n} file${n === 1 ? "" : "s"} put on run ${v.run}`);
    return 0;
  } catch (e) { console.error(`ui-review put: ${(e as Error).message}`); return 1; }
}

export async function getCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { run: { type: "string" }, out: { type: "string" } } });
  if (!v.run || !v.out || !positionals.length || positionals.some((n) => !NAME.test(n))) { console.error("usage: ui-review get --run <id> --out <dir> <name>..."); return 2; }
  mkdirSync(v.out, { recursive: true });
  let failed = 0;
  for (const name of positionals) {
    try {
      const parts: Buffer[] = [];
      for (let offset = 0, size = Infinity; offset < size; offset += PART) {
        const got = unfence((await call("design", "design_image", { run: v.run, name, offset, length: PART }, { timeoutS: 120 })).text) as { data?: unknown; size?: unknown };
        if (typeof got.data !== "string" || typeof got.size !== "number") throw new Error("no data in the answer");
        size = got.size;
        parts.push(Buffer.from(got.data, "base64"));
      }
      writeFileSync(join(v.out, name), Buffer.concat(parts));
      console.log(`${join(v.out, name)}`);
    } catch (e) { failed++; console.error(`ui-review get ${name}: ${(e as Error).message.split("\n")[0]}`); }
  }
  return failed ? 1 : 0;
}
