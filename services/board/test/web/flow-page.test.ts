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
