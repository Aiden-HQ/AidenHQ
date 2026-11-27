// The module's validate hook (spec §7, §9): a settings change is checked entry by entry, and a clear of one key of the servers_keys
// map is refused while a machine still names it. A key's VALUE never reaches this function's answers; a clear carries only the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../service/src/validate.ts";

const entry = { name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" };
const settings = (machines: unknown) => ({ servers_machines: machines });

test("a good list and a good key clear pass", () => {
  assert.deepEqual(validate({ settings: settings([entry]) }), { ok: true });
  // A clear of a key no machine names is allowed.
  assert.deepEqual(validate({ settings: settings([entry]), secret: { name: "servers_keys" }, key: "unused" }), { ok: true });
  // A written value (a set or a replace) is left to the kernel's own caps and pattern.
  assert.deepEqual(validate({ settings: settings([entry]), secret: { name: "servers_keys" }, value: "x" }), { ok: true });
});

test("a settings change that carries a bad entry is refused, naming the entry and its field", () => {
  const r = validate({ settings: settings([entry, { ...entry, name: "vm-two", port: 0 }]) });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errors[0]!.field, "servers_machines[1].port");
});

test("a clear of a key a machine still names is refused, and the message names the machines", () => {
  const r = validate({ settings: settings([entry, { ...entry, name: "vm-two" }]), secret: { name: "servers_keys" }, key: "vm-one-key" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.errors[0]!.message, /vm-one, vm-two/);
  assert.match(r.errors[0]!.message, /still used/);
});

test("a clear with no machine naming the key is allowed even where the list is empty", () => {
  assert.deepEqual(validate({ settings: settings([]), secret: { name: "servers_keys" }, key: "vm-one-key" }), { ok: true });
  assert.deepEqual(validate({ secret: { name: "servers_keys" }, key: "vm-one-key" }), { ok: true });
});

test("another secret's clear is not this hook's to judge", () => {
  assert.deepEqual(validate({ settings: settings([entry]), secret: { name: "something_else" }, key: "vm-one-key" }), { ok: true });
});

test("an entry's key is judged by its pattern too: a clear is keyed by name, never by a value", () => {
  // A key name with characters the vault does not allow is a bad entry, refused with the rest.
  const r = validate({ settings: settings([{ ...entry, key: "not a key" }]) });
  assert.equal(r.ok, false);
});
