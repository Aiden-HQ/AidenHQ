// What the owner sees in Slack: agent markdown as mrkdwn, with only the board's own address formable as a link.
import { expect, it } from "vitest";
import { toSlackMrkdwn } from "../src/mrkdwn.js";

const BOARD_URL = "https://board.example/";

it("renders bold, italics, headings and bullets", () => {
  expect(toSlackMrkdwn("**Hold** __it__\n## H\n- one")).toBe("*Hold* _it_\n*H*\n• one");
});

it("an in-app route becomes a link to the board's own address, with the address visible", () => {
  expect(toSlackMrkdwn("Tap [Set up Telegram](#/setup/x).", BOARD_URL)).toBe("Tap Set up Telegram (<https://board.example/#/setup/x>).");
  expect(toSlackMrkdwn("[Connect](#/settings/connections)", BOARD_URL)).toBe("Connect (<https://board.example/#/settings/connections>)");
});

it("an absolute external link keeps today's behaviour: label and the real address, visible", () => {
  expect(toSlackMrkdwn("[docs](https://example.com/a)", BOARD_URL)).toBe("docs (<https://example.com/a>)");
});

it("no board address leaves a route literal, not a broken link", () => {
  expect(toSlackMrkdwn("[Set up](#/setup/x)")).toBe("[Set up](#/setup/x)");
  expect(toSlackMrkdwn("[Set up](#/setup/x)", "not a url")).toBe("[Set up](#/setup/x)");
});

it("a route inside inline code stays literal, and the label can't carry markup", () => {
  expect(toSlackMrkdwn("`[Set up](#/setup/x)`", BOARD_URL)).toBe("`[Set up](#/setup/x)`");
  expect(toSlackMrkdwn("[<b>Set up</b>](#/setup/x)", BOARD_URL)).toBe("[&lt;b&gt;Set up&lt;/b&gt;](#/setup/x)");
});
