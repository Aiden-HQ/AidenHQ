import { agentPaused } from "./aidenhq-sdk/agent-paused.js";
// Telegram quick commands, answered straight from Paperclip (no model, no wake): /waiting, /status, /brief, /help.
// Anything else is an ordinary message for Aiden.
export type Api = (method: string, path: string) => Promise<any>;
export interface QuickReply {
  text: string;
  actions?: string[];
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

export async function quickCommand(text: string, api: Api, company: string): Promise<QuickReply | null> {
  const cmd = text.trim().match(/^\/([a-z]+)(?:@\w+)?$/i)?.[1]?.toLowerCase();
  const issues = (q: Record<string, string>) => api("GET", `/api/companies/${company}/issues?${new URLSearchParams({ limit: "200", excludeRoutineExecutions: "true", ...q })}`);
  switch (cmd) {
    case "waiting": {
      // Waiting on the owner = in review (the doer's latest report asks the owner).
      const list: any[] = await issues({ status: "in_review" });
      if (!list.length) return { text: "**Nothing is waiting on you.**" };
      return {
        text: `**Waiting on you (${list.length}):**\n${list.slice(0, 15).map(line).join("\n")}${list.length > 15 ? `\n…and ${list.length - 15} more` : ""}`,
        actions: list.slice(0, 4).map((i) => `Apply ${i.identifier}`),
      };
    }
    case "status": {
      const agents: any[] = (await api("GET", `/api/companies/${company}/agents`)).filter((a: any) => a.status !== "terminated");
      const count = (s: string) => agents.filter((a) => (s === "paused" ? agentPaused(a) : !agentPaused(a) && a.status === s)).length;
      const broken = agents.filter((a) => a.status === "error").map((a) => a.name);
      const open: any[] = await issues({ status: OPEN });
      const by = (s: string) => open.filter((i) => i.status === s).length;
      return {
        text: [
          `**Agents:** ${count("running")} running, ${count("idle")} idle, ${count("paused")} paused${broken.length ? `, in error: ${broken.join(", ")}` : ""}.`,
          `**Tasks:** ${open.length} open tasks: ${by("in_progress")} in progress, ${by("in_review")} waiting on you, ${by("blocked")} blocked, ${by("todo") + by("backlog")} not started.`,
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
