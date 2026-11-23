// The fast chat lane's configuration: one secret file setup writes (scripts/paperclip-setup.ts, `lane_config`), re-read
// whenever it changes, so an apply that adds or changes a lane agent needs no restart. Empty or missing: no lane agents.
// Per agent: its Paperclip id and name, its chat task (its tool calls cross the kernel as that agent, so its grants apply),
// the model settings from its `chat:` block, its handbook, the tools it may use here (by connection name), and its
// own Telegram bot token if it has one.
import { readFileSync, statSync } from "node:fs";

export interface LaneTool { connection: string; name: string }
export interface LaneAgent {
  key: string;
  id: string;
  name: string;
  /** Its chat task (setup's ensureChatTasks): the conversation, on every channel. */
  chatTask: string;
  model: string;
  reasoning: "off" | "low";
  deadlineS: number;
  prompt: string;
  tools: LaneTool[];
  telegramToken?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The file's agents by key; malformed entries are skipped (an apply never takes the lane down). */
export function parseLaneConfig(text: string): Record<string, LaneAgent> {
  if (!text.trim()) return {};
  const raw = (JSON.parse(text) as { agents?: Record<string, Record<string, unknown>> }).agents ?? {};
  const out: Record<string, LaneAgent> = {};
  for (const [key, a] of Object.entries(raw)) {
    if (!a || !str(a.id) || !str(a.chat_task) || !str(a.model)) continue;
    const tools = (Array.isArray(a.tools) ? a.tools : []) as Record<string, unknown>[];
    out[key] = {
      key,
      id: str(a.id),
      name: str(a.name) || key,
      chatTask: str(a.chat_task),
      model: str(a.model),
      reasoning: a.reasoning === "low" ? "low" : "off",
      deadlineS: Number(a.deadline_s) > 0 ? Number(a.deadline_s) : 8,
      prompt: str(a.prompt),
      tools: tools.filter((t) => str(t.connection) && str(t.name)).map((t) => ({ connection: str(t.connection), name: str(t.name) })),
      ...(str(a.telegram_token) ? { telegramToken: str(a.telegram_token) } : {}),
    };
  }
  return out;
}

export function laneConfig(file: string | undefined, warn: (msg: string) => void = () => {}): () => Record<string, LaneAgent> {
  let cached: { mtimeMs: number; size: number; agents: Record<string, LaneAgent> } = { mtimeMs: -1, size: -1, agents: {} };
  return () => {
    if (!file) return {};
    try {
      const st = statSync(file);
      if (st.mtimeMs !== cached.mtimeMs || st.size !== cached.size) cached = { mtimeMs: st.mtimeMs, size: st.size, agents: parseLaneConfig(readFileSync(file, "utf8")) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") warn(`lane config unreadable: ${(err as Error).message}`);
    }
    return cached.agents;
  };
}
