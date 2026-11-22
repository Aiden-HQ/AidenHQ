// A shared module's two pure pieces (docs/design/sharing.md): the digest the owner's preview binds his save to (the kernel's
// export, kernel/src/module-share.ts, and this code host's plan compute it the same way), and the destination's
// marketplace.json with the module listed from its own folder.
import { createHash } from "node:crypto";

/** The preview's digest: sha256 of the source commit and every file (path order), canonical JSON. */
export const digestOf = (source: string, files: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify({ source, files: Object.keys(files).sort().map((p) => [p, files[p]]) })).digest("hex");

/**
 * marketplace.json with `module` listed from `./<module>` (the folder the publish writes): added when absent, kept as it is
 * when already there. Undefined text: a new marketplace.json. Throws when the file isn't a marketplace or lists the module
 * from another source (someone else's entry is never overwritten).
 */
export function upsertMarketplace(text: string | undefined, module: string): string {
  const doc = text === undefined ? { plugins: [] } : JSON.parse(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.plugins)) throw new Error("marketplace.json has no plugins list");
  const own = `./${module}`;
  const entry = doc.plugins.find((p: { name?: unknown }) => p?.name === module);
  if (entry && String(entry.source).replace(/\/+$/, "") !== own) throw new Error(`marketplace.json lists ${module} from another source`);
  if (entry) return text!;
  doc.plugins.push({ name: module, source: own });
  return `${JSON.stringify(doc, null, 2)}\n`;
}
