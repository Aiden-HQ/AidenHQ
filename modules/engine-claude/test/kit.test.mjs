import { test } from "node:test";
import { join } from "node:path";
import { engineKit } from "../../../kernel/sdk/src/kit.ts";

test("engine-claude passes the engine@1 kit: a comment while it works gets a turn", async () => {
  await engineKit(join(import.meta.dirname, ".."), { PATH: `${join(import.meta.dirname, "bin")}:${process.env.PATH}` });
});
