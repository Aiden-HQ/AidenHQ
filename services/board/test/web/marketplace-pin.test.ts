// The marketplace form's pin (web/src/Marketplaces.tsx AddMarketplace) belongs to the repository that was checked: a
// lookup answered after the input changed must not offer to add that commit to the new repository.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AddMarketplace } from "../../web/src/Marketplaces";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  unstubAllGlobals();
});

const answer = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const input = (el: HTMLElement) => el.querySelector<HTMLInputElement>(".br-search")!;
const submit = (el: HTMLElement) => el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const type = async (el: HTMLElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(el), text);
    input(el).dispatchEvent(new Event("input", { bubbles: true }));
  });

const render = async (resolve: (repo: string) => Promise<unknown>) => {
  stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => answer(await resolve(JSON.parse(init?.body ?? "{}").repo))));
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(AddMarketplace)));
  return el;
};

describe("the marketplace pin", () => {
  it("drops a lookup answered after the repository was edited", async () => {
    let first!: (v: unknown) => void;
    const el = await render((repo) =>
      repo === "acme/first" ? new Promise((r) => (first = r)) : Promise.resolve({ sha: "b".repeat(40), date: "2026-11-01T00:00:00Z" }),
    );
    await type(el, "acme/first");
    await act(async () => submit(el));
    await type(el, "acme/second");
    await act(async () => first({ sha: "a".repeat(40), date: "2026-11-01T00:00:00Z" }));
    // The late answer for acme/first is not offered against acme/second.
    expect(el.textContent).not.toContain("Pinning");
    expect(el.querySelector("button")!.textContent).toBe("Check repository");
  });

  it("offers the pin once the checked repository is the one in the input", async () => {
    const el = await render(async () => ({ sha: "a".repeat(40), date: "2026-11-01T00:00:00Z" }));
    await type(el, "acme/first");
    await act(async () => submit(el));
    expect(el.textContent).toContain("Pinning aaaaaaa from");
    expect(el.querySelector("button")!.textContent).toBe("Add marketplace");
  });
});
