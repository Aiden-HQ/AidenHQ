// @vitest-environment happy-dom
// A sign-in's own rows (web/src/SignInLines.tsx): the GitHub card's text, an Authorize link to GitHub's URL, and a Reconnect
// that is the sign-in's own Connect button.
import { afterEach, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SignInLines } from "../../web/src/SignInLines";
import type { SignIn } from "../../web/src/connections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => act(() => root?.unmount()));

it("sign-in lines render with actions", () => {
  const signIn: SignIn = {
    state: "ok",
    configured: true,
    since: "",
    login: "mudit",
    lines: [
      { label: "Reads, issues, comments", value: "working", state: "ok" },
      { label: "CI runners", value: "needs permission", state: "warn", action: { label: "Reconnect", reconnect: true } },
      { label: "Fleet repos", value: "in acme", state: "ok", action: { label: "Change", href: "#/modules/github/settings" } },
      { label: "Rate limit", value: "3,812 of 5,000 left, resets", time: "2026-11-20T10:20:00Z", state: "ok" },
      { label: "evil", value: "x", state: "warn", action: { label: "Run", href: "javascript:alert(1)" } },
      { label: "0xPolygon", value: "GitHub needs you to authorize single sign-on", state: "warn", action: { label: "Authorize", href: "https://github.com/orgs/0xPolygon/sso?x=1" } },
    ],
  };
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(createElement(SignInLines, { c: { id: "github", label: "GitHub", signIn }, can: true })));
  expect(el.textContent).toContain("Connected as @mudit");
  expect(el.textContent).toContain("GitHub needs you to authorize single sign-on");
  const link = [...el.querySelectorAll("a")].find((a) => a.textContent === "Authorize");
  expect(link?.getAttribute("href")).toBe("https://github.com/orgs/0xPolygon/sso?x=1");
  const change = [...el.querySelectorAll("a")].find((a) => a.textContent === "Change");
  expect([change?.getAttribute("href"), change?.getAttribute("target")]).toEqual(["#/modules/github/settings", null]);
  expect(el.textContent).toContain(`resets ${new Date("2026-11-20T10:20:00Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  expect([...el.querySelectorAll("a")].some((a) => a.textContent === "Run")).toBe(false);
  expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Reconnect"]);
});
