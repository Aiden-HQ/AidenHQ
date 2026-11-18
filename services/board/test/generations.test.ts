import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fleetGenerationStatus, type FleetGenerations } from "../src/generations.js";

const ok = (v: FleetGenerations | { error: string }): FleetGenerations => {
  if ("error" in v) throw new Error(v.error);
  return v;
};

const file = (lines: unknown[]) => {
  const f = join(mkdtempSync(join(tmpdir(), "generations-")), "generations.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
};

describe("fleet_generation_status", () => {
  it("returns the current pin and the last 20 generations, newest first, with every field", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      n: i + 1,
      at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      product: `sha-${i + 1}`,
      health: i === 24 ? "failed" : "good",
      reason: i === 24 ? "health check failed" : undefined,
      log: `/state/apply-${i + 1}.log`,
      revert_of: i === 24 ? 24 : undefined,
      lkg: i === 24 ? 23 : undefined,
      data_versions: { meetings: 3 },
    }));
    const out = ok(fleetGenerationStatus(file(rows)));
    expect(out.pin).toBe("sha-25");
    expect(out.generations).toHaveLength(20);
    expect(out.generations.map((g) => g.n)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(out.generations[0]).toEqual({ n: 25, at: "2026-01-25T00:00:00Z", product: "sha-25", health: "failed", reason: "health check failed", log: "/state/apply-25.log", revert_of: 24, lkg: 23, data_versions: { meetings: 3 } });
    expect(Object.keys(out.generations[1]!).sort()).toEqual(["at", "data_versions", "health", "lkg", "log", "n", "product", "reason", "revert_of"]);
  });

  it("the pin is the newest generation that switched: a refused apply switched nothing", () => {
    const out = fleetGenerationStatus(file([
      { n: 1, at: "2026-01-01T00:00:00Z", product: "sha-1", health: "good" },
      { n: 2, at: "2026-01-02T00:00:00Z", product: "sha-2", health: "refused", reason: "compose refused the staged files" },
    ]));
    if ("error" in out) throw new Error(out.error);
    expect(out.pin).toBe("sha-1");
    expect(out.generations.map((g) => [g.n, g.health])).toEqual([[2, "refused"], [1, "good"]]);
  });

  it("an empty history is no history yet, not an error", () => {
    expect(fleetGenerationStatus(file([]))).toEqual({ pin: null, generations: [], release: null });
  });

  it("carries the release updater's display copy beside it: what is available and what changed", () => {
    const f = file([]);
    const u = { current: { name: "2026.11.2", product: "k1" }, auto: true, timezone: "Asia/Dubai", checkedAt: null, available: { name: "2026.11.3", notes: ["Updates"], compare: "https://github.com/x" }, error: null, last: null };
    writeFileSync(join(f, "..", "updates.json"), JSON.stringify(u));
    expect(ok(fleetGenerationStatus(f)).release).toEqual(u);
  });

  it("a missing file is an explicit error, never an empty list", () => {
    const out = fleetGenerationStatus(join(mkdtempSync(join(tmpdir(), "generations-")), "generations.jsonl"));
    expect(out).not.toHaveProperty("generations");
    expect(out).toHaveProperty("error", expect.stringMatching(/cannot read .*generations\.jsonl/));
  });

  it("an unreadable line is an explicit error, never a partial list", () => {
    const f = join(mkdtempSync(join(tmpdir(), "generations-")), "generations.jsonl");
    writeFileSync(f, '{"n":1,"product":"sha-1"}\nnot json\n');
    const out = fleetGenerationStatus(f);
    expect(out).not.toHaveProperty("generations");
    expect(out).toHaveProperty("error", expect.stringMatching(/not JSON lines/));
  });
});
