import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppCard } from "../../web/src/Apps";

describe("app card", () => {
  it("keeps an unpublished app's name in the header and its note below it", () => {
    const html = renderToStaticMarkup(createElement(AppCard, { a: { name: "notes", healthy: false, state: "not deployed", unpublished: true } }));
    const head = /<header class="app-card-head">(.*?)<\/header>/.exec(html)?.[1] ?? "";
    expect(head).toContain("<h3>notes</h3>");
    expect(head).not.toContain("Opens in a browser");
    expect(html).toContain('class="app-note muted"');
  });

  it("says why an app doesn't open yet, in apps-mcp's words, never with a link", () => {
    const html = renderToStaticMarkup(createElement(AppCard, { a: { name: "notes", healthy: true, state: "healthy", unpublished: "Waiting for its HTTPS certificate." } }));
    expect(html).toContain("Waiting for its HTTPS certificate.");
    expect(html).not.toContain("href=");
  });

  // docs/design/app-doors.md: a local door's sign-in needs Secure cookies on plain http, which Safari doesn't keep.
  it("a local door: Open where the browser can sign in; elsewhere the Chrome or Firefox note and a link to copy", () => {
    const a = { name: "notes", healthy: true, state: "healthy", url: "http://notes.localhost:3130" };
    const ok = renderToStaticMarkup(createElement(AppCard, { a, secureCookies: true }));
    expect(ok).toContain('href="http://notes.localhost:3130"');
    expect(ok).not.toContain("Chrome or Firefox");
    const safari = renderToStaticMarkup(createElement(AppCard, { a, secureCookies: false }));
    expect(safari).not.toContain("href=");
    expect(safari).toContain("Apps open in Chrome or Firefox on this Mac.");
    expect(safari).toContain("Copy link");
    // an https door opens anywhere
    expect(renderToStaticMarkup(createElement(AppCard, { a: { ...a, url: "https://notes.203-0-113-7.sslip.io" }, secureCookies: false }))).toContain("href=");
  });
});
