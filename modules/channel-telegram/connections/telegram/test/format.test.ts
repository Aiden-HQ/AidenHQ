// What the owner sees: agent markdown rendered for Telegram.
import { expect, it } from "vitest";
import { toTelegramHtml } from "../src/telegram.js";

it("renders bold, italics and headings in Telegram", () => {
  expect(toTelegramHtml("**Hold** __it__\n## H")).toBe("<b>Hold</b> <i>it</i>\n<b>H</b>");
});
