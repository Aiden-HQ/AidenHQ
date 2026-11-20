// Settings is named in the board's top bar and in the palette's default list, so guidance saying "Settings" finds it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Palette, TopNav } from "../../web/src/Shell";

describe("Settings in the navigation", () => {
  it("shows the word Settings in the top bar", () => {
    const html = renderToStaticMarkup(
      createElement(TopNav, {
        view: "chat",
        approvals: 0,
        agentsActive: 0,
        onNav: () => {},
        spend: null,
        settingsAlert: true,
        brief: false,
        onPalette: () => {},
      }),
    );
    const settings = /<a[^>]*aria-label="Settings"[^>]*>(.*?)<\/a>/.exec(html);
    expect(settings?.[1]).toContain("Settings");
    expect(settings?.[1]).toContain("tn-dot");
  });

  it("lists Settings in the palette before anything is typed", () => {
    const html = renderToStaticMarkup(createElement(Palette, { open: true, onClose: () => {}, go: () => {}, crew: [], apps: [], onNewTask: () => {} }));
    expect(html).toContain('id="pal-v-settings"');
    expect(html).toContain('class="pal-label">Settings</span>');
  });
});
