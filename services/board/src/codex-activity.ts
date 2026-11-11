// What a Codex agent is doing, read from its session log (a "rollout" JSONL, one event per line). Paperclip has no
// live-log API; Codex writes this file as it works. Pure: the caller finds and reads the file.
import type { PlanItem } from "./activity.js";

export interface Step {
  at: string;
  kind: "tool" | "thought" | "message";
  text: string;
}
export interface SessionActivity {
  said?: string;
  saidAt?: string;
  plan?: PlanItem[];
  steps: Step[];
}

const MAX_STEPS = 60;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
// The argument that says what the call is about, in order of how well it reads.
const ARG_KEYS = ["query", "q", "jql", "question", "url", "path", "channel", "command", "cmd", "text", "name"];

function firstArg(args: Record<string, unknown>): string {
  for (const k of ARG_KEYS) if (typeof args[k] === "string" && args[k]) return clip(oneLine(args[k] as string), 80);
  for (const v of Object.values(args)) if (typeof v === "string" && v) return clip(oneLine(v), 80);
  return "";
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function toolStep(namespace: string, name: string, rawArgs: string): string {
  // Older logs carry "mcp__glean__search" as the name with no namespace.
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m && !namespace) {
    namespace = m[1]!;
    name = m[2]!;
  }
  const ns = namespace.replace(/^mcp__/, "");
  let args: Record<string, unknown> = {};
  try {
    const p = JSON.parse(rawArgs);
    if (p && typeof p === "object") args = p;
  } catch {}
  const arg = firstArg(args);
  if (name === "update_plan") return "Updating plan";
  if (!ns) return arg ? `Running ${name}: ${arg}` : `Running ${name}`;
  const who = title(ns);
  if (/^search/.test(name)) return arg ? `Searching ${who}: ${arg}` : `Searching ${who}`;
  if (/thread/.test(name) && /^(read|get)/.test(name)) return `Reading ${who} thread`;
  if (ns === "jira" && arg) return `Jira: ${arg}`;
  return `${ns} · ${name}${arg ? `: ${arg}` : ""}`;
}

const planState = (s: string): PlanItem["state"] => (s === "completed" ? "done" : s === "in_progress" ? "doing" : "todo");

export function activityFromSession(lines: string[]): SessionActivity {
  const steps: Step[] = [];
  let plan: PlanItem[] | undefined;
  for (const raw of lines) {
    let e: { timestamp?: string; type?: string; payload?: Record<string, any> };
    try {
      e = JSON.parse(raw);
    } catch {
      continue; // a half-written last line while Codex is mid-write
    }
    const p = e.payload;
    if (e.type !== "response_item" || !p) continue;
    const at = e.timestamp ?? "";
    if (p.type === "function_call" && typeof p.name === "string") {
      if (p.name === "update_plan") {
        try {
          const items = JSON.parse(p.arguments).plan;
          if (Array.isArray(items)) plan = items.filter((i) => typeof i?.step === "string").slice(0, 20).map((i) => ({ text: clip(i.step, 200), state: planState(i.status) }));
        } catch {}
      }
      steps.push({ at, kind: "tool", text: toolStep(p.namespace ?? "", p.name, p.arguments ?? "") });
    } else if (p.type === "reasoning") {
      const text = [...(p.content ?? []), ...(p.summary ?? [])].map((c: any) => c?.text).find((t) => typeof t === "string" && t.trim());
      if (text) steps.push({ at, kind: "thought", text: clip(oneLine(text), 300) });
    } else if (p.type === "message" && p.role === "assistant") {
      const text = (p.content ?? []).filter((c: any) => c?.type === "output_text").map((c: any) => c.text).join(" ");
      if (text.trim()) steps.push({ at, kind: "message", text: clip(oneLine(text), 300) });
    }
  }
  const last = steps.findLast((s) => s.kind !== "tool");
  return { ...(last ? { said: clip(last.text, 200), saidAt: last.at } : {}), ...(plan?.length ? { plan } : {}), steps: steps.slice(-MAX_STEPS) };
}
