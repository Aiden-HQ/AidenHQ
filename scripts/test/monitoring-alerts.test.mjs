// modules/monitoring/prometheus/rules.yml against fixtures: a 16-unit snapshot raises nothing, absent or stale unit data
// raises only the exporter alert, and a unit that stops reporting is named. The expressions are evaluated, not restated:
// a small PromQL subset (vectors, absent/sum/count/count_over_time/last_over_time, subtraction, comparisons, and/or/unless with on()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rules = YAML.parse(readFileSync(join(product, "modules/monitoring/prometheus/rules.yml"), "utf8"))
  .groups.flatMap((g) => g.rules).filter((r) => r.alert);
/** The rules this change is about: the unit alerts and the exporter freshness alert that gates them. */
const UNIT_RULES = ["UnitFailed", "CiRunnersDown", "CiRunnerUnitMissing", "HostMetricsExporterStale"];
const underTest = rules.filter((r) => UNIT_RULES.includes(r.alert));

/** The CI runner units in service: @1-@4 for the agents org, @Aiden-HQ-1-@Aiden-HQ-12 for the product org. */
const UNITS = [
  "aidenhq-ci-runner@1.service",
  "aidenhq-ci-runner@2.service",
  "aidenhq-ci-runner@3.service",
  "aidenhq-ci-runner@4.service",
  "aidenhq-ci-runner@Aiden-HQ-1.service",
  "aidenhq-ci-runner@Aiden-HQ-2.service",
  "aidenhq-ci-runner@Aiden-HQ-3.service",
  "aidenhq-ci-runner@Aiden-HQ-4.service",
  "aidenhq-ci-runner@Aiden-HQ-5.service",
  "aidenhq-ci-runner@Aiden-HQ-6.service",
  "aidenhq-ci-runner@Aiden-HQ-7.service",
  "aidenhq-ci-runner@Aiden-HQ-8.service",
  "aidenhq-ci-runner@Aiden-HQ-9.service",
  "aidenhq-ci-runner@Aiden-HQ-10.service",
  "aidenhq-ci-runner@Aiden-HQ-11.service",
  "aidenhq-ci-runner@Aiden-HQ-12.service",
];
const NOW = 1_800_000_000;
const lookback = 300;

// ---- a PromQL subset, enough for the unit alerts -------------------------------------------------------------
const tokenize = (src) => {
  const out = [];
  const re = /\s*(?:(and|or|unless|on)\b|(\d+(?:\.\d+)?[smhdwy])|(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*")|([A-Za-z_:][A-Za-z0-9_:]*)|(=~|==|[-{}()[\],<>=]))/y;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(at))) break;
      throw new Error(`unexpected PromQL at ${JSON.stringify(src.slice(at, at + 30))}`);
    }
    const [all, word, dur, num, str, ident, op] = m;
    if (dur) out.push({ t: "dur", v: dur });
    else if (num) out.push({ t: "num", v: Number(num) });
    else if (str) out.push({ t: "str", v: JSON.parse(str) });
    else if (ident) out.push({ t: "id", v: ident });
    else if (word) out.push({ t: "id", v: word });
    else out.push({ t: "op", v: op });
    if (!all.length) break;
  }
  return out;
};
const seconds = (d) => Number(d.slice(0, -1)) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[d.slice(-1)];

function parser(tokens) {
  let i = 0;
  const peek = (v) => (tokens[i]?.v === v && (tokens[i].t === "op" || tokens[i].t === "id") ? tokens[i] : undefined);
  const eat = (v) => { if (peek(v)) { i++; return true; } return false; };
  const expect = (v) => { if (!eat(v)) throw new Error(`PromQL: expected ${v}, got ${tokens[i]?.v}`); };
  const id = () => { const t = tokens[i++]; if (t?.t !== "id") throw new Error(`PromQL: expected a name, got ${t?.v}`); return t.v; };

  function expr() { return orExpr(); }
  function orExpr() {
    let n = andExpr();
    while (eat("or")) n = { k: "or", l: n, r: andExpr() };
    return n;
  }
  function andExpr() {
    let n = cmpExpr();
    for (;;) {
      if (peek("and") || peek("unless")) {
        const k = tokens[i++].v;
        let on = null;
        if (eat("on")) {
          on = [];
          expect("(");
          if (!eat(")")) { do { on.push(id()); } while (eat(",")); expect(")"); }
        }
        n = { k, on, l: n, r: cmpExpr() };
      } else return n;
    }
  }
  function labels() {
    const out = [];
    do { const name = id(); const op = tokens[i++].v; const v = tokens[i++]; out.push({ name, re: op === "=~" ? new RegExp(`^(?:${v.v})$`) : null, v: v.v }); } while (eat(","));
    return out;
  }
  function cmpExpr() {
    const l = addExpr();
    const op = tokens[i];
    if (op?.t === "op" && ["==", ">", "<"].includes(op.v)) { i++; return { k: "cmp", op: op.v, l, r: addExpr() }; }
    return l;
  }
  function addExpr() {
    let n = mulExpr();
    while (peek("-")) n = { k: "arith", op: tokens[i++].v, l: n, r: mulExpr() };
    return n;
  }
  function mulExpr() {
    return primary();
  }
  function primary() {
    if (eat("(")) { const n = expr(); expect(")"); return n; }
    const t = tokens[i++];
    if (t?.t === "num") return { k: "num", v: t.v };
    if (t?.t !== "id") throw new Error(`PromQL: unexpected ${t?.v}`);
    if (t.v === "time" && eat("(")) { expect(")"); return { k: "time" }; }
    let matchers = [];
    if (eat("{")) {
      if (!eat("}")) { matchers = labels(); expect("}"); }
    }
    const range = eat("[") ? (() => { const d = tokens[i++]; expect("]"); return seconds(d.v); })() : null;
    if (peek("(")) {
      i++;
      const args = eat(")") ? [] : [expr()];
      if (args.length) expect(")");
      return { k: "call", name: t.v, args };
    }
    return { k: "sel", name: t.v, matchers, range };
  }
  return { ast: expr(), end: i };
}

const key = (labels) => JSON.stringify(Object.entries(labels).sort());
const labelsOf = (node) => (labels) => node.matchers.every((x) => (x.re ? x.re.test(labels[x.name] ?? "") : labels[x.name] === x.v));

function evaluate(node, ctx) {
  const vec = (rows) => ({ v: rows });
  switch (node.k) {
    case "num": return { s: node.v };
    case "time": return { s: ctx.now };
    case "sel": {
      const want = labelsOf(node);
      const earliest = ctx.now - (node.range ?? lookback);
      const latest = new Map();
      for (const p of ctx.points) {
        if (p.metric !== node.name || p.t > ctx.now || p.t < earliest || !want(p.labels)) continue;
        const k = key(p.labels);
        if (!latest.has(k) || latest.get(k).t < p.t) latest.set(k, p);
      }
      return vec([...latest.values()].map((p) => ({ labels: p.labels, value: p.value })));
    }
    case "call": {
      const name = node.name;
      if (name === "count_over_time") {
        const sel = node.args[0];
        const earliest = ctx.now - sel.range;
        const counts = new Map();
        for (const p of ctx.points) {
          if (p.metric !== sel.name || p.t > ctx.now || p.t < earliest || !labelsOf(sel)(p.labels)) continue;
          const k = key(p.labels);
          counts.set(k, { labels: p.labels, value: (counts.get(k)?.value ?? 0) + 1 });
        }
        return vec([...counts.values()]);
      }
      if (name === "last_over_time") {
        const sel = node.args[0];
        const earliest = ctx.now - sel.range;
        const last = new Map();
        for (const p of ctx.points) {
          if (p.metric !== sel.name || p.t > ctx.now || p.t < earliest || !labelsOf(sel)(p.labels)) continue;
          const k = key(p.labels);
          if (!last.has(k) || last.get(k).t < p.t) last.set(k, p);
        }
        return vec([...last.values()].map((p) => ({ labels: p.labels, value: p.value })));
      }
      const a = evaluate(node.args[0], ctx);
      if (a.s !== undefined) return vec([{ labels: {}, value: a.s }]);
      if (name === "absent") return a.v.length ? vec([]) : vec([{ labels: {}, value: 1 }]);
      const values = a.v.map((r) => r.value);
      if (!values.length) return vec([]);
      const v = { sum: values.reduce((x, y) => x + y, 0), count: values.length }[name];
      if (v === undefined) throw new Error(`PromQL: ${name} is not in the test subset`);
      return vec([{ labels: {}, value: v }]); // an aggregation is a vector with no labels, not a scalar
    }
    case "or": case "and": case "unless": {
      const l = evaluate(node.l, ctx).v ?? [];
      const r = evaluate(node.r, ctx).v ?? [];
      const onLabels = (labels) => node.on ?? Object.keys(labels);
      const same = (a, b) => onLabels(a).every((k) => a[k] === b[k]);
      if (node.k === "or") return vec([...l, ...r.filter((b) => !l.some((a) => same(a.labels, b.labels)))]);
      if (node.k === "and") return vec(l.filter((a) => r.some((b) => same(a.labels, b.labels))));
      return vec(l.filter((a) => !r.some((b) => same(a.labels, b.labels))));
    }
    case "arith": case "cmp": {
      const l = evaluate(node.l, ctx);
      const r = evaluate(node.r, ctx);
      const op = { "-": (a, b) => a - b, ">": (a, b) => a > b, "<": (a, b) => a < b, "==": (a, b) => a === b }[node.op];
      if (l.s !== undefined && r.s !== undefined) return { s: node.k === "cmp" ? (op(l.s, r.s) ? 1 : 0) : op(l.s, r.s) };
      const pair = (a, b) => (node.k === "cmp" ? (op(a, b) ? a : undefined) : op(a, b));
      if (l.v && r.s !== undefined) return vec(l.v.map((row) => ({ labels: row.labels, value: pair(row.value, r.s) })).filter((row) => row.value !== undefined));
      if (l.s !== undefined && r.v) return vec(r.v.map((row) => ({ labels: row.labels, value: pair(l.s, row.value) })).filter((row) => row.value !== undefined));
      return vec(l.v.flatMap((row) => {
        const other = r.v.find((x) => key(x.labels) === key(row.labels));
        if (!other) return [];
        const value = pair(row.value, other.value);
        return value === undefined ? [] : [{ labels: row.labels, value }];
      }));
    }
    default: throw new Error(`PromQL: unknown node ${node.k}`);
  }
}

/** The alerts that would fire now, and the labels they carry. */
function firing(points, now = NOW) {
  const out = [];
  for (const rule of underTest) {
    const { ast } = parser(tokenize(rule.expr));
    const r = evaluate(ast, { points, now });
    for (const row of r.v ?? []) out.push({ alert: rule.alert, unit: row.labels.unit, labels: row.labels });
  }
  return out;
}

// ---- fixtures ------------------------------------------------------------------------------------------------
const point = (metric, labels, value, t = NOW) => ({ metric, labels, value, t });
// `declared` is what the exporter reads from `systemctl --user list-unit-files`, so a unit can be declared and still be
// absent from the snapshot: that is the case CiRunnerUnitMissing names. It defaults to the units listed here.
const snapshot = (units, { active = 1, failed = 0, mtime = NOW - 20, draining = 0, declared = units } = {}) => [
  point("aidenhq_fleet_draining", {}, draining),
  // node-exporter labels this with the path it read (the module mounts the textfile dir at /textfile), not the bare name.
  point("node_textfile_mtime_seconds", { file: "/textfile/units.prom" }, mtime),
  point("node_textfile_mtime_seconds", { file: "/textfile/runner.prom" }, mtime),
  point("node_textfile_mtime_seconds", { file: "/textfile/containers.prom" }, mtime),
  ...units.flatMap((unit) => [
    point("aidenhq_unit_active", { scope: "user", unit }, active),
    point("aidenhq_unit_failed", { scope: "user", unit }, failed),
  ]),
  ...declared.map((unit) => point("aidenhq_unit_declared", { scope: "user", unit }, 1)),
];

test("the exporter alert exists, warns, and has a for: window", () => {
  const rule = rules.find((r) => r.alert === "HostMetricsExporterStale");
  assert.ok(rule, "HostMetricsExporterStale");
  assert.equal(rule.labels.severity, "warning");
  assert.match(rule.for, /^\d+[smhd]$/);
});

test("the unit alerts are in the rules file and gated on the exporter's freshness", () => {
  assert.deepEqual(underTest.map((r) => r.alert).sort(), [...UNIT_RULES].sort());
  for (const name of ["UnitFailed", "CiRunnersDown", "CiRunnerUnitMissing"]) {
    // node-exporter labels the mtime with the path it read: a matcher on the bare name never matches.
    assert.ok(rules.find((r) => r.alert === name).expr.includes('node_textfile_mtime_seconds{file=~".*/units\\\\.prom"}'), name);
  }
});

test("all 16 runner units in service raise nothing", () => {
  assert.equal(UNITS.length, 16);
  assert.deepEqual(firing(snapshot(UNITS)), []);
});

test("an absent series raises only the exporter alert", () => {
  assert.deepEqual(firing([]).map((a) => a.alert), ["HostMetricsExporterStale"]);
});

test("a writer that runs but reads no unit raises only the exporter alert", () => {
  const points = [
    point("aidenhq_fleet_draining", {}, 0),
    point("node_textfile_mtime_seconds", { file: "/textfile/units.prom" }, NOW - 5),
    point("node_textfile_mtime_seconds", { file: "/textfile/containers.prom" }, NOW - 5),
  ];
  assert.deepEqual(firing(points).map((a) => a.alert), ["HostMetricsExporterStale"]);
});

test("a stale exporter (frozen all-failed snapshot) raises only the exporter alert", () => {
  const stale = snapshot(UNITS, { active: 0, failed: 1, mtime: NOW - 600, draining: 0 });
  assert.deepEqual(firing(stale).map((a) => a.alert), ["HostMetricsExporterStale"]);
});

test("a real failure with fresh data still raises UnitFailed and CiRunnersDown", () => {
  const down = firing(snapshot(UNITS, { active: 0, failed: 1 }));
  assert.deepEqual([...new Set(down.map((a) => a.alert))].sort(), ["CiRunnersDown", "UnitFailed"]);
  assert.equal(down.filter((a) => a.alert === "UnitFailed").length, 16);
});

test("a single missing unit is named, and only that unit", () => {
  const missing = UNITS[5];
  const points = [
    // systemd still has it enabled, so it is declared: a unit that is declared and gone is the one to name.
    ...snapshot(UNITS.filter((u) => u !== missing), { declared: UNITS }),
    // it reported a quarter of an hour ago, before the last scrape: gone now, but not from a broken exporter
    point("aidenhq_unit_active", { scope: "user", unit: missing }, 1, NOW - 600),
    point("aidenhq_unit_failed", { scope: "user", unit: missing }, 0, NOW - 600),
  ];
  const fired = firing(points);
  assert.deepEqual(fired.map((a) => a.alert), ["CiRunnerUnitMissing"]);
  assert.equal(fired[0].unit, missing);
});

test("a unit stopped and disabled in one step is not named by CiRunnerUnitMissing", () => {
  const retired = UNITS[5];
  const points = [
    ...snapshot(UNITS.filter((u) => u !== retired)),
    // it reported within the last day, but it is no longer declared: retired, not missing
    point("aidenhq_unit_active", { scope: "user", unit: retired }, 1, NOW - 600),
    point("aidenhq_unit_failed", { scope: "user", unit: retired }, 0, NOW - 600),
  ];
  assert.deepEqual(firing(points), []);
});

test("one failed unit on fresh data is named by unit, and CiRunnersDown waits for the rest", () => {
  const failedUnit = UNITS[7];
  const points = [
    ...snapshot(UNITS.filter((u) => u !== failedUnit)),
    point("aidenhq_unit_active", { scope: "user", unit: failedUnit }, 0),
    point("aidenhq_unit_failed", { scope: "user", unit: failedUnit }, 1),
  ];
  const fired = firing(points);
  // The gate is open (units.prom is fresh), so the failure is visible; 15 units still run, so the fleet is not down.
  assert.deepEqual(fired.map((a) => a.alert), ["UnitFailed"]);
  assert.equal(fired[0].unit, failedUnit);
});

test("a planned drain with every unit still listed raises nothing", () => {
  assert.deepEqual(firing(snapshot(UNITS, { active: 0, draining: 1 })), []);
});
