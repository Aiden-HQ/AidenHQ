// What the task drawer's Done means and Activity show, shaped from the grading module's row (grading.ts) and the kernel's facts
// for this one task (flow.ts task()). Agent text in either is untrusted: shown as plain text.
import type { Deliverable, GradeState, GradesView, Verdict } from "./grading.js";
import type { Waterfall } from "./flow.js";
import { triggerWords } from "./timeline.js";

export interface GradeShown {
  /** none: no grade row (nothing is shown); unavailable: the module can't be read; ungraded_close: closed with no verdict. */
  state: "none" | "unavailable" | "ungraded_close" | GradeState;
  rubric: { text: string; met: "yes" | "no" | "unknown"; evidence?: string }[];
  judgedAt?: string;
  version?: string;
  deliverable?: { kind: Deliverable["kind"]; ref: string; href?: string };
}

export interface Milestone {
  at: string;
  kind: "created" | "run_started" | "run_ended" | "asked_you" | "approved" | "applied" | "deployed" | "graded";
  text: string;
  href?: string;
  runId?: string;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const HOSTED = /^[\w.-]+\/[\w.-]+#\d+$/;

/** A deliverable's link, only once its ref resolves: a URL or an `owner/repo#n` on GitHub (an app's name is not checked against the registry, so it is text). */
function hrefOf(d: Deliverable): string | undefined {
  if (/^https?:\/\//.test(d.ref)) return d.ref;
  if ((d.kind === "pr" || d.kind === "issue") && HOSTED.test(d.ref)) return `https://github.com/${d.ref.replace("#", d.kind === "pr" ? "/pull/" : "/issues/")}`;
  return undefined;
}

/** The grade as the drawer shows it. `view` undefined: the module couldn't be read (never read as passed). */
export function gradeShown(view: GradesView | undefined, id: string, status: string, w: Waterfall | null = null): GradeShown {
  if (!view || !Object.hasOwn(view.grades, id)) return { state: "unavailable", rubric: [] };
  const g = view.grades[id];
  if (!g) return { state: "none", rubric: [] };
  const v: Verdict | undefined = g.verdicts.at(-1);
  const texts = g.rubric.length ? g.rubric : (view.templates?.[g.deliverable.kind] ?? []);
  const rubric = texts.map((text, i) => {
    const c = v?.criteria.find((x) => x.id === String(i + 1));
    return { text, met: c?.met ?? "unknown", ...(c?.evidence ? { evidence: clip(c.evidence, 200) } : {}) };
  });
  const closed = status === "done" || g.closedReason !== null;
  // Met only on a satisfied (or owner-accepted) verdict: the module also closes a row satisfied when it gives up or lets unmet work through.
  const verified = v?.verdict === "satisfied" || v?.verdict === "accepted";
  // A blank PR ref means the task's own PRs: the newest GitHub one it opened and that is not closed unmerged.
  const gone = new Set<string>();
  for (const f of w?.facts ?? []) if (f.type.startsWith("pr.")) f.type === "pr.closed" && f.data?.merged !== true ? gone.add(f.subject) : f.type === "pr.opened" || f.type === "pr.merged" ? gone.delete(f.subject) : undefined;
  const own = g.deliverable.ref || g.deliverable.kind !== "pr" ? "" : (w?.facts.findLast((f) => f.type === "pr.opened" && HOSTED.test(f.subject.slice(3)) && !f.subject.startsWith("pr:local/") && !gone.has(f.subject))?.subject.slice(3) ?? "");
  const deliverable = { ...g.deliverable, ref: g.deliverable.ref || own };
  return {
    state: (g.state === "satisfied" && !verified) || (!v && closed) ? "ungraded_close" : g.state,
    rubric,
    ...(v ? { judgedAt: v.at, version: v.version } : {}),
    deliverable: { kind: deliverable.kind, ref: deliverable.ref, href: hrefOf(deliverable) },
  };
}

/** The task's own facts as milestones, oldest first. */
export function milestonesOf(w: Waterfall | null): Milestone[] {
  const out: Milestone[] = [];
  for (const f of w?.facts ?? []) {
    const d = f.data ?? {};
    const m = (kind: Milestone["kind"], text: string, extra: Partial<Milestone> = {}) => out.push({ at: f.at, kind, text, ...extra });
    const record = f.subject.startsWith("record:") ? `#/approvals/${f.subject.slice(7)}` : undefined;
    switch (f.type) {
      case "task.created": if (f.subject === `task:${w!.task}`) m("created", "Created"); break;
      case "job.started": m("run_started", "Run started", { runId: f.subject.slice(4) }); break;
      case "job.ended": m("run_ended", d.state === "done" ? "Run finished" : d.exit === 143 ? "Run stopped" : `Run ${d.state === "cancelled" ? "stopped" : String(d.state ?? "failed")}${d.why ? `: ${clip(d.why, 160)}` : ""}`, { runId: f.subject.slice(4) }); break;
      case "work.waiting": if (d.reason === "owner_wait") m("asked_you", `Asked you${d.question || d.note ? `: ${clip(typeof d.question === "string" ? d.question : d.note, 160)}` : ""}`); break;
      case "record.decided": if (d.decision === "approved") m("approved", `Card approved${d.decider === "reviewer" ? " by the AI reviewer" : d.decider === "owner" ? " by you" : ""}`, { href: record }); break;
      case "record.landed": m("applied", `Card applied${d.kind ? `: ${clip(d.kind, 60)}` : ""}`, { href: record }); break;
      case "pr.deployed": m("deployed", `Deployed${d.generation ? ` in generation ${d.generation}` : ""}`, { href: HOSTED.test(String(d.pr ?? "")) ? `https://github.com/${String(d.pr).replace("#", "/pull/")}` : undefined }); break;
      case "grade.verdict": m("graded", d.pass === true ? "Graded: satisfied" : d.reason_code === "needs_revision" ? "Graded: criteria unmet" : `Graded: ${String(d.reason_code ?? "not met").replaceAll("_", " ")}`); break;
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface RunLine {
  id: string;
  seconds: number;
  /** What woke the run, in Agent Activity's words; absent when the kernel has no wake for it. */
  trigger?: string;
}

/** The run behind an agent's final reply (its job tag, which only the kernel writes): how long it ran and what woke it, from the task's facts. */
export function runLineOf(body: string, w: Waterfall | null, agents: Parameters<typeof triggerWords>[2]): RunLine | undefined {
  const id = /<!-- aidenhq:job=(j-[0-9a-f]{16}) kind=reply -->\s*$/.exec(body)?.[1];
  const at = (type: string) => w?.facts.find((f) => f.type === type && f.subject === `job:${id}`)?.at;
  const [start, end] = [at("job.started"), at("job.ended")];
  if (!id || !start || !end) return undefined;
  const wake = w!.facts.find((f) => f.type === "wake.bound" && f.data?.job === id)?.subject;
  const opened = wake ? w!.facts.findLast((f) => f.type === "wake.opened" && f.subject === wake) : undefined;
  return {
    id,
    seconds: Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)),
    ...(opened ? { trigger: triggerWords(String(opened.data?.cause ?? ""), String(opened.data?.author ?? ""), agents) } : {}),
  };
}
