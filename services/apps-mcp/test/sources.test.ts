import { expect, it } from "vitest";
import { findingVerdict, newRowsSql, sourceAck, sourceNew, type WarehouseDeps } from "../src/sources.js";

// The cursor belongs to the calling agent (its Paperclip id), starts a day back, and moves only by source_ack.
// The SQL itself was smoke-run as the readonly login on postgres:17.
it("source_new / source_ack: per-agent cursor, filters as parameters, baseline rows skipped by default", async () => {
  const cursors = new Map<string, string>();
  const sent: { text: string; values?: unknown[] }[] = [];
  const d: WarehouseDeps = {
    pool: {
      connect: async () => { throw new Error("unused"); },
      query: (async (text: string, values?: unknown[]) => {
        sent.push({ text, values });
        if (text.includes("src_meta.cursor")) {
          const c = cursors.get(`${values![0]}|${values![1]}`);
          return { rows: c ? [{ seq: c }] : [] };
        }
        // As Postgres sends them: n = seq, r = the row's JSON text (null once the byte cap is reached).
        return { rows: [{ n: "41", r: JSON.stringify({ channel_id: "C1", text: "ship it", seq: 41 }) }, { n: "42", r: JSON.stringify({ channel_id: "C1", text: "shipped", seq: 42 }) }] };
      }) as any,
    },
    sql: async (_script, vars) => (cursors.set(`${vars.agent}|${vars.view}`, vars.seq!), ""),
  };

  const first = await sourceNew(d, "agent-a", "src_slack.messages", { channels: ["C1"], q: "ship" }, 2);
  expect(sent[1]!.text).toContain("ingested_at > now() - interval '1 day'");
  expect(sent[1]!.text).toContain("NOT baseline");
  expect(sent[1]!.values).toEqual([["C1"], "ship", 2]);
  expect(first).toMatchObject({ cursor: "42", more: true, rows: [{ seq: 41 }, { seq: 42 }] });

  await sourceAck(d, "agent-a", "src_slack.messages", first.cursor!);
  sent.length = 0;
  await sourceNew(d, "agent-a", "src_slack.messages", {}, 100);
  expect(sent[1]!.text).toContain("seq > $1");
  expect(sent[1]!.values).toEqual([42, 100]);

  sent.length = 0;
  await sourceNew(d, "agent-b", "src_slack.messages", {}, 100); // another agent has its own cursor
  expect(sent[1]!.text).toContain("interval '1 day'");

  expect(() => newRowsSql("src_slack.message", {}, null, 10)).toThrow(/unknown view/); // base tables aren't served
  expect(() => newRowsSql("src_jira.sprints", { channels: ["C1"] }, null, 10)).toThrow(/no channels filter/);
  await expect(sourceAck(d, "agent-a", "src_slack.messages", "1; DROP")).rejects.toThrow(/cursor/);
});

it("finding_verdict: copies the finding's current state in SQL, and source_new skips current not-affected findings", async () => {
  const sent: { script: string; vars: Record<string, string> }[] = [];
  const d: WarehouseDeps = {
    pool: { connect: async () => { throw new Error("unused"); }, query: (async (_t: string, v?: unknown[]) => ({ rows: v![0] === "0123456789abcdef" ? [{}] : [] })) as any },
    sql: async (script, vars) => (sent.push({ script, vars }), ""),
  };
  await findingVerdict(d, "security-watch", "0123456789abcdef", "not-affected", "fixed in the running release");
  expect(sent[0]!.vars).toEqual({ id: "0123456789abcdef", verdict: "not-affected", reason: "fixed in the running release", agent: "security-watch" });
  expect(sent[0]!.script).toContain("severity, fixed_version, fix_state, present FROM src_security.finding");
  await expect(findingVerdict(d, "security-watch", "ffffffffffffffff", "confirmed", "x")).rejects.toThrow(/no finding/);
  expect(newRowsSql("src_security.findings", {}, 5, 10).text).toContain("verdict IS DISTINCT FROM 'not-affected'");
  expect(newRowsSql("src_slack.messages", {}, 5, 10).text).not.toContain("verdict");
});
