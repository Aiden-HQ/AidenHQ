// The design connection's tools. Reads: design_runs, design_run, design_image, design_apps, and design_evidence_put,
// design_run_finish and design_issue_note (the GitHub issue a pass filed for a marker): they write only into this module's own
// store. Writes: design_run_start, design_pass_start (files a task), design_pass_stop (closes one).
// A run belongs to the agent that started it, or a pass to the agent its task went to (the caller's signed assertion), and only
// that agent writes to it.
import type { Tool } from "./mcp.ts";
import type { Store } from "./store.ts";
import { ceiling, DEPTHS, MODES, type App, type Depth, type Login, type Mode, type Passes } from "./passes.ts";

const str = { type: "string" };
const obj = (properties: object, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export function designTools(store: Store, p: { passes: Passes; apps: () => App[]; logins: () => Record<string, Login> }): Tool[] {
  const s = (v: unknown) => String(v ?? "");
  return [
    { name: "design_run_start", description: "Start a design run of a target (a URL or repo@commit) for the calling task and agent; returns its run id. Put its evidence with design_evidence_put, then finish it.",
      inputSchema: obj({ target: str, kind: { type: "string", enum: ["review"] }, model: str, app: str }, ["target", "kind", "model"]),
      run: async (a, c) => store.start({ target: s(a.target), kind: s(a.kind), model: s(a.model), app: a.app === undefined ? undefined : s(a.app), task: c.task, agent: c.agent }) },
    { name: "design_evidence_put", description: "Store files for your run: { name, data (base64) }, at most 8 MB per call; names are letters, digits, . _ - ending .png .jpg .webp .json .md .diff or .webm (a recording goes in a call of its own). In a box, `ui-review put` sends files for you.",
      inputSchema: obj({ run: str, files: { type: "array", items: obj({ name: str, data: str }, ["name", "data"]) } }, ["run", "files"]),
      run: async (a, c) => store.put(s(a.run), c.agent, a.files as { name: string; data: string }[]) },
    { name: "design_run_finish", description: "Finish your run with its report (the ui-review report.json object); returns the run's board url.",
      inputSchema: obj({ run: str, report: { type: "object" } }, ["run", "report"]),
      run: async (a, c) => store.finish(s(a.run), c.agent, a.report as Record<string, unknown>) },
    { name: "design_runs", description: "Recent design runs, newest first, optionally of one app.",
      inputSchema: obj({ app: str, limit: { type: "integer" } }),
      run: async (a) => store.runs({ app: a.app === undefined ? undefined : s(a.app), limit: a.limit === undefined ? undefined : Number(a.limit) }) },
    { name: "design_run", description: "One run: its row, its report, the names of its evidence files and its app's known GitHub issues (marker, repo, number).", inputSchema: obj({ run: str }, ["run"]),
      run: async (a) => { const r = store.run(s(a.run)); return { ...r, issues: r.run.app ? store.issues(r.run.app) : [] }; } },
    { name: "design_issue_note", description: "Remember the GitHub issue you filed or adopted for a marker (ui-review issue-body prints each marker, without its <!-- -->): later passes update that number and never search for it again. Call it at once after the issue is created or found.",
      inputSchema: obj({ app: str, marker: str, repo: str, number: { type: "integer" } }, ["app", "marker", "repo", "number"]),
      run: async (a) => store.noteIssue({ app: s(a.app), marker: s(a.marker), repo: s(a.repo), number: Number(a.number) }) },
    { name: "design_apps", description: "The apps set up for UI testing (settings.ui_testing): name, url, repo, whether it is an AidenHQ app, its live-app mode (the most a pass may do; AidenHQ apps are read-only) and whether a supplied login is set.",
      inputSchema: obj({}),
      run: async () => { const logins = p.logins(); return { apps: p.apps().map((a) => ({ name: a.name, url: a.url, ...(a.repo ? { repo: a.repo } : {}), aidenhq_app: a.aidenhq_app, live_mode: ceiling(a), login: Boolean(logins[a.name]) })) }; } },
    { name: "design_pass_start", description: "Start a UI review pass of a configured app: files one task for the UI Reviewer against the app's url (or its repo's default branch, never a PR head) and returns { run, task }. depth (default from the app's spend mode): scan (signed out), signed-in or tester (clicking pass). mode may only narrow the app's live_mode. One pass runs per app; none starts once the app's passes billed its day cap (UTC).",
      inputSchema: obj({ app: str, depth: { type: "string", enum: [...DEPTHS] }, mode: { type: "string", enum: [...MODES] }, model: str }, ["app"]),
      run: async (a) => {
        const r = await p.passes.startPass(s(a.app), "request", { ...(a.depth !== undefined ? { depth: s(a.depth) as Depth } : {}), ...(a.mode !== undefined ? { mode: s(a.mode) as Mode } : {}), ...(a.model !== undefined ? { model: s(a.model) } : {}) });
        if ("refused" in r) throw new Error(`Refused: ${r.refused}${"run" in r ? `: ${r.run}` : r.refused === "unknown app" ? `: ${s(a.app).slice(0, 40)} isn't in settings.ui_testing` : ""}.`);
        return r;
      } },
    { name: "design_pass_stop", description: "Stop an app's running pass: closes its task, which stops its job; the run shows stopping until the job has ended, then stopped, and the app takes a new pass.",
      inputSchema: obj({ app: str }, ["app"]),
      run: async (a) => {
        const r = await p.passes.stopPass(s(a.app));
        if ("refused" in r) throw new Error(`Refused: ${r.refused}.`);
        return r;
      } },
    { name: "design_image", description: "One evidence file of a run as base64 data with its media type and size in bytes; with offset and length, only those bytes of it (`ui-review get` reads a big file in parts).",
      inputSchema: obj({ run: str, name: str, offset: { type: "integer" }, length: { type: "integer" } }, ["run", "name"]),
      run: async (a) => store.image(s(a.run), s(a.name), a.offset === undefined && a.length === undefined ? undefined : { offset: Number(a.offset ?? 0), length: Number(a.length ?? Infinity) }) },
  ];
}
