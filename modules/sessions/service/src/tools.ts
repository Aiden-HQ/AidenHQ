// The sessions connection's tools: watch_arm, watch_list, watch_cancel, for the role `session`. The job and task are the
// kernel's caller assertion's (mcp.ts passes the verified caller), never an argument: a session arms, lists and cancels its own
// task's watches only.
import { randomBytes } from "node:crypto";
import { KernelError } from "./aidenhq-sdk/kernel-client.ts";
import type { Tool } from "./mcp.ts";
import { reconcile, type Kernel } from "./reconcile.ts";
import type { Watch, Watches } from "./watches.ts";

/** The connection and kinds a watch can wait for: what the module subscribes to (module.yaml `subscribes`). */
const SUPPORTED: Record<string, string[]> = { github: ["pull_request.closed"] };
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const view = (w: Watch) => ({ id: w.id, connection: w.connection, kind: w.kind, resource: w.resource, match: w.match, note: w.note, state: w.state, ...(w.fired_by ? { fired_by: w.fired_by } : {}) });

export function watchTools({ watches, kernel }: { watches: Watches; kernel: Kernel }): Tool[] {
  const own = (caller: { task?: string }) => caller.task ?? (() => { throw new Error("a watch belongs to a session's task: call this from the session"); })();
  return [
    {
      name: "watch_arm", roles: ["session"],
      description: "Wake this session when a pull request closes: the first slice of event watches. It answers `armed`, or `fired` when the PR has already closed (act at once). The note is the text you are woken with. A repo the code host does not manage is refused.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["connection", "kind", "resource", "match", "note"],
        properties: {
          connection: { type: "string", enum: Object.keys(SUPPORTED) },
          kind: { type: "string", enum: SUPPORTED.github, description: "The event: pull_request.closed (a merge or a close)." },
          resource: { type: "string", description: "owner/repo" },
          match: { type: "object", additionalProperties: false, required: ["number"], properties: { number: { type: "integer", minimum: 1 }, merged: { type: "boolean", description: "true: only a merge; false: only a close without merging; absent: either." } } },
          note: { type: "string", maxLength: 1000, description: "What to do when it happens: the line you are woken with." },
        },
      },
      async run(a, caller) {
        const task = own(caller);
        const connection = String(a.connection), kind = String(a.kind), resource = String(a.resource ?? "").toLowerCase(), note = String(a.note ?? "").trim();
        const m = (a.match ?? {}) as { number?: unknown; merged?: unknown };
        if (!SUPPORTED[connection]?.includes(kind)) throw new Error(`watch ${connection} ${kind} isn't supported yet (${Object.entries(SUPPORTED).map(([c, k]) => `${c}: ${k.join(", ")}`).join("; ")})`);
        if (!REPO.test(resource)) throw new Error("resource is owner/repo");
        if (!Number.isInteger(m.number) || (m.number as number) < 1) throw new Error("match.number is the pull request's number");
        if (m.merged !== undefined && typeof m.merged !== "boolean") throw new Error("match.merged is true or false");
        if (!note || note.length > 1000) throw new Error("note is the line you are woken with (1 to 1000 characters)");
        const w = watches.arm({ id: randomBytes(6).toString("hex"), task, agent: caller.agent, connection, kind, resource, match: { number: m.number as number, ...(m.merged !== undefined ? { merged: m.merged } : {}) }, note });
        // Checked now: a repo the code host doesn't read is refused here, and a PR that already closed fires at once. A watch that
        // can't be checked is not armed (an event it missed could never reach it).
        try {
          return { id: w.id, state: await reconcile(kernel, watches, w) };
        } catch (e) {
          // A watch already fired keeps its row: its stored notice is filed again on the next pass.
          if (watches.get(w.id)?.state === "fired") return { id: w.id, state: "fired" };
          watches.remove(w.id);
          if (e instanceof KernelError && e.status === 403) throw new Error(`${resource} isn't watched: add it to maintainer_repos`);
          throw e;
        }
      },
    },
    {
      name: "watch_list", roles: ["session"],
      description: "This session's watches: each one's id, what it waits for, its note and its state (armed, fired, cancelled).",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      run: async (_a, caller) => ({ watches: watches.list(own(caller)).map(view) }),
    },
    {
      name: "watch_cancel", roles: ["session"],
      description: "Cancels one of this session's armed watches by id.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
      async run(a, caller) {
        const w = watches.get(String(a.id ?? ""));
        if (!w || w.task !== own(caller)) throw new Error("no such watch on this task");
        watches.cancel(w.id);
        return { id: w.id, state: watches.get(w.id)!.state };
      },
    },
  ];
}
