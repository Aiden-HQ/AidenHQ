// @vitest-environment happy-dom
// A page that throws while rendering (web/src/ErrorBoundary.tsx) is replaced by its message in place: the rest of the
// board, the nav included, stays mounted, and a new route renders again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "../../web/src/ErrorBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error("pin.sha is undefined");
}

/** The board's frame around the boundary: the nav is outside it, as TopNav/SubNav are in App.tsx. */
const mount = async (page: ReactNode, resetKey?: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const tree = (next: ReactNode, key?: string) =>
    createElement("div", null, createElement("nav", null, createElement("a", { href: "#/costs" }, "Costs")), createElement(ErrorBoundary, { resetKey: key, children: next }));
  const show = (next: ReactNode, key?: string) => act(async () => root!.render(tree(next, key)));
  await show(page, resetKey);
  return { el, show };
};

describe("the page error boundary", () => {
  it("shows the fallback in the page's place while the nav stays up", async () => {
    const { el } = await mount(createElement(Boom));
    expect(el.textContent).toContain("This page failed to load");
    expect(el.textContent).toContain("pin.sha is undefined");
    // The page was replaced, not the app: the nav around the boundary is still there.
    expect(el.querySelector("nav a")?.textContent).toBe("Costs");
    expect(el.querySelector(".error-boundary")).not.toBeNull();
  });

  it("renders the next page after the route changes", async () => {
    const { el, show } = await mount(createElement(Boom), "board");
    expect(el.textContent).toContain("This page failed to load");
    await show(createElement("p", null, "Costs page"), "costs");
    expect(el.querySelector(".error-boundary")).toBeNull();
    expect(el.textContent).toBe("CostsCosts page");
  });

  it("retries the same page on Retry", async () => {
    let fail = true;
    const Maybe = () => (fail ? (() => { throw new Error("once"); })() : createElement("p", null, "Loaded now"));
    const { el } = await mount(createElement(Maybe));
    expect(el.textContent).toContain("This page failed to load");
    fail = false;
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(el.querySelector(".error-boundary")).toBeNull();
    expect(el.textContent).toBe("CostsLoaded now");
  });
});
