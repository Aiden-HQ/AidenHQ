// The frame's vertical scroll container is the row's main column, not `.app`: if `.app` scrolls, `.app-row` (and the
// Fleet sub-nav beside it) grows with the page content and the sub-nav scrolls away from the viewport. A CSS layout
// can't be measured in happy-dom, so this reads the stylesheet and holds the rule that makes it true.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../web/src/shell.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const end = css.indexOf("}", at);
  const body = css.slice(at + selector.length + 2, end);
  return body.split(";").map((decl: string) => decl.trim()).filter(Boolean);
};

describe("the frame's scroll container", () => {
  it("scrolls .app-main vertically, so the sub-nav stays the height of the viewport", () => {
    expect(rule(".app-main")).toContain("overflow-y: auto");
  });
});
