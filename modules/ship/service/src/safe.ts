// Approval (spec §5, risk tiers §7): the PR's risk tier from code review's verdict, whether code review's pass carries to a later head,
// and the one judgement of whether the App may approve an adopted PR's head. Facts only, from code: no model reads anything here.
// The round reads the PR's own change (GitHub's compare from its merge base) only where a pass stands on an earlier head, and passes
// riskOf()'s answer (the tier's approve and merge) and judge()'s to round().
import { posix } from "node:path";
import { LOCKFILES } from "./discover.ts";
import { TIERS, type ShipSettings, type Tier } from "./settings.ts";

/** One file of the PR's own change: GitHub's compare (merge base...head) `files` entry. */
export interface ChangedFile { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }
/** Code review's GET /v1/verdict at the head: `tier` says whether the head is classified (and its tier, rule and why), pending or
 * unwatched; `policy` is how it is reviewed; `kind` and `reviewed` say what a pass stands on (`none`: its tier needs no review). */
export interface Verdict {
  verdict: "pass" | "wait"; reasons: { code: string; text: string }[]; reviewed?: string | null; kind?: "completed" | "exhausted" | "skipped" | "none";
  requires_review?: boolean; policy?: string; tier?: { state: "classified"; tier: Tier; rule: number; why: string } | { state: "pending" | "unwatched" };
}
/** The head's risk tier with what the repo's `by_tier` says about it: the App's approval and ship's merge. `pending`: not classified
 * yet, so nothing is approved, queued or merged; `unwatched`: code review doesn't watch the repo (no tier; `unwatched.merge`). */
export type Risk = { state: "classified" | "pending" | "unwatched"; tier?: Tier; rule?: number; why: string; policy?: string; requiresReview: boolean; approve: ShipSettings["by_tier"][Tier]["approve"]; merge: ShipSettings["by_tier"][Tier]["merge"] };
export type Judged = { ok: boolean; why: string; ask?: boolean; risk: Risk };

/** GitHub's compare lists at most 300 files: past that the change can't be read whole. */
const COMPARE_CAP = 300;
const hit = (path: string, globs: string[]) => globs.some((g) => posix.matchesGlob(path, g));
const isGenerated = (f: ChangedFile, generated: string[]) => LOCKFILES.includes(posix.basename(f.filename)) || hit(f.filename, generated);

/** The verdict's tier and the repo's settings for it. A tier this build doesn't know is pending (never guessed). */
export function riskOf(s: ShipSettings, v: Verdict): Risk {
  const t = v.tier;
  if (t?.state === "classified" && TIERS.includes(t.tier)) {
    const cell = s.by_tier[t.tier];
    return { state: "classified", tier: t.tier, rule: t.rule, why: t.why, ...(v.policy ? { policy: v.policy } : {}), requiresReview: v.requires_review !== false, approve: cell.approve, merge: cell.merge };
  }
  if (t?.state === "unwatched") return { state: "unwatched", why: "code review doesn't watch this repo", requiresReview: false, approve: "off", merge: s.unwatched.merge };
  return { state: "pending", why: "code review hasn't classified this head's risk tier yet", requiresReview: true, approve: "off", merge: "off" };
}

/** The PR's own change without its generated paths: each file's status, names and patch, hunk positions included (code review's
 * patch-id rule: the same edit at another place is another change). null when a file has no patch (binary, too large) or the
 * list is cut. */
function fingerprint(files: ChangedFile[], generated: string[]): string | null {
  if (files.length >= COMPARE_CAP) return null;
  // A rename out of a source path stays (only a move between generated paths is dropped).
  const own = files.filter((f) => !isGenerated(f, generated) || (f.previous_filename !== undefined && !isGenerated({ ...f, filename: f.previous_filename }, generated)));
  if (own.some((f) => typeof f.patch !== "string")) return null;
  return own.map((f) => `${f.status}\0${f.previous_filename ?? ""}\0${f.filename}\0${f.patch}`).sort().join("\0\0");
}

/** Whether code review's pass on an earlier head carries to this one: the PR's own change is the same at both (a base merge, or
 * only generated paths regenerated). Anything unreadable is a change. */
export function carries(reviewed: ChangedFile[], head: ChangedFile[], generated: string[]): boolean {
  const a = fingerprint(reviewed, generated);
  return a !== null && a === fingerprint(head, generated);
}

/**
 * Whether the App may approve the head, with why (the report's line). By the head's tier: `off` never, a head without a tier (pending,
 * or an unwatched repo) never, and a tier that needs no review (`kind: none`) never. Else it needs code review's pass on this head
 * under its current policy: completed there, or an earlier head's (`reviewed`) whose change this head keeps (carries). A pass on an
 * earlier head with a different change asks for a fresh review (`ask`). `observe` reports what `on` would do.
 * `reviewedFiles`: the PR's own change at the verdict's `reviewed` head, read only when the verdict isn't completed at this head.
 */
export function judge(s: ShipSettings, e: { files: ChangedFile[]; generated: string[]; verdict: Verdict; reviewedFiles?: ChangedFile[] }): Judged {
  const v = e.verdict;
  const risk = riskOf(s, v);
  const no = (why: string, ask?: boolean): Judged => ({ ok: false, why, risk, ...(ask ? { ask } : {}) });
  if (risk.state === "pending") return no(risk.why);
  if (risk.state === "unwatched") return no(`${risk.why}, so there is no review to approve on`);
  if (risk.approve === "off") return no(`tier \`${risk.tier}\`: approval is off`);
  if (v.kind === "none" || !risk.requiresReview) return no(`tier \`${risk.tier}\` needs no review: there is none to approve on`);
  if (v.verdict !== "pass") return no(`code review: ${String(v.reasons[0]?.text ?? "not passed").slice(0, 200)}`);
  if (v.kind === "skipped") return no("code review skipped its head");
  const carried = v.kind !== "completed";
  if (carried && !(v.reviewed && e.reviewedFiles && carries(e.reviewedFiles, e.files, e.generated))) {
    return no(`its change since code review's last full review${v.reviewed ? ` (\`${v.reviewed.slice(0, 12)}\`)` : ""} has no review of its own yet`, true);
  }
  return { ok: true, why: carried ? `code review passed at \`${v.reviewed!.slice(0, 12)}\`, and its own change is the same here` : "code review passed on its head", risk };
}

/** decide's ShipContext.approve: the tier's `approve` is `on`, and the evidence holds. */
export const canApprove = (j: Judged | undefined) => j?.ok === true && j.risk.approve === "on";

/** The App's approval ship filed (the adoption's `approve`): at which head, under which policy, and whether a person's is awaited. */
export type Approved = { head: string; why?: string; policy?: string };
/** An App approval that no longer stands for this head: issued on another commit (the head moved since: GitHub may keep it as
 * approving, but it never saw this change), under another policy than the head's current one, or where the tier's `approve` is no
 * longer `on` (risk tiers §7). A person's stays whatever the tier says; an approval ship never made is none. It is dismissed, never
 * counted, and the approve round judges the head again: where code review's pass carries to it (the PR's own change is the same),
 * the App approves the new head without a fresh review. */
export const staleApproval = (ap: Approved | undefined, head: string, r: Risk) => !!ap && !ap.why && (ap.head !== head || r.approve !== "on" || ap.policy !== r.policy);

/**
 * The final check before the App approves, or ship merges or queues (github asks right before the write): the verdict read now, with
 * the live base and author. Why not, or undefined; `retry`: only for now (a head not classified yet, a verdict that can't be read),
 * so the write is tried again rather than ended. An approval also needs the verdict's policy to be the one it was filed under and
 * code review's pass to cover this head itself (a pass standing on an earlier head asks for its own judgement in the round).
 */
export function effectRefusal(s: ShipSettings, v: Verdict, what: "approve" | "merge", app: Approved | undefined, head: string, policy?: string): { why: string; retry: boolean } | undefined {
  const r = riskOf(s, v);
  const no = (why: string, retry = false) => ({ why, retry });
  if (r.state === "pending") return no(`${r.why}: try again once it is`, true);
  if (what === "merge" && staleApproval(app, head, r)) return no("an App approval made on another commit or under another policy stands on this PR: ship dismisses it first");
  if (what === "merge") return r.merge === "ready" ? undefined : no(r.state === "unwatched" ? "the repo's unwatched merge setting is off" : `tier \`${r.tier}\`: merge is off`);
  if (r.state === "unwatched") return no("code review doesn't watch this repo: nothing to approve on");
  if (r.approve !== "on") return no(`tier \`${r.tier}\`: approval is ${r.approve}`);
  if (policy !== undefined && v.policy !== policy) return no("the head's review policy changed since the approval was filed", true);
  // `exhausted`: the pass stands on an earlier head whose change this head keeps; judge() verified that when the approval was filed,
  // and github binds the write to that head and policy (checked above).
  return v.verdict === "pass" && (v.kind === "completed" || v.kind === "exhausted") ? undefined : no("code review hasn't passed this head under its current policy", true);
}
