// The official modules repository (owner/name) an instance runs: its `aidenhq` marketplace entry in instance.yaml, else the
// repo this product pins (modules-pin.json). It is part of the product: the runner and setup both name it beside the product
// repo, so the AI reviewer and the grader treat the two as one product (a change to a module is the product's change).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const slug = (s) => /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/*$/.exec(String(s ?? "").trim())?.[1];

/** `instance`: the parsed instance.yaml (or undefined); `root`: the product checkout. Undefined when neither names one. */
export function officialRepo(instance, root) {
  const entry = (Array.isArray(instance?.marketplaces) ? instance.marketplaces : []).find((m) => m?.name === "aidenhq");
  const fromEntry = entry && slug(entry.source?.repo ?? entry.source?.url);
  if (fromEntry) return fromEntry;
  try {
    const pin = join(root, "modules-pin.json");
    return existsSync(pin) ? slug(JSON.parse(readFileSync(pin, "utf8")).repo) : undefined;
  } catch {
    return undefined;
  }
}
