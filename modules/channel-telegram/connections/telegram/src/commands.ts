import { agentPaused } from "./aidenhq-sdk/agent-paused.js";
// Telegram quick commands, answered straight from Paperclip and the kernel's task state (no model, no wake): /waiting, /status, /brief, /help.
// Anything else is an ordinary message for Aiden.
export type Api = (method: string, path: string) => Promise<any>;
/** The kernel's task state read (GET /v1/tasks/state?open=1): every open task's one state, with the fleet's counts. */
export type OpenState = () => Promise<{ tasks: { identifier: string | null; kind: string; since: string; attention: { who: string }[] }[]; counts: { needs_you: number; failed: number; unexplained_idle: number } }>;
export interface QuickReply {
  text: string;
  actions?: string[];
  /** Task identifiers whose pending card the owner may approve from a button (made by main.ts from the kernel's cards). */
  applyTo?: string[];
  /** Ready-made buttons (set by main.ts). */
  markup?: unknown;
}

export const COMMANDS = [
  { command: "waiting", description: "What needs your decision" },
  { command: "status", description: "Agents and open tasks" },
  { command: "brief", description: "Today's daily brief" },
  { command: "stop", description: "Stop a chat's run (reply to its message)" },
  { command: "help", description: "What I can do" },
];

const OPEN = "backlog,todo,in_progress,in_review,blocked";
const line = (i: any) => `- ${i.identifier} ${String(i.title ?? "").slice(0, 80)}`;

export async function quickCommand(text: string, api: Api, company: string, openState: OpenState): Promise<QuickReply | null> {
  const cmd = text.trim().match(/^\/([a-z]+)(?:@\w+)?$/i)?.[1]?.toLowerCase();
  const issues = (q: Record<string, string>) => api("GET", `/api/companies/${company}/issues?${new URLSearchParams({ limit: "200", excludeRoutineExecutions: "true", ...q })}`);
  switch (cmd) {
    case "waiting": {
      // Waiting on the owner = the kernel's state has attention for the owner, oldest first.
      const { tasks } = await openState();
      const list = tasks.filter((t) => t.identifier && t.attention.some((a) => a.who === "owner")).sort((a, b) => a.since.localeCompare(b.since));
      if (!list.length) return { text: "**Nothing is waiting on you.**" };
      const titles = new Map((await issues({ status: OPEN })).map((i: any) => [i.identifier, i.title]));
      const rows = list.slice(0, 15).map((t) => line({ identifier: t.identifier, title: titles.get(t.identifier) }));
      return {
        text: `**Waiting on you (${list.length}):**\n${rows.join("\n")}${list.length > 15 ? `\n…and ${list.length - 15} more` : ""}`,
        applyTo: list.slice(0, 4).map((t) => t.identifier!),
      };
    }
    case "status": {
      const agents: any[] = (await api("GET", `/api/companies/${company}/agents`)).filter((a: any) => a.status !== "terminated");
      const count = (s: string) => agents.filter((a) => (s === "paused" ? agentPaused(a) : !agentPaused(a) && a.status === s)).length;
      const broken = agents.filter((a) => a.status === "error").map((a) => a.name);
      const { tasks, counts } = await openState();
      const by = (k: string) => tasks.filter((t) => t.kind === k).length;
      return {
        text: [
          `**Agents:** ${count("running")} running, ${count("idle")} idle, ${count("paused")} paused${broken.length ? `, in error: ${broken.join(", ")}` : ""}.`,
          `**Tasks:** ${tasks.length} open: ${by("working")} working, ${by("waiting")} waiting, ${by("idle")} idle (failed ${counts.failed}, unexplained ${counts.unexplained_idle}), needs you ${counts.needs_you}.`,
        ].join("\n"),
      };
    }
    case "brief": {
      const labels: any[] = await api("GET", `/api/companies/${company}/labels`);
      const label = labels.find((l) => l.name === "daily-brief");
      const [latest] = label ? await issues({ labelId: label.id, status: `${OPEN},done` }) : [];
      if (!latest) return { text: "No daily brief yet today." };
      return { text: `**${latest.title}** (${latest.identifier})\n${String(latest.description ?? "").slice(0, 3000)}` };
    }
    case "help":
      return { text: `${COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n")}\nAnything else (typed or a voice note) goes to Aiden.` };
    default:
      return null;
  }
}
