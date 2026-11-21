import { expect, it } from "vitest";
import { isModule, reportNeed } from "../src/module-caller.js";
import { createAccess } from "../src/client.js";

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

it("an org that restricts OAuth apps is told to the kernel as a restricted need for that org", async () => {
  const auth = { headers: async () => ({ authorization: "Bearer gho_owner" }), refresh: async () => {}, status: () => ({ state: "ok" as const, since: "" }), mark: () => {}, signedIn: () => true };
  const refusal = async () => new Response(JSON.stringify({ message: "Although you appear to have the correct authorization credentials, the `0xPolygon` organization has enabled OAuth App access restrictions" }), { status: 403 });
  const err = await createAccess({ auth, clientId: "cid", fetchImpl: refusal as typeof fetch }).rest("POST", "/repos/0xPolygon/primer/pulls/1/reviews", {}).catch((e) => e);
  let sent: { url: string; body: any } | undefined;
  await reportNeed("http://kernel", "key", err, (async (url: URL, init: RequestInit) => ((sent = { url: String(url), body: JSON.parse(String(init.body)) }), new Response("{}"))) as typeof fetch);
  expect(sent?.url).toBe("http://kernel/v1/connections/need");
  expect(sent?.body).toEqual({ connection: "github", need: { cause: "restricted", org: "0xPolygon", url: "https://github.com/settings/connections/applications/cid", detail: expect.stringContaining("0xPolygon organization restricts OAuth apps") } });
});
