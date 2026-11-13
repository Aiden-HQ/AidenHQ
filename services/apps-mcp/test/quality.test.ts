import { describe, expect, it } from "vitest";
import { MAX_CHECKS, parseChecks, withoutSamples } from "../src/quality.js";

describe("quality checks from /api/health", () => {
  it("reads bounded checks; no checks is none; anything that didn't evaluate is unknown", () => {
    expect(parseChecks("null")).toEqual({ state: "none" });
    const r = parseChecks(JSON.stringify([{ name: "eta_has_source", ok: false, count: 3, sample: { id: 7, note: "x".repeat(500) } }, { name: "fresh", ok: true }]));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.checks[0]).toMatchObject({ name: "eta_has_source", ok: false, count: 3 });
    expect(r.checks[0]!.sample!.length).toBe(200);
    expect(r.checks[1]).toEqual({ name: "fresh", ok: true, count: null, sample: null });
    expect(parseChecks(JSON.stringify([{ name: "x", ok: null }])).state).toBe("unknown");
    expect(parseChecks(JSON.stringify([{ name: "a:b", ok: true }])).state).toBe("unknown");
    expect(parseChecks(JSON.stringify(Array.from({ length: MAX_CHECKS + 1 }, (_, n) => ({ name: `c${n}`, ok: true })))).state).toBe("unknown");
    expect(parseChecks("not json").state).toBe("unknown");
    // The internal route (the board, then fleet_status) never carries a sample: app data stays behind app_status.
    expect(JSON.stringify(withoutSamples(r))).not.toContain("xxx");
  });
});
