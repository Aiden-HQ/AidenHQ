// Quality per approval tier: how often an agent change that landed was later reverted or tied to an incident, by who approved
// it (ran at once, the AI reviewer alone, the reviewer panel, the owner). Pure: records and GitHub text in, a report out, so the
// board's fleet summary, the report CLI (scripts/quality.ts) and the kernel's flow DORA (flow.ts) share it.
// A revert or incident is linked to its original only by a PR number or a commit sha it names: exactly one agent change named
// links it; several, a bare number that names no repository, or no reference at all is `unknown`, never a guess.

export const TIERS = ["ran", "reviewer", "panel", "owner"] as const;
export type Tier = (typeof TIERS)[number];
/** An approval record, as little as this needs (the kernel's row or the board's approval, mapped). `at`: when it ran. */
export type Row = { id: string; kind: string; args: unknown; tier: number; panel: boolean; by: string | null; state: string; at: string; outcome?: string | null; identifier?: string | null };
/** A revert PR or an incident as text: `repo` and `number` are its own (a bare #n in it names this repo; its own number is skipped). */
export type Text = { id: string; title: string; body?: string; url?: string; repo?: string; number?: number };
export type Change = { id: string; tier: Tier; at: string; keys: string[]; link: string; label: string };

// A code host's kinds (github.merge, codehost-local.pr) are bare actions too, as kernel review-loop.ts actionOf reads them.
const action = (kind: string) => kind.replace(/^(runner|kernel|github|codehost-local)\./, "");
const repoKey = (s: string) => s.toLowerCase().replace(/\.git$/, "");

/** Who approved it: the reviewer (alone or with the panel's second), the owner, or nobody (it ran at once); undefined when no one did. */
export function tierOf(r: Pick<Row, "tier" | "panel" | "by">): Tier | undefined {
  const by = r.by ?? "";
  if (by.startsWith("reviewer:")) return r.panel || by.includes("+") ? "panel" : "reviewer";
  if (r.tier === 0 || by.startsWith("kernel")) return "ran";
  return by && !by.startsWith("stale:") ? "owner" : undefined;
}

// A GitHub PR's URL, or a change request's on this server (codehost:<org>/<name>/change/<n>): both key as <repo>#<n>.
const PR_URL = /(?:github\.com\/([\w.-]+\/[\w.-]+)\/pull|codehost:([\w.-]+\/[\w.-]+)\/change)\/(\d+)/gi;
/** Where a PR key links to: GitHub's page, or nowhere for this server's change requests (no web page; the board shows them). */
const prLink = (pr: string) => (pr.startsWith("record:") || pr.startsWith("local/") ? "" : `https://github.com/${pr.replace("#", "/pull/")}`);
const SHA = /\b[0-9a-f]{7,40}\b/g;

/** Agent changes that landed (merge, a PR that merges, an apply), one per PR or apply commit however many records carried it. */
export function changesFrom(rows: Row[]): Change[] {
  const out = new Map<string, Change>();
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const a = action(r.kind);
    const args = (r.args ?? {}) as { prs?: { repo: string; number?: number; url?: string }[]; only?: { repo: string; sha?: string }[]; repo?: string; sha?: string; merge?: boolean };
    const tier = tierOf(r);
    if (r.state !== "done" || !tier || !(a === "merge" || (a === "pr" && args.merge === true) || a === "apply")) continue;
    const prs = [...(args.prs ?? []).map((p) => (p.number ? `${repoKey(p.repo)}#${p.number}` : "")), ...[...String(r.outcome ?? "").matchAll(PR_URL)].map((m) => `${repoKey((m[1] ?? m[2])!)}#${m[3]}`)].filter(Boolean);
    const shas = [args.sha, ...(args.only ?? []).map((b) => b.sha), ...(args.prs ?? []).map((p) => (p as { head?: string }).head)].filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase());
    for (const pr of prs.length ? [...new Set(prs)] : [`record:${r.id}`]) {
      const prev = out.get(pr);
      out.set(pr, { id: pr, tier, at: r.at, keys: [...new Set([...(prev?.keys ?? []), ...(pr.startsWith("record:") ? [] : [pr]), ...shas])], link: prLink(pr), label: r.identifier ?? pr });
    }
  }
  return [...out.values()];
}

/** The PRs and commits a text names; `loose`: it names a bare number outside any repository, or nothing at all. */
function refs(t: Text) {
  const text = `${t.title}\n${t.body ?? ""}\n${t.url ?? ""}`;
  const prs = new Set([...text.matchAll(PR_URL)].map((m) => `${repoKey((m[1] ?? m[2])!)}#${m[3]}`));
  for (const m of text.matchAll(/([\w.-]+\/[\w.-]+)#(\d+)/g)) prs.add(`${repoKey(m[1]!)}#${m[2]}`);
  let bare = false;
  for (const m of text.replace(PR_URL, " ").replace(/[\w.-]+\/[\w.-]+#\d+/g, " ").matchAll(/(?:^|[^\w&])#(\d+)\b/g)) {
    if (t.repo) prs.add(`${repoKey(t.repo)}#${m[1]}`);
    else bare = true;
  }
  if (t.repo && t.number) prs.delete(`${repoKey(t.repo)}#${t.number}`);
  const shas = [...text.toLowerCase().matchAll(SHA)].map((m) => m[0]).filter((s) => /\d/.test(s));
  return { prs: [...prs], shas, loose: bare || (!prs.size && !shas.length) };
}

/** The one change a text names, or why not: `unknown` (ambiguous or no usable reference) or `none` (names no agent change). */
export function link(t: Text, changes: Change[]): { change: Change } | "unknown" | "none" {
  const r = refs(t);
  const hit = changes.filter((c) => r.prs.some((p) => c.keys.includes(p)) || r.shas.some((s) => c.keys.some((k) => /^[0-9a-f]{7,40}$/.test(k) && k.startsWith(s))));
  if (hit.length === 1 && !r.loose) return { change: hit[0]! };
  return hit.length > 1 || r.loose ? "unknown" : "none";
}

/** A revert is titled Revert… (a revert of a revert puts the original back and is not one). */
export const isRevert = (t: Text) => /^revert\b/i.test(t.title.trim()) && !/^revert\s+"?revert\b/i.test(t.title.trim());

/** The PRs the fleet opened itself (their title and body are in the record): a revert among them is found without GitHub. */
export const revertsFrom = (rows: Row[]): Text[] => rows
  .filter((r) => r.state === "done" && action(r.kind) === "pr")
  .map((r) => { const a = (r.args ?? {}) as { text?: { title?: string; body?: string }; only?: { repo: string }[] }; return { id: r.id, title: a.text?.title ?? "", body: a.text?.body, repo: a.only?.[0]?.repo }; })
  .filter((t) => t.title);

/** Failed or rolled-back app deploys as incident text: the deployed commit and what the executor said. */
export const deployIncidents = (rows: Row[]): Text[] => rows
  .filter((r) => /(^|\.)deploy(_app)?$/.test(r.kind) && (r.state === "failed" || /rolled back/i.test(r.outcome ?? "")))
  .map((r) => ({ id: r.id, title: `deploy ${(r.args as { name?: string } | null)?.name ?? ""} failed`, body: `${(r.args as { sha?: string } | null)?.sha ?? ""} ${r.outcome ?? ""}` }));

export type Count = { changes: number; reverted: number; incidents: number };
export type Report = {
  windows: { days: number; tiers: Record<Tier, Count> }[];
  /** The reverted changes of the longest window, with the revert that names them. */
  reverted: { change: string; tier: Tier; link: string; revert: string }[];
  /** Reverts that could not be tied to one change (ambiguous or no reference), by their ids. */
  unknown: string[];
};

export function report(rows: Row[], { reverts = [], incidents = [] }: { reverts?: Text[]; incidents?: Text[] }, now = Date.now(), days = [7, 30]): Report {
  const changes = changesFrom(rows);
  const reverted = new Map<string, Text>();
  const unknown: string[] = [];
  for (const t of [...reverts, ...revertsFrom(rows)].filter(isRevert)) {
    const l = link(t, changes);
    if (l === "unknown") unknown.push(t.url ?? t.id);
    else if (l !== "none" && !reverted.has(l.change.id)) reverted.set(l.change.id, t);
  }
  const hit = new Set<string>();
  for (const t of [...incidents, ...deployIncidents(rows)]) {
    const l = link(t, changes);
    if (l !== "unknown" && l !== "none") hit.add(l.change.id);
  }
  const windows = days.map((d) => {
    const tiers = Object.fromEntries(TIERS.map((t) => [t, { changes: 0, reverted: 0, incidents: 0 }])) as Record<Tier, Count>;
    for (const c of changes.filter((c) => Date.parse(c.at) >= now - d * 864e5)) {
      tiers[c.tier].changes++;
      if (reverted.has(c.id)) tiers[c.tier].reverted++;
      if (hit.has(c.id)) tiers[c.tier].incidents++;
    }
    return { days: d, tiers };
  });
  const horizon = now - Math.max(...days) * 864e5;
  return {
    windows,
    reverted: changes.filter((c) => reverted.has(c.id) && Date.parse(c.at) >= horizon).map((c) => ({ change: c.label, tier: c.tier, link: c.link, revert: reverted.get(c.id)!.url ?? reverted.get(c.id)!.id })),
    unknown: [...new Set(unknown)],
  };
}

const pct = (c: Count) => (c.changes ? `${Math.round((100 * c.reverted) / c.changes)}%` : "-");
/** The table: per tier and window, changes, reverted (count and %), incidents; then the reverted ones and the unknown. */
export function render(r: Report): string {
  const lines = ["tier       " + r.windows.map((w) => `${`${w.days}d`.padEnd(24)}`).join(""), "           " + r.windows.map(() => "changes  reverted  incid.  ").join("")];
  for (const t of TIERS) lines.push(t.padEnd(11) + r.windows.map((w) => `${String(w.tiers[t].changes).padEnd(9)}${`${w.tiers[t].reverted} (${pct(w.tiers[t])})`.padEnd(10)}${String(w.tiers[t].incidents).padEnd(8)}`).join(""));
  if (r.reverted.length) lines.push("", "Reverted:", ...r.reverted.map((x) => `  ${x.change} [${x.tier}] ${x.link}  <- ${x.revert}`));
  if (r.unknown.length) lines.push("", `Unknown (a revert that names no single agent change): ${r.unknown.join(", ")}`);
  return lines.join("\n");
}

/** One line for the owner's weekly digest: the revert rate by approver over the first window. */
export function oneLine(r: Report): string {
  const w = r.windows[0]!;
  const parts = TIERS.filter((t) => w.tiers[t].changes).map((t) => `${t} ${w.tiers[t].reverted}/${w.tiers[t].changes} (${pct(w.tiers[t])})`);
  return `Reverted by approver, ${w.days}d: ${parts.join(", ") || "no agent changes landed"}${r.unknown.length ? `; ${r.unknown.length} revert(s) not tied to one change` : ""}`;
}
