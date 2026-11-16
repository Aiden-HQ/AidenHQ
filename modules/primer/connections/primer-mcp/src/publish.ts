// primer.publish (module.yaml writes.publish), the executor side: the kernel files every Primer publish as a record (an
// agent's primer_create_document or primer_add_version call, or an Engineer's document the runner files after its run) and
// calls execute only once the AI reviewer (and, at Tier 2, the owner) approved it. The args carry the whole document, so the
// digest covers it: what is published is exactly what was reviewed. `path` is only a label for the card.
// A new version overwrites what readers see on an existing document, so it is the owner's (Tier 2) unless the runner vouches
// that the task's own publish made that document or the owner's own comment asked for that link to be updated (`own`, taken
// only from a job token, which only the runner mints); an agent's word for it never counts.
import { createHash } from "node:crypto";
import type { Executor } from "./aidenhq-sdk/executor.js";

export type Publish = { title?: string; content: string; format: "markdown" | "html"; description?: string; documentId?: string; versionNote?: string; path?: string; own?: true };
type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A publish's args from either request shape, with only the fields Primer takes; throws on one that can't be published. */
export function normalise(a: any, fromRunner = false): Publish {
  const args: Publish = { content: str(a?.content) ?? "", format: a?.format === "html" ? "html" : "markdown" };
  for (const k of ["title", "description", "documentId", "versionNote", "path"] as const) if (str(a?.[k])) args[k] = str(a[k])!.trim();
  if (fromRunner && args.documentId && a?.own === true) args.own = true;
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

export function publisher(call: Call): Executor {
  return {
    async plan(req) {
      const args = normalise(req.args, req.requester?.kind === "job");
      const sha = createHash("sha256").update(args.content).digest("hex");
      return {
        args,
        targets: { artifact_sha256: sha, ...(args.documentId ? { document: args.documentId } : {}) },
        facts: { size: args.content.length, short: sha.slice(0, 12) },
        ...(args.documentId && !args.own ? { raise: { tier: 2 as const, rule: "primer-version-not-own", reason: `a new version of document ${args.documentId}, which this task didn't publish and the owner's own words didn't ask to update` } } : {}),
        card: {
          what: args.documentId ? `a new version of Primer document ${args.documentId}` : `the new document "${args.title}"`,
          changes: args.documentId
            ? `Adds this as the latest version of document ${args.documentId} (its earlier versions stay in its history); everyone who can read it sees it.`
            : "Creates a new Primer document that everyone in the organization can read.",
          from: args.path ? `, from the workspace file ${args.path}` : "",
        },
      };
    },
    async execute(rec) {
      const a = normalise(rec.args, true);
      if (a.documentId) {
        const r = await call("primer_add_version", { documentId: a.documentId, content: a.content, format: a.format, ...(a.versionNote ? { versionNote: a.versionNote } : {}) });
        return r.isError ? { ok: false, text: r.text.slice(0, 2000) } : { ok: true, text: `New version on Primer (document ${a.documentId}).` };
      }
      const r = await call("primer_create_document", { title: a.title, content: a.content, format: a.format, ...(a.description ? { description: a.description } : {}) });
      if (r.isError) return { ok: false, text: r.text.slice(0, 2000) };
      let ref = documentRef(r.text);
      if (!ref.documentId && ref.url) ref = { ...ref, ...documentRef((await call("primer_resolve_url", { url: ref.url })).text) };
      return { ok: true, text: `Published on Primer: ${ref.url ?? "(no link in Primer's answer)"}${ref.documentId ? ` (document ${ref.documentId})` : ""}` };
    },
  };
}
