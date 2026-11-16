import { test } from "node:test";
import { join } from "node:path";
import { engineKit } from "../../../kernel/sdk/src/kit.ts";

test("engine-opencode passes the engine@1 kit", async () => {
  await engineKit(join(import.meta.dirname, ".."), { PATH: `${join(import.meta.dirname, "bin")}:${process.env.PATH}` });
});
