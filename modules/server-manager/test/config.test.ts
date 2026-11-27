// settings.servers_machines as the service, the page and the validate hook read it (spec §9): an entry's defaults, the shape each
// field must keep, and a bad entry never reaching a run. Names here are stand-ins; the module holds no address, user or key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryProblems, listProblems, machinesUsingKey, readMachines, withDefaults, DEFAULTS } from "../service/src/config.ts";

const entry = { name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" };

test("a minimal entry takes every default: four fields are all a new machine needs", () => {
  const { machines, problems } = readMachines(JSON.stringify([entry]));
  assert.deepEqual(problems, []);
  assert.equal(machines.length, 1);
  assert.deepEqual(machines[0], { ...DEFAULTS, ...entry });
  assert.deepEqual([machines[0]!.port, machines[0]!.enabled, machines[0]!.security_minutes, machines[0]!.reboot_policy, machines[0]!.quiet_start, machines[0]!.quiet_end], [22, true, 60, "auto", "03:00", "05:00"]);
});

test("an entry carrying its own values keeps them", () => {
  const { machines, problems } = readMachines(JSON.stringify([{ ...entry, port: 2222, enabled: false, security_minutes: 120, weekly_day: "fri", weekly_time: "04:30", reboot_policy: "ask", quiet_start: "23:00", quiet_end: "01:00", expected_fingerprint: `SHA256:${"a".repeat(43)}` }]));
  assert.deepEqual(problems, []);
  assert.deepEqual([machines[0]!.port, machines[0]!.enabled, machines[0]!.reboot_policy, machines[0]!.quiet_start, machines[0]!.quiet_end], [2222, false, "ask", "23:00", "01:00"]);
});

test("each field's shape is checked, and the error names the entry and the field", () => {
  const problems = entryProblems({ ...entry, name: "VM One", port: 0, address: "user@vm/one", user: "1x", key: "k k", security_minutes: 5, weekly_day: "funday", reboot_policy: "maybe", quiet_start: "3am", expected_fingerprint: "md5" }, "servers_machines[2]");
  const fields = problems.map((p) => p.field);
  for (const f of ["name", "port", "address", "user", "key", "security_minutes", "weekly_day", "reboot_policy", "quiet_start", "expected_fingerprint"]) assert.ok(fields.includes(`servers_machines[2].${f}`), `expected a problem on ${f}, got ${fields.join(", ")}`);
});

test("an unknown field, a missing required field and a name listed twice are each refused", () => {
  assert.ok(entryProblems({ ...entry, nope: 1 }, "x").some((p) => p.field === "x.nope"));
  assert.ok(entryProblems({ name: "vm-one", address: "vm-one", user: "user" }, "x").some((p) => p.field === "x.key"));
  const problems = listProblems([entry, { ...entry, address: "vm-one-b" }]);
  assert.ok(problems.some((p) => p.field === "servers_machines[1].name" && /twice/.test(p.message)));
});

test("a list that isn't JSON reads as no machines, with the reason", () => {
  assert.deepEqual(readMachines("[]").machines, []);
  const bad = readMachines("{not json");
  assert.deepEqual(bad.machines, []);
  assert.deepEqual(bad.problems.map((p) => p.field), ["servers_machines"]);
});

test("a bad entry is left out whole: a run never acts on a machine the list got wrong", () => {
  const { machines, problems } = readMachines(JSON.stringify([entry, { ...entry, name: "vm-two", port: 70000 }]));
  assert.deepEqual(machines.map((m) => m.name), ["vm-one"]);
  assert.ok(problems.some((p) => p.field === "servers_machines[1].port"));
});

test("machinesUsingKey names every machine that still signs in with a key", () => {
  assert.deepEqual(machinesUsingKey([entry, { ...entry, name: "vm-two" }, { ...entry, name: "vm-three", key: "other" }], "vm-one-key"), ["vm-one", "vm-two"]);
  assert.deepEqual(machinesUsingKey([entry], "other"), []);
});

test("withDefaults keeps what the entry sets over the default", () => {
  assert.equal(withDefaults({ ...entry, port: 2200 }).port, 2200);
});
