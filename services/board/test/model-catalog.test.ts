// The model picker's list rules (src/model-catalog.ts): older versions collapse, engines filter, search finds the old one.
import { describe, expect, it } from "vitest";
import { bare, costText, estimate, family, listing, prefixOf, type CatalogModel } from "../src/model-catalog.js";

const m = (id: string, created: number, o: Partial<CatalogModel> = {}): CatalogModel => ({ id, name: id, provider: id.replace(/^~/, "").split("/")[0]!, created, context: 200000, in: 1, out: 2, tools: true, reasoning: false, ...o });
const catalog = [
  m("openai/gpt-6.2-sol", 300), m("openai/gpt-6.1-sol", 200), m("openai/gpt-6.1-sol-20260101", 100), m("~openai/gpt-sol-latest", 300),
  m("anthropic/claude-sonnet-5.5", 300), m("anthropic/claude-sonnet-5", 100), m("meta-llama/llama-3.3-70b-instruct", 50), m("meta-llama/llama-3.3-8b-instruct", 50), m("x/no-tools", 10, { tools: false }),
];
const ids = (l: ReturnType<typeof listing>) => l.sections.map((s) => `${s.title}: ${s.rows.map((r) => r.id).join(", ")}`);
const base = { catalog, recommended: ["openai/gpt-6.2-sol", "gone/model"], query: "", showOlder: false };

describe("model picker list", () => {
  it("families ignore versions and dates but keep sizes", () => {
    expect(family("openai/gpt-6.1-sol-20260101")).toBe(family("openai/gpt-6.2-sol"));
    expect(family("meta-llama/llama-3.3-70b-instruct")).not.toBe(family("meta-llama/llama-3.3-8b-instruct"));
  });

  it("pins recommended and aliases, shows each model once, newest per family, older behind the toggle", () => {
    const l = listing({ ...base, accepts: { tools: true } });
    expect(ids(l)).toEqual([
      "Recommended: openai/gpt-6.2-sol",
      "Latest aliases: ~openai/gpt-sol-latest",
      "anthropic: anthropic/claude-sonnet-5.5",
      "meta-llama: meta-llama/llama-3.3-70b-instruct, meta-llama/llama-3.3-8b-instruct",
    ]);
    expect(l.older).toBe(3);
    expect(listing({ ...base, accepts: { tools: true }, showOlder: true }).sections.find((s) => s.title === "openai")?.rows.map((r) => r.id)).toEqual(["openai/gpt-6.1-sol", "openai/gpt-6.1-sol-20260101"]);
  });

  it("an engine's filter: one provider, or tool support", () => {
    expect(ids(listing({ ...base, recommended: [], accepts: { provider: "anthropic" } }))).toEqual(["anthropic: anthropic/claude-sonnet-5.5"]);
    expect(JSON.stringify(listing({ ...base, accepts: { tools: true } }))).not.toContain("no-tools");
  });

  it("a search matches id or name over every version, and with no catalog only the recommended are offered", () => {
    expect(ids(listing({ ...base, query: "gpt 6.1" })).join()).toContain("openai/gpt-6.1-sol");
    expect(ids(listing({ ...base, catalog: [] }))).toEqual(["Recommended: openai/gpt-6.2-sol, gone/model"]);
  });

  it("a saved id the catalog doesn't offer stays first", () => {
    expect(ids(listing({ ...base, current: "gone/old" }))[0]).toBe("Not offered: gone/old");
  });

  it("an option's cost comes from its past runs: same model as is, another scaled by price, none: no number", () => {
    const cat = [m("x/cheap", 1, { in: 1, out: 1 }), m("x/dear", 1, { in: 4, out: 4 }), m("x/unpriced", 1, { in: 0, out: 0 })];
    const past = [{ model: "x/cheap", effort: "medium", n: 3, usd: 0.3 }, { model: "x/cheap", effort: "high", n: 1, usd: 0.9 }];
    expect(estimate(past, "x/cheap", "medium", cat)).toBeCloseTo(0.3);
    expect(estimate(past, "x/dear", "medium", cat)).toBeCloseTo(1.2);
    // no run at this effort: the others count, as they are
    expect(estimate(past, "x/cheap", "low", cat)).toBeCloseTo(0.45);
    expect(estimate(past, "x/unpriced", "medium", cat)).toBeNull();
    expect(estimate(undefined, "x/cheap", "medium", cat)).toBeNull();
    expect(costText(0.004)).toBe("<$0.01");
    expect(costText(42.4)).toBe("$42");
  });

  it("a stored model's prefix is taken off for the catalog and put back on a pick", () => {
    expect(prefixOf("openrouter/z-ai/glm-5.3")).toBe("openrouter/");
    expect(prefixOf("z-ai/glm-5.3")).toBe("");
    expect(bare("openrouter/z-ai/glm-5.3", "openrouter/")).toBe("z-ai/glm-5.3");
  });
});
