// Aria's tools on the module's MCP connection `aria`: the owner's page reads (`aria_config`) and proposes (`aria_configure`), and
// Aria's own `aria_suggest` (save a proposal for the page) and `aria_move_budget` (the nightly cap, optimizer-cap.ts).
// A change is validated whole. The owner's call (the Aria page) only proposes: it comes back as a typed settings change the board
// shows in its Save bar. An agent's call files the change itself (POST /v1/settings/agent), except turning the tidy-up on.
import { budget, type WorkRecord } from "./optimizer-cap.ts";
import { suggest, teamDomainOf, type Meeting } from "./prefill.ts";
import { DEFAULTS, KEYS, problem, problems, type Key } from "./settings.ts";
import type { Store } from "./state.ts";
import type { Tool } from "./mcp.ts";

type Dict = Record<string, unknown>;
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

export interface Deps {
  settings: () => Record<Key, unknown>;
  state: Store;
  env: { timezone: string; time_format: string; owner_email: string };
  now: () => Date;
  /** POST /v1/settings/agent as the calling job (its assertion goes along). */
  file: (changes: Dict[], assertion: string) => Promise<unknown>;
  /** GET /v1/work?since=: the kernel's write records since an instant. */
  work: (since: string) => Promise<WorkRecord[]>;
}

/** The setting after `change`: an object setting merges field by field, anything else is replaced, null puts the default back. */
export function applyChange(current: unknown, change: unknown, key: Key): unknown {
  if (change === null) return structuredClone(DEFAULTS[key]);
  return isMap(current) && isMap(change) ? { ...current, ...change } : change;
}

export function configTools(d: Deps): Tool[] {
  const plan = () => d.settings().aria_optimizer as { on: boolean; at: string; max_moves: number };
  return [
    {
      name: "aria_config", roles: ["aria-admin"],
      description: "Aria's settings as the owner has them (working hours, call windows, meeting lengths and buffers, VIPs and team domains, preferences, follow-up timing, the nightly tidy-up and its limits), their defaults, any problems, the owner's time zone and the proposal Aria last saved from reading their calendar.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const settings = d.settings(), t = d.state.get().tidy;
        return {
          settings, defaults: DEFAULTS, problems: problems(settings), timezone: d.env.timezone, time_format: d.env.time_format,
          owner_team_domain: teamDomainOf(d.env.owner_email) ?? null,
          suggestion: d.state.get().suggestion ?? null,
          tidy: { on: plan().on, at: plan().at, last_date: t?.date ?? null, last_task: t?.task ?? null },
        };
      },
    },
    {
      name: "aria_configure", roles: ["aria-admin"],
      description: `Propose changes to Aria's settings, in one settings change: { changes: { <setting>: <value> | null } }, null putting the default back. Settings: ${KEYS.join(", ")}. A map setting takes only the fields you name (the rest stay); a list inside it is replaced whole. Refused whole when the result wouldn't be valid. Turning the nightly tidy-up on (aria_optimizer.on) is the owner's own change from the Aria page.`,
      inputSchema: { type: "object", properties: { changes: { type: "object" } }, required: ["changes"], additionalProperties: false },
      run: async (a, caller) => {
        if (!isMap(a.changes) || !Object.keys(a.changes).length) throw new Error("say what to change: { changes: { <setting>: <value> } }");
        const current = d.settings(), out: Dict[] = [], summary: string[] = [];
        for (const [k, v] of Object.entries(a.changes)) {
          if (!(KEYS as readonly string[]).includes(k)) throw new Error(`there is no setting ${k.slice(0, 40)} (${KEYS.join(", ")})`);
          const key = k as Key, next = applyChange(current[key], v, key);
          const bad = problem(key, next);
          if (bad) throw new Error(`that wouldn't work: ${bad}`);
          if (JSON.stringify(next) === JSON.stringify(current[key])) continue;
          if (caller.kind !== "owner" && key === "aria_optimizer" && (next as { on: boolean }).on && !plan().on) throw new Error("turning the nightly tidy-up on is the owner's: ask them to switch it on from the Aria page");
          out.push({ kind: "setting", key, value: next });
          summary.push(`${key} changed`);
        }
        if (!out.length) return { changes: ["no changes"], _aidenhq: { settings_change: [] } };
        // The owner's own call (the Aria page) only proposes: the board shows it and files it on his Save.
        if (caller.kind === "owner") return { changes: summary, _aidenhq: { settings_change: out } };
        return { filed: await d.file(out, caller.assertion ?? ""), changes: summary };
      },
    },
    {
      name: "aria_suggest", roles: ["aria-admin"],
      description: "Save what you learned from reading the owner's last four weeks of meetings, for their Aria page to propose (they correct it and save; nothing changes until then): { meetings: [{ start, end, attendees?: [email], all_day?: boolean }], calendars?: [id] }, every timed meeting of the four weeks (all-day entries are ignored, so keep Google's all_day flag). Instants are ISO with an offset or Z. The service works out working hours per weekday, typical lengths and blocking calendars; you never do that arithmetic.",
      inputSchema: { type: "object", properties: { meetings: { type: "array", items: { type: "object", properties: { start: { type: "string" }, end: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, all_day: { type: "boolean" } }, required: ["start", "end"] } }, calendars: { type: "array", items: { type: "string" } } }, required: ["meetings"], additionalProperties: false },
      run: async (a) => {
        if (!Array.isArray(a.meetings) || a.meetings.length > 2000) throw new Error("send up to 2000 meetings");
        const s = suggest(a.meetings as Meeting[], { timeZone: d.env.timezone, ownerEmail: d.env.owner_email, calendars: Array.isArray(a.calendars) ? a.calendars.map(String) : [] });
        if (!s.based_on.meetings) throw new Error("none of those are timed meetings: send each one's start and end instants");
        // What is saved must be what the page can show and the settings accept.
        const bad = problem("aria_working_hours", s.working_hours) ?? problem("aria_meetings", { ...(DEFAULTS.aria_meetings as object), ...s.durations, blocking_calendars: s.blocking_calendars });
        if (bad) throw new Error(`that calendar gave a proposal the settings can't hold: ${bad}`);
        d.state.set({ ...d.state.get(), suggestion: { ...s, at: d.now().toISOString() } });
        return { saved: true, ...s };
      },
    },
    {
      name: "aria_move_budget", roles: ["aria-admin"],
      description: "How many meetings the nightly tidy-up may still move tonight: the cap (aria_optimizer.max_moves) less the reviewed calendar writes you have filed since tonight's tidy-up began, counted from the kernel's records. Call it before every move; at remaining 0, stop.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const t = d.state.get().tidy;
        // The night began when the task was filed; with no tidy-up on record (an owner's own ask), the last twelve hours.
        const since = t?.filed_at ?? new Date(d.now().getTime() - 12 * 3_600_000).toISOString();
        return { since, ...budget(await d.work(since), "aria", since, plan().max_moves) };
      },
    },
  ];
}
