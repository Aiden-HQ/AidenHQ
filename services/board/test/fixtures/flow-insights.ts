// A Flow page's data in the kernel's shapes (src/flow.ts), shaped like a real instance: most PRs the owner's own (no task,
// starting at "PR open"), agent PRs with AI-review loops, CI around two minutes, one multi-day outlier, one open and one
// closed. Seeded, so a render (test/web/flow-page.test.ts) and the dev harness see the same page.
import type { FlowSummary, IdleItem, Insights, JourneyInfo, JourneyItem, JourneyList, Metric } from "../../src/flow.js";

export const PHASES = [
  ["triage", "Triage"], ["pickup", "Pickup"], ["coding", "Coding"], ["review", "AI review"],
  ["open", "PR open"], ["ci", "CI"], ["merge", "Merge review"], ["deploy", "Deploy"],
].map(([name, label]) => ({ name: name!, label: label! }));

export const JOURNEY: JourneyInfo = { name: "pr", label: "Pull requests", phases: PHASES };

const TITLES = [
  "fix(runner): retry a push the code host refused with 502", "feat(board): flow page tabs", "fix(kernel): normalise fact times to UTC",
  "chore(deps): bump vite to 8.3.8", "feat(codehost): record pushes per head", "fix(board): relative times read 5m ago",
  "docs(flow): journeys and phases", "fix(runner): an approved write starts the next run", "feat(apps): app starter on main",
  "refactor(kernel): one fact emitter", "fix(ops): wait for the apt lock", "feat(reviewer): reason codes on rejections",
  "fix(board): dialog focus on close", "feat(kernel): cost per merged PR", "test(runner): merge queue receipt",
];

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** The journey's items, newest first, ending before `now`. */
export function fixtureItems(now = Date.parse("2026-11-19T12:00:00Z")): JourneyItem[] {
  const r = rng(7);
  const between = (a: number, b: number) => a + r() * (b - a);
  const items: JourneyItem[] = [];
  for (let i = 0; i < 62; i++) {
    const n = 380 - i;
    const kind: JourneyItem["author_kind"] = i % 9 === 4 ? "outside" : r() < 0.68 ? "owner" : "agent";
    const outlier = i === 17;
    const open = i === 0 || i === 3;
    const closed = i === 11;
    const spans: [string, number, number, Record<string, number>][] = [];
    const add = (phase: string, s: number, rounds = 1, idle: Record<string, number> = {}) => spans.push([phase, s, rounds, idle]);
    if (kind === "agent") {
      add("triage", between(600, 7200), 1, { capacity: between(300, 3000) });
      add("pickup", between(30, 400));
      add("coding", between(900, 4800), r() < 0.2 ? 2 : 1);
      const rounds = Math.min(5, 1 + Math.floor(r() * r() * 5));
      add("review", rounds * between(120, 600) + (rounds > 1 ? between(600, 3000) : 0), rounds, rounds > 1 ? { reviewer: between(300, 1800) } : {});
    }
    add("open", between(20, 300));
    add("ci", between(80, 200) * (r() < 0.25 ? 2 : 1), r() < 0.25 ? 2 : 1, r() < 0.2 ? { checks: between(30, 120) } : {});
    add("merge", outlier ? 3.2 * 86_400 : kind === "outside" ? between(3600, 40_000) : between(30, 900), r() < 0.15 ? 2 : 1, outlier ? { owner: 3 * 86_400 } : kind === "outside" ? { owner: between(1800, 20_000) } : {});
    if (!closed) add("deploy", between(480, 1500), 1, r() < 0.3 ? { deploy_queue: between(60, 400) } : {});
    if (open) spans.splice(i === 0 ? spans.length - 3 : spans.length - 2);
    const total = spans.reduce((a, s) => a + s[1], 0);
    const endAt = now - i * between(5, 13) * 3600_000 - (open ? 0 : between(0, 2) * 3600_000);
    let t = endAt - total * 1000;
    const blocks = spans.map(([phase, s, rounds, idle]) => {
      const start = t;
      t += s * 1000;
      const idle_s = Math.min(s * 0.9, Object.values(idle).reduce((a, v) => a + v, 0));
      return { phase, start: new Date(start).toISOString(), end: new Date(t).toISOString(), rounds, idle_s, idle };
    });
    items.push({
      subject: `pr:acme/acme-agents#${n}`,
      repo: "acme/acme-agents",
      number: n,
      url: i === 40 ? null : `https://github.com/acme/acme-agents/pull/${n}`,
      title: i === 22 ? null : TITLES[i % TITLES.length]!,
      author: kind === "agent" ? "acme-agents[bot]" : kind === "owner" ? "acme-owner" : i === 31 ? null : "contributor",
      author_kind: i === 31 ? null : kind,
      task: kind === "agent" ? `task-${n}` : null,
      identifier: kind === "agent" ? `WOR-${7000 + n}` : null,
      state: open ? "open" : closed ? "closed" : i < 6 ? "merged" : "deployed",
      start: blocks[0]!.start,
      end: open ? null : blocks.at(-1)!.end,
      total_s: total,
      blocks,
    });
  }
  return items;
}

export function fixtureList(items = fixtureItems()): JourneyList {
  return { ...JOURNEY, journey: "pr", items, truncated: false };
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const weekOf = (iso: string) => {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** The summary's insights, computed from the items the way the kernel would (roughly; it is a fixture). */
export function fixtureInsights(items = fixtureItems(), now = Date.parse("2026-11-19T12:00:00Z")): Insights {
  const r = rng(11);
  const weeks = [...new Set(items.map((x) => weekOf(x.start)))].sort();
  const days = Array.from({ length: 30 }, (_, i) => new Date(now - (29 - i) * 864e5).toISOString().slice(0, 10));
  const metric = (base: number, spread: number, prev: number): Metric => ({ value: base, previous: prev, weekly: weeks.map((week) => ({ week, value: base + (r() - 0.5) * spread })) });
  const phases = PHASES.map((p) => {
    const bs = items.flatMap((x) => x.blocks.filter((b) => b.phase === p.name).map((b) => ({ ...b, s: (Date.parse(b.end) - Date.parse(b.start)) / 1000 })));
    return {
      ...p,
      n: bs.length,
      p50: q(bs.map((b) => b.s), 0.5),
      p85: q(bs.map((b) => b.s), 0.85),
      p95: q(bs.map((b) => b.s), 0.95),
      idle_s: bs.reduce((a, b) => a + b.idle_s, 0),
      rounds_mean: bs.length ? bs.reduce((a, b) => a + b.rounds, 0) / bs.length : 0,
      weekly: weeks.map((week) => {
        const w = bs.filter((b) => weekOf(b.start) === week).map((b) => b.s);
        return { week, p50: q(w, 0.5), n: w.length };
      }),
    };
  });
  const rounds: Insights["rounds"] = {};
  for (const x of items) for (const b of x.blocks) {
    const k = String(Math.min(4, b.rounds));
    (rounds[b.phase] ??= {})[k] = (rounds[b.phase]![k] ?? 0) + 1;
  }
  const openItems = items.filter((x) => !x.end);
  return {
    phases,
    scatter: items.filter((x) => x.end).map((x) => ({ subject: x.subject, url: x.url, task: x.task, end: x.end!, total_s: x.total_s, author_kind: x.author_kind })),
    rounds,
    rejections: [
      { reason: "missing_tests", n: 41 }, { reason: "scope_creep", n: 27 }, { reason: "unpinned_dependency", n: 18 },
      { reason: "secret_in_diff", n: 6 }, { reason: "unclear_intent", n: 4 },
    ],
    first_pass: weeks.map((week) => ({ week, rate: 0.42 + r() * 0.3, n: 8 + Math.floor(r() * 20) })),
    aging: [
      ...openItems.map((x) => ({ subject: x.subject, url: x.url, task: x.task, author_kind: x.author_kind, title: x.title, phase: x.blocks.at(-1)!.phase, age_s: (now - Date.parse(x.start)) / 1000, idle_reason: "reviewer" })),
      ...Array.from({ length: 14 }, (_, i) => ({
        subject: `pr:acme/acme-agents#${400 + i}`, url: null, task: null, author_kind: "agent", title: TITLES[(i * 5) % TITLES.length]!, phase: PHASES[[3, 3, 4, 5, 6, 6, 3, 2, 6, 7, 3, 5, 6, 1][i]!]!.name,
        age_s: 300 + r() * r() * 4 * 86_400, idle_reason: [null, "owner", "reviewer", "capacity"][i % 4]!,
      })),
    ],
    cfd: days.map((day, i) => ({ day, counts: Object.fromEntries(PHASES.map((p, j) => [p.name, Math.max(0, Math.round((j === 7 ? i * 2.1 : j === 6 ? i * 0.4 + 2 : 3 + 2 * Math.sin(i / 3 + j)) + r() * 2))])) })),
    funnel: [{ step: "issue", n: 74 }, { step: "pr_opened", n: 62 }, { step: "ci_passed", n: 58 }, { step: "review_passed", n: 51 }, { step: "merged", n: 49 }, { step: "deployed", n: 44 }],
    cost: {
      per_merged: weeks.map((week) => ({ week, usd: 1.4 + r() * 1.6 })),
      by_agent: [{ key: "engineer", usd: 61.2, merged: 19 }, { key: "platform-engineer", usd: 23.9, merged: 6 }, { key: "devops", usd: 8.4, merged: 4 }, { key: "aiden", usd: 4.1, merged: 0 }],
      by_model: [{ key: "deepseek/deepseek-flash", usd: 58.3, merged: 26 }, { key: "openai/gpt-luna", usd: 31.7, merged: 0 }, { key: "openai/gpt-sol", usd: 7.6, merged: 3 }],
      unmerged_usd: 17.35,
    },
    dora5: {
      deploys_per_day: metric(6.4, 3, 5.1),
      lead_time_s: metric(5400, 2400, 7900),
      change_fail_rate: metric(0.06, 0.05, 0.04),
      recovery_s: metric(1800, 1200, 2700),
      rework_rate: metric(0.31, 0.1, 0.38),
    },
    throughput: days.map((day) => ({ day, merged: Math.round(r() * r() * 9), opened: Math.round(r() * 8) })),
    bottlenecks: [
      { phase: "review", kind: "rounds", text: "AI review takes 2.1 rounds on average: 245 of 507 agent filings were rejected, most for missing tests." },
      { phase: "merge", kind: "idle", text: "Merge review holds the most idle time: 3d 4h this period, nearly all waiting on the owner." },
      { phase: "triage", kind: "slow", text: "Triage is the slowest step at the p85: 1h 52m from an issue to its task." },
    ],
  };
}

export function fixtureSummary(): FlowSummary {
  return {
    stages: [],
    dora: null,
    churn: { rewritten_30d: 0.18, hot_lines: 212 },
    fleet: { first_pass_review: 0.52, cost_per_outcome: 2.31 },
    insights: fixtureInsights(),
  };
}

export const FIXTURE_IDLE: IdleItem[] = [
  { task: "task-378", identifier: "WOR-7378", since: "2026-11-19T07:10:00Z", reason: "reviewer", holder: "ai-reviewer" },
  { task: "task-377", identifier: "WOR-7377", since: "2026-11-19T09:40:00Z", reason: "owner", holder: "owner" },
  { task: "task-369", identifier: "WOR-7369", since: "2026-11-19T11:20:00Z", reason: "capacity", holder: null },
];
