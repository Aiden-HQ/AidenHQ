// The Flow page's empty state (web/src/Flow.tsx).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { FlowEmpty, dominantWait } from "../../web/src/Flow";

describe("the empty page", () => {
  it("says Flow fills in as work happens, with no history import button", () => {
    const empty = renderToStaticMarkup(createElement(FlowEmpty));
    expect(empty).toContain("Flow fills in as work happens.");
    expect(empty).not.toContain("Import history");
    expect(dominantWait({ grader_retry: 62, checks: 38 })).toEqual({ reason: "grader_retry", share: 0.62 });
  });
});
