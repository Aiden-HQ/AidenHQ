// The Flow page's empty states (web/src/Flow.tsx, flow-charts.tsx): a fresh install's page and every chart without data say so.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { FlowEmpty, dur } from "../../web/src/Flow";
import { BarList, Columns, DotPlot, Lines } from "../../web/src/flow-charts";

describe("the empty page", () => {
  it("says Flow fills in as work happens, on the page and in each chart without data", () => {
    const empty = "Flow fills in as work happens.";
    expect(renderToStaticMarkup(createElement(FlowEmpty))).toContain(empty);
    const none = { xs: [], series: [], value: () => null, fmt: String, label: "x" };
    for (const el of [createElement(Columns, none), createElement(Lines, none), createElement(DotPlot, { dots: [], label: "x", fmtY: String }), createElement(BarList, { rows: [], fmt: String, label: "x" })])
      expect(renderToStaticMarkup(el)).toContain(empty);
    expect(dur(5400)).toBe("1h 30m");
  });
});

describe("the timeline table", () => {
  it("has a column per journey phase, a dash where a PR skipped one, and rounds on looping phases", async () => {
    const { ItemTable } = await import("../../web/src/Flow");
    const { PHASES, fixtureItems } = await import("../fixtures/flow-insights");
    const items = fixtureItems();
    const html = renderToStaticMarkup(createElement(ItemTable, { items, phases: PHASES, color: () => "red", onTask: () => {}, label: "PRs", truncated: false }));
    for (const p of PHASES) expect(html).toContain(p.label);
    expect(html).toContain("—");
    expect(html).toContain("↻2");
    expect(html.match(/<tr[ >]/g)!.length).toBe(1 + Math.min(100, items.length));
  });

  it("names a piece of work by its identifier, with links to its PRs and issue and no author column", async () => {
    const { ItemTable } = await import("../../web/src/Flow");
    const block = { phase: "working", start: "2026-11-19T10:00:00Z", end: "2026-11-19T11:00:00Z", rounds: 1, idle_s: 0, idle: {} };
    const work = {
      subject: "task:0b1c", title: "Fix the widget", task: "0b1c", identifier: "WOR-7", url: null, repo: null, number: null, author: null, author_kind: null,
      links: [{ subject: "issue:acme/widgets#7", url: "https://github.com/acme/widgets/issues/7" }, { subject: "pr:acme/widgets#12", url: "https://github.com/acme/widgets/pull/12" }],
      state: "done" as const, start: block.start, end: block.end, total_s: 3600, blocks: [block],
    };
    const html = renderToStaticMarkup(createElement(ItemTable, { items: [work], phases: [{ name: "working", label: "Working" }], color: () => "red", onTask: () => {}, label: "Work", truncated: false }));
    expect(html).toContain("WOR-7");
    expect(html).toContain(">PR #12</a>");
    expect(html).toContain(">issue #7</a>");
    expect(html).not.toContain("Author");
  });
});
