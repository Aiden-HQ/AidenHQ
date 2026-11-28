// Agent markdown -> Telegram text entities (what TDLib's formattedText takes; offsets in UTF-16 units). The one small subset
// agents write: **bold**, _italic_, `code`, [text](url), "- " bullets, "> " quotes, blank-line paragraphs. Headers become bold
// lines and tables become plain lines; nothing else is interpreted, so unsupported markup reads as clean text.
type Entity = { _: "textEntity"; offset: number; length: number; type: Record<string, unknown> };
type Out = { text: string; entities: Entity[] };

// A link's url may hold one level of balanced parentheses (Wikipedia's `Mercury_(planet)`).
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/gu;

const shift = (es: Entity[], by: number): Entity[] => es.map((e) => ({ ...e, offset: e.offset + by }));

function inline(src: string): Out {
  let text = "";
  const entities: Entity[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    text += src.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      entities.push({ _: "textEntity", offset: text.length, length: m[1].length, type: { _: "textEntityTypeCode" } });
      text += m[1];
      continue;
    }
    const inner = inline(m[2] ?? m[3] ?? m[4]!);
    const type = m[2] !== undefined ? { _: "textEntityTypeBold" } : m[3] !== undefined ? { _: "textEntityTypeItalic" } : { _: "textEntityTypeTextUrl", url: m[5] };
    entities.push({ _: "textEntity", offset: text.length, length: inner.text.length, type }, ...shift(inner.entities, text.length));
    text += inner.text;
  }
  return { text: text + src.slice(last), entities };
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

export function renderTelegram(markdown: string): Out {
  let text = "";
  const entities: Entity[] = [];
  const add = (o: Out) => { entities.push(...shift(o.entities, text.length)); text += o.text; };
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const emit = (line: string, wrap?: Record<string, unknown>) => {
    const start = text.length;
    add(inline(line));
    if (wrap) entities.push({ _: "textEntity", offset: start, length: text.length - start, type: wrap });
    text += "\n";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      const start = text.length;
      text += body.join("\n");
      if (text.length > start) entities.push({ _: "textEntity", offset: start, length: text.length - start, type: { _: "textEntityTypePre" } });
      text += "\n";
    } else if (/^\s*>/.test(line)) {
      const start = text.length;
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) emit(lines[i]!.replace(/^\s*>[ \t]?/, ""));
      i--;
      entities.push({ _: "textEntity", offset: start, length: text.length - 1 - start, type: { _: "textEntityTypeBlockQuote" } });
    } else if (TABLE_ROW.test(line)) {
      if (!TABLE_RULE.test(line)) emit(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · "));
    } else if (/^\s{0,3}#{1,6}[ \t]+/.test(line)) emit(line.replace(/^\s*#{1,6}[ \t]+/, "").replace(/[ \t]+#*$/, ""), { _: "textEntityTypeBold" });
    else if (/^\s*[-*][ \t]+/.test(line)) emit(line.replace(/^(\s*)[-*][ \t]+/, "$1• "));
    else emit(line);
  }
  // Trim the final newline and collapse runs of blank lines to one; entity offsets are fixed up by the same edits.
  return tidy(text, entities);
}

function tidy(text: string, entities: Entity[]): Out {
  // Drop positions: every char at index i is kept unless it is a newline that would make 3+ in a row, or trailing/leading.
  const keep: boolean[] = [];
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    run = text[i] === "\n" ? run + 1 : 0;
    keep.push(!(text[i] === "\n" && (run > 2 || i === 0 || /^\n*$/.test(text.slice(i)))));
  }
  const map: number[] = [0];
  for (let i = 0; i < text.length; i++) map.push(map[i]! + (keep[i] ? 1 : 0));
  const out = text.split("").filter((_, i) => keep[i]).join("");
  return {
    text: out,
    entities: entities
      .map((e) => ({ ...e, offset: map[e.offset]!, length: map[e.offset + e.length]! - map[e.offset]! }))
      .filter((e) => e.length > 0)
      .sort((a, b) => a.offset - b.offset || b.length - a.length),
  };
}
