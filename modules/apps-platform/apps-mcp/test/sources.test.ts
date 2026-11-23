import { expect, it } from "vitest";
import { newRowsSql, sourceAck, sourceNew, warehouseQuery, type WarehouseDeps } from "../src/sources.js";

// The cursor belongs to the calling agent (its Paperclip id) and the read's filter, starts a day back, and moves only by
// source_ack. The SQL itself was smoke-run as the readonly login on postgres:17.
it("source_new / source_ack: per-agent, per-filter cursor, filters as parameters, baseline rows skipped by default", async () => {
  const cursors = new Map<string, string>();
  const sent: { text: string; values?: unknown[] }[] = [];
  const at = (v: unknown[], k: unknown) => cursors.get(`${v[0]}|${v[1]}|${k}`);
  const d: WarehouseDeps = {
    pool: {
      connect: async () => { throw new Error("unused"); },
      query: (async (text: string, values?: unknown[]) => {
        sent.push({ text, values });
        if (text.includes("max(seq) AS seq FROM")) return { rows: [{ seq: "42" }] };
        if (text.includes("src_meta.cursor")) return { rows: ["", values![2]].filter((k) => at(values!, k)).map((k) => ({ filter_key: k, seq: at(values!, k) })) };
        // As Postgres sends them: n = seq, r = the row's JSON text (null once the byte cap is reached).
        return { rows: [{ n: "41", r: JSON.stringify({ channel_id: "C1", text: "ship it", seq: 41 }) }, { n: "42", r: JSON.stringify({ channel_id: "C1", text: "shipped", seq: 42 }) }] };
      }) as any,
    },
    sql: async (_script, vars) => (cursors.set(`${vars.agent}|${vars.view}|${vars.key}`, vars.seq!), ""),
  };

  const first = await sourceNew(d, "agent-a", "src_slack.messages", { q: "ship" }, 2);
  expect(sent[2]!.text).toContain("ingested_at > now() - interval '1 day'");
  expect(sent[2]!.text).toContain("NOT baseline");
  expect(sent[2]!.values).toEqual(["ship", 2]);
  expect(first).toMatchObject({ cursor: expect.stringMatching(/^42\.[0-9a-f]{16}$/), more: true, rows: [{ seq: 41 }, { seq: 42 }] });

  await sourceAck(d, "agent-a", "src_slack.messages", first.cursor!);
  sent.length = 0;
  await sourceNew(d, "agent-a", "src_slack.messages", { q: " ship " }, 100); // the same filter resumes after its ack
  expect(sent[2]!.text).toContain("seq > $1");
  expect(sent[2]!.values).toEqual([42, " ship ", 100]);

  sent.length = 0;
  await sourceNew(d, "agent-a", "src_slack.messages", {}, 100); // the filtered ack didn't move the unfiltered cursor
  expect(sent[2]!.text).toContain("interval '1 day'");
  await sourceAck(d, "agent-a", "src_slack.messages", "40");
  sent.length = 0;
  await sourceNew(d, "agent-a", "src_slack.messages", { q: "other" }, 100); // a new filter starts at the unfiltered cursor
  expect(sent[2]!.values).toEqual([40, "other", 100]);

  sent.length = 0;
  await sourceNew(d, "agent-b", "src_slack.messages", {}, 100); // another agent has its own cursor
  expect(sent[2]!.text).toContain("interval '1 day'");

  expect(newRowsSql("src_slack.messages", { channels: ["C1"], q: "ship" }, null, 2).values).toEqual([["C1"], "ship", 2]);
  expect(() => newRowsSql("src_slack.message", {}, null, 10)).toThrow(/unknown view/); // base tables aren't served
  expect(() => newRowsSql("src_jira.sprints", { channels: ["C1"] }, null, 10)).toThrow(/no channels filter/);
  await expect(sourceAck(d, "agent-a", "src_slack.messages", "1; DROP")).rejects.toThrow(/cursor/);
});

// The agent's SQL may leave state on its session that a ROLLBACK keeps (a session-level advisory lock): its connection is
// closed, never pooled for the next query, whether or not the ROLLBACK went through.
it("warehouse_query never returns its connection to the pool", async () => {
  const run = async (rollback: "ok" | "fails") => {
    const released: unknown[] = [];
    const client = {
      query: async (q: string | { text: string }) => {
        if (q === "ROLLBACK" && rollback === "fails") throw new Error("connection terminated");
        return { rows: [] };
      },
      release: (e?: unknown) => void released.push(e),
    };
    const d = { pool: { connect: async () => client, query: async () => ({ rows: [] }) }, sql: async () => "" } as unknown as WarehouseDeps;
    await warehouseQuery(d, "SELECT set_config('statement_timeout', '0', false)");
    return released;
  };
  expect(await run("ok")).toEqual([true]);
  expect(await run("fails")).toEqual([true]);
});
