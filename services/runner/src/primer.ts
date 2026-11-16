// An Engineer task's document for Primer. The agent writes the document to a file in the workspace, Markdown or a
// self-contained HTML page; after a finished run the runner files it as a primer.publish record (main.mjs publishToPrimer): a
// new document the first time, then a new version of that same document whenever the file changed. The AI reviewer checks
// each against the request and the primer module publishes it once approved. The agent never gets a publishing tool.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readOwn } from "./files.ts";

export const PRIMER_FILE = join(".aidenhq", "primer.md");
/** A designed page instead (colours, sections, filtering): Primer serves HTML with its scripts, sandboxed. */
export const PRIMER_HTML = join(".aidenhq", "primer.html");
/** Both, for the agent and the check on writes. */
export const PRIMER_FILES = `${PRIMER_FILE} (or ${PRIMER_HTML})`;

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * The document's title, content and format; undefined when there's none. With both files, the one
 * written last is the document. A Markdown title is its first `# ` heading; an HTML one its <title> or <h1>.
 */
export function readDocument(workspace: string, fallbackTitle?: string) {
  // Read safely (readOwn: no link, a regular file, checked on the open descriptor): the workspace is the agent's, and a link
  // could publish a host file.
  const found = [PRIMER_FILE, PRIMER_HTML]
    .map((rel) => ({ rel, path: join(workspace, rel), text: readOwn(workspace, rel)?.toString("utf8").trim() }))
    .filter((d) => d.text)
    .sort((a, b) => lstatSync(b.path).mtimeMs - lstatSync(a.path).mtimeMs);
  if (!found.length) return undefined;
  const { path } = found[0]!;
  const content = found[0]!.text!;
  const format = path.endsWith(".html") ? "html" : "markdown";
  const heading =
    format === "html"
      ? decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(content) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content))?.[1]?.replace(/<[^>]*>/g, "") ?? "").replace(/\s+/g, " ").trim() || undefined
      : /^#\s+(.+?)\s*#*\s*$/m.exec(content)?.[1];
  const title = (heading ?? fallbackTitle ?? "Report").replace(/[*_`]/g, "").trim().slice(0, 200);
  return { path, title, content, format, hash: createHash("sha256").update(content).digest("hex") };
}

/** The link and ID in primer.publish's outcome ("Published on Primer: <link> (document <id>)", modules/primer publish.ts). */
export function publishedRef(text: unknown): { url?: string; documentId?: string } {
  const url = /https:\/\/[^\s"')]+\/d\/[A-Za-z0-9-]{8,64}/.exec(String(text ?? ""))?.[0];
  const documentId = /\(document ([A-Za-z0-9-]{8,64})\)/.exec(String(text ?? ""))?.[1] ?? (url ? /\/d\/([A-Za-z0-9-]+)$/.exec(url)?.[1] : undefined);
  return { ...(url ? { url } : {}), ...(documentId ? { documentId } : {}) };
}

/** A Primer document the user linked: its link and ID, or undefined for anything else. */
export function primerLink(text: unknown) {
  let url: URL;
  try {
    url = new URL(String(text).trim());
  } catch {
    return undefined;
  }
  const id = /^\/d\/([A-Za-z0-9-]{8,64})\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== "https:" || !id) return undefined;
  return { url: `${url.origin}/d/${id}`, documentId: id };
}
