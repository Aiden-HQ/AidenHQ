// WOR-8736: a close note that cites a PR only as "PR #N" is not read as a citation by the grader (its parser accepts
// owner/name#number or a full /pull/ URL only), so WOR-8689 closed Aiden-HQ/AidenHQ#797 with the live fix and still
// graded as uncited. The handbook bullet carries the form; the github-mcp close path refuses a bare one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const handbook = readFileSync(new URL("../agents/maintainer/AGENTS.md", import.meta.url), "utf8");

test("the github_app_issue_state bullet states the citation form", () => {
  const bullet = handbook.slice(handbook.indexOf("- `github_app_issue_state`"));
  const text = bullet.slice(0, bullet.indexOf("\n\n")).replace(/\s+/g, " ");
  assert.match(text, /Write each PR as `owner\/name#number`/, "names owner/name#number");
  assert.match(text, /full `https:\/\/github\.com\/owner\/name\/pull\/N` URL/, "names the full /pull/ URL");
  assert.match(text, /never as a bare `PR #N`/, "rules out the bare form");
  assert.match(text, /the grader's citation parser/, "says why");
});
