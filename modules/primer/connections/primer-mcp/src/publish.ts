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
import { fileOwners, type Owner, type Owners } from "./owners.js";
import { fileReports, type Reports } from "./reports.js";

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
  // A private report (one document per repo_key, only the owner's): code review's, filed by that module (module.yaml filed_by).
  if (a?.private === true) {
    if (!str(a.repo_key)) throw new Error("a private publish names its repo_key");
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
  const rec = j?.reconciliation ? `\nReconciliation: ${JSON.stringify(j.reconciliation).slice(0, 2000)}` : "";
  return `${head}${j?.url ? `: ${j.url}` : "."}${rec}`;
}

/** The requester's identity as the kernel names it: the agent and its task (a module or an empty one has none). */
const byOf = (r: { agent?: string }, task: string): Owner | undefined => (r.agent && task ? { agent: r.agent, task } : undefined);

/** What publishing a private report needs of Primer beyond its MCP tools: narrowing a new document to the owner, and the repo→document map. */
export interface Private { makePrivate(documentId: string, title: string): Promise<void>; reports: Reports }
/** A report's document is created with this title, before it is private: it names no repo. Its real title is set once private. */
export const NEUTRAL_TITLE = "Repo review";

/**
 * Whether a document is private to its owner alone: private, and no collaborator. A read that fails throws (the publish fails
 * and is asked again), so a transient error never passes for "shared" and never starts a second document.
 */
export async function ownerOnly(call: Call, documentId: string): Promise<boolean> {
  const json = async (tool: string) => {
    const r = await call(tool, { documentId });
    if (r.isError && /not.?found|\b404\b|no such document/i.test(r.text)) return null; // gone: a new document takes its place
    if (r.isError) throw new Error(`${tool} failed: ${r.text.slice(0, 200)}`);
    return JSON.parse(r.text);
  };
  const doc = await json("primer_get_document");
  if (doc === null) return false;
  const visibility = doc?.document?.visibility ?? doc?.visibility;
  if (typeof visibility !== "string") throw new Error(`primer_get_document didn't say the visibility of ${documentId}`);
  if (visibility !== "private") return false;
  const who = await json("primer_list_collaborators");
  if (who === null) return false; // deleted between the two reads: gone, a new document takes its place
  const list = Array.isArray(who) ? who : Array.isArray(who?.collaborators) ? who.collaborators : undefined;
  if (!list) throw new Error(`primer_list_collaborators didn't list the collaborators of ${documentId}`);
  return list.length === 0;
}

/** First publications on one repo_key never overlap, so concurrent ones share the one document. */
const locks = new Map<string, Promise<unknown>>();
const serial = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  void run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
  return run;
};

export function publisher(call: Call, owners: Owners = fileOwners(), priv: Private = { makePrivate: async () => {}, reports: fileReports() }): Executor {
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
            ? "Publishes this report on Primer where only its owner can read it: a new version of this repo's earlier report while that is still private to the owner alone, else a new private document."
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
      // A caller's version number belongs to the document it named, which a private report never writes to.
      delete a.baseVersionNumber;
      // A private report: the repo's one document (never a document the caller names), a new version of it while it is still
      // private to the owner alone, else a new private document in its place; first publications on a repo_key are serialised.
      return serial(a.repo_key!.toLowerCase(), async () => {
        const known = priv.reports.get(a.repo_key!);
        if (known !== undefined && (await ownerOnly(call, known))) return applied(await write({ ...a, documentId: known }, undefined));
        // A new document: created with a placeholder, made private, and only then given the report, so the report is never
        // readable by the organization, not even for a moment.
        const made = await write({ ...a, documentId: undefined, content: "This private report is being prepared.", description: undefined, title: NEUTRAL_TITLE }, undefined);
        if (!made.ok) return made;
        const id = /\(document ([A-Za-z0-9-]+)\)/.exec(made.text)?.[1];
        if (!id) return { ok: false, text: `${made.text}: its id wasn't in Primer's answer, so the report wasn't added` };
        try {
          await priv.makePrivate(id, a.title ?? `Repo review: ${a.repo_key}`);
        } catch (e) {
          return { ok: false, text: `${made.text} (a placeholder), but it couldn't be made private (${(e as Error).message.slice(0, 200)}), so the report wasn't added` };
        }
        priv.reports.set(a.repo_key!, id);
        const out = applied(await write({ ...a, documentId: id }, undefined));
        return out.ok && known ? { ...out, text: `${out.text} (the earlier report ${known} is shared wider or gone, so this is a new private document)` } : out;
      });
    },
  };

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
