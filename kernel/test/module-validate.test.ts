import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createResolver } from "../src/net.ts";
import { createModuleValidate } from "../src/module-validate.ts";

test("a module's validate hook refuses a value with its field's error; in observe mode the value goes ahead with a gate.would_block fact; a hook that can't answer doesn't block", async (t) => {
  const seen: { auth?: string; body: any }[] = [];
  let reply: unknown = { ok: false, errors: [{ field: "host", message: "that host isn't reachable" }] };
  const hook = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(200, { "content-type": "application/json" }).end(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  t.after(() => hook.close());
  const url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/validate`;
  const facts = openFacts(new DatabaseSync(":memory:"));
  let table: Record<string, any> = { "acme.validate": { module: "acme", at: "validate", url, auth_secret: "acme_key" } };
  const validate = createModuleValidate({ registry: () => table, secret: () => "k", resolver: createResolver(), facts });

  // Enforcing: the refusal comes back as the field's error; a secret's value reaches only its module, in its own field.
  assert.deepEqual(await validate("acme", { settings: { host: "nope" } }), { ok: false, errors: [{ field: "host", message: "that host isn't reachable" }] });
  assert.deepEqual(seen[0], { auth: "Bearer k", body: { settings: { host: "nope" } } });
  await validate("acme", { secret: { name: "acme_token", value: "s3cret" } });
  assert.deepEqual(seen[1]!.body, { secret: { name: "acme_token" }, value: "s3cret" });
  assert.deepEqual(await validate("other", { settings: { host: "x" } }), { ok: true });

  // Observing: the same refusal is only recorded, and the value goes ahead.
  table = { "acme.validate": { ...table["acme.validate"], mode: "observe" } };
  assert.deepEqual(await validate("acme", { settings: { host: "nope" } }), { ok: true });
  const rows = facts.since(0).filter((f) => f.type === "gate.would_block");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.data, { gate: "acme.validate", module: "acme", verdict: "deny", errors: [{ field: "host", message: "that host isn't reachable" }] });
  assert.equal(JSON.stringify(rows).includes("s3cret"), false);

  // A hook that answers nonsense can't check: the value isn't blocked, and the answer says so.
  reply = "not json";
  const unchecked = await validate("acme", { settings: { host: "x" } });
  assert.equal(unchecked.ok, true);
  assert.match((unchecked as { unchecked?: string }).unchecked ?? "", /couldn't check this/);
});
