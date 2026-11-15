// The agent's `aidenhq` commands (bin/aidenhq, and bin/aidenhq-repo): a loopback endpoint in
// the runner. `repo` clones another repository into the job's workspace: agents have no SSH
// agent, so they can't clone private repositories themselves. The others are the runner's actions as
// the agent's tools (docs/design/conversational-engineers.md), and every write among them is checked
// against the user's words. Each job gets its own random token.

/** The commands, and nothing else: verify-security.sh checks this list. */
export const TOOLS = ["repo", "status", "review", "push", "pr", "merge", "close", "create-repo", "apply", "engine", "primer", "pass", "reset", "cleanup", "task", "tasks", "advise"];
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A helper command's handler: resolves with the text to print, or rejects with a message for the agent. */
export type Tool<C> = (ctx: C, args: any) => Promise<string>;
/** A job's context as the helper needs it: the rest is the runner's. */
type JobCtx = { issue?: { identifier?: string } };

/**
 * `clone(ctx, repo)` for `repo`, and `tools[name](ctx, args)` for the others: each resolves with the
 * text to print, or rejects with a message for the agent.
 */
export function startRepoHelper<C extends JobCtx>(clone: (ctx: C, repo: string) => Promise<string>, log: (msg: string, fields?: object) => void = () => {}, tools: Partial<Record<string, Tool<C>>> = {}, port = 0) {
  const jobs = new Map<string, C>(); // token → job context
  let inflight = 0;
  const server = createServer(async (req, res) => {
    inflight++;
    res.on("close", () => inflight--);
    const reply = (code: number, text: string) => res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(text);
    const name = String(req.url ?? "").slice(1);
    if (req.method !== "POST" || !TOOLS.includes(name) || (name !== "repo" && !tools[name])) return reply(404, "not found");
    const ctx = jobs.get(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!ctx) return reply(401, "this task run is over");
    let body;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8").slice(0, 65_536));
    } catch {
      return reply(400, name === "repo" ? "send {\"repo\": \"org/name\"}" : "send a JSON object");
    }
    try {
      reply(200, name === "repo" ? await clone(ctx, String(body?.repo ?? "")) : await tools[name]!(ctx, body ?? {}));
    } catch (err: any) {
      log(`${name} refused`, { issue: ctx.issue?.identifier, err: String(err.message ?? err).slice(0, 300) });
      reply(400, String(err.message ?? err).slice(0, 2000));
    }
  });
  // The same port across restarts (the caller keeps it), so runs a restart left running still reach it.
  server.once("error", (err) => {
    log("helper port taken: runs started before the restart lose their aidenhq commands", { port, err: String(err.message) });
    server.listen(0, "127.0.0.1");
  });
  server.listen(port, "127.0.0.1");
  server.unref();
  const address = () => server.address() as AddressInfo | null;
  const url = () => `http://127.0.0.1:${address()?.port ?? port}`;
  return {
    url,
    listening: new Promise<number>((r) => server.once("listening", () => r(address()!.port))),
    /** Requests in progress: a restart waits for them. */
    busy: () => inflight,
    /** Allow one job to use the helper until `done()` (an adopted run keeps its token); returns the environment for its agent. */
    register(ctx: C, token: string = randomBytes(24).toString("hex")) {
      jobs.set(token, ctx);
      return { token, env: { AIDENHQ_REPO_URL: url(), AIDENHQ_REPO_TOKEN: token }, done: () => jobs.delete(token) };
    },
    close: () => server.close(),
  };
}
