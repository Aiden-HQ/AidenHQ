// The report: the one comment on an adopted PR, edited in place, in plain words, written by code. It exists only for what a person
// has to do (a hold, a hand-back, a code owner's or a required review, an approval, a merge Ship may not make) and for the one
// line that acknowledges a member's hand-off; once it exists it is kept true (edited), never added to. Nothing internal reaches it:
// no generation, hash, rule, counter, finding or agent instruction. Posted through the code host's `comment` op, which finds the
// comment by MARKER before it creates one and adds the "via AidenHQ" footer.
export const MARKER = "<!-- aidenhq-ship -->";

/** The line that acknowledges a member's explicit hand-off (the `ship` label or a `/ship` comment). */
export const ACK = "Ship has this PR: it will rebase, fix CI and review comments, and merge when ready.";

const FIXED = {
  /** Ship is working, or waiting on something that needs no one. */
  active: ACK,
  /** Code review's findings are open: Ship's task fixes or answers them. */
  findings: "Waiting for review findings to be fixed or answered.",
  review: "Waiting for a required review.",
  approval: "Waiting for an approval on the latest commit.",
  person_merge: "Ready to merge. Merge is off for this PR, so a person merges it.",
  checks: "A required check never reported on the latest commit. A person reruns it or fixes the workflow.",
  requeue: "Ship won't queue this PR again. A person queues it again, or pushes a fix.",
  owner_card: "Ship's merge is waiting for the owner's approval on the board.",
  merged: "Merged.",
};
/** The kinds a person has to act on. */
const ACT = new Set<Kind>(["review", "approval", "checks", "requeue", "owner_card", "person_merge", "owner", "hold"]);

export type Kind = keyof typeof FIXED | "owner" | "hold";
/** What a round says about the PR: its kind, and the sentence for the kinds that carry one (owner, hold, a special merge). */
export interface Facts { kind: Kind; text?: string }

/** The words, and whether a person must act on them. */
export function say(f: Facts): { text: string; act: boolean } {
  return { text: f.text ?? FIXED[f.kind as keyof typeof FIXED], act: ACT.has(f.kind) };
}

/** What a hold says, in plain words, with what a person can do. A hold's own reason stays on the adoption and in the task's wake. */
export const HOLD = {
  cap: "Ship stopped: it reached its limit of tries on this PR. A new commit lets it continue; otherwise a person takes it from here.",
  settings: (what: string) => `Ship can't ${what} here: this repo's Ship settings don't allow it. A person does it, or changes the repo's Ship settings.`,
  noEdits: "Ship can't push to this fork's branch. The contributor can allow edits by maintainers, or rebase and fix it themselves.",
  github: "GitHub refused to update this branch. A person updates or fixes it.",
  pushPartial: "Only part of Ship's fix for this PR went through, so the branch holds only part of it. A person finishes or reverts it.",
  pushRefused: (why: string) => `Ship's fix for this PR didn't go through (${why.replace(/[\r\n]+/g, " ")}). A person pushes the fix, or changes the rule that refused it.`,
  repair: "Ship couldn't repair this PR on its own. A person needs to resolve it.",
  steps: "A step the repo asks Ship to run before merging didn't pass. A person needs to look at it.",
  ciRegen: (check: string) => `Ship resolved a conflict by taking the base side of generated files, and the repo's ${check.replace(/[\r\n`]+/g, " ")} check, which regenerates them, didn't pass on that commit. A person checks the generated files.`,
  failed: "Ship's merge or approval for the latest commit was refused or didn't go through. A person decides what happens next.",
  refused: (why: string) => `GitHub refused to queue this PR (${why.replace(/[\r\n]+/g, " ")}). A person clears it, or pushes a fix.`,
  stall: "GitHub blocks the merge on a rule Ship doesn't handle, such as review threads to resolve. A person clears it.",
  closed: "Ship stopped: its task was closed. A person decides what happens to this PR.",
  handedBack: "Ship handed this PR back. A person takes it from here; handing it over again restarts Ship.",
};

/** What a wait from the merge gate means for a person (its own text is for agents and is never printed). */
export function waitFacts(why = ""): Facts {
  const owner = /^waiting on code owner @(\S+)/.exec(why)?.[1];
  if (owner) return { kind: "owner", text: `Waiting for a review from code owner @${owner}.` };
  if (/^waiting for required review/.test(why)) return { kind: "review" };
  if (/^its approval is on an earlier commit/.test(why)) return { kind: "approval" };
  if (/^required check\(s\) never reported/.test(why)) return { kind: "checks" };
  // Code review's own wait for findings (not its pending classification or an outage: those need no one).
  if (/^code review: \d+ important finding/.test(why)) return { kind: "findings" };
  return { kind: "active" };
}

export const renderReport = (text: string) => `${MARKER}\n**Ship:** ${text}`;
