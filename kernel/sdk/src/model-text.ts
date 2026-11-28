// Model-format text a completion can leak into a reply as literal text, and the policy that removes it at the edges: the
// tokenizer/chat-template sentinels and headers (`stripSentinels`, which a job's stored last message already goes through in
// jobs.ts), and the tool-call markup a model writes as text instead of calling a tool. The markup has one definition here
// (`hasToolMarkup`), so the task tools' refusal and the kernel's reply sanitizer cannot drift apart; scripts/sync-shared.ts
// copies this file into the task tools' server.

/**
 * Model-format sentinels a tokenizer or chat template can leak into a reply as literal text: DeepSeek's begin/end of sentence
 * (its word separator is U+2581, and a model may echo it with underscores instead), the `<|...|>` chat templates, Gemma's
 * `<start_of_turn>` and OpenAI's `<|endoftext|>`. A run whose whole answer was sentinels is left with no message at all, which
 * its dispatcher reads as one that ended without a reply.
 */
const SENTINELS = [
  "<\uff5cbegin\u2581of\u2581sentence\uff5c>", "<\uff5cend\u2581of\u2581sentence\uff5c>",
  "<\uff5cbegin_of_sentence\uff5c>", "<\uff5cend_of_sentence\uff5c>",
  "<begin\u2581of\u2581sentence>", "<end\u2581of\u2581sentence>", "<begin_of_sentence>", "<end_of_sentence>",
  "<|im_start|>", "<|im_end|>", "<\uff5cim_start\uff5c>", "<\uff5cim_end\uff5c>",
  "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>", "<|eom_id|>",
  "<start_of_turn>", "<|end_of_turn|>", "<end_of_turn>",
  "<|begin_of_text|>", "<|end_of_text|>", "<|endoftext|>",
  "<\uff5cend\u2581of\u2581text\uff5c>", "<|end\u2581of\u2581text|>",
  // DeepSeek's turn markers, which stand alone at an edge and name the role in the marker itself.
  "<\uff5cUser\uff5c>", "<\uff5cAssistant\uff5c>", "<\uff5cSystem\uff5c>",
];
/**
 * A chat template's message header and the roles its own template gives a turn: `model` is Gemma's role, not ChatML's, so a
 * reply that opens with `<|im_start|>model` is a heading, and its text stays.
 */
const HEADERS: { text: string; roles: string[] }[] = [
  { text: "<|im_start|>", roles: ["system", "user", "assistant", "tool", "ipython"] },
  { text: "<\uff5cim_start\uff5c>", roles: ["system", "user", "assistant", "tool", "ipython"] },
  { text: "<|start_header_id|>", roles: ["system", "user", "assistant", "ipython", "tool"] },
  { text: "<start_of_turn>", roles: ["user", "model", "system"] },
];
/** The padding beside a sentinel: whitespace and the invisible characters a tokenizer leaves around one. */
const PAD = /[\s\u200b\ufeff\u2060]/;
/** The first index at or after `from` that is not padding, and the last before `to` that is not. */
const skipStart = (text: string, from: number, to: number) => {
  let i = from;
  while (i < to && PAD.test(text[i]!)) i++;
  return i;
};
const skipEnd = (text: string, from: number, to: number) => {
  let i = to;
  while (i > from && PAD.test(text[i - 1]!)) i--;
  return i;
};
/** The same as `skipEnd` inside a line: spaces and invisible characters, never a newline. */
const skipSpace = (text: string, from: number, to: number) => {
  let i = to;
  while (i > from && /[ \t\u200b\ufeff\u2060]/.test(text[i - 1]!)) i--;
  return i;
};
/** How long a role at `at` is, when one of `roles` starts there and a template delimiter follows it, else 0. */
const roleAt = (text: string, at: number, to: number, roles: string[]) => {
  const role = roles.find((r) => text.startsWith(r, at));
  if (!role) return 0;
  let i = at + role.length;
  while (i < to && /[ \t\u200b\ufeff\u2060]/.test(text[i]!)) i++;
  if (i >= to || text[i] === "\n" || text[i] === "\r") return role.length;
  return HEADERS.some((h) => text.startsWith(h.text, i)) || SENTINELS.some((s) => text.startsWith(s, i)) ? role.length : 0;
};
/** How far a leading header and its role reach past `from`, or undefined when the text there opens with neither. */
const afterHeader = (text: string, from: number, to: number) => {
  const header = HEADERS.find((h) => text.startsWith(h.text, from) && text[from - 1] !== "\\");
  if (!header) return undefined;
  // Only padding, never a newline, may sit between a header and its role: a role on the next line is the reply's own word.
  let at = from + header.text.length;
  while (at < to && /[ \t\u200b\ufeff\u2060]/.test(text[at]!)) at++;
  return at - from + roleAt(text, at, to, header.roles);
};
/** Where the reply's own text ends before a trailing header and its role ("Done.<|im_end|><|im_start|>user"), or undefined. */
const beforeHeader = (text: string, from: number, to: number) => {
  const end = skipEnd(text, from, to);
  for (const header of HEADERS) {
    const role = header.roles.find((r) => end - r.length >= from && text.startsWith(r, end - r.length));
    if (!role) continue;
    // As at the opening edge, a role on the next line is the reply's own word, never a template's role line.
    const head = skipSpace(text, from, end - role.length);
    const at = head - header.text.length;
    if (at >= from && text.startsWith(header.text, at) && text[at - 1] !== "\\") return at;
  }
  return undefined;
};
/**
 * True when the sentinel from `from` to `to` is the whole of a Markdown blockquote line ("> <|im_end|>"): the reply shows the
 * marker on purpose, so it stays. A marker anywhere else is a leak, however it is indented.
 */
const QUOTE_PREFIX = 64;
const quoted = (text: string, from: number, to: number, lineStart: number, limit: number) => {
  // A blockquote's own marks are a handful of characters: a longer prefix is reply text, and is not walked at all.
  if (from - lineStart > QUOTE_PREFIX) return false;
  // A blockquote's own marks, with an optional list marker in front of them ("- > <|im_end|>"): a handful of characters.
  const prefix = text.slice(lineStart, from);
  if (!/^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*>[ \t>]*$/.test(prefix)) return false;
  let i = to;
  while (i < limit && PAD.test(text[i]!)) i++;
  return i === limit;
};
/** The index at which each line starts, so a line start costs a lookup rather than a scan. */
const lineStarts = (text: string) => {
  const starts = [0];
  for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", nl + 1)) starts.push(nl + 1);
  return starts;
};
/** A fenced code block's opening line: a run of at least three backticks or tildes, indented at most three spaces, and an
 * optional info string after it. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Which lines open inside a fenced code block: the block's own text is the reply's, so a marker there stays. A closing line is
 * a run at least as long as the opening one and nothing but spaces after it, so the three backticks inside a four-backtick
 * block (or a content line like "```js") are its content, not its end. */
const fenceState = (text: string, starts: number[]) => {
  const inside = new Array<boolean>(starts.length);
  let open: { mark: string; length: number } | undefined;
  for (let i = 0; i < starts.length; i++) {
    inside[i] = open !== undefined;
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : text.length;
    const match = FENCE.exec(text.slice(starts[i]!, end));
    if (!match) continue;
    const [, run, rest] = match;
    if (!open) open = { mark: run![0]!, length: run!.length };
    else if (run![0] === open.mark && run!.length >= open.length && /^[ \t]*$/.test(rest!)) open = undefined;
  }
  return inside;
};

/**
 * A final message without the model-format sentinels a tokenizer or chat template leaks as literal text. They leak at the edges
 * of a completion, so a sentinel at either end is removed, with the padding beside it and the role line its header carries: a
 * reply that was only sentinels is left empty, so its dispatcher reads it as one that ended without a reply, while a reply that
 * shows a marker in a blockquote keeps it. Every step reads only the characters it needs, so a long reply or a run of
 * sentinels costs its own length rather than its square.
 */
export function stripSentinels(text: string): string {
  let from = 0, to = text.length;
  const starts = lineStarts(text);
  let line = 0;
  const leadLine = (at: number) => { while (line + 1 < starts.length && starts[line + 1]! <= at) line++; return starts[line]!; };
  let back = starts.length - 1;
  const tailLine = (at: number) => { while (back > 0 && starts[back]! > at) back--; return starts[back]!; };
  // Each edge is settled once: a removal there shortens the text and never touches the other edge, so neither end is rescanned.
  for (;;) {
    const at = skipStart(text, from, to);
    const after = afterHeader(text, at, to);
    const hit = after !== undefined ? undefined : SENTINELS.find((s) => text.startsWith(s, at) && text[at - 1] !== "\\");
    const reach = after ?? hit?.length;
    // Only what the reply still has before the marker counts as its line's prefix: a sentinel just removed is not there.
    if (reach === undefined || quoted(text, at, at + reach, Math.max(leadLine(at), from), to)) break;
    from = at + reach;
  }
  // The trailing scan stays inside what the leading one left: a reply that is the word `model` after a header is its own text.
  for (;;) {
    const end = skipEnd(text, from, to);
    const head = beforeHeader(text, from, end);
    if (head !== undefined) {
      if (quoted(text, head, end, Math.max(tailLine(head), from), to)) break;
      to = head;
      continue;
    }
    const hit = SENTINELS.find((s) => end - s.length >= from && text.startsWith(s, end - s.length) && text[end - s.length - 1] !== "\\");
    if (!hit || quoted(text, end - hit.length, end, Math.max(tailLine(end - hit.length), from), to)) break;
    to = end - hit.length;
  }
  // The padding a removed sentinel left beside the reply goes with it: the reply is stored as its own text.
  return text.slice(skipStart(text, from, to), skipEnd(text, from, to));
}

/**
 * A complete tool-call element tag, as text: DeepSeek's DSML spelling (fullwidth bars as its separators, e.g. its invoke or
 * parameter element) or a bare `<invoke>`, `</parameter>`, `<function_calls>` (attributes allowed). One definition, so the
 * task tools' refusal and a reply's sanitizer cannot drift apart.
 */
const TOOL_TAG = /<\/?[\uff5c|]*(?:DSML[^<>]*|invoke|parameter|function_calls)(?:\s[^<>]*)?>/i;
/** Whether `text` carries raw tool-call markup: the task tools refuse such an argument, and a reply's body is stripped of it. */
export const hasToolMarkup = (text: string) => TOOL_TAG.test(text);
/** A tool-call element's name: DSML's own spelling (after its leading bars), or a bare invoke/parameter/function_calls. */
const TOOL_NAME = /^\/?[\uff5c|]*(?:DSML[^\s<>]*|invoke|parameter|function_calls)(?=[\s/>]|$)/i;
/** Attributes a model writes inside a tag: `name="x"`, `name='x'`, and the same cut before its closing quote. */
const ATTRIBUTES = /^(?:\s+[^\s=<>]+\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s"'<>]*))*\s*$/;
/**
 * Where the tool-call markup that ends exactly at `end` starts, or undefined: a complete tag ("</invoke>"), an opening tag
 * cut short with its attributes ("<invoke name=\"x\""), or a tag's name cut short ("<｜DSML｜`DSM`").
 */
const toolTagEndingAt = (text: string, from: number, end: number) => {
  let at = text.lastIndexOf("<", end - 1);
  let frag = at < from ? "" : text.slice(at + 1, end);
  // A tag never spans a line, and `<` inside the fragment means an earlier tag ended first: the rest is prose.
  while (at >= from && end - at <= 300 && /[\n<]/.test(frag)) {
    at = text.lastIndexOf("<", at - 1);
    frag = at < from ? "" : text.slice(at + 1, end);
  }
  if (at < from || !frag || frag.length > 300) return undefined;
  const name = TOOL_NAME.exec(frag)?.[0];
  if (name !== undefined) {
    const rest = frag.slice(name.length);
    // A complete tag: everything up to the `>` at the edge.
    if (/^[^>]*>$/.test(rest)) return at;
    // A cut opening tag: its name, then only attributes (or part of one) and no `>` yet.
    return ATTRIBUTES.test(rest) ? at : undefined;
  }
  // A tag whose name is cut short: "<｜DSML｜`DSM`", or a bare "<DSML"/"<invoke"/"<param". A short prefix after prose ("x<d") is
  // the reply's own comparison, so a DSML one needs its opening bar and any other at least four characters.
  const opened = frag.replace(/^\//, "");
  const dsml = /^[\uff5c|]/.test(opened);
  const bare = opened.replace(/^[\uff5c|]+/, "").toLowerCase();
  const names = ["dsml", "invoke", "parameter", "function_calls"];
  return (dsml ? bare.length >= 3 : bare.length >= 4) && /^[a-z0-9_]+$/.test(bare) && names.some((n) => n.startsWith(bare)) ? at : undefined;
};
/** A complete tool-call tag's element name at `at`, or undefined: its tags are parsed to balance a trailing block. */
const toolTag = (text: string, at: number) => {
  const close = text.indexOf(">", at + 1);
  if (text[at] !== "<" || close < 0) return undefined;
  const inner = text.slice(at + 1, close);
  const closing = inner.startsWith("/");
  const name = sanitizeTagName(closing ? inner.slice(1) : inner);
  return name ? { name, closing, next: close + 1 } : undefined;
};
/** A tag's element name, in one spelling: a DSML tag's own element, or invoke/parameter/function_calls. */
const sanitizeTagName = (inner: string) => {
  const bare = inner.replace(/^[\uff5c|]+/, "");
  const dsml = /^DSML/i.test(bare);
  const name = dsml ? bare.slice(4).replace(/^[\uff5c|]+/, "").split(/[\s/>]/)[0]!.toLowerCase() : bare.split(/[\s/>]/)[0]!.toLowerCase();
  return dsml ? `dsml:${name}` : ["invoke", "parameter", "function_calls"].includes(name) ? name : "";
};
/**
 * Where a balanced trailing tool-call block starts, or undefined: a call element with its payload, such as
 * `<invoke><parameter>London</parameter></invoke>`, whose closing tag is at `end`. It is read from the element's opening tag, a
 * bounded distance back, and only when an opening tag sits there, so a long run of bare closing tags stays linear.
 */
const toolBlockEndingAt = (text: string, from: number, end: number, fenced: boolean[], starts: number[]) => {
  // The block must end in a closing tag: a lone opening one is a single tag, which the tag run strips.
  const at = toolTagEndingAt(text, from, end);
  if (at === undefined || !toolTag(text, at)?.closing) return undefined;
  // A block the reply shows inside a fenced code block is its own text: every line of it must be inside the fence.
  if (fenced[lineOf(starts, at)]) return undefined;
  const limit = Math.max(from, at - 4_000);
  // A call element's payload is at most a few tags, never a blank line: the opening tag is at most 4,000 characters back.
  const open = text.lastIndexOf("<", at - 1);
  if (open < limit || toolTag(text, open)?.closing) return undefined;
  let depth = 0, cursor = open;
  for (;;) {
    const tag = toolTag(text, cursor);
    if (!tag) return undefined;
    depth += tag.closing ? -1 : 1;
    // The opening tag must sit outside the fence too: a block that starts in prose and ends in a code sample is not one block.
    if (depth === 0) return cursor === at && !fenced[lineOf(starts, open)] ? open : undefined;
    cursor = tag.next;
    while (cursor < text.length && text[cursor] !== "<") {
      if (text.startsWith("\n\n", cursor)) return undefined;
      cursor++;
    }
    if (cursor > at) return undefined;
  }
};
/**
 * A model-format role tag written bare as text: `<system>`, `<|user|>`, `</assistant>`. Some templates emit it without the
 * sentinel spelling `stripSentinels` knows.
 */
const ROLE = /^<\/?\|?(?:system|user|assistant|model|tool|developer|ipython)\|?(?:\s[^<>]{0,120})?>/i;

/** The line `at` is on, from the line starts. */
const lineOf = (starts: number[], at: number) => {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= at) lo = mid; else hi = mid - 1; }
  return lo;
};
/**
 * A reply's body without model-format markup at its edges: the chat-template headers and sentinels (`stripSentinels`' own
 * policy), a bare opening role tag, and a trailing run of tool-call tags, opening or closing, with a half-written one at the
 * very end. A marker the reply shows on purpose stays: escaped, inside a fenced code block, or the whole of a blockquote line.
 * The fences are read before anything is cut, so a marker that was inside one keeps that fence's protection even once the
 * text after it is gone. A body that was only markup comes back empty, so its dispatcher posts no reply, as at jobs.ts's
 * stored last message. Each edge is walked to its end, so a long reply or a long run of tags costs its own length.
 */
export function sanitizeReply(text: string): string {
  let from = 0, to = text.length;
  const starts = lineStarts(text);
  const fenced = fenceState(text, starts);
  const line = (at: number) => lineOf(starts, at);
  const keeps = (at: number, end: number, limit: number) => text[at - 1] === "\\" || fenced[line(at)] || quoted(text, at, end, Math.max(starts[line(at)]!, from), limit);
  for (;;) {
    const at = skipStart(text, from, to);
    const after = afterHeader(text, at, to);
    const sentinel = after !== undefined ? undefined : SENTINELS.find((s) => text.startsWith(s, at) && text[at - 1] !== "\\");
    const reach = after ?? sentinel?.length;
    if (reach !== undefined) {
      if (keeps(at, at + reach, to)) break;
      from = at + reach;
      continue;
    }
    const role = ROLE.exec(text.slice(at, Math.min(to, at + 160)))?.[0].length ?? 0;
    if (!role || keeps(at, at + role, to)) break;
    from = at + role;
  }
  for (;;) {
    const end = skipEnd(text, from, to);
    const head = beforeHeader(text, from, end);
    if (head !== undefined) {
      if (keeps(head, end, to)) break;
      to = head;
      continue;
    }
    const sentinel = SENTINELS.find((s) => end - s.length >= from && text.startsWith(s, end - s.length) && text[end - s.length - 1] !== "\\");
    // A whole call element at the edge goes with its payload, not just its closing tag; otherwise the tag run is stripped.
    const start = sentinel ? end - sentinel.length : toolBlockEndingAt(text, from, end, fenced, starts) ?? toolTagEndingAt(text, from, end);
    if (start === undefined || keeps(start, end, to)) break;
    to = start;
  }
  return text.slice(skipStart(text, from, to), skipEnd(text, from, to));
}
