// The Servers page's read tools, on the module's MCP connection `server-manager` (spec §9). Slice 1 is the config read path: the
// machines as the instance holds them, with their defaults resolved, and each machine's last readout as the status store keeps it.
// The SSH reads (`server_manager_check`) and the writes come in later slices; this file answers from settings and the status store
// only, so it never opens a connection and never holds a key.
import type { Tool } from "./mcp.ts";
import { readMachines, withDefaults, MACHINE_FIELDS, DEFAULTS, listProblems, type Machine } from "./config.ts";
import type { StatusStore } from "./status-store.ts";

type Dict = Record<string, unknown>;

/** What a machine's summary line is built from, for the page and the agent: its own settings, one plain sentence each. */
export function summaryOf(m: Machine): string {
  const every = m.security_minutes >= 60 && m.security_minutes % 60 === 0 ? `${m.security_minutes / 60}h` : `${m.security_minutes}m`;
  const reboot = m.reboot_policy === "auto" ? "reboots in its quiet window" : "asks before rebooting";
  const on = m.enabled ? `checks every ${every}` : "is off";
  return `${on}; weekly pass ${m.weekly_day} ${m.weekly_time}; ${reboot} (${m.quiet_start}–${m.quiet_end}); key "${m.key}".`;
}

export function configTools(d: { machines: () => string; status: StatusStore }): Tool[] {
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
        const bad = list ? listProblems(list) : [{ field: "servers_machines", message: "is a list of servers" }];
        if (bad.length) return { ...current, problems: bad };
        return { changes: [`Servers: ${list!.length} machine${list!.length === 1 ? "" : "s"}`], _aidenhq: { settings_change: [{ kind: "setting", key: "servers_machines", value: list }] } };
      },
    },
    // server_manager_check and the three writes arrive with the SSH transport (slices 2 and 3). They are registered now so every
    // name the page lists resolves to a tool; until then each says plainly that the transport isn't here yet.
    ...(["server_manager_check", "server_manager_patch", "server_manager_reboot", "server_manager_host_key_reset"] as const).map(
      (name): Tool => ({ name, description: "Not available in this build yet: it needs the SSH transport, which lands in the next change.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new Error(`${name} isn't available in this build yet: the SSH transport it needs is in the next change`); } }),
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
