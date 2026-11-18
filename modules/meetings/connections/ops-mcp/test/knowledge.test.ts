import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeBases } from "../src/knowledge/knowledge.js";
import { UserFacingError } from "../src/util/errors.js";

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeBases() {
  const dir = mkdtempSync(join(tmpdir(), "ops-mcp-knowledge-"));
  const root = join(dir, "knowledge");
  const agg = join(root, "protocol-docs");
  put(join(agg, "README.md"), "# AggBrain\nStart here.");
  put(join(agg, "glossary.md"), "Global Exit Root: the root of exit roots.");
  put(
    join(agg, "acmenet", "pessimistic-proof.md"),
    "---\ntitle: Pessimistic Proof\nstatus: stable\nsummary: >\n  The financial firewall.\n---\nThe pessimistic proof checks balances.\nProof proof proof.\n",
  );
  put(join(agg, ".agents", "skills", "protocol-docs", "SKILL.md"), "---\nname: protocol-docs\ndescription: Use for AcmeNet and CDK.\n---\n\n# AggBrain\n\nRead README.md first.\n");
  put(join(agg, ".git", "HEAD.md"), "pessimistic secret");
  put(join(root, "wallet-docs", "v3", "sessions.md"), "---\ntitle: Sessions\n---\nSession keys and the pessimistic word once.\n");
  writeFileSync(join(dir, "outside.md"), "outside the base");
  return { dir, root, agg, kb: new KnowledgeBases({ root, max_search_results: 15 }) };
}

describe("knowledge bases", () => {
  it("searches every word across bases, best match first", () => {
    const { kb } = makeBases();
    const hits = kb.search("pessimistic proof");
    expect(hits.map((h) => `${h.base}/${h.path}`)).toEqual(["protocol-docs/acmenet/pessimistic-proof.md"]);
    expect(hits[0]!.matches[0]).toEqual({ line: 2, text: "title: Pessimistic Proof" });
    expect(kb.search("pessimistic").map((h) => h.base)).toEqual(["protocol-docs", "wallet-docs"]);
    expect(kb.search("pessimistic", "wallet-docs").map((h) => h.path)).toEqual(["v3/sessions.md"]);
  });

  it("reads only .md documents inside the base", () => {
    const { kb, agg, dir } = makeBases();
    expect(kb.read("protocol-docs", "acmenet/pessimistic-proof.md").content).toContain("checks balances");
    expect(() => kb.read("protocol-docs", "../outside.md")).toThrow(UserFacingError);
    expect(() => kb.read("protocol-docs", "../wallet-docs/v3/sessions.md")).toThrow(UserFacingError);
    expect(() => kb.read("protocol-docs", ".agents/skills/protocol-docs/SKILL.md")).toThrow(UserFacingError);
    expect(() => kb.read("protocol-docs", "/etc/passwd")).toThrow(UserFacingError);
    expect(() => kb.read("protocol-docs", "acmenet")).toThrow(UserFacingError);
    symlinkSync(join(dir, "outside.md"), join(agg, "escape.md"));
    expect(() => kb.read("protocol-docs", "escape.md")).toThrow(UserFacingError);
  });

  it("refuses unknown bases and works with none mounted", () => {
    const { kb, root } = makeBases();
    expect(() => kb.index("nope")).toThrow(/Unknown knowledge base "nope" \(available: protocol-docs, wallet-docs\)/);
    expect(() => kb.read("..", "README.md")).toThrow(UserFacingError);
    const empty = new KnowledgeBases({ root: join(root, "missing"), max_search_results: 15 });
    expect(empty.list()).toEqual([]);
    expect(empty.search("exit root")).toEqual([]);
  });
});
