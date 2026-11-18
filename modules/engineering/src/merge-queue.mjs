// The merge queue (engineering): which approved PRs wait to merge, in what order and how far apart. How each one lands
// (heads, checks, the base branch, GitHub's writes) is the code host's merge gate (modules/codehost-github/service/src/merge-gate.mjs).

/**
 * Pull requests named in free text, in order: links, org/repo#n, or this server's change requests
 * (codehost:local/<name>/change/<n>; local/<name>#n means the same one). Duplicates dropped.
 */
export function findPrs(text) {
  const out = [];
  const re = /(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+))|(?:codehost:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/change\/(\d+))|(?<![\w./:-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
  for (const m of String(text ?? "").replace(/\\(.)/g, "$1").matchAll(re)) {
    const [org, name, number] = m[1] ? [m[1], m[2], m[3]] : m[4] ? [m[4], m[5], m[6]] : [m[7], m[8], m[9]];
    const repo = `${org}/${name}`;
    const url = org.toLowerCase() === "local" ? `codehost:${repo}/change/${number}` : `https://github.com/${repo}/pull/${number}`;
    if (!out.some((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.number === Number(number))) out.push({ repo, number: Number(number), url });
  }
  return out;
}

/** A new queue for the PRs, merged in the order given. */
export function newQueue(prs, { gapMinutes, now = new Date() }) {
  return { state: "running", gapMinutes, startedAt: now.toISOString(), prs: prs.map((p) => ({ ...p, status: "pending" })) };
}

/**
 * An independent queue with these PRs added (their heads bound). It keeps what an earlier independent queue on the task
 * merged, skipped or reported (so its finish still closes the tasks behind them) and, while running, its pending PRs; a PR
 * asked for again (pending or failed) takes its new head. Undefined when every one was merged already.
 */
export function addEach(existing, prs, { now = new Date() } = {}) {
  const same = (a, b) => a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
  const old = existing?.independent ? existing.prs : [];
  const running = existing?.state === "running";
  const fresh = prs.filter((p) => !old.some((o) => o.status === "merged" && same(o, p)));
  if (!fresh.length) return undefined;
  const kept = old.filter((o) => !fresh.some((p) => same(o, p)) && (o.status !== "pending" || running));
  return { state: "running", independent: true, strict: true, startedAt: (running && existing.startedAt) || now.toISOString(), prs: [...kept, ...fresh.map((p) => ({ ...p, status: "pending" }))] };
}

/** The newest queue for a task, with the user's new PRs: replaces pending ones, keeps what's merged. */
export function startOrResume(existing, prs, { gapMinutes, now = new Date() }) {
  if (!prs.length) {
    if (!existing || !existing.prs.some((p) => p.status === "pending")) return undefined;
    return { ...existing, state: "running", gapMinutes: gapMinutes ?? existing.gapMinutes, reason: undefined, wait: undefined };
  }
  const same = (a, b) => a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
  // Only a merged PR (or one someone else merged: skipped) is done. A failed or escalated one asked for again is merged now.
  const done = (existing?.prs ?? []).filter((p) => p.status === "merged" || p.status === "skipped");
  const fresh = prs.filter((p) => !done.some((d) => same(d, p)));
  if (!fresh.length) return undefined;
  const q = newQueue(fresh, { gapMinutes: gapMinutes ?? existing?.gapMinutes ?? 15, now });
  // A running queue's PRs still waiting were approved too (WOR-4611: a second merge card on the task dropped #141 from the
  // first): they keep their place, ahead of the ones the new card adds. A stopped queue's leftovers are the agent's to name
  // again. An independent queue's waiting PRs are requested again by the caller (requestAutoMerge), so they aren't carried.
  const carried = existing?.state === "running" && !existing.independent ? existing.prs.filter((p) => p.status === "pending") : [];
  // One named again takes its new head where it already stood: a card that re-names a waiting PR (a replay) must not push
  // it behind PRs it was ahead of, or the merge it asked for waits on all of them.
  const waiting = carried.map((p) => ({ ...(fresh.find((f) => same(f, p)) ?? p), status: "pending" }));
  const added = fresh.filter((f) => !carried.some((p) => same(p, f))).map((p) => ({ ...p, status: "pending" }));
  q.prs = [...done, ...waiting, ...added];
  // Carried-over PRs keep the gating they were approved under: a strict queue's leftovers never merge on a laxer one.
  if (carried.length && existing.strict) q.strict = true;
  return q;
}
