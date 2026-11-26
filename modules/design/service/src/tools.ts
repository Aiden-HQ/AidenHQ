// The design connection's tools. Reads: design_runs, design_run, design_image, and design_evidence_put and design_run_finish (they
// write only into this module's own store). Write: design_run_start. A run belongs to the agent that started it (the caller's signed assertion), and only that agent writes to it.
import type { Tool } from "./mcp.ts";
import type { Store } from "./store.ts";

const str = { type: "string" };
const obj = (properties: object, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export function designTools(store: Store): Tool[] {
  const s = (v: unknown) => String(v ?? "");
  return [
    { name: "design_run_start", description: "Start a design run of a target (a URL or repo@commit) for the calling task and agent; returns its run id. Put its evidence with design_evidence_put, then finish it.",
      inputSchema: obj({ target: str, kind: { type: "string", enum: ["review"] }, model: str, app: str }, ["target", "kind", "model"]),
      run: async (a, c) => store.start({ target: s(a.target), kind: s(a.kind), model: s(a.model), app: a.app === undefined ? undefined : s(a.app), task: c.task, agent: c.agent }) },
    { name: "design_evidence_put", description: "Store files for your run: { name, data (base64) }, at most 8 MB per call; names are letters, digits, . _ - ending .png .jpg .webp .json .md or .diff.",
      inputSchema: obj({ run: str, files: { type: "array", items: obj({ name: str, data: str }, ["name", "data"]) } }, ["run", "files"]),
      run: async (a, c) => store.put(s(a.run), c.agent, a.files as { name: string; data: string }[]) },
    { name: "design_run_finish", description: "Finish your run with its report (the ui-review report.json object); returns the run's board url.",
      inputSchema: obj({ run: str, report: { type: "object" } }, ["run", "report"]),
      run: async (a, c) => store.finish(s(a.run), c.agent, a.report as Record<string, unknown>) },
    { name: "design_runs", description: "Recent design runs, newest first, optionally of one app.",
      inputSchema: obj({ app: str, limit: { type: "integer" } }),
      run: async (a) => store.runs({ app: a.app === undefined ? undefined : s(a.app), limit: a.limit === undefined ? undefined : Number(a.limit) }) },
    { name: "design_run", description: "One run: its row, its report and the names of its evidence files.", inputSchema: obj({ run: str }, ["run"]), run: async (a) => store.run(s(a.run)) },
    { name: "design_image", description: "One evidence file of a run as base64 data with its media type.", inputSchema: obj({ run: str, name: str }, ["run", "name"]), run: async (a) => store.image(s(a.run), s(a.name)) },
  ];
}
