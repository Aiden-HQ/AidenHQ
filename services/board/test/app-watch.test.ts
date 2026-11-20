import { describe, expect, it } from "vitest";
import { appWatchTick, type Alert, type AppStatus } from "../src/app-watch.js";

const kv = () => { const m = new Map<string, string>(); return { meta: (k: string) => m.get(k), setMeta: (k: string, v: string) => void m.set(k, v) }; };

describe("app alerts", () => {
  it("an incident open past 30 minutes is one task for the chief of staff, however many ticks, and recovery sends nothing", async () => {
    const store = kv(), filed: Alert[] = [];
    const t0 = 1_800_000_000_000;
    let apps: AppStatus[] = [{ name: "web", incident: { opened_at: t0, kind: "unhealthy", detail: "health check failing" } }];
    const tick = (now: number) => appWatchTick({ apps: async () => apps, store, file: async (a) => void filed.push(a), now });
    await tick(t0 + 10 * 60_000);
    expect(filed).toEqual([]);
    await tick(t0 + 31 * 60_000);
    await tick(t0 + 100 * 60_000);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ title: "App incident: web (unhealthy)", source: `app-incident:web:${t0}` });
    expect(filed[0]!.description).toContain("health check failing");
    apps = [{ name: "web", stats: { mem_bytes: 95, mem_limit_bytes: 100 } }];
    await tick(t0 + 110 * 60_000);
    await tick(t0 + 111 * 60_000);
    expect(filed.slice(1).map((a) => a.title)).toEqual(["App resources: web is using 95% of its memory limit"]);
  });
});
