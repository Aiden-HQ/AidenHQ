import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { TRUST_ROLES } from "../src/aidenhq-sdk/maintained-repos.js";

const manifest = readFileSync(join(import.meta.dirname, "..", "..", "..", "module.yaml"), "utf8");
const MAINTAINER_READS = ["github_issue_list", "github_label_events", "github_repo_tree", "github_repo_file"];
const MAINTAINER_WRITES = ["github_issue_comment", "github_issue_label", "github_issue_state"];

// The manifest's groups, without the comments that name tools in prose.
const grants = manifest.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const group = (key: string) => (new RegExp(`^\\s+${key}: \\[([^\\]]*)\\]`, "m").exec(grants)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
// What the product's compiler makes of them: `named` narrows a read out of the read shorthand, and a named tool must also be
// a read (scripts/modules.ts:63 `readTools`, :641). So a tool tagged named is listed to read, never granted by it.
const readShorthand = group("read").filter((t) => !group("named").includes(t));
const writeShorthand = [...readShorthand, ...group("write")];

it("the Maintainer's reads are named reads, and no shorthand grant reaches any of the seven tools", () => {
  for (const tool of MAINTAINER_READS) {
    expect(group("read")).toContain(tool);
    expect(group("named")).toContain(tool);
  }
  for (const tool of [...MAINTAINER_READS, ...MAINTAINER_WRITES]) {
    expect(readShorthand).not.toContain(tool);
    expect(writeShorthand).not.toContain(tool);
  }
  // The three writes are destructive: a grant must name them.
  for (const tool of MAINTAINER_WRITES) expect(group("destructive")).toContain(tool);
});

it("a repo's trusted roles come from a fixed set in code, never wider than write", () => {
  expect(TRUST_ROLES).toEqual(["admin", "maintain", "write"]);
  expect(manifest).not.toMatch(/maintainer_trusted_permissions/);
});

// The maintainer module's github grants, as text (this package has no YAML dependency, and the list may wrap lines).
const maintainer = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "maintainer", "module.yaml"), "utf8");
const maintainerGrant = /github\?: \[([\s\S]*?)\]/.exec(maintainer)?.[1] ?? "";
const maintainerTools = maintainerGrant.split(",").map((t) => t.trim()).filter(Boolean);

// The compile contract: every tool the Maintainer names must exist here, the four reads and three writes among them, and
// nothing else (no shorthand grant, so no github_pr_review or another module's tool).
it("the maintainer module grants only tools this manifest declares, the four named reads and three writes among them", () => {
  const declared = new Set([...group("read"), ...group("write"), ...group("destructive")]);
  for (const tool of maintainerTools) expect(declared, `${tool} is granted but not declared`).toContain(tool);
  for (const tool of [...MAINTAINER_READS, ...MAINTAINER_WRITES]) expect(maintainerTools).toContain(tool);
  expect(maintainerTools).not.toContain("github_pr_review");
});
