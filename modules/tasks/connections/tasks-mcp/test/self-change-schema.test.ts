// self_change's declared input schema, as `tools/list` serves it: a client that validates against it must keep a routine_def's
// routine fields (title, description, schedules, concurrency, model, event), never strip them to `routine: {}`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rpc } from "./helpers.ts";

const ROUTINE_FIELDS = ["title", "description", "schedules", "concurrency", "model", "event"];

async function selfChangeChange() {
  const tools = (await rpc({ method: "tools/list" })).json.result.tools;
  const tool = tools.find((t) => t.name === "self_change");
  assert.ok(tool, "self_change is listed");
  const changes = tool.inputSchema.properties.changes;
  assert.equal(changes.type, "array");
  return changes.items;
}

test("self_change's routine declares its fields, so a schema-validating client keeps them", async () => {
  const change = await selfChangeChange();
  const routine = change.properties.routine;
  assert.equal(routine.type, "object");
  assert.deepEqual(Object.keys(routine.properties).sort(), [...ROUTINE_FIELDS].sort(), "title, description, schedules, concurrency, model and event are declared");
  assert.equal(routine.additionalProperties, false);
  for (const f of ["title", "description", "model", "concurrency"]) assert.equal(routine.properties[f].type, "string", `routine.${f} is a string`);
  const schedules = routine.properties.schedules;
  assert.equal(schedules.type, "array");
  assert.equal(schedules.maxItems, 1, "at most one schedule");
  assert.equal(schedules.items.type, "object");
  assert.deepEqual(Object.keys(schedules.items.properties).sort(), ["cron", "label"]);
  assert.deepEqual(schedules.items.required, ["cron"]);
  assert.equal(schedules.items.additionalProperties, false);
  const event = routine.properties.event;
  assert.equal(event.type, "object");
  assert.deepEqual([...event.required].sort(), ["connection", "filter", "resource"]);
  assert.equal(event.additionalProperties, false);
  // The change's own top level keeps `text` and `key`, and only its declared fields.
  assert.equal(change.properties.text.type, "string");
  assert.equal(change.properties.key.type, "string");
  assert.equal(change.additionalProperties, false);
});

/**
 * What a client that validates against the declared schema and forwards only its properties sends: object fields the schema
 * doesn't declare are dropped (`additionalProperties: false`), one listed `anyOf` branch is picked, and arrays go item by item.
 * The defect was exactly this: `routine` declared no properties, so all of them were stripped to `{}`.
 */
function prune(value, schema) {
  if (Array.isArray(value)) return value.map((v) => prune(v, schema?.items ?? {}));
  if (value && typeof value === "object") {
    const props = schema?.properties ?? {};
    return Object.fromEntries(Object.entries(value).filter(([k]) => k in props).map(([k, v]) => [k, prune(v, props[k])]));
  }
  const branch = schema?.anyOf?.find((b) => (typeof value === "string" ? b.type === "string" : b.type === "array"));
  return value;
}

test("a routine_def change carrying a title and schedules survives the declared schema", async () => {
  const change = await selfChangeChange();
  const changeSchema = (await rpc({ method: "tools/list" })).json.result.tools.find((t) => t.name === "self_change").inputSchema.properties.changes.items;
  const sent = { kind: "routine_def", key: "sweep", routine: { title: "Sweep", description: "Sweep, then close this task.", schedules: [{ cron: "0 10 * * *", label: "daily" }] } };
  assert.deepEqual(prune(sent, changeSchema), sent, "no routine field is stripped");
  // The change's top level keeps `text` and `key`, and only the declared fields.
  assert.equal(change.properties.text.type, "string");
  assert.equal(change.properties.key.type, "string");
  assert.equal(change.additionalProperties, false);
  assert.ok(change.properties.kind.enum.includes("routine_def"));
  // An event routine (no schedules) survives too.
  const event = { kind: "routine_def", key: "watch", routine: { title: "Watch", description: "Act on each batch.", event: { connection: "slack", resource: "C1", filter: { kind: ["message"], bot: false } } } };
  assert.deepEqual(prune(event, changeSchema), event, "an event routine survives");
});
