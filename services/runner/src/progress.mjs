// What a job shows on the board while it works: the agent's latest words and its own task list,
// read from the engine's event stream (Claude Code, Codex, opencode). Kept in memory and sent with
// the activity report; it never reaches Paperclip, and the reply is still the job's final comment.

const SAID_MAX = 600;
const PLAN_MAX = 20;
const ITEM_MAX = 200;

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const STATE = { completed: "done", in_progress: "doing", pending: "todo" };
const STEPS_MAX = 30;
// Steps show command lines on the board: blank the usual secret shapes first.
const redact = (t) =>
  t
    .replace(/(Bearer|Basic|token)\s+[^\s'"]+/gi, "$1 …")
    .replace(/:\/\/[^/\s@]+@/g, "://…@")
    .replace(/([?&](?:token|key|secret|password|sig|access_token)=)[^&\s'"]+/gi, "$1…")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=[^\s'"]+/g, "$1=…")
    .replace(/\b(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA)[A-Za-z0-9_-]+/g, "$1…");
// The argument that says what a tool call is about, in order of how well it reads.
const ARG_KEYS = ["command", "query", "q", "file_path", "filePath", "path", "pattern", "url", "description", "name"];
function firstArg(args) {
  if (!args || typeof args !== "object") return "";
  for (const k of ARG_KEYS) if (typeof args[k] === "string" && args[k]) return clip(args[k], 120);
  return "";
}
const withArg = (label, args) => {
  const a = firstArg(args);
  return a ? `${label}: ${a}` : label;
};

/** A tracker for one run: `take(event)` returns true when what the board would show changed. */
export function progressTracker() {
  let said = "";
  let saidAt = "";
  let plan = []; // [{ id?, text, state: "todo" | "doing" | "done" }]
  const creating = new Map(); // Claude Code: TaskCreate tool_use id → subject, until its result names the task
  const setSaid = (text) => {
    const t = clip(text, SAID_MAX);
    if (!t || t === said || t === "NO_REPLY") return false;
    said = t;
    saidAt = new Date().toISOString();
    return true;
  };
  const setPlan = (items) => {
    const next = items.filter((i) => i.text).slice(0, PLAN_MAX);
    if (JSON.stringify(next) === JSON.stringify(plan)) return false;
    plan = next;
    return true;
  };
  const steps = []; // [{ at, kind: "tool", text }], the newest STEPS_MAX
  const step = (text, at) => {
    steps.push({ at: at ? new Date(at).toISOString() : new Date().toISOString(), kind: "tool", text: clip(redact(text), ITEM_MAX) });
    if (steps.length > STEPS_MAX) steps.shift();
    return true;
  };
  const todos = (list) => setPlan((Array.isArray(list) ? list : []).map((t) => ({ text: clip(t.activeForm && t.status === "in_progress" ? t.activeForm : t.content, ITEM_MAX), state: STATE[t.status] ?? "todo" })));

  function take(e) {
    if (!e || typeof e !== "object") return false;
    let changed = false;
    // Claude Code: text between tool calls, and its task tools (TaskCreate/TaskUpdate; TodoWrite in older versions).
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === "text") changed = setSaid(c.text) || changed;
        if (c.type !== "tool_use") continue;
        if (!/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(c.name)) changed = step(withArg(c.name, c.input)) || changed;
        if (c.name === "TodoWrite") changed = todos(c.input?.todos) || changed;
        if (c.name === "TaskCreate" && c.input?.subject) creating.set(c.id, c.input.subject);
        if (c.name === "TaskUpdate" && c.input?.taskId) {
          const id = String(c.input.taskId);
          const { status, subject } = c.input;
          if (status === "deleted") changed = setPlan(plan.filter((i) => i.id !== id)) || changed;
          else changed = setPlan(plan.map((i) => (i.id === id ? { ...i, ...(subject ? { text: clip(subject, ITEM_MAX) } : {}), ...(STATE[status] ? { state: STATE[status] } : {}) } : i))) || changed;
        }
      }
    }
    if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        const subject = c.type === "tool_result" && creating.get(c.tool_use_id);
        if (!subject) continue;
        creating.delete(c.tool_use_id);
        const id = e.tool_use_result?.task?.id ?? /#(\d+)/.exec(JSON.stringify(c.content))?.[1];
        if (id && !c.is_error) changed = setPlan([...plan.filter((i) => i.id !== String(id)), { id: String(id), text: clip(subject, ITEM_MAX), state: "todo" }]) || changed;
      }
    }
    // Codex: its messages, and the plan tool's list (no "in progress": the first open item is it).
    if (/^item\.(started|updated|completed)$/.test(e.type ?? "") && e.item) {
      if (e.type === "item.started" && e.item.type === "command_execution" && e.item.command) changed = step(`Running ${clip(e.item.command, 120)}`) || changed;
      if (e.type === "item.started" && e.item.type === "mcp_tool_call") changed = step(withArg(`${e.item.server} · ${e.item.tool}`, e.item.arguments)) || changed;
      if (e.type === "item.started" && e.item.type === "web_search" && e.item.query) changed = step(`Searching the web: ${clip(e.item.query, 120)}`) || changed;
      if (e.type === "item.completed" && e.item.type === "file_change") changed = step(`Editing ${(e.item.changes ?? []).map((c) => c.path).join(", ") || "files"}`) || changed;
      if (e.item.type === "agent_message" && e.type === "item.completed") changed = setSaid(e.item.text) || changed;
      if (e.item.type === "todo_list" && Array.isArray(e.item.items)) {
        const open = e.item.items.findIndex((t) => !t.completed);
        changed = setPlan(e.item.items.map((t, i) => ({ text: clip(t.text, ITEM_MAX), state: t.completed ? "done" : i === open ? "doing" : "todo" }))) || changed;
      }
    }
    // opencode
    if (e.type === "text" && e.part?.text) changed = setSaid(e.part.text) || changed;
    if (e.type === "tool_use" && e.part?.tool === "todowrite") changed = todos(e.part.state?.input?.todos) || changed;
    else if (e.type === "tool_use" && e.part?.tool) changed = step(withArg(e.part.tool, e.part.state?.input), e.timestamp) || changed;
    return changed;
  }

  return { take, current: () => ({ ...(said ? { said, saidAt } : {}), ...(plan.length ? { plan: plan.map(({ text, state }) => ({ text, state })) } : {}), ...(steps.length ? { steps: [...steps] } : {}) }) };
}
