import { expect, it } from "vitest";
import { findingVerdict, newRowsSql, sourceAck, sourceNew, type WarehouseDeps } from "../src/sources.js";

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

// Slack rows are large, so the old 200 KB result guard ended a limit=500 page after ~145 rows. source_new has its own
// 1 MB budget now (still a guard), and a page it cuts reports `capped` so callers can tell it apart from a short view.
it("source_new: honours limit up to 500 under its own size guard, and reports a page the guard cut", async () => {
  let cut = false;
  const sent: { text: string; values?: unknown[] }[] = [];
  const d: WarehouseDeps = {
    pool: {
      connect: async () => { throw new Error("unused"); },
      query: (async (text: string, values: unknown[] = []) => {
        sent.push({ text, values });
        if (text.includes("max(seq) AS seq FROM")) return { rows: [{ seq: "500" }] };
        if (text.includes("src_meta.cursor")) return { rows: [] };
        const limit = Number(values[values.length - 1]);
        const rows: { n: string; r: string | null }[] = Array.from({ length: limit }, (_, i) => ({ n: String(i + 1), r: JSON.stringify({ seq: i + 1, text: "x".repeat(1400) }) }));
        if (cut) rows[rows.length - 1] = { n: String(limit), r: null }; // Postgres withholds the rest past the cap
        return { rows };
      }) as any,
    },
    sql: async () => "",
  };

  const full = await sourceNew(d, "agent-a", "src_slack.messages", {}, 500);
  expect(sent.find((q) => q.text.includes("LIMIT $"))!.text).toContain("total <= 1000000");
  expect(sent.find((q) => q.text.includes("LIMIT $"))!.values).toEqual([500]);
  expect(full.rows).toHaveLength(500);
  expect(full).toMatchObject({ capped: false, byte_cap: 1_000_000, more: true });

  cut = true;
  const short = await sourceNew(d, "agent-a", "src_slack.messages", {}, 500);
  expect(short.rows).toHaveLength(499);
  expect(short).toMatchObject({ capped: true, byte_cap: 1_000_000, more: true });
});

// Roadmap Keeper read src_github.changes filtered to some repos (some made up), acked, and its next unfiltered scan began
// past 71 rows of the real repos. Now a filtered read keeps its own cursor and an unknown repo is refused.
it("source_new: a filtered ack never skips other scopes' rows, and an unknown scope is refused with real ones", async () => {
  const table = [
    { seq: 10, scope: "acme/node" },
    { seq: 11, scope: "acme/ledger" },
    { seq: 12, scope: "acme/billing-api" },
    { seq: 13, scope: "acme/ledger" },
  ];
  const known = new Set([...table.map((r) => r.scope), "bridge/bridge"]);
  const cursors = new Map<string, string>();
  const d: WarehouseDeps = {
    pool: {
      connect: async () => { throw new Error("unused"); },
      query: (async (text: string, values: unknown[] = []) => {
        if (text.includes("max(seq) AS seq FROM")) return { rows: [{ seq: String(Math.max(...table.map((r) => r.seq))) }] };
        if (text.includes("src_meta.cursor")) return { rows: ["", values[2]].flatMap((k) => (cursors.has(`${values[0]}|${values[1]}|${k}`) ? [{ filter_key: k, seq: cursors.get(`${values[0]}|${values[1]}|${k}`) }] : [])) };
        if (text.includes("unnest")) return { rows: (values[0] as string[]).filter((u) => !known.has(u)).map((u) => ({ u })) };
        if (text.includes("ILIKE")) return { rows: [...known].filter((s) => s.includes(String(values[0]).replaceAll("%", ""))).map((s) => ({ s })) };
        const after = text.includes("seq > $1") ? Number(values[0]) : 0;
        const only = values.find(Array.isArray) as string[] | undefined;
        const rows = table.filter((r) => r.seq > after && (!only || only.includes(r.scope)));
        return { rows: rows.map((r) => ({ n: String(r.seq), r: JSON.stringify(r) })) };
      }) as any,
    },
    sql: async (_script, vars) => (cursors.set(`${vars.agent}|${vars.view}|${vars.key}`, vars.seq!), ""),
  };
  const view = "src_github.changes";

  await expect(sourceNew(d, "rk", view, { repos: ["acme/ledger", "acme/bridge"] }, 100)).rejects.toThrow(/acme\/bridge \(did you mean bridge\/bridge\)/);
  const filtered = await sourceNew(d, "rk", view, { repos: ["acme/ledger"] }, 100);
  expect(filtered.rows.map((r) => r.seq)).toEqual([11, 13]);
  await sourceAck(d, "rk", view, filtered.cursor!);

  // The unfiltered scan still sees every row, the other repos' included; the filtered one resumes after its own ack.
  const all = await sourceNew(d, "rk", view, {}, 100);
  expect(all.rows.map((r) => r.seq)).toEqual([10, 11, 12, 13]);
  expect(all.cursor).toBe("13");
  expect((await sourceNew(d, "rk", view, { repos: ["acme/ledger"] }, 100)).rows).toEqual([]);
});

// A stored cursor past the newest seq is not a read position in the view (a seq reset, or a timestamp acked as a cursor):
// `seq > cursor` would never be true. The read starts over from the day window, and the next ack replaces the bad cursor.
it("source_new: a cursor ahead of the view's newest seq is ignored, and source_ack replaces it", async () => {
  const cursors = new Map<string, string>([["rk|src_slack.messages|", "1794505378775662"]]);
  const sent: { text: string; values?: unknown[] }[] = [];
  const scripts: string[] = [];
  const d: WarehouseDeps = {
    pool: {
      connect: async () => { throw new Error("unused"); },
      query: (async (text: string, values: unknown[] = []) => {
        sent.push({ text, values });
        if (text.includes("max(seq) AS seq FROM")) return { rows: [{ seq: "2394" }] };
        if (text.includes("src_meta.cursor")) return { rows: [{ filter_key: "", seq: cursors.get("rk|src_slack.messages|") }] };
        return { rows: [{ n: "2394", r: JSON.stringify({ seq: 2394 }) }] };
      }) as any,
    },
    sql: async (script, vars) => (scripts.push(script), cursors.set(`${vars.agent}|${vars.view}|${vars.key}`, vars.seq!), ""),
  };

  const read = await sourceNew(d, "rk", "src_slack.messages", {}, 100);
  expect(sent.some((q) => q.text.includes("ingested_at > now() - interval '1 day'"))).toBe(true); // the stored 1.79e15 cursor was ignored
  expect(sent.some((q) => q.text.includes("seq > $1"))).toBe(false);
  expect(read.rows).toEqual([{ seq: 2394 }]);
  expect(read.cursor).toBe("2394");
  await expect(sourceAck(d, "rk", "src_slack.messages", "9999999999999999")).rejects.toThrow(/past the newest row/);

  await sourceAck(d, "rk", "src_slack.messages", read.cursor!);
  expect(scripts[0]).toContain("WHEN src_meta.cursor.seq > (SELECT COALESCE(max(seq), 0) FROM src_slack.messages) THEN EXCLUDED.seq");
  expect(cursors.get("rk|src_slack.messages|")).toBe("2394");
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
