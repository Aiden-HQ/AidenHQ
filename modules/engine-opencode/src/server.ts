// opencode's own server (`opencode serve`) and the few routes the engine drives (1.19.6): basic auth, one process.
import { spawn, type ChildProcess } from "node:child_process";

export interface Server {
  url: string;
  child: ChildProcess;
  call(method: string, path: string, body?: unknown): Promise<any>;
  /** The server's event stream, reconnecting until stop(); resolves once it is connected (so no event of a later prompt is missed). */
  events(onEvent: (ev: any) => void): Promise<void>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function serve(o: { bin?: string; port: number; password: string; env: NodeJS.ProcessEnv; cwd?: string; hostname?: string }): Promise<Server> {
  const url = `http://127.0.0.1:${o.port}`;
  const auth = `Basic ${Buffer.from(`opencode:${o.password}`).toString("base64")}`;
  const child = spawn(o.bin ?? "opencode", ["serve", "--hostname", o.hostname ?? "0.0.0.0", "--port", String(o.port)], { env: { ...o.env, OPENCODE_SERVER_PASSWORD: o.password }, cwd: o.cwd, stdio: ["ignore", "inherit", "inherit"] });
  let dead = false;
  child.on("exit", () => (dead = true));
  child.on("error", () => (dead = true));
  let stopped = false;
  // Every call has a deadline: a request opencode accepts while it is still starting can go unanswered for good (seen live
  // on 1.19.6: the first /session/status never returned and the engine waited forever).
  const call = async (method: string, path: string, body?: unknown, timeoutMs = 60_000) => {
    const r = await fetch(url + path, { method, signal: AbortSignal.timeout(timeoutMs), headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`opencode ${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  // Ready once /session/status answers; each try gets 10 s (the first one also builds opencode's instance), all of them 2 minutes.
  const until = Date.now() + 120_000;
  for (;;) {
    if (dead) throw new Error("opencode serve exited before it answered");
    try { await call("GET", "/session/status", undefined, 10_000); break; } catch { if (Date.now() > until) throw new Error("opencode serve never answered"); await sleep(200); }
  }
  const events: Server["events"] = (onEvent) => {
    let connected!: () => void;
    let failed!: (e: Error) => void;
    const ready = new Promise<void>((r, j) => { connected = r; failed = j; });
    void (async () => {
      while (!stopped) {
        if (dead) { failed(new Error("opencode serve exited before its event stream connected")); return; }
        try {
          const r = await fetch(url + "/event", { headers: { authorization: auth } });
          if (!r.ok || !r.body) throw new Error(`/event answered ${r.status}`);
          connected();
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of r.body as any) {
            buf += dec.decode(chunk, { stream: true });
            for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
              if (data) try { onEvent(JSON.parse(data)); } catch {}
            }
          }
        } catch {}
        if (!stopped) await sleep(1000);
      }
    })();
    return ready;
  };
  return {
    url, child, call, events,
    async stop() {
      stopped = true;
      if (dead) return;
      child.kill("SIGTERM");
      await new Promise((r) => { child.on("exit", r); setTimeout(() => { child.kill("SIGKILL"); r(0); }, 5000); });
    },
  };
}
