import { expect, it } from "vitest";
import { isModule } from "../src/module-caller.js";

const kernel = (who: object | undefined, status = 200) => (async (url: URL | string, init?: RequestInit) => {
  expect(String(url)).toBe("http://kernel/v1/whoami");
  expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  return new Response(JSON.stringify(who ?? {}), { status });
}) as typeof fetch;

it("opens the issue read to the named module's own token and nobody else; a kernel that can't answer is unknown", async () => {
  expect(await isModule("http://kernel", "Bearer tok", "maintainer", kernel({ kind: "module", module: "maintainer" }))).toBe(true);
  expect(await isModule("http://kernel", "Bearer tok", "maintainer", kernel({ kind: "module", module: "grading" }))).toBe(false);
  expect(await isModule("http://kernel", "Bearer tok", "maintainer", kernel({ kind: "job", module: "maintainer" }))).toBe(false);
  expect(await isModule("http://kernel", "Bearer tok", "maintainer", kernel({}, 401))).toBe(false);
  expect(await isModule("http://kernel", "", "maintainer", kernel({ kind: "module", module: "maintainer" }))).toBe(false);
  // The kernel couldn't answer (down, restarting, a 5xx): unknown, which the routes answer 503, never a refusal.
  expect(await isModule("http://kernel", "Bearer tok", "maintainer", (async () => { throw new Error("down"); }) as typeof fetch)).toBe(undefined);
  expect(await isModule("http://kernel", "Bearer tok", "maintainer", kernel({}, 502))).toBe(undefined);
});
