// A fixture-backed stand-in for the board's API, for working on the web UI without a kernel or Paperclip:
//   node web/dev/mock-api.ts & npm run dev:web     (vite proxies /api to :3120)
// Neutral sample data only. Writes answer ok and change nothing. GET /__mock?welcome=1|0 shows or hides the first-run wizard;
// GET /__mock?empty=1 empties every list (empty states); ?slow=<ms> delays every answer (loading states); ?search=keyword|down
// answers task search with keyword hits only, or fails it (its degraded notes). ?email=<address> signs the mock owner in as it;
// ?org=1 lists an organisation with its own Google app. The Google flow is a short sample of modules/google/module.yaml's `ways`. ?slack=none|signin|org|full|old sets the
// Slack setup page's state (nothing yet, sign-in only, an organisation's sign-in, sign-in and bot, a bot app that predates the manifest).
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3120);
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const ahead = (min: number) => new Date(now + min * 60_000).toISOString();
/** Tomorrow 08:00 in the board's timezone (Asia/Dubai, UTC+4). */
const TOMORROW_8 = (() => { const d = new Date(now + 4 * 3600_000); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(8 - 4, 0, 0, 0); return d.toISOString(); })();
// OpenRouter's text models as the gateway serves them (kernel/src/gateway/prices.ts catalogOf): [id, name, created (days ago), context, in, out, tools, reasoning].
const MODEL_CATALOG = ([
  ["~deepseek/deepseek-flash-latest", "DeepSeek: V4 Flash", 6, 1000000, 0.1, 0.4, 1, 1], ["~openai/gpt-luna-latest", "OpenAI: GPT Luna", 9, 400000, 0.3, 2, 1, 1], ["~openai/gpt-sol-latest", "OpenAI: GPT Sol", 9, 400000, 2.5, 15, 1, 1], ["~openai/gpt-terra-latest", "OpenAI: GPT Terra", 9, 400000, 1, 6, 1, 1],
  ["~anthropic/claude-sonnet-latest", "Anthropic: Claude Sonnet", 12, 1000000, 3, 15, 1, 1], ["~anthropic/claude-opus-latest", "Anthropic: Claude Opus", 12, 1000000, 5, 25, 1, 1], ["~anthropic/claude-haiku-latest", "Anthropic: Claude Haiku", 12, 200000, 1, 5, 1, 1], ["~google/gemini-pro-latest", "Google: Gemini Pro", 20, 2000000, 1.25, 10, 1, 1], ["~moonshotai/kimi-latest", "MoonshotAI: Kimi", 30, 262144, 0.6, 2.5, 1, 1],
  ["openai/gpt-6.2-sol", "OpenAI: GPT-6.2 Sol", 9, 400000, 2.5, 15, 1, 1], ["openai/gpt-6.1-sol", "OpenAI: GPT-6.1 Sol", 70, 400000, 2.5, 15, 1, 1], ["openai/gpt-6-sol", "OpenAI: GPT-6 Sol", 140, 400000, 2.5, 15, 1, 1], ["openai/gpt-6.2-luna", "OpenAI: GPT-6.2 Luna", 9, 400000, 0.3, 2, 1, 1], ["openai/gpt-6.1-luna", "OpenAI: GPT-6.1 Luna", 70, 400000, 0.3, 2, 1, 1], ["openai/gpt-oss-120b", "OpenAI: gpt-oss-120b", 300, 131072, 0.04, 0.2, 1, 1], ["openai/gpt-oss-20b:free", "OpenAI: gpt-oss-20b (free)", 300, 131072, 0, 0, 0, 1],
  ["anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", 12, 1000000, 5, 25, 1, 1], ["anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5", 12, 1000000, 3, 15, 1, 1], ["anthropic/claude-haiku-5.5", "Anthropic: Claude Haiku 5.5", 12, 200000, 1, 5, 1, 1], ["anthropic/claude-opus-5", "Anthropic: Claude Opus 5", 90, 1000000, 5, 25, 1, 1], ["anthropic/claude-sonnet-5", "Anthropic: Claude Sonnet 5", 90, 1000000, 3, 15, 1, 1], ["anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5", 400, 1000000, 3, 15, 1, 1],
  ["deepseek/deepseek-v4-pro", "DeepSeek: V4 Pro", 40, 1000000, 0.5, 2, 1, 1], ["deepseek/deepseek-v4-flash", "DeepSeek: V4 Flash", 6, 1000000, 0.1, 0.4, 1, 1], ["deepseek/deepseek-v3.2", "DeepSeek: V3.2", 200, 163840, 0.25, 0.4, 1, 1],
  ["google/gemini-3.5-pro", "Google: Gemini 3.5 Pro", 20, 2000000, 1.25, 10, 1, 1], ["google/gemini-3-pro", "Google: Gemini 3 Pro", 150, 1000000, 1.25, 10, 1, 1], ["google/gemini-3.5-flash", "Google: Gemini 3.5 Flash", 20, 1000000, 0.3, 2.5, 1, 1], ["google/gemma-4-27b-it", "Google: Gemma 4 27B", 60, 131072, 0.1, 0.2, 0, 0],
  ["z-ai/glm-5.3", "Z.ai: GLM 5.3", 25, 202752, 0.4, 1.5, 1, 1], ["z-ai/glm-5.2", "Z.ai: GLM 5.2", 80, 202752, 0.4, 1.5, 1, 1], ["moonshotai/kimi-k3.1-pro", "MoonshotAI: Kimi K3.1 Pro", 30, 262144, 0.6, 2.5, 1, 1], ["moonshotai/kimi-k3", "MoonshotAI: Kimi K3", 120, 262144, 0.6, 2.5, 1, 1],
  ["meta-llama/llama-4.5-70b-instruct", "Meta: Llama 4.5 70B Instruct", 100, 131072, 0.15, 0.4, 1, 0], ["meta-llama/llama-4.5-8b-instruct", "Meta: Llama 4.5 8B Instruct", 100, 131072, 0.03, 0.06, 0, 0], ["qwen/qwen3.6-coder", "Qwen: Qwen3.6 Coder", 50, 262144, 0.2, 0.9, 1, 0], ["mistralai/mistral-large-3", "Mistral: Mistral Large 3", 110, 131072, 2, 6, 1, 0], ["x-ai/grok-5", "xAI: Grok 5", 45, 256000, 3, 15, 1, 1], ["minimax/minimax-m3", "MiniMax: M3", 35, 1000000, 0.3, 1.2, 1, 1],
] as [string, string, number, number, number, number, number, number][]).map(([id, name, d, context, i, o, tools, reasoning]) => ({ id, name, provider: id.replace(/^~/, "").split("/")[0], created: Math.floor(now / 1000) - d * 86400, context, in: i, out: o, tools: !!tools, reasoning: !!reasoning }));
const mock = { welcome: false, empty: false, slow: 0, search: "ok", email: "alex@example.com", org: false, slack: "none" };

// The kernel's task state (src/task-state.ts) as the board reads it: one row per task, every reason somewhere below.
const A = (who: string, why: string, ref = "x") => ({ who, why, ref });
const LANE: Record<string, string> = { owner_wait: "needs_you", card_owner: "needs_you", handback: "needs_you", job_running: "working", failed: "blocked", blocked: "blocked", unknown: "blocked", orphaned: "blocked", history_expired: "blocked", unpolled: "blocked", scheduled: "idle", backlog: "idle", owner_task: "idle", chat_turn: "idle", closed: "done", cancelled: "done" };
const st = (kind: string, reason: string, o: Record<string, unknown> = {}) => ({ task: "t", identifier: null as string | null, kind, reason, since: ago(30), holder: null, attention: [] as unknown[], lane: LANE[reason] ?? "waiting", ...o });
const ASK = st("waiting", "owner_wait", { since: ago(120), question: "Which week should I compare against?", attention: [A("owner", "owner_wait", "wait:t")] });
const CARD = st("waiting", "card_owner", { since: ago(9), ref: "record:k-00000000000000a1", refLabel: "Deploy the invoices app at 4e1a9c2", attention: [A("owner", "card", "record:k-00000000000000a1")] });
const WORKING_CARD = st("working", "job_running", { since: ago(12), stage: "CI running", ref: "job:j-2", lane: "needs_you", attention: [A("owner", "card", "record:k-00000000000000a2")] });
const FAILED = st("idle", "failed", { since: ago(8), ref: "job:j-1", refLabel: "timed out", attention: [A("agent", "failed", "job:j-1")] });
const UNKNOWN = st("idle", "unknown", { since: ago(25), attention: [A("agent", "unknown", "task:t")] });
const EXPIRED = st("idle", "history_expired", { since: ago(900), attention: [A("agent", "history_expired", "task:t")] });
const STATES = {
  running: st("working", "job_running", { since: ago(1), ref: "job:j-3" }),
  queued: st("waiting", "job_queued", { since: ago(4) }),
  held: st("waiting", "job_held", { since: ago(6), ref: "capacity" }),
  review: st("waiting", "card_review", { since: ago(4), ref: "record:k-00000000000000a5", refLabel: "Merge “Add CSV export” into main" }),
  delegator: st("waiting", "delegator_wait", { since: ago(33), attention: [A("agent", "delegator_wait", "wait:t")] }),
  handback: st("waiting", "handback", { since: ago(70), attention: [A("owner", "handback", "task:t")] }),
  blocked: st("waiting", "blocked", { since: ago(40), ref: "task:id-901", refLabel: "WOR-901" }),
  agentWait: st("waiting", "agent_wait", { since: ago(20) }),
  moduleWait: st("waiting", "module_wait", { since: ago(50), ref: "checks", note: "CI is running on the PR" }),
  stalled: st("waiting", "module_wait", { since: ago(400), ref: "design_review", lane: "blocked", attention: [A("agent", "stalled_wait", "design_review")] }),
  scheduled: st("waiting", "scheduled", { since: ago(60) }),
  chatTurn: st("waiting", "chat_turn", { since: ago(700) }),
  backlog: st("waiting", "backlog", { since: ago(2000) }),
  orphaned: st("idle", "orphaned", { since: ago(80), attention: [A("agent", "orphaned", "task:t")] }),
  done: st("done", "closed", { since: ago(180), grade: "pass" }),
  stopped: st("done", "cancelled", { since: ago(300) }),
};
const named = <T extends object>(identifier: string, state: T) => ({ ...state, identifier });

const dept = (id: string, name: string, order: number) => ({ id, name, order });
const OPS = dept("ops", "Chief of staff", 0), ENG = dept("eng", "Engineering", 1), DESK = dept("desk", "Desk", 2);
const roster = [
  { id: "a1", key: "aiden", name: "Aiden", title: "Chief of staff", system: false, department: OPS, avatar: "chief-of-staff", model: "deepseek-flash", reportsTo: null, state: "working", running: 1, queued: 0, workingSince: ago(3), schedules: [{ title: "Morning brief", paused: false, nextRunAt: ahead(600) }], lastRunAt: ago(3), lastRunStatus: "succeeded" },
  { id: "a2", key: "open-loops", name: "Open Loops", title: "Follow-ups and promises", system: false, department: OPS, avatar: "open-loops", model: "deepseek-flash", reportsTo: "a1", state: "idle", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Sweep", paused: false, nextRunAt: ahead(25) }], lastRunAt: ago(35), lastRunStatus: "succeeded" },
  { id: "a3", key: "engineer", name: "Engineer", title: "Builds and fixes code", system: false, department: ENG, avatar: "engineer", model: "deepseek-flash", reportsTo: "a1", state: "working", running: 3, queued: 1, workingSince: ago(12), schedules: [], lastRunAt: ago(12), lastRunStatus: "succeeded", maxParallel: 4 },
  { id: "a4", key: "platform-engineer", name: "Platform Engineer", title: "Keeps the fleet healthy", system: false, department: ENG, avatar: "platform-engineer", model: "deepseek-flash", reportsTo: "a1", state: "failing", stateNote: "Last 2 runs failed", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Health check", paused: false, nextRunAt: ahead(48) }], lastRunAt: ago(50), lastRunStatus: "failed" },
  { id: "a5", key: "ui-designer", name: "UI Designer", title: "Designs app screens", system: false, department: ENG, avatar: "ui-designer", model: "deepseek-flash", reportsTo: "a3", state: "queued", running: 0, queued: 2, workingSince: null, schedules: [], lastRunAt: ago(240), lastRunStatus: "succeeded" },
  { id: "a6", key: "email-triage", name: "Email Triage", title: "Sorts the inbox", system: false, department: DESK, avatar: "email-triage", model: "deepseek-flash", reportsTo: "a1", state: "paused", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Inbox pass", paused: true, nextRunAt: null }], lastRunAt: ago(1440), lastRunStatus: "succeeded" },
  { id: "a7", key: "meeting-librarian", name: "Meeting Librarian", title: "Notes from every meeting", system: false, department: DESK, avatar: "meeting-librarian", model: "deepseek-flash", reportsTo: "a1", state: "idle", running: 0, queued: 0, workingSince: null, schedules: [{ title: "After meetings", paused: false, nextRunAt: ahead(95) }], lastRunAt: ago(130), lastRunStatus: "succeeded" },
  { id: "a8", key: "researcher", name: "Researcher", title: "Research and drafts", system: true, department: OPS, avatar: "aiden", model: "deepseek-flash", reportsTo: null, state: "idle", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Process task replies", paused: true, nextRunAt: null }], lastRunAt: ago(60), lastRunStatus: "succeeded" },
];

const CARD_STATES: Record<number, ReturnType<typeof st>> = { 812: STATES.orphaned, 815: ASK, 790: WORKING_CARD, 801: STATES.queued, 802: FAILED, 770: STATES.scheduled, 700: STATES.agentWait, 705: UNKNOWN, 600: STATES.backlog };
// Agent work (the mockup's sample, docs/design/agent-work-board.html): every issue its own card in its kernel lane.
const PROJECTS = [{ id: "p-aidenhq", name: "AidenHQ" }, { id: "p-launch", name: "Launch" }, { id: "p-infra", name: "Infra" }, { id: "p-hiring", name: "Hiring" }];
const LABELS = [{ id: "l-code", name: "engineer", color: "#3b82f6" }, { id: "l-review", name: "needs-review", color: "#f59e0b" }];
const w = (n: number, title: string, who: string | null, state: Record<string, unknown> | null, o: Record<string, unknown> = {}) => ({
  ...card(n, title, { assignee: who, state: state && named(`WOR-${n}`, { ...state, task: `id-${n}` }), activityAt: ago(o.age as number ?? 30) }),
  parent: null, crewIds: [], closedAt: null, ...o,
});
const WORK = () => [
  w(7812, "Pick the payments vendor for the refund API", "aiden", st("waiting", "owner_wait", { question: "Stripe or Adyen? Adyen is cheaper at our volume but needs a 3-week review.", since: ago(120), attention: [A("owner", "owner_wait", "wait:t")] }), { priority: "high", projectId: "p-launch", age: 120 }),
  w(7820, "Approve push: release 0.9 notes", "engineer", st("waiting", "card_owner", { ref: "record:k-00000000000000a2", since: ago(25), attention: [A("owner", "card", "record:k-00000000000000a2")], refs: { "record:k-00000000000000a2": "push to docs/release-0.9" } }), { projectId: "p-launch", age: 25 }),
  w(7790, "Fix the flaky checkout test on CI", "engineer", st("working", "job_running", { ref: "job:j-e101000000000001", stage: "Testing", since: ago(3.2) }), { priority: "high", projectId: "p-launch", labelIds: ["l-code"], age: 40 }),
  w(7791, "Add retry to the checkout flow", "platform-engineer", st("working", "job_running", { ref: "job:j-e102000000000002", stage: "Coding", since: ago(8) }), { projectId: "p-launch", parent: "WOR-7790", age: 20 }),
  w(7795, "Weekly fleet digest", "aiden", st("working", "job_running", { ref: "job:j-77fa000000000003", stage: "Digest", since: ago(1) }), { projectId: "p-aidenhq", age: 6 }),
  w(7801, "Migrate the warehouse ingest to the new schema, including backfill of 2023 and the long tail of partner tables", "platform-engineer", st("working", "job_running", { ref: "job:j-0b3c000000000004", stage: "Migrating", since: ago(12.6) }), { projectId: "p-infra", crewIds: ["engineer"], age: 60 }),
  w(7788, "Release 0.9 candidate", "engineer", st("waiting", "card_review", { ref: "record:k-00000000000000a5", refLabel: "reviewer is reading the diff", since: ago(18) }), { projectId: "p-launch", labelIds: ["l-review"], age: 18 }),
  w(7765, "Ask legal about the data-retention clause", "aiden", st("waiting", "delegator_wait", { since: ago(180), waits_on: "a8", waits_on_name: "Research Lead", attention: [A("agent", "delegator_wait", "wait:t")] }), { projectId: "p-hiring", age: 180 }),
  w(7770, "Deploy marketing site", "platform-engineer", st("waiting", "module_wait", { ref: "checks", since: ago(50) }), { projectId: "p-infra", age: 50 }),
  w(7744, "Refund API: wire up the webhook handler", "engineer", st("idle", "failed", { ref: "job:j-d002000000000005", since: ago(300), attention: [A("agent", "failed", "job:j-d002000000000005")], refs: { "job:j-d002000000000005": "the job timed out after 120 min" } }), { priority: "critical", projectId: "p-launch", age: 300 }),
  w(7751, "Backfill invoices", "platform-engineer", st("waiting", "job_queued", { since: ago(300), blocker: "task:id-7744", lane: "blocked", note: "Waits for the webhook handler.", refs: { "task:id-7744": "WOR-7744" } }), { projectId: "p-infra", age: 300 }),
  w(7756, "Answer the partner's API question", "open-loops", st("idle", "failed", { ref: "no_reply", since: ago(90), attention: [A("agent", "failed", "no_reply")] }), { age: 90 }),
  w(7702, "Tidy the Notion roadmap", "aiden", st("waiting", "backlog", { since: ago(5760) }), { age: 5760 }),
  w(7733, "Prepare Thursday's board pre-read", "aiden", st("waiting", "scheduled", { since: ago(1440), scheduled_for: TOMORROW_8 }), { age: 1440 }),
  w(7690, "Review vendor security questionnaire", "me", st("waiting", "owner_task", { since: ago(2880) }), { age: 2880 }),
  w(7686, "Old import task", null, null, { age: 9000 }),
  w(7781, "Rotate the staging database credentials", "platform-engineer", st("done", "closed", { grade: "pass", since: ago(180) }), { status: "done", closedAt: ago(180), age: 180 }),
  w(7776, "Summarise the Monday leads call", "aiden", st("done", "closed", { grade: "pass", since: ago(540) }), { status: "done", closedAt: ago(540), age: 540 }),
  w(7760, "Stale PR cleanup", "engineer", st("done", "cancelled", { since: ago(1440) }), { status: "cancelled", closedAt: ago(1440), age: 1440 }),
  // A long Idle lane: 25 cards, then "Show N more".
  ...Array.from({ length: 32 }, (_, i) => w(6900 + i, i === 1 ? "A very long title that should clamp to two lines and never push the card wider, with https://example.com/a/very/long/path/that/keeps/going" : `Archive the Q${(i % 4) + 1} vendor threads`, "aiden", st("waiting", "backlog", { since: ago(9000 + i) }), { age: 9000 + i })),
];
// Task search (GET /api/search): any work card or old closed task sharing a word with the query (4+ letters, or a prefix of
// one), and "review" also finds what is about review without the word (the meaning half). Old closed tasks are months back.
const OLD_DONE = () => [
  [7012, "Add a code-review lens for module repos", "engineer", 60], [6950, "Critique checklist for pull requests", "aiden", 95], [6870, "Reviewer eval: planted cases for false rejects", "engineer", 120],
  [6801, "Tune the AI reviewer's malice-only rule", "platform-engineer", 150], [6744, "PR review comments land as one thread", "engineer", 180], [6702, "Second opinion on the checkout PR", "engineer", 210],
  [6650, "Review the vendor security questionnaire", "me", 240], [6601, "Retire the old review dashboard", "aiden", 270], [6555, "Reviewer timeouts on large diffs", "platform-engineer", 300],
  [6500, "Code review summary in the morning brief", "aiden", 330], [6444, "Lint rule for review comments", "engineer", 365], [6400, "Warehouse backups to the storage box", "platform-engineer", 400],
  // A long tail, so Done pages ("Show more").
  ...Array.from({ length: 30 }, (_, i) => [6300 - i, `Weekly review of the ${["billing", "export", "ingest"][i % 3]} PRs`, "engineer", 420 + i * 7]),
].map(([n, title, who, days]) => w(n as number, title as string, who as string, st("done", "closed", { since: ago((days as number) * 1440) }), { status: "done", closedAt: ago((days as number) * 1440), age: (days as number) * 1440, projectId: (n as number) % 2 ? "p-launch" : null }));
function search(q: string, after: string | null): [number, unknown] {
  if (mock.search === "down") return [503, { error: "task search is unavailable" }];
  const words = q.toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
  const hit = (title: string) => words.some((x) => title.toLowerCase().split(/[^a-z0-9-]+/).some((t) => t.startsWith(x))) || (mock.search === "ok" && words.some((x) => x.startsWith("review")) && /critique|second opinion|pr |lens/i.test(title));
  // Older closed hits a page of 8 at a time, newest first, like the board's route (by the last one's id here).
  const old = OLD_DONE().filter((c) => hit(c.title));
  const from = after ? old.findIndex((c) => c.id === after) + 1 : 0;
  const page = old.slice(from, from + 8);
  return [200, { ids: WORK().filter((c) => hit(c.title)).map((c) => c.id), done: page, next: from + 8 < old.length ? page.at(-1)!.id : null, semantic: mock.search === "ok" }];
}
// Saved boards (GET/POST/PUT/DELETE /api/views): in memory, revisioned like the board's.
let views = [
  { id: "00000000-0000-4000-8000-0000000000a1", name: "Needs review", rev: 1, spec: { layout: "work", groupBy: "none", filters: { label: ["l-review"] } } },
  { id: "00000000-0000-4000-8000-0000000000a2", name: "Engineering", rev: 1, spec: { layout: "work", groupBy: "none", filters: { agent: ["engineer", "aiden", "platform-engineer"], updated: "7d" } } },
];
function viewRoute(method: string, url: URL, body: any): [number, unknown] | undefined {
  const id = /^\/api\/views\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
  if (url.pathname === "/api/views" && method === "GET") return [200, { views: mock.empty ? [] : views }];
  if (url.pathname === "/api/views" && method === "POST") { const v = { id: crypto.randomUUID(), name: body.name, spec: body.spec, rev: 1 }; views.push(v); return [200, v]; }
  if (!id) return undefined;
  const v = views.find((x) => x.id === id);
  const rev = method === "DELETE" ? Number(url.searchParams.get("rev")) : body.rev;
  if (!v || v.rev !== rev) return [409, { error: "conflict", current: v ?? null }];
  if (method === "DELETE") return (views = views.filter((x) => x !== v), [200, { ok: true }]);
  Object.assign(v, body.name ? { name: body.name } : {}, body.spec ? { spec: body.spec } : {}, { rev: v.rev + 1 });
  return [200, v];
}
const card = (n: number, title: string, extra: Record<string, unknown> = {}) => ({ id: `id-${n}`, identifier: `WOR-${n}`, title, status: "todo", priority: "medium", labels: [], labelIds: [] as string[], projectId: null as string | null, assignee: null, unread: false, createdAt: ago(n % 300), activityAt: ago(n % 90), state: CARD_STATES[n] ? named(`WOR-${n}`, CARD_STATES[n]) : null, ...extra });
const board = () => ({
  buckets: mock.empty ? { triage: [], today: [], tomorrow: [], later: [], backlog: [] } : {
    triage: [card(812, "Reply to Acme's renewal question", { unread: true, assignee: "open-loops" }), card(815, "Weekly metrics digest looks off", { priority: "high", assignee: "me" })],
    today: [card(790, "Ship the invoices app's export", { assignee: "engineer", working: { agent: "Engineer", since: ago(12), queued: false, said: "Running the export tests" }, crew: [{ agent: "engineer", state: "working", issues: [{ id: "id-791", identifier: "WOR-791", title: "Add CSV export", state: "working" }], since: ago(12) }] }), card(801, "Prep notes for the design review", { carried: 1 }), card(802, "Chase the vendor contract", { assignee: "open-loops", priority: "critical" })],
    tomorrow: [card(770, "Plan the Q1 offsite agenda")],
    later: [card(700, "Try the new calendar agent"), card(705, "Tidy the warehouse schemas")],
    backlog: [card(600, "Someday: voice notes into tasks")],
  },
  brief: null, done: [], recurring: [],
  work: mock.empty ? [] : WORK(), asOf: new Date().toISOString(), incomplete: false, projects: mock.empty ? [] : PROJECTS,
  assignees: [{ key: "me", kind: "me", name: "Me" }, ...roster.map((a) => ({ key: a.key, kind: a.key === "engineer" ? "engineer" : a.key === "researcher" ? "assistant" : "agent", name: a.name, avatar: a.avatar, ...(a.key === "engineer" ? { defaultModel: "openrouter/~deepseek/deepseek-flash-latest", efforts: ["low", "medium", "high"] } : {}) }))],
  labels: mock.empty ? [] : LABELS, prefix: "WOR", timezone: "Asia/Dubai", slackTeams: {}, rollsOn: "Monday", rollsTomorrow: true, agentsActive: 4,
  spend: { day: { spent: 3.42, cap: 50 }, month: { spent: 61.2, cap: 1000 } }, google: null, signIns: [],
});

const chatRows = () => mock.empty ? [] : [
  { identifier: "WOR-820", title: "Can you find a time with Sam next week?", open: true, agent: { key: "aiden", name: "Aiden" }, state: named("WOR-820", STATES.running), updatedAt: ago(1), preview: { text: "Looking at both calendars now.", at: ago(1), from: "agent" }, unread: true },
  { identifier: "WOR-818", title: "Build a small app that tracks invoices", open: true, agent: { key: "aiden", name: "Aiden" }, state: named("WOR-818", CARD), updatedAt: ago(9), preview: { text: "The app is ready; the deploy waits on your approval.", at: ago(9), from: "agent" }, unread: true },
  { identifier: "WOR-815", title: "Weekly metrics digest looks off", open: true, agent: { key: "aiden", name: "Aiden" }, state: named("WOR-815", ASK), updatedAt: ago(40), preview: { text: "Which week should I compare against?", at: ago(40), from: "agent" }, unread: false },
  { identifier: "WOR-811", title: "Summarise yesterday's leadership sync", open: true, agent: { key: "meeting-librarian", name: "Meeting Librarian" }, state: named("WOR-811", STATES.done), updatedAt: ago(180), preview: { text: "Summary posted with 4 action items.", at: ago(180), from: "agent" }, unread: false },
  { identifier: "WOR-806", title: "Why did the health check fail?", open: true, agent: { key: "platform-engineer", name: "Platform Engineer" }, state: named("WOR-806", FAILED), updatedAt: ago(52), preview: { text: "Timed out after 30 minutes.", at: ago(52), from: "agent" }, unread: false },
  { identifier: "WOR-799", title: "Draft a reply to the hiring agency", open: true, agent: { key: "aiden", name: "Aiden" }, state: named("WOR-799", STATES.chatTurn), updatedAt: ago(1500), preview: { text: "Sent.", at: ago(1500), from: "you" }, unread: false },
];

const approval = (id: string, over = {}) => ({ id, identifier: "WOR-818", action: "deploy", target: "invoices", digest: "sha256:9f2c", sentence: "Deploy the invoices app at 4e1a9c2", reads: "The warehouse schema app_invoices", changes: "Starts a new container; the app's door opens to admins", cost: "No spend", details: "Commit 4e1a9c2 on acme-agents/invoices: adds CSV export and a monthly total.", requestedBy: "Engineer", state: "pending", tier: 2, reason: "First deploy of a new app", review: "The diff is small and touches only the app's own repo. Sent to you because it is a first deploy.", decidedBy: null, outcome: null, outcomeText: null, createdAt: ago(9), replaced: false, ...over });
const approvals = () => mock.empty ? [] : [
  approval("k-00000000000000a1"),
  approval("k-00000000000000a2", { identifier: "WOR-806", action: "push", target: "acme-agents/aidenhq-instance", sentence: "Raise the Platform Engineer's run timeout to 45 minutes", changes: "One line in instance.yaml", tier: 2, reason: "Changes an agent's limits", review: null, createdAt: ago(50) }),
  approval("k-00000000000000a3", { identifier: "WOR-790", action: "merge", target: "acme-agents/invoices#14", sentence: "Merge “Add CSV export” into main", tier: 1, state: "approved", decidedBy: "reviewer:gpt-luna", review: "Tests pass, change is scoped to the export.", outcome: "applied", outcomeText: "Merged as 4e1a9c2", createdAt: ago(70) }),
  approval("k-00000000000000a4", { identifier: "WOR-777", action: "send", target: "slack:#general", sentence: "Post the weekly update in #general", tier: 1, state: "rejected", decidedBy: "reviewer:gpt-luna", review: "The draft names a customer that isn't public yet.", createdAt: ago(300) }),
  approval("k-00000000000000a5", { identifier: "WOR-792", action: "push", target: "acme-agents/invoices", sentence: "Push the CSV export fix to a branch", tier: 1, reason: null, review: null, createdAt: ago(2) }),
];

const chatDetail = (ref: string) => {
  const row = chatRows().find((c) => c.identifier === ref) ?? chatRows()[0] ?? { identifier: ref, title: "New chat", open: true, agent: { key: "aiden", name: "Aiden" }, state: null };
  return {
    id: `id-${ref}`, identifier: row.identifier, title: row.title, open: true, agent: row.agent, state: row.state,
    messages: [
      { kind: "owner", id: "m1", text: row.title, at: ago(15) },
      { kind: "reply", id: "m2", agent: row.agent.name, text: "On it. I'll check both calendars and propose **three slots** that avoid your focus blocks.\n\n- Tuesday 10:00\n- Wednesday 14:30\n- Thursday 09:00", at: ago(12) },
      { kind: "notes", id: "m3", agent: row.agent.name, at: ago(10), notes: [{ by: "Aiden", text: "Asked Open Loops whether Sam has a pending thread.", at: ago(10) }] },
      { kind: "owner", id: "m4", text: "Wednesday works best, but keep it to 30 minutes.", at: ago(6) },
      { kind: "reply", id: "m5", agent: row.agent.name, text: "Got it: Wednesday 14:30 for 30 minutes. Which title should the invite carry?", at: ago(2), questions: [{ question: "Invite title", options: ["Sam / sync", "Q1 planning", "Catch-up"] }] },
    ],
    working: row.state?.kind === "working" ? { agent: row.agent.name, since: ago(1), queued: false, said: "Checking Sam's calendar", plan: [{ text: "Read both calendars", state: "done" }, { text: "Pick slots", state: "doing" }, { text: "Send the invite", state: "todo" }] } : null,
    files: [], approvals: ref === "WOR-818" ? [approval("k-00000000000000a1")] : [], handedOut: ref === "WOR-818" ? [{ identifier: "WOR-819", title: "Build the invoices app", agent: "Engineer", state: named("WOR-819", WORKING_CARD), updatedAt: ago(5), working: { agent: "Engineer", since: ago(5), queued: false } }, { identifier: "WOR-821", title: "Design the invoice screens", agent: "UI Designer", state: named("WOR-821", ASK), updatedAt: ago(20), working: null }, { identifier: "WOR-822", title: "Write the export tests", agent: "Engineer", state: named("WOR-822", STATES.blocked), updatedAt: ago(40), working: null }, { identifier: "WOR-823", title: "Seed the demo data", agent: "Engineer", state: named("WOR-823", STATES.done), updatedAt: ago(100), working: null }] : [],
    parent: null, runs: [], asks: [],
  };
};

const kid = (n: number, title: string, agent: string, state: ReturnType<typeof st>, o: Record<string, unknown> = {}) => ({ identifier: `WOR-${n}`, title, agent, model: "deepseek-flash high", state: named(`WOR-${n}`, state), latest: { text: "Working through the export tests.", at: ago(4) }, tokens: 182_000, usd: 0.42, startedAt: ago(90), endedAt: state.kind === "done" ? ago(30) : null, children: [], approvals: [], ...o });
const lineage = (identifier: string) => {
  if (identifier !== "WOR-818" || mock.empty) return { identifier, children: [], total: { tasks: 0, running: 0, needs: 0, failed: 0, tokens: 0, usd: 0, ms: 0 } };
  const children = [kid(819, "Build the invoices app", "Engineer", WORKING_CARD, { children: [kid(824, "Add CSV export", "Engineer", FAILED, { latest: { text: "The export test timed out.", at: ago(8) } })], approvals: [approval("k-00000000000000a1")] }), kid(821, "Design the invoice screens", "UI Designer", ASK), kid(822, "Write the export tests", "Engineer", STATES.blocked), kid(823, "Seed the demo data", "Engineer", STATES.done)];
  return { identifier, children, total: { tasks: 5, running: 1, needs: 2, failed: 1, tokens: 910_000, usd: 2.1, ms: 5_400_000 } };
};

const apps = () => mock.empty ? [] : [
  { name: "invoices", healthy: true, state: "running", sha: "4e1a9c2", deployed_at: now - 3_600_000, deployed_by: "Engineer", auto_deploy: true, repo: "acme-agents/invoices", owner: "Engineer", url: "https://invoices.example.com", stats: { cpu_pct: 2.1, mem_bytes: 120e6, mem_limit_bytes: 512e6 }, deploys: [{ sha: "4e1a9c2", at: now - 3_600_000, by: "Engineer", status: "healthy" }] },
  { name: "roadmap", healthy: true, state: "running", sha: "b81f0d3", deployed_at: now - 86_400_000, deployed_by: "Engineer", repo: "acme-agents/roadmap", url: "https://roadmap.example.com", panel: "Roadmap", stats: { cpu_pct: 0.4, mem_bytes: 80e6, mem_limit_bytes: 512e6 } },
  { name: "hiring", healthy: false, state: "crashed", sha: "c09e1aa", deployed_at: now - 7_200_000, deployed_by: "Engineer", repo: "acme-agents/hiring", incident: { opened_at: ago(30), kind: "crash", detail: "Exited with code 1 three times in five minutes" } },
];

const moduleRow = (name: string, description: string, state: string, over = {}) => ({ name, description, agents: [], requires: [], marketplace: "aidenhq", tier: "official", state, neededBy: [], connections: [], routines: [], apps: [], settings: {}, revision: "a1b2c3d", pinned: null, source: null, setup: null, ...over });
const modules = () => [
  moduleRow("core", "The chief of staff and the pieces every install needs.", "core", { agents: ["aiden"] }),
  moduleRow("open-loops", "Tracks promises and follow-ups across Slack and email.", "on", { agents: ["open-loops"], connections: ["slack"] }),
  moduleRow("engineering", "Engineers that build and fix code in your repos.", "on", { agents: ["engineer", "ui-designer"], connections: ["github"] }),
  moduleRow("apps-platform", "Runs the apps agents build, each in its own sandbox.", "dependency", { neededBy: ["engineering"] }),
  moduleRow("google", "Gmail and Calendar for every agent you grant.", "on", { connections: ["google_workspace"], setup: "google" }),
  moduleRow("meetings", "Notes and action items from every meeting.", "off", { agents: ["meeting-librarian"] }),
];

const settingsData = () => ({
  compiled: true, owner: { name: "Alex" },
  instance: { product: "9c1496b", instance: "acme", lastChangeAt: ago(300), boardTimezone: "Asia/Dubai", node: "v24.11.0" },
  settings: [
    { key: "owner_name", module: "core", value: "Alex", set: true, known: true, switch: false, doc: "What agents call you." },
    { key: "autonomy", module: "core", value: "full", set: false, known: true, default: "full", values: ["full", "reviewed", "manual"], switch: false, doc: "Who decides writes: the AI reviewer, or you." },
    { key: "spend_day_usd", module: "core", value: 50, set: true, known: true, switch: false, doc: "The most the whole install may spend on models in a UTC day." },
    { key: "task_usd", module: "core", value: 20, set: true, known: true, switch: false, doc: "The most one task may spend on models, whichever agents work on it." },
    { key: "spend_month_usd", module: "core", value: 1000, set: true, known: true, switch: false, doc: "The most the whole install may spend on models in a UTC calendar month." },
    { key: "quiet_start", module: "core", value: false, set: true, known: true, switch: true, doc: "Nothing runs on a schedule until you turn it on." },
  ],
  agents: [], choices: { heartbeatHours: [1, 4, 24], models: ["deepseek-flash", "gpt-luna"] }, approvals: { pending: 2 },
  updates: { current: { name: "2026.11.19", product: "9c1496b" }, auto: true, timezone: "Asia/Dubai", checkedAt: ago(60), available: null, error: null, last: { release: "2026.11.19", outcome: "installed", at: ago(1300), by: "auto" } },
});

const connections = () => ({
  compiled: true, sourcesError: false,
  connections: [
    { name: "google_workspace", module: "google", kind: "connection", transport: "http", tools: { read: 14, write: 6 }, grants: [{ agent: "aiden", name: "Aiden", access: "write", tools: 20 }], setup: "google", probe: { ok: true, checkedAt: ago(2) }, signIn: null, google: { accounts: [{ email: "alex@example.com", primary: true, state: "ok", since: ago(5000) }] } },
    { name: "slack", module: "open-loops", kind: "connection", transport: "http", tools: { read: 9, write: 3 }, grants: [{ agent: "open-loops", name: "Open Loops", access: "read", tools: 9 }], setup: null, probe: { ok: true, checkedAt: ago(2) }, signIn: { state: "ok", configured: true, since: ago(9000) } },
    { name: "github", module: "engineering", kind: "connection", transport: "http", tools: { read: 22, write: 11 }, grants: [], setup: null, probe: { ok: false, status: 401, detail: "Token expired", checkedAt: ago(2) }, signIn: { state: "expired", configured: true, since: ago(60) } },
    { name: "jira", module: "engineering", kind: "connection", transport: "http", tools: { read: 7, write: 2 }, grants: [], setup: null, probe: null, signIn: { state: "missing", configured: false, since: ago(60) } },
    { name: "paperclip_tasks", module: "core", kind: "connection", transport: "stdio", tools: { read: 5, write: 5 }, grants: [], setup: null, probe: null, signIn: null },
  ],
  sources: [{ name: "slack", lastOk: ago(3), failing: false, stale: false }, { name: "gmail", lastOk: ago(400), failing: false, stale: true }],
});

const profile = (key: string) => {
  const a = roster.find((r) => r.key === key) ?? roster[0]!;
  return { id: a.id, key: a.key, name: a.name, avatar: a.avatar, title: a.title, state: a.state, stateNote: a.stateNote, model: a.model, effort: "high", reportsTo: a.reportsTo, source: { module: "core", marketplace: "aidenhq", tier: "official", revision: "a1b2c3d" }, schedules: a.schedules };
};
const days = Array.from({ length: 7 }, (_, i) => new Date(now - (6 - i) * 86_400_000).toISOString().slice(0, 10));


const timeline = () => mock.empty ? [] : [
  { id: "r1", outcome: "running", state: "running", startedAt: ago(3), endedAt: null, task: { id: "t1", identifier: "WOR-790", title: "Ship the invoices app's export" }, trigger: "Assigned by Aiden", steps: 14, costUsd: null, error: null, writes: [] },
  { id: "r2", outcome: "done", state: "done", startedAt: ago(40), endedAt: ago(31), task: { id: "t1", identifier: "WOR-790", title: "Ship the invoices app's export" }, trigger: "Your comment", steps: 31, costUsd: 0.42, error: null, writes: [
    { id: "w1", action: "push", tier: 1, state: "ran", decidedBy: "AI reviewer" }, { id: "w2", action: "deploy_app", tier: 2, state: "pending", decidedBy: null }, { id: "w3", action: "send_message", tier: 0, state: "ran", decidedBy: null }] },
  { id: "r3", outcome: "failed", state: "failed", startedAt: ago(200), endedAt: ago(196), task: { id: "t2", identifier: "WOR-806", title: "Why did the health check fail?" }, trigger: "Schedule: Health check", steps: 6, costUsd: 0.03, error: "Tool call failed: the runner refused the push because the branch is behind main.", writes: [{ id: "w4", action: "push", tier: 1, state: "rejected", decidedBy: "AI reviewer" }] },
  { id: "r4", outcome: "stopped", state: "cancelled", startedAt: ago(1700), endedAt: ago(1698), task: { id: "t3", identifier: null, title: null }, trigger: "Schedule: Morning brief", steps: 1, costUsd: 0.004, error: "Stopped by you before it started.", writes: [] },
  { id: "r5", outcome: "failed", state: "timeout", startedAt: ago(1900), endedAt: ago(1780), task: { id: "t4", identifier: "WOR-700", title: "Set up the invoices repo" }, trigger: "Assigned by Aiden", steps: 80, costUsd: 1.9, error: null, writes: [] },
];
const explanation = (id: string) => ({
  id, sentence: "An AI reviewer approved this push.",
  decider: { kind: id === "w2" ? "pending-owner" : "reviewer", words: "The AI reviewer read it and approved.", models: ["openai/gpt-luna-latest"] },
  path: ["Engineer filed the push.", "The kernel put it at Tier 1.", "The AI reviewer approved it.", "The runner pushed the branch."],
  tier: { tier: 1, merit: 2, rule: "product-pr", ruleWords: null, reason: "Touches the export module.", cap: null, panel: false },
  review: { note: "In scope: it adds the CSV export the task asked for. No secrets, no gate changes.", code: "in_scope", codeWords: "In scope: it does what the task asked.", },
  checklist: [{ id: "tests-run", result: "holds" }, { id: "scope", result: "holds" }, { id: "rollback", result: "not reported" }],
  ownerReason: null,
  asked: "Add a CSV export to the invoices app and a monthly total row.\n\nExport respects the current filter.",
  changes: "push fix/invoice-export -> main (3 files)",
  details: "diff --git a/export.ts b/export.ts\n+export const csv = (rows) => rows.join('\\n');",
  outcome: { ok: true, text: "Pushed." },
});

const welcome = () => ({ finished: !mock.welcome, modelReady: true, recoveryKeyWaiting: mock.welcome, wizard: ["google", "telegram"] });
/** The Slack flow in the state ?slack= names (modules/slack/module.yaml, as GET /api/setup-flows serves it). */
const slackFlow = () => {
  const k = mock.slack;
  const signedIn = k !== "none";
  const bot = k === "full" || k === "old";
  return {
    module: "slack", order: 30, title: "Slack", label: "Read Slack as you", wizard: true,
    why: "Agents search and read the Slack you can see, save drafts for you, and (if you allow it) post as you, each post reviewed first.",
    effort: "about 1 minute", admin: "a Slack workspace admin may need to approve the app",
    capabilities: ["search and read the Slack you can see", "drafts, and reviewed posts as you when you allow it"],
    steps: "On Connect you pick which permissions to grant: the reads are pre-selected. To let agents act as you too, add the **User Token Scopes** you want under **OAuth & Permissions** (`chat:write`, `reactions:write`) and Connect again.",
    secrets: ["slack_client_id"], fields: [{ secret: "slack_client_id", label: "Slack app Client ID", pattern: "^[0-9]{6,20}\\.[0-9]{6,20}$" }], signin: "slack",
    app: {
      label: "App Configuration Token", pattern: "^xoxe\\.xoxp-[A-Za-z0-9-]{20,400}$", console_url: "https://api.slack.com/apps",
      help: "Open [Your Apps](https://api.slack.com/apps) in Slack. Under **Your App Configuration Tokens**, press **Generate Token**, pick your workspace and copy the **Access Token** (it starts xoxe.xoxp-). It lasts 12 hours; AidenHQ uses it once to make your app and keeps nothing.",
      status: k === "full" ? { app_id: "A0ACME0001", part: "advanced", current: true, url: "https://api.slack.com/apps/A0ACME0001" } : k === "signin" ? { app_id: "A0ACME0001", part: "basic", current: true, url: "https://api.slack.com/apps/A0ACME0001" } : { app_id: null, part: null, current: false, url: null },
      org_secrets: k === "org" ? ["slack_client_id"] : [],
    },
    present: { slack_client_id: k !== "none" && k !== "org", slack_live_bot_token: bot, slack_live_app_token: bot },
    signedIn, scopes: true, paired: bot, done: signedIn, dismissed: false,
    advanced: {
      title: "Slack with Aiden's bot", why: "Everything on the left, plus a bot of your own app's that you DM, and live Slack events. The bot is always your own app's.",
      effort: "about 5 minutes", admin: "a Slack workspace admin may need to approve the app",
      capabilities: ["DM Aiden; approvals and alerts as Slack messages", "Slack triage and 📌 tasks (Intake)", "live events for the src_slack warehouse", "/aiden assign-channel: a channel's @mentions become an agent's tasks"],
      steps: "1. [Open your app's Install page]({app_url}/install-on-team), press **Install to Workspace** (or **Reinstall**), then **Allow**. A workspace admin may need to approve it.\n2. [Open OAuth & Permissions]({app_url}/oauth), copy the **Bot User OAuth Token** (it starts xoxb-) and paste it here.\n3. [Open Basic Information]({app_url}/general), scroll to **App-Level Tokens**, press **Generate Token and Scopes**, add the scope `connections:write`, press **Generate** and paste the token (it starts xapp-) here. Slack has no API that makes this token, so it is the one copy by hand.",
      secrets: ["slack_live_bot_token", "slack_live_app_token"],
      fields: [{ secret: "slack_live_bot_token", label: "Slack bot token", pattern: "^xoxb-[A-Za-z0-9-]{20,300}$", help: "OAuth & Permissions, Bot User OAuth Token (starts xoxb-)." }, { secret: "slack_live_app_token", label: "Slack app-level token", pattern: "^xapp-[A-Za-z0-9-]{20,300}$", help: "Basic Information, App-Level Tokens, scope connections:write (starts xapp-)." }],
      pair_url: "http://slack-live:8089/pair", done: bot,
    },
  };
};
const googleFlow = () => ({
  module: "google", order: 40, title: "Google", why: "Aiden reads your calendar, Drive and Gmail (read-only) to brief you and follow up.", effort: "about 5 minutes, in the Google Cloud console",
  secrets: ["google_client_id", "google_client_secret"], connect_url: "/google/connect",
  console_scopes: ["https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.readonly"],
  steps: "AidenHQ needs **one Google app per Workspace**: the app is what Google shows when you approve access. Pick the way that fits you; only its steps show.",
  ways: [
    { id: "organisation", title: "Use your organisation's app", detail: "Your organisation already runs one. Pick it from the list and there is nothing to make.", effort: "about a minute", organisation: true },
    { id: "colleague", title: "A colleague already made one", detail: "Ask them for the Client ID and Client secret, then enter them here.", effort: "about a minute", paste: true, steps: "1. Ask your colleague for the app's **Client ID** and **Client secret** (a **Desktop app** client).\n2. Enter both under **Paste the details**, then press **Connect**." },
    { id: "create", title: "Create one", detail: "A Google Workspace address. About 5 minutes in the Google Cloud console.", paste: true, steps: "1. [Create a project](https://console.cloud.google.com/projectcreate) named `AidenHQ`.\n2. On [Data access](https://console.cloud.google.com/auth/scopes) add these scopes:\n   {scopes}\n3. Create a **Desktop app** client and enter its ID and secret under **Paste the details**." },
    { id: "personal", title: "Personal Gmail", detail: "A gmail.com address. One extra step so sign-in does not expire every 7 days.", paste: true, domains: ["gmail.com", "googlemail.com"], steps: "1. As Create one, with audience **External**.\n2. On [Audience](https://console.cloud.google.com/auth/audience) press **Publish app**.\n3. Google then shows **Google hasn't verified this app**: press **Advanced**, then **Go to AidenHQ (unsafe)**." },
  ],
  fields: [
    { secret: "google_client_id", label: "Google client ID", pattern: "^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$", help: "Ends in .apps.googleusercontent.com." },
    { secret: "google_client_secret", label: "Google client secret", pattern: "^GOCSPX-[A-Za-z0-9_-]{20,60}$", help: "Starts with GOCSPX-." },
  ],
});
const flows = () => ({
  board_url: "https://board.example.com", named: true,
  flows: [
    { ...googleFlow(), present: { google_client_id: false, google_client_secret: false }, signedIn: false, paired: false, done: false, dismissed: false },
    slackFlow(),
    { module: "telegram", order: 2, title: "Talk to Aiden on Telegram", why: "Reach Aiden from your phone and approve with one tap.", effort: "3 minutes", wizard: true, steps: "1. Open @BotFather and create a bot.\n2. Paste its token below.", fields: [{ secret: "telegram_bot_token", label: "Bot token", pattern: "^\\d+:[\\w-]+$" }], present: { telegram_bot_token: false }, signedIn: false, paired: false, done: false, dismissed: false },
  ],
});

// The Reviews page: a watched repo, a PR run, two whole-repo batches, and the catalog a repo review offers.
const REVIEW_COMBO = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium" };
const reviewRuns = () => [{ id: "cr-000000000001", repo: "acme/payments", number: 42, head: "a".repeat(40), engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium", kind: "auto", status: "done", why: null, cost_usd: 0.4, tokens_in: 12000, tokens_out: 3000, duration_ms: 90000, important: 1, nit: 2, pre_existing: 0, started: ago(30), ended: ago(28), full: false, incremental_from: null, posted: true, title: "Retry failed charges" }];
const reviewBatches = () => [
  { id: "b-000000000001", repo: "acme/payments", sha: "4e1a9c2".padEnd(40, "0"), sha7: "4e1a9c2", verdict: "concerns", cost_usd: 6.8, status: "done", started: ago(300), ended: ago(260), option_names: ["Codex code review", "Claude Code review", "Trail of Bits security audit", "React performance (Vercel)"] },
  { id: "b-000000000002", repo: "acme/web", sha: "9b0c7de".padEnd(40, "0"), sha7: "9b0c7de", verdict: null, cost_usd: 1.2, status: "running", started: ago(4), ended: null, option_names: ["Codex code review", "Unused code and dependencies (Knip)"] },
];
const CATALOG_ROWS: [string, string, string, string, string, boolean, boolean, string, string, string | null][] = [
  ["cor.codex-native", "Codex code review", "OpenAI's Codex reads the whole repo and reports logic errors and broken edge cases.", "correctness", "engine", true, false, "high", "openai/codex", null],
  ["cor.claude-review", "Claude Code review", "Anthropic's built-in code review: bugs, regressions and risky changes.", "correctness", "engine", true, false, "high", "anthropics/claude-code", null],
  ["cor.codegenie", "Codegenie review", "Codegenie's reviewer for logic errors and missed cases.", "correctness", "engine", false, false, "high", "0xPolygon/codegenie", "Runs on pull requests only"],
  ["cor.ce-code-review", "Compound Engineering review", "A multi-angle review that checks correctness, tests and design together.", "correctness", "skill", false, false, "high", "EveryInc/compound-engineering-plugin", null],
  ["cor.pr-review-toolkit", "Silent failures and test gaps", "Finds swallowed errors and code paths no test covers.", "correctness", "skill", false, false, "low", "anthropics/claude-plugins-official", "Runs on pull requests only"],
  ["cor.variant-analysis", "Variant analysis (Trail of Bits)", "Takes known bug patterns and hunts for the same flaw elsewhere in the code.", "correctness", "skill", false, false, "high", "trailofbits/skills", null],
  ["sec.govulncheck", "Go vulnerabilities (govulncheck)", "Reports known vulnerabilities in Go dependencies that your code actually calls.", "security", "tool", true, false, "free", "golang/vuln", "Needs Go (go.mod)"],
  ["sec.deepsec", "Deep security scan (deepsec)", "Vercel's scanner sets itself up on the repo, then traces risky flows and revalidates each finding.", "security", "engine", false, false, "high", "vercel-labs/deepsec", null],
  ["sec.cloudflare-audit", "Cloudflare security audit", "Cloudflare's security audit skill: auth, input handling and platform misconfigurations.", "security", "skill", false, false, "high", "cloudflare/security-audit-skill", null],
  ["sec.codex-security", "Codex Security", "OpenAI's security reviewer for vulnerabilities in application code.", "security", "engine", false, false, "high", "openai/codex-security", "No Codex Security engine is built into the review box yet"],
  ["sec.claude-security-review", "Claude security review", "Anthropic's security review of a change: injection, auth and data exposure.", "security", "engine", false, false, "high", "anthropics/claude-code", "Runs on pull requests only"],
  ["sec.tob-audit", "Trail of Bits security audit", "A security audit that follows how data and trust cross the code.", "security", "skill", false, false, "high", "trailofbits/skills", null],
  ["sec.solidity-auditor", "Solidity audit", "Reviews smart contracts for reentrancy, access control and arithmetic flaws.", "security", "skill", true, false, "high", "pashov/skills", "Needs Solidity contracts (.sol)"],
  ["maint.vulture", "Dead Python code (Vulture)", "Finds unused functions, classes and variables in Python.", "maintainability", "tool", true, false, "free", "jendrikseipp/vulture", "Needs Python files"],
  ["maint.ruff-unused", "Unused Python imports and variables (Ruff)", "Flags imports and variables nothing uses.", "maintainability", "tool", true, false, "free", "astral-sh/ruff", "Needs Python files"],
  ["maint.improve-architecture", "Architecture improvements", "Suggests refactors that deepen modules and untangle structure.", "maintainability", "skill", false, false, "high", "mattpocock/skills", null],
  ["maint.code-modernization", "Code modernization", "Finds outdated patterns and APIs and suggests current ones.", "maintainability", "skill", false, false, "high", "anthropics/claude-plugins-official", null],
  ["maint.scc", "Code size and complexity (scc)", "A metrics tool, not a bug finder: reports only the ten most complex files (50+ branch points) as nits, so a simple codebase gets none.", "maintainability", "tool", false, false, "free", "boyter/scc", null],
  ["maint.comment-analyzer", "Comment accuracy", "Checks that comments still match the code they describe.", "maintainability", "skill", false, false, "low", "anthropics/claude-plugins-official", "Runs on pull requests only"],
  ["perf.ruff-perf", "Python performance lint (Ruff)", "Flags Python patterns that are slower than they need to be.", "performance", "tool", true, false, "free", "astral-sh/ruff", "Needs Python files"],
  ["perf.squawk", "Risky SQL migrations (Squawk)", "Finds migrations that lock tables or break running queries.", "performance", "tool", true, false, "free", "sbdchd/squawk", "Needs SQL migrations"],
  ["perf.supabase-postgres", "Postgres performance (Supabase)", "Reviews queries, indexes and schema for Postgres performance.", "performance", "skill", false, false, "high", "supabase/agent-skills", "Needs SQL or Supabase files"],
  ["perf.react-best-practices", "React performance (Vercel)", "Finds slow renders, waterfalls and oversized bundles in React code.", "performance", "skill", false, false, "high", "vercel-labs/agent-skills", null],
  ["perf.django", "Django performance (Sentry)", "Finds N+1 queries and slow ORM use in Django projects.", "performance", "skill", false, false, "high", "getsentry/skills", "Needs a Django project (manage.py)"],
  ["perf.react-native", "React Native performance", "Finds slow lists, re-renders and bridge overhead in React Native apps.", "performance", "skill", false, false, "high", "callstackincubator/agent-skills", "Needs a React Native project"],
  ["perf.dotnet", ".NET performance", "Finds allocation and async problems in .NET code.", "performance", "skill", false, false, "high", "dotnet/skills", "Needs .NET projects (.csproj)"],
];
// What past repo reviews cost, per option (the service reads it from its runs).
const PAST: Record<string, { model: string; effort: string; n: number; usd: number }[]> = {
  "sec.cloudflare-audit": [{ model: "anthropic/claude-haiku-5.5", effort: "medium", n: 2, usd: 0.62 }],
  "cor.codex-native": [{ model: "~deepseek/deepseek-flash-latest", effort: "medium", n: 3, usd: 0.21 }],
  "sec.tob-audit": [{ model: "anthropic/claude-sonnet-5.5", effort: "high", n: 1, usd: 4.8 }],
};
const catalog = () => ({ sha: "6018f7c2f0b7d".padEnd(40, "0"), options: CATALOG_ROWS.map(([id, name, description, lens, kind, recommended, runs_code, cost, repo, unavailable]) => ({ id, name, description, lens, kind, recommended: recommended && !unavailable, runs_code, cost, source: { repo, version: "1.0.0", licence: "MIT" }, ...(PAST[id] ? { past: PAST[id] } : {}), ...(unavailable ? { unavailable } : {}) })) });
const REPORT = "# Repo review: acme/payments\n\n**Verdict:** concerns, at `4e1a9c2`\n\n## Security\n\n- **Important** `src/billing/charge.ts:88`: a retried charge can post twice.\n  - Evidence: the idempotency key is written after the provider call.\n  - Found by: sec.quick-scan\n\n## Coverage\n\n| Option | Result |\n| --- | --- |\n| sec.quick-scan | done |\n| maint.knip | done |\n\nCost $6.80.";

function route(method: string, url: URL): [number, unknown] {
  const one = /^\/api\/approvals\/(k-[0-9a-f]{16})$/.exec(url.pathname)?.[1];
  if (one && method === "GET") { const a = approvals().find((x) => x.id === one); return a ? [200, { approval: a }] : [404, { error: "no such card" }]; }
  const p = url.pathname;
  if (method === "POST" && p === "/api/reviews") return [200, { batch: "b-000000000003" }];
  if (method !== "GET") return [200, { ok: true, identifier: "WOR-900", id: "id-900" }];
  if (p.startsWith("/api/models/")) return [200, { default: "openrouter/~deepseek/deepseek-flash-latest", models: ["openrouter/~deepseek/deepseek-flash-latest", "openrouter/~openai/gpt-luna-latest", "openrouter/z-ai/glm-5.3"], efforts: ["low", "medium", "high"] }];
  const m = (re: RegExp) => re.exec(p);
  switch (p) {
    case "/api/reviews/setup": return [200, { module: true, github: { configured: true, connected: true, state: "ok" }, config: { repos: [{ repo: "acme/payments", on_open: [REVIEW_COMBO], on_push: [{ ...REVIEW_COMBO, effort: "low" }] }], day_usd: 200 }, problems: [] }];
    case "/api/reviews": return [200, { runs: reviewRuns(), batches: reviewBatches() }];
    case "/api/reviews/repos": return [200, { repos: [{ repo: "acme/payments", on_open: [REVIEW_COMBO], on_push: [], day_usd: 200, day_spent_usd: 3.2 }], day_usd: 200, day_spent_usd: 3.2 }];
    case "/api/reviews/engines": return [200, { engines: { codex: { label: "Codex", accepts: { tools: true }, efforts: ["low", "medium", "high"], models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "deepseek/deepseek-v4-pro", "z-ai/glm-5.3"], run_usd: 5 }, "claude-code": { label: "Claude Code", accepts: { provider: "anthropic" }, efforts: ["low", "medium", "high"], models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5"], run_usd: 5 }, codegenie: { label: "Codegenie", accepts: { tools: true }, efforts: ["low", "medium"], models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest"], run_usd: 5 }, "codex-native": { label: "Codex native", accepts: { tools: true }, efforts: ["low", "medium"], models: ["openai/gpt-6.2-sol", "~openai/gpt-sol-latest"], run_usd: 5 } } }];
    case "/api/model-catalog": return [200, { models: MODEL_CATALOG }];
    case "/api/reviews/available": return [200, { repos: [{ repo: "acme/payments", private: true }, { repo: "acme/web", private: true }, { repo: "acme/docs", private: false }] }];
    case "/api/reviews/catalog": return [200, catalog()];
    case "/api/session": return [200, { mode: "lan", account: { id: "u1", email: mock.email, name: "Alex", role: "admin", owner: true }, signInConnect: true, adminUrl: "http://127.0.0.1:3120" }];
    case "/api/board": return [200, board()];
    case "/api/search": return search(url.searchParams.get("q") ?? "", url.searchParams.get("after"));
    case "/api/welcome": return [200, welcome()];
    case "/api/organisations": return [200, mock.slack === "org" ? { organisations: [{ id: "acme", name: "Acme", domains: ["acme.example"], connections: ["slack"] }], suggested: "acme", chosen: "acme", applied: { slack: "acme" } } : mock.org ? { organisations: [{ id: "example", name: "Example Inc", domains: ["example.com"], connections: ["google", "github"] }], suggested: mock.email.endsWith("@example.com") ? "example" : null, chosen: null, applied: {} } : { organisations: [], suggested: null, chosen: null, applied: {} }];
    case "/api/setup-flows": return [200, flows()];
    case "/api/chats": return [200, { chats: chatRows(), agents: [{ key: "aiden", name: "Aiden", front: true }, ...roster.slice(1).map((a) => ({ key: a.key, name: a.name }))] }];
    case "/api/lane": return [200, { agents: [] }];
    case "/api/needs-you": return [200, mock.empty ? { counts: { needs_you: 0, failed: 0, unexplained_idle: 0 }, approvals: 0, items: [] } : { counts: { needs_you: 4, failed: 1, unexplained_idle: 3 }, approvals: 2, items: [
      { identifier: "WOR-801", title: "Brief decisions", agent: "Aiden", state: named("WOR-801", ASK) },
      { identifier: "WOR-790", title: "Fix the sbom job", agent: "Engineer", state: named("WOR-790", { ...WORKING_CARD, refLabel: "approve the push to main" }) },
      { identifier: "WOR-795", title: "A task handed back to you", agent: "Engineer", state: named("WOR-795", STATES.handback) },
      { identifier: "WOR-802", title: "Slack ingest", agent: "Open Loops", state: named("WOR-802", FAILED) },
      { identifier: "WOR-705", title: "Primer lint", agent: "Engineer", state: named("WOR-705", UNKNOWN) },
      { identifier: "WOR-812", title: "Reply to Acme's renewal question", agent: "Open Loops", state: named("WOR-812", STATES.orphaned) },
      { identifier: "WOR-650", title: "An old task whose history expired", agent: "Engineer", state: named("WOR-650", EXPIRED) },
    ] }];
    case "/api/approvals": return [200, { approvals: approvals() }];

    case "/api/agents/roster": return [200, { roster: mock.empty ? roster.slice(0, 1) : roster }];
    case "/api/agents": return [200, { sessions: [{ id: "s1", agent: "Engineer", agentId: "a3", state: "working", startedAt: ago(12), said: "Running the export tests", run: { identifier: "WOR-790", title: "Ship the invoices app's export" }, tasks: [] }], finished: [], roster }];
    case "/api/apps": return [200, { apps: apps() }];
    case "/api/app-admins": return [200, { apps: [] }];
    case "/api/modules": return [200, { modules: modules(), advisories: [] }];
    case "/api/modules/browse": return [200, { modules: [{ name: "hiring", description: "Screens candidates and schedules interviews.", marketplace: "aidenhq", tier: "official", adds: ["agent", "app"], installed: false }] }];
    case "/api/marketplaces": return [200, { marketplaces: [{ name: "aidenhq", source: "github:aidenhq/modules", sha: "a1b2c3d", modules: 14, newer: false }] }];
    case "/api/settings": return [200, settingsData()];
    case "/api/settings/changes": return [200, { changes: [] }];
    case "/api/settings/connections": return [200, connections()];
    case "/api/accounts": return [200, { accounts: [{ id: "u1", email: "alex@example.com", name: "Alex", role: "admin", owner: true, twoFactorEnabled: true, disabled: false, lockedUntil: null, createdAt: ago(40000) }], me: "u1" }];
    case "/api/accounts/sessions": return [200, { sessions: [{ id: "s1", userAgent: "Safari on macOS", ipAddress: "192.0.2.10", createdAt: ago(2000), updatedAt: ago(1), current: true }] }];
    case "/api/settled": return [200, { settled: [] }];
    case "/api/costs/features": return [200, { features: [], unattributed: { usd: 0, calls: 0 } }];
  }
  let x: RegExpExecArray | null;
  if (m(/^\/api\/reviews\/report\/[\w-]+$/)) return [200, { markdown: REPORT }];
  if ((x = m(/^\/api\/chats\/([^/]+)$/))) return [200, chatDetail(decodeURIComponent(x[1]!))];
  if ((x = m(/^\/api\/issues\/([^/]+)\/feature-cost$/))) return [200, { cost: null }];
  if ((x = m(/^\/api\/issues\/([^/]+)\/lineage$/))) return [200, lineage(decodeURIComponent(x[1]!))];
  if ((x = m(/^\/api\/issues\/([^/]+)$/))) {
    const ref = decodeURIComponent(x![1]!);
    // A crew part of WOR-790: the Engineer's issue, opened from that task's agent tab.
    if (ref === "WOR-791") return [200, { ...card(791, "Add CSV export"), parent: { identifier: "WOR-790", title: "Ship the invoices app's export" }, assignee: "engineer", editable: true, labelIds: [], replyTarget: "The Engineer reads replies here and continues the coding job.", scheduled: null, recurring: null, comments: [], files: [], runs: [], crew: [] }];
    const c = Object.values(board().buckets).flat().find((k) => k.identifier === ref || k.id === ref) ?? card(790, "Ship the invoices app's export");
    const crew = (c as { crew?: { agent: string }[] }).crew ?? [];
    const onTask = board().assignees.find((a) => a.key === crew[0]?.agent);
    const replyTarget = onTask ? (onTask.kind === "engineer" ? "The Engineer reads replies here and continues the coding job." : `${onTask.name} reads replies here.`) : "No agent is assigned; this message stays on the task. @name brings an agent in.";
    return [200, { ...c, working: (c as { working?: unknown }).working ?? null, description: "Add a **CSV export** to the invoices app and a monthly total row.\n\n- Export respects the current filter\n- Totals in the account currency", bucket: "today", editable: true, labelIds: [], replyTarget, scheduled: null, recurring: null, comments: [{ id: "k1", body: "Started on the export; tests next.", author: { kind: "agent", name: "Engineer" }, createdAt: ago(20) }], files: [], parent: null, runs: [], crew }];
  }
  if ((x = m(/^\/api\/models\/([^/]+)$/))) return [200, { default: "deepseek-flash", models: ["deepseek-flash", "gpt-luna"], efforts: ["medium", "high"] }];
  if ((x = m(/^\/api\/agents\/by-key\/([^/]+)\/timeline$/))) return [200, { entries: timeline() }];
  if ((x = m(/^\/api\/agents\/by-key\/([^/]+)\/handbook$/))) return [200, { kind: "module", main: { text: "You run the invoices app for the owner.", source: "module", module: "invoices", revision: "4e1a9c2" }, rules: "Answer in short paragraphs.", compiled: "You run the invoices app for the owner.\n\n## What you've learned\n\n(memory, filled when a run starts)", fork: null }];
  if ((x = m(/^\/api\/agents\/by-key\/([^/]+)\/handbook\/history$/))) return [200, { rows: [] }];
  if ((x = m(/^\/api\/agents\/by-key\/([^/]+)\/memory$/))) return [200, mock.empty ? { facts: [], updated: null } : { updated: ago(95), facts: [
    { date: "2026-11-18", src: "WOR-790", fact: "The invoices app's export runs from the reports page; the owner checks totals there first." },
    { date: "2026-11-20", src: "https://example.com/acme/invoices/pull/42", fact: "CI on the invoices repo takes about 6 minutes; the flaky date test passes on a re-run." },
    { date: "2026-11-22", src: "WOR-806", fact: "The owner prefers totals in the account currency, rounded to whole units." },
  ] }];
  if ((x = m(/^\/api\/approvals\/([^/]+)\/explain$/))) return [200, { explanation: explanation(decodeURIComponent(x[1]!)) }];
  if ((x = m(/^\/api\/runs\/([^/]+)$/))) return [200, { id: x[1]!, agent: "Engineer", engine: "codex", status: "done", error: null, startedAt: ago(40), finishedAt: ago(31), durationMs: 540000, issue: null, rev: null, tokens: null, plan: [], ledger: { rows: [], usd: null }, timeline: [{ at: ago(40), kind: "step", text: "Read the task and the invoices app.", ok: true }, { at: ago(38), kind: "step", text: "Ran the export tests.", ok: true }, { at: ago(33), kind: "error", text: "The linter failed on export.ts; fixed and re-ran.", ok: false }] }];
  if ((x = m(/^\/api\/agents\/by-key\/([^/]+)$/))) return [200, { profile: profile(x[1]!) }];
  if ((x = m(/^\/api\/agents\/by-key\/([^/]+)\/tasks$/))) {
    const rows = [{ identifier: "WOR-790", title: "Ship the invoices app's export", state: named("WOR-790", STATES.running), updatedAt: ago(12), from: "WOR-818" }, { identifier: "WOR-806", title: "Why did the health check fail?", state: named("WOR-806", FAILED), updatedAt: ago(52), from: null }];
    return url.searchParams.get("view") === "history" ? [200, { rows: [{ identifier: "WOR-700", title: "Set up the invoices repo", state: named("WOR-700", STATES.done), updatedAt: ago(3000), from: null }, { identifier: "WOR-698", title: "A task you stopped", state: named("WOR-698", STATES.stopped), updatedAt: ago(4000), from: null }], next: null }] : [200, { needs: [rows[1]], ongoing: [rows[0], { identifier: "WOR-831", title: "Re-run the nightly import", state: named("WOR-831", STATES.held), updatedAt: ago(6), from: null }, { identifier: "WOR-832", title: "Merge the export change", state: named("WOR-832", STATES.review), updatedAt: ago(4), from: "WOR-818" }, { identifier: "WOR-834", title: "Wait for CI on the export PR", state: named("WOR-834", STATES.moduleWait), updatedAt: ago(50), from: null }, { identifier: "WOR-835", title: "Wait for the design review", state: named("WOR-835", STATES.stalled), updatedAt: ago(400), from: null }, { identifier: "WOR-833", title: "Wait for the design answer", state: named("WOR-833", STATES.delegator), updatedAt: ago(33), from: "WOR-818" }] }];
  }
  if ((x = m(/^\/api\/agents\/([^/]+)\/scorecard$/))) return [200, { done: { count: 14, prior: 9, tasks: [] }, reopen: { graded: 12, reopened: 1 }, approvals: { filed: 6, rejected: 1, priorRejected: 2 }, runsFailed: 1, cost: { usd: 4.18, prior: 5.02, perDone: 0.3, billed: true }, daily: days.map((day, i) => ({ day, done: [1, 3, 2, 0, 4, 2, 2][i], costUsd: [0.4, 0.9, 0.6, 0.1, 1.1, 0.5, 0.58][i] })) }];
  if ((x = m(/^\/api\/modules\/([^/]+)$/))) {
    const mod = modules().find((r) => r.name === x![1]) ?? modules()[0]!;
    return [200, { module: mod, agents: mod.agents.map(profile), ongoing: [], routines: [], authority: { connections: mod.connections, writes: [{ kind: "push", tier: 1 }], secrets: [], prompts: [], readme: `# ${mod.name}\n\n${mod.description}` }, neededBy: mod.neededBy, requires: mod.requires }];
  }
  return [404, { error: `mock: no fixture for ${p}` }];
}

createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/__mock") {
    for (const k of ["welcome", "empty", "org"] as const) if (url.searchParams.has(k)) mock[k] = url.searchParams.get(k) === "1";
    if (url.searchParams.has("email")) mock.email = url.searchParams.get("email") ?? mock.email;
    if (url.searchParams.has("slow")) mock.slow = Number(url.searchParams.get("slow"));
    if (url.searchParams.has("search")) mock.search = url.searchParams.get("search") ?? "ok";
    if (url.searchParams.has("slack")) mock.slack = url.searchParams.get("slack") ?? "none";
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mock));
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("event: ping\ndata: {}\n\n");
    const t = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 20_000);
    return req.on("close", () => clearInterval(t));
  }
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    const [status, body] = viewRoute(req.method!, url, text ? JSON.parse(text) : {}) ?? route(req.method!, url);
    setTimeout(() => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)), mock.slow);
  });
}).listen(port, "127.0.0.1", () => console.log(`board mock API on :${port}`));
