import { expect, test } from "bun:test";
import { toSlackMrkdwn } from "../src/mrkdwn.js";

test("bold labels, bullets, links on the words and a quote render as mrkdwn", () => {
  expect(toSlackMrkdwn("Lead\n\n- **Time:** 3pm, _maybe_ [site](https://a.b/x)\n- `x`\n\n> said", { labelled: true })).toBe("Lead\n\n• *Time:* 3pm, _maybe_ <https://a.b/x|site>\n• `x`\n\n> said");
});

test("a message to the owner keeps the address visible", () => {
  expect(toSlackMrkdwn("[site](https://a.b/x)")).toBe("site (<https://a.b/x>)");
});

test("a header degrades to a bold line and a table to plain lines", () => {
  expect(toSlackMrkdwn("## Plan\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("*Plan*\na · b\n1 · 2");
});

test("the bot's own posts keep the mentions and links the agent wrote", () => {
  expect(toSlackMrkdwn("- hi <@U1> <https://a.b|x> **b**", { labelled: true, keepTokens: true })).toBe("• hi <@U1> <https://a.b|x> *b*");
});
