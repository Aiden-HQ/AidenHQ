// The Servers page's read tools, on the module's MCP connection `server-manager` (spec §9): the machines as the instance holds them
// with their defaults resolved, each machine's last readout as the status store keeps it, and — this slice — the live read pass
// over SSH (`server_manager_check`). The check is a read: it files no record (§6), and it is the only tool here that opens a
// connection. The writes arrive with the executor (slice 3); until then the three write names answer plainly.
import type { Tool } from "./mcp.ts";
import { readMachines, MACHINE_FIELDS, DEFAULTS, listProblems, savedList, type Machine, type Problem } from "./config.ts";
import type { StatusStore } from "./status-store.ts";
import { readKeys, withConnection, type Keys, type SshMachine, type Transport } from "./ssh.ts";
import { publish, publishRow, readHost, rowOf, stateOfError } from "./status.ts";

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

export function configTools(d: {
  machines: () => string; status: StatusStore; keys?: () => Keys; transport?: Transport;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The warehouse publish, overridable so a test can hold it open and see the check answer regardless. */
  publishRows?: typeof publish;
}): Tool[] {
  const log = d.log ?? (() => undefined);
  const publishRows = d.publishRows ?? publish;
  /** One machine's target for the transport: only the fields ssh.ts may see, and never the key's value. */
  const target = (m: Machine): SshMachine => ({ name: m.name, address: m.address, port: m.port, user: m.user, key: m.key, expected_fingerprint: m.expected_fingerprint });
  /**
   * Checks one machine and records what it saw: the transport's read pass, the row (in the page's store) and the sanitized
   * warehouse row. The record is filed only after the read, and a publish failure never fails the check.
   */
  async function checkOne(m: Machine, transport: Transport, keys: Keys) {
    // The failure is a result, not an exception: a host that is unreachable, refuses the key or changed its host key records
    // that state, so a stale healthy row is never left standing and the rest of the fleet is still checked.
    const at = new Date().toISOString();
    let checked: Awaited<ReturnType<typeof readHost>>;
    try {
      checked = await withConnection(transport, target(m), keys, async (c, pin) => readHost(c, pin));
    } catch (e) {
      checked = { ...stateOfError(e), ok: false };
    }
    const row = rowOf(m, checked, at);
    d.status.put(row);
    return { row, checked };
  }

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
        const inventory = [...new Set([...machines.map((m) => m.name), ...(savedList(d.machines()) ?? []).flatMap((e) => (typeof e.name === "string" && e.name ? [e.name] : []))])];
        const list = machines.filter((m) => m.enabled && (!name || m.name === name));
        if (name && !list.length) return { problem: `no enabled machine called ${name}` };
        const results = [];
        const rows = [];
        for (const m of list) {
          const { row, checked } = await checkOne(m, transport, keys);
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
    // The three writes arrive with the executor (slice 3). They are registered now so every name the page lists resolves to a tool
    // that says plainly where it is — and each already carries the caller rule it will keep: these are the owner's own actions,
    // taken from the page's signed-in session, never an agent's assertion (§9). An agent's call is refused before anything else.
    ...(["server_manager_patch", "server_manager_reboot", "server_manager_host_key_reset"] as const).map(
      (name): Tool => ({
        name,
        description: "Not available in this build yet: the write path lands in the next change.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: async (_a, who) => {
          ownerOnly(who);
          throw new Error(`${name} isn't available in this build yet: the write path is in the next change`);
        },
      }),
    ),
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
