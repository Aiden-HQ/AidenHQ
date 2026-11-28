import { expect, test } from "bun:test";
import { renderTelegram } from "../src/format.js";

const types = (r: ReturnType<typeof renderTelegram>) => r.entities.map((e) => [r.text.slice(e.offset, e.offset + e.length), (e.type as any)._.replace("textEntityType", ""), (e.type as any).url]);

test("bold labels, italic, code and links become entities", () => {
  const r = renderTelegram("**Time:** 3pm, _maybe_ `ok` [site](https://a.b/x_(y))");
  expect(r.text).toBe("Time: 3pm, maybe ok site");
  expect(types(r)).toEqual([["Time:", "Bold", undefined], ["maybe", "Italic", undefined], ["ok", "Code", undefined], ["site", "TextUrl", "https://a.b/x_(y)"]]);
});

test("bullets become • and a quote becomes a blockquote", () => {
  const r = renderTelegram("Lead\n\n- **One:** a\n- Two\n\n> said\n> more");
  expect(r.text).toBe("Lead\n\n• One: a\n• Two\n\nsaid\nmore");
  expect(types(r)).toEqual([["One:", "Bold", undefined], ["said\nmore", "BlockQuote", undefined]]);
});

test("a header degrades to a bold line and a table to plain lines; snake_case stays", () => {
  const r = renderTelegram("## Plan\n| a | b |\n|---|---|\n| 1 | 2 |\nsome_snake_name");
  expect(r.text).toBe("Plan\na · b\n1 · 2\nsome_snake_name");
  expect(types(r)).toEqual([["Plan", "Bold", undefined]]);
});

test("offsets count UTF-16 units after an emoji", () => {
  const r = renderTelegram("👀 **x**");
  expect(r.entities[0]).toMatchObject({ offset: 3, length: 1 });
});
