// Task search's document (docs/design/task-search.md): the one text a task is found by, keyword and meaning alike. Built
// from what the kernel reads of a task (its issue and comments as the owner, its PRs, changed paths and last job's final);
// the optional summary and tags join it. No model here: this is code.
import { createHash } from "node:crypto";

export type DocInput = {
  identifier: string;
  title: string;
  labels: string[];
  project: string | null;
  agent: string | null;
  description: string;
  /** Oldest first; the newest are kept when cut. */
  comments: string[];
  prs: { repo: string; number: number; title: string }[];
  paths: string[];
  final: string;
};

const DESCRIPTION = 4000, COMMENTS = 4000, FINAL = 2000, PATHS = 60;
/** What the embedding model is sent: the document cut to this many characters. */
export const EMBED_CHARS = 8000;

/** `s` cut to `n` characters (whole code points). */
const head = (s: string, n: number) => (s.length <= n ? s : [...s].slice(0, n).join(""));
const tail = (s: string, n: number) => (s.length <= n ? s : [...s].slice(-n).join(""));

/**
 * Keyword-only terms (never embedded): each path's segments and basenames without the extension, since Postgres' parser keeps
 * `kernel/src/jobs.ts` as one token (a search for `jobs.ts`, `jobs` or `kernel` would otherwise miss it), and the identifier's
 * bare number (`WOR-10795` is the tokens `wor` and `-10795`, so a search for `10795` would miss it).
 */
export function keywordTerms(d: Pick<DocInput, "identifier" | "paths">): string {
  const out = new Set<string>();
  for (const p of d.paths.slice(0, PATHS)) {
    for (const seg of p.split("/").filter(Boolean)) {
      out.add(seg);
      const dot = seg.lastIndexOf(".");
      if (dot > 0) out.add(seg.slice(0, dot));
    }
  }
  const n = /-(\d+)$/.exec(d.identifier)?.[1];
  if (n) out.add(n);
  return [...out].join(" ");
}

/** The first line, weighted highest in keyword ranking, so a task outranks the tasks that cite it. */
export const headLine = (d: Pick<DocInput, "identifier" | "title">) => `${d.identifier} ${d.title}`;

/**
 * The task's fields in document order, each with the marker the embedded text shows before it. The outcome comes before the
 * comments, so the embedding cut never drops how the task ended.
 */
function fields(d: DocInput, extra?: { summary: string; tags: string[] } | null): [marker: string, text: string][] {
  const out: [string, string][] = [];
  const put = (marker: string, text: string) => { if (text.trim()) out.push([marker, text]); };
  put("labels", d.labels.join(", "));
  put("project", d.project ?? "");
  put("agent", d.agent ?? "");
  for (const pr of d.prs) put("PR", `${pr.repo}#${pr.number} ${pr.title}${pr.repo.startsWith("local/") ? "" : ` https://github.com/${pr.repo}/pull/${pr.number}`}`);
  put("files", d.paths.slice(0, PATHS).join(" "));
  put("summary", extra?.summary ?? "");
  put("tags", (extra?.tags ?? []).join(", "));
  put("", head(d.description.trim(), DESCRIPTION));
  put("outcome", head(d.final.trim(), FINAL));
  put("comments", tail(d.comments.map((c) => c.trim()).filter(Boolean).join("\n---\n"), COMMENTS));
  return out;
}

/** The task's document: the head line, then each field after its marker. Its first EMBED_CHARS are what is embedded. */
export const buildDoc = (d: DocInput, extra?: { summary: string; tags: string[] } | null) =>
  [headLine(d), ...fields(d, extra).map(([m, t]) => (m ? `${m}: ${t}` : t))].join("\n");

/** What keyword search reads beside the head line: the same fields without their markers (which every row would match). */
export const keywordText = (d: DocInput, extra?: { summary: string; tags: string[] } | null) => fields(d, extra).map(([, t]) => t).join("\n");

/** What a summary is made from: the task's content (no card fields), so a status change never asks the model again. */
export const contentHash = (d: DocInput) => createHash("sha256").update(buildDoc(d)).digest("hex");

/** The embedding's identity: the text sent and the model; equal means the stored vector is still right. */
export const embedHash = (doc: string, model: string) => createHash("sha256").update(`${model}\n${head(doc, EMBED_CHARS)}`).digest("hex");

export const embedText = (doc: string) => head(doc, EMBED_CHARS);
