// The task drawer's title (web/src/Drawer.tsx Title): an edit in progress survives a refresh that changes the title, and
// Escape drops it without saving.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Title } from "../../web/src/Drawer";
import type { IssueView } from "../../web/src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

const issue = (title: string) => ({ id: "t1", title }) as IssueView;
const mount = async (save: (t: string) => Promise<boolean>) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (title: string) => act(async () => root!.render(createElement(Title, { issue: issue(title), editable: true, save })));
  await show("Ship it");
  return { box: el.querySelector("textarea")!, show };
};
/** Types into the textarea the way React hears it. */
const type = (box: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("the drawer's title", () => {
  it("follows the task until edited, then keeps the edit through a refresh and saves it", async () => {
    const save = vi.fn(async () => true);
    const { box, show } = await mount(save);
    await show("Ship it today");
    expect(box.value).toBe("Ship it today");
    box.focus();
    await type(box, "Ship it tomorrow");
    await show("Renamed elsewhere");
    expect(box.value).toBe("Ship it tomorrow");
    await act(async () => box.blur());
    expect(save).toHaveBeenCalledWith("Ship it tomorrow");
  });

  it("keeps a newer edit typed while the earlier one was saving", async () => {
    let saved!: (ok: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((r) => (saved = r)));
    const { box, show } = await mount(save);
    box.focus();
    await type(box, "First");
    await act(async () => box.blur());
    box.focus();
    await type(box, "Second");
    await act(async () => saved(true));
    await show("First");
    expect(box.value).toBe("Second");
  });

  it("keeps the edit when the save failed, for another try", async () => {
    const save = vi.fn(async () => false);
    const { box } = await mount(save);
    box.focus();
    await type(box, "Ship it later");
    await act(async () => box.blur());
    expect(save).toHaveBeenCalledWith("Ship it later");
    expect(box.value).toBe("Ship it later");
  });

  it("drops the edit on Escape without saving", async () => {
    const save = vi.fn(async () => true);
    const { box } = await mount(save);
    box.focus();
    await type(box, "Never mind");
    await act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(save).not.toHaveBeenCalled();
    expect(box.value).toBe("Ship it");
  });
});
