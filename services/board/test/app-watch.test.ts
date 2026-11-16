import { describe, expect, it } from "vitest";
import { appWatchTick, type AppStatus } from "../src/app-watch.js";

const kv = () => { const m = new Map<string, string>(); return { meta: (k: string) => m.get(k), setMeta: (k: string, v: string) => void m.set(k, v) }; };

describe("app alerts", () => {
  it("an incident open past 30 minutes becomes one owner notice an hour, and its recovery one more", async () => {
    const store = kv(), lines: string[] = [];
    const t0 = 1_800_000_000_000;
    let apps: AppStatus[] = [{ name: "web", incident: { opened_at: t0, kind: "unhealthy", detail: "health check failing" } }];
    const tick = (now: number) => appWatchTick({ apps: async () => apps, store, notify: (l) => void lines.push(l), now });
    await tick(t0 + 10 * 60_000);
    expect(lines).toEqual([]);
    await tick(t0 + 31 * 60_000);
    await tick(t0 + 40 * 60_000);
    expect(lines).toEqual(["⚠️ DevOps Engineer couldn't fix web: health check failing"]);
    apps = [{ name: "web", stats: { mem_bytes: 95, mem_limit_bytes: 100 } }];
    await tick(t0 + 50 * 60_000);
    expect(lines.slice(1)).toEqual(["✅ web recovered", "⚠️ web is using 95% of its memory limit"]);
  });
});
