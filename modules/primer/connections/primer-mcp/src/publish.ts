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

export type Publish = { title?: string; content: string; format: "markdown" | "html"; description?: string; documentId?: string; versionNote?: string; baseVersionNumber?: number; path?: string; own?: true; private?: true; by?: Owner };
type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A publish's args from either request shape, with only the fields Primer takes; throws on one that can't be published. */
export function normalise(a: any, fromRunner = false): Publish {
  const args: Publish = { content: str(a?.content) ?? "", format: a?.format === "html" ? "html" : "markdown" };
  for (const k of ["title", "description", "documentId", "versionNote", "path"] as const) if (str(a?.[k])) args[k] = str(a[k])!.trim();
  // The version the agent read: Primer merges people's edits since then (three-way) and refuses a stale one.
  if (args.documentId && Number.isInteger(a?.baseVersionNumber) && a.baseVersionNumber > 0) args.baseVersionNumber = a.baseVersionNumber;
  if (fromRunner && args.documentId && a?.own === true) args.own = true;
  // Only ever narrows who can read a new document, so any requester may ask for it.
  if (!args.documentId && a?.private === true) args.private = true;
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

/** This module's own filing (the report route, report.ts): its module token is the only way to be this requester. */
const isOwnFiling = (r: { kind?: string; module?: string }) => r.kind === "module" && r.module === "primer";

/** `makePrivate` narrows a document just created to the requester (Primer's PATCH /api/documents/:id visibility). */
export function publisher(call: Call, owners: Owners = fileOwners(), makePrivate: (documentId: string) => Promise<void> = async () => {}): Executor {
  return {
    async plan(req) {
      const args = normalise(req.args, req.requester?.kind === "job");
      const by = byOf(req.requester ?? {}, req.task);
      if (by) args.by = by;
      const owner = args.documentId ? owners.get(args.documentId) : undefined;
      if ((owner && by && owner.agent === by.agent && owner.task === by.task) || (args.documentId && isOwnFiling(req.requester ?? {}))) args.own = true;
      const sha = createHash("sha256").update(args.content).digest("hex");
      return {
        args,
        targets: { artifact_sha256: sha, ...(args.documentId ? { document: args.documentId } : {}) },
        facts: { size: args.content.length, short: sha.slice(0, 12) },
        ...(args.documentId && !args.own ? { raise: { tier: 2 as const, rule: "primer-version-not-own", reason: `a new version of document ${args.documentId}, which this agent didn't publish on this task and the owner's own words didn't ask to update` } } : {}),
        card: {
          what: args.documentId ? `a new version of Primer document ${args.documentId}` : `the new document "${args.title}"`,
          changes: args.documentId
            ? `Adds this as the latest version of document ${args.documentId} (its earlier versions stay in its history)${args.baseVersionNumber ? `, merged onto version ${args.baseVersionNumber} so people's edits since are kept` : ""}; everyone who can read it sees it.`
            : args.private ? "Creates a new Primer document that only its requester (the owner) can read." : "Creates a new Primer document that everyone in the organization can read.",
          from: args.path ? `, from the workspace file ${args.path}` : "",
        },
      };
    },
    async execute(rec) {
      const a = normalise(rec.args, true);
      const by: Owner | undefined = rec.args?.by?.agent && rec.args.by.task ? { agent: String(rec.args.by.agent), task: String(rec.args.by.task) } : undefined;
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
      if (a.private) {
        if (!ref.documentId) return { ok: false, text: `Published on Primer: ${ref.url ?? "(no link)"}, but its id wasn't in Primer's answer, so it couldn't be made private: make it private on Primer by hand` };
        try {
          await makePrivate(ref.documentId);
        } catch (e) {
          return { ok: false, text: `Published on Primer (document ${ref.documentId}: ${ref.url ?? "no link"}) but it couldn't be made private (${(e as Error).message.slice(0, 200)}): make it private on Primer before anything else` };
        }
      }
      return { ok: true, text: `Published on Primer: ${ref.url ?? "(no link in Primer's answer)"}${ref.documentId ? ` (document ${ref.documentId})` : ""}` };
    },
  };
}
