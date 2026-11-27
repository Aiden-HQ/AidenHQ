// A setup page's organisation picker lists only the organisations with an app for its module: a saved or email-suggested
// organisation that has none for it must not become the pick (its button label would dereference a missing choice).
import { afterEach, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OrganisationPicker } from "../../web/src/Organisation";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  unstubAllGlobals();
});

it("starts on the organisation applied to the module, not on a saved one that has no app for it", async () => {
  const body = {
    organisations: [
      { id: "acme", name: "Acme", domains: ["acme.com"], connections: ["github"] },
      { id: "globex", name: "Globex", domains: ["globex.com"], connections: ["slack"] },
    ],
    suggested: "acme",
    chosen: "acme",
    applied: { slack: "globex" } as Record<string, string>,
  };
  stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })));
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(createElement(OrganisationPicker, { bare: true, module: "slack" }));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(el.querySelector("button")?.textContent).toBe("Use Globex");
  // With nothing applied, the saved organisation (no app for slack) is not picked.
  body.applied = {};
  act(() => root!.unmount());
  root = createRoot(el);
  await act(async () => {
    root!.render(createElement(OrganisationPicker, { bare: true, module: "slack" }));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(el.querySelector("button")?.textContent).toBe("Use this organisation");
  // A saved organisation that left the catalog is not picked either, on the Settings picker.
  body.chosen = "gone";
  body.suggested = null as never;
  act(() => root!.unmount());
  root = createRoot(el);
  await act(async () => {
    root!.render(createElement(OrganisationPicker, {}));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(el.textContent).toContain("None of these");
});
