import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppTile } from "../../web/src/Apps";

describe("app tile", () => {
  it("says why an app doesn't open yet, in apps-mcp's words, with no Open", () => {
    const html = renderToStaticMarkup(createElement(AppTile, { a: { name: "notes", healthy: false, state: "not deployed", unpublished: "Waiting for its HTTPS certificate." } }));
    expect(html).toContain("Waiting for its HTTPS certificate.");
    expect(html).toContain("Not deployed");
    expect(html).not.toContain(">Open<");
  });

  // docs/design/app-doors.md: a local door's sign-in needs Secure cookies on plain http, which Safari doesn't keep.
  it("a local door: Open where the browser can sign in; elsewhere the Chrome or Firefox note and a link to copy", () => {
    const a = { name: "notes", healthy: true, state: "healthy", url: "http://notes.localhost:3130" };
    const ok = renderToStaticMarkup(createElement(AppTile, { a, secureCookies: true }));
    expect(ok).toContain('href="http://notes.localhost:3130"');
    expect(ok).not.toContain("Chrome or Firefox");
    const safari = renderToStaticMarkup(createElement(AppTile, { a, secureCookies: false }));
    expect(safari).not.toContain('href="http://notes.localhost:3130"');
    expect(safari).toContain("Apps open in Chrome or Firefox on this Mac.");
    expect(safari).toContain("Copy link");
    // an https door opens anywhere
    expect(renderToStaticMarkup(createElement(AppTile, { a: { ...a, url: "https://notes.203-0-113-7.sslip.io" }, secureCookies: false }))).toContain('href="https://notes.203-0-113-7.sslip.io"');
  });
});
