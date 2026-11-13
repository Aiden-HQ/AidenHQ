import { describe, expect, it } from "vitest";
import { boundedFleetStatus } from "../src/fleet.js";
import { detectorState, stalePrs, staleSources, tick, type Incident } from "../src/fleet-ops.js";
import { Store } from "../src/store.js";

describe("Fleet Ops detector", () => {
  it("fleet_status keeps detector.open and detector.recovered whole behind a long failed[] history and long lists", () => {
    const store = new Store(":memory:");
    // State an older detector left behind: a long `failed` card-text history, then the open and recovered keys it wrote.
    store.setMeta("fleet_ops_detector", JSON.stringify({
      failed: Array.from({ length: 400 }, (_, k) => ({ key: `card:${k}`, reason: "x".repeat(200), at: "2026-11-13T10:00:00Z" })),
      open: { "routine:daily-brief": { reason: "routine daily brief: its last 3 runs failed", at: "2026-11-13T10:00:00Z", fired: true } },
      recovered: [{ key: "source:slack", reason: "source src_slack: last good pass 20 min ago", at: "2026-11-13T11:00:00Z", fired: true }],
    }));
    const long = (n: number) => Array.from({ length: n }, (_, k) => ({ identifier: `WOR-${k}`, title: "t".repeat(200), status: "blocked", assignee: "Ann", updatedAt: "2026-11-01T00:00:00Z" }));
    const reply = boundedFleetStatus({
      detector: detectorState(store),
      runs: [],
      approvals: [],
      agents: [],
      routines: [],
      stuck: long(500),
      summary: { window: "7d", shipped: { tasks: long(500), landed: [] }, failed: { outcomes: [], runs: 0 }, waiting: { cards: [], blocked: [] }, spend: { yesterdayUsd: 0, avg7dUsd: 0, top: [] } },
    }) as unknown as { detector: ReturnType<typeof detectorState>; stuck: unknown[]; truncated: string[] };
    const text = JSON.stringify(reply);
    expect(text.length).toBeLessThanOrEqual(24_000);
    expect(JSON.parse(text).detector.open["routine:daily-brief"].reason).toBe("routine daily brief: its last 3 runs failed");
    expect(reply.detector.recovered.map((r) => r.key)).toEqual(["source:slack"]);
    expect(reply.truncated.some((t) => /^(stuck|summary\.shipped\.tasks): \d+ of 500$/.test(t))).toBe(true);
    expect(JSON.parse(text)).not.toHaveProperty("failed"); // the old history is not part of a reply
  });

  it("fires once per incident, keeps quiet while it lasts, fires once on recovery, and retries a fire that didn't land", async () => {
    const store = new Store(":memory:");
    let found: Incident[] | undefined = [];
    const fired: { incidents: { key: string }[]; recovered: { key: string }[] }[] = [];
    let up = true;
    const fire = async (b: unknown) => (up && fired.push(b as (typeof fired)[0]) > 0) || false;
    const run = () => tick(store, { source: async () => found }, fire);

    await run();
    expect(fired).toHaveLength(0); // nothing tripped

    found = [{ key: "slack", reason: "src_slack stale" }];
    up = false;
    await run(); // the webhook didn't take it: tried again next tick
    expect(fired).toHaveLength(0);
    up = true;
    await run();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.incidents.map((i) => i.key)).toEqual(["source:slack"]);
    await run();
    await run();
    expect(fired).toHaveLength(1); // still down: no second alert

    found = undefined; // couldn't check (warehouse unreachable): not a recovery
    await run();
    expect(fired).toHaveLength(1);
    expect(detectorState(store).open["source:slack"]).toBeDefined();

    found = [];
    await run();
    expect(fired).toHaveLength(2);
    expect(fired[1]).toMatchObject({ incidents: [], recovered: [{ key: "source:slack" }] });
    await run();
    expect(fired).toHaveLength(2); // the recovery is said once

    found = [{ key: "slack", reason: "src_slack stale again" }];
    await run();
    expect(fired).toHaveLength(3); // a new incident after recovery fires again
  });
});

describe("staleSources", () => {
  const now = Date.parse("2026-11-12T00:00:00Z");
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  it("a daily source is not stale after an hour, only after a day", () => {
    const keys = (rows: { source: string; last_ok: string | null; failing: boolean }[]) => staleSources(rows, now).map((x) => x.key);
    expect(keys([{ source: "security", last_ok: ago(90), failing: false }, { source: "slack", last_ok: ago(90), failing: false }])).toEqual(["slack"]);
    expect(keys([{ source: "security", last_ok: ago(27 * 60), failing: false }])).toEqual(["security"]);
  });
});

describe("stale agents-org PRs", () => {
  it("a PR open over an hour is an item, keyed pr:<repo>#<n>; once merged it recovers", async () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    let rows = [{ repo: "org/app", number: 7, opened_at: ago(90) }, { repo: "org/app", number: 8, opened_at: ago(10) }];
    const store = new Store(":memory:");
    const fired: { incidents: { key: string; reason: string }[]; recovered: { key: string }[] }[] = [];
    const run = () => tick(store, { pr: async () => stalePrs(rows, now) }, async (b) => fired.push(b as (typeof fired)[0]) > 0);
    await run();
    expect(fired[0]!.incidents).toMatchObject([{ key: "pr:org/app#7", reason: "org/app#7 open 90 min without merging" }]);
    rows = []; // merged: no longer open
    await run();
    expect(fired[1]!.recovered.map((r) => r.key)).toEqual(["pr:org/app#7"]);
  });
});
