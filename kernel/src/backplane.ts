// The kernel's backplane listener (10.231.0.1:3130): the tool proxy, caller identity, the keys modules check assertions
// with, the agent directory modules read, and the control plane as the calling agent.
//   GET  /healthz              ok
//   GET  /v1/jwks              the caller-assertion keys
//   GET  /v1/whoami            (a kernel job's or a module's token) who the bearer is and its granted tools
//   GET  /v1/agents            (module token) every agent's key, roles, profile and the fields setup records for it, never its tools
//   POST /c/<connection>/mcp   (run or module token) the tool proxy (proxy.ts)
//   ANY  /v1/cp/agent/<path>   (module token + caller assertion) cp.ts; a status change to done passes the finish gate
//   POST /v1/checks/:task      (a check's module) release its label on a task, or resolve a hold it placed (checks.ts)
//   POST /v1/compile/check     (a module with role kernel.apply) {product, instance?, pin?}: does the instance at that commit (its
//                              main by default), pinned to `pin` (product, by default), compile against `product`? The apply's own
//                              staged compile, read-only (compile-check.ts): {ok} or {ok: false, error: the compiler's first message}
//   POST /v1/writes            (run, module, or job token naming the kind) request a write (writes.ts); GET /v1/writes/:id its
//                              record (own only; the board: any)
//   POST /v1/writes/:id/outcome (the kind's executor module) the outcome of an execute
//   POST /v1/writes/:id/wait (the kind's executor module) {reason}: why its claimed record is still running
//   GET  /v1/writes            (the board's key) records by state or task (`tier0=1`: Tier 0 runs too; `after=<id>`: the next page)
//   GET  /v1/writes/:id/chain  (the board's key) what the record's task asks, as the AI reviewer reads it (review-loop.ts requestChain)
//   GET  /v1/channel/cards, POST /v1/channel/{decide,owner-message,stop,thread}  (a speaks-as-owner channel's token) cards
//                              with decision tokens, a token spent, the owner's words (channels.ts)
//   POST /v1/answers/{claim,release}  (the board's key, or a channel's own token) {task, wait_since}: the owner's answer to that
//                              open wait is claimed once (200 ok, 409 stale|taken) before it is posted; a failed post releases it (answers.ts)
//   GET  /v1/cp/read/<path>    (a channel, or a module with role kernel.cp-read) the control plane's read routes, as the owner;
//                              with the board's key, the board's reads (cp.ts createBoardCp)
//   ANY  /v1/cp/owner/<path>   (the board's key) the owner's writes the board makes, X-AidenHQ-Account the admin's (cp.ts)
//   POST /v1/brake/notify      (the owner's router) may an agent message the owner about a task again (brake.ts)
//   POST /v1/channel/exchange  (a module with role kernel.lane) a fast-lane turn written to its agent's chat task (lane.ts)
//   POST /v1/notify            (the board's key, or a module with role kernel.owner-notice) a message for the owner,
//                              queued for the owner's router (notify.ts)
//   GET  /v1/notify/take, POST /v1/notify/ack, POST /v1/notify/send  (the module with role kernel.notify) the queued owner messages, each until acknowledged; one
//                              message to a channel's transport
//   POST /v1/wakes/events      (the paperclip-events plugin's key) a Paperclip event's ids: its task is scanned (wakes.ts)
//   POST /v1/wait              (a module with role kernel.wake, serving a job's task_wait, task_handoff or notify call in flight)
//                              {reason, until?, on?, task?}: the calling job's own task waits
//                              (idle.ts): a work.waiting fact and a wake at `until`
//   POST /v1/wakes             (a module with role kernel.wake) a scheduled wake {task, agent?, at?, cause?, id?}; with
//                              {task, text}: a labelled wake notice on the task now, which wakes its agent (no scheduled row); with
//                              to: "asker", on the task's open requester instead when it has one; with quiet: true, a note that wakes
//                              nobody and is not anyone's words
//   GET  /v1/wakes/pending?task=  (a module with role kernel.jobs) whether a wake for the task still waits to start a job
//   POST /v1/wakes/claim, POST /v1/wakes/:key/drop  (a module with role kernel.jobs) claim inbox rows; give one up
//   POST /v1/routines/cancel   (a module with role kernel.jobs) {task, why: coalesced|stale, body}: an open or blocked routine run of an
//                              agent it dispatches, cancelled as that agent (wakes.ts)
//   POST /v1/wakes/:key/note   (the module that claimed it) {body}: a note on its task as its agent, once (no job answers it)
//   POST /v1/board-tasks       (the board's key) {title, description, role | agent, source}: the same, as module "board" (app incidents for the chief of staff)
//   POST /v1/tasks             (a module with role kernel.tasks) {title, description, role | agent, source, parent?, quiet?}: a task of the module's
//                              fixed text for the agent holding `role` (or `agent`, by id), once per source (modtasks.ts); GET /v1/tasks?source=
//                              the open tasks of the module's own `release:instance:` family (the release train's sweep); POST /v1/tasks/:task/close
//                              {status: done|cancelled, body}: one it filed. `quiet: true` files it in the backlog, a holder for
//                              records whose assignment wakes nobody.
//   POST /v1/reviews           (the runner's reviewer key) a check before filing: one review by the bound reviewer module → its verdict
//   POST /v1/reviews/:review   (that review's token, once) the reviewer module's verdict
//   POST /v1/jobs {wake, prompt, session?}, GET/DELETE /v1/jobs/:job, POST /v1/jobs/:job/input  (a module with role kernel.jobs)
//                              a job on a wake it claimed, admitted (admission.ts: the only way a job starts), its status
//                              (?after=<version>&wait=<ms> waits for a change), stop it, a comment into it (jobs.ts; `wake`: the claimed comment wake it delivers);
//                              GET /v1/jobs?open=1 | ?task=<id>: its own jobs not yet acknowledged, or a task's; POST /v1/jobs/:job/ack: an ended job is dealt with
//   POST /v1/codehost/:op      (a module's own token) token | snapshot | clone on the code host that owns the repo, under the module's
//                              codehost grant (codehost.ts)
//   POST /v1/jobs/workspace    (a module with role kernel.jobs) {task}: the workspace folder it may write into (a task of an agent it dispatches)
//   GET  /v1/objects?ref=<ref> | ?type=pr&since=<iso>  (role kernel.work-read) whether a GitHub object is ours (objects.ts)
//   GET  /v1/work[?task=|?job=|?record=|?agent=|?since=], GET /v1/work/metrics  (a module with role kernel.work-read) the jobs and records
//                              of the kernel's work: a task's, one job, an agent's, the records and billed cost since a time, or what
//                              runs and ended lately; Prometheus text (work.ts)
//   GET  /v1/work[?task=|?job=|?record=|?agent=|?since=|?sessions=1|?session=<task>]  (the board) the same reads (the sessions' task, state, lease, times, last words and spend: work.ts sessions()); never the metrics or a token
//   GET  /v1/flow?task=|?item=|?journeys=1|?journey=|?since=[&to=&by=&scope=]  (the board, or a module with role
//                              kernel.flow-read) Flow's views over the fact log (flow.ts): a task's or item's waterfall, the declared journeys, a journey's items (journeys.ts), the summary with its insights
//   GET  /v1/facts[?since=<seq>&limit=]  (role kernel.flow-read) the fact log after `since` in ingestion order: {facts: [{seq,
//                              type, task}], tail}; without `since`, none and the tail (where a new incremental reader starts)
//   GET  /v1/tasks/issues?ids=  (the board, or a module with role kernel.flow-read) the issue mirror's rows (wakes.ts): identifier,
//                               title, status, assignee, parent and updatedAt of up to 200 tasks, by id or identifier, no Paperclip read
//   GET  /v1/tasks/state?ids=|?open=1[&closed_since=<iso>]  (the board, or a module with role kernel.flow-read) each task's one
//                              state, computed from its facts (task-state.ts): `ids` (≤ 200, ids or identifiers, closures included) or
//                              every open task (and every task closed since `closed_since`, no id limit), in one snapshot, with the needs-you, failed and unexplained-idle counts (task-state-read.ts)
//   POST /v1/work/grader-token  (the one module with role kernel.grader) {task} -> a gateway
//                              token billed to the task's assignee under its caps, for a task its finish check holds; one live token per task
//   POST /v1/jobs/:job/post    (that job's module) {kind: reply|status|notice, body, status?, blocked_by?, turn?}: posted on the job's
//                              task as its agent, once per kind (per `turn` for a session's turn reply, outcomes.ts)
//   POST /v1/checks, GET /v1/checks/:check, POST /v1/receipts/verify  (a module with role kernel.checks) a credential-free check
//                              job of repo@head and its signed receipt (?after=<version>&wait=<ms>), a receipt checked against
//                              {repo, head, run, judge?, policy?} (checkjobs.ts)
//   POST /v1/checks/inputs, GET /v1/checks/:check/kept  (the same) a file a later check's spec names by its sha256 (raw bytes in,
//                              {sha256} out), and the file a keep recipe left after its run (raw bytes; 404 when none)
//   POST /v1/checkout          (a kernel job's own token) {repo, sha?}: a code host snapshot (tar.gz) for a job holding the
//                              repo-checkout role, an agents-org repo only: GitHub's, or local/… from codehost-local (jobtools.ts checkout)
//   POST /v1/jobtools/git-token {repo}   a session job's own token: the code host's App token for that repo, at most an hour (jobtools.ts gitToken)
//   POST /v1/jobtools/:cmd     (a kernel job's own token) reset | engine {engine, model?} | cleanup: what the running job asks of its
//                              task's next turn (jobtools.ts); review {kind, args}: what the AI reviewer would say of that write,
//                              filed by nothing (writes.preview, review-loop precheck), at most PRECHECKS reviewer calls a job
//                              | clone {repo}: a repository its dispatcher's clone grant covers as a git bundle (its default
//                              branch; every branch on this server), which the box clones, or fetches into its clone, itself
//   POST /v1/jobtools/module/<module>/<op>  (a kernel job's own token, body ≤ 16 KB) one of the module's own job tools (module.yaml
//                              providers.jobtools ops): the kernel POSTs {op, body, caller} to the module with its key and a caller
//                              assertion in flight for the job; the module's status and answer (≤ 64 KB) go back (jobtools.ts createModuleTool)
//   GET  /v1/advisories        (the board's key) the marketplace advisories open against installed modules (advisories.ts)
//   GET  /v1/connections/health (the board's key) every connection's /healthz as the kernel reaches it -> {probes: {name: {ok, status?, state?, detail?, channels?, checkedAt}}} (health.ts)
//   POST /v1/connections/:module/ok  (the board's key) a sign-in or setup flow of that module finished: its down state clears and
//                              the tasks waiting on it wake -> {woken} (connection-state.ts); 404 for a module with no connection
//   POST /v1/connections/need  (a module with role kernel.owner-notice) {connection, need}: its own call (not a tool call through the proxy)
//                              that only the owner can fix, recorded as that connection's need (needs.ts) and routed like a tool call's -> {ok}
//   POST /v1/connections/ok    (a module with role kernel.owner-notice) {connection, org}: a call to that org succeeded, so its sso
//                              and restricted rows clear and their waiters wake -> {woken}
//   GET  /v1/connections/down?agent=  (a module with role kernel.jobs) the agent's granted connections that are down ->
//                              {down: [{connection, module, cause, since}]}: names, causes and dates only (the dispatch preamble)
//   GET  /v1/connections/needs (the module with role kernel.notify) {lines}: the owner's digest lines for every connection need confirmed
//                              down now (a connection that recovered or was removed is absent); the owner channel appends them to each digest
//   POST /v1/auth/:op, /v1/auth/mcp/:op, /v1/owner/{decide,update}, /v1/accounts/:op, /v1/apps/:op, /v1/operator/:op  the accounts' routes (auth-api.ts): module UI
//                              sessions and account admin (the board), in-app requests (apps-platform), setup links (operator)
//   POST /v1/memory/:op       (a module with role kernel.memory, serving a job's memory_<op> call in flight) note | forget | read |
//                              rewrite on the job's own agent's memory (memory.ts); read and a removals-only rewrite of any agent's
//                              for a librarian. GET /v1/memory/:key (the board, or role kernel.lane) {view, facts, updated}
//   POST /v1/events            (a module with role kernel.events) one source event of a connection it serves (events.ts) ->
//                              {accepted, seq?, duplicate?, queued}; 422 for an envelope the schema refuses, 403 when it isn't that
//                              connection's module: both final.
//   GET  /v1/events/log?connection=&after=&limit= (a module whose compiled `subscribes:` names the connection) {events, next, gap}:
//                              the log after its committed cursor, only its kinds and resources; no `after`: the watermark.
//   GET  /v1/events/readers    (role kernel.flow-read) each subscribed module's committed cursor, last read and events waiting.
//                              GET /v1/events/sources?connection= the resources its connection's routines subscribe to.
//                              GET /v1/events/batch/:batch (role kernel.events, serving a job's routine_events call in flight) the
//                              batch the job's own run was fired with, or {pending, retry_after_s} while its binding is stored
//   POST /v1/health/probe      (the host's health_probe_key, x-health-key) {probe}: one of the modules' declared health probes (health.ts), called as the
//                              agent granted it -> {ok, ms, error?}, never the tool's answer; scripts/healthcheck.sh's reads
//   POST /v1/views/<module>/mcp (the board's key) {view, method, params}: a module view's resources/read of itself or tools/call of a
//                              tool its page lists (board.pages), sent to the module as the owner (views.ts) -> {result} | {error}
import type { Projects } from "./projects.ts";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Asserter } from "./assert.ts";
import type { Facts } from "./facts.ts";
import type { Idle } from "./idle.ts";
import type { Brake } from "./brake.ts";
import type { Checks } from "./checks.ts";
import type { Lane } from "./lane.ts";
import { INPUT_MAX, type Checks as CheckJobs } from "./checkjobs.ts";
import type { Answers } from "./answers.ts";
import { CP_READ_PATHS, isChannel, neutral, type Api, type Channels, type ModulesFile } from "./channels.ts";
import { requestedParentOf } from "../../services/shared/requested-parent.ts";
import type { Grant, Identity, Whoami } from "./identity.ts";
import { TestSessionError, type TestSessions } from "./test-session.ts";
import type { Jobs } from "./jobs.ts";
import type { Admission } from "./admission.ts";
import { JOB_KINDS, type Outcomes } from "./outcomes.ts";
import { notice, type Notify } from "./notify.ts";
import { JOBTOOL_BODY_MAX, type JobTools, type ModuleTool } from "./jobtools.ts";
import type { Routing } from "./routing-tune.ts";
import { CODEHOSTS, hostOf, type Answer } from "./codehost.ts";
import { fail } from "./proxy.ts";
import { logTasks } from "./task-scope.ts";
import type { Records, Requester, State } from "./records.ts";
import type { BoardApi } from "./board-api.ts";
import type { Views } from "./views.ts";
import type { Work } from "./work.ts";
import { BY, type By, type Flow } from "./flow.ts";
import type { TaskStateRead } from "./task-state-read.ts";
import { AUTHOR_KINDS, SORTS, type AuthorKind, type Sort } from "./journeys.ts";
import type { Reviews } from "./reviews.ts";
import { wakeNotice, type Wakes } from "./wakes.ts";
import type { ModuleTasks } from "./modtasks.ts";
import { CONN_TOOL, type Writes } from "./writes.ts";
import { requestChain } from "./review-loop.ts";
import { NAME, type ConnectionState } from "./connection-state.ts";
import { MemoryError, memoryOp, view as memoryView, type Memory } from "./memory.ts";
import { EventsError, type Events } from "./events.ts";
import { OWNER_CAUSES, readNeed } from "../sdk/src/vendor/needs.ts";

const MAX_ATTACHMENT = 25 * 1024 * 1024;
type Handler = (req: IncomingMessage, res: ServerResponse, ...a: string[]) => Promise<void>;
/** Directory fields a module may read (name and model: code review's judge picks a model family other than a PR author's);
 * everything else in the grants table (tools, model lists, caps, images) stays here. */
const DIRECTORY = ["key", "name", "model", "roles", "profile", "description", "delegate_to", "review_log", "graded", "feedback_for"];

/** The tool calls that record a wait on their job's task (POST /v1/wait, idle.ts). */
const WAIT_TOOLS = ["task_wait", "task_handoff", "notify"];
/** What a task shows when the owner stops its run: the kernel's own words, the dispatcher posts nothing else for it. */
export const STOPPED_NOTE = "**Stopped by the owner.** Say **continue** to pick up where it stopped.";
/** What the listener serves: the router dispatches from this table and scripts/lean/contract-lock.ts reads it, so the lock can't miss a route. */
export const ROUTES = [
  { method: "GET", path: "/healthz", auth: "none" },
  { method: "GET", path: "/v1/jwks", auth: "none" },
  { method: "GET", path: "/v1/whoami", auth: "bearer" },
  { method: "GET", path: "/v1/agents", auth: "module" },
  { method: "POST", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "DELETE", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "ANY", path: "/v1/cp/agent/*", auth: "module+assertion" },
  { method: "POST", path: "/v1/checks/:task", auth: "module" },
  { method: "POST", path: "/v1/writes", auth: "bearer" },
  { method: "GET", path: "/v1/writes", auth: "board" },
  { method: "GET", path: "/v1/writes/:id", auth: "bearer" },
  { method: "GET", path: "/v1/writes/:id/chain", auth: "board" },
  { method: "POST", path: "/v1/writes/:id/outcome", auth: "module" },
  { method: "POST", path: "/v1/writes/:id/wait", auth: "module" },
  { method: "GET", path: "/v1/channel/cards", auth: "module" },
  { method: "POST", path: "/v1/channel/decide", auth: "module" },
  { method: "POST", path: "/v1/channel/owner-message", auth: "module" },
  { method: "POST", path: "/v1/channel/stop", auth: "module" },
  { method: "POST", path: "/v1/channel/thread", auth: "module" },
  { method: "POST", path: "/v1/channel/exchange", auth: "module" },
  { method: "POST", path: "/v1/answers/claim", auth: "module|board" },
  { method: "POST", path: "/v1/answers/release", auth: "module|board" },
  { method: "GET", path: "/v1/cp/read/*", auth: "module|board" },
  { method: "ANY", path: "/v1/cp/owner/*", auth: "board" },
  { method: "POST", path: "/v1/brake/notify", auth: "module" },
  { method: "POST", path: "/v1/notify", auth: "board" },
  { method: "POST", path: "/v1/board-tasks", auth: "board" },
  { method: "GET", path: "/v1/notify/take", auth: "module" },
  { method: "POST", path: "/v1/notify/ack", auth: "module" },
  { method: "POST", path: "/v1/notify/send", auth: "module" },
  { method: "POST", path: "/v1/facts", auth: "module" },
  { method: "GET", path: "/v1/facts", auth: "module" },
  { method: "POST", path: "/v1/wait", auth: "module+assertion" },
  { method: "POST", path: "/v1/wakes/events", auth: "events-key" },
  { method: "POST", path: "/v1/wakes", auth: "module" },
  { method: "GET", path: "/v1/wakes/pending", auth: "module" },
  { method: "POST", path: "/v1/wakes/claim", auth: "module" },
  { method: "POST", path: "/v1/wakes/:key/drop", auth: "module" },
  { method: "POST", path: "/v1/wakes/:key/note", auth: "module" },
  { method: "POST", path: "/v1/routines/cancel", auth: "module" },
  { method: "GET", path: "/v1/tasks/state", auth: "module|board" },
  { method: "GET", path: "/v1/tasks/issues", auth: "module|board" },
  { method: "POST", path: "/v1/tasks", auth: "module" },
  { method: "POST", path: "/v1/tasks/:task/close", auth: "module" },
  { method: "POST", path: "/v1/tasks/:task/comment", auth: "module" },
  { method: "GET", path: "/v1/tasks", auth: "module" },
  { method: "POST", path: "/v1/reviews", auth: "reviewer-key" },
  { method: "POST", path: "/v1/reviews/:review", auth: "review-token" },
  { method: "POST", path: "/v1/jobs", auth: "module" },
  { method: "GET", path: "/v1/jobs", auth: "module" },
  { method: "POST", path: "/v1/jobs/workspace", auth: "module" },
  { method: "POST", path: "/v1/codehost/:op", auth: "module" },
  { method: "GET", path: "/v1/jobs/:job", auth: "module" },
  { method: "DELETE", path: "/v1/jobs/:job", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/input", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/ack", auth: "module" },
  { method: "GET", path: "/v1/work", auth: "module|board" },
  { method: "GET", path: "/v1/work/metrics", auth: "module" },
  { method: "GET", path: "/v1/objects", auth: "module" },
  { method: "GET", path: "/v1/flow", auth: "module|board" },
  { method: "POST", path: "/v1/work/grader-token", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/post", auth: "module" },
  { method: "POST", path: "/v1/checks", auth: "module" },
  { method: "POST", path: "/v1/checks/inputs", auth: "module" },
  { method: "GET", path: "/v1/checks/:check", auth: "module" },
  { method: "GET", path: "/v1/checks/:check/kept", auth: "module" },
  { method: "POST", path: "/v1/receipts/verify", auth: "module" },
  { method: "POST", path: "/v1/jobtools/:cmd", auth: "job" },
  { method: "POST", path: "/v1/jobtools/module/:module/:cmd", auth: "job" },
  { method: "POST", path: "/v1/checkout", auth: "job" },
  { method: "GET", path: "/v1/advisories", auth: "board" },
  { method: "GET", path: "/v1/connections/health", auth: "board" },
  { method: "POST", path: "/v1/connections/:module/ok", auth: "board" },
  { method: "POST", path: "/v1/connections/need", auth: "module" },
  { method: "POST", path: "/v1/connections/ok", auth: "module" },
  { method: "GET", path: "/v1/connections/down", auth: "module" },
  { method: "GET", path: "/v1/connections/needs", auth: "module" },
  { method: "POST", path: "/v1/settings/change", auth: "board" },
  { method: "POST", path: "/v1/modules/share/preview", auth: "board" },
  { method: "POST", path: "/v1/modules/share", auth: "board" },
  { method: "POST", path: "/v1/validate", auth: "board" },
  { method: "POST", path: "/v1/stop", auth: "board" },
  { method: "POST", path: "/v1/compile/check", auth: "module" },
  { method: "POST", path: "/v1/routing/:op", auth: "module+assertion" },
  { method: "POST", path: "/v1/settings/agent", auth: "module+assertion" },
  { method: "POST", path: "/v1/memory/:op", auth: "module+assertion" },
  { method: "GET", path: "/v1/memory/:key", auth: "module|board" },
  { method: "POST", path: "/v1/events", auth: "module" },
  { method: "GET", path: "/v1/events/sources", auth: "module" },
  { method: "GET", path: "/v1/events/log", auth: "module" },
  { method: "GET", path: "/v1/events/readers", auth: "module" },
  { method: "GET", path: "/v1/events/batch/:batch", auth: "module+assertion" },
  { method: "ANY", path: "/v1/board-api/:module/*", auth: "board" },
  { method: "POST", path: "/v1/views/:module/mcp", auth: "board" },
  { method: "POST", path: "/v1/auth/:op", auth: "board" },
  { method: "POST", path: "/v1/auth/mcp/:op", auth: "board" },
  { method: "POST", path: "/v1/owner/decide", auth: "board+mcp" },
  { method: "POST", path: "/v1/owner/update", auth: "board+mcp" },
  { method: "POST", path: "/v1/accounts/:op", auth: "board+session" },
  { method: "POST", path: "/v1/apps/:op", auth: "module" },
  { method: "POST", path: "/v1/operator/:op", auth: "operator-key" },
  { method: "POST", path: "/v1/test-session", auth: "module+assertion" },
  { method: "POST", path: "/v1/test-session/:op", auth: "module+assertion" },
  { method: "POST", path: "/v1/health/probe", auth: "health-key" },
] as const;
// `:id` matches a record id, any other `:name` [a-z0-9_]+, a trailing `/*` the rest of the path, slash included.
const compiled = ROUTES.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:id\b/g, "(k-[0-9a-f]{16})").replace(/:review\b/g, "(r-[0-9a-f]{16})").replace(/:job\b/g, "(j-[0-9a-f]{16})").replace(/:check\b/g, "(c-[0-9a-f]{16})").replace(/:task\b/g, "([0-9a-f-]{36})").replace(/:batch\b/g, "([0-9a-f-]{36})").replace(/:key\b/g, "([^/]{1,200})").replace(/:cmd\b/g, "([a-z][a-z0-9_-]*)").replace(/:module\b/g, "([a-z0-9][a-z0-9-]{0,62})").replace(/:\w+/g, "([a-z0-9_]+)").replace(/\/\*$/, "(/.*)")}$`) }));
/** The record lists the board and the runner read (`?state=`). */
const ALL: State[] = ["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"];
const LISTS: { [k: string]: State[] } = { review: ["review"], owner: ["owner"], pending: ["review", "owner"], approved: ["approved", "claimed"], live: ["review", "owner", "approved", "claimed"], recent: ALL, finished: ["done", "failed", "unknown"] };

/** A raw body of at most `max` bytes. */
async function bytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw fail(413, "too_large", "too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function json(req: IncomingMessage, max = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw fail(413, "too_large", "too large"); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
}

/** GET /v1/work's reads, by query: ?job=, ?record=, ?task=, ?agent=, ?since=[&to=], ?generations=1, ?pauses=1, ?owner_cards=1[&after=&limit=], ?sessions=1, ?session=<task>, or what runs now (work.ts). */
function workRead(work: Work, p: URLSearchParams) {
  const [job, task, agent, since, record] = [p.get("job"), p.get("task"), p.get("agent"), p.get("since"), p.get("record")];
  if (p.get("sessions")) return work.sessions();
  if (p.get("session")) return { session: work.sessions(p.get("session")!.slice(0, 64)).sessions[0] ?? null };
  if (p.get("generations")) return work.generations();
  if (p.get("pauses")) return work.pauses();
  if (p.get("owner_cards")) {
    const limit = Number(p.get("limit") ?? 20), after = p.get("after") ?? undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(400, "bad_request", "limit is 1 to 100");
    if (after !== undefined && !/^[\w-]{1,64}$/.test(after)) throw fail(400, "bad_request", "after is a record id");
    return work.ownerCards(after, limit);
  }
  if (record) return work.record(record.slice(0, 40)) ?? (() => { throw fail(404, "not_found", `no record ${record.slice(0, 40)}`); })();
  if (job) return work.job(job.slice(0, 40)) ?? (() => { throw fail(404, "not_found", `no job ${job.slice(0, 40)}`); })();
  // `shown=1` (the board's Activity tab): quiet routine runs left out before the limit; detectors read every run.
  // `since` with `agent`: every job of that agent from that instant on, uncut, for a caller classifying a window of its tasks.
  if (agent) {
    const from = since ? Date.parse(since) : NaN;
    if (since && Number.isNaN(from)) throw fail(400, "bad_request", "since is an ISO timestamp");
    // `brief=1` alone: the rows without the timeline, for the caller classifying a window (fleet-steward's scorecard).
    return work.agent(agent.slice(0, 100), { shown: p.get("shown") === "1", ...(since ? { since: from } : {}), ...(p.get("brief") === "1" ? { brief: true } : {}) });
  }
  if (since) {
    const to = p.get("to") ?? undefined;
    if (Number.isNaN(Date.parse(since)) || (to && Number.isNaN(Date.parse(to)))) throw fail(400, "bad_request", "since and to are ISO timestamps");
    return work.since(since, to);
  }
  return task ? work.task(task.slice(0, 100)) : work.activity();
}

const FACT_AT = /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * GET /v1/flow's reads, by query: ?task=, ?item=, ?journeys=1 (the declared journeys), ?journey=<name> (its items over
 * ?since= [&to=&author=agent,owner,outside&sort=recent|slowest|rounds&limit=200]), else the summary over ?since= (default 7 days)
 * [&to=&by=&scope=] with the insights of journey ?insights=<name> (else the first declared one with items).
 */
function flowRead(flow: Flow, p: URLSearchParams) {
  const [task, item] = [p.get("task"), p.get("item")];
  if (task) return flow.task(task.slice(0, 100));
  if (item) return flow.item(item.slice(0, 100));
  if (p.get("journeys")) return flow.journeys();
  const since = p.get("since") ?? new Date(Date.now() - 7 * 864e5).toISOString(), to = p.get("to") ?? undefined, by = p.get("by") ?? "stage";
  if (Number.isNaN(Date.parse(since)) || (to && Number.isNaN(Date.parse(to)))) throw fail(400, "bad_request", "since and to are ISO timestamps");
  const journey = p.get("journey");
  if (journey) {
    const authors = p.get("author")?.split(",").filter(Boolean), sort = p.get("sort") ?? "recent", limit = Number(p.get("limit") ?? 200);
    if (authors?.some((a) => !(AUTHOR_KINDS as string[]).includes(a))) throw fail(400, "bad_request", `author is a list of ${AUTHOR_KINDS.join(", ")}`);
    if (!(SORTS as string[]).includes(sort)) throw fail(400, "bad_request", `sort is one of ${SORTS.join(", ")}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail(400, "bad_request", "limit is 1 to 1000");
    const list = flow.journey({ name: journey.slice(0, 100), since, to, authors: authors as AuthorKind[] | undefined, sort: sort as Sort, limit });
    if (!list) throw fail(404, "not_found", `no module declares journey ${journey.slice(0, 40)}`);
    return list;
  }
  if (!(BY as string[]).includes(by)) throw fail(400, "bad_request", `by is one of ${BY.join(", ")}`);
  return flow.summary({ since, to, by: by as By, scope: p.get("scope")?.slice(0, 100) || undefined, journey: p.get("insights")?.slice(0, 100) || undefined });
}

export function createBackplane({ projects, idle, facts, whoami, asserter, proxy, cp, boardCp, grantsFile, writes, records, channels, brake, notify, owner, modules = () => ({}), boardKey = () => "", reviews, reviewerKey = () => "", jobs, codehost, admission, outcomes, wakes, tasks, eventsKey = () => "", work, flow, taskStates, answers, repos = () => ({}), graderToken = () => "", dropGraderToken = () => {}, advisories = () => [], testSessions, accounts, checks, checkJobs, jobTools, moduleTool, precheck, repoBundle, appToken, ownerRaw, lane, healthProbe, healthKey = () => "", connectionHealth, connectionState, settingsChange, compileCheck, sharing, validate, routing, memory, events, boardApi: moduleBoardApi, views, log = () => {} }: {
  /** Flow's fact log (facts.ts): POST /v1/facts, and GET /v1/facts for incremental readers. */
  facts?: Facts;
  /** Projects (projects.ts): a code host's new PR fills in its task's project. */
  projects?: Pick<Projects, "queue" | "touch">;
  /** An agent's own wait on its job's task (idle.ts): POST /v1/wait. */
  idle?: Idle;
  whoami: Whoami; asserter: Asserter; proxy: Handler; cp: Handler; boardCp?: Handler; grantsFile: () => { agents?: Record<string, Grant> } & Record<string, unknown>;
  writes?: Writes; records?: Records; boardKey?: () => string; log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The reviewer slot, and the key a direct review request asks with (reviewer_key, which the board holds). */
  reviews?: Reviews; reviewerKey?: () => string;
  /** 2f: channel tokens and owner messages, the notify brake, and the control plane as the owner (reads, wake notices). */
  channels?: Channels; brake?: Brake; owner?: Api; modules?: () => ModulesFile;
  /** The control plane as the owner, the raw response (an attachment's bytes, which `owner`'s JSON can't carry). */
  ownerRaw?: (path: string) => Promise<Response>;
  /** The fast chat lane's exchanges onto its agents' chat tasks (lane.ts). */
  lane?: Lane;
  /** 3.2: the owner's messages, queued for the owner-channel module and handed to channels' transports. */
  notify?: Notify;
  /** 3e: jobs in the sandbox. */
  jobs?: Jobs;
  /** The GitHub code host's operations for modules (codehost.ts). */
  codehost?: (module: string, op: string, body: Record<string, unknown>, res: ServerResponse) => Promise<void>;
  /** Admission (admission.ts): a job on a wake the module claimed, its authority frozen, its computer the kernel's (boxes.ts). */
  admission?: Admission;
  /** F5: a job's outcome posted as its agent. */
  outcomes?: Outcomes;
  /** The wake inbox (wakes.ts), and the paperclip-events plugin's key. */
  wakes?: Wakes; eventsKey?: () => string;
  /** Tasks modules file for agents (modtasks.ts). */
  tasks?: ModuleTasks;
  /** Reads of the work the kernel owns (work.ts). */
  work?: Work;
  /** Flow's views over the fact log (flow.ts). */
  flow?: Flow;
  /** Each task's one state (task-state-read.ts). */
  taskStates?: Pick<TaskStateRead, "read" | "named" | "issues">;
  /** The once-per-wait claim on an owner's answer (answers.ts): the board and a channel module post only after it. */
  answers?: Answers;
  /** The repos the instance reaches (codehostRepos in main.ts): GET /v1/agents hands them to modules. */
  repos?: () => Record<string, unknown>;
  /** A grader-kind gateway token for a task (the kernel is the only minter). */
  graderToken?: (task: string, agent: string) => string;
  /** Forget a task's cached grader token (its hold resolved or was released). */
  dropGraderToken?: (task: string) => void;
  /** 4e: the open marketplace advisories. */
  advisories?: () => unknown[];
  /** 3g: the accounts' routes (auth-api.ts). */
  accounts?: (req: IncomingMessage, res: ServerResponse, group: string, op: string) => Promise<void>;
  /** The test-user page canary's sessions (test-session.ts), for app_page_canary's own tool call in flight. */
  testSessions?: () => TestSessions | undefined;
  /** 3h: the finish gate (checks.ts). */
  checks?: Checks;
  /** Check jobs and their receipts (checkjobs.ts). */
  checkJobs?: CheckJobs;
  /** A running job's requests for its task's next turn (jobtools.ts). */
  jobTools?: JobTools;
  /** A module's own job tools, for a kernel job's box (jobtools.ts createModuleTool). */
  moduleTool?: ModuleTool;
  /** A job's precheck (`aidenhq review`): what the AI reviewer would say of this write, filing nothing; `slot` counts the reviewer call. */
  precheck?: (who: Identity, b: { kind: string; args: unknown }, slot: () => (failure: unknown) => void) => Promise<{ text: string; reason?: string; decision?: string }>;
  /** A session job's git token for a repo (codehost.ts appToken): the App's, narrowed to that repo. */
  appToken?: (repo: string) => Promise<{ token: string; expires_at: string }>;
  /** A repo's bundle for a job's `aidenhq clone`, under its dispatcher's clone grant (codehost.ts bundle): the code host's answer. */
  repoBundle?: (module: string, repo: string, head?: string) => Promise<Answer>;
  /** The host's health probes (health.ts), and the key the host's healthcheck asks with (health_probe_key, held by no container). */
  healthProbe?: (b: Record<string, unknown>) => Promise<{ ok: boolean; ms: number; error?: string }>;
  healthKey?: () => string;
  /** Every connection's /healthz (health.ts createConnectionHealth). */
  connectionHealth?: () => Promise<Record<string, unknown>>;
  /** Connect on first use (connection-state.ts): the board's /ok and the dispatcher's down list. */
  connectionState?: Pick<ConnectionState, "ok" | "okModule" | "downFor" | "needs" | "has" | "report" | "owns">;
  /** A local module's share: its preview, and the owner's save of it (module-share.ts createSharing). */
  sharing?: { preview(b: Record<string, unknown>): Promise<unknown>; share(b: Record<string, unknown>): Promise<unknown> };
  /** The owner's typed settings change on their settings task (settings-change.ts). */
  /** A module's own check of settings the board is about to file (module-validate.ts). */
  validate?: (module: string, input: { settings?: Record<string, unknown> }) => Promise<unknown>;
  settingsChange?: ((task: unknown, changes: unknown, session?: unknown) => Promise<unknown>) & { asAgent?: (requester: Requester, task: string, changes: unknown, module: string, o?: { tool?: string; why?: unknown }) => Promise<unknown> };
  /** The release train's compile preflight (compile-check.ts): a product commit compiled against the instance's main. */
  compileCheck?: (b: { product?: unknown; instance?: unknown; pin?: unknown }) => Promise<{ ok: boolean; error?: string }>;
  /** The routing learning loop (routing-tune.ts). */
  routing?: Routing;
  /** Agents' memory documents (memory.ts). */
  memory?: Memory;
  /** The event router (events.ts). */
  events?: Events;
  /** A module view's calls for the owner (views.ts): its own resource and its page's tools. */
  views?: Views;
  /** A module's board API (board-api.ts): the board's reads of a module service, through the kernel. */
  boardApi?: BoardApi;
}) {
  /** The calling module (its own token), or 401. */
  const moduleOf = async (req: IncomingMessage) => {
    const w = await whoami(bearer(req)).catch(() => undefined);
    if (w?.kind !== "module" || !w.module) throw fail(401, "unauthorized", "a module's own token is required");
    return w;
  };
  /** The chief of staff's agent id, from the grants table (where owner messages go by default). */
  const cos = () => chiefOfStaff(grantsFile().agents);
  const keyIs = (req: IncomingMessage, key: string) => { const a = Buffer.from(bearer(req)), b = Buffer.from(key); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
  const isBoard = (req: IncomingMessage) => keyIs(req, boardKey());
  const reviewer = (req: IncomingMessage) => { if (!keyIs(req, reviewerKey())) throw fail(401, "unauthorized", "the reviewer key is required"); };
  const record = (id: string) => records?.get(id) ?? (() => { throw fail(404, "not_found", `no record ${id}`); })();
  const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path = "", q] = String(req.url ?? "").split(/\?(.*)/s);
    const query = q ? `?${q}` : "";
    try {
      const hit = compiled.find((r) => (r.method === "ANY" || r.method === req.method) && r.re.test(path));
      const m = hit ? hit.re.exec(path)!.slice(1) : [];
      switch (hit && `${hit.method} ${hit.path}`) {
        case "GET /healthz": return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        case "GET /v1/jwks": return send(res, 200, asserter.jwks);
        case "POST /v1/wait": {
          // A module with role kernel.wake serving a kernel job's task_wait, task_handoff or notify call in flight: the job is
          // read from its own token (never the assertion's or the body's say-so), and the wait is on that job's own task.
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.wake")) throw fail(403, "forbidden", `${w.module} may not record waits (role kernel.wake)`);
          if (!idle) throw fail(503, "unavailable", "waits are off");
          const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
          const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
          if (!live || job?.kind !== "run" || !job.task || !job.agent || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight records a wait on its task");
          if (!WAIT_TOOLS.includes(String(live.caller.tool ?? "").split(".").pop()!)) throw fail(403, "forbidden", `a wait is recorded by ${WAIT_TOOLS.join(", ")} only`);
          return send(res, 200, await idle.wait({ agent: job.agent, key: job.key ?? "", task: job.task }, await json(req)));
        }
        case "GET /v1/facts": {
          // The fact log in ingestion order, for an incremental reader: each fact's seq, type and task (no data), after `since`;
          // without `since`, none and the tail (a first reader starts there).
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.flow-read")) throw fail(403, "forbidden", `${w.module} may not read the fact log (role kernel.flow-read)`);
          if (!facts) throw fail(503, "unavailable", "the fact log is off");
          const p = new URLSearchParams(query.slice(1));
          const since = p.get("since"), limit = Number(p.get("limit") ?? 1000);
          if (since !== null && !/^\d{1,15}$/.test(since)) throw fail(400, "bad_request", "since is a fact's seq");
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail(400, "bad_request", "limit is 1 to 1000");
          const rows = since === null ? [] : facts.since(Number(since), limit).map((f) => ({ seq: f.seq, type: f.type, task: f.task }));
          return send(res, 200, { facts: rows, tail: rows.at(-1)?.seq ?? (since === null ? facts.tail() : Number(since)) });
        }
        case "POST /v1/facts": {
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.facts")) throw fail(403, "forbidden", `${w.module} may not record facts (role kernel.facts)`);
          if (!facts || !records) throw fail(503, "unavailable", "the fact log is off");
          const b = await json(req, 5_000_000);
          if (!Array.isArray(b.facts) || b.facts.length > 500) throw fail(400, "bad_request", "send {facts: [...]} of at most 500");
          const declared = modules().modules?.[w.module!]?.facts ?? {};
          // All are checked before any is recorded: a bad fact refuses the batch, and the rest are recorded in one transaction.
          const t = Date.now();
          for (const f of b.facts) {
            if (!f || !text(f.type, 80) || !text(f.subject, 300) || !text(f.version, 300) || typeof f.at !== "string" || !FACT_AT.test(f.at) || Number.isNaN(Date.parse(f.at))) throw fail(400, "bad_request", "each fact is {type, subject, version, at (ISO), task?, data?}");
            if (!Object.hasOwn(declared, f.type)) throw fail(403, "forbidden", `${w.module} did not declare fact ${f.type} (module.yaml facts:)`);
            if (Date.parse(f.at) > t + 864e5) throw fail(400, "bad_request", `fact ${f.type} is dated more than a day ahead`);
            if (f.data !== undefined && (!f.data || typeof f.data !== "object" || Array.isArray(f.data) || Buffer.byteLength(JSON.stringify(f.data)) > 4096)) throw fail(400, "bad_request", `fact ${f.type}: data is an object of at most 4096 bytes`);
            const d = declared[f.type] ?? {};
            if (d.subject && !f.subject.startsWith(`${d.subject}:`)) throw fail(400, "bad_request", `fact ${f.type}'s subject is a ${d.subject}: (module.yaml facts:)`);
            if (f.data?.reason !== undefined && !(d.reasons ?? []).includes(String(f.data.reason))) throw fail(400, "bad_request", `fact ${f.type}: reason ${String(f.data.reason).slice(0, 40)} isn't declared (module.yaml facts:)`);
          }
          // The actor is the kernel's call, never the body's: the agent whose job (data.job) or PR (its code host record's requester) it
          // is, only when that job or record is the calling module's own; else the module itself.
          const agentOf = (id: unknown) => { try { const a = (records.db.prepare("SELECT agent FROM jobs WHERE id = ? AND module = ?").get(String(id), w.module!) as { agent: string } | undefined)?.agent; const key = a && (grantsFile().agents ?? {})[a]?.key; return key ? `agent:${key}` : undefined; } catch { return undefined; } };
          const prAgent = (subject: string, task: unknown) => {
            const repo = /^pr:([^#]+)#/.exec(subject)?.[1];
            if (!repo || typeof task !== "string") return undefined;
            const r = records.list(["approved", "claimed", "done", "failed"], 50, { task }).find((x) => x.module === w.module && CODEHOSTS.includes(w.module!) && x.kind === `${w.module}.pr` && ((x.args as { only?: { repo?: string }[] } | null)?.only ?? []).some((o) => o.repo === repo));
            return r?.requester.key ? `agent:${r.requester.key}` : undefined;
          };
          let recorded = 0;
          const opened: { task: string; repo: string }[] = [];
          // Facts older than the log keeps (facts.ts prune, 400 days) would be pruned at once: skipped, not refused (a history backfill).
          const kept = t - 400 * 864e5;
          records.db.exec("BEGIN IMMEDIATE");
          try {
            for (const f of b.facts) {
              if (Date.parse(f.at) < kept) continue;
              const data = f.data ?? {};
              const actor = (data.job != null ? agentOf(data.job) : undefined) ?? (f.subject.startsWith("pr:") ? prAgent(f.subject, f.task) : undefined) ?? `module:${w.module}`;
              // The module's name is part of the version (so of the id): two modules declaring one type can never pre-empt each other's facts.
              if (facts.record({ type: f.type, subject: f.subject, version: `${w.module}/${f.version}`, at: f.at, actor, ...(typeof f.task === "string" && f.task ? { task: f.task.slice(0, 100) } : {}), source: f.source === "backfill" ? "backfill" : "live", data })) {
                recorded++;
                // A code host's new PR on a task: the task joins the repo's project (projects.ts touch).
                // Queued in this transaction, so a restart before the fill keeps it.
                if (f.type === "pr.opened" && CODEHOSTS.includes(w.module!) && typeof f.task === "string" && f.task && typeof data.repo === "string" && f.source !== "backfill") {
                  projects?.queue(f.task, data.repo);
                  opened.push({ task: f.task, repo: data.repo });
                }
              }
            }
            records.db.exec("COMMIT");
          } catch (e) {
            records.db.exec("ROLLBACK");
            throw e;
          }
          for (const o of opened) void projects?.touch(o.task, o.repo).catch((e: Error) => log("project fill failed", { task: o.task, repo: o.repo, err: e.message }));
          return send(res, 200, { recorded });
        }
        case "GET /v1/whoami": {
          const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
          return send(res, 200, { kind: w.kind, ...(w.agent ? { agent: w.agent } : {}), roles: w.roles, ...(w.task ? { task: w.task } : {}), ...(w.run ? { run: w.run } : {}), ...(w.module ? { module: w.module } : {}), tools: w.tools });
        }
        case "GET /v1/agents": {
          const w = await whoami(bearer(req)).catch(() => undefined);
          if (w?.kind !== "module") throw fail(401, "unauthorized", "a module's own token is required");
          const t = grantsFile();
          const agents = Object.fromEntries(Object.entries(t.agents ?? {}).map(([id, g]) => [id, Object.fromEntries(DIRECTORY.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]))]));
          // The repos the instance reaches (the agents orgs, product, github_orgs, maintainer_repos): what a deliverable may name.
          // Setup's log tasks (task-scope.ts logTasks): the tasks bridge keeps them out of an agent's own work.
          return send(res, 200, { agents, repos: repos(), log_tasks: [...logTasks(t as never)] });
        }
        case "POST /c/:connection/mcp": case "DELETE /c/:connection/mcp": return await proxy(req, res, m[0]!);
        case "ANY /v1/board-api/:module/*": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!moduleBoardApi) throw fail(503, "unavailable", "module board APIs are off");
          if (!["GET", "POST"].includes(String(req.method))) throw fail(405, "method_not_allowed", "GET or POST");
          const b = req.method === "POST" ? JSON.stringify(await json(req, 400_000)) : undefined;
          const r = await moduleBoardApi(m[0]!, String(req.method), m[1] ?? "/", query, b);
          return void res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
        }
        case "POST /v1/views/:module/mcp": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!views) throw fail(503, "unavailable", "module views are off");
          return send(res, 200, await views(m[0]!, await json(req, 400_000)));
        }
        case "ANY /v1/cp/agent/*": return await cp(req, res, m[0]!, query);
        case "POST /v1/checks/:task": {
          const w = await moduleOf(req);
          if (!checks) throw fail(503, "unavailable", "checks are off");
          const resolved = await checks.resolve(w.module!, m[0]!, await json(req));
          dropGraderToken(m[0]!);
          return send(res, 200, resolved);
        }
        case "POST /v1/notify": {
          // A module that tells the owner about its work (role kernel.owner-notice: the dispatch module's dead ends) queues too.
          if (!isBoard(req) && !(await whoami(bearer(req)).catch(() => undefined))?.roles?.includes("kernel.owner-notice")) throw fail(401, "unauthorized", "the board's key, or a module with role kernel.owner-notice, is required");
          if (!notify) throw fail(503, "unavailable", "notify is off");
          notify.queue(notice(await json(req)));
          return send(res, 200, { queued: true });
        }
        case "POST /v1/answers/claim": case "POST /v1/answers/release": {
          // The board, or a speaks-as-owner channel with its own token (as owner-message): the claimant is the caller.
          let by = "board";
          if (!isBoard(req)) {
            const w = await moduleOf(req);
            if (!isChannel(modules().modules?.[w.module!]) || !w.own) throw fail(403, "forbidden", `${w.module} may not answer for the owner`);
            by = w.module!;
          }
          if (!answers) throw fail(503, "unavailable", "answers are off");
          const b = await json(req);
          if (typeof b.task !== "string" || !b.task || typeof b.wait_since !== "string" || !b.wait_since) throw fail(400, "bad_request", "send {task, wait_since}");
          if (hit!.path === "/v1/answers/release") { answers.release(b.task, b.wait_since, by); return send(res, 200, { ok: true }); }
          const r = answers.claim(b.task, b.wait_since, by);
          return r === "ok" ? send(res, 200, { ok: true }) : send(res, 409, { error: r });
        }
        case "POST /v1/board-tasks": {
          // The board's own alerts for the chief of staff (an app incident): a task of fixed text, once per source (modtasks.ts, as module "board").
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!tasks) throw fail(503, "unavailable", "module tasks are off");
          return send(res, 200, await tasks.file("board", await json(req)).catch((e: { name?: string; status?: number; message: string }) => { throw e.name === "TaskError" ? fail(e.status!, "bad_request", e.message) : e; }));
        }
        case "GET /v1/notify/take": case "POST /v1/notify/send": case "POST /v1/notify/ack": {
          const w = await moduleOf(req);
          if (!notify) throw fail(503, "unavailable", "notify is off");
          if (hit!.path === "/v1/notify/ack") return send(res, 200, notify.ack(w.roles, await json(req)));
          return send(res, 200, hit!.method === "GET" ? notify.take(w.roles) : await notify.send(w.roles, await json(req)));
        }
        case "POST /v1/health/probe": {
          const given = Buffer.from(String(req.headers["x-health-key"] ?? "")), want = Buffer.from(healthKey());
          if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) throw fail(401, "unauthorized", "the health probe key is required");
          if (!healthProbe) throw fail(503, "unavailable", "the health probe is off");
          return send(res, 200, await healthProbe(await json(req)));
        }
        case "POST /v1/checkout": {
          if (!jobTools || !codehost) throw fail(503, "unavailable", "repo-checkout is off");
          let snap;
          try { snap = jobTools.checkout(bearer(req), await json(req)); } catch (e) {
            const j = e as { name?: string; status?: number; code?: string; message: string };
            if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
            throw e;
          }
          return await codehost(hostOf(snap.repo), "snapshot", snap, res);
        }
        case "POST /v1/jobtools/module/:module/:cmd": {
          if (!moduleTool) throw fail(503, "unavailable", "module job tools are off");
          const b = await json(req, JOBTOOL_BODY_MAX);
          let out;
          try { out = await moduleTool(bearer(req), m[0]!, m[1]!, b); } catch (e) {
            const j = e as { name?: string; status?: number; code?: string; message: string };
            if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
            throw e;
          }
          return void res.writeHead(out.status, { "content-type": "application/json" }).end(out.body);
        }
        case "POST /v1/jobtools/:cmd": {
          if (!jobTools) throw fail(503, "unavailable", "job tools are off");
          const b = await json(req);
          if (m[0] === "review") {
            if (!precheck) throw fail(503, "unavailable", "the precheck is off");
            const token = bearer(req);
            const w = await whoami(token).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const slot = () => { try { return jobTools.review(token); } catch (e) {
              const j = e as { name?: string; status?: number; code?: string; message: string };
              throw j.name === "JobToolError" ? fail(j.status!, j.code!, j.message) : e;
            } };
            return send(res, 200, await precheck(w, { kind: String(b.kind ?? ""), args: b.args }, slot));
          }
          if (m[0] === "git-token") {
            if (!appToken) throw fail(503, "unavailable", "git tokens are off");
            let c: { repo: string };
            try { c = jobTools.gitToken(bearer(req), b); } catch (e) {
              const j = e as { name?: string; status?: number; code?: string; message: string };
              if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
              throw e;
            }
            return send(res, 200, await appToken(c.repo).catch((e: { status?: number; message: string }) => { throw fail(e.status ?? 502, "no-token", e.message); }));
          }
          if (m[0] === "clone") {
            // The repo as a git bundle; the box clones it, or fetches it into the clone it has, itself.
            if (!repoBundle) throw fail(503, "unavailable", "aidenhq clone is off");
            let c: { repo: string; module: string; head?: string };
            try { c = jobTools.clone(bearer(req), b); } catch (e) {
              const j = e as { name?: string; status?: number; code?: string; message: string };
              if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
              throw e;
            }
            const out = await repoBundle(c.module, c.repo, c.head).catch((e: { status?: number; message: string }) => { throw fail(e.status ?? 500, "no-repo", e.message); });
            if ((out.statusCode ?? 502) >= 300) {
              let said = "";
              for await (const x of out) said += x;
              try { said = String((JSON.parse(said) as { error?: string }).error ?? said); } catch {}
              throw fail(out.statusCode ?? 502, "no-repo", said.slice(0, 300) || `the code host answered ${out.statusCode}`);
            }
            res.writeHead(200, { "content-type": "application/octet-stream", "x-aidenhq-repo": c.repo });
            // An aborted client ends the pipeline too: the request never hangs and the bundle's stream always closes.
            return void (await pipeline(out, res).catch(() => {}));
          }
          try { return send(res, 200, { text: jobTools.run(bearer(req), m[0]!, b) }); } catch (e) {
            const j = e as { name?: string; status?: number; code?: string; message: string };
            if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
            throw e;
          }
        }
        case "GET /v1/cp/read/*": case "ANY /v1/cp/owner/*": {
          const read = hit!.path === "/v1/cp/read/*";
          if (read && !isBoard(req)) break; // a module's read: below
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!boardCp) throw fail(503, "unavailable", "the board's control-plane routes are off");
          return await boardCp(req, res, read ? "read" : "owner", m[0]!, query);
        }
        case "POST /v1/connections/:module/ok": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!connectionState) throw fail(503, "unavailable", "connection state is off");
          if (!connectionState.has(m[0]!)) throw fail(404, "not_found", `no connection of module ${m[0]}`);
          return send(res, 200, { woken: connectionState.okModule(m[0]!) });
        }
        case "POST /v1/connections/need": {
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.owner-notice")) throw fail(403, "forbidden", `${w.module} may not report a connection need (role kernel.owner-notice)`);
          if (!connectionState) throw fail(503, "unavailable", "connection state is off");
          const b = await json(req);
          const need = readNeed({ isError: true, structuredContent: { error: "needs_owner", need: b?.need } });
          // The request's own faults are 400; an error recording the need (a database or idle-wake failure) is 5xx, so the module
          // retries it instead of reading a 400 as a need it must not send again.
          if (typeof b?.connection !== "string" || !need || !OWNER_CAUSES.includes(b.need?.cause)) throw fail(400, "bad_request", "send {connection, need: {cause, detail, …}}");
          try {
            await connectionState.report(w.module!, b.connection, need);
          } catch (e) {
            const err = e as Error & { code?: string };
            if (err.code === "unknown_connection") throw fail(400, "bad_request", err.message);
            throw fail(503, "unavailable", `the connection need could not be recorded: ${String(err.message).slice(0, 300)}`);
          }
          return send(res, 200, { ok: true });
        }
        case "POST /v1/connections/ok": {
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.owner-notice")) throw fail(403, "forbidden", `${w.module} may not report a connection success (role kernel.owner-notice)`);
          if (!connectionState) throw fail(503, "unavailable", "connection state is off");
          const b = await json(req);
          if (typeof b?.connection !== "string" || typeof b?.org !== "string" || !NAME.test(b.org)) throw fail(400, "bad_request", "send {connection, org}");
          if (!connectionState.owns(w.module!, b.connection)) throw fail(400, "bad_request", `${w.module} has no connection ${b.connection}`);
          return send(res, 200, { woken: connectionState.ok(b.connection, { org: b.org }) });
        }
        case "GET /v1/connections/down": {
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not read connection state (role kernel.jobs)`);
          if (!connectionState) throw fail(503, "unavailable", "connection state is off");
          const agent = new URLSearchParams(q ?? "").get("agent") ?? "";
          if (!/^[\w-]{1,100}$/.test(agent)) throw fail(400, "bad_request", "send ?agent=<id>");
          return send(res, 200, { down: connectionState.downFor(agent) });
        }
        case "GET /v1/connections/needs": {
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.notify")) throw fail(403, "forbidden", `${w.module} may not read connection state (role kernel.notify)`);
          if (!connectionState) throw fail(503, "unavailable", "connection state is off");
          return send(res, 200, { lines: connectionState.needs() });
        }
        case "GET /v1/connections/health": if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required"); return send(res, 200, { probes: connectionHealth ? await connectionHealth() : {} });
        case "GET /v1/advisories": if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required"); return send(res, 200, { advisories: advisories() });
        case "POST /v1/stop": {
          // The owner's Stop, from the board's signed-in admin: the running jobs of a task or an agent end `cancelled`, the task stays open with one fixed note.
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!jobs || !outcomes) throw fail(503, "unavailable", "jobs are off");
          const b = await json(req);
          const by = String(req.headers["x-aidenhq-account"] ?? "");
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(by)) throw fail(400, "bad_request", "X-AidenHQ-Account names the admin who stops it");
          if ((typeof b.task === "string") === (typeof b.agent === "string")) throw fail(400, "bad_request", "send {task} or {agent}");
          const stopped = jobs.stopRunning(typeof b.task === "string" ? { task: b.task } : { agent: b.agent }, by);
          for (const j of stopped) {
            log("job stopped by the owner", { job: j.id, task: j.task, agent: j.agent, by });
            await outcomes.post(j, { kind: "notice", body: STOPPED_NOTE }).catch((e: Error) => log("stop note failed", { job: j.id, err: e.message }));
          }
          return send(res, 200, { stopped: stopped.map((j) => j.id) });
        }
        case "POST /v1/validate": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!validate) throw fail(503, "unavailable", "validation is off");
          const b = await json(req, 200_000);
          if (typeof b.module !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(b.module) || !b.settings || typeof b.settings !== "object" || Array.isArray(b.settings)) throw fail(400, "bad_request", "send {module, settings}");
          return send(res, 200, await validate(b.module, { settings: b.settings as Record<string, unknown> }));
        }
        case "POST /v1/compile/check": {
          // A module with kernel.apply (the release train's code host) asks whether the instance as it stands compiles against
          // a product commit, before it commits and files a pin bump to it. Read-only: the instance is read at its main, the
          // target product's tree is compiled out of this checkout, and nothing is written on the host or filed.
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.apply")) throw fail(403, "forbidden", `${w.module} may not compile-check a product (role kernel.apply)`);
          if (!compileCheck) throw fail(503, "unavailable", "the compile preflight is off");
          const b = await json(req);
          const sha = (v: unknown) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
          if (!sha(b?.product) || (b?.instance !== undefined && !sha(b.instance)) || (b.pin !== undefined && !sha(b.pin))) throw fail(400, "bad_request", "send {product: <40-character commit>, instance?: <40-character commit>, pin?: <40-character commit>}");
          // A compile that couldn't run (git, network, a target this checkout doesn't have) is 503: the train retries, and never
          // reads it as the target refusing the instance.
          try { return send(res, 200, await compileCheck(b)); } catch (e) { return send(res, 503, { error: { code: 503, type: "unavailable", message: `the compile check couldn't run: ${String((e as Error).message).slice(0, 500)}` } }); }
        }
        case "POST /v1/settings/change": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!settingsChange) throw fail(503, "unavailable", "settings changes are off");
          const b = await json(req, 2_000_000);
          // The owner reads why: a refusal of the change itself, or the code host's or the planner's answer. `credential`: the
          // owner's board session or MCP sign-in it was made in (the kernel checks it; its account decides the record).
          try { return send(res, 200, await settingsChange(b.task, b.changes, b.credential)); } catch (e) { throw fail((e as { status?: number }).status ?? 502, "refused", String((e as Error).message).slice(0, 1000)); }
        }
        case "POST /v1/modules/share/preview":
        case "POST /v1/modules/share": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!sharing) throw fail(503, "unavailable", "sharing is off");
          const b = await json(req, 100_000);
          // The owner reads why: the export's refusal, the code host's, or the filing's (a moved tip, a private repo).
          try { return send(res, 200, await (hit!.path === "/v1/modules/share" ? sharing.share(b) : sharing.preview(b))); } catch (e) { throw fail((e as { status?: number }).status ?? 502, "refused", String((e as Error).message).slice(0, 1000)); }
        }
      }
      if (hit?.path === "/v1/settings/agent") {
        // A module holding kernel.settings, serving a kernel job's tool call in flight, on the job's own task: through the signed
        // tool self_change, the agent's change to itself; through any other, a setting whose module names one of the agent's
        // roles as a writer (settings-change.ts asAgent). The agent's key and roles are its live grants row's, never the assertion's.
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.settings")) throw fail(403, "forbidden", `${w.module} may not file settings changes (role kernel.settings)`);
        if (!settingsChange?.asAgent) throw fail(503, "unavailable", "settings changes are off");
        const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
        const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
        if (!live || job?.kind !== "run" || !job.task || !job.job || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight changes settings");
        const row = grantsFile().agents?.[job.agent!];
        if (!row?.key) throw fail(403, "forbidden", "the job's agent has no grants row");
        const requester = { agent: job.agent ?? "", key: String(row.key), name: job.name ?? "", roles: [...(row.roles ?? [])], kind: job.kind, task: job.task, ...(job.run ? { run: job.run } : {}), ...(job.model ? { model: job.model } : {}) };
        const b = await json(req, 400_000);
        // The task tools' own self_change (paperclip_tasks), never a same-named tool on another connection.
        const signed = String(live.caller.tool ?? ""), tool = signed === "paperclip_tasks.self_change" ? "self_change" : signed.endsWith(".self_change") ? "" : signed.split(".").pop();
        // A run an event routine fired (its job's routine is an event subscription, or its task was bound to a batch) read outside
        // text (Slack, GitHub): it changes nothing about itself; a task of its own may.
        const routine = (() => { try { return (records?.db.prepare("SELECT routine FROM jobs WHERE id = ?").get(job.job) as { routine: string | null } | undefined)?.routine; } catch { return undefined; } })();
        const evented = Boolean(routine && Object.values((grantsFile().routine_events ?? {}) as Record<string, { key?: string }>).some((s) => s.key === routine)) || Boolean(events?.fired(job.task));
        // An untrusted agent (it reads outside text by design) changes nothing about itself (compile never grants it either).
        if (tool === "self_change" && row.isolation === "untrusted") throw fail(403, "forbidden", "an untrusted agent changes nothing about itself");
        if (tool === "self_change" && evented) throw fail(403, "forbidden", "a run fired by events changes nothing about its agent: file the change as a task of your own (task_create), with the evidence, and make it there");
        try { return send(res, 200, await settingsChange.asAgent(requester, job.task, b.changes, w.module!, { tool, why: b.why })); } catch (e) { throw fail((e as { status?: number }).status ?? 502, "refused", String((e as Error).message).slice(0, 1000)); }
      }
      if (hit && (hit.path === "/v1/test-session" || hit.path === "/v1/test-session/:op")) {
        // Test-user sessions (test-session.ts): a module holding kernel.test-session serves a kernel job's own tool call in
        // flight (app_page_canary, or a module's job tool forwarded for that job). Who the agent is, and its roles, come from
        // its job token and grants row, never from the request body; the app list and the task's assignee are re-read in
        // test-session.ts. With no settings.edge.test_user the route refuses everything.
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.test-session")) throw fail(403, "forbidden", `${w.module} may not reach the test session (role kernel.test-session)`);
        const sessions = testSessions?.();
        if (!sessions) throw fail(503, "unavailable", "test sessions are off");
        const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
        const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
        if (!live || job?.kind !== "run" || !job.task || !job.job || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight opens a test session");
        // The mode is the kernel's: app_page_canary's one feedback submission writes (test-write); every other caller reads.
        // AidenHQ apps never get more: a body asking for test-write or any is refused, whatever the app's own settings say.
        const canary = String(live.caller.tool ?? "") === "apps.app_page_canary";
        const b = await json(req);
        const op = hit.path === "/v1/test-session" ? "mint" : m[0]!;
        // The allowlist and the audit use the grants key; the task's assignee is the control plane's agent id.
        const who = { agentKey: String(job.key ?? ""), agentId: String(job.agent ?? ""), roles: job.roles ?? [], task: job.task };
        try {
          if (op === "mint") {
            if (typeof b.app !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(b.app)) throw fail(400, "bad_request", "send {app}");
            if (b.mode !== undefined && b.mode !== "read") throw fail(400, "bad_request", "an AidenHQ app's test session is read-only: send mode read or none");
            if (b.minutes !== undefined && (canary || typeof b.minutes !== "number")) throw fail(400, "bad_request", canary ? "app_page_canary's session is 15 minutes" : "minutes is a number");
            const t = await sessions.mint({ ...who, app: b.app, mode: canary && b.mode === undefined ? "test-write" : "read", ...(typeof b.minutes === "number" ? { minutes: b.minutes } : {}) });
            // The one place a code or cookie leaves the kernel: back to the tool call that asked, never to a browser.
            return send(res, 200, { app: t.app, host: t.host, expires: t.expires, mode: t.mode, email: t.email, code: t.code, state: t.state, id: t.id });
          }
          if (op === "check") {
            if (typeof b.cookie !== "string" || typeof b.host !== "string") throw fail(400, "bad_request", "send {cookie, host}");
            const r = await sessions.check({ cookie: b.cookie, host: b.host });
            return send(res, r ? 200 : 401, r ?? { error: "no test session" });
          }
          if (op === "revoke") {
            const sessionId = typeof b.sessionId === "string" ? b.sessionId : undefined;
            // The calling job's task always scopes the revocation, so one task can never end another's session by id.
            return send(res, 200, await sessions.revoke({ ...(sessionId ? { sessionId } : {}), task: who.task, reason: "caller finished" }));
          }
          throw fail(404, "not_found", `no test session op ${op}`);
        } catch (e) {
          if (e instanceof TestSessionError) throw fail(e.status, e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "bad_request", (e as Error).message);
          throw e;
        }
      }
      if (hit?.path === "/v1/memory/:op") {
        // A module holding kernel.memory, serving a kernel job's memory_<op> call in flight: the job is read from its own token
        // and its agent from the grants table, never the body's say-so (a lane turn holds no job, so it never writes memory).
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.memory")) throw fail(403, "forbidden", `${w.module} may not reach agents' memory (role kernel.memory)`);
        if (!memory) throw fail(503, "unavailable", "memory is off");
        const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
        const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
        if (!live || job?.kind !== "run" || !job.task || !job.job || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight reaches memory");
        const op = m[0]!;
        if (!["note", "forget", "read", "rewrite"].includes(op)) throw fail(404, "not_found", `no memory op ${op}`);
        if (String(live.caller.tool ?? "") !== `paperclip_tasks.memory_${op}`) throw fail(403, "forbidden", `memory ${op} is memory_${op}'s only`);
        const agents = grantsFile().agents ?? {}, row = agents[job.agent!];
        if (!row?.key) throw fail(403, "forbidden", "the job's agent has no grants row");
        const keys = Object.values(agents).map((g) => String(g.key ?? "")).filter(Boolean);
        try { return send(res, 200, memoryOp(memory, op, await json(req, 100_000), { key: row.key, job: job.job, task: job.task, librarian: (row.roles ?? []).includes("librarian") }, keys)); } catch (e) { if (e instanceof MemoryError) throw fail(e.status, "refused", e.message); throw e; }
      }
      if (hit?.path === "/v1/memory/:key") {
        if (!isBoard(req)) { const w = await moduleOf(req); if (!w.roles.includes("kernel.lane")) throw fail(403, "forbidden", `${w.module} may not read agents' memory (role kernel.lane)`); }
        if (!memory) throw fail(503, "unavailable", "memory is off");
        const key = decodeURIComponent(m[0]!);
        if (!Object.values(grantsFile().agents ?? {}).some((g) => g.key === key)) throw fail(404, "not_found", `no agent ${key.slice(0, 60)}`);
        const { doc } = memory.read(key);
        return send(res, 200, { view: memoryView(doc), facts: doc.facts, updated: memory.updated(key) ?? null });
      }
      if (hit?.path === "/v1/events/log" || hit?.path === "/v1/events/readers") {
        // The log's own grant: the module's compiled subscription (events.log refuses one without it); readers is fleet state.
        const w = await moduleOf(req);
        if (!events) throw fail(503, "unavailable", "events are off");
        const p = new URLSearchParams(q ?? "");
        try {
          if (hit.path === "/v1/events/readers") {
            if (!w.roles.includes("kernel.flow-read")) throw fail(403, "forbidden", `${w.module} may not read the event readers (role kernel.flow-read)`);
            return send(res, 200, { readers: events.readers() });
          }
          const after = p.get("after"), limit = Math.floor(Number(p.get("limit") ?? 200));
          if (after !== null && !/^\d{1,15}$/.test(after)) throw fail(400, "bad_request", "after is a log seq");
          return send(res, 200, events.log(w.module!, String(p.get("connection") ?? ""), after === null ? undefined : Number(after), Number.isFinite(limit) ? limit : 200));
        } catch (e) { if (e instanceof EventsError) throw fail(e.status, "refused", e.message); throw e; }
      }
      if (hit?.path.startsWith("/v1/events")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.events")) throw fail(403, "forbidden", `${w.module} may not reach the event router (role kernel.events)`);
        if (!events) throw fail(503, "unavailable", "events are off");
        try {
          if (hit.path === "/v1/events") return send(res, 200, events.ingest(w.module!, await json(req, 64_000)));
          if (hit.path === "/v1/events/sources") return send(res, 200, { resources: events.resources(w.module!, String(new URLSearchParams(q ?? "").get("connection") ?? "")) });
          // A kernel job's routine_events call in flight: the job, its task, agent and routine from its own token and row.
          const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
          const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
          if (!live || job?.kind !== "run" || !job.task || !job.job || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight reads a batch");
          if (String(live.caller.tool ?? "") !== "paperclip_tasks.routine_events") throw fail(403, "forbidden", "a batch is routine_events's only");
          const row = records?.db.prepare("SELECT routine FROM jobs WHERE id = ?").get(job.job) as { routine: string | null } | undefined;
          return send(res, 200, await events.batch({ task: job.task, agent: job.agent!, routine: row?.routine }, m[0]!));
        } catch (e) { if (e instanceof EventsError) throw fail(e.status, "refused", e.message); throw e; }
      }
      if (hit?.path === "/v1/routing/:op") {
        // A module holding kernel.routing (the fleet-steward), serving a kernel job's tool call in flight: the job is read from
        // its own token, which the kernel keeps for that call, and must hold the routing-tuner role. Never the body's say-so.
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.routing")) throw fail(403, "forbidden", `${w.module} may not tune routing (role kernel.routing)`);
        if (!routing) throw fail(503, "unavailable", "routing tuning is off");
        const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
        const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
        if (!live || job?.kind !== "run" || !job.task || !job.job || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight tunes routing");
        if (!job.roles.includes("routing-tuner")) throw fail(403, "forbidden", "routing changes are for an agent with the routing-tuner role");
        const op = m[0]!;
        if (!["evidence", "replay", "tune", "judge"].includes(op)) throw fail(404, "not_found", `no routing op ${op}`);
        const requester = { agent: job.agent ?? "", key: job.key ?? "", name: job.name ?? "", roles: job.roles, kind: job.kind, task: job.task, ...(job.run ? { run: job.run } : {}), ...(job.model ? { model: job.model } : {}) };
        const b = await json(req);
        try {
          return send(res, 200, op === "evidence" ? await routing.evidence(b) : op === "replay" ? routing.replay(b) : op === "tune" ? await routing.tune(requester, job.task, b) : await routing.judge(requester, job.task));
        } catch (e) { throw fail((e as { status?: number }).status ?? 502, "refused", String((e as Error).message).slice(0, 1000)); }
      }
      if (hit?.path === "/v1/tasks/state") {
        if (!isBoard(req)) { const w = await moduleOf(req); if (!w.roles.includes("kernel.flow-read")) throw fail(403, "forbidden", `${w.module} may not read task state (role kernel.flow-read)`); }
        if (!taskStates) throw fail(503, "unavailable", "task state reads are off");
        const p = new URLSearchParams(q ?? ""), ids = p.get("ids")?.split(",").map((s) => s.trim()).filter(Boolean);
        const since = p.get("closed_since");
        if (since !== null && (p.get("open") !== "1" || !Number.isFinite(Date.parse(since)))) throw fail(400, "bad_request", "closed_since is an ISO instant, with ?open=1");
        if (p.get("open") === "1") return send(res, 200, await taskStates.named(taskStates.read({ open: true, ...(since ? { closed_since: new Date(since).toISOString() } : {}) })));
        if (!ids?.length || ids.length > 200 || ids.some((s) => s.length > 100)) throw fail(400, "bad_request", "send ?open=1 or ?ids= (1 to 200 task ids or identifiers, comma-separated)");
        return send(res, 200, await taskStates.named(taskStates.read({ ids })));
      }
      if (hit?.path === "/v1/tasks/issues") {
        if (!isBoard(req)) { const w = await moduleOf(req); if (!w.roles.includes("kernel.flow-read")) throw fail(403, "forbidden", `${w.module} may not read task state (role kernel.flow-read)`); }
        if (!taskStates) throw fail(503, "unavailable", "task state reads are off");
        const ids = new URLSearchParams(q ?? "").get("ids")?.split(",").map((s) => s.trim()).filter(Boolean);
        if (!ids?.length || ids.length > 200 || ids.some((s) => s.length > 100)) throw fail(400, "bad_request", "send ?ids= (1 to 200 task ids or identifiers, comma-separated)");
        return send(res, 200, taskStates.issues(ids));
      }
      if (hit?.path.startsWith("/v1/tasks")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.tasks")) throw fail(403, "forbidden", `${w.module} may not file tasks (role kernel.tasks)`);
        if (!tasks) throw fail(503, "unavailable", "module tasks are off");
        if (hit.method === "GET") {
          const r = await tasks.list(w.module!, String(new URLSearchParams(q ?? "").get("source") ?? "")).catch((e: { name?: string; status?: number; message: string }) => {
            throw e.name === "TaskError" ? fail(e.status!, "bad_request", e.message) : e;
          });
          return send(res, 200, r);
        }
        const b = await json(req);
        const r = await (hit.path === "/v1/tasks" ? tasks.file(w.module!, b) : hit.path.endsWith("/comment") ? tasks.comment(w.module!, decodeURIComponent(m[0]!), b) : tasks.close(w.module!, decodeURIComponent(m[0]!), b)).catch((e: { name?: string; status?: number; message: string }) => { throw e.name === "TaskError" ? fail(e.status!, "bad_request", e.message) : e; });
        return send(res, 200, r);
      }
      if (hit && (hit.path.startsWith("/v1/wakes") || hit.path === "/v1/routines/cancel")) {
        if (hit.path === "/v1/wakes/events") {
          if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
          if (!keyIs(req, eventsKey())) throw fail(401, "unauthorized", "the events plugin's key is required");
          const b = await json(req);
          // Answered at once: the scan runs once the task's events have gathered (wakes.ts event); the poll is the backstop.
          void wakes.event(b);
          return send(res, 200, { queued: true });
        }
        const w = await moduleOf(req);
        if (hit.path === "/v1/wakes") {
          if (!w.roles.includes("kernel.wake")) throw fail(403, "forbidden", `${w.module} may not schedule wakes (role kernel.wake)`);
          const b = await json(req);
          if (typeof b.text === "string") {
            // A wake notice now: the labelled comment on the task, posted as the owner, which wakes its agent.
            if (!owner) throw fail(503, "unavailable", "the control plane is off");
            const task = typeof b.task === "string" ? b.task.slice(0, 100) : "", text = neutral(b.text).trim().slice(0, 2000);
            if (!task || !text) throw fail(400, "bad_request", "send {task, text}");
            // `id`: the producer's own key for this notice. Filed again with the same one, it posts nothing: the comment already
            // carries that key, so a producer's retry (its answer was lost) never wakes the task's agent twice.
            const id = typeof b.id === "string" && /^[\w.-]{1,80}$/.test(b.id) ? b.id : undefined;
            if (b.id !== undefined && !id) throw fail(400, "bad_request", "id is [A-Za-z0-9_.-]{1,80}");
            // `quiet`: a note on the task, never a notice: it wakes nobody and is not anyone's words (the grading loop's failed-pass
            // note, which its agent has nothing to act on). It carries the grader's own marker so the evidence read skips it.
            const quiet = b.quiet === true;
            // `to: "asker"`: whoever asked for the task hears it, its open parent (asker.tell's open-parent path), else the task itself.
            const said = async (on: string) => wakeNotice(owner, on, text, id === undefined ? undefined : `${id}@${on}`, quiet).catch((e: Error) => { throw fail(502, "upstream", e.message); });
            if (b.to === "asker") {
              // A read that failed says nothing about the requester: retried (502), never read as "none" and posted on the task.
              const parent = await owner("GET", `/api/issues/${encodeURIComponent(task)}`).then((i) => {
                if (i.status === 200) return requestedParentOf(i.json);
                if (i.status === 404) return undefined;
                throw fail(502, "upstream", `the control plane answered ${i.status} reading the task`);
              }, (e: Error) => { throw fail(502, "upstream", e.message); });
              if (parent) {
                // The parent is only fallen through from when it cannot hear a notice: gone, or closed since. A send that failed (a
                // 502, a thread that could not be read) is the producer's to retry, never the task's to take in the parent's place —
                // the asker would hear it on the wrong task, and the retry would find nothing to do.
                const p = await said(String(parent));
                if (p === "posted" || p === "duplicate") return log("wake notice", { module: w.module, task: parent }), send(res, 200, { posted: true, to: "parent" });
              }
            }
            const r = await said(task);
            if (r === "missing") throw fail(404, "not_found", `no task ${task}`);
            if (r === "closed") return send(res, 200, { posted: false, closed: true });
            if (r === "duplicate") return send(res, 200, { posted: true, duplicate: true });
            log("wake notice", { module: w.module, task });
            return send(res, 200, { posted: true });
          }
          if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
          const r = await wakes.schedule(w.module!, b);
          if ("error" in r) throw fail("upstream" in r ? 503 : 400, "upstream" in r ? "upstream" : "bad_request", r.error!);
          return send(res, 200, r);
        }
        if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
        if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not claim wakes (role kernel.jobs)`);
        if (hit.path === "/v1/wakes/pending") {
          const params = new URLSearchParams(q ?? ""), task = params.get("task") ?? "";
          if (!/^[\w.:-]{1,100}$/.test(task)) throw fail(400, "bad_request", "send ?task=<id>");
          // `retry`: only the wake that restarts that run (dispatch's `retry.<job>`); `except`: one the caller is dropping.
          return send(res, 200, { pending: wakes.pending(w.module!, task, { retry: params.get("retry") ?? undefined, except: params.get("except") ?? "" }) });
        }
        const b = await json(req);
        if (hit.path === "/v1/wakes/claim") return send(res, 200, { wakes: wakes.claim(w.module!, Math.min(Math.max(Number(b.limit) || 20, 1), 100)) });
        if (hit.path === "/v1/routines/cancel") {
          const r = await wakes.cancelRoutineRun(w.module!, b).catch((e: { name?: string; status?: number; code?: string; message: string }) => {
            throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
          });
          if ("error" in r) throw fail(r.status, "bad_request", r.error);
          return send(res, 200, r);
        }
        if (hit.path === "/v1/wakes/:key/note") {
          const r = await wakes.note(w.module!, decodeURIComponent(m[0]!), b.body).catch((e: { name?: string; status?: number; code?: string; message: string }) => {
            throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
          });
          if ("error" in r) throw fail(r.status, "bad_request", r.error);
          return send(res, 200, r);
        }
        return send(res, 200, wakes.drop(w.module!, decodeURIComponent(m[0]!), String(b.why ?? "")));
      }
      if (hit && /^\/v1\/(channel|cp\/read|brake)/.test(hit.path)) {
        const w = await moduleOf(req);
        const mod = w.module!;
        // A channel's authority is its own token's: a module's other services hold connection keys, which never speak as the owner.
        if (isChannel(modules().modules?.[mod]) && !w.own) throw fail(403, "forbidden", `${mod} speaks as the owner only with its own token, not a connection's key`);
        if (!channels || !brake || !owner) throw fail(503, "unavailable", "channels are off");
        switch (`${hit.method} ${hit.path}`) {
          case "GET /v1/channel/cards": return send(res, 200, await channels.cards(mod, new URLSearchParams(q ?? "").get("resync") === "1"));
          case "POST /v1/channel/decide": return send(res, 200, await channels.decide(mod, await json(req)));
          case "POST /v1/channel/owner-message": return send(res, 200, await channels.ownerMessage(mod, await json(req), cos));
          case "POST /v1/channel/thread": {
            const b = await json(req);
            return send(res, 200, await channels.thread(mod, b, (key) => { const e = Object.entries(grantsFile().agents ?? {}).find(([, g]) => key && g.key === key); return e && { id: e[0] }; }));
          }
          case "POST /v1/channel/stop": return send(res, 200, await channels.stop(mod, await json(req)));
          case "POST /v1/channel/exchange": {
            if (!w.roles.includes("kernel.lane")) throw fail(403, "forbidden", `${mod} may not write lane exchanges (role kernel.lane)`);
            if (!lane) throw fail(503, "unavailable", "the lane is off");
            return send(res, 200, await lane.exchange(mod, await json(req)));
          }
          case "GET /v1/cp/read/*": {
            if (!isChannel(modules().modules?.[mod]) && !w.roles.includes("kernel.cp-read")) throw fail(403, "forbidden", `${mod} has no read access to the control plane (role kernel.cp-read)`);
            const att = /^\/attachments\/([A-Za-z0-9_-]{1,100})\/content$/.exec(m[0]!);
            if (att) {
              // One attachment's bytes: only one listed on the task named by ?task= (the same listing a module reads), at most 25 MB.
              const task = new URLSearchParams(q ?? "").get("task") ?? "";
              if (!task || task.length > 100) throw fail(400, "bad_request", "send ?task=<the task the attachment is on>");
              if (!ownerRaw) throw fail(503, "unavailable", "the control plane is off");
              const list = await owner("GET", `/api/issues/${encodeURIComponent(task)}/attachments`);
              if (list.status !== 200 || !Array.isArray(list.json) || !list.json.some((a: { id?: string }) => a?.id === att[1])) throw fail(404, "not_found", `no attachment ${att[1]} on task ${task.slice(0, 100)}`);
              const r = await ownerRaw(`/api/attachments/${att[1]}/content`);
              if (!r.ok) throw fail(r.status === 404 ? 404 : 502, r.status === 404 ? "not_found" : "upstream", `the control plane answered ${r.status}`);
              if (Number(r.headers.get("content-length") ?? 0) > MAX_ATTACHMENT) throw fail(413, "too_large", `the attachment is over ${MAX_ATTACHMENT} bytes`);
              const bytes = Buffer.from(await r.arrayBuffer());
              if (bytes.length > MAX_ATTACHMENT) throw fail(413, "too_large", `the attachment is over ${MAX_ATTACHMENT} bytes`);
              return void res.writeHead(200, { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "content-length": bytes.length }).end(bytes);
            }
            if (!CP_READ_PATHS.some((re) => re.test(m[0]!))) throw fail(403, "forbidden", `GET ${m[0]} isn't a read route`);
            const r = await owner("GET", `${m[0]}${query}`);
            return send(res, r.status, r.json);
          }
          case "POST /v1/brake/notify": {
            if (!w.roles.includes("kernel.notify")) throw fail(403, "forbidden", "only the owner's router (role kernel.notify) asks the notify brake");
            return send(res, 200, await brake(await json(req)));
          }
        }
      }
      if (hit && /^\/v1\/((auth|accounts|apps|operator)\/:op|auth\/mcp\/:op|owner\/(decide|update))$/.test(hit.path)) {
        if (!accounts) throw fail(503, "unavailable", "accounts are off");
        return await accounts(req, res, hit.path.split("/")[2]!, hit.path.startsWith("/v1/owner/") ? hit.path.slice(10) : hit.path === "/v1/auth/mcp/:op" ? `mcp/${m[0]}` : m[0]!);
      }
      if (hit?.path === "/v1/flow") {
        if (!isBoard(req)) { const w = await moduleOf(req); if (!w.roles.includes("kernel.flow-read")) throw fail(403, "forbidden", `${w.module} may not read flow (role kernel.flow-read)`); }
        if (!flow) throw fail(503, "unavailable", "flow reads are off");
        return send(res, 200, flowRead(flow, new URLSearchParams(q ?? "")));
      }
      if (hit?.path === "/v1/work" && isBoard(req)) {
        if (!work) throw fail(503, "unavailable", "work reads are off");
        return send(res, 200, await workRead(work, new URLSearchParams(q ?? "")));
      }
      if (hit && hit.path.startsWith("/v1/work")) {
        // The sessions' leases are the board's alone.
        { const p = new URLSearchParams(q ?? ""); if (p.has("sessions") || p.has("session")) throw fail(403, "forbidden", "session reads are the board's"); }
        const w = await moduleOf(req);
        if (hit.path !== "/v1/work/grader-token" && !w.roles.includes("kernel.work-read")) throw fail(403, "forbidden", `${w.module} may not read kernel work (role kernel.work-read)`);
        if (!work) throw fail(503, "unavailable", "work reads are off");
        if (hit.path === "/v1/work/grader-token") {
          if (!w.roles.includes("kernel.grader")) throw fail(403, "forbidden", `${w.module} may not ask for grader tokens (role kernel.grader)`);
          const b = await json(req);
          if (typeof b.task !== "string" || !b.task) throw fail(400, "bad_request", "send {task}");
          if (!owner) throw fail(503, "unavailable", "the control plane is off");
          const issue = await owner("GET", `/api/issues/${encodeURIComponent(b.task.slice(0, 100))}`);
          if (issue.status !== 200 && issue.status !== 404) throw fail(502, "upstream", `the control plane answered ${issue.status}`);
          // Only a task the module's own finish check holds (finished, waiting for its verdict), and only for as long as it
          // does: the recorded hold row, or the check's own label on a task still in review.
          if (issue.status === 404 || !(await checks?.held(w.module!, issue.json))) throw fail(403, "forbidden", `no finish check of ${w.module} holds task ${b.task.slice(0, 100)}`);
          if (typeof issue.json.assigneeAgentId !== "string") throw fail(404, "not_found", `no task ${b.task.slice(0, 100)} with an assignee`);
          return send(res, 200, { token: graderToken(b.task.slice(0, 100), issue.json.assigneeAgentId) });
        }
        if (hit.path === "/v1/work/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(work.metrics());
        return send(res, 200, await workRead(work, new URLSearchParams(q ?? "")));
      }
      if (hit?.path === "/v1/objects") {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.work-read")) throw fail(403, "forbidden", `${w.module} may not read kernel work (role kernel.work-read)`);
        if (!records) throw fail(503, "unavailable", "records are off");
        const p = new URLSearchParams(q ?? "");
        const ref = p.get("ref");
        if (ref) { const o = records.objectOf(ref); return send(res, 200, o ? { ours: true, record: o.record, at: o.at } : { ours: false }); }
        const since = p.get("since") ?? "";
        if (p.get("type") !== "pr" || Number.isNaN(Date.parse(since))) throw fail(400, "bad_request", "send ?ref=<ref>, or ?type=pr&since=<iso>");
        return send(res, 200, { refs: records.objectsSince(new Date(since).toISOString()) });
      }
      if (hit?.path === "/v1/codehost/:op") {
        const w = await moduleOf(req);
        if (!codehost) throw fail(404, "not_found", "no GitHub code host here");
        return await codehost(w.module!, m[0]!, await json(req), res);
      }
      if (hit && hit.path.startsWith("/v1/jobs")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not run jobs (role kernel.jobs)`);
        if (!jobs) throw fail(503, "unavailable", "jobs are off");
        try {
          switch (`${hit.method} ${hit.path}`) {
            case "POST /v1/jobs": {
              // {wake, prompt, session?}: every job is admitted by the kernel, on a wake its module claimed.
              if (!admission) throw fail(503, "unavailable", "admission is off");
              const b = await json(req, 4_000_000);
              if (typeof (b as { wake?: unknown })?.wake !== "string") throw fail(400, "bad_request", "send {wake, prompt, session?}");
              return send(res, 200, await admission.admit(w.module!, b as never));
            }
            case "GET /v1/jobs": {
              const p = new URLSearchParams(q ?? "");
              const task = p.get("task");
              if (!task && !p.has("open")) throw fail(400, "bad_request", "send ?open=1 or ?task=<id>");
              return send(res, 200, { jobs: jobs.list(w.module!, task ? { task } : { open: true }) });
            }
            case "POST /v1/jobs/workspace": return send(res, 200, await jobs.workspace(w.module!, (await json(req)).task));
            case "GET /v1/jobs/:job": {
              const p = new URLSearchParams(q ?? "");
              return send(res, 200, await jobs.get(w.module!, m[0]!, { ...(p.has("after") ? { after: Number(p.get("after")) } : {}), waitMs: Number(p.get("wait") ?? 0) || 0 }));
            }
            case "DELETE /v1/jobs/:job": return send(res, 200, jobs.stop(w.module!, m[0]!));
            case "POST /v1/jobs/:job/input": {
              const b = await json(req);
              if (typeof b.text !== "string") throw fail(400, "bad_request", "send {text}");
              const r = jobs.input(w.module!, m[0]!, b.text, typeof b.from === "string" ? b.from : "owner", typeof b.comment === "string" ? b.comment : undefined);
              // A claimed comment wake is delivered only once the run took it.
              if (r.sent && typeof b.wake === "string") wakes?.delivered(w.module!, b.wake, m[0]!);
              return send(res, 200, r);
            }
            case "POST /v1/jobs/:job/ack": return send(res, 200, jobs.ack(w.module!, m[0]!));
            case "POST /v1/jobs/:job/post": {
              if (!outcomes) throw fail(503, "unavailable", "outcomes are off");
              const job = await jobs.get(w.module!, m[0]!);
              const b = await json(req);
              if (!JOB_KINDS.includes(b.kind) || typeof b.body !== "string") throw fail(400, "bad_request", `send {kind: ${JOB_KINDS.join("|")}, body, status?, blocked_by?}`);
              if (b.blocked_by !== undefined && !(Array.isArray(b.blocked_by) && b.blocked_by.every((x: unknown) => typeof x === "string"))) throw fail(400, "bad_request", "blocked_by is a list of task ids");
              if (b.turn !== undefined && !(typeof b.turn === "string" && /^[\w-]{1,100}$/.test(b.turn))) throw fail(400, "bad_request", "turn is a turn's id");
              return send(res, 200, await outcomes.post(job, { kind: b.kind, body: b.body, ...(b.turn ? { turn: b.turn } : {}), ...(typeof b.status === "string" ? { status: b.status } : {}), ...(b.blocked_by ? { blockedBy: b.blocked_by } : {}) }));
            }
          }
        } catch (e) {
          const j = e as { name?: string; status?: number; code?: string; message: string };
          if (j.name === "JobError" || j.name === "OutcomeError") throw fail(j.status!, j.code!, j.message);
          throw e;
        }
      }
      if (hit && ["/v1/checks", "/v1/checks/inputs", "/v1/checks/:check", "/v1/checks/:check/kept", "/v1/receipts/verify"].includes(hit.path)) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.checks")) throw fail(403, "forbidden", `${w.module} may not run checks (role kernel.checks)`);
        if (!checkJobs) throw fail(503, "unavailable", "check jobs are off");
        try {
          if (hit.path === "/v1/checks") return send(res, 200, checkJobs.start(w.module!, await json(req)));
          if (hit.path === "/v1/receipts/verify") { const b = await json(req); return send(res, 200, checkJobs.verify(b.receipt, b.for ?? {})); }
          if (hit.path === "/v1/checks/inputs") return send(res, 200, checkJobs.putInput(w.module!, await bytes(req, INPUT_MAX)));
          if (hit.path === "/v1/checks/:check/kept") {
            const data = checkJobs.kept(w.module!, m[0]!);
            if (!data) throw fail(404, "not_found", "the check kept no file");
            return void res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length }).end(data);
          }
          const p = new URLSearchParams(q ?? "");
          return send(res, 200, await checkJobs.get(w.module!, m[0]!, { ...(p.has("after") ? { after: Number(p.get("after")) } : {}), waitMs: Number(p.get("wait") ?? 0) || 0 }));
        } catch (e) {
          const c = e as { name?: string; status?: number; code?: string; message: string };
          if (c.name === "CheckError") throw fail(c.status!, c.code!, c.message);
          throw e;
        }
      }
      if (hit && hit.path.startsWith("/v1/reviews")) {
        if (!reviews) throw fail(503, "unavailable", "reviews are off");
        // A review request carries the whole diff: one past the reviewer's limit is still sent, so its verdict can say how large.
        if (hit.path === "/v1/reviews") {
          reviewer(req);
          const b = await json(req, 64_000_000);
          if (!b.request || typeof b.request !== "object") throw fail(400, "bad_request", "send {request}");
          return send(res, 200, await reviews.request(b.request));
        }
        const b = await json(req);
        if (!b || typeof b !== "object" || !reviews.verdict(m[0]!, bearer(req), b)) throw fail(404, "not_found", "no review waits for that token");
        return send(res, 200, { ok: true });
      }
      if (hit && hit.path.startsWith("/v1/writes")) {
        if (!writes || !records) throw fail(503, "unavailable", "records are off");
        const id = m[0] ?? "";
        switch (`${hit.method} ${hit.path}`) {
          case "POST /v1/writes": {
            const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const b = await json(req);
            const r = await writes.request(w, { kind: String(b.kind ?? ""), args: b.args, ...(typeof b.task === "string" ? { task: b.task } : {}), ...(b.evidence !== undefined ? { evidence: b.evidence } : {}) });
            return send(res, 200, { id: r.id, tier: r.tier, state: r.state });
          }
          case "GET /v1/writes": {
            if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
            const p = new URLSearchParams(q ?? "");
            // `id=<record id>`: that one record, whatever its state or age (the board's card page), shown as the lists show it.
            const one = p.get("id");
            const list = LISTS[p.get("state") ?? ""];
            if (!list && !one) throw fail(400, "bad_request", `state=${Object.keys(LISTS).join(", ")}, or id`);
            const task = p.get("task") || undefined;
            // The reviewed ones only (every Tier 0 write is a record too, and would crowd the cards out), unless `tier0=1`
            // asks for every record (the board's history shows Tier 0 runs after the fact); the review list says which wait out a
            // failed review's backoff.
            // `after=<record id>` is the next page in the same order (keyset): a reader that must see every matching record
            // (the board's live list) walks the pages instead of treating the largest one as the whole set.
            const after = p.get("after") || undefined;
            // `kinds`: only these record kinds (comma-separated). A read of one kind's history — a task's merge cards — must not
            // lose it behind newer writes of other kinds, whatever the page cap.
            const kinds = (p.get("kinds") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
            const rows = one ? [records.detail(one)].filter((r): r is NonNullable<typeof r> => Boolean(r)) : records.list(list!, Math.min(Number(p.get("limit")) || 100, 1000), { reviewed: p.get("tier0") !== "1", ...(task ? { task } : {}), ...(kinds.length ? { kinds } : {}), ...(after ? { after } : {}) });
            // An open record's card shows the whole diff the reviewer reads (context.diff), so the owner decides on all of it; the
            // reviewer's other input (the files' text) stays in the kernel.
            return send(res, 200, { records: rows.map(({ diff, ...r }) => ({ ...r, card: diff ? { ...r.card, details: diff } : r.card, state: records.shownState(r), ...(writes.retryAt(r.id) ? { retry_at: writes.retryAt(r.id) } : {}) })) });
          }
          case "GET /v1/writes/:id": {
            if (isBoard(req)) return send(res, 200, record(id));
            const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const r = record(id);
            const own = w.kind === "module" ? w.module === r.requester.module && r.requester.kind === "module" : Boolean(w.agent) && w.agent === r.requester.agent;
            // The kind's executor (as the outcome route checks it) reads only whether the record is still live.
            const exec = w.kind === "module" && w.module === r.executor.module && r.kind !== CONN_TOOL && (w.connection === undefined || (r.executor.url !== undefined && new URL(r.executor.url).hostname === w.connection));
            if (!own && exec) return send(res, 200, { id: r.id, state: r.state });
            if (!own) throw fail(404, "not_found", `no record ${id}`);
            // A module requester reads its own outcome as filed; a job reads it as its live answer would have come (fenced and capped).
            return send(res, 200, { id: r.id, kind: r.kind, tier: r.tier, state: r.state, outcome: w.kind === "module" ? r.outcome : writes.shownOutcome(r), ...(r.owner_reason ? { reason: r.owner_reason } : {}) });
          }
          case "GET /v1/writes/:id/chain": {
            // What was asked, as the AI reviewer reads it (review-loop.ts requestChain), from the task as it reads now: the
            // board's "Explain" on a card.
            if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
            if (!owner) throw fail(503, "unavailable", "the control plane is off");
            const issue = async (task: string) => { const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`); if (r.status !== 200) throw fail(404, "not_found", `no task ${task}`); return r.json; };
            return send(res, 200, { chain: await requestChain(await issue(record(id).task), issue) });
          }
          case "POST /v1/writes/:id/outcome": {
            const r = record(id);
            if (await whoami(bearer(req)).then((w) => w.kind !== "module" || r.kind === CONN_TOOL || w.module !== r.executor.module || (w.connection !== undefined && (!r.executor.url || new URL(r.executor.url).hostname !== w.connection)), () => true)) throw fail(403, "forbidden", "only the kind's executor reports its outcome");
            const b = await json(req);
            if (!writes.outcome(id, b.ok === true, String(b.text ?? "").slice(0, 200_000), b.objects)) throw fail(409, "conflict", `this record is ${record(id).state}`);
            return send(res, 200, { ok: true });
          }
          case "POST /v1/writes/:id/wait": {
            const r = record(id);
            if (await whoami(bearer(req)).then((w) => w.kind !== "module" || r.kind === CONN_TOOL || w.module !== r.executor.module || (w.connection !== undefined && (!r.executor.url || new URL(r.executor.url).hostname !== w.connection)), () => true)) throw fail(403, "forbidden", "only the kind's executor reports its wait");
            const b = await json(req);
            // The whole reason identifies the wait, so a change past the display cap still reaches the task: only the card and the
            // notice truncate what they show (the same 200_000 bound the outcome route puts on its text).
            const raw = String(b.reason ?? "").split("\u0000").join("").trim();
            // `{reason: ""}` clears a wait the executor no longer has (the review passed, or another wait replaces it): nothing is
            // shown and no notice goes out, so the card never keeps a reason the record has left.
            const reason = raw ? raw.slice(0, 200_000) : null;
            // Idempotent for an unchanged reason (200, `new: false`), and a record that has left `claimed` is a conflict.
            const fresh = writes.waiting(id, reason);
            if (!fresh && record(id).state !== "claimed") throw fail(409, "conflict", `this record is ${record(id).state}`);
            return send(res, 200, { ok: true, new: fresh });
          }
        }
      }
      send(res, 404, { error: "no such route" });
    } catch (err) {
      const e = err as Error & { status?: number; type?: string };
      const status = e.status ?? 500;
      if (status >= 500) log("backplane error", { url: path, status, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(res, status, { error: { code: status, type: e.type ?? "error", message: e.message } });
      else res.destroy();
    }
  };
}

/** The chief of staff: the agent holding the fleet-admin role in the grants table (found by role, never by key). */
export const chiefOfStaff = (agents: Record<string, Grant> | undefined) => Object.entries(agents ?? {}).find(([, g]) => (g.roles ?? []).includes("fleet-admin"))?.[0];
