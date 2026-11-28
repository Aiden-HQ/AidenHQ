// The server-manager service: one container (`server-manager-ssh`), on :8103, holding a server's private key only at connect time
// and the only thing in the fleet that speaks to a server (spec §2, §4). It serves the MCP connection `server-manager` with the
// config read path (`server_manager_config`, `server_manager_status`), the SSH check (`server_manager_check`), the page's three
// write actions, its Servers page view and the `validate` hook; the two write kinds' executor@1 route; and the schedule that files a
// run per due slot (§12) and nothing at all for a fresh install.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { serveExecutor } from "./aidenhq-sdk/executor.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
import { StatusStore } from "./status-store.ts";
import { checkOne, configTools, inventoryOf } from "./tools.ts";
import { validate, type ValidateInput } from "./validate.ts";
import { readKeys, repin, type Transport } from "./ssh.ts";
import { ensureSchema, publish, publishRow } from "./status.ts";
import { readMachines } from "./config.ts";
import { createExecutor } from "./executor.ts";
import { KernelWrites } from "./kernel-writes.ts";
import { dueFor, SlotStore } from "./schedule.ts";
import { ConsentStore, inWindow, rebootDue } from "./reboot.ts";

const env = process.env;
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const serviceKey = () => file(env.SERVERS_SERVICE_KEY_FILE);
const moduleToken = () => file(env.SERVERS_TOKEN_FILE);
// Settings.servers_machines as the instance holds it (a JSON list). It is the container's environment, fixed at start: a saved
// change applies because the kernel applies the settings change by recreating this service with the new value, never mid-process.
const machines = () => env.SERVERS_MACHINES ?? "[]";
const stateDir = env.SERVERS_STATE_DIR ?? "/data";
// The instance's timezone (§12): a due time is the owner's wall clock, never the container's.
const timeZone = () => env.OWNER_TIMEZONE || "UTC";
const status = new StatusStore(stateDir);
// The key map (servers_keys) and the transport's paths: read fresh on every check, never cached and never logged.
const keys = () => readKeys(env.SERVERS_KEYS_FILE);
const transport: Transport = { config: { stateDir, tmpDir: env.SERVERS_TMP_DIR } };

const kernelWrites = new KernelWrites({ url: kernelUrl, token: moduleToken, log });
let agentId: string | undefined;
/**
 * The module agent's id, read from the kernel once. A failed lookup is not cached: a transient kernel error at boot would otherwise
 * leave every wake and every holder task broken for the process's life, and the next call must try again.
 */
const holderAgent = async (): Promise<string> => {
  if (agentId) return agentId;
  agentId = await kernelWrites.agentId();
  return agentId;
};
const wake = async (i: { machine: string; title: string; body: string; source: string }) => {
  try {
    await kernelWrites.wake({ ...i, agent: await holderAgent() });
  } catch (e) {
    log("wake skipped: no agent id", { err: String((e as Error).message ?? e).slice(0, 200) });
  }
};
const executor = createExecutor({
  machines, keys, transport: () => transport, timeZone, stateDir, log, wake,
  // A patch's own reboot record is filed the same way a click's is: the same kind, the same kernel, the same executor.
  file: async (kind, args, task) => kernelWrites.file(kind, args, task),
  taskFor: async (machine) => kernelWrites.holder(machine, await holderAgent()),
});

const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const pages = configTools({
  machines, status, keys, transport, log,
  filing: {
    // A page's click files the same record a schedule does, as the module (the kernel admits a module filing its own kind). The
    // record names the machine's quiet holder task, so a card the owner decides and the run's outcome land there: never a task the
    // owner is asked to act on.
    file: async (kind, args, machine) => {
      const task = await kernelWrites.holder(machine, await holderAgent()).catch(() => "");
      return kernelWrites.file(kind, args, task || undefined);
    },
  },
  repinKey: (machine, expected) => repin(transport, machine, expected),
});
const mcp = serveMcp(
  createMcp("server-manager", pages, [{ uri: "ui://server-manager/page", html: pageHtml(new URL("./", import.meta.url)) }]),
  serviceKey,
  async (req) => ({ ...(await verifyCaller(req, jwks, "server-manager")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }),
);

/** POST /validate: the kernel posts a settings change or a key's set/clear here with the service key. */
async function serveValidate(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean> {
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/validate") return false;
  const want = Buffer.from(serviceKey()), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return void res.writeHead(401).end(), true;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 256 * 1024) return void res.writeHead(413).end(), true; chunks.push(c as Buffer); }
  let body: ValidateInput;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void res.writeHead(400).end(), true; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(validate(body && typeof body === "object" ? body : {}, machines())));
  return true;
}

// executor@1: the two write kinds' plan/execute, with one handler across requests (its once-per-id map must live).
const executorHandler = serveExecutor(executor, { key: serviceKey(), kernelUrl, log });

createServer(async (req, res) => {
  try {
    if (await executorHandler(req, res)) return;
    if (await mcp(req, res)) return;
    if (await serveValidate(req, res)) return;
    res.writeHead(req.url === "/healthz" ? 200 : 404).end();
  } catch (e) {
    log("request failed", { err: String((e as Error).message).slice(0, 200) });
    if (!res.headersSent && res.writable) res.writeHead(400).end();
  }
}).listen(8103, "0.0.0.0", () => {
  log("server-manager listening", { port: 8103, machines: (() => { try { return JSON.parse(machines()).length; } catch { return 0; } })() });
  // The advertised src_servers views exist from the first boot, before any machine is checked (spec §8).
  void ensureSchema(log);
  startSchedule();
});

/**
 * The schedule (§12): every minute, what each machine is due for now. A fresh install lists no machine and does nothing; a machine
 * the owner adds and enables gets its first slot one interval after it is enabled. A slot is recorded durably before its run and
 * marked done after, so a restart cannot start it twice. Each slot checks the machine (a read, no record) and files a patch
 * (security or full) as the module only when the check found something to install, which brings its own executor, tier and
 * audit trail. A patch that needs a reboot files the reboot record itself after it (a Tier 2 card on an
 * "ask me first" machine). No agent run is started for scheduled work (§12).
 */
function startSchedule() {
  const slots = new SlotStore(stateDir);
  const consent = new ConsentStore(stateDir);
  // §12: a slot a dead process started and never finished is released before the first tick, so it is due again and its record's
  // plan re-derives the set from the host — never replayed blind. Left alone, `dueFor` would treat it as done and a weekly full pass
  // would not come round again for a week.
  for (const r of slots.reconcile()) log("a slot was interrupted; it is due again and its plan re-derives the set", { machine: r.machine, slot: r.slot });
  let busy = false;
  const tick = async () => {
    if (busy || !moduleToken()) return;
    busy = true;
    try {
      const list = readMachines(machines()).machines;
      for (const m of list) {
        if (!m.enabled) continue;
        // §9's quiet start: the first tick that sees a machine records it, so a weekly pass from before it was listed is never read
        // as missed. Written durably, once, before this tick asks what is due.
        slots.markSeen(m.name);
        const due = dueFor(m, new Date(), timeZone(), slots);
        if (!due) continue;
        if (!slots.start(due)) continue;
        // A slot is a check first (a read: no record, §6). Only a check that found something this module may install files a
        // patch record, and a scheduled security patch installs only inside the machine's quiet window; the weekly pass runs at the
        // time the owner set for it. The check also keeps the page's status and the warehouse row current between clicks.
        const prior = status.get(m.name)?.state;
        const { row, checked } = await checkOne(m, transport, keys(), status, { refresh: true });
        void publish([publishRow(m, checked, row.updated_at!)], inventoryOf(machines()), log);
        if (!checked.ok) {
          // A weekly pass is retried next tick (a host back a minute later still gets it); an hourly slot just waits for the next.
          if (due.kind === "full") slots.release(due); else slots.finish(due, false, `check failed: ${checked.state}`);
          // Told once per new failure state, not every interval while a host stays down.
          if (prior !== checked.state) await wake({ machine: m.name, title: `Server Manager: ${m.name} could not be checked`, body: `${m.name}: the scheduled check failed (${checked.state}): ${checked.detail.slice(0, 300)}`, source: `server-manager:check-failed:${m.name}:${checked.state}` });
          continue;
        }
        const r = checked.readout;
        const count = due.kind === "full" ? r.upgradable.length : r.security.length;
        const why = !count ? "nothing to install"
          : r.unattended_upgrades ? "unattended-upgrades patches this host"
          : due.kind === "security" && !inWindow(m.quiet_start, m.quiet_end, new Date(), timeZone()) ? `${count} security update(s) wait for the quiet window`
          : "";
        if (why) { slots.finish(due, true, `checked: ${why}`); continue; }
        try {
          const task = await kernelWrites.holder(m.name, await holderAgent()).catch(() => "");
          const r = await kernelWrites.file("server-manager.patch", { machine: m.name, mode: due.kind }, task || undefined);
          slots.finish(due, true, `filed ${r.id} (tier ${r.tier})`);
        } catch (e) {
          // A filing that failed is not a run that happened: release the slot so the next tick tries again, rather than marking the
          // hour done and missing it until tomorrow. `prune` only drops done slots, so a released one is retried and then cleaned up.
          slots.release(due);
          log("a due run did not file", { machine: m.name, kind: due.kind, slot: due.slot });
          await wake({ machine: m.name, title: `Server Manager: a scheduled run did not file on ${m.name}`, body: `${m.name}: the ${due.kind} run due ${due.slot} could not be filed (${String((e as Error).message ?? e).slice(0, 300)}).`, source: `server-manager:schedule-failed:${m.name}:${due.slot}` });
        }
      }
      // §6: a reboot deferred to the quiet window's start gets its own record. Only a reboot the kernel already *decided* is filed
      // again — never one a plan merely proposed, and never one past its 12 hours: the sweep below drops those, and `rebootDue`
      // refuses to revive one it finds expired after the service was offline. Filed once per window (`markFiled`), not every minute.
      for (const m of list) {
        if (!m.enabled) continue;
        const c = consent.get(m.name);
        // Only a reboot the kernel actually decided is resumed here: a plan that merely proposed one leaves no decision, so a card
        // the owner never answered cannot be picked up by the scheduler. `rebootDue` handles the window, the once-per-window mark
        // and the 12 hours measured from that decision.
        if (!c || !c.decided_at) continue;
        const pending = rebootDue(m, c, new Date(), timeZone());
        if (!pending) continue;
        try {
          const task = await kernelWrites.holder(m.name, await holderAgent()).catch(() => "");
          await kernelWrites.file("server-manager.reboot", { machine: m.name }, task || undefined);
          consent.markFiled(m.name, pending);
        } catch (e) {
          log("a deferred reboot did not file", { machine: m.name, err: String((e as Error).message ?? e).slice(0, 200) });
        }
      }
      // Consent older than 12 h is dropped and the agent told, never held (§6).
      for (const m of list) {
        const c = consent.get(m.name);
        if (c && Date.now() - Date.parse(c.granted_at) > 12 * 3600_000) {
          consent.drop(m.name);
          await wake({ machine: m.name, title: `Server Manager: a reboot consent expired on ${m.name}`, body: `${m.name}: the reboot consent granted ${c.granted_at} is older than 12 hours and was dropped, not held open.`, source: `server-manager:consent-expired:${m.name}:${c.pending.slice(0, 12)}` });
        }
      }
      slots.prune(new Date(Date.now() - 30 * 86_400_000));
    } catch (e) {
      log("the schedule's tick failed", { err: String((e as Error).message ?? e).slice(0, 300) });
    } finally { busy = false; }
  };
  setInterval(() => void tick(), 60_000);
}
