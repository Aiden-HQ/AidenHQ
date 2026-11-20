// The shared prompt sections setup writes into agent handbooks live in scripts/prompts/<name>.md, wrapped at about 120
// characters so concurrent edits merge. A section is its file, unwrapped: a newline inside a paragraph is a space, a line
// starting "- " begins a list item (its continuation lines are indented), a blank line separates paragraphs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export const unwrap = (text: string) => text.replace(/\n$/, "").split("\n\n").map((block) => block.split("\n").reduce((out: string, line: string) => (out === "" ? line : line.startsWith("- ") ? `${out}\n${line}` : `${out} ${line.trimStart()}`), "")).join("\n\n");

/** "\n\n## Heading..." as setup appends it; `tail` is the text's own ending. */
export const section = (name: string, tail = "\n") => `\n\n${unwrap(readFileSync(join(dir, `${name}.md`), "utf8"))}${tail}`;
