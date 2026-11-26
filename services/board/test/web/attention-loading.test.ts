// @vitest-environment happy-dom
// The Tasks page's fleet strip before its counts arrive (web/src/Attention.tsx): it renders its own frame, marked busy, so
// the board below it lands in place instead of being pushed down when the counts answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../web/src/events", () => ({ useLive: () => {} }));
vi.mock("../../web/src/queries", () => ({ QUERIES: { needsYou: { key: "needs-you" } }, useQuery: () => ({ data: undefined, reload: () => {} }) }));

import { AttentionStrip } from "../../web/src/Attention";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

const mount = async (compact?: boolean) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(AttentionStrip, { onSignIn: () => {}, compact })));
  return el;
};

describe("the fleet strip's loading frame", () => {
  it("renders the strip's section, busy, with its heading and the open list's area while the counts are undefined", async () => {
    const el = await mount();
    const section = el.querySelector("section.attn");
    expect(section).not.toBeNull();
    expect(section!.getAttribute("aria-busy")).toBe("true");
    expect(section!.getAttribute("aria-label")).toMatch(/loading/i);
    expect(el.querySelector(".attn-title")?.textContent).toBe("Fleet attention");
    expect(el.querySelector(".attn-slot-load")).not.toBeNull();
  });

  it("keeps the compact strip to its one line while loading", async () => {
    const el = await mount(true);
    expect(el.querySelector("section.attn.attn-compact")).not.toBeNull();
    expect(el.querySelector(".attn-slot-load")).toBeNull();
  });
});
