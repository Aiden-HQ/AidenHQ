// The Servers page's read tools, on the module's MCP connection `server-manager` (spec §9): the machines as the instance holds them
// with their defaults resolved, each machine's last readout as the status store keeps it, and — this slice — the live read pass
// over SSH (`server_manager_check`). The check is a read: it files no record (§6), and it is the only tool here that opens a
// connection. The writes arrive with the executor (slice 3); until then the three write names answer plainly.
import type { Tool } from "./mcp.ts";
import { readMachines, MACHINE_FIELDS, DEFAULTS, listProblems, savedList, type Machine, type Problem } from "./config.ts";
import type { StatusStore } from "./status-store.ts";
import { readKeys, TIMEOUTS, withConnection, type Keys, type SshMachine, type Transport } from "./ssh.ts";
import { detect, parseOsRelease, UPDATE_ARGV } from "./apt.ts";
import { publish, publishRow, READ, readHost, rowOf, stateOfError } from "./status.ts";

type Dict = Record<string, unknown>;

/** What a machine's summary line is built from, for the page and the agent: its own settings, one plain sentence each. */
export function summaryOf(m: Machine): string {
  const every = m.security_minutes >= 60 && m.security_minutes % 60 === 0 ? `${m.security_minutes / 60}h` : `${m.security_minutes}m`;
  const reboot = m.reboot_policy === "auto" ? "reboots in its quiet window" : "asks before rebooting";
  const on = m.enabled ? `checks every ${every}` : "is off";
  return `${on}; weekly pass ${m.weekly_day} ${m.weekly_time}; ${reboot} (${m.quiet_start}–${m.quiet_end}); key "${m.key}".`;
}

/** The three write tools are the owner's own actions on the page: an agent's call is refused, whoever it names (§9). */
export function ownerOnly(who: { kind?: string }): void {
  if (who.kind !== "owner") throw new Error("this action is the owner's: it is taken from the Servers page, and no agent may file it");
}

/** What a page tool needs to file a record, which the board's view may only do through this service (§3, §6, §9). */
export interface Filing {
  /** Files one of the module's kinds for a machine and returns its id, tier and state. */
  file: (kind: "server-manager.patch" | "server-manager.reboot", args: Record<string, unknown>, machine: string) => Promise<{ id: string; tier: number; state: string }>;
}

/** One machine's target for the transport: only the fields ssh.ts may see, and never the key's value. */
export const targetOf = (m: Machine): SshMachine => ({ name: m.name, address: m.address, port: m.port, user: m.user, key: m.key, expected_fingerprint: m.expected_fingerprint });

/**
 * Checks one machine and records what it saw in the page's store: the one read pass the page, the agent and the schedule share.
 * The failure is a result, not an exception: a host that is unreachable, refuses the key or changed its host key records that
 * state, so a stale healthy row is never left standing and the rest of the fleet is still checked.
 */
export async function checkOne(m: Machine, transport: Transport, keys: Keys, status: StatusStore, opts: { refresh?: boolean } = {}) {
  const at = new Date().toISOString();
  let checked: Awaited<ReturnType<typeof readHost>>;
  try {
    // `refresh`: the schedule's check first refreshes apt's index (it installs nothing), so a newly published fix is seen even on a
    // host that never refreshes on its own. The page's "check now" reads the index as it is.
    checked = await withConnection(transport, targetOf(m), keys, async (c, pin) => {
      // Only on a supported host: an unsupported one is reported as such by the read, never as a failed refresh.
      if (opts.refresh && !("unsupported" in detect(parseOsRelease((await c.exec([...READ.osRelease])).stdout)))) await c.exec([...UPDATE_ARGV], TIMEOUTS.lock);
      return readHost(c, pin);
    });
  } catch (e) {
    checked = { ...stateOfError(e), ok: false };
  }
  const row = rowOf(m, checked, at);
  status.put(row);
  return { row, checked };
}

/** Every name the saved list holds, valid or not: the warehouse keeps exactly these machines' rows. */
export function inventoryOf(saved: string): string[] {
  const { machines } = readMachines(saved);
  return [...new Set([...machines.map((m) => m.name), ...(savedList(saved) ?? []).flatMap((e) => (typeof e.name === "string" && e.name ? [e.name] : []))])];
}

export function configTools(d: {
  machines: () => string; status: StatusStore; keys?: () => Keys; transport?: Transport;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The warehouse publish, overridable so a test can hold it open and see the check answer regardless. */
  publishRows?: typeof publish;
  /** The record filing (the kernel, with the module's token) and the host-key re-pin: absent in a build with no write path. */
  filing?: Filing;
  /** §10's re-pin: read the host's key and write the pin, only when it is the fingerprint the owner was shown. */
  repinKey?: (machine: SshMachine, expected: string) => Promise<{ fingerprint: string }>;
}): Tool[] {
  const log = d.log ?? (() => undefined);
  const publishRows = d.publishRows ?? publish;
  /**
   * A saved entry that failed its own check is not in `readMachines`' list, so a whole-list replacement built from that list would
   * silently delete it. A draft may not drop a saved entry the draft does not itself name and carry: the page shows the entries
   * with their problems instead, and the owner fixes or removes one deliberately.
   */
  function droppedInvalid(saved: string | undefined, list: Record<string, unknown>[]): Problem[] {
    const now = savedList(saved) ?? [];
    const keep = new Set(list.flatMap((e) => (typeof e.name === "string" ? [e.name] : [])));
    const problems = readMachines(saved).problems;
    const broken = new Set(problems.flatMap((p) => { const m = /^servers_machines\[(\d+)\]/.exec(p.field); return m ? [Number(m[1])] : []; }));
    const out: Problem[] = [];
    now.forEach((e, i) => {
      if (!broken.has(i)) return;
      // A nameless entry can never be carried by a draft (an entry needs a name), so the page cannot show or remove it: the owner
      // fixes it in the instance settings. Either way a whole-list draft that omits it would delete it, so the draft is refused.
      if (typeof e.name !== "string" || !e.name) return void out.push({ field: `servers_machines[${i}].name`, message: "an entry is saved with no name; fix it in the instance settings, or the Save would delete it" });
      if (!keep.has(e.name)) out.push({ field: `servers_machines[${i}].name`, message: `${e.name} is saved but has a problem; fix it or remove it here, or the Save would delete it` });
    });
    return out;
  }
  return [
    {
      name: "server_manager_config",
      description:
        "The servers this module maintains (settings.servers_machines), one entry each, the defaults every entry falls back to, and what each field means. Every machine's key is named, never shown: its value lives only in the Sign-ins panel. Called with { edits: { machines: [...] } } it proposes that whole list instead (the page's one Save): nothing is filed here, and only the owner's Save outside the frame applies it.",
      inputSchema: { type: "object", properties: { edits: { type: "object", properties: { machines: { type: "array", items: { type: "object" } } }, additionalProperties: false } }, additionalProperties: false },
      run: async (a, who) => {
        // Reading the machines is the page's and the agent's (§3); proposing a change is the owner's own call, shown by the board
        // and filed on his Save, never an agent's.
        const edits = a.edits as { machines?: unknown } | undefined;
        if (edits && who.kind !== "owner") throw new Error("the servers are the owner's to change: they edit them on the Fleet page, and an agent only reads them");
        const { machines, problems } = readMachines(d.machines());
        const current = {
          machines: machines.map((m) => ({ name: m.name, set: Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== "name" && !(k in DEFAULTS && DEFAULTS[k as keyof typeof DEFAULTS] === v))), effective: m, summary: summaryOf(m) })),
          defaults: DEFAULTS,
          fields: [...MACHINE_FIELDS],
          problems,
        };
        if (!edits || edits.machines === undefined) return current;
        // The page's draft, whole: checked here, then handed to the board as the owner's one settings change. A draft the schema
        // refuses is returned with its problems and no change, so the bar never offers a value the module would reject.
        const list = Array.isArray(edits.machines) ? edits.machines : undefined;
        const bad = list ? [...listProblems(list), ...droppedInvalid(d.machines(), list)] : [{ field: "servers_machines", message: "is a list of servers" }];
        if (bad.length) return { ...current, problems: bad };
        return { changes: [`Servers: ${list!.length} machine${list!.length === 1 ? "" : "s"}`], _aidenhq: { settings_change: [{ kind: "setting", key: "servers_machines", value: list }] } };
      },
    },
    {
      name: "server_manager_check",
      description:
        "Checks one server now, over SSH, and files nothing (§6): its distro, how many packages are upgradable and how many of those are security updates, whether a reboot is needed, disk on / and /boot, and the running services. Read-only: no package is installed and no service is touched. Results land in the page's status and the sanitized status row. Pass { name } for one machine, or nothing for every enabled machine.",
      inputSchema: { type: "object", properties: { name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" } }, additionalProperties: false },
      run: async (a) => {
        const transport = d.transport;
        const keys = d.keys?.() ?? {};
        if (!transport) throw new Error("the SSH transport isn't configured in this build");
        const { machines } = readMachines(d.machines());
        const name = typeof a.name === "string" ? a.name : undefined;
        // Every machine the settings still list, enabled or not, and including an entry that fails its own check: the warehouse
        // keeps only the machines that are still saved, and a bad field is the owner's to fix, not a removal.
        const inventory = inventoryOf(d.machines());
        const list = machines.filter((m) => m.enabled && (!name || m.name === name));
        if (name && !list.length) return { problem: `no enabled machine called ${name}` };
        const results = [];
        const rows = [];
        for (const m of list) {
          const { row, checked } = await checkOne(m, transport, keys, d.status);
          rows.push(publishRow(m, checked, row.updated_at!));
          results.push({
            name: m.name, state: row.state, distro: row.distro, pending: row.pending, security: row.security, reboot_needed: row.reboot_needed,
            disk: row.disk, last_check: row.updated_at,
            ...(checked.ok
              ? { services: checked.readout.services, fingerprint: checked.fingerprint ?? null, first_pinned: !!checked.first_pinned, security_note: checked.readout.security_note, unattended_upgrades: checked.readout.unattended_upgrades, holds: checked.readout.holds }
              : { detail: checked.detail }),
          });
        }
        // Not awaited: the warehouse is never in the execution path, so a slow or unreachable Postgres can't hold the answer.
        void publishRows(rows, inventory, log).catch((e) => log("status publish failed; the run is unaffected", { err: String((e as Error).message ?? e).slice(0, 200) }));
        return { checked: results };
      },
    },
    // The page's three write actions (§9). Each is the owner's own: an agent's call is refused first, whoever it names, because a
    // patch, a reboot and a re-pin are taken from the signed-in session on the page and never an agent's assertion. The service files
    // the record itself, as its own kind, so the same record, tier and executor serve a click, a schedule and the agent's read.
    {
      name: "server_manager_patch",
      description:
        "Installs the server's updates now: `mode` security (only the candidates from a security suite) or full (every upgradable package). The owner's own action from the Servers page. The service reads the host over SSH and files one `server-manager.patch` record with the exact `name=version` list and its hash; at execution the list is re-derived and the run stops if it changed. Nothing is installed by this call itself.",
      inputSchema: { type: "object", properties: { machine: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }, mode: { enum: ["security", "full"] } }, required: ["machine", "mode"], additionalProperties: false },
      run: async (a, who) => {
        ownerOnly(who);
        const filing = d.filing;
        if (!filing) throw new Error("the write path isn't configured in this build");
        const m = readMachines(d.machines()).machines.find((x) => x.name === a.machine);
        if (!m) throw new Error(`no enabled machine called ${String(a.machine)}`);
        if (!m.enabled) throw new Error(`${m.name} is off: turn it on before patching it`);
        const mode = a.mode === "full" ? "full" : a.mode === "security" ? "security" : undefined;
        if (!mode) throw new Error("mode is security or full");
        // The record is filed with what the page named; the executor's plan reads the host and derives the exact list and its hash.
        const r = await filing.file("server-manager.patch", { machine: m.name, mode }, m.name);
        return { filed: { id: r.id, tier: r.tier, state: r.state }, machine: m.name, mode, note: r.tier === 0 ? "It runs now; its outcome lands on the machine's records." : "It waits for its card to be approved." };
      },
    },
    {
      name: "server_manager_reboot",
      description:
        "Reboots one server inside its quiet window. The owner's own action from the Servers page. Files one `server-manager.reboot` record bound to a pending id over the boot ID, the kernel and the package set; a machine set to \"ask me first\" raises it to the owner's own card, and the reboot is done only when its boot ID changes within 900 s.",
      inputSchema: { type: "object", properties: { machine: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" } }, required: ["machine"], additionalProperties: false },
      run: async (a, who) => {
        ownerOnly(who);
        const filing = d.filing;
        if (!filing) throw new Error("the write path isn't configured in this build");
        const m = readMachines(d.machines()).machines.find((x) => x.name === a.machine);
        if (!m) throw new Error(`no enabled machine called ${String(a.machine)}`);
        if (!m.enabled) throw new Error(`${m.name} is off: turn it on before rebooting it`);
        const r = await filing.file("server-manager.reboot", { machine: m.name }, m.name);
        return { filed: { id: r.id, tier: r.tier, state: r.state }, machine: m.name, note: r.tier === 0 ? "It runs now, if the quiet window is open." : "It waits for its card; the owner decides this one." };
      },
    },
    {
      name: "server_manager_host_key_reset",
      description:
        "Re-pins a machine's changed SSH host key: reads the key the host presents right now and writes it as the pin, but only when it is the fingerprint the owner was shown (`fingerprint`, the one §10's wake gave). A different key is refused, so a stale click can never pin a third one. The owner's own action; no agent holds it.",
      inputSchema: { type: "object", properties: { machine: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }, fingerprint: { type: "string", pattern: "^SHA256:[A-Za-z0-9+/]{43}$" } }, required: ["machine", "fingerprint"], additionalProperties: false },
      run: async (a, who) => {
        ownerOnly(who);
        const m = readMachines(d.machines()).machines.find((x) => x.name === a.machine);
        if (!m) throw new Error(`no enabled machine called ${String(a.machine)}`);
        if (!d.repinKey) throw new Error("the re-pin isn't configured in this build");
        const r = await d.repinKey(targetOf(m), String(a.fingerprint));
        d.status.put({ ...(d.status.get(m.name) ?? { name: m.name, distro: null, state: "ok", pending: null, security: null, security_known: null, reboot_needed: null, disk: null, updated_at: null }), state: "ok", updated_at: new Date().toISOString() });
        return { machine: m.name, repinned: r.fingerprint, note: "The next check reads the host over this pin." };
      },
    },
    {
      name: "server_manager_status",
      description:
        "Each server's last readout as the service saw it: distro, how many packages are upgradable and how many of those are security updates, whether a reboot is needed, disk on / and /boot, and when it last checked. Empty until a machine's first check. No key, address or package list.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async (_a, _who) => {
        const { machines } = readMachines(d.machines());
        const rows = d.status.all();
        const byName = new Map(rows.map((r) => [r.name, r]));
        return {
          servers: machines.map((m) => {
            const r = byName.get(m.name);
            return { name: m.name, enabled: m.enabled, distro: r?.distro ?? null, state: r?.state ?? (m.enabled ? "not checked yet" : "off"), pending: r?.pending ?? null, security: r?.security ?? null, security_known: r?.security_known ?? null, reboot_needed: r?.reboot_needed ?? null, disk: r?.disk ?? null, last_check: r?.updated_at ?? null };
          }),
        };
      },
    },
  ];
}
