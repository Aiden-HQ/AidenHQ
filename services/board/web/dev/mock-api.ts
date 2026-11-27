// A fixture-backed stand-in for the board's API, for working on the web UI without a kernel or Paperclip:
//   node web/dev/mock-api.ts & npm run dev:web     (vite proxies /api to :3120)
// Neutral sample data only. Writes answer ok and change nothing (an answer to WOR-821 is refused 409, the "already answered" case). GET /__mock?welcome=1|0 starts or ends onboarding
// (a fresh install: only Aiden on the team; hiring and onboarding's writes are kept in memory, a module change goes live in 5 s, a trial finds 4 tasks in 3 s,
// none with ?empty=1); ?connected=1 marks every setup flow done; ?key=1 shows the recovery key screen first;
// GET /__mock?empty=1 empties every list (empty states, Home's fresh install); ?nocal=1 drops Home's calendar block; ?quiet=1 is Home after the owner has looked (nothing needs him, nothing new); ?slow=<ms> delays every answer (loading states); ?search=keyword|down
// answers task search with keyword hits only, or fails it (its degraded notes). ?email=<address> signs the mock owner in as it;
// ?org=1 lists an organisation with its own Google app. The Google flow is a short sample of modules/google/module.yaml's `ways`. ?slack=none|signin|org|full|old sets the
// Slack setup page's state (nothing yet, sign-in only, an organisation's sign-in, sign-in and bot, a bot app that predates the manifest).
// ?sessions=full|fresh|off|error sets the Sessions page (live and ended ones, a fresh install's empty list, the module off, the kernel down);
// ?term=up|down|flaky sets whether a session's terminal and web view answer; ?slowSessions=<ms> delays only the Sessions list.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { FRAME_CSP } from "../../src/module-views.ts";

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
] as [string, string, number, number, number, number, number, number][]).map(([id, name, d, context, i, o, tools, reasoning]) => ({ id, name, provider: id.replace(/^~/, "").split("/")[0], created: Math.floor(now / 1000) - d * 86400, context, in: i, cached_in: null, out: o, tools: !!tools, reasoning: !!reasoning }));
const mock = { slowSessions: 0, sessions: "full", term: "up", welcome: false, empty: false, slow: 0, search: "ok", email: "alex@example.com", org: false, slack: "none", connected: false, key: false };

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
  stalled: st("waiting", "module_wait", { since: ago(400), ref: "code_review", lane: "blocked", attention: [A("agent", "stalled_wait", "code_review")] }),
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
// A teammate's block as the roster sends it (activity.ts teammateOf); its kit spec as in its module's AGENTS.md.
const kit = (hair: string, accessory: string, body: string, n: number, hairColor = n) => ({ kit: { hair, accessory, body, skin: n, hair_color: hairColor, palette: n } });
const mate = (job: string, sample: string, face: unknown, staff: string[] = [], controls: string[] = []) => ({ job, sample, staff, controls, face });
const idle = { running: 0, queued: 0, workingSince: null, schedules: [] as { title: string; paused: boolean; nextRunAt: string | null }[], lastRunAt: ago(90), lastRunStatus: "succeeded" };
const roster = [
  { id: "a1", key: "chief-of-staff", name: "Aiden", title: "Chief of staff", system: false, department: OPS, teammate: mate("Chief of staff", "Four things need you. The rest is handled.", kit("short", "none", "tie", 0), ["inbox-agent"], ["chief-of-staff", "owner-channel"]), model: "deepseek-flash", reportsTo: null, state: "working", running: 1, queued: 0, workingSince: ago(3), schedules: [{ title: "Morning brief", paused: false, nextRunAt: ahead(600) }], lastRunAt: ago(3), lastRunStatus: "succeeded" },
  { id: "a2", key: "open-loops", name: "Tess", title: "Follow-ups and promises", system: false, department: OPS, teammate: mate("Follow-up chaser", "Jonas Weber still owes you the signed contract (5 days). Chaser drafted for you to send.", kit("long", "headset", "none", 1)), model: "deepseek-flash", reportsTo: "a1", state: "idle", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Sweep", paused: false, nextRunAt: ahead(25) }], lastRunAt: ago(35), lastRunStatus: "succeeded" },
  { id: "a7", key: "meetings", name: "Nora", title: "Notes from every meeting", system: false, department: DESK, teammate: mate("Meeting notes", "Leadership sync: 4 actions, 2 are yours, due Friday.", kit("long", "pencil", "notepad", 2)), model: "deepseek-flash", reportsTo: "a1", state: "working", running: 1, queued: 0, workingSince: null, schedules: [{ title: "After meetings", paused: false, nextRunAt: ahead(95) }], lastRunAt: ago(130), lastRunStatus: "succeeded" },
  { id: "a10", key: "reviewer-manager", name: "Max", title: "Reviews pull requests", system: false, department: ENG, teammate: mate("PR reviewer", "“review only PRs from people outside the team”, “why is #821 slow?”", kit("spiky", "glasses", "none", 3), ["ai-reviewer"], ["code-review"]), model: "deepseek-flash", reportsTo: "a1", state: "working", ...idle, running: 1, workingSince: ago(6), stateNote: "Reviewing PR #821 in aidenhq-distro" },
  { id: "a11", key: "ship", name: "Sam", title: "How your pull requests ship", system: false, department: ENG, teammate: mate("Release manager", "Invoices export v2 merged at 06:10.", kit("short", "cap", "none", 4), [], ["ship"]), model: "deepseek-flash", reportsTo: "a1", state: "idle", ...idle },
  { id: "a12", key: "maintainer", name: "Mia", title: "Keeps your repos tidy", system: false, department: ENG, teammate: mate("Repo maintainer", "3 bugs triaged, 1 fix merged this week.", kit("bun", "none", "badge", 5)), model: "deepseek-flash", reportsTo: "a1", state: "idle", ...idle },
  { id: "a13", key: "app-maintainer", name: "Iris", title: "Builds and runs your apps", system: false, department: ENG, teammate: mate("App builder", "Hiring pipeline board, fed by recruiter emails.", kit("curly", "earrings", "none", 6), ["engineer", "ui-designer"], ["apps-platform"]), model: "deepseek-flash", reportsTo: "a1", state: "queued", ...idle, queued: 1 },
  { id: "a14", key: "architect", name: "Archie", title: "Designs new agents", system: false, department: OPS, teammate: mate("Agent Architect", "Board prep: a one-page brief the day before.", kit("short", "hard-hat", "none", 7)), model: "deepseek-flash", reportsTo: "a1", state: "idle", ...idle },
  { id: "a15", key: "security-watch", name: "Vik", title: "Watches for vulnerabilities", system: false, department: ENG, teammate: mate("Security", "1 high CVE in an image you run. Fix PR ready.", kit("short", "headband", "shield", 8, 0)), model: "deepseek-flash", reportsTo: "a1", state: "failing", stateNote: "Last scan failed", ...idle, lastRunStatus: "failed" },
  { id: "a8", key: "researcher", name: "Rhea", title: "Research and drafts", system: true, department: OPS, teammate: mate("Researcher", "Weekly metrics digest, every Monday.", kit("long", "round-glasses", "none", 9, 8)), model: "deepseek-flash", reportsTo: null, state: "idle", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Process task replies", paused: true, nextRunAt: null }], lastRunAt: ago(60), lastRunStatus: "succeeded" },
  { id: "a16", key: "acme-bot", name: "Acme Bot", title: "A local teammate with its own picture", system: false, department: DESK, teammate: mate("Invoice desk", "Three invoices matched to payments today.", { src: "/api/faces/acme-bot" }), model: "deepseek-flash", reportsTo: "a1", state: "idle", ...idle },
  // Hidden staff (no teammate block): drawn from the seed.
  { id: "a3", key: "engineer", name: "Engineer", title: "Builds and fixes code", system: false, department: ENG, model: "deepseek-flash", reportsTo: "a1", state: "working", running: 3, queued: 1, workingSince: ago(12), schedules: [], lastRunAt: ago(12), lastRunStatus: "succeeded", maxParallel: 4 },
  { id: "a4", key: "platform-engineer", name: "Platform Engineer", title: "Keeps the fleet healthy", system: false, department: ENG, model: "deepseek-flash", reportsTo: "a1", state: "failing", stateNote: "Last 2 runs failed", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Health check", paused: false, nextRunAt: ahead(48) }], lastRunAt: ago(50), lastRunStatus: "failed" },
  { id: "a5", key: "ui-designer", name: "UI Designer", title: "Designs app screens", system: false, department: ENG, model: "deepseek-flash", reportsTo: "a3", state: "queued", running: 0, queued: 2, workingSince: null, schedules: [], lastRunAt: ago(240), lastRunStatus: "succeeded" },
  { id: "a6", key: "inbox-agent", name: "Intake", title: "Sorts what comes in", system: false, department: DESK, model: "deepseek-flash", reportsTo: "a1", state: "paused", running: 0, queued: 0, workingSince: null, schedules: [{ title: "Inbox pass", paused: true, nextRunAt: null }], lastRunAt: ago(1440), lastRunStatus: "succeeded" },
  { id: "a9", key: "session", name: "Session", title: "Long-lived coding sessions", system: false, department: ENG, model: "deepseek-flash", reportsTo: "a1", state: "idle", running: 0, queued: 0, workingSince: null, schedules: [], lastRunAt: ago(20), lastRunStatus: "succeeded", maxParallel: 8 },
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
  w(7812, "Pick the payments vendor for the refund API", "chief-of-staff", st("waiting", "owner_wait", { question: "Stripe or Adyen? Adyen is cheaper at our volume but needs a 3-week review.", since: ago(120), attention: [A("owner", "owner_wait", "wait:t")] }), { priority: "high", projectId: "p-launch", age: 120 }),
  w(7820, "Approve push: release 0.9 notes", "engineer", st("waiting", "card_owner", { ref: "record:k-00000000000000a2", since: ago(25), attention: [A("owner", "card", "record:k-00000000000000a2")], refs: { "record:k-00000000000000a2": "push to docs/release-0.9" } }), { projectId: "p-launch", age: 25 }),
  w(7790, "Fix the flaky checkout test on CI", "engineer", st("working", "job_running", { ref: "job:j-e101000000000001", stage: "Testing", since: ago(3.2) }), { priority: "high", projectId: "p-launch", labelIds: ["l-code"], age: 40 }),
  w(7791, "Add retry to the checkout flow", "platform-engineer", st("working", "job_running", { ref: "job:j-e102000000000002", stage: "Coding", since: ago(8) }), { projectId: "p-launch", parent: "WOR-7790", age: 20 }),
  w(7795, "Weekly fleet digest", "chief-of-staff", st("working", "job_running", { ref: "job:j-77fa000000000003", stage: "Digest", since: ago(1) }), { projectId: "p-aidenhq", age: 6 }),
  w(7801, "Migrate the warehouse ingest to the new schema, including backfill of 2023 and the long tail of partner tables", "platform-engineer", st("working", "job_running", { ref: "job:j-0b3c000000000004", stage: "Migrating", since: ago(12.6) }), { projectId: "p-infra", crewIds: ["engineer"], age: 60 }),
  w(7788, "Release 0.9 candidate", "engineer", st("waiting", "card_review", { ref: "record:k-00000000000000a5", refLabel: "reviewer is reading the diff", since: ago(18) }), { projectId: "p-launch", labelIds: ["l-review"], age: 18 }),
  w(7765, "Ask legal about the data-retention clause", "chief-of-staff", st("waiting", "delegator_wait", { since: ago(180), waits_on: "a8", waits_on_name: "Research Lead", attention: [A("agent", "delegator_wait", "wait:t")] }), { projectId: "p-hiring", age: 180 }),
  w(7770, "Deploy marketing site", "platform-engineer", st("waiting", "module_wait", { ref: "checks", since: ago(50) }), { projectId: "p-infra", age: 50 }),
  w(7744, "Refund API: wire up the webhook handler", "engineer", st("idle", "failed", { ref: "job:j-d002000000000005", since: ago(300), attention: [A("agent", "failed", "job:j-d002000000000005")], refs: { "job:j-d002000000000005": "the job timed out after 120 min" } }), { priority: "critical", projectId: "p-launch", age: 300 }),
  w(7751, "Backfill invoices", "platform-engineer", st("waiting", "job_queued", { since: ago(300), blocker: "task:id-7744", lane: "blocked", note: "Waits for the webhook handler.", refs: { "task:id-7744": "WOR-7744" } }), { projectId: "p-infra", age: 300 }),
  w(7756, "Answer the partner's API question", "open-loops", st("idle", "failed", { ref: "no_reply", since: ago(90), attention: [A("agent", "failed", "no_reply")] }), { age: 90 }),
  w(7702, "Tidy the Notion roadmap", "chief-of-staff", st("waiting", "backlog", { since: ago(5760) }), { age: 5760 }),
  w(7733, "Prepare Thursday's board pre-read", "chief-of-staff", st("waiting", "scheduled", { since: ago(1440), scheduled_for: TOMORROW_8 }), { age: 1440 }),
  w(7690, "Review vendor security questionnaire", "me", st("waiting", "owner_task", { since: ago(2880) }), { age: 2880 }),
  w(7686, "Old import task", null, null, { age: 9000 }),
  w(7781, "Rotate the staging database credentials", "platform-engineer", st("done", "closed", { grade: "pass", since: ago(180) }), { status: "done", closedAt: ago(180), age: 180 }),
  w(7776, "Summarise the Monday leads call", "chief-of-staff", st("done", "closed", { grade: "pass", since: ago(540) }), { status: "done", closedAt: ago(540), age: 540 }),
  w(7760, "Stale PR cleanup", "engineer", st("done", "cancelled", { since: ago(1440) }), { status: "cancelled", closedAt: ago(1440), age: 1440 }),
  // A long Idle lane: 25 cards, then "Show N more".
  ...Array.from({ length: 32 }, (_, i) => w(6900 + i, i === 1 ? "A very long title that should clamp to two lines and never push the card wider, with https://example.com/a/very/long/path/that/keeps/going" : `Archive the Q${(i % 4) + 1} vendor threads`, "chief-of-staff", st("waiting", "backlog", { since: ago(9000 + i) }), { age: 9000 + i })),
];
// Task search (GET /api/search): any work card or old closed task sharing a word with the query (4+ letters, or a prefix of
// one), and "review" also finds what is about review without the word (the meaning half). Old closed tasks are months back.
const OLD_DONE = () => [
  [7012, "Add a code-review lens for module repos", "engineer", 60], [6950, "Critique checklist for pull requests", "chief-of-staff", 95], [6870, "Reviewer eval: planted cases for false rejects", "engineer", 120],
  [6801, "Tune the AI reviewer's malice-only rule", "platform-engineer", 150], [6744, "PR review comments land as one thread", "engineer", 180], [6702, "Second opinion on the checkout PR", "engineer", 210],
  [6650, "Review the vendor security questionnaire", "me", 240], [6601, "Retire the old review dashboard", "chief-of-staff", 270], [6555, "Reviewer timeouts on large diffs", "platform-engineer", 300],
  [6500, "Code review summary in the morning brief", "chief-of-staff", 330], [6444, "Lint rule for review comments", "engineer", 365], [6400, "Warehouse backups to the storage box", "platform-engineer", 400],
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
  { id: "00000000-0000-4000-8000-0000000000a2", name: "Engineering", rev: 1, spec: { layout: "work", groupBy: "none", filters: { agent: ["engineer", "chief-of-staff", "platform-engineer"], updated: "7d" } } },
];
// A module's Fleet page (board.pages): the example view (web/dev/example-view.html) with the shared kit inlined, as a module's
// mcp.ts pageHtml serves its page.html, and its two tools, as the kernel would relay them.
const kitFile = (f: string) => readFileSync(new URL(`../../../shared/${f}`, import.meta.url), "utf8");
const exampleView = () => readFileSync(new URL("./example-view.html", import.meta.url), "utf8").replace("/*kit:css*/", () => kitFile("page-kit.css")).replace("/*kit:js*/", () => kitFile("page-kit.js"));
const PAGES = [{ id: "notes", title: "Notes", icon: "list", order: 10, module: "example" }, { id: "code-review", title: "Reviews", icon: "reviews", order: 5, module: "code-review" }];
// The Notes page's last Save stays "applying" for 8 seconds, then lands (the Save-while-applying state).
let savedAt = 0, savedId = "WOR-901";
const notesChange = () => (savedAt ? [{ identifier: savedId, title: "Keep notes", createdAt: new Date(savedAt).toISOString(), items: [{ kind: "setting", key: "example_limit", value: 30 }, { kind: "setting", key: "code_review", value: {} }], stage: Date.now() - savedAt < 8_000 ? "applying" : "applied" }] : []);
function pageRoute(method: string, url: URL, body: any): [number, unknown] | undefined {
  if (url.pathname === "/api/pages") return [200, { pages: mock.empty ? [] : PAGES }];
  if (method === "POST" && url.pathname === "/api/pages/code-review/save") return (savedAt = Date.now(), savedId = "WOR-902", [200, { identifier: "WOR-902", record: "k-0000000000000902", tier: 2, state: "approved" }]);
  if (method === "POST" && url.pathname === "/api/pages/code-review/call") { const r = reviewCall(body.name, body.arguments ?? {}); return r ? [200, r] : [403, { error: `${body.name} isn't one of this page's tools` }]; }
  if (method === "POST" && url.pathname === "/api/pages/notes/save") return (savedAt = Date.now(), savedId = "WOR-901", [200, { identifier: "WOR-901", record: "k-0000000000000901", tier: 2, state: "approved" }]);
  if (method !== "POST" || url.pathname !== "/api/pages/notes/call") return undefined;
  if (body.name === "example_notes") return [200, { result: { content: [{ type: "text", text: "3 notes" }], structuredContent: { notes: [{ text: "Renewal call with Acme moved to Thursday", at: "2h ago" }, { text: "Invoices export shipped", at: "yesterday" }, { text: "Draft the Q1 offsite agenda", at: "3 days ago" }] } } }];
  if (body.name === "example_configure") return [200, { result: { content: [{ type: "text", text: `Proposed keeping ${body.arguments?.limit} notes: save it above.` }], structuredContent: { _aidenhq: { settings_change: [{ kind: "setting", key: "example_limit", value: body.arguments?.limit }] } } } }];
  return [403, { error: `${body.name} isn't one of this page's tools` }];
}

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
// The owner's own tasks (assignee "me") fill My tasks; the agent-assigned ones are Delegated and never listed there.
const mine = (n: number, title: string, extra: Record<string, unknown> = {}) => card(n, title, { assignee: "me", ...extra });
const src = (name: string, color: string) => ({ labels: [{ name, color }] });
const board = () => ({
  buckets: mock.empty ? { triage: [], today: [], tomorrow: [], later: [], backlog: [] } : {
    triage: [
      mine(815, "Weekly metrics digest looks off", { priority: "high", ...src("email", "#e8590c") }),
      mine(816, "Northwind asks for revised SLA terms", { unread: true, ...src("needs-response", "#3b5bdb") }),
      mine(817, "Invoice dispute from Acme Freight", src("email", "#e8590c")),
      mine(818, "Omar flagged a gap in the hiring budget", src("needs-response", "#3b5bdb")),
      mine(819, "Own the vendor shortlist (Leadership sync)", src("meeting-action", "#0f9d8a")),
      mine(820, "Speaker invite for a Zurich conference", src("email", "#e8590c")),
      mine(821, "Renew the domain portfolio", src("todo", "#868e96")),
      mine(822, "Intro request from a recruiter", src("email", "#e8590c")),
      card(812, "Reply to Acme's renewal question", { unread: true, assignee: "open-loops" }),
    ],
    today: [
      mine(801, "Prep notes for the design review", { carried: 1, projectId: "p-launch" }),
      mine(803, "Review Northwind vendor contract redlines", { projectId: "p-aidenhq", priority: "high" }),
      mine(804, "Send Q1 budget sign-off to Omar Haddad", { projectId: "p-infra" }),
      mine(805, "Decide on Lena Park's offer band", { projectId: "p-hiring" }),
      card(790, "Ship the invoices app's export", { assignee: "engineer", working: { agent: "Engineer", since: ago(12), queued: false, said: "Running the export tests" }, crew: [{ agent: "engineer", state: "working", issues: [{ id: "id-791", identifier: "WOR-791", title: "Add CSV export", state: "working" }], since: ago(12) }] }),
      card(802, "Chase the vendor contract", { assignee: "open-loops", priority: "critical" }),
    ],
    tomorrow: [mine(770, "Plan the Q1 offsite agenda", { projectId: "p-hiring" }), mine(771, "Follow up on Jonas Weber's signed contract", { projectId: "p-aidenhq" })],
    later: ["Draft Q1 engineering priorities", "Approve conference travel for the platform team", "Read the vendor security questionnaire", "Debrief the hiring loop with Lena Park", "Shortlist offsite venues", "Write a reference for Priya Nair", "Try the new calendar agent"].map((t, i) => mine(700 + i, t, { projectId: PROJECTS[i % 4]!.id })),
    backlog: ["Someday: voice notes into tasks", "Evaluate the Postgres 18 upgrade window", "Redesign the leadership update format", "Explore EU entity options", "Tidy the warehouse schemas", "Archive the 2023 vendor folders"].map((t, i) => mine(600 + i, t, i % 2 ? { projectId: PROJECTS[i % 4]!.id } : {})),
  },
  brief: null, done: [], recurring: [],
  work: mock.empty ? [] : WORK(), asOf: new Date().toISOString(), incomplete: false, projects: mock.empty ? [] : PROJECTS,
  assignees: [{ key: "me", kind: "me", name: "Me", seed: "me" }, ...roster.map((a) => ({ key: a.key, kind: a.key === "engineer" ? "engineer" : a.key === "researcher" ? "assistant" : "agent", name: a.name, seed: a.key, ...(a.teammate ? { face: a.teammate.face } : {}), ...(a.key === "engineer" ? { defaultModel: "openrouter/~deepseek/deepseek-flash-latest", efforts: ["low", "medium", "high"] } : {}) }))],
  labels: mock.empty ? [] : LABELS, prefix: "WOR", timezone: "Asia/Dubai", slackTeams: {}, rollsOn: "Monday", rollsTomorrow: true, agentsActive: 4,
  spend: { day: { spent: 3.42, cap: 50 }, month: { spent: 61.2, cap: 1000 } }, google: null, signIns: [],
});

// Sessions (the sessions module): live and ended ones. Only the account that started a session may open its terminal (`mine`).
const SESSIONS = () => [
  { task: "id-931", identifier: "WOR-931", title: "Merge the widgets stack", state: "running", error: null, started_at: ago(94), ended_at: null, last_activity: { at: ago(0.2), text: "Running the integration tests on acme/widgets#413" }, cost_usd: 1.84, creator: { name: "Alex", kind: "person" }, mine: true },
  { task: "id-932", identifier: "WOR-932", title: "Watch #412, then merge #413", state: "waiting", error: null, started_at: ago(60 * 7), ended_at: null, last_activity: { at: ago(55), text: "Armed a watch on acme/widgets#412" }, cost_usd: 0.37, creator: { name: "Aiden", kind: "agent" }, mine: true },
  { task: "id-933", identifier: "WOR-933", title: "Overnight dependency sweep", state: "waiting", error: null, started_at: ago(60 * 30), ended_at: null, last_activity: { at: ago(60 * 9), text: "Opened 3 pull requests with the safe upgrades" }, cost_usd: 2.61, creator: { name: "Alex", kind: "person" }, mine: true },
  { task: "id-934", identifier: "WOR-934", title: "Investigate the flaky export test", state: "starting", error: null, started_at: ago(0.3), ended_at: null, last_activity: null, cost_usd: 0, creator: { name: "Alex", kind: "person" }, mine: true },
  { task: "id-937", identifier: "WOR-937", title: "Draft the migration plan for the ledger", state: "running", error: null, started_at: ago(210), ended_at: null, last_activity: { at: ago(2), text: "Reading the ledger schema" }, cost_usd: 4.12, creator: { name: "Jordan", kind: "person" }, mine: false },
  { task: "id-936", identifier: "WOR-936", title: "Rebuild the search index", state: "error", error: "The computer restarted and the session could not resume: its job was lost.", started_at: ago(60 * 26), ended_at: ago(60 * 20), last_activity: { at: ago(60 * 20), text: "Re-indexing 40% done" }, cost_usd: 0.88, creator: { name: "Alex", kind: "person" }, mine: true },
  { task: "id-935", identifier: "WOR-935", title: "Port the CSV export to the new table", state: "stopped", error: null, started_at: ago(60 * 52), ended_at: ago(60 * 49), last_activity: { at: ago(60 * 49), text: "Merged acme/invoices#58 and finished" }, cost_usd: 3.05, creator: { name: "Alex", kind: "person" }, mine: true },
];
const sessionChat = (ref: string) => {
  const s = SESSIONS().find((x) => x.identifier === ref);
  if (!s) return undefined;
  return { id: s.task, identifier: ref, title: s.title, open: s.state !== "stopped", agent: { key: "session", name: "Session" }, state: null, working: null, files: [], approvals: [], handedOut: [], parent: null, runs: [], asks: [], messages: [
    { kind: "owner", id: "s1", text: s.state === "waiting" ? "Watch acme/widgets#412. When it merges, merge #413 and tell me here." : "Get the widgets stack merged: #412 first, then #413, then #414. Run the tests between each.", at: ago(100), ...(s.creator.kind === "agent" ? { by: "Aiden" } : {}) },
    { kind: "reply", id: "s2", agent: "Session", text: s.state === "waiting" ? "Armed a watch on #412. I'm going to sleep and will use no tokens until it fires." : "Rebased the stack on main. **#412** is green; starting the merge.\n\n- #412 merged\n- #413 waiting on CI", at: ago(90) },
    { kind: "notice", id: "s3", text: s.state === "waiting" ? "Woke at 09:00 to check CI on #413: still queued." : "A wake notice: CI finished on #413.", at: ago(40) },
    ...(s.state === "running" ? [{ kind: "owner", id: "s4", text: "Skip #414 for now.", at: ago(12) }, { kind: "reply", id: "s5", agent: "Session", text: "Skipping #414. Running the integration tests on #413.", at: ago(10) }] : []),
  ] };
};
const chatRows = () => mock.empty ? [] : [
  { identifier: "WOR-820", title: "Can you find a time with Sam next week?", open: true, agent: { key: "chief-of-staff", name: "Aiden" }, state: named("WOR-820", STATES.running), updatedAt: ago(1), preview: { text: "Looking at both calendars now.", at: ago(1), from: "agent" }, unread: true },
  { identifier: "WOR-818", title: "Build a small app that tracks invoices", open: true, agent: { key: "chief-of-staff", name: "Aiden" }, state: named("WOR-818", CARD), updatedAt: ago(9), preview: { text: "The app is ready; the deploy waits on your approval.", at: ago(9), from: "agent" }, unread: true },
  { identifier: "WOR-815", title: "Weekly metrics digest looks off", open: true, agent: { key: "chief-of-staff", name: "Aiden" }, state: named("WOR-815", ASK), updatedAt: ago(40), preview: { text: "Which week should I compare against?", at: ago(40), from: "agent" }, unread: false },
  { identifier: "WOR-803", title: "Ship the invoices app's export", open: true, agent: { key: "engineer", name: "Engineer" }, state: named("WOR-803", STATES.running), updatedAt: ago(5), preview: { text: "Running the export tests.", at: ago(5), from: "agent" }, unread: false },
  { identifier: "WOR-811", title: "Summarise yesterday's leadership sync", open: true, agent: { key: "meetings", name: "Nora" }, state: named("WOR-811", STATES.done), updatedAt: ago(180), preview: { text: "Summary posted with 4 action items.", at: ago(180), from: "agent" }, unread: false },
  { identifier: "WOR-806", title: "Why did the health check fail?", open: true, agent: { key: "platform-engineer", name: "Platform Engineer" }, state: named("WOR-806", FAILED), updatedAt: ago(52), preview: { text: "Timed out after 30 minutes.", at: ago(52), from: "agent" }, unread: false },
  { identifier: "WOR-799", title: "Draft a reply to the hiring agency", open: true, agent: { key: "chief-of-staff", name: "Aiden" }, state: named("WOR-799", STATES.chatTurn), updatedAt: ago(1500), preview: { text: "Sent.", at: ago(1500), from: "you" }, unread: false },
];

const approval = (id: string, over = {}) => ({ id, identifier: "WOR-818", action: "deploy", target: "invoices", digest: "sha256:9f2c", sentence: "Deploy the invoices app at 4e1a9c2", reads: "The warehouse schema app_invoices", changes: "Starts a new container; the app's door opens to admins", cost: "No spend", details: "Commit 4e1a9c2 on acme-agents/invoices: adds CSV export and a monthly total.", requestedBy: "Engineer", state: "pending", tier: 2, reason: "First deploy of a new app", review: "The diff is small and touches only the app's own repo. Sent to you because it is a first deploy.", decidedBy: null, outcome: null, outcomeText: null, createdAt: ago(9), replaced: false, ...over });
const approvals = () => mock.empty ? [] : [
  approval("k-00000000000000a1"),
  approval("k-00000000000000a2", { identifier: "WOR-806", action: "push", target: "acme-agents/aidenhq-instance", sentence: "Raise the Platform Engineer's run timeout to 45 minutes", changes: "One line in instance.yaml", tier: 2, reason: "Changes an agent's limits", review: null, createdAt: ago(50) }),
  approval("k-00000000000000a3", { identifier: "WOR-790", action: "merge", target: "acme-agents/invoices#14", sentence: "Merge “Add CSV export” into main", tier: 1, state: "approved", decidedBy: "reviewer:gpt-luna", review: "Tests pass, change is scoped to the export.", outcome: "applied", outcomeText: "Merged as 4e1a9c2", createdAt: ago(70) }),
  approval("k-00000000000000a4", { identifier: "WOR-777", action: "send", target: "slack:#general", sentence: "Post the weekly update in #general", tier: 1, state: "rejected", decidedBy: "reviewer:gpt-luna", review: "The draft names a customer that isn't public yet.", createdAt: ago(300) }),
  approval("k-00000000000000d1", { identifier: "WOR-770", action: "send", target: "slack:#leads", sentence: "Post the hiring update in #leads", tier: 2, state: "rejected", decidedBy: "account:u1", reason: "Names a candidate", createdAt: ago(900) }),
  approval("k-00000000000000a5", { identifier: "WOR-792", action: "push", target: "acme-agents/invoices", sentence: "Push the CSV export fix to a branch", tier: 1, reason: null, review: null, createdAt: ago(2) }),
];

const chatDetail = (ref: string) => {
  const mine = ["chief-of-staff", "reviewer-manager"].flatMap((k) => [...(agentChats(k, "active")?.chats ?? []), ...(agentChats(k, "settled")?.chats ?? [])]);
  const row = chatRows().find((c) => c.identifier === ref) ?? mine.find((c) => c.identifier === ref) ?? chatRows()[0] ?? { identifier: ref, title: "New chat", open: true, agent: { key: "chief-of-staff", name: "Aiden" }, state: null };
  // Max's chats talk about reviews (a hidden Engineer adds a note under him); everyone else's about scheduling.
  const max = row.agent.key === "reviewer-manager";
  return {
    id: `id-${ref}`, identifier: row.identifier, title: row.title, open: true, agent: row.agent, state: row.state,
    messages: max ? [
      { kind: "owner", id: "m1", text: row.title, at: ago(15) },
      { kind: "reply", id: "m2", agent: row.agent.name, text: "On it. I'll add **aidenhq-distro** to the reviewed repos with the same rules:\n\n- review on open\n- one push round\n- skip docs-only PRs", at: ago(12), run: { id: "j-bbbbbbbbbbbbbbbb", seconds: 372, trigger: "Your comment" } },
      { kind: "reply", id: "m3", agent: "Engineer", text: "Repo settings updated; the change is waiting for Max's check.", at: ago(10) },
      { kind: "owner", id: "m4", text: "Skip the site/ folder there too.", at: ago(6) },
      { kind: "reply", id: "m5", agent: row.agent.name, text: "Done: aidenhq-distro is reviewed like your other repos, site/ left out. Apply it now?", at: ago(2), run: { id: "j-cccccccccccccccc", seconds: 41, trigger: "Your comment" }, questions: [{ question: "Apply the change", options: ["Apply now", "Tonight"] }] },
    ] : [
      { kind: "owner", id: "m1", text: row.title, at: ago(15) },
      { kind: "reply", id: "m2", agent: row.agent.name, text: "On it. I'll check both calendars and propose **three slots** that avoid your focus blocks.\n\n- Tuesday 10:00\n- Wednesday 14:30\n- Thursday 09:00", at: ago(12), run: { id: "j-bbbbbbbbbbbbbbbb", seconds: 372, trigger: "Your comment" } },
      { kind: "notes", id: "m3", agent: row.agent.name, at: ago(10), notes: [{ by: "Aiden", text: "Asked Tess whether Sam has a pending thread.", at: ago(10) }] },
      { kind: "owner", id: "m4", text: "Wednesday works best, but keep it to 30 minutes.", at: ago(6) },
      { kind: "reply", id: "m5", agent: row.agent.name, text: "Got it: Wednesday 14:30 for 30 minutes. Which title should the invite carry?", at: ago(2), run: { id: "j-cccccccccccccccc", seconds: 41, trigger: "Schedule: daily-brief" }, questions: [{ question: "Invite title", options: ["Sam / sync", "Q1 planning", "Catch-up"] }] },
    ],
    working: row.state?.kind === "working" ? { agent: row.agent.name, since: ago(1), queued: false, said: max ? "Reading the repo's settings" : "Checking Sam's calendar", plan: [{ text: "Read both calendars", state: "done" }, { text: "Pick slots", state: "doing" }, { text: "Send the invite", state: "todo" }] } : null,
    files: [], approvals: ref === "WOR-818" ? [approval("k-00000000000000a1")] : [], handedOut: ref === "WOR-818" ? [{ identifier: "WOR-819", title: "Build the invoices app", agent: "Engineer", state: named("WOR-819", WORKING_CARD), updatedAt: ago(5), working: { agent: "Engineer", since: ago(5), queued: false } }, { identifier: "WOR-821", title: "Design the invoice screens", agent: "UI Designer", state: named("WOR-821", ASK), updatedAt: ago(20), working: null }, { identifier: "WOR-822", title: "Write the export tests", agent: "Engineer", state: named("WOR-822", STATES.blocked), updatedAt: ago(40), working: null }, { identifier: "WOR-823", title: "Seed the demo data", agent: "Engineer", state: named("WOR-823", STATES.done), updatedAt: ago(100), working: null }] : [],
    parent: null, runs: [], asks: [],
  };
};

const kid = (n: number, title: string, agent: string, state: ReturnType<typeof st>, o: Record<string, unknown> = {}) => ({ identifier: `WOR-${n}`, title, agent, model: "deepseek-flash high", state: named(`WOR-${n}`, state), latest: { text: "Working through the export tests.", at: ago(4) }, tokens: 182_000, usd: 0.42, startedAt: ago(90), endedAt: state.kind === "done" ? ago(30) : null, children: [], approvals: [], ...o });
// The task drawer's rubric by ref: WOR-798 no rubric row, WOR-795 grading down, WOR-796 failed check, WOR-797 open (checked after close), WOR-799 met, else unmet.
const gradeFor = (ref: string) =>
  ref === "WOR-798" ? { state: "none", rubric: [] }
  : ref === "WOR-795" ? { state: "unavailable", rubric: [] }
  : ref === "WOR-796" ? { state: "failed", reason: "The model could not be reached.", rubric: [{ text: "Export respects the current filter" }], deliverable: { kind: "pr", ref: "acme-agents/invoices#41", href: "https://github.com/acme-agents/invoices/pull/41" } }
  : ref === "WOR-797" ? { state: "open", rubric: [{ text: "Says what was found" }, { text: "Cites sources" }], deliverable: { kind: "pr", ref: "" } }
  : ref === "WOR-799" ? { state: "met", checkedAt: ago(30), rubric: [{ text: "Says what was found", met: "yes", reason: "The report lists the findings." }, { text: "Cites sources", met: "yes", reason: "Sources are linked." }], deliverable: { kind: "report", ref: "" } }
  : { state: "unmet", checkedAt: ago(30), rubric: [{ text: "Export respects the current filter", met: "yes", reason: "The report says the filter state is passed to ExportButton." }, { text: "Totals row uses the account currency", met: "no", reason: "The report says the total row is hard-coded to USD." }, { text: "Docs mention the new export", met: "yes", reason: "Docs updated." }], deliverable: { kind: "pr", ref: "acme-agents/invoices#41", href: "https://github.com/acme-agents/invoices/pull/41" } };
const milestones = () => [
  { at: ago(240), kind: "created", text: "Created" },
  { at: ago(235), kind: "run_started", text: "Run started", runId: "j-aaaaaaaaaaaaaaaa" },
  { at: ago(200), kind: "run_ended", text: "Run failed: ran past 120 minutes", runId: "j-aaaaaaaaaaaaaaaa" },
  { at: ago(120), kind: "asked_you", text: "Asked you: Ship the CSV export behind a flag?" },
  { at: ago(60), kind: "approved", text: "Card approved by the AI reviewer", href: "#/approvals/k-00000000000000a1" },
  { at: ago(50), kind: "applied", text: "Card applied: pr", href: "#/approvals/k-00000000000000a1" },
  { at: ago(35), kind: "deployed", text: "Deployed in generation 7", href: "https://github.com/acme-agents/invoices/pull/41" },
];
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

const moduleRow = (name: string, description: string, state: string, over = {}) => ({ name, id: name, browse: false, description, agents: [], requires: [], marketplace: "aidenhq", tier: "official", state, neededBy: [], connections: [], routines: [], apps: [], settings: {}, revision: "a1b2c3d", pinned: null, source: null, setup: null, ...over });
// Hiring and onboarding (src/teammates.ts): every catalog teammate, official first, then a third-party marketplace's
// browse rows (one with a kit face, one without: a monogram). With ?welcome=1 only Aiden is on the team until a module
// change for a teammate goes live (5 s after it is filed).
const hireMock = { filed: new Map<string, { at: number; n: number }>(), dismissed: new Set<string>(), trials: new Map<string, number>(), queue: { next: [] as string[], later: [] as string[] } as { first?: string; next: string[]; later: string[] }, finishedAt: 0, chats: new Map<string, { at: number; text: string }>() };
const HM = (key: string, module: string, description: string, department: string, o: { requires?: string[]; connections?: string[]; marketplace?: string; first?: number; team?: boolean } = {}) => {
  const a = roster.find((r) => r.key === key);
  const mk = o.marketplace ?? "aidenhq";
  const id = mk === "aidenhq" ? module : `${module}@${mk}`;
  return { key, name: a?.name ?? "", job: a?.teammate?.job ?? "", sample: a?.teammate?.sample ?? "", description, department, module, id, ref: `${id}:${key}`, marketplace: mk, browse: mk !== "aidenhq", face: a?.teammate?.face ?? null, requires: o.requires ?? [], connections: o.connections ?? [], first: o.first, team: o.team ?? false };
};
const HIRE = [
  HM("chief-of-staff", "core", "Your front door: reads everything, hands work to the team, and writes your morning brief.", "Chief of staff", { team: true }),
  HM("open-loops", "open-loops", "Spots what people owe you in Slack and email, tracks it, and drafts a polite chaser when it goes quiet.", "Chief of staff", { requires: ["intake"], connections: ["slack", "google"], first: 1, team: true }),
  HM("meetings", "meetings", "Takes notes for every meeting, files each action item to its owner and follows them up.", "Desk", { connections: ["google"], team: true }),
  HM("reviewer-manager", "code-review", "Reviews every pull request on the repos you choose and explains each finding.", "Engineering", { requires: ["github"], team: true }),
  HM("ship", "ship", "Fixes review findings and red checks, and merges once everything is green.", "Engineering", { requires: ["github", "code-review"], team: true }),
  HM("app-maintainer", "apps-platform", "Describe a tool, get a working app that stays up.", "Engineering", { team: true }),
  HM("researcher", "research", "Long research, drafts and recurring reports, from your company's own sources.", "Chief of staff", { team: true }),
  HM("architect", "agent-builder", "Builds a new teammate from a sentence when nothing in your marketplaces fits.", "Chief of staff", { team: true }),
  HM("security-watch", "security", "Scans what you run for known vulnerabilities, verifies each, and opens the fix.", "Engineering", { requires: ["github"] }),
  HM("maintainer", "maintainer", "Keeps your repos healthy: triages issues and sees fixes through to merged PRs.", "Engineering", { requires: ["github"] }),
  { ...HM("twin", "twin", "A one-page brief before any meeting you flag: attendees, open threads, decisions pending.", "Desk", { marketplace: "acme", connections: ["google"] }), name: "Eve", job: "Executive briefings", sample: "Board meeting tomorrow: 2 decisions, 3 likely questions.", face: { kit: { hair: "bun", accessory: "glasses", body: "none", skin: 3, hair_color: 2, palette: 6 } } },
  { ...HM("penny", "board-pack", "Assembles the board pack from finance sheets and past minutes, with directors' open questions.", "Desk", { marketplace: "acme", connections: ["google"] }), name: "Penny", job: "Board pack", sample: "Board pack v1 ready: 14 pages, 3 open questions." },
];
type Hire = (typeof HIRE)[number];
const filedAt = (h: Hire) => hireMock.filed.get(h.id)?.at ?? 0;
const hired = (h: Hire) => (mock.welcome || hireMock.finishedAt ? h.key === "chief-of-staff" : h.team) || (filedAt(h) > 0 && Date.now() - filedAt(h) > 5_000);
const hireRow = (h: Hire) => { const { first: _f, team: _t, ...row } = h; const on = hired(h); return { ...row, onTeam: on, connections: on ? row.connections.filter((m) => !flows().flows.some((f) => f.module === m && f.done)) : row.connections }; };
const teammates = () => {
  const rows = HIRE.map(hireRow);
  const avail = HIRE.filter((h) => !hired(h));
  const first = [...avail].sort((a, b) => (a.first ?? 1e9) - (b.first ?? 1e9) || a.job.localeCompare(b.job))[0];
  const arch = HIRE.find((h) => h.key === "architect")!;
  return { rows, first: first?.ref ?? null, builder: hired(arch) ? { key: arch.key, name: arch.name, face: arch.face } : null };
};
const hireChanges = () => [...hireMock.filed].map(([id, f]) => { const age = Date.now() - f.at; return { identifier: `WOR-${f.n}`, title: `Turn on ${id}`, createdAt: new Date(f.at).toISOString(), items: [{ kind: "module", name: id, on: true }], stage: age < 1_500 ? "working" : age < 5_000 ? "applying" : "applied", tier: 1 }; });
const TRIAL_FOUND = [
  { identifier: "WOR-871", title: "Jonas Weber · signed contract (5 days quiet)", labels: ["waiting-on"] },
  { identifier: "WOR-872", title: "Priya Nair · design doc review", labels: ["waiting-on"] },
  { identifier: "WOR-873", title: "Lena Park asked for the hiring loop feedback", labels: ["needs-response"] },
  { identifier: "WOR-874", title: "Omar Haddad · Q1 budget numbers, due Friday", labels: ["waiting-on"] },
];
const trial = (ref: string) => { const at = hireMock.trials.get(ref); return !at ? { state: "none", found: [] } : Date.now() - at < 3_000 ? { state: "running", found: [] } : { state: "done", found: mock.empty ? [] : TRIAL_FOUND }; };
const homeStart = () => {
  const avail = HIRE.filter((h) => !hired(h));
  const next = hireMock.queue.next.map((r) => avail.find((h) => h.ref === r)).find(Boolean);
  if (!next && !(hireMock.finishedAt && Date.now() - hireMock.finishedAt < 7 * 86_400_000)) return undefined;
  return { nextUp: next ? hireRow(next) : null, more: avail.filter((h) => h !== next).slice(0, 8).map((h) => ({ key: h.key, name: h.name, job: h.job, face: h.face })) };
};
/** The builder's chat on a description: looking for 3 s, then its form (Extend a teammate, Install a listing, Build new). */
const hireChat = (ref: string) => {
  const c = hireMock.chats.get(ref)!;
  const asked = Date.now() - c.at > 3_000;
  const arch = HIRE.find((h) => h.key === "architect")!;
  return {
    id: `id-${ref}`, identifier: ref, title: c.text.slice(0, 80), open: true, agent: { key: arch.key, name: arch.name },
    state: asked ? named(ref, st("waiting", "owner_wait", { wait_since: ago(0.1), question: "Which way?" })) : named(ref, STATES.running),
    messages: [
      { kind: "owner", id: "h1", text: c.text, at: new Date(c.at).toISOString() },
      ...(asked ? [{ kind: "reply", id: "h2", agent: arch.name, at: ago(0.1), text: "I checked your team and your marketplaces. Three could do this:\n\n- **Extend Rhea** · she already reads Drive and writes briefs; a board-prep routine covers it. No new connections.\n- **Install Eve** (Executive briefings) · from acme, reviewed when installed. Needs Google.\n- **Build new** · I design one from your description, reusing what you have.", questions: [{ question: "Which way?", options: ["Extend researcher", "Install twin@acme", "Build new"] }] }] : []),
    ],
    working: asked ? null : { agent: arch.name, since: ago(0.05), queued: false, said: "Looking in your team and marketplaces", plan: [] },
    files: [], approvals: [], handedOut: [], parent: null, runs: [], asks: [],
  };
};
const modules = () => [
  moduleRow("core", "The chief of staff and the pieces every install needs.", "core", { agents: ["chief-of-staff"] }),
  moduleRow("engineering", "Engineers that build and fix code in your repos.", "on", { agents: ["engineer", "ui-designer"], connections: ["github"] }),
  moduleRow("apps-platform", "Runs the apps agents build, each in its own sandbox.", "dependency", { neededBy: ["engineering"] }),
  moduleRow("google", "Gmail and Calendar for every agent you grant.", "on", { connections: ["google_workspace"], setup: "google" }),
  // Hiring's modules (below): off until a module change for them goes live; a third-party listing is a browse row.
  ...HIRE.filter((h) => h.module !== "core").map((h) => ({ ...moduleRow(h.module, h.description, hired(h) ? "on" : "off", { agents: [h.key], requires: h.requires }), id: h.id, marketplace: h.marketplace, tier: h.browse ? "declared" : "official", browse: h.browse && !hired(h) })),
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
    { key: "review_repos", module: "code-review", value: ["AidenHQ", "aidenhq-distro", "invoices-app"], set: true, known: true, switch: false, doc: "Repos. The repositories reviewed when a pull request opens." },
    { key: "review_when", module: "code-review", value: "When a PR opens, then once after the next push", set: false, known: true, switch: false, doc: "When. When a review runs." },
    { key: "review_skip", module: "code-review", value: ["Docs-only PRs"], set: true, known: true, switch: false, doc: "Skips. Pull requests that get no review." },
    { key: "quiet_start", module: "core", value: mock.welcome, set: true, known: true, switch: true, doc: "Nothing runs on a schedule until you turn it on." },
    { key: "notify_transports", module: "owner-channel", value: null, set: false, known: true, default: ["channel-telegram", "slack"], switch: false, doc: "Where the owner is reached, in order." },
  ],
  agents: [{
    recurring: [],
    key: "chief-of-staff", name: "Aiden", module: "core", model: "deepseek-flash", models: [], effort: "high", heartbeatHours: 4, canHeartbeat: true, efforts: ["low", "medium", "high"], department: OPS, graded: false, roles: [], connections: [], defaults: {},
    // A schedule with its next run, a paused one, an event routine and one setup hasn't applied yet.
    routines: [
      { key: "morning-brief", title: "Morning brief", schedules: [{ cron: "0 9 * * 1-5", timezone: "Asia/Dubai", label: "" }], id: "r1", paused: false, next: ahead(600), defaults: {} },
      { key: "weekly-digest", title: "Weekly digest", schedules: [{ cron: "0 17 * * 5", timezone: "Asia/Dubai", label: "" }], id: "r2", paused: true, defaults: {} },
      { key: "linear-issues", title: "Triage new Linear issues", schedules: [], id: "r3", paused: false, wakes: { connection: "linear", resource: "ENG", filter: { kind: ["issue"], contains: ["urgent", "outage"] } }, defaults: {} },
      { key: "slack-mentions", title: "Answer Slack mentions", schedules: [], wakes: "not_applied", defaults: {} },
    ],
  }, {
    key: "researcher", name: "Researcher", module: "core", model: "deepseek-flash", models: [], effort: "high", heartbeatHours: null, canHeartbeat: false, efforts: ["low", "medium", "high"], department: OPS, graded: false, roles: [], connections: [], defaults: {}, routines: [],
    // Recurring tasks the Researcher runs: one active with its next run, one paused.
    recurring: [
      { title: "Repeats: WOR-812", task: "WOR-812", summary: "Every Monday 09:00", paused: false, next: ahead(2000) },
      { title: "Repeats: WOR-790", task: "WOR-790", summary: "Every 2 weeks on Friday 17:00", paused: true },
    ],
  }], choices: { heartbeatHours: [1, 4, 24], models: ["deepseek-flash", "gpt-luna"] }, approvals: { pending: 2 },
  updates: { current: { name: "2026.11.19", product: "9c1496b" }, auto: true, timezone: "Asia/Dubai", checkedAt: ago(60), available: null, error: null, last: { release: "2026.11.19", outcome: "installed", at: ago(1300), by: "auto" } },
});

const connections = () => ({
  compiled: true, sourcesError: false,
  connections: [
    { name: "google_workspace", module: "google", kind: "connection", transport: "http", tools: { read: 14, write: 6 }, grants: [{ agent: "chief-of-staff", name: "Aiden", access: "write", tools: 20 }], setup: "google", probe: { ok: true, checkedAt: ago(2) }, signIn: null, google: { accounts: [{ email: "alex@example.com", primary: true, state: "ok", since: ago(5000) }] } },
    { name: "slack", module: "open-loops", kind: "connection", transport: "http", tools: { read: 9, write: 3 }, grants: [{ agent: "open-loops", name: "Tess", access: "read", tools: 9 }], setup: null, probe: { ok: true, checkedAt: ago(2) }, signIn: { state: "ok", configured: true, since: ago(9000) } },
    { name: "github", module: "engineering", kind: "connection", transport: "http", tools: { read: 22, write: 11 }, grants: [], setup: null, probe: { ok: false, status: 401, detail: "Token expired", checkedAt: ago(2) }, signIn: { state: "expired", configured: true, since: ago(60) } },
    { name: "jira", module: "engineering", kind: "connection", transport: "http", tools: { read: 7, write: 2 }, grants: [], setup: null, probe: null, signIn: { state: "missing", configured: false, since: ago(60) } },
    { name: "paperclip_tasks", module: "core", kind: "connection", transport: "stdio", tools: { read: 5, write: 5 }, grants: [], setup: null, probe: null, signIn: null },
  ],
  sources: [{ name: "slack", lastOk: ago(3), failing: false, stale: false }, { name: "gmail", lastOk: ago(400), failing: false, stale: true }],
});

const profile = (key: string) => {
  const a = roster.find((r) => r.key === key) ?? roster[0]!;
  return { id: a.id, key: a.key, name: a.name, ...(a.teammate ? { teammate: a.teammate } : {}), title: a.title, state: a.state, stateNote: a.stateNote, model: a.model, effort: "high", reportsTo: a.reportsTo, source: { module: "core", marketplace: "aidenhq", tier: "official", revision: "a1b2c3d" }, schedules: a.schedules };
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

const welcome = () => ({ finished: !mock.welcome, modelReady: true, recoveryKeyWaiting: mock.welcome && mock.key });
/** The Slack flow in the state ?slack= names (modules/slack/module.yaml, as GET /api/setup-flows serves it). */
const slackFlow = () => {
  const k = mock.slack;
  const signedIn = k !== "none";
  const bot = k === "full" || k === "old";
  return {
    module: "slack", order: 30, title: "Slack", label: "Read Slack as you",
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
  flows: ([
    { ...googleFlow(), present: { google_client_id: false, google_client_secret: false }, signedIn: false, paired: false, done: false, dismissed: false },
    slackFlow(),
    { module: "channel-telegram", order: 2, title: "Telegram", why: "Reach Aiden from your phone and approve with one tap.", effort: "3 minutes", steps: "1. Open @BotFather and create a bot.\n2. Paste its token below.", fields: [{ secret: "telegram_bot_token", label: "Bot token", pattern: "^\\d+:[\\w-]+$" }], present: { telegram_bot_token: false }, signedIn: false, paired: false, done: false, dismissed: false },
  ] as Record<string, any>[]).map((f): Record<string, any> => mock.connected ? { ...f, done: true, signedIn: true, paired: true, ...(f.advanced ? { advanced: { ...f.advanced, done: true } } : {}) } : { ...f, dismissed: hireMock.dismissed.has(f.module) }),
});

// The Reviews page: a watched repo, a PR run, two whole-repo batches, and the catalog a repo review offers.
const REVIEW_COMBO = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium" };
const RUN = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium", kind: "auto", why: null, tokens_in: 12000, tokens_out: 3000, duration_ms: 90000, important: 0, nit: 0, pre_existing: 0, full: false, incremental_from: null, posted: true, target: "pr", batch: null };
const reviewRuns = () => [
  { ...RUN, id: "cr-000000000001", repo: "acme/payments", number: 42, head: "a".repeat(40), status: "done", cost_usd: 0.4, important: 1, nit: 2, started: ago(30), ended: ago(28), title: "Retry failed charges" },
  { ...RUN, id: "cr-000000000002", repo: "acme/payments", number: 43, head: "b".repeat(40), status: "running", cost_usd: 0.1, started: ago(3), ended: null, important: 0, title: "Add idempotency keys to refunds" },
  { ...RUN, id: "cr-000000000003", repo: "acme/web", number: 9, head: "c".repeat(40), status: "skipped", why: "draft: a draft PR", cost_usd: 0, started: null, ended: ago(60), title: "WIP: new settings layout", kind: "auto" },
  { ...RUN, id: "cr-000000000004", repo: "acme/web", number: 7, head: "d".repeat(40), status: "done", cost_usd: 0.22, important: 0, nit: 1, started: ago(300), ended: ago(298), title: "Tidy the header", model: "openai/gpt-6.2-sol", engine: "codex-native", effort: "low", kind: "command" },
  { ...RUN, id: "cr-000000000005", repo: "acme/web", number: 5, head: "e".repeat(40), status: "failed", why: "the box ran out of time", cost_usd: 0.6, started: ago(900), ended: ago(880), title: "Upgrade the bundler" },
];
const FINDINGS = [
  { id: "f1", severity: "important", path: "src/billing/charge.ts", line: 88, end_line: 96, title: "A retried charge can post twice", why: "The idempotency key is written after the provider call, so a timeout between the two lets the retry charge again.", evidence: "88  const res = await provider.charge(card, amount);\n89  await store.put(key, res.id);\nA retry after a timeout at line 88 never sees the key.", fix_brief: "Write the key before calling the provider and treat an existing key as the answer." },
  { id: "f2", severity: "nit", path: "src/billing/retry.ts", line: 14, title: "Backoff has no jitter", why: "Every retry waits the same time, so a burst of failures retries together.", evidence: "14  await sleep(base * 2 ** n);", fix_brief: "Add up to 20% random jitter." },
  { id: "f3", severity: "nit", path: "src/billing/retry.ts", line: 31, title: "Unused import", why: "`Duration` isn't used.", evidence: "1  import { Duration } from './time';", fix_brief: "Remove it." },
];
let dismissed = false;
const runDetail = (id: string) => {
  const r = reviewRuns().find((x) => x.id === id) ?? reviewRuns()[0]!;
  const done = r.status === "done";
  const review = done ? { version: 1, repo: r.repo, pr: r.number, base: "0".repeat(40), head: r.head, engine: r.engine, model: r.model, effort: r.effort, incremental_from: null, full: false, coverage: { reviewed: ["src/billing/charge.ts", "src/billing/retry.ts", "test/charge.test.ts"], excluded: ["package-lock.json"], incomplete: null }, findings: r.important ? FINDINGS : [], withheld: { important: 0, nit: 1, pre_existing: 0 }, cost_usd: r.cost_usd, stale_guidance: [] } : null;
  const gate = r.number === 42 ? { tier: { state: "classified", tier: "trivial", rule: 7, why: "by a member, 8 lines, 1 file" }, verdict: dismissed ? "pass" : "wait", reasons: dismissed ? [] : [{ code: "findings", text: "1 important finding open: A retried charge can post twice (src/billing/charge.ts:88, id f1)", unblock: "fix and push, or record each outcome with code_review_resolve" }], head: r.head, open: dismissed ? [] : [{ id: "f1", path: "src/billing/charge.ts", line: 88, title: "A retried charge can post twice" }] } : null;
  return { run: { ...r, url: `https://github.com/${r.repo}/pull/${r.number}`, review_url: done ? `https://github.com/${r.repo}/pull/${r.number}#pullrequestreview-1` : undefined }, review, findings: review ? review.findings.map((f) => ({ id: f.id, severity: f.severity, path: f.path, line: f.line, title: f.title, outcome: f.id === "f1" && dismissed ? "dismissed" : null })) : [], gate };
};
// The Reviews page's tools (modules/code-review/service/src/config-tool.ts), as the kernel would relay them.
// The presets and default rules as modules/code-review/service/src/config.ts and kernel/sdk/src/tiers.ts serve them (trimmed lists).
const M = (engine: string, model: string, effort: string) => ({ engine, model, effort, mandatory: true });
const FLASH = "~deepseek/deepseek-flash-latest", SOL = "openai/gpt-6.2-sol", SONNET = "anthropic/claude-sonnet-5.5";
const NO = { on_open: [], on_push: [], push_rounds: 0 };
const PRESETS = {
  light: { skip: NO, trivial: { on_open: [M("codex", FLASH, "low")], on_push: [], push_rounds: 0 }, standard: { on_open: [M("codex", FLASH, "medium")], on_push: [], push_rounds: 0 }, sensitive: { on_open: [M("codex-native", SOL, "medium")], on_push: [M("codex-native", SOL, "low")], push_rounds: 1 } },
  standard: { skip: NO, trivial: { on_open: [M("codex", FLASH, "medium")], on_push: [], push_rounds: 0 }, standard: { on_open: [M("codex", FLASH, "medium")], on_push: [M("codex-native", SOL, "low")], push_rounds: 1 }, sensitive: { on_open: [M("codex-native", SOL, "medium"), M("claude-code", SONNET, "medium")], on_push: [M("codex-native", SOL, "low")], push_rounds: 2 } },
  thorough: { skip: NO, trivial: { on_open: [M("codex", FLASH, "medium")], on_push: [M("codex-native", SOL, "low")], push_rounds: 1 }, standard: { on_open: [M("codex-native", SOL, "medium"), M("codex", FLASH, "medium")], on_push: [M("codex-native", SOL, "low")], push_rounds: 2 }, sensitive: { on_open: [M("codex-native", SOL, "high"), M("claude-code", SONNET, "high")], on_push: [M("codex-native", SOL, "medium")], push_rounds: 3 } },
};
const DEFAULT_RULES = [
  { when: { repo_class: "critical" }, tier: "sensitive" },
  { when: { author: "bot", only_paths: ["**/package.json", "**/go.mod", "**/package-lock.json", "**/*.lock"] }, tier: "standard" },
  { when: { paths: [".github/**", "**/Dockerfile*", "**/package.json", "**/AGENTS.md", "**/*auth*", "**/*auth*/**", "**/*token*", "**/migrations/**", "**/config/**"] }, tier: "sensitive" },
  { when: { author: "outsider" }, tier: "sensitive" },
  { when: { repo_class: "sandbox" }, tier: "trivial" },
  { when: { lines_max: 0 }, tier: "sensitive" },
  { when: { lines_min: 600 }, tier: "sensitive" },
  { when: { author: "member", lines_max: 10, files_max: 20 }, tier: "trivial" },
  { tier: "standard" },
];
const SETTING = { repos: [
  { repo: "acme/payments", preset: "standard", by_tier: { sensitive: { on_open: [M("codex-native", SOL, "high"), M("claude-code", SONNET, "medium")], on_push: [M("codex-native", SOL, "low")], push_rounds: 3 } }, max_nits: 5, ignore: ["**/*.lock"] },
  { repo: "acme/web", preset: "light", repo_class: "sandbox", rules: [{ when: { base: ["release/*"] }, tier: "sensitive" }, { when: { lines_max: 3 }, tier: "skip" }, { tier: "trivial" }], drafts: true, forks: "auto", max_nits: 3 },
] };
let watched: any[] = [
  { ...SETTING.repos[0], preset: "standard", repo_class: "standard", rules: DEFAULT_RULES, custom: false, drafts: false, forks: "manual", day_spent_usd: 3.2, error: null, identity: "owner", prs: [
    { number: 44, title: "Rotate the session signing key", head: "f".repeat(40), tier: "sensitive", rule: 2, why: "touches src/auth/session.ts", facts: { lines: 84, files: 3, author: "member" } },
    { number: 43, title: "Add idempotency keys to refunds", head: "b".repeat(40), tier: "standard", rule: 8, why: "142 lines in 6 files, by a member", facts: { lines: 142, files: 6, author: "member" } },
    { number: 42, title: "Retry failed charges", head: "a".repeat(40), tier: "trivial", rule: 7, why: "by a member, 8 lines, 1 file", facts: { lines: 8, files: 1, author: "member" } },
    { number: 41, title: "Bump stripe from 14.2.0 to 14.3.1", head: "c".repeat(40), tier: "standard", rule: 1, why: "by a bot, only 2 matching files", facts: { lines: 0, files: 0, author: "bot" } },
    { number: 40, title: "Docs: explain refunds", head: "d".repeat(40), tier: null },
  ] },
  { ...SETTING.repos[1], custom: true, ignore: [], day_spent_usd: 0.8, error: null, identity: "app", prs: [{ number: 9, title: "Fix a typo in the footer", head: "e".repeat(40), tier: "skip", rule: 1, why: "1 line", facts: { lines: 1, files: 1, author: "member" } }] },
];
function reviewCall(name: string, a: any): any {
  const sc = (v: unknown) => ({ result: { content: [{ type: "text", text: "ok" }], structuredContent: v } });
  switch (name) {
    case "code_review_overview": return sc({ runs: mock.empty ? [] : reviewRuns(), batches: mock.empty ? [] : reviewBatches(), repos: { day_spent_usd: 4, errors: [], repos: mock.empty ? [] : watched }, engines: ENGINES, presets: PRESETS, default_rules: DEFAULT_RULES, setting: mock.empty ? { repos: [] } : SETTING, problems: [] });
    case "code_review_run_detail": return sc(runDetail(a.id));
    case "code_review_report": return sc({ markdown: REPORT });
    case "code_review_catalog": return sc({ repo: a.repo, ...catalog() });
    case "code_review_available": return sc({ repos: [{ repo: "acme/payments", private: true }, { repo: "acme/web", private: true }, { repo: "acme/docs", private: false }].filter((x) => x.repo.includes(a.q ?? "")) });
    case "code_review_run": return sc(a.repo ? { batch: "b-000000000003", repo: a.repo, sha: a.commit, options: a.options, runs: [] } : { runs: [{ ...reviewRuns()[1], id: "cr-000000000009" }] });
    case "code_review_dismiss": dismissed = true; return sc({ dismissed: a.id });
    case "code_review_configure": return sc({ changes: [...(a.watch ?? []).map((w: any) => `${w.repo} updated`), ...(a.unwatch ?? []).map((r: string) => `stopped watching ${r}`)], _aidenhq: { settings_change: [{ kind: "setting", key: "code_review", value: { repos: a.watch ?? [] } }] } });
  }
  return undefined;
};
const reviewBatches = () => [
  { id: "b-000000000001", repo: "acme/payments", sha: "4e1a9c2".padEnd(40, "0"), sha7: "4e1a9c2", verdict: "concerns", cost_usd: 6.8, status: "done", started: ago(300), ended: ago(260), option_names: ["Codex code review", "Claude Code review", "Trail of Bits security audit", "React performance (Vercel)"], published: true, primer_url: "https://primer.example.com/d/4e1a9c2", runs: [{ id: "cr-000000000011", option: "cor.codex-native", names: ["Codex code review"], status: "done", important: 1, nit: 2, pre_existing: 0 }, { id: "cr-000000000012", option: "perf.react", names: ["React performance (Vercel)"], status: "done", important: 0, nit: 0, pre_existing: 0, area: "web" }, { id: "cr-000000000013", option: "perf.react", names: ["React performance (Vercel)"], status: "skipped", important: 0, nit: 0, pre_existing: 0, area: "api", unchanged: "unchanged since 3d4c0aa" }], areas: 2 },
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
const catalog = () => ({ sha: "6018f7c2f0b7d".padEnd(40, "0"), options: CATALOG_ROWS.map(([id, name, description, lens, kind, recommended, runs_code, cost, repo, unavailable]) => ({ id, name, description, lens, kind, recommended: recommended && !unavailable, runs_code, cost, source: { repo, version: "1.0.0", licence: "MIT" }, ...(kind !== "tool" ? { model: "~deepseek/deepseek-flash-latest", effort: "medium" } : {}), ...(PAST[id] ? { past: PAST[id] } : {}), ...(unavailable ? { unavailable } : {}) })) });
const ENGINES = { codex: { label: "Codex", accepts: { tools: true }, efforts: ["low", "medium", "high"], models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "deepseek/deepseek-v4-pro", "z-ai/glm-5.3"], run_usd: 5 }, "claude-code": { label: "Claude Code", accepts: { provider: "anthropic" }, efforts: ["low", "medium", "high"], models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5"], run_usd: 5 }, codegenie: { label: "Codegenie", accepts: { tools: true }, efforts: ["low", "medium"], models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest"], run_usd: 5 }, "codex-native": { label: "Codex native", accepts: { tools: true }, efforts: ["low", "medium"], models: ["openai/gpt-6.2-sol", "~openai/gpt-sol-latest"], run_usd: 5 } };
const REPORT = "# Repo review: acme/payments\n\n**Verdict:** concerns, at `4e1a9c2`\n\n## Security\n\n- **Important** `src/billing/charge.ts:88`: a retried charge can post twice.\n  - Evidence: the idempotency key is written after the provider call.\n  - Found by: sec.quick-scan\n\n## Coverage\n\n| Option | Result |\n| --- | --- |\n| sec.quick-scan | done |\n| maint.knip | done |\n\nCost $6.80.";


// Home (GET /api/home), as V3Home shows it. Snoozed rows leave the next read; `nocal` drops the calendar block.
let lastBody: any = {};
const homeMock = { snoozed: new Set<string>(), nocal: false, quiet: false, many: false };
const fref = (key: string, state: "idle" | "working" | "needs" = "idle") => {
  const a = roster.find((r) => r.key === key)!;
  return { key, name: a.name, job: a.teammate?.job ?? "", face: a.teammate?.face ?? null, state };
};
const sinceItem = (key: string, text: string, min: number, task: string | null, kind = "done") => ({ teammate: fref(key), text, at: ago(min), task, kind });
/** A row's task details (home.ts aboutTask): a Source block when Intake or the meeting notes filed it. */
const about = (min: number, o: Record<string, unknown> = {}) => ({ created: ago(min), labels: [] as string[], project: null as string | null, parent: null as { identifier: string; title: string } | null, holder: null as string | null, source: null as unknown, ...o });
const slackSrc = (channel: string, from: string, min: number, ts: string) => ({ type: "Slack", url: `https://acme.slack.com/archives/C04NQ7B1L/p${ts}`, fields: [["Channel", channel], ["From", from], ["Sent", new Date(Date.now() - min * 60_000).toISOString().slice(0, 16) + "Z"]] });
const homeData = () => {
  if (mock.empty) return { as_of: new Date().toISOString(), since_from: ago(1440), since_complete: true, greeting: { needs: 0 }, needs: [], since: null, world: { waiting_on: null, today: null }, team: [] };
  const needs = [
    { id: "id-841", kind: "answer", teammate: fref("open-loops", "needs"), since: ago(7200), task: { identifier: "WOR-841", title: "Chase Jonas Weber for the signed contract" }, question: "Send a chaser to Jonas Weber about the Northwind contract?", detail: "Hi Jonas, checking in on the signed vendor contract. Is anything holding it up on your side? We're speaking at 16:30 today, happy to cover it then.", options: ["Send", "Edit", "Not now"], questions: [{ question: "Send a chaser to Jonas Weber about the Northwind contract?", options: ["Send", "Edit", "Not now"] }], waitSince: ago(7200), about: about(9 * 1440, { labels: ["follow-up"], project: "p-launch", parent: { identifier: "WOR-843", title: "Jonas Weber · signed contract" }, holder: "Tess", body: "Jonas promised the signed Northwind vendor contract by **Nov 20**. Nothing has arrived and he has been quiet for 5 days.\n\n- Contract: Northwind master services agreement\n- Last message: Nov 22, \"will send it over tomorrow\"" }) },
    { id: "id-815", kind: "answer", teammate: fref("researcher", "needs"), since: ago(40), task: { identifier: "WOR-815", title: "Weekly metrics digest" }, question: "Weekly metrics digest: compare against last week, or the same week last month?", detail: undefined, options: ["Last week", "Same week last month"], questions: [{ question: "Which week should the digest compare against?", options: ["Last week", "Same week last month"] }], waitSince: ago(40), about: about(300, { labels: ["digest"], holder: "Rhea", body: "Build the weekly metrics digest for the leadership sync: signups, activation, revenue and churn, each with its change." }) },
    { id: "k-00000000000000a2", kind: "approval", teammate: fref("ship", "needs"), since: ago(50), task: { identifier: "WOR-806", title: "Runner timeout" }, question: "Raise the Platform Engineer's run timeout to 45 minutes?", card: approval("k-00000000000000a2", { identifier: "WOR-806", action: "push", sentence: "Raise the Platform Engineer's run timeout to 45 minutes", reads: "instance.yaml", requestedBy: "Sam" }), about: about(70, { labels: ["engineer"], project: "p-infra", holder: "Sam", parent: { identifier: "WOR-801", title: "Runner reliability" } }) },
    { id: "k-00000000000000a1", kind: "approval", teammate: fref("app-maintainer", "needs"), since: ago(120), task: { identifier: "WOR-818", title: "Hiring pipeline app" }, question: "Let the Hiring pipeline app read your “Recruiting” Gmail label?", card: approval("k-00000000000000a1", { sentence: "Let the Hiring pipeline app read your “Recruiting” Gmail label", reads: "Read only · that one label", requestedBy: "Iris" }), about: about(200, { project: "p-hiring", holder: "Iris" }) },
    // People waiting on the owner's reply (open needs-response tasks Intake filed), after the teammates' asks.
    { id: "id-861", kind: "open", teammate: fref("chief-of-staff"), since: ago(2900), task: { identifier: "WOR-861", title: "Reply to Priya Nair: can you approve the Q1 hiring plan?" }, question: "can you approve the Q1 hiring plan?", reply: { person: "Priya Nair", source: "slack" }, about: about(2900, { labels: ["needs-response"], project: "p-hiring", holder: "Aiden", source: slackSrc("#leadership", "Priya Nair", 2900, "1732601234000100"), reason: "Priya asks you to approve the Q1 hiring plan before Friday's budget review.", suggested: "Read the plan in the thread and reply with approval or the changes you want." }) },
    { id: "id-862", kind: "open", teammate: fref("chief-of-staff"), since: ago(300), task: { identifier: "WOR-862", title: "Reply to Dana Cho: Northwind security questionnaire" }, question: "Northwind security questionnaire", reply: { person: "Dana Cho", source: "gmail" }, about: about(300, { labels: ["needs-response", "email"], holder: "Aiden", source: { type: "Email", url: "https://mail.google.com/mail/u/0/#all/18c2f0a9b1d4e5f6", fields: [["Account", "you@acme.com"], ["From", "Dana Cho <dana@northwind.com>"], ["Subject", "Northwind security questionnaire: 3 open questions"], ["Received", new Date(Date.now() - 300 * 60_000).toISOString().slice(0, 16) + "Z"]] }, reason: "Dana needs answers to three questions about data retention and SSO before Northwind signs.", suggested: "Answer the three questions, or forward to Security with a deadline." }) },
    // ?many=1: more than a card lists (the newest ten show), with long titles.
    ...(homeMock.many ? Array.from({ length: 9 }, (_, i) => ({ id: `id-9${i}`, kind: "open", teammate: fref("chief-of-staff"), since: ago(20 + i * 90), task: { identifier: `WOR-9${i}`, title: "Reply" }, question: "Could you confirm whether the revised statement of work for the second phase of the Northwind integration, including the security addendum, is approved on your side before Friday's call?", reply: { person: ["Marta Quinn", "Ravi Shah", "Elena Petrova"][i % 3]!, source: i % 2 ? "slack" : "gmail" } })) : []),
  ].filter((n) => !homeMock.quiet && ![...homeMock.snoozed].some((k) => k === n.id || k.startsWith(`${n.id}:`))); // an answer row's key carries its wait
  const items = [
    sinceItem("ship", "Invoices export v2 shipped. PR #812 merged at 06:10 after review.", 140, "WOR-812"),
    sinceItem("open-loops", "6 chasers sent overnight; Priya and Omar replied.", 200, "WOR-842", "digest"),
    sinceItem("meetings", "Leadership sync notes: 4 actions, 2 of them yours.", 300, "WOR-811", "fyi"),
    sinceItem("reviewer-manager", "2 PRs ready to merge.", 320, "WOR-819"),
    sinceItem("app-maintainer", "Offsite planner deploying now.", 360, "WOR-823", "fyi"),
    sinceItem("ship", "CI runners upgraded.", 400, "WOR-801", "closed"),
    sinceItem("open-loops", "Lena Park acknowledged the hiring loop feedback.", 420, null, "fyi"),
    sinceItem("meetings", "Board prep brief ready for Thursday.", 500, "WOR-733"),
    sinceItem("reviewer-manager", "Findings on PR #817 fixed and re-checked.", 560, "WOR-817"),
  ];
  const groups = [...new Set(items.map((i) => i.teammate.key))].map((k) => ({ teammate: fref(k), latest: items.find((i) => i.teammate.key === k)!, count: items.filter((i) => i.teammate.key === k).length }));
  return {
    as_of: new Date().toISOString(), since_from: ago(600), since_complete: true, greeting: { needs: needs.length }, needs,
    since: homeMock.quiet ? null : { groups, items, total: items.length },
    world: {
      waiting_on: [
        { id: "w-843", identifier: "WOR-843", title: "Jonas Weber · signed contract", age_days: 9, quiet_days: 5, about: about(9 * 1440, { labels: ["waiting-on"], project: "p-launch", holder: "Tess", source: slackSrc("DM with Jonas Weber", "Jonas Weber", 9 * 1440, "1731900000000200"), reason: "Jonas promised the signed Northwind contract by Nov 20.", suggested: "Tess chases him if it hasn't arrived by Friday." }) },
        { id: "w-844", identifier: "WOR-844", title: "Priya Nair · design doc review", age_days: 2, quiet_days: 2, about: about(2 * 1440, { labels: ["waiting-on"], source: { type: "Meeting", url: null, fields: [["Meeting", "Design review (2026-11-25)"], ["Note", "work/meetings/2026-11-25 Design review.md"], ["Quote", "\"I'll get my comments on the doc by Thursday\""]] }, reason: "Priya committed to reviewing the design doc." }) },
        { id: "w-845", identifier: "WOR-845", title: "Lena Park · hiring loop feedback", age_days: 1, quiet_days: 1 },
        { id: "w-846", identifier: "WOR-846", title: "Omar Haddad · Q1 budget numbers", age_days: 3, quiet_days: 0 },
        ...(homeMock.many ? Array.from({ length: 9 }, (_, i) => ({ id: `w-9${i}`, identifier: `WOR-95${i}`, title: `Vendor ${i + 1} · countersigned data processing agreement with the revised liability cap and the sub-processor list for the EU region`, age_days: 4 + i, quiet_days: i })) : []),
      ].filter((w) => !homeMock.snoozed.has(w.id)),
      today: homeMock.nocal ? null : { timezone: "Asia/Dubai", events: [
        { id: "ev1", start: `${new Date().toISOString().slice(0, 10)}T06:00:00Z`, title: "Leadership sync", all_day: false, url: "https://meet.google.com/abc-defg-hij", prep: "WOR-811" },
        { id: "ev2", start: `${new Date().toISOString().slice(0, 10)}T10:00:00Z`, title: "1:1 Priya", all_day: false, url: "https://www.google.com/calendar/event?eid=mock" },
        { id: "ev3", start: `${new Date().toISOString().slice(0, 10)}T12:30:00Z`, title: "Northwind call · Jonas", all_day: false, url: "https://acme.zoom.us/j/123456789", prep: "WOR-843" },
      ] },
    },
    // The whole team, always: those with news first (home.ts teamRow).
    team: [
      ...(homeMock.quiet ? [] : [
        { teammate: fref("open-loops", "needs"), line: "Priya and Omar replied overnight · Jonas 5 days quiet" },
        { teammate: fref("reviewer-manager", "working"), line: "2 PRs ready to merge" },
        { teammate: fref("app-maintainer", "needs"), line: "Offsite planner deploying now" },
      ]),
      ...roster.filter((r) => r.teammate && (homeMock.quiet || !["open-loops", "reviewer-manager", "app-maintainer"].includes(r.key))).map((r) => ({ teammate: fref(r.key), line: "Nothing new" })),
    ],
  };
};
/** One agent's chats (GET /api/chats?agent=): Aiden has three, Max two, a settled page for each. */
const agentChats = (key: string, state: string, offset = 0) => {
  const a = roster.find((r) => r.key === key);
  if (!a) return undefined;
  const mk = (n: number, title: string, min: number, preview: string, s: ReturnType<typeof st> = STATES.chatTurn) => ({ identifier: `WOR-${n}`, title, open: state !== "settled", agent: { key, name: a.name }, state: named(`WOR-${n}`, s), updatedAt: ago(min), preview: { text: preview, at: ago(min), from: "agent" }, unread: false, ...(state === "settled" ? { settled: true } : {}) });
  const rows: Record<string, ReturnType<typeof mk>[]> = state === "settled"
    ? { "chief-of-staff": [mk(760, "Plan the offsite agenda", 3000, "Agenda sent to the leads.")], "reviewer-manager": [mk(761, "Review the docs repo too?", 5000, "Done: docs repo added.")] }
    : { "chief-of-staff": [mk(820, "Why is the invoices release stuck?", 2, "Sam owns this, so I asked Sam.", STATES.running), mk(815, "Weekly metrics digest looks off", 40, "Which week should I compare against?"), mk(799, "Draft a reply to the hiring agency", 1500, "Sent.")], "reviewer-manager": [mk(830, "Also review PRs on aidenhq-distro", 6, "Done. aidenhq-distro is now reviewed like your other repos."), mk(831, "Why did #812 take 3 rounds?", 30, "Two findings were real, one was mine to fix.")] };
  // Settled lists have a next page (offset 100: one older chat each), so "Show older" is exercised.
  if (state === "settled" && offset >= 100) return { chats: offset === 100 ? [mk(700 + offset / 100, "Rotate the review key", 9000, "Rotated.")] : [], agents: [{ key, name: a.name }], more: false, next_offset: offset + 1 };
  return { chats: rows[key] ?? [], agents: [{ key, name: a.name }], more: state === "settled", next_offset: 100 };
};

function route(method: string, url: URL): [number, unknown] {
  const one = /^\/api\/approvals\/(k-[0-9a-f]{16})$/.exec(url.pathname)?.[1];
  if (one && method === "GET") { const a = approvals().find((x) => x.id === one); return a ? [200, { approval: a }] : [404, { error: "no such card" }]; }
  const p = url.pathname;
  if (method === "POST" && /^\/api\/issues\/[^/]+\/answer$/.test(p)) return p.split("/")[3] === "WOR-821" ? [409, { error: "Already answered, or the question changed." }] : [200, { identifier: p.split("/")[3], message: "m-1" }];
  const opened = method === "POST" ? /^\/api\/sessions\/(id-93\d)\/open$/.exec(p) : null;
  if (opened) { const tok = `${"mock".repeat(6)}.${"sig".repeat(15)}`; return [200, { term: `/sessions/${opened[1]}/${tok}/term/` }]; }
  if (method === "POST" && p === "/api/home/seen") return [200, { seen: lastBody.as_of }];
  if (method === "POST" && p === "/api/home/snooze") { if (lastBody.on) homeMock.snoozed.add(lastBody.id); else homeMock.snoozed.delete(lastBody.id); return [200, lastBody.on ? { until: TOMORROW_8 } : {}]; }
  // Hiring and onboarding.
  if (p === "/api/teammates") return [200, teammates()];
  if (p === "/api/teammates/queue") { if (method === "PUT") hireMock.queue = { ...lastBody }; return [200, hireMock.queue]; }
  const tm = /^\/api\/teammates\/([^/]+)\/(start|trial)$/.exec(p);
  if (tm) {
    const ref = decodeURIComponent(tm[1]!);
    if (!HIRE.some((h) => h.ref === ref)) return [404, { error: "no such teammate" }];
    if (tm[2] === "trial") return [200, trial(ref)];
    if (lastBody.trial !== false && !hireMock.trials.has(ref)) hireMock.trials.set(ref, Date.now());
    return [200, { resumed: ["inbox-scan", "open-loops-sweep"], trials: lastBody.trial === false ? [] : ["inbox-lookback"] }];
  }
  if (method === "POST" && p === "/api/notify/test") return [200, { sent: true }];
  if (method === "POST" && p === "/api/welcome/finish") return (mock.welcome = false, hireMock.finishedAt = Date.now(), [200, { ok: true }]);
  if (method === "POST" && /^\/api\/setup-flows\/[^/]+\/dismiss$/.test(p)) return (hireMock.dismissed.add(p.split("/")[3]!), [200, { ok: true }]);
  if (method === "POST" && p === "/api/settings/change") {
    for (const ch of lastBody.changes ?? []) if (ch.kind === "module" && ch.on && HIRE.some((h) => h.id === ch.name) && !hireMock.filed.has(ch.name)) hireMock.filed.set(ch.name, { at: Date.now(), n: 880 + hireMock.filed.size });
    return [200, { identifier: "WOR-900" }];
  }
  if (method === "POST" && p === "/api/chats" && lastBody.agent === "architect") return (hireMock.chats.set("WOR-860", { at: Date.now(), text: String(lastBody.text ?? "") }), [200, { identifier: "WOR-860" }]);
  if (p === "/api/chats/WOR-860" && hireMock.chats.has("WOR-860")) return [200, hireChat("WOR-860")];
  if (method === "POST" && p === "/api/chats") { const to = /^@(\w+)/.exec(String(lastBody.text ?? ""))?.[1]?.toLowerCase(); const mate = lastBody.agent === "reviewer-manager" || (to && roster.find((r) => r.teammate && r.name.toLowerCase() === to)); return [200, { identifier: mate ? "WOR-830" : "WOR-820" }]; }
  if (method !== "GET") return [200, { ok: true, identifier: "WOR-900", id: "id-900" }];
  if (p.startsWith("/api/models/")) return [200, { default: "openrouter/~deepseek/deepseek-flash-latest", models: ["openrouter/~deepseek/deepseek-flash-latest", "openrouter/~openai/gpt-luna-latest", "openrouter/z-ai/glm-5.3"], efforts: ["low", "medium", "high"] }];
  const m = (re: RegExp) => re.exec(p);
  switch (p) {
    case "/api/model-catalog": return [200, { models: MODEL_CATALOG }];
    case "/api/session": return [200, { mode: "lan", account: { id: "u1", email: mock.email, name: "Alex", role: "admin", owner: true }, signInConnect: true, adminUrl: "http://127.0.0.1:3120" }];
    case "/api/board": return [200, board()];
    case "/api/sessions": return mock.sessions === "error" ? [502, { error: "the kernel didn't answer: connect ECONNREFUSED" }] : [200, { enabled: mock.sessions !== "off", agent: "session", sessions: mock.sessions === "fresh" || mock.sessions === "off" ? [] : SESSIONS() }];
    case "/api/search": return search(url.searchParams.get("q") ?? "", url.searchParams.get("after"));
    case "/api/welcome": return [200, welcome()];
    case "/api/organisations": return [200, mock.slack === "org" ? { organisations: [{ id: "acme", name: "Acme", domains: ["acme.example"], connections: ["slack"] }], suggested: "acme", chosen: "acme", applied: { slack: "acme" } } : mock.org ? { organisations: [{ id: "example", name: "Example Inc", domains: ["example.com"], connections: ["google", "github"] }], suggested: mock.email.endsWith("@example.com") ? "example" : null, chosen: null, applied: {} } : { organisations: [], suggested: null, chosen: null, applied: {} }];
    case "/api/setup-flows": return [200, flows()];
    case "/api/home": return [200, { ...homeData(), start: homeStart() }];
    case "/api/chats": if (url.searchParams.get("agent")) { const r = agentChats(url.searchParams.get("agent")!, url.searchParams.get("state") ?? "active", Number(url.searchParams.get("offset")) || 0); return r ? [200, r] : [404, { error: "no such agent" }]; } return [200, { chats: chatRows(), agents: [{ key: "chief-of-staff", name: "Aiden", front: true }, ...roster.slice(1).map((a) => ({ key: a.key, name: a.name }))] }];
    case "/api/lane": return [200, { agents: [] }];
    case "/api/needs-you": return [200, mock.empty ? { counts: { needs_you: 0, failed: 0, unexplained_idle: 0 }, approvals: 0, items: [] } : { counts: { needs_you: 6, failed: 1, unexplained_idle: 3 }, approvals: 2, items: [
      { identifier: "WOR-801", title: "Chase Jonas for the signed contract", agent: "Tess", state: named("WOR-801", ASK), ask: { question: "Send this chaser to Jonas?", detail: "Hi Jonas, a quick nudge on the signed contract from last week. Could you send it over by Friday? Thanks!", waitSince: ago(120), questions: [{ question: "Send this chaser to Jonas?", options: ["Send", "Not now"] }] } },
      { identifier: "WOR-815", title: "Weekly metrics digest looks off", agent: "Aiden", state: named("WOR-815", ASK), ask: { question: "A few things before I rebuild the digest.", waitSince: ago(75), questions: [{ question: "Which week should I compare against?", options: ["Last week", "Same week last month"] }, { question: "Which channels should get it?", options: ["#metrics", "#leads", "#exec"], multi: true }] } },
      { identifier: "WOR-821", title: "Design the invoice screens", agent: "UI Designer", state: named("WOR-821", ASK), ask: { question: "What should the empty invoice list say?", waitSince: ago(30), questions: [{ question: "What should the empty invoice list say?", options: [] }] } },
      { identifier: "WOR-790", title: "Fix the sbom job", agent: "Engineer", state: named("WOR-790", { ...WORKING_CARD, refLabel: "approve the push to main" }) },
      { identifier: "WOR-795", title: "A task handed back to you", agent: "Engineer", state: named("WOR-795", STATES.handback) },
      { identifier: "WOR-802", title: "Slack ingest", agent: "Tess", state: named("WOR-802", FAILED) },
      { identifier: "WOR-705", title: "Primer lint", agent: "Engineer", state: named("WOR-705", UNKNOWN) },
      { identifier: "WOR-812", title: "Reply to Acme's renewal question", agent: "Tess", state: named("WOR-812", STATES.orphaned) },
      { identifier: "WOR-650", title: "An old task whose history expired", agent: "Engineer", state: named("WOR-650", EXPIRED) },
    ] }];
    case "/api/approvals": return [200, { approvals: approvals() }];

    case "/api/agents/roster": return [200, { roster: mock.empty ? roster.slice(0, 1) : roster }];
    case "/api/agents": return [200, { sessions: [{ id: "s1", agent: "Engineer", agentId: "a3", state: "working", startedAt: ago(12), said: "Running the export tests", run: { identifier: "WOR-790", title: "Ship the invoices app's export" }, tasks: [] }, { id: "s2", agent: "Nora", agentId: "a7", state: "working", startedAt: ago(3), said: "Summarising the leadership sync", run: { identifier: "WOR-840", title: "Summarise yesterday's leadership sync and file the four action items with their owners" }, tasks: [] }], finished: [], roster }];
    case "/api/apps": return [200, { apps: apps() }];
    case "/api/app-admins": return [200, { apps: [] }];
    case "/api/modules": return [200, { modules: modules(), advisories: [] }];
    case "/api/modules/browse": return [200, { modules: [{ name: "hiring", id: "hiring", browse: false, description: "Screens candidates and schedules interviews.", marketplace: "aidenhq", tier: "official", adds: ["agent", "app"], installed: false }] }];
    case "/api/marketplaces": return [200, { marketplaces: [{ name: "aidenhq", source: "github:aidenhq/modules", sha: "a1b2c3d", modules: 14, newer: false }] }];
    case "/api/settings": return [200, settingsData()];
    case "/api/settings/changes": return [200, { changes: [...hireChanges(), ...notesChange()] }];
    case "/api/settings/connections": return [200, connections()];
    case "/api/accounts": return [200, { accounts: [{ id: "u1", email: "alex@example.com", name: "Alex", role: "admin", owner: true, twoFactorEnabled: true, disabled: false, lockedUntil: null, createdAt: ago(40000) }], me: "u1" }];
    case "/api/accounts/sessions": return [200, { sessions: [{ id: "s1", userAgent: "Safari on macOS", ipAddress: "192.0.2.10", createdAt: ago(2000), updatedAt: ago(1), current: true }] }];
    case "/api/costs/features": return [200, { features: [], unattributed: { usd: 0, calls: 0 } }];
  }
  let x: RegExpExecArray | null;
  if ((x = m(/^\/api\/chats\/(WOR-93\d)$/))) { const c = sessionChat(x[1]!); return c ? [200, c] : [404, { error: "no such chat" }]; }
  if ((x = m(/^\/api\/chats\/([^/]+)$/))) return [200, chatDetail(decodeURIComponent(x[1]!))];
  if ((x = m(/^\/api\/issues\/([^/]+)\/feature-cost$/))) return [200, { cost: null }];
  if ((x = m(/^\/api\/issues\/([^/]+)\/lineage$/))) return [200, lineage(decodeURIComponent(x[1]!))];
  if ((x = m(/^\/api\/issues\/([^/]+)$/))) {
    const ref = decodeURIComponent(x![1]!);
    // A crew part of WOR-790: the Engineer's issue, opened from that task's agent tab.
    if (ref === "WOR-791") return [200, { ...card(791, "Add CSV export"), parent: { identifier: "WOR-790", title: "Ship the invoices app's export" }, assignee: "engineer", editable: true, labelIds: [], replyTarget: "The Engineer reads replies here and continues the coding job.", scheduled: null, recurring: null, comments: [], files: [], crew: [], grade: gradeFor("WOR-790"), milestones: [] }];
    const c = Object.values(board().buckets).flat().find((k) => k.identifier === ref || k.id === ref) ?? card(790, "Ship the invoices app's export");
    const crew = (c as { crew?: { agent: string }[] }).crew ?? [];
    const onTask = board().assignees.find((a) => a.key === crew[0]?.agent);
    const replyTarget = onTask ? (onTask.kind === "engineer" ? "The Engineer reads replies here and continues the coding job." : `${onTask.name} reads replies here.`) : "No agent is assigned; this message stays on the task. @name brings an agent in.";
    return [200, { ...c, working: (c as { working?: unknown }).working ?? null, description: "Add a **CSV export** to the invoices app and a monthly total row.\n\n- Export respects the current filter\n- Totals in the account currency", bucket: "today", editable: true, labelIds: [], replyTarget, scheduled: null, recurring: null, comments: [{ id: "k1", body: "Started on the export; tests next.", author: { kind: "agent", name: "Engineer" }, createdAt: ago(20) }], files: [], parent: null, crew, grade: gradeFor(ref), milestones: milestones() }];
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
  if ((x = m(/^\/api\/agents\/([^/]+)\/scorecard$/))) return [200, { done: { count: 14, prior: 9, tasks: [] }, approvals: { filed: 6, rejected: 1, priorRejected: 2 }, runsFailed: 1, cost: { usd: 4.18, prior: 5.02, perDone: 0.3, billed: true }, daily: days.map((day, i) => ({ day, done: [1, 3, 2, 0, 4, 2, 2][i], costUsd: [0.4, 0.9, 0.6, 0.1, 1.1, 0.5, 0.58][i] })) }];
  if ((x = m(/^\/api\/modules\/([^/]+)$/))) {
    const mod = modules().find((r) => r.id === decodeURIComponent(x![1]!)) ?? modules()[0]!;
    return [200, { module: mod, agents: mod.agents.map(profile), ongoing: [], routines: [], authority: { connections: mod.connections, writes: [{ kind: "push", tier: 1 }], secrets: [], prompts: [], readme: `# ${mod.name}\n\n${mod.description}` }, neededBy: mod.neededBy, requires: mod.requires }];
  }
  return [404, { error: `mock: no fixture for ${p}` }];
}

/** ttyd's page and opencode's web UI, drawn by hand: only what the frame shows, so the layout can be judged. */
function fakeScreen(kind: "term" | "web", title: string) {
  if (kind === "term")
    return `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0b0d12;color:#d6dbe6;font:13px/1.55 ui-monospace,Menlo,monospace;padding:14px 16px;overflow:hidden"><pre style="margin:0;white-space:pre-wrap"><span style="color:#8b93a7">opencode 1.19.6  ·  deepseek-flash  ·  ~/sessions/WOR-931</span>

<span style="color:#4ade80">&gt;</span> ${title}

<span style="color:#8b93a7">  $ gh pr view 412 --json state,statusCheckRollup</span>
  {"state":"MERGED","statusCheckRollup":[{"conclusion":"SUCCESS"}]}
<span style="color:#8b93a7">  $ git fetch origin &amp;&amp; git rebase origin/main</span>
  Successfully rebased and updated refs/heads/stack-413.
<span style="color:#8b93a7">  $ npm test -- --run</span>
  <span style="color:#4ade80">✓</span> 214 tests passed (38.2s)

  #412 merged. Merging #413 now.
  <span style="color:#fbbf24">●</span> Waiting for CI on #413
<span style="color:#4ade80">█</span></pre>`;
  return `<!doctype html><meta charset=utf-8><body style="margin:0;background:#111318;color:#e6e8ee;font:14px/1.5 system-ui,sans-serif"><div style="padding:14px 16px;border-bottom:1px solid #262a33;font-weight:600">${title}</div><div style="padding:16px;display:grid;gap:12px"><div style="background:#1a1d24;border-radius:8px;padding:10px 12px">Get the widgets stack merged: #412 first, then #413.</div><div>Rebased the stack on main. <b>#412</b> is green; starting the merge.</div><div style="color:#8b93a7">ran <code>gh pr merge 412</code></div></div><div style="position:fixed;left:12px;right:12px;bottom:12px;background:#1a1d24;border:1px solid #2c303a;border-radius:10px;padding:12px;color:#8b93a7">Ask anything…</div>`;
}

createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/__mock") {
    if (url.searchParams.has("slowSessions")) mock.slowSessions = Number(url.searchParams.get("slowSessions"));
    for (const k of ["sessions", "term"] as const) if (url.searchParams.has(k)) mock[k] = url.searchParams.get(k) ?? mock[k];
    for (const k of ["welcome", "empty", "org", "connected", "key"] as const) if (url.searchParams.has(k)) mock[k] = url.searchParams.get(k) === "1";
    // Onboarding starts over: nothing filed, queued, tried or skipped.
    if (url.searchParams.get("welcome") === "1") Object.assign(hireMock, { filed: new Map(), dismissed: new Set(), trials: new Map(), queue: { next: [], later: [] }, finishedAt: 0, chats: new Map() });
    if (url.searchParams.has("email")) mock.email = url.searchParams.get("email") ?? mock.email;
    if (url.searchParams.has("slow")) mock.slow = Number(url.searchParams.get("slow"));
    if (url.searchParams.has("search")) mock.search = url.searchParams.get("search") ?? "ok";
    if (url.searchParams.has("many")) homeMock.many = url.searchParams.get("many") === "1";
    if (url.searchParams.has("nocal")) homeMock.nocal = url.searchParams.get("nocal") === "1";
    if (url.searchParams.has("quiet")) homeMock.quiet = url.searchParams.get("quiet") === "1";
    if (url.searchParams.has("slack")) mock.slack = url.searchParams.get("slack") ?? "none";
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mock));
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("event: ping\ndata: {}\n\n");
    const t = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 20_000);
    return req.on("close", () => clearInterval(t));
  }
  if (url.pathname === "/api/pages/code-review/frame") {
    const dir = new URL("../../../../modules/code-review/service/src/", import.meta.url), read = (f: string) => readFileSync(new URL(f, dir), "utf8");
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_CSP }).end(read("page.html").replace("/*kit:css*/", () => read("page-kit.css")).replace("/*kit:js*/", () => read("page-kit.js")));
  }
  // A module-shipped teammate face (the board's GET /api/faces/<key>): one neutral fixture.
  if (url.pathname === "/api/faces/acme-bot") return res.writeHead(200, { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" }).end(readFileSync(new URL("./acme-bot.svg", import.meta.url)));
  if (url.pathname.startsWith("/api/faces/")) return res.writeHead(404).end();
  if (url.pathname === "/api/pages/notes/frame") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_CSP }).end(exampleView());
  // A session's terminal and web view: stand-ins for ttyd and opencode's web UI behind the board's proxy (src/sessions.ts).
  const frame = /^\/sessions\/(id-93\d)\/[\w.-]+\/(term)\//.exec(url.pathname);
  if (frame) {
    if (mock.term === "down" || (mock.term === "flaky" && Math.floor(Date.now() / 12_000) % 2)) return res.writeHead(502, { "content-type": "text/plain" }).end("down");
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fakeScreen(frame[2] as "term" | "web", SESSIONS().find((x) => x.task === frame[1])!.title));
  }
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    lastBody = text ? JSON.parse(text) : {};
    const [status, body] = pageRoute(req.method!, url, text ? JSON.parse(text) : {}) ?? viewRoute(req.method!, url, text ? JSON.parse(text) : {}) ?? route(req.method!, url);
    setTimeout(() => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)), url.pathname === "/api/sessions" ? mock.slowSessions || mock.slow : mock.slow);
  });
}).listen(port, "127.0.0.1", () => console.log(`board mock API on :${port}`));
