// The release train (owner, 2026-11-18), moved from the runner (services/runner/src/release.mjs, deleted at the big switch):
// the instance's `product:` pin moved to the product repo's green main by code, batched, and carded like any other write
// (one apply card). The official modules are the product's modules/, so the product pin carries them.
// The train has at most one bump in flight (its card filed) and one open (collecting merges, its task listing them), so two
// bumps never race. A bump files only at a tip CI passed on. A source tip already tried (applied, rejected or reverted) is
// never tried again: only a newer merge starts the next bump. The service does the reads and writes; this file decides. No
// dependencies.

const SHA = /^[0-9a-f]{40}$/;

/**
 * One poll of one target, from what the service read: `tip` (the source's main) and `green` (its CI passed there), `pinned`
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
 * instance.yaml with its `product:` pin moved, every other byte kept. Throws when that line isn't there in the plain form (a
 * `release:` instance, say).
 */
export function bumpInstance(text, { product }) {
  if (!SHA.test(product)) throw new Error("a pin is a full commit sha");
  const lines = String(text).split("\n");
  const hits = lines.flatMap((l, i) => (/^product:[ \t]*["']?[0-9a-f]{40}["']?[ \t]*(#.*)?$/.test(l) ? [i] : []));
  if (hits.length !== 1) throw new Error(`instance.yaml has ${hits.length} \`product: <sha>\` lines, not one`);
  lines[hits[0]] = lines[hits[0]].replace(/[0-9a-f]{40}/, product);
  return lines.join("\n");
}

/** The task's description: what the bump carries, one commit per line (full shas, so a waiter finds it by its merge commit). */
export function trainDescription({ what, carries, windowMinutes, marker }) {
  const list = carries.length ? carries.map((c) => `- ${c.repo} \`${c.sha}\` ${c.subject}`).join("\n") : "- (nothing yet)";
  return [
    `${what} Written by the code host's release train, batched over ${windowMinutes} minutes from the first merge it carries, then filed as one card for the AI reviewer. No agent works on this task; it closes when the bump is live (the apply succeeded).`,
    "",
    "Carries these merged commits:",
    list,
    "",
    "Waiting on one of them? Block on this task: it finishes when they are live, or with a \"Not landed\" note and its reason when they aren't; then search for the next bump that lists your commit.",
    "",
    `<!-- source:${marker} -->`,
  ].join("\n");
}
