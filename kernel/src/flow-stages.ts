// Flow's stages (docs/design/flow.md §3): an interval from one fact to the next matching fact about the same subject. The
// kernel's own are here; each module declares its own in module.yaml `stages:` (compiled into config/kernel/modules.json).
/** A stage as a module declares it. `start`: a data field holding the real start time (default the `from` fact's `at`); with
 * `from === to` the one fact is the whole interval. `where`: data fields the `to` fact must match. */
export type StageDecl = { name: string; label: string; from: string; to: string; start?: string; where?: Record<string, string> };
export type Stage = StageDecl & { module: string };

/** The kernel's own: a job's queue (from its wake) and its run, the AI reviewer's and the owner's decisions, and a merge to its deploy. */
export const KERNEL_STAGES: Stage[] = [
  { name: "queued", label: "Queued", from: "job.queued", to: "job.started", start: "wake_at", module: "kernel" },
  { name: "working", label: "Working", from: "job.started", to: "job.ended", module: "kernel" },
  { name: "review", label: "Review", from: "record.filed", to: "record.decided", where: { decider: "reviewer" }, module: "kernel" },
  { name: "owner", label: "Owner", from: "record.filed", to: "record.decided", where: { decider: "owner" }, module: "kernel" },
  { name: "deploy", label: "Deploy", from: "pr.merged", to: "pr.deployed", module: "kernel" },
];
