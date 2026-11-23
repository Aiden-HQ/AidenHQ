// Replace as one transaction (spec §5.7.1): virtual capabilities, conflicts, and the refusal of any dangling binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { danglingBindings } from "../compiler/bindings.ts";

const engine = (kind, extra = {}) => ({ provides: ["engine"], providers: { engine: [{ kind, bin: "bin/run" }] }, ...extra });
const user = { requires: ["engine"], agents: { builder: { engine: "alpha", connections: { crm: "read" }, jobcaps: ["crm-read"], roles: ["acme-crm.editor"] } } };
const crm = { connections: { crm: { tools: { read: ["r"], write: [] } } }, jobcaps: [{ id: "crm-read" }], roles: { declares: [{ id: "acme-crm.editor" }] } };

test("A13: replacing A with B leaves a binding unprovided → refused, naming who holds it", () => {
  const ok = { user, "engine-a": engine("alpha"), "acme-crm": crm };
  const without = (name, patch = {}) => { const e = { ...ok, ...patch }; delete e[name]; return e; };
  const cases = [
    ["agent engine", without("engine-a", { "engine-b": engine("beta") }), "agent builder", "engine alpha"],
    ["agent connections", without("acme-crm", { "acme-crm2": { ...crm, connections: {} } }), "agent builder", "connection crm"],
    ["agent jobcaps", without("acme-crm", { "acme-crm2": { ...crm, jobcaps: [] } }), "agent builder", "jobcap crm-read"],
    ["agent roles", without("acme-crm", { "acme-crm2": { ...crm, roles: {} } }), "agent builder", "role acme-crm.editor"],
    ["roles.requests", { ...ok, "acme-x": { roles: { requests: ["acme-y.admin"] } } }, "module acme-x", "role acme-y.admin"],
    ["services.grants", { ...ok, "acme-x": { services: { grants: { gone: "read" } } } }, "module acme-x", "connection gone"],
    ["services.run.join", { ...ok, "acme-x": { services: { run: { s: { join: ["acme-db"] } } } } }, "module acme-x", "module acme-db"],
    ["workspaces.share_with", { ...ok, "acme-x": { workspaces: { share_with: ["acme-db"] } } }, "module acme-x", "module acme-db"],
    ["requires", without("engine-a"), "module user", "engine"],
  ];
  for (const [binding, enabled, owner, missing] of cases) assert.deepEqual(danglingBindings(enabled, {}).filter((d) => d.binding === binding), [{ binding, owner, missing }], binding);
  // Optional grants (`?`) are allowed to be missing; the kernel's roles need no declaring module, every other role does.
  assert.deepEqual(danglingBindings({ "acme-x": { agents: { a: { connections: { "gone?": "read" }, jobcaps: ["gone?"], roles: ["kernel.audit"] } } } }, {}), []);
  assert.deepEqual(danglingBindings({ "acme-x": { agents: { a: { roles: ["fleet-read"] } } } }, {}), [{ binding: "agent roles", owner: "agent a", missing: "role fleet-read" }]);
  // The instance's own bindings: its reviewer and its write floor raises.
  const inst = danglingBindings(ok, { reviewer: { primary: "acme-crm" }, writes: { "acme-crm.publish": { floor: 2 } } });
  assert.deepEqual(inst.map((d) => d.binding), ["instance reviewer", "instance writes"]);
  assert.deepEqual(danglingBindings({ ...ok, "acme-crm": { ...crm, writes: { publish: { floor: 1 } }, providers: { reviewer: { url: "http://r:1/" } } } }, { reviewer: { primary: "acme-crm" }, writes: { "acme-crm.publish": { floor: 2 } } }), []);
});
