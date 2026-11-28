// How people reach a teammate (board.reach, compiled into the points file): each channel module declares the entry points it
// offers for an agent, a list setting with one entry per agent (`{ agent, … }`). The teammate page's "How to reach" card reads
// them: real state only (the setting's applied value, the stored tokens), never a module's name. Pure but for its two reads.
import { existsSync, readFileSync } from "node:fs";
import type { PagePoint } from "./module-views.js";

/** One compiled entry (modules/board/schemas/reach.json); compile adds `module`. */
export interface ReachPoint { id: string; label: string; kind: "app" | "address"; setting: string; secret_map?: string; module: string }

export function reachPoints(file: string): ReachPoint[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).reach ?? []) : [];
}

/** `on`: in use; `needs`: set up but not working yet; `off`: not set up. */
export interface ReachRow { id: string; label: string; kind: ReachPoint["kind"]; state: "on" | "needs" | "off"; detail: string; address?: string[]; manage: { module: string; page?: string } }
export interface TeammateReach { rows: ReachRow[]; address: boolean }

/** The entries of the setting's list that name this agent (the setting's value is a list of objects with an `agent`). */
const entriesOf = (value: unknown, agent: string): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as { agent?: unknown }).agent === agent);

/** The page its Manage opens: the module's page that edits the secret map, else its first page; none sends the owner to the module's settings. */
const pageOf = (p: ReachPoint, pages: PagePoint[]) => {
  const own = pages.filter((x) => x.module === p.module);
  return (own.find((x) => p.secret_map && x.secret_maps?.some((s) => s.secret === p.secret_map)) ?? own[0])?.id;
};

export async function teammateReach({ agent, points, pages, settings, stored }: { agent: string; points: ReachPoint[]; pages: PagePoint[]; settings: Record<string, unknown>; stored: (module: string, secret: string) => Promise<string[] | null> }): Promise<TeammateReach> {
  const rows = await Promise.all(
    points.map(async (p): Promise<ReachRow> => {
      const entries = entriesOf(settings[p.setting], agent);
      const manage = { module: p.module, ...(pageOf(p, pages) ? { page: pageOf(p, pages)! } : {}) };
      const row = { id: `${p.module}:${p.id}`, label: p.label, kind: p.kind, manage };
      if (!entries.length) return { ...row, state: "off", detail: p.kind === "address" ? "No address yet" : "Not set up" };
      if (p.kind === "address") {
        const address = [...new Set(entries.flatMap((e) => (typeof e.address === "string" && e.address ? [e.address] : [])))];
        return { ...row, state: "on", detail: address.join(", "), address };
      }
      // A dedicated app works once its tokens are stored; a read that fails is no answer, so it counts as set up.
      const keys = p.secret_map ? await stored(p.module, p.secret_map) : null;
      return keys && !keys.includes(agent) ? { ...row, state: "needs", detail: "Waiting for its app tokens" } : { ...row, state: "on", detail: "Connected as its own app" };
    }),
  );
  return { rows, address: rows.some((r) => r.state === "on" && r.address?.length) };
}
