// Quality per approval tier, read-only: how many agent changes each approver let through over 7 and 30 days, and how many were
// reverted or tied to an incident (kernel/sdk/src/quality.ts has the matching rules; the board's fleet_status carries the
// same line for Fleet Ops' weekly review).
//   node scripts/quality.ts [--db <kernel.db>] [--github <file.json>] [--json]
// Records come from kernel.db (opened read-only). Reverts and incidents from GitHub come from `gh` (the repos the changes
// touched), or from --github: {"reverts": [Text], "incidents": [Text]}. Without GitHub the report still counts the reverts
// the fleet opened itself (their text is in the records) and says so.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changesFrom, oneLine, render, report, type Row, type Text } from "../kernel/sdk/src/quality.ts";

const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? undefined : process.argv[i + 1] ?? ""; };
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(flag("db") ?? path.resolve(repoDir, process.env.AIDENHQ_DATA_DIR ?? "data", "kernel", "kernel.db"), { readOnly: true });
const since = new Date(Date.now() - 31 * 864e5).toISOString();
const rows: Row[] = (db.prepare("SELECT id, kind, args, tier, panel, decided_by, state, outcome, updated_at, identifier FROM records WHERE updated_at >= ?").all(since) as unknown as { id: string; kind: string; args: string; tier: number; panel: number; decided_by: string | null; state: string; outcome: string | null; updated_at: string; identifier: string | null }[]).map((r) => ({
  id: r.id, kind: r.kind, args: JSON.parse(r.args), tier: r.tier, panel: r.panel === 1, by: r.decided_by, state: r.state, at: r.updated_at, outcome: r.outcome ? JSON.parse(r.outcome).text : null, identifier: r.identifier,
}));

const gh = (...a: string[]) => JSON.parse(execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
function github() {
  const file = flag("github");
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  // local/<repo>: this server's own change requests, not on GitHub.
  const repos = [...new Set(changesFrom(rows).map((c) => c.id.split("#")[0]!).filter((r) => r.includes("/") && !r.startsWith("local/")))];
  const out: { reverts: Text[]; incidents: Text[] } = { reverts: [], incidents: [] };
  for (const repo of repos) {
    const item = (i: { url: string; title: string; body?: string; number: number }) => ({ id: i.url, url: i.url, title: i.title, body: i.body ?? "", repo, number: i.number });
    out.reverts.push(...gh("pr", "list", "-R", repo, "--state", "merged", "--search", "revert in:title", "--json", "number,title,body,url", "-L", "200").map(item));
    out.incidents.push(...gh("issue", "list", "-R", repo, "--state", "all", "--search", "product-bug in:body", "--json", "number,title,body,url", "-L", "200").map(item));
  }
  return out;
}
let fromGitHub: { reverts: Text[]; incidents: Text[] } = { reverts: [], incidents: [] };
try { fromGitHub = github(); } catch (e) { console.error(`GitHub not read (${(e as Error).message.split("\n")[0]}): counting only the reverts the fleet opened itself`); }
const r = report(rows, fromGitHub);
console.log(process.argv.includes("--json") ? JSON.stringify({ ...r, line: oneLine(r) }, null, 2) : `${render(r)}\n\n${oneLine(r)}`);
