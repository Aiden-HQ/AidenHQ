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
/** A fenced code block's opening or closing line: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^ {0,3}(?:```|~~~)/;
/** Which lines open inside a fenced code block: the block's own text is the reply's, so a marker there stays. */
const fenceState = (text: string, starts: number[]) => {
  const inside = new Array<boolean>(starts.length);
  let open = false;
  for (let i = 0; i < starts.length; i++) {
    inside[i] = open;
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : text.length;
    if (FENCE.test(text.slice(starts[i]!, end))) open = !open;
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
 * DeepSeek's DSML tag, which writes tool-call markup as text: its separators are fullwidth bars (U+FF5C), so its tags are
 * spelled with them instead of the usual attribute punctuation. One tag, one element.
 */
const DSML = /<\uff5cDSML\uff5c>/;
/** A stray tool-call element's complete tag: `<invoke>`, `</parameter>`, `<function_calls>` (attributes allowed). */
const ELEMENT = /<\/?(?:invoke|parameter|function_calls)\b[^>]*>/;
/** Whether `text` carries raw tool-call markup: the task tools refuse such an argument, and a reply's body is stripped of it. */
export const hasToolMarkup = (text: string) => DSML.test(text) || ELEMENT.test(text);
/** A tool-call element's name: DSML's own spelling (after its leading bars), or a bare invoke/parameter/function_calls. */
const TOOL_NAME = /^\/?[\uff5c|]*(?:DSML[^\s<>]*|invoke|parameter|function_calls)(?=[\s/>]|$)/i;
/** Attributes a model writes inside a tag: `name="x"`, `name='x'`, and the same cut before its closing quote. */
const ATTRIBUTES = /^(?:\s+[^\s=<>]+\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s"'<>]*))*\s*$/;
/**
 * Where the tool-call markup that ends exactly at `end` starts, or undefined: a complete tag ("</invoke>"), an opening tag
 * cut short with its attributes ("<invoke name=\"x\""), or a name cut short ("<DSM"). A tag never spans a line.
 */
const toolTagEndingAt = (text: string, from: number, end: number) => {
  let at = text.lastIndexOf("<", end - 1);
  let frag = at < from ? "" : text.slice(at + 1, end);
  // Only a tag's own characters may sit between its `<` and the edge; a line break or `<` between means the tag ended before,
  // and the rest is prose.
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
  // A name cut short is the start of one ("<DSM"): never a bare `<`.
  const bare = frag.replace(/^\//, "").replace(/^[\uff5c|]+/, "").toLowerCase();
  const names = ["dsml", "invoke", "parameter", "function_calls"];
  return /^[a-z0-9_]+$/.test(bare) && names.some((n) => n.startsWith(bare)) ? at : undefined;
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
 * A reply's body without model-format markup at its edges: `stripSentinels` first, then a bare role tag at the opening edge and
 * a trailing run of tool-call tags, opening or closing, with a half-written one at the very end. A marker the reply shows on
 * purpose stays, exactly as `stripSentinels` has it: escaped, inside a fenced code block, or the whole of a blockquote line.
 * A body that was only markup comes back empty, so its dispatcher posts no reply, as at jobs.ts's stored last message.
 */
export function sanitizeReply(text: string): string {
  for (let body = stripSentinels(text); ;) {
    let from = 0, to = body.length;
    const starts = lineStarts(body);
    const fenced = fenceState(body, starts);
    let changed = false;
    // Each edge is walked to its end before the text is cut, so a long run of tags costs its own length.
    for (;;) {
      const at = skipStart(body, from, to);
      const tag = ROLE.exec(body.slice(at, Math.min(to, at + 160)))?.[0].length ?? 0;
      if (!tag) break;
      const line = lineOf(starts, at);
      if (body[at - 1] === "\\" || fenced[line] || quoted(body, at, at + tag, Math.max(starts[line]!, from), to)) break;
      from = at + tag;
      changed = true;
    }
    for (;;) {
      const end = skipEnd(body, from, to);
      const start = toolTagEndingAt(body, from, end);
      if (start === undefined || body[start - 1] === "\\") break;
      const line = lineOf(starts, start);
      if (fenced[line] || quoted(body, start, end, Math.max(starts[line]!, from), to)) break;
      to = start;
      changed = true;
    }
    const cut = body.slice(skipStart(body, from, to), skipEnd(body, from, to));
    // Removing one piece can expose another at the other edge (a sentinel behind a tool tag): settle both again.
    const next = changed ? stripSentinels(cut) : cut;
    if (next === body) return next;
    body = next;
  }
}
