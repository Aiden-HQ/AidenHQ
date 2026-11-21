// POST /internal/report: code review's one-off reports (modules/code-review) become Primer documents. Only the code-review module
// calls it, with its own module token the kernel vouches for (module-caller.ts, as github-mcp's /internal/review does). The report
// is filed as this module's own `primer.publish` record (publish.ts), so the kernel tiers it and the AI reviewer reads the whole
// document first; the document is private to the requester (the owner). One document per repo: the first publication is serialised
// per repo key, so concurrent first runs share it, and every later one is a version of it.
//   body { repo, title, content (markdown, ≤ 80000), documentId?, versionNote } → { documentId, version, url }
//   202 { pending: true, write }: the record is still waiting on its review; repeat the request (the open record is found again).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { KernelCall } from "./kernel.js";
import { isModule } from "./module-caller.js";

/** The role whose quiet task holds the report's approval records (as code review's own posts do). */
const ROLE = "reviewer-manager";
const KIND = "primer.publish";
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** repo → document id: the one document each repo's reports are versions of. */
export interface Reports { get(repo: string): string | undefined; set(repo: string, documentId: string): void }
export function fileReports(dir = process.env.PRIMER_STATE_DIR ?? "/state"): Reports {
  const file = join(dir, "reports.json");
  const read = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  return {
    get: (repo) => read()[repo.toLowerCase()],
    set(repo, id) {
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...read(), [repo.toLowerCase()]: id }));
      renameSync(`${file}.tmp`, file);
    },
  };
}

/** The document, version and link a publish's outcome text names (publish.ts: documentRef, versionResult). */
export function parseOutcome(text: string): { documentId: string; version: number; url: string } | undefined {
  const documentId = /\(document ([A-Za-z0-9-]+)[,)]/.exec(text)?.[1];
  const url = /https?:\/\/[^\s"')]+/.exec(text)?.[0];
  if (!documentId || !url) return undefined;
  return { documentId, version: Number(/New version v(\d+)/.exec(text)?.[1] ?? 1), url: url.replace(/:$/, "") };
}

class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function reportRoute(o: {
  kernelUrl: string; call: KernelCall; reports: Reports; log?: (m: string, f?: Record<string, unknown>) => void;
  isModule?: typeof isModule; pollMs?: number; waitMs?: number;
}) {
  const log = o.log ?? (() => {});
  const who = o.isModule ?? isModule;
  const pollMs = o.pollMs ?? 2000, waitMs = o.waitMs ?? 5 * 60_000;
  const locks = new Map<string, Promise<unknown>>();
  /** Runs fn after every earlier call for the key: first publications on one repo never overlap. */
  const serial = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, run);
    void run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
    return run;
  };

  async function publish(b: { repo: string; title: string; content: string; documentId?: string; versionNote?: string }) {
    const known = o.reports.get(b.repo);
    // A document id other than the repo's own is refused: this route never adds a version to any other document.
    if (b.documentId && b.documentId !== known) throw new Refused(400, `document ${b.documentId} isn't ${b.repo}'s report`);
    // The one-per-repo rule holds even when the caller doesn't know the id yet.
    const documentId = known;
    const task = String((await o.call("POST", "/v1/tasks", {
      title: `Code review report: ${b.repo}`, role: ROLE, source: `code-review-report:${b.repo.toLowerCase()}`, quiet: true,
      description: `${b.repo}\n\nCode review's one-off reports on this repository are approved here; the report is on Primer.`,
    })).id);
    const args = { content: b.content, format: "markdown", private: true, ...(documentId ? { documentId } : { title: b.title }), ...(b.versionNote ? { versionNote: b.versionNote } : {}) };
    let rec = (await o.call("POST", "/v1/writes", { kind: KIND, args, task })) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
    for (const t0 = Date.now(); !["done", "failed", "rejected", "stale", "cancelled", "unknown"].includes(rec.state); ) {
      if (Date.now() - t0 > waitMs) return { status: 202, body: { pending: true, write: rec.id } };
      await new Promise((r) => setTimeout(r, pollMs));
      rec = await o.call("GET", `/v1/writes/${rec.id}`);
    }
    if (rec.state !== "done" || !rec.outcome?.ok) throw new Refused(502, `the report wasn't published: write ${rec.id} ${rec.state}${rec.outcome?.text ? `: ${rec.outcome.text.slice(0, 300)}` : ""}`);
    const out = parseOutcome(rec.outcome.text);
    if (!out) throw new Refused(502, `Primer's answer named no document: ${rec.outcome.text.slice(0, 300)}`);
    if (!documentId) o.reports.set(b.repo, out.documentId);
    log("report published", { repo: b.repo, document: out.documentId, version: out.version });
    return { status: 200, body: out };
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/internal/report") return false;
    const send = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const ok = await who(o.kernelUrl, String(req.headers.authorization ?? ""), "code-review");
    if (!ok) return void send(ok === undefined ? 503 : 401, { error: ok === undefined ? "try again" : "unauthorized" }), true;
    if (req.method !== "POST") return void send(405, { error: "POST only" }), true;
    try {
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += (c as Buffer).length; if (n > 400_000) throw new Refused(413, "too large"); chunks.push(c as Buffer); }
      let b: any;
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Refused(400, "send JSON"); }
      const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v : undefined);
      const repo = text(b?.repo, 201), title = text(b?.title, 200), content = text(b?.content, 80_000), versionNote = b?.versionNote === undefined ? undefined : text(b.versionNote, 500);
      if (!repo || !REPO.test(repo)) throw new Refused(400, "repo is owner/name");
      if (!title || !content) throw new Refused(400, "title (≤ 200) and content (≤ 80000 characters) are required");
      if (b?.versionNote !== undefined && !versionNote) throw new Refused(400, "versionNote is text of at most 500 characters");
      if (b?.documentId !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(String(b.documentId))) throw new Refused(400, "documentId is a Primer document id");
      const r = await serial(repo.toLowerCase(), () => publish({ repo, title, content, ...(b.documentId ? { documentId: String(b.documentId) } : {}), ...(versionNote ? { versionNote } : {}) }));
      send(r.status, r.body);
    } catch (e) {
      const status = e instanceof Refused ? e.status : 502;
      if (!(e instanceof Refused)) log("report failed", { err: (e as Error).message.slice(0, 200) });
      send(status, { error: status === 502 ? "failed" : "refused", detail: (e as Error).message.slice(0, 400) });
    }
    return true;
  };
}
