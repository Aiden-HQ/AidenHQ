// Ask Aiden (web/src/AskAiden.tsx): ⌘J opens a non-modal panel with focus in its composer, Escape closes it and gives focus
// back, and "@Max …" starts a chat the server routes (no agent field).
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { key, mountApp, settle, unmountApp } from "./app-fixture";

afterEach(unmountApp);

describe("Ask Aiden", () => {
  it("opens on ⌘J with focus in its composer, leaves the page usable, and closes on Escape", async () => {
    const { el, sent } = await mountApp("#/");
    await key("j", { metaKey: true });
    await settle();
    const panel = el.querySelector("#ask-aiden")!;
    expect(panel).not.toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
    // No backdrop: a Home button still works.
    const send = [...el.querySelectorAll<HTMLButtonElement>("#need-id-815 button")].find((b) => b.textContent === "Last week")!;
    await act(async () => send.click());
    await settle();
    expect(sent.some((s) => s.path === "/api/issues/WOR-815/answer")).toBe(true);
    (panel.querySelector("textarea") as HTMLTextAreaElement).focus();
    await key("Escape");
    await settle();
    expect(el.querySelector("#ask-aiden .ui-side:not(.leaving)")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-controls")).toBe("ask-aiden");
  });

  it("sends @teammate text as a new chat with no agent field", async () => {
    const { el, sent } = await mountApp("#/");
    await key("j", { metaKey: true });
    await settle();
    const box = el.querySelector<HTMLTextAreaElement>("#ask-aiden textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "@Max look at #821");
    await act(async () => box.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await settle();
    expect(sent.find((s) => s.path === "/api/chats" && s.method === "POST")?.body).toEqual({ text: "@Max look at #821" });
  });
});
