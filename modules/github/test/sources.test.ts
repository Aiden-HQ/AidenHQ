// The owner-approved source exceptions a change's review reads (sources.ts): from each base, owner records only, each tied to
// its repo and base; a file that can't be read is no records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCardSourceExceptions } from "../service/src/sources.ts";

test("source records come from each base, only the owner's, each tied to its repo and base; unread is none", async () => {
  const files = {
    "acme/app main": `- { package: left-pad, to: "git+https://example.com/left-pad.git", approved_by: owner }\n- { package: right-pad, to: "https://example.com/r.tgz", approved_by: agent }\n`,
  };
  const read = async (repo, base) => { const t = files[`${repo} ${base}`]; if (t === undefined) throw new Error("no such file"); return t; };
  const s = await readCardSourceExceptions([{ repo: "acme/app", base: "main" }, { repo: "acme/api", base: "main" }, { repo: "acme/new", base: "" }], read);
  assert.equal(s.where, "acme/app main .github/supply-chain-source-exceptions.yaml; acme/api main .github/supply-chain-source-exceptions.yaml");
  assert.deepEqual(s.records, [{ package: "left-pad", to: "git+https://example.com/left-pad.git", approved_by: "owner", repo: "acme/app", base: "main" }]);
  assert.equal(await readCardSourceExceptions([], read), undefined);
});
