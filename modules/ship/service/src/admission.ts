// Admission before spend: whether code review (and any other work) may start on a PR. A repo ship doesn't cover is admitted;
// an external PR (a fork, or an author without write access) is admitted only when the repo's `external` is `any` or a trusted
// member has handed it off (an adoption record exists). The caller (code review, with its module token) states what it read.
import { effective } from "./settings.ts";
import type { State } from "./state.ts";

export interface Pr { repo: string; number: number; fork: boolean; member: boolean }

export function admitted(raw: unknown, covered: string[], state: State, pr: Pr): { admitted: boolean; why: string } {
  const s = effective(raw, pr.repo, covered);
  if (!s) return { admitted: true, why: "ship doesn't cover this repo" };
  if (!pr.fork && pr.member) return { admitted: true, why: "the author has write access" };
  if (s.external === "any") return { admitted: true, why: "external PRs are admitted on this repo" };
  const a = state.get(pr.repo, pr.number);
  if (a && a.status !== "stopped") return { admitted: true, why: "a trusted member handed it off" };
  return { admitted: false, why: "an external PR waits for a trusted member to hand it off" };
}
