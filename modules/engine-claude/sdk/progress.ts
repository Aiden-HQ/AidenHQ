// What a job shows while it works: its latest words, its own task list and its recent tool calls. An engine feeds this
// from its event stream and emits `snapshot()` as a progress event whenever a call returns true. The runner blanks secret
// shapes in steps before showing them.
import type { EngineEvent } from "./types.ts";

const SAID_MAX = 600;
const PLAN_MAX = 20;
const ITEM_MAX = 200;
const STEPS_MAX = 30;

export const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// The argument that says what a tool call is about, in order of how well it reads.
const ARG_KEYS = ["command", "query", "q", "file_path", "filePath", "path", "pattern", "url", "description", "name"];
export function withArg(label: string, args?: any): string {
  if (args && typeof args === "object") for (const k of ARG_KEYS) if (typeof args[k] === "string" && args[k]) return `${label}: ${clip(args[k], 120)}`;
  return label;
}

export interface PlanItem { id?: string; step: string; done: boolean; doing?: boolean }

export function tracker() {
  let said = "";
  let plan: PlanItem[] = [];
  const steps: { at: string; text: string }[] = [];
  return {
    said(text: unknown): boolean {
      const t = clip(text, SAID_MAX);
      if (!t || t === said || t === "NO_REPLY") return false;
      said = t;
      return true;
    },
    plan(items: PlanItem[]): boolean {
      const next = items.filter((i) => i.step).map((i) => ({ ...i, step: clip(i.step, ITEM_MAX) })).slice(0, PLAN_MAX);
      if (JSON.stringify(next) === JSON.stringify(plan)) return false;
      plan = next;
      return true;
    },
    items: () => plan,
    step(text: string, at?: number | string): boolean {
      steps.push({ at: at ? new Date(at).toISOString() : new Date().toISOString(), text: clip(text, ITEM_MAX) });
      if (steps.length > STEPS_MAX) steps.shift();
      return true;
    },
    snapshot: (): EngineEvent => ({ t: "progress", text: said, ...(plan.length ? { plan: plan.map(({ step, done, doing }) => ({ step, done, ...(doing ? { doing } : {}) })) } : {}), ...(steps.length ? { steps: [...steps] } : {}) }),
  };
}
