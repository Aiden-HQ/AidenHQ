// `ui-review browser start`: the guarded, signed-in Chrome the clicking pass's agent attaches to (`agent-browser --cdp <port>`).
// It is the engine's own Chrome (launch: the live-app guard covers every target of it, a tab the agent opens included). A
// session's cookies and local storage are put into the browser's default context, the one an attaching client works in, so the
// agent's tabs are signed in without the agent ever holding the login. It runs until it is killed.
import { mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { launch } from "./browser.ts";

type State = { cookies?: Parameters<import("playwright-core").BrowserContext["addCookies"]>[0]; origins?: { origin: string; localStorage: { name: string; value: string }[] }[] };

export async function browserCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { url: { type: "string" }, session: { type: "string" }, mode: { type: "string" }, out: { type: "string" } } });
  if (positionals[0] !== "start" || !v.url) { console.error("usage: ui-review browser start --url <app url> [--session state.json] [--mode read|test-write|any] [--out <dir>]"); return 2; }
  if (v.mode && !["read", "test-write", "any"].includes(v.mode)) { console.error("ui-review browser: --mode is read, test-write or any"); return 2; }
  const out = v.out ?? ".";
  mkdirSync(out, { recursive: true });
  const l = await launch({ out, target: v.url, mode: v.mode } as Parameters<typeof launch>[0]);
  if (v.session) {
    const state = JSON.parse(readFileSync(v.session, "utf8")) as State;
    const client = await chromium.connectOverCDP(l.cdp);
    const ctx = client.contexts()[0]; // the default context: what an attaching agent-browser works in
    if (state.cookies?.length) await ctx.addCookies(state.cookies);
    for (const o of state.origins ?? []) {
      const page = await ctx.newPage();
      await page.goto(o.origin, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.evaluate((items) => { for (const i of items) localStorage.setItem(i.name, i.value); }, o.localStorage).catch(() => {});
      await page.close();
    }
  }
  console.log(`cdp port ${l.port} (agent-browser --cdp ${l.port}); the browser stays up until this process is killed`);
  await new Promise<void>((ok) => { for (const s of ["SIGTERM", "SIGINT"] as const) process.once(s, ok); });
  await l.close();
  return 0;
}
