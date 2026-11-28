// A settings card (web/src/SettingsForm.tsx): editing rows opens one Save/Discard bar, and Save files every change in one request.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsCard } from "../../web/src/SettingsForm";
import { ChangesScope } from "../../web/src/settings-ui";
import type { SettingRow } from "../../web/src/types";
import { stubGlobal, unstubAllGlobals } from "../stubs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<SettingRow>): SettingRow => ({ key: "k", module: "kernel", value: null, set: false, known: true, ...over });
const rows = [
  row({ key: "owner_name", title: "Your name", value: "Alex" }),
  row({ key: "spend_day_usd", title: "Daily spend limit", value: 50, default: 50 }),
  row({ key: "time_format", title: "Time format", value: null, default: "12h", values: ["12h", "24h"] }),
];

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  unstubAllGlobals();
});

describe("a settings card", () => {
  it("has no bar until a row changes; Save files all the changes at once, Discard drops them", async () => {
    const sent: { path: string; body: unknown }[] = [];
    stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") sent.push({ path, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, text: async () => JSON.stringify(path.includes("/changes") ? { changes: [] } : { identifier: "WOR-900" }) };
    }));
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(ChangesScope, { onSignIn: () => {}, children: createElement(SettingsCard, { rows }) })));
    expect(el.querySelector(".st-bar")).toBeNull();
    // Typing keeps the raw text (a trailing space is not trimmed away), and only a touched row is a change.
    const name = el.querySelector<HTMLInputElement>("input[aria-label='Your name']")!;
    const setName = (v: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, v);
    await act(async () => { setName("Alex "); name.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(name.value).toBe("Alex ");
    await act(async () => { setName("Alex"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(el.querySelector(".st-bar")).toBeNull();
    const input = el.querySelector<HTMLInputElement>("input[aria-label='Daily spend limit']")!;
    const set = (v: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    await act(async () => { set("75"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => void [...el.querySelectorAll<HTMLButtonElement>(".ui-seg button")].find((b) => b.textContent === "24h")!.click());
    expect(el.querySelector(".st-bar")?.textContent).toContain("2 changes");
    // An emptied number is a problem, not a $0 limit: Save is off.
    await act(async () => { set(""); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect([...el.querySelectorAll<HTMLButtonElement>(".st-bar button")].find((b) => b.textContent === "Save")!.disabled).toBe(true);
    await act(async () => { set("75"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    // Discard: the draft is gone and so is the bar.
    await act(async () => void [...el.querySelectorAll<HTMLButtonElement>(".st-bar button")].find((b) => b.textContent === "Discard")!.click());
    expect(el.querySelector(".st-bar")).toBeNull();
    expect(input.value).toBe("50");
    await act(async () => { set("75"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => void [...el.querySelectorAll<HTMLButtonElement>(".ui-seg button")].find((b) => b.textContent === "24h")!.click());
    await act(async () => void [...el.querySelectorAll<HTMLButtonElement>(".st-bar button")].find((b) => b.textContent === "Save")!.click());
    expect(sent.filter((s) => s.path === "/api/settings/change")).toHaveLength(1);
    expect(sent.find((s) => s.path === "/api/settings/change")!.body).toMatchObject({ changes: [{ kind: "setting", key: "spend_day_usd", value: 75 }, { kind: "setting", key: "time_format", value: "24h" }] });
  });
});
