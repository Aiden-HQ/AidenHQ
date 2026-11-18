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
});
