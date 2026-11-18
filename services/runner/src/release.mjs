// The release train (owner, 2026-11-18): pin bumps written by code, batched, and carded like any other write. Two targets,
// each moved to its source's green tip once the batch window since the first unpinned merge has passed:
// - `modules`: the product's modules-pin.json → the official modules repo's main (a product PR card that merges).
// - `instance`: the instance's `product:` pin → the product repo's main, and its official marketplace → that commit's
//   modules-pin.json (one apply card).
// Each target has at most one bump in flight (its card filed) and one open (collecting merges, its task listing them), so two
// bumps of one target never race. A bump files only at a tip CI passed on. A source tip already tried (applied, rejected or reverted) is never tried again: only a
// newer merge starts the next bump. The runner does the reads and writes (main.mjs runReleases); this file decides.
import YAML from "yaml";

const SHA = /^[0-9a-f]{40}$/;

/** A full commit sha, or undefined: a pin read from a repository's own files goes through this before git or an API path. */
export const asSha = (x) => (typeof x === "string" && SHA.test(x) ? x : undefined);
/** The commit a modules-pin.json text pins, or undefined for anything that isn't a full sha (`--output=…` included). */
export function pinOf(text) {
  try {
    return asSha(JSON.parse(String(text ?? ""))?.sha);
  } catch {
    return undefined;
  }
}

/**
 * One poll of one target, from what the runner read: `tip` (the source's main) and `green` (its CI passed there), `pinned`
 * (what the target pins now), `lastTried` (the tip the last bump carried), `open` ({ since }: the task collecting merges),
 * `flight` ({ to }: a filed bump not over yet), `now` and `windowMinutes`. A merge opens its bump at once (so a waiter finds
 * the task that lists it); the card waits for the window, a green tip and the bump in flight to be over.
 * → { do: "idle" | "open" | "wait" | "file" | "close", why? }.
 */
export function trainStep({ tip, green, pinned, lastTried, open, flight, now, windowMinutes }) {
  if (!SHA.test(tip ?? "")) return { do: open ? "wait" : "idle", why: "the source's main couldn't be read" };
  // A target with no plain pin to move (an instance on a `release:`, say) is not this train's.
  if (!SHA.test(pinned ?? "")) return { do: open ? "wait" : "idle", why: "the target has no pin this train can move" };
  // The tip a bump in flight carries counts as tried: merges after it open the next bump, which files once that one is over.
  const due = tip !== pinned && tip !== (flight?.to ?? lastTried);
  if (!due) return open && !flight ? { do: "close", why: tip === pinned ? "the target already pins it" : "nothing new to carry" } : { do: "idle" };
  if (!open) return { do: "open" };
  if (flight) return { do: "wait", why: `it files once ${flight.identifier ?? "the bump in flight"} is over` };
  if (!green) return { do: "wait", why: "CI hasn't passed on the source's main yet" };
  return Date.parse(now) - Date.parse(open.since) >= windowMinutes * 60_000 ? { do: "file" } : { do: "wait", why: "the batch window is open" };
}

/**
 * instance.yaml with its `product:` pin and its official marketplace's sha moved, every other byte kept. Throws when either
 * line isn't there in the plain form (a `release:` instance, say), or when anything but those two values would change.
 */
export function bumpInstance(text, { product, modules, official = "aidenhq" }) {
  if (!SHA.test(product) || !SHA.test(modules)) throw new Error("a pin is a full commit sha");
  const lines = String(text).split("\n");
  const at = (re, what) => {
    const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (hits.length !== 1) throw new Error(`instance.yaml has ${hits.length} ${what} lines, not one`);
    return hits[0];
  };
  const p = at(/^product:[ \t]*["']?[0-9a-f]{40}["']?[ \t]*(#.*)?$/, "`product: <sha>`");
  lines[p] = lines[p].replace(/[0-9a-f]{40}/, product);
  const m = at(new RegExp(`^\\s*-\\s*\\{.*\\bname:\\s*${official}\\b.*\\bsha:\\s*[0-9a-f]{40}.*\\}\\s*(#.*)?$`), `\`${official}\` marketplace`);
  lines[m] = lines[m].replace(/\bsha:(\s*)[0-9a-f]{40}/, `sha:$1${modules}`);
  const out = lines.join("\n");
  const [before, after] = [YAML.parse(String(text)), YAML.parse(out)];
  const market = (doc) => (doc.marketplaces ?? []).find((x) => x?.name === official);
  if (after.product !== product || market(after)?.sha !== modules) throw new Error("the pins didn't move as written");
  const rest = (doc) => JSON.stringify({ ...doc, product: undefined, marketplaces: (doc.marketplaces ?? []).map((x) => (x?.name === official ? { ...x, sha: undefined } : x)) });
  if (rest(before) !== rest(after)) throw new Error("the edit changed more than the two pins");
  return out;
}

/**
 * The task's description: what the bump carries, one commit per line (full shas, so a waiter finds it by its merge commit),
 * and the module authority its pinned manifests add (`authority`: { modules: { from, to }, lines }, read by code from the
 * manifests at both pins). The reviewer reads this description as the request chain, so the bump says it asks for exactly
 * those changes; with no lines the section is left out and the description reads as it did before.
 */
export function trainDescription({ target, what, carries, authority, windowMinutes, marker }) {
  const list = carries.length ? carries.map((c) => `- ${c.repo} \`${c.sha}\` ${c.subject}`).join("\n") : "- (nothing yet)";
  const lines = authority?.lines ?? [];
  const section = lines.length
    ? [
        `The official modules move from \`${authority.modules.from.slice(0, 12)}\` to \`${authority.modules.to.slice(0, 12)}\`. For the modules it resolves to, that adds the authority below (computed by code from the module manifests at both pins; owner = new authority), and this bump requests exactly these changes:`,
        ...lines.map((l) => `- ${l}`),
        "",
      ]
    : [];
  return [
    `${what} Written by the runner's release train, batched over ${windowMinutes} minutes from the first merge it carries, then filed as one card for the AI reviewer. No agent works on this task; it closes when the bump is live${target === "instance" ? " (the apply succeeded)" : " (its PR merged)"}.`,
    "",
    ...section,
    "Carries these merged commits:",
    list,
    "",
    "Waiting on one of them? Block on this task: it finishes when they are live, or with a \"Not landed\" note and its reason when they aren't; then search for the next bump that lists your commit.",
    "",
    `<!-- source:${marker} -->`,
  ].join("\n");
}
