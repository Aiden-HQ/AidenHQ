// The public contract types (spec §3.3.1). engine@1 minor additions are marked "minor": optional for engines, always
// written by the runner.

/** A module's `providers.executor` (spec §3.3.2): its write kinds' executor endpoint and the secret the kernel calls it with. */
export interface ExecutorDecl { contract: "executor@1"; url: string; auth: string }
/** A module's `providers.reviewer` (spec §3.3.3; reviewer.ts): its review endpoint and the secret the kernel calls it with. */
export interface ReviewerDecl { contract: "reviewer@1"; url: string; auth: string }

export interface Caller { agent: string; roles: string[]; task?: string; run?: string; job?: string; module?: string }
export interface CardText { sentence: string; changes: string; reads: string; cost: string; tier: 0 | 1 | 2; panel: boolean;
                            kind: string; digest: string; requester: string; task: string }

// job dir (read-write for the engine), the task folder is the engine's working directory
export interface JobSpec {     // <job dir>/job.json, written by the runner
  contract: "engine@1";
  job: string; agent: string; task: string;
  prompt: string;              // composed by the requesting module
  session?: string;            // resume a prior session id the engine reported
  model: { base_url: string; token_env: string; id: string; effort: string;   // token_env: AIDENHQ_MODEL_TOKEN (a box: its run token)
           models?: string[] };   // minor: the model ids the agent offers (its frozen authority's)
  // minor (filled): the job's frozen connections, each through the box gateway's proxy with the run token as X-Agent-Key; the
  // proxy enforces the tools, the list only names them
  mcp: { name: string; url: string; token_env: "AIDENHQ_RUN_TOKEN"; tools: string[]; tool_timeout_s?: number }[];
  env: string[];               // names of env vars set (jobcap secrets)
  limits: { timeout_s: number };
  web: boolean;                // minor: false when the job holds private data (no web search or fetch)
  state?: string;              // minor: the engine's own state folder (its sessions), read-write, as the box sees it
  // minor: a code-mode engine's (`tools: code`) connections as files: their folder and the index its instructions name; `mcp` is then empty
  tools?: { dir: string; index: string };
  sandbox: { kind: "box"; writable: string[]; network: boolean };   // minor: the boundary the engine runs in
}
export type EngineEvent =      // <job dir>/events.jsonl, appended by the engine
  | { t: "progress"; text: string; plan?: { step: string; done: boolean; doing?: boolean }[]; steps?: { at: string; text: string }[] }
  | { t: "usage"; input: number; output: number; cached?: number; model: string }
  | { t: "session"; id: string }
  | { t: "final"; text: string }
  | { t: "reply"; id: string; text: string; start?: number; end?: number };   // a long-lived session's finished turn: its last words, posted on the task (id: that text's own, once per turn), unless the job commented on its task between start and end (epoch ms)
// <job dir>/inbox.jsonl, appended by the runner: { t: "comment"; from: string; text: string }   (only if live_input)
export interface InboxLine { t: "comment"; from: string; text: string }
// exit code: 0 = turn done; non-zero = failed (the runner reports, the requesting module decides retries)
