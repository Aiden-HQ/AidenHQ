// primer.publish (module.yaml writes.publish), the executor side: the kernel files every Primer publish as a record (an
// agent's primer_create_document or primer_add_version call, or an Engineer's document the runner files after its run) and
// calls execute only once the AI reviewer (and, at Tier 2, the owner) approved it. The args carry the whole document, so the
// digest covers it: what is published is exactly what was reviewed. `path` is only a label for the card.
// A new version overwrites what readers see on an existing document, so it is the owner's (Tier 2) unless this agent, on this
// task, published that document (owners.ts: written when its create succeeded, from the kernel's requester identity) or the
// runner vouches that the owner's own comment asked for that link to be updated (`own`, taken only from a job token, which
// only the runner mints). An agent's word for it never counts. `by` (task, agent) is set here from the requester, never read
// from the request. Revising its own document is Tier 1: the AI reviewer decides.
import { createHash } from "node:crypto";
import type { Executor } from "./aidenhq-sdk/executor.js";
import { fileLedger, type Ledger } from "./ledger.js";
import { fileOwners, type Owner, type Owners } from "./owners.js";

export type Publish = { title?: string; content: string; format: "markdown" | "html"; description?: string; documentId?: string; versionNote?: string; baseVersionNumber?: number; path?: string; own?: true; private?: true; repo_key?: string; by?: Owner };
type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A publish's args from either request shape, with only the fields Primer takes; throws on one that can't be published. */
export function normalise(a: any, fromRunner = false): Publish {
  const args: Publish = { content: str(a?.content) ?? "", format: a?.format === "html" ? "html" : "markdown" };
  for (const k of ["title", "description", "documentId", "versionNote", "path"] as const) if (str(a?.[k])) args[k] = str(a[k])!.trim();
  // The version the agent read: Primer merges people's edits since then (three-way) and refuses a stale one.
  if (args.documentId && Number.isInteger(a?.baseVersionNumber) && a.baseVersionNumber > 0) args.baseVersionNumber = a.baseVersionNumber;
  if (fromRunner && args.documentId && a?.own === true) args.own = true;
  // A private report (a new document each time, only the owner's): code review's, filed by that module (module.yaml filed_by).
  if (a?.private === true) {
    if (!str(a.repo_key)) throw new Error("a private publish names its repo_key");
    if (args.documentId) throw new Error("a private report is always a new document: it names no documentId");
    if (!args.versionNote) throw new Error("a private report names its versionNote: it is the key that keeps a retry from making a second document");
    args.private = true;
    args.repo_key = str(a.repo_key)!.trim().toLowerCase();
  } else if (str(a?.repo_key)) throw new Error("repo_key goes with private");
  if (!args.content) throw new Error("the document is empty: nothing to publish");
  if (!args.documentId && !args.title) throw new Error("a new document needs a title");
  return args;
}

/** A Primer document's ID and link from a create_document result (JSON or text with the link). */
export function documentRef(text: string): { url?: string; documentId?: string } {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  const url = json?.url ?? json?.documentUrl ?? /https?:\/\/[^\s"')]+\/d\/[A-Za-z0-9-]+/.exec(String(text))?.[0];
  const documentId = json?.documentId ?? json?.id ?? (url ? /\/d\/([A-Za-z0-9-]+)/.exec(url)?.[1] : undefined);
  return { url, documentId };
}

/**
 * What primer_add_version answered, for the agent: the version Primer made (number, id, link) and how a live document took
 * the new text (reconciliation: applied, suggested or conflict per changed part). No version when nothing was applied.
 */
export function versionResult(documentId: string, text: string): string {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return `New version on Primer (document ${documentId}). Primer answered: ${text.slice(0, 1500)}`;
  }
  const head = j?.versionNumber ? `New version v${j.versionNumber} on Primer (document ${documentId}, version ${j.versionId ?? "?"})` : `No new version on Primer (document ${documentId}): nothing was applied`;
  return `${head}${j?.url ? `: ${j.url}` : "."}${reconciled(j?.reconciliation, Boolean(j?.versionNumber))}`;
}

/** What became of each changed part, in words (Primer's per-part status: applied, suggested or conflict). Nothing for a shape it doesn't know. */
function reconciled(rec: any, made: boolean): string {
  const parts: any[] = Array.isArray(rec) ? rec : Object.values(rec ?? {}).find(Array.isArray) ?? [];
  const n = (s: string) => parts.filter((p) => p?.status === s);
  const [applied, suggested, conflict] = [n("applied"), n("suggested"), n("conflict")];
  if (!suggested.length && !conflict.length) return "";
  const lines: string[] = [];
  const total = parts.length;
  if (suggested.length) lines.push(`${suggested.length} of the ${total} changed parts ${made ? "became suggestions for a person to decide" : "are now suggestions for a person to decide"} (for example because people edited them since you read the document). Leave them to the person: publishing the same change again adds nothing.`);
  if (conflict.length) {
    const named = conflict.map((c) => (typeof c?.note === "string" ? c.note : typeof c?.text === "string" ? c.text : "")).filter(Boolean).map((t) => `"${t.slice(0, 80)}"`);
    lines.push(`${conflict.length} changed part${conflict.length > 1 ? "s" : ""} conflicted with people's edits and ${conflict.length > 1 ? "were" : "was"} not applied${named.length ? ` (${named.join("; ")})` : ""}: read the live document and change them from its current text.`);
  }
  if (applied.length) lines.push(`${applied.length} changed part${applied.length > 1 ? "s" : ""} went in as written.`);
  return `\n${lines.join(" ")}`;
}

/** The requester's identity as the kernel names it: the agent and its task (a module or an empty one has none). */
const byOf = (r: { agent?: string }, task: string): Owner | undefined => (r.agent && task ? { agent: r.agent, task } : undefined);

/** What publishing a private report needs of Primer beyond its MCP tools: narrowing a new document to the owner. */
export interface Private { makePrivate(documentId: string, title: string): Promise<void>; done: Ledger }
/** A report's document is created with this title, before it is private: it names no repo. Its real title is set once private. */
export const NEUTRAL_TITLE = "Repo review";
const PLACEHOLDER = "This private report is being prepared.";
const locks = new Map<string, Promise<unknown>>();

export function publisher(call: Call, owners: Owners = fileOwners(), priv: Private = { makePrivate: async () => {}, done: fileLedger() }): Executor {
  return {
    async plan(req) {
      const args = normalise(req.args, req.requester?.kind === "job");
      const by = byOf(req.requester ?? {}, req.task);
      if (by) args.by = by;
      const owner = args.documentId ? owners.get(args.documentId) : undefined;
      if (owner && by && owner.agent === by.agent && owner.task === by.task) args.own = true;
      // A module's private report (module.yaml filed_by): its versions are the one report document's, never another's, so they
      // stay at the floor. Only a module identity, which no agent can hold, counts.
      // Only a module files a private report (primer's module.yaml filed_by names which): an agent never repoints a repo's report.
      if (args.private && req.requester?.kind !== "module") throw new Error("a private report is filed by a module only");
      // Another module files here only by primer's filed_by, and only a private report (never an organization-wide document).
      if (req.requester?.kind === "module" && req.requester.module !== "primer" && !args.private) throw new Error("a module files private reports only");
      const report = Boolean(args.private);
      const sha = createHash("sha256").update(args.content).digest("hex");
      return {
        args,
        targets: { artifact_sha256: sha, ...(args.documentId ? { document: args.documentId } : {}), ...(args.repo_key ? { repo_key: args.repo_key } : {}) },
        facts: { size: args.content.length, short: sha.slice(0, 12) },
        ...(args.documentId && !args.own && !report ? { raise: { tier: 2 as const, rule: "primer-version-not-own", reason: `a new version of document ${args.documentId}, which this agent didn't publish on this task and the owner's own words didn't ask to update` } } : {}),
        card: {
          what: args.private ? `the private report "${args.title ?? args.repo_key}" (${args.repo_key})` : args.documentId ? `a new version of Primer document ${args.documentId}` : `the new document "${args.title}"`,
          changes: args.private
            ? "Publishes this report as a new Primer document that only its owner can read."
            : args.documentId
            ? `Adds this as the latest version of document ${args.documentId} (its earlier versions stay in its history)${args.baseVersionNumber ? `, merged onto version ${args.baseVersionNumber} so people's edits since are kept` : ""}; everyone who can read it sees it.`
            : "Creates a new Primer document that everyone in the organization can read.",
          from: args.path ? `, from the workspace file ${args.path}` : "",
        },
      };
    },
    async execute(rec) {
      const a = normalise(rec.args, true);
      const by: Owner | undefined = rec.args?.by?.agent && rec.args.by.task ? { agent: String(rec.args.by.agent), task: String(rec.args.by.task) } : undefined;
      if (!a.private) return write(a, by);
      // A new document per report, once: the report is keyed by its repo and version note (which names its batch), so a write filed
      // again (its answer lost, a restart) finds what the first one did. Created with a placeholder, made private, and only then
      // given the report: it has no collaborators until the owner shares it, so nobody else can read it, not even for a moment.
      const key = `${a.repo_key}|${a.versionNote}`;
      return serial(key, async () => {
        const had = priv.done.get(key);
        if (had) return { ok: true, text: had };
        let id = priv.done.get(`${key}#doc`);
        if (!id) {
          const made = await write({ ...a, content: PLACEHOLDER, description: undefined, title: NEUTRAL_TITLE }, undefined);
          if (!made.ok) return made;
          id = /\(document ([A-Za-z0-9-]+)\)/.exec(made.text)?.[1];
          if (!id) return { ok: false, text: `${made.text}: its id wasn't in Primer's answer, so the report wasn't added` };
          priv.done.set(`${key}#doc`, id);
        }
        try {
          await priv.makePrivate(id, a.title ?? `Repo review: ${a.repo_key}`);
        } catch (e) {
          return { ok: false, text: `document ${id} (a placeholder) couldn't be made private (${(e as Error).message.slice(0, 200)}), so the report wasn't added` };
        }
        const out = applied(await write({ ...a, documentId: id }, undefined));
        if (out.ok) priv.done.set(key, out.text);
        return out;
      });
    },
  };

  /** Publications on one key never overlap, so a duplicate waits for the first and then finds its document. */
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, run);
    void run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
    return run;
  }

  /** A private report is published only when Primer made a version of it: "nothing was applied" is a failure, never a done write. */
  function applied(r: { ok: boolean; text: string }) {
    return r.ok && /^No new version on Primer/.test(r.text) ? { ok: false, text: `${r.text} So the report wasn't published.` } : r;
  }

  async function write(a: Publish, by: Owner | undefined) {
    if (a.documentId) {
      // A call that threw may have landed: read the versions back instead of publishing again.
      const r = await call("primer_add_version", { documentId: a.documentId, content: a.content, format: a.format, ...(a.versionNote ? { versionNote: a.versionNote } : {}), ...(a.baseVersionNumber ? { baseVersionNumber: a.baseVersionNumber } : {}) }).catch(async (e: Error) => {
        const seen = a.versionNote && (await call("primer_list_versions", { documentId: a.documentId! }).catch(() => undefined))?.text.includes(a.versionNote);
        return seen ? { text: "a version with this note is on Primer: read its versions for the number", isError: false } : { text: `outcome unknown (${e.message}): check the document's versions on Primer before publishing again`, isError: true };
      });
      return r.isError ? { ok: false, text: r.text.slice(0, 2000) } : { ok: true, text: versionResult(a.documentId, r.text) };
    }
    const r = await call("primer_create_document", { title: a.title, content: a.content, format: a.format, ...(a.description ? { description: a.description } : {}) })
      .catch((e: Error) => ({ text: `outcome unknown (${e.message}): look for the document on Primer before publishing again`, isError: true }));
    if (r.isError) return { ok: false, text: r.text.slice(0, 2000) };
    let ref = documentRef(r.text);
    if (!ref.documentId && ref.url) ref = { ...ref, ...documentRef((await call("primer_resolve_url", { url: ref.url })).text) };
    if (ref.documentId && by) owners.set(ref.documentId, by);
    return { ok: true, text: `Published on Primer: ${ref.url ?? "(no link in Primer's answer)"}${ref.documentId ? ` (document ${ref.documentId})` : ""}` };
  }
}
