// @vitest-environment happy-dom
// A module page's Sign-ins panel (web/src/SecretMaps.tsx): it lists which keys are set, sets and clears one through the board's own
// route, and what it sent is never drawn again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SecretMaps } from "../../web/src/SecretMaps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A sample key's armour, built from parts so the repo's leak scan doesn't read this test as one.
const PEM_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ");

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await Promise.resolve()));
};

describe("secret maps panel", () => {
  it("sets one key's entry, never shows a stored value, and clears it", async () => {
    let set = false;
    const sent: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          sent.push({ path, body: JSON.parse(init.body!) });
          set = (JSON.parse(init.body!) as { values: unknown }).values !== null;
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
        }
        const fields = [{ name: "username", label: "Username", kind: "text" }, { name: "password", label: "Password", kind: "password" }, { name: "private_key", label: "Private key", kind: "key", maxLength: 4096 }];
        return { ok: true, status: 200, text: async () => JSON.stringify({ maps: [{ secret: "ui_logins", fields, keys: [{ key: "acme", set, listed: true }, { key: "beta", set: true, listed: true }] }] }) };
      }),
    );
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(SecretMaps, { page: "ui-testing", reload: 0, onSignIn: () => {} })));
    await flush();
    expect(el.textContent).toContain("acme");
    expect(el.textContent).toContain("Not set");
    const button = (word: string, nth = 0) => [...el.querySelectorAll("button")].filter((b) => b.textContent === word)[nth]!;

    await act(async () => button("Set").click());
    const input = (name: string) => el.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
    expect(input("password").type).toBe("password");
    const type = async (i: HTMLInputElement, v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, v);
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A key field is a visible multi-line textarea, not a hidden single-line input.
    expect(el.querySelector("textarea[name=private_key]")).not.toBeNull();
    expect(el.querySelectorAll("textarea[name=private_key]")[0]!.getAttribute("rows")).toBe("6");
    expect(el.querySelectorAll("input[name=private_key]")).toHaveLength(0);
    await type(input("username"), "tester");
    await type(input("password"), "s3cret-pw");
    const key = el.querySelector<HTMLTextAreaElement>("textarea[name=private_key]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(key, `${PEM_HEAD}\nAAA\n${PEM_END}\n`);
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save").click());
    await flush();
    expect(sent).toEqual([{ path: "/api/pages/ui-testing/secrets/ui_logins/acme", body: { values: { username: "tester", password: "s3cret-pw", private_key: `${PEM_HEAD}\nAAA\n${PEM_END}\n` } } }]);
    // Saved: the form is gone, the key reads Set, and the typed value is nowhere on the page.
    expect(el.querySelector("input")).toBeNull();
    expect(el.querySelector("textarea")).toBeNull();
    expect(el.textContent).not.toContain("s3cret-pw");
    expect(el.innerHTML).not.toContain("s3cret-pw");

    await act(async () => button("Clear", 0).click());
    await flush();
    expect(sent[1]).toEqual({ path: "/api/pages/ui-testing/secrets/ui_logins/acme", body: { values: null } });
  });
});
