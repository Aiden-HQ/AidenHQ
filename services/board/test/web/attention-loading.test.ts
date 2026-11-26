// @vitest-environment happy-dom
// The Tasks page's fleet strip (web/src/Attention.tsx): one line of counts that opens its list on a click. Before the counts
// arrive it renders that same line, marked busy, so the board below lands in place instead of being pushed down.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../web/src/events", () => ({ useLive: () => {} }));
const query = vi.hoisted(() => ({ data: undefined as unknown, error: "" }));
vi.mock("../../web/src/queries", () => ({ QUERIES: { needsYou: { key: "needs-you" } }, useQuery: () => ({ ...query, reload: () => {} }) }));

import { AttentionStrip } from "../../web/src/Attention";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  // A shared mock: the failure one test sets must not leak into the next, which asserts the loading frame.
  query.error = "";
});

const mount = async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(AttentionStrip, { onSignIn: () => {} })));
  return el;
};

const loaded = {
  counts: { needs_you: 1, failed: 0, unexplained_idle: 0 },
  approvals: 0,
  items: [
    {
      identifier: "WOR-1",
      title: "A task that needs you",
      agent: "lena",
      state: { kind: "waiting", reason: "owner_wait", attention: [{ who: "owner", why: "owner_wait", ref: "wait:t", since: "2026-11-26T05:00:00Z" }] },
    },
  ],
};

describe("the fleet strip's loading frame", () => {
  it("renders the strip's one line, busy, with no reserved list area while the counts are undefined", async () => {
    const el = await mount();
    const section = el.querySelector("section.attn");
    expect(section).not.toBeNull();
    expect(section!.getAttribute("aria-busy")).toBe("true");
    expect(section!.getAttribute("aria-label")).toMatch(/loading/i);
    expect(section!.classList.contains("attn-compact")).toBe(true);
    expect(el.querySelector(".attn-title")?.textContent).toBe("Fleet attention");
    expect(el.querySelector(".attn-list")).toBeNull();
    expect(el.querySelector(".attn-list-load")).toBeNull();
  });

  it("shows the read's failure instead of a busy frame that never ends", async () => {
    query.error = "the kernel didn't answer";
    const el = await mount();
    expect(el.querySelector("section.attn[aria-busy]")).toBeNull();
    expect(el.querySelector(".attn-failed")?.textContent).toMatch(/unavailable/i);
    expect(el.textContent).toContain("the kernel didn't answer");
  });

  it("keeps its list closed until a count is clicked, then opens and closes it", async () => {
    query.data = loaded;
    const el = await mount();
    expect(el.querySelector(".attn-list")).toBeNull();
    expect(el.textContent).not.toContain("A task that needs you");
    const count = el.querySelector<HTMLButtonElement>(".attn-count.attn-needs")!;
    expect(count.getAttribute("aria-expanded")).toBe("false");
    await act(async () => count.click());
    expect(count.getAttribute("aria-expanded")).toBe("true");
    expect(el.textContent).toContain("A task that needs you");
    await act(async () => count.click());
    expect(count.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".attn-list")).toBeNull();
  });
});
