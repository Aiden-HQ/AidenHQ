// The four subtle degradations of the `degraded` suite. Each runs inside the page (page.evaluate serialises it, so it
// closes over nothing), changes only elements in the captured viewport, and is seeded: the same page degrades the same way.
// `kind` is the answer key: scoring data, never part of a prompt.

export type Kind = "spacing" | "font-size" | "colour" | "alignment";

export const degradations: { kind: Kind; apply: (seed: number) => void }[] = [
  {
    // 2-4px jitter of padding and margin on about a third of the visible blocks
    kind: "spacing",
    apply(seed) {
      let s = seed >>> 0;
      const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      const visible = [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight; });
      for (const e of visible) {
        if (rnd() > 0.35) continue;
        const d = (rnd() < 0.5 ? -1 : 1) * (2 + Math.floor(rnd() * 3));
        const cs = getComputedStyle(e as Element);
        // vertical only: a sideways shift would read as a misalignment, a different degradation
        (e as HTMLElement).style.setProperty("padding-top", `${Math.max(0, parseFloat(cs.paddingTop) + d)}px`, "important");
        (e as HTMLElement).style.setProperty("margin-top", `${Math.max(0, parseFloat(cs.marginTop) + Math.abs(d))}px`, "important");
      }
    },
  },
  {
    // one font size the page does not use, on three visible text elements
    kind: "font-size",
    apply(seed) {
      const text = [...document.querySelectorAll("body *")].filter((e) => {
        const r = e.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === e || e.contains(top)) && r.width > 8 && r.height > 8 && r.top >= 0 && r.top < innerHeight && [...e.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim());
      });
      const used = new Set(text.map((e) => parseFloat(getComputedStyle(e).fontSize)));
      const size = [15, 17, 19, 13.5].find((n) => !used.has(n)) ?? 15.5;
      for (let i = 0; i < 3 && text.length; i++) (text[(seed + i * 7) % text.length] as HTMLElement).style.setProperty("font-size", `${size}px`, "important");
    },
  },
  {
    // one colour outside the page's palette, on three visible text elements
    kind: "colour",
    apply(seed) {
      const text = [...document.querySelectorAll("body *")].filter((e) => {
        const r = e.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === e || e.contains(top)) && r.width > 8 && r.height > 8 && r.top >= 0 && r.top < innerHeight && [...e.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim());
      });
      for (let i = 0; i < 3 && text.length; i++) (text[(seed + i * 5) % text.length] as HTMLElement).style.setProperty("color", "#c2410c", "important");
    },
  },
  {
    // two visible left-aligned blocks 2px off their column
    kind: "alignment",
    apply(seed) {
      const blocks = [...document.querySelectorAll("main h1, main p, main th:first-child, main td:first-child, main input, [role=dialog] h2, [role=dialog] p, [role=dialog] dt, [role=dialog] dd, [role=dialog] input")].filter((e) => {
        const r = e.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === e || e.contains(top)) && r.width > 8 && r.top >= 0 && r.top < innerHeight;
      });
      for (let i = 0; i < 2 && blocks.length; i++) {
        const e = blocks[(seed + i * 3) % blocks.length] as HTMLElement;
        e.style.setProperty("position", "relative", "important");
        e.style.setProperty("left", "2px", "important");
      }
    },
  },
];
