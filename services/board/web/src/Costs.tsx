import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SignInRequired, api } from "./api";
import { duration } from "./FeatureCost";
import type { FeatureCost, CostLedger, CostTop, LedgerMetrics, LedgerPeriod } from "./types";
import { Tag } from "./ui";
import { clockOpts } from "./util";

// The Costs tab: billed spend from the model gateway's ledger (src/cost-ledger.ts), aggregated on the board.
//  1. Overview: today / 7 / 30 days against the period before, the OpenRouter key's limit, the install's spend limits.
//  2. Spend over time by model (stacked bars) and the by-model table.
//  3. By agent and by kind of call; 4. a drill-down into one agent or model (top runs and tasks).
// The view lives in the URL (#/insight/costs?range=7d&bucket=day&agent=…), so it can be linked.

/* ----------------------------------------------------------------------------- formatting */
const DAY = 864e5;
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const usd = (n: number | null | undefined) => (n == null ? "—" : n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n >= 100 ? 0 : 2)}`);
const pct = (x: number) => (x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 1e4 ? 0 : 1)} s` : `${ms} ms`);
const short = (model: string) => model.replace(/^openrouter\//, "").split("/").pop()!.replace(/^~/, "");
const cacheHit = (m: LedgerMetrics) => (m.input + m.cached ? m.cached / (m.input + m.cached) : null);
const LANES: Record<string, string> = { agent: "Agent runs", engineer: "Engineer jobs", advisor: "Advisor", fanout: "Fan-out", grader: "Grader", reviewer: "AI reviewer", source: "Sources and intake", "ci-code-review": "App CI code review", aside: "Side chat", check: "Check jobs" };
const lane = (k: string) => LANES[k] ?? k;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts() }) : "");

/** Up or down against the period before, as words: costs going up are worth a look, not an alarm. */
function Delta({ cur, prev, vs }: { cur: number; prev: number | null; vs: string }) {
  if (prev == null) return <span className="cost-delta" title={`The ledger doesn't reach back to ${vs} yet`}>Nothing earlier to compare</span>;
  if (prev === 0) return <span className="cost-delta">{cur > 0 ? `Nothing ${vs}` : `Same as ${vs}`}</span>;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return <span className="cost-delta">Same as {vs}</span>;
  return (
    <span className={`cost-delta ${d > 0 ? "up" : "down"}`} title={`${usd(prev)} ${vs}`}>
      <span aria-hidden>{d > 0 ? "▲" : "▼"}</span> {pct(Math.abs(d))} {d > 0 ? "more" : "less"} than {vs}
    </span>
  );
}

/* ----------------------------------------------------------------------------- URL state */
type RangeKey = "24h" | "7d" | "30d" | "custom";
interface ViewState {
  range: RangeKey;
  /** Custom range: UTC days, both inclusive (YYYY-MM-DD). */
  from: string;
  to: string;
  bucket: "hour" | "day" | null;
  agent: string | null;
  model: string | null;
}
const RANGES: [RangeKey, string][] = [["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"], ["custom", "Custom"]];
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function readHash(): ViewState {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const range = (["24h", "7d", "30d", "custom"] as RangeKey[]).find((r) => r === q.get("range")) ?? "7d";
  const b = q.get("bucket");
  return { range, from: q.get("from") ?? ymd(Date.now() - 6 * DAY), to: q.get("to") ?? ymd(Date.now()), bucket: b === "hour" || b === "day" ? b : null, agent: q.get("agent"), model: q.get("model") };
}
function writeHash(s: ViewState) {
  const q = new URLSearchParams({ range: s.range });
  if (s.range === "custom") (q.set("from", s.from), q.set("to", s.to));
  if (s.bucket) q.set("bucket", s.bucket);
  if (s.agent) q.set("agent", s.agent);
  else if (s.model) q.set("model", s.model);
  history.replaceState(null, "", `#/insight/costs?${q}`);
}
/** The instants the server is asked for; the end is "now" for the rolling ranges. */
function bounds(s: ViewState): { from: number; to: number } {
  const now = Date.now();
  if (s.range === "custom") {
    const from = Date.parse(`${s.from}T00:00:00Z`);
    const to = Math.min(Date.parse(`${s.to}T00:00:00Z`) + DAY, now);
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : { from: now - 7 * DAY, to: now };
  }
  return { from: now - (s.range === "24h" ? 1 : s.range === "7d" ? 7 : 30) * DAY, to: now };
}
const bucketOf = (s: ViewState, span: number): "hour" | "day" => (span > 7 * DAY ? "day" : (s.bucket ?? (span <= 2 * DAY ? "hour" : "day")));

/* ----------------------------------------------------------------------------- data */
/** Loads `fetcher` whenever `key` changes; what's on screen stays (dimmed by the caller) until the new answer arrives. */
function useLoad<T>(key: string | null, fetcher: () => Promise<T>, onSignIn: () => void) {
  const [state, setState] = useState<{ data: T | null; key: string | null; error: string; loading: boolean }>({ data: null, key: null, error: "", loading: false });
  const latest = useRef(0);
  const f = useRef(fetcher);
  f.current = fetcher;
  const signIn = useRef(onSignIn);
  signIn.current = onSignIn;
  const load = useCallback(async () => {
    if (key == null) return;
    const n = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await f.current();
      if (n === latest.current) setState({ data, key, error: "", loading: false });
    } catch (e) {
      if (n !== latest.current) return;
      if (e instanceof SignInRequired) signIn.current();
      setState((s) => ({ ...s, error: (e as Error).message, loading: false }));
    }
  }, [key]);
  useEffect(() => {
    void load();
  }, [load]);
  return { ...state, reload: load };
}

/* ----------------------------------------------------------------------------- colours */
// Categorical slots in fixed order (validated against the board's surfaces, light and dark): a model's slot is its rank by the last
// 30 days' spend, so it keeps its colour whatever range is shown. Past six, models fold into Other.
const SLOTS = 6;
function colourOf(order: string[]) {
  const slot = new Map(order.slice(0, SLOTS).map((m, i) => [m, i + 1]));
  return (model: string) => (slot.has(model) ? `var(--cost-s${slot.get(model)})` : "var(--cost-other)");
}
const seriesKey = (order: string[], model: string) => (order.indexOf(model) >= 0 && order.indexOf(model) < SLOTS ? model : "Other");

/* ----------------------------------------------------------------------------- the page */
let mounted = 0;
export function CostsView({ onSignIn }: { onSignIn: () => void }) {
  const [view, setViewState] = useState<ViewState>(readHash);
  const set = (patch: Partial<ViewState>) =>
    setViewState((v) => {
      const next = { ...v, ...patch };
      writeHash(next);
      return next;
    });
  // Back from a run page (or a pasted link) lands here with the state in the hash.
  useEffect(() => {
    const on = () => location.hash.startsWith("#/insight/costs") && setViewState(readHash());
    window.addEventListener("hashchange", on);
    mounted++;
    return () => {
      window.removeEventListener("hashchange", on);
      mounted--;
      // Tabs switch without touching the hash: leaving Costs drops its link, so a later hash change doesn't bring Costs back.
      // Deferred so a remount (StrictMode) keeps a pasted link.
      setTimeout(() => !mounted && location.hash.startsWith("#/insight/costs?") && history.replaceState(null, "", "#/insight/costs"));
    };
  }, []);

  // Rolling ranges end "now": the key changes only on a control change or Refresh, never on a re-render.
  const [tick, setTick] = useState(0);
  const { from, to } = bounds(view);
  const bucket = bucketOf(view, to - from);
  const rangeKey = `${view.range}|${view.from}|${view.to}|${bucket}|${tick}`;
  // The time chart buckets by the viewer's clock; the custom dates stay UTC; "today" and the limits are the owner's day.
  const query = () => new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket, offset: String(-new Date().getTimezoneOffset()) });
  const ledger = useLoad<CostLedger>(rangeKey, () => api.costLedger(query()), onSignIn);
  const focus: Record<string, string> | null = view.agent ? { agent: view.agent } : view.model ? { model: view.model } : null;
  const topKey = focus ? `${rangeKey}|${view.agent}|${view.model}` : null;
  const top = useLoad<CostTop>(topKey, () => api.costTop(new URLSearchParams({ ...Object.fromEntries(query()), ...focus! })), onSignIn);

  const d = ledger.data;
  const stale = ledger.loading && d != null;
  const drill = useRef<HTMLElement>(null);
  const open = (patch: { agent?: string; model?: string }) => {
    set({ agent: patch.agent ?? null, model: patch.model ?? null });
    requestAnimationFrame(() => drill.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  };

  return (
    <main className="page wide costs-page">
      <header className="page-head cost-head-bar">
        <div className="cost-title">
          <h1>Costs</h1>
          <p className="page-sub">What OpenRouter billed for each model call through the gateway.</p>
        </div>
        <div className="cost-controls">
          <div className="seg-tabs" role="tablist" aria-label="Range">
            {RANGES.map(([r, label]) => (
              <button key={r} role="tab" aria-selected={view.range === r} className={view.range === r ? "on" : ""} onClick={() => set({ range: r })}>
                {label}
              </button>
            ))}
          </div>
          {view.range === "custom" && (
            <div className="cost-dates">
              <input aria-label="From (UTC)" type="date" value={view.from} max={view.to} min={ymd(Date.now() - 61 * DAY)} onChange={(e) => e.target.value && set({ from: e.target.value })} />
              <span aria-hidden>to</span>
              <input aria-label="To (UTC, inclusive)" type="date" value={view.to} min={view.from} max={ymd(Date.now())} onChange={(e) => e.target.value && set({ to: e.target.value })} />
            </div>
          )}
          <div className="seg-tabs" role="tablist" aria-label="Group by">
            {(["hour", "day"] as const).map((b) => (
              <button key={b} role="tab" aria-selected={bucket === b} disabled={b === "hour" && to - from > 7 * DAY} title={b === "hour" && to - from > 7 * DAY ? "Hourly covers up to 7 days" : undefined} className={bucket === b ? "on" : ""} onClick={() => set({ bucket: b })}>
                By {b}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setTick((t) => t + 1)} disabled={ledger.loading}>
            {ledger.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {ledger.error && <div className="offline cost-error">Couldn't load costs: {ledger.error}</div>}

      {!d ? (
        !ledger.error && <CostSkeleton />
      ) : (
        <>
          <Overview d={d} />
          <InsightStrip d={d} />
          <div className={`cost-body${stale ? " cost-stale" : ""}`} aria-busy={ledger.loading}>
            <section className="cost-card cost-chart-card" aria-labelledby="cost-time">
              <div className="cost-card-head">
                <h2 id="cost-time">Spend over time, by model</h2>
                <p className="cost-range-total">
                  <strong>{usd(d.totals.usd)}</strong> in this range · {compact(d.totals.calls)} calls{" "}
                  <Delta cur={d.totals.usd} prev={d.totals.prevUsd} vs="the period before" />
                </p>
              </div>
              <TimeChart d={d} />
              <ModelTable d={d} focus={view.model} onOpen={(model) => open({ model })} />
            </section>
            <div className="cost-split">
              <AgentTable d={d} focus={view.agent} onOpen={(agent) => open({ agent })} />
              <KindList d={d} />
            </div>
            <div className="cost-split">
              <TaskCard d={d} />
              <DepartmentCard d={d} />
            </div>
            <WastedCard d={d} />
            <FeaturesCard onSignIn={onSignIn} />
            <section ref={drill} className="cost-drill-anchor">
              {focus && <Drill top={top.key === topKey ? top.data : null} loading={top.loading} error={top.error} label={view.agent ? (d.agents.find((a) => a.agentId === view.agent)?.name ?? "This agent") : short(view.model!)} onClose={() => set({ agent: null, model: null })} />}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

/* ----------------------------------------------------------------------------- overview */
function Overview({ d }: { d: CostLedger }) {
  const o = d.overview;
  const key = "error" in o.key ? null : o.key;
  const tiles: [string, LedgerPeriod, string][] = [
    ["Today so far", o.today, "yesterday by now"],
    ["Last 7 days", o.week, "the 7 before"],
    ["Last 30 days", o.month, "the 30 before"],
  ];
  return (
    <section className="cost-overview" aria-label="Overview">
      {tiles.map(([label, p, vs]) => (
        <div key={label} className="cost-tile">
          <span className="cost-tile-label" title={label.startsWith("Today") ? "The owner's day so far: the day the install's day limit counts (midnight in the owner's timezone)" : undefined}>{label}</span>
          <span className="cost-tile-value">{usd(p.usd)}</span>
          <Delta cur={p.usd} prev={p.prev} vs={vs} />
          {label.startsWith("Today") && key && <span className="cost-tile-note" title="OpenRouter's own figure for the key: every caller of it, itemised here or not">OpenRouter shows {usd(key.today)} today</span>}
        </div>
      ))}
      <div className="cost-tile cost-limits">
        <span className="cost-tile-label">Limits</span>
        {key?.limit ? (
          <Meter label={`OpenRouter key, ${key.reset ?? "total"}`} used={key.limit - (key.remaining ?? 0)} cap={key.limit} />
        ) : (
          <span className="cost-tile-note">{key ? "The OpenRouter key has no spend limit." : `OpenRouter key: ${"error" in o.key ? o.key.error : ""}`}</span>
        )}
        {o.limits ? (
          <>
            <Meter label="Install, today" used={o.limits.day.spent} cap={o.limits.day.cap} />
            <Meter label="Install, this month (UTC)" used={o.limits.month.spent} cap={o.limits.month.cap} />
            <span className="cost-tile-note">The install's spend limits (settings spend_day_usd spend_month_usd and task_usd): model calls stop at a limit.</span>
          </>
        ) : (
          <span className="cost-tile-note">The install's spend limits are not available.</span>
        )}
      </div>
    </section>
  );
}

/** Spend against a limit: the fill turns amber past 70% and red past 90%. */
function Meter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const share = cap > 0 ? Math.min(1, used / cap) : 0;
  const level = share >= 0.9 ? "bad" : share >= 0.7 ? "warn" : "ok";
  return (
    <div className="cost-meter">
      <div className="cost-meter-text">
        <span className="cost-meter-label">{label}</span>
        <span className="cost-meter-value">
          {usd(used)} <span className="muted">of {usd(cap)}</span>
        </span>
      </div>
      <div className={`cost-meter-track ${level}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.round(used * 100) / 100} aria-valuetext={`${usd(used)} of ${usd(cap)}`}>
        <div style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- time chart */
/** Bucket keys (YYYY-MM-DD[THH]) are the viewer's wall-clock hours or days: the server shifted them by d.offset minutes. */
function buckets(d: CostLedger): string[] {
  const step = d.bucket === "hour" ? 36e5 : DAY;
  const len = d.bucket === "hour" ? 13 : 10;
  const shift = d.offset * 6e4;
  const out: string[] = [];
  for (let t = Math.floor((Date.parse(d.from) + shift) / step) * step; t < Date.parse(d.to) + shift; t += step) out.push(new Date(t).toISOString().slice(0, len));
  return out;
}
const wallMs = (t: string, hour: boolean) => Date.parse(hour ? `${t}:00:00Z` : `${t}T00:00:00Z`);
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fmtHour = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts(), timeZone: "UTC" });
/** The bucket's start in UTC, for hover. */
const utcStart = (t: string, hour: boolean, offset: number) => `${fmtHour(wallMs(t, hour) - offset * 6e4)} UTC`;
const bucketLabel = (t: string, hour: boolean) => (hour ? fmtHour(wallMs(t, hour)) : fmtDay(wallMs(t, hour)));
const tickLabel = (t: string, hour: boolean) => (hour && !t.endsWith("T00") ? new Date(wallMs(t, hour)).toLocaleTimeString(undefined, { ...clockOpts(), timeZone: "UTC" }) : fmtDay(wallMs(t, hour)));
/** A round axis maximum and its steps: 1, 2 or 5 × a power of ten. */
function niceMax(v: number): number[] {
  if (v <= 0) return [0, 0.01];
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(v / step) + 1 }, (_, i) => i * step);
}

function TimeChart({ d }: { d: CostLedger }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hour = d.bucket === "hour";
  const xs = buckets(d);
  const colour = colourOf(d.modelOrder);
  // Series in fixed colour order (slot 1 at the baseline), Other on top.
  const present = new Set(d.series.map((s) => seriesKey(d.modelOrder, s.model)));
  const keys = [...d.modelOrder.slice(0, SLOTS), "Other"].filter((k) => present.has(k));
  const cell = new Map<string, number>();
  for (const s of d.series) {
    const k = `${s.t}|${seriesKey(d.modelOrder, s.model)}`;
    cell.set(k, (cell.get(k) ?? 0) + s.usd);
  }
  const totals = xs.map((t) => keys.reduce((s, k) => s + (cell.get(`${t}|${k}`) ?? 0), 0));
  const ticks = niceMax(Math.max(...totals, 0));
  const max = ticks[ticks.length - 1]!;
  const H = 220, top = 8, bottom = 24, left = 52, right = 8;
  const plotW = w - left - right, plotH = H - top - bottom;
  const band = plotW / Math.max(1, xs.length);
  const barW = Math.max(2, Math.min(28, band * 0.72));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const every = Math.max(1, Math.ceil(xs.length / Math.floor(plotW / 64)));
  const tip = hover != null ? xs[hover] : null;

  if (!d.series.length) return <p className="cost-empty">No billed calls in this range.</p>;
  return (
    <div className="cost-chart" ref={wrap}>
      <ul className="cost-legend" aria-label="Models">
        {keys.map((k) => (
          <li key={k}>
            <span className="cost-swatch" style={{ background: k === "Other" ? "var(--cost-other)" : colour(k) }} />
            {k === "Other" ? "Other models" : short(k)}
          </li>
        ))}
      </ul>
      <svg width={w} height={H} role="img" aria-label={`Spend by ${d.bucket} and model; the table below lists each model's total`} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={w - right} y1={y(t)} y2={y(t)} className={t === 0 ? "cost-axis" : "cost-grid"} />
            <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="cost-tick">
              {usd(t)}
            </text>
          </g>
        ))}
        {xs.map((t, i) => {
          const x = left + band * i + (band - barW) / 2;
          let acc = 0;
          const segs = keys.flatMap((k) => {
            const v = cell.get(`${t}|${k}`) ?? 0;
            if (v <= 0) return [];
            const y0 = y(acc), y1 = y(acc + v);
            acc += v;
            return [{ k, y0, y1 }];
          });
          return (
            <g key={t}>
              {hover === i && <rect x={left + band * i} y={top} width={band} height={plotH} className="cost-hover-band" />}
              {segs.map((s, j) => {
                // A 2px surface gap between stacked segments; the top segment's end is rounded.
                const h = Math.max(0, s.y0 - s.y1 - (j > 0 ? 2 : 0));
                if (h < 0.5) return null;
                const last = j === segs.length - 1;
                const r = last ? Math.min(3, barW / 2, h) : 0;
                const yTop = s.y1;
                return <path key={s.k} d={roundTop(x, yTop, barW, h, r)} style={{ fill: s.k === "Other" ? "var(--cost-other)" : colour(s.k) }} />;
              })}
              <rect
                x={left + band * i}
                y={top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${bucketLabel(t, hour)}, ${utcStart(t, hour, d.offset)}: ${usd(totals[i]!)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="cost-hit"
              />
              {i % every === 0 && (
                <text x={left + band * i + band / 2} y={H - 6} textAnchor="middle" className="cost-tick">
                  <title>{utcStart(t, hour, d.offset)}</title>
                  {tickLabel(t, hour)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tip != null && hover != null && (
        // Beside the hovered column, never over it: right of it when there's room, else left.
        <div className="cost-tip" style={{ left: left + band * (hover + 1) + 8 + 220 <= w ? left + band * (hover + 1) + 8 : Math.max(0, left + band * hover - 228) }} role="status">
          <div className="cost-tip-head">
            {bucketLabel(tip, hour)}
            <span className="cost-tip-utc">{hour ? "" : "from "}{utcStart(tip, hour, d.offset)}</span>
          </div>
          <div className="cost-tip-total">
            <strong>{usd(totals[hover]!)}</strong> total
          </div>
          {[...keys].reverse().map((k) => {
            const v = cell.get(`${tip}|${k}`) ?? 0;
            if (!v) return null;
            return (
              <div key={k} className="cost-tip-row">
                <span className="cost-tip-key" style={{ background: k === "Other" ? "var(--cost-other)" : colour(k) }} />
                <strong>{usd(v)}</strong>
                <span className="muted">{k === "Other" ? "Other models" : short(k)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
/** A bar segment with only its top corners rounded (the baseline end stays square). */
const roundTop = (x: number, y: number, w: number, h: number, r: number) => `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;

/* ----------------------------------------------------------------------------- tables */
type Col<T> = { key: string; label: string; cls?: string; value: (r: T) => number | string; render?: (r: T) => ReactNode; title?: string };
function useSort<T>(cols: Col<T>[], first: string) {
  const [sort, setSort] = useState({ key: first, desc: true });
  const col = cols.find((c) => c.key === sort.key) ?? cols[0]!;
  const sorted = (rows: T[]) =>
    [...rows].sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
    });
  const head = (
    <div className="ct-row ct-head" role="row">
      {cols.map((c) => (
        <button key={c.key} role="columnheader" title={c.title} className={`${c.cls ?? ""}${sort.key === c.key ? " sorted" : ""}`} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"} onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== "name" }))}>
          {c.label}
          {sort.key === c.key && <span aria-hidden>{sort.desc ? " ↓" : " ↑"}</span>}
        </button>
      ))}
    </div>
  );
  return { head, sorted };
}

function ModelTable({ d, focus, onOpen }: { d: CostLedger; focus: string | null; onOpen: (model: string) => void }) {
  const colour = colourOf(d.modelOrder);
  const total = d.totals.usd;
  type R = CostLedger["models"][number];
  const cols: Col<R>[] = [
    { key: "name", label: "Model", cls: "ct-name", value: (r) => r.model, render: (r) => (
      <>
        <span className="cost-swatch" style={{ background: colour(r.model) }} />
        <span className="ct-strong" title={r.model}>{short(r.model)}</span>
      </>
    ) },
    { key: "usd", label: "Spend", cls: "ct-usd", value: (r) => r.usd, render: (r) => usd(r.usd) },
    { key: "share", label: "Share", value: (r) => r.usd, render: (r) => (total ? pct(r.usd / total) : "—") },
    { key: "calls", label: "Calls", value: (r) => r.calls, render: (r) => compact(r.calls) },
    { key: "input", label: "Input", cls: "ct-wide", value: (r) => r.input, render: (r) => compact(r.input), title: "Uncached input tokens" },
    { key: "cached", label: "Cached", cls: "ct-wide", value: (r) => r.cached, render: (r) => compact(r.cached), title: "Input tokens read from the cache" },
    { key: "output", label: "Output", cls: "ct-wide", value: (r) => r.output, render: (r) => compact(r.output), title: "Output tokens, reasoning included" },
    { key: "hit", label: "Cache hit", value: (r) => cacheHit(r) ?? -1, render: (r) => (cacheHit(r) == null ? "—" : pct(cacheHit(r)!)), title: "Cached input over all input" },
    { key: "ms", label: "Avg latency", cls: "ct-wide", value: (r) => r.ms ?? -1, render: (r) => secs(r.ms), title: "Mean time per successful call (calls that recorded one)" },
    { key: "errors", label: "Errors", value: (r) => r.errors, render: (r) => (r.errors ? <span className="ct-bad">{r.errors}</span> : "0"), title: "Calls that ended in a refusal or an upstream failure" },
    { key: "interrupted", label: "Interrupted", value: (r) => r.interrupted, render: (r) => compact(r.interrupted), title: "Calls cut off before their final usage (a kernel restart, a cut or usage-less stream); their spend is what OpenRouter billed for them" },
  ];
  const { head, sorted } = useSort(cols, "usd");
  return (
    <div className="ct ct-models" role="table" aria-label="Spend by model">
      {head}
      {sorted(d.models).map((r) => (
        <button key={r.model} role="row" className={`ct-row ct-click${focus === r.model ? " on" : ""}`} onClick={() => onOpen(r.model)} aria-label={`${short(r.model)}: ${usd(r.usd)}; show its top runs and tasks`}>
          {cols.map((c) => (
            <span key={c.key} role="cell" className={c.cls}>
              {c.render ? c.render(r) : String(c.value(r))}
            </span>
          ))}
        </button>
      ))}
    </div>
  );
}

function AgentTable({ d, focus, onOpen }: { d: CostLedger; focus: string | null; onOpen: (agentId: string) => void }) {
  type R = CostLedger["agents"][number];
  const cols: Col<R>[] = [
    { key: "name", label: "Agent", cls: "ct-name", value: (r) => r.name.toLowerCase(), render: (r) => (
      <span className="ct-stack">
        <span className="ct-strong">{r.name}</span>
        {r.model && <span className="ct-sub">{short(r.model)}</span>}
      </span>
    ) },
    { key: "usd", label: "Spend", cls: "ct-usd", value: (r) => r.usd, render: (r) => usd(r.usd) },
    { key: "calls", label: "Calls", value: (r) => r.calls, render: (r) => compact(r.calls) },
    { key: "per", label: "$ / call", cls: "ct-wide", value: (r) => (r.calls ? r.usd / r.calls : 0), render: (r) => (r.calls ? `$${(r.usd / r.calls).toPrecision(2)}` : "—") },
    { key: "today", label: "Today", cls: "ct-usd", value: (r) => r.today, render: (r) => usd(r.today) },
  ];
  const { head, sorted } = useSort(cols, "usd");
  const system = d.lanes.filter((l) => !["agent", "advisor", "fanout", "engineer"].includes(l.lane)).reduce((s, l) => s + l.usd, 0);
  return (
    <section className="cost-card" aria-labelledby="cost-agents">
      <div className="cost-card-head">
        <h2 id="cost-agents">By agent</h2>
        <p className="muted">Each agent's spend with its main model. Pick one for its top runs and tasks.</p>
      </div>
      <div className="ct ct-agents" role="table" aria-label="Spend by agent">
        {head}
        {!d.agents.length && <p className="cost-empty">No agent calls in this range.</p>}
        {sorted(d.agents).map((r) => (
          <button key={r.agentId} role="row" className={`ct-row ct-click${focus === r.agentId ? " on" : ""}`} onClick={() => onOpen(r.agentId)} aria-label={`${r.name}: ${usd(r.usd)}; show its top runs and tasks`}>
            {cols.map((c) => (
              <span key={c.key} role="cell" className={c.cls}>
                {c.render ? c.render(r) : String(c.value(r))}
              </span>
            ))}
          </button>
        ))}
      </div>
      {system > 0 && <p className="cost-foot">System calls (reviewer, grader, sources, app CI code review) are not any agent's: {usd(system)} in this range, under By kind.</p>}
    </section>
  );
}

function KindList({ d }: { d: CostLedger }) {
  const max = Math.max(...d.lanes.map((l) => l.usd), 0);
  return (
    <section className="cost-card" aria-labelledby="cost-kinds">
      <div className="cost-card-head">
        <h2 id="cost-kinds">By kind of call</h2>
        <p className="muted">Agents' own turns, and the work around them.</p>
      </div>
      <ul className="cost-kinds">
        {d.lanes.map((l) => (
          <li key={l.lane}>
            <div className="cost-kind-text">
              <span className="ct-strong">{lane(l.lane)}</span>
              <span>
                <strong>{usd(l.usd)}</strong> <span className="muted">· {d.totals.usd ? pct(l.usd / d.totals.usd) : "—"} · {compact(l.calls)} calls</span>
              </span>
            </div>
            <div className="cost-kind-bar" aria-hidden>
              <span style={{ width: `${max ? Math.max(l.usd > 0 ? 1 : 0, (l.usd / max) * 100) : 0}%` }} />
            </div>
          </li>
        ))}
        {!d.lanes.length && <li className="cost-empty">No calls in this range.</li>}
      </ul>
    </section>
  );
}

/* ----------------------------------------------------------------------------- drill-down */
function Drill({ top, loading, error, label, onClose }: { top: CostTop | null; loading: boolean; error: string; label: string; onClose: () => void }) {
  const byModel = Boolean(top?.filter.model);
  return (
    <div className={`cost-card cost-drill${loading && top ? " cost-stale" : ""}`}>
      <div className="cost-card-head">
        <h2>{label}: where the money went</h2>
        {top && (
          <p className="muted">
            {usd(top.total.usd)} over {compact(top.total.calls)} calls · {compact(top.total.input + top.total.cached + top.total.output)} tokens
            {cacheHit(top.total) != null && ` · ${pct(cacheHit(top.total)!)} cache hit`}
          </p>
        )}
        <button className="btn cost-close" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <p className="ct-bad">Couldn't load: {error}</p>}
      {!top ? (
        <div className="cost-skel" style={{ height: 160 }} />
      ) : (
        <div className="cost-drill-grid">
          <div>
            <h3>{byModel ? "By agent" : "By model"}</h3>
            <ul className="cost-kinds">
              {top.split.map((s) => (
                <li key={s.name}>
                  <div className="cost-kind-text">
                    <span className="ct-strong">{byModel ? s.name : short(s.name)}</span>
                    <span>
                      <strong>{usd(s.usd)}</strong> <span className="muted">· {compact(s.calls)} calls</span>
                    </span>
                  </div>
                  <div className="cost-kind-bar" aria-hidden>
                    <span style={{ width: `${top.total.usd ? (s.usd / top.total.usd) * 100 : 0}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Top tasks</h3>
            <ol className="cost-top">
              {top.tasks.map((t) => (
                <li key={t.issueId}>
                  <a href={`#/t/${encodeURIComponent(t.identifier ?? t.issueId)}`} className="cost-top-name">
                    {t.identifier && <span className="cost-top-id">{t.identifier}</span>}
                    {t.title ?? "Task"}
                  </a>
                  <span className="cost-top-meta">
                    <strong>{usd(t.usd)}</strong> · {compact(t.calls)} calls{byModel && t.agent ? ` · ${t.agent}` : ""}
                  </span>
                </li>
              ))}
              {!top.tasks.length && <li className="muted">No calls tied to a task.</li>}
            </ol>
            {top.noTask >= 0.01 && <p className="cost-foot">{usd(top.noTask)} of it came from calls that name no task.</p>}
          </div>
          <div>
            <h3>Top runs</h3>
            <ol className="cost-top">
              {top.runs.map((r) => (
                <li key={r.runId}>
                  <a href={`#/r/${r.runId}`} className="cost-top-name">
                    Run {r.runId.slice(0, 8)}
                    {byModel && r.agent ? ` · ${r.agent}` : ""}
                  </a>
                  <span className="cost-top-meta">
                    <strong>{usd(r.usd)}</strong> · {compact(r.calls)} calls · {when(r.first)}
                  </span>
                </li>
              ))}
              {!top.runs.length && <li className="muted">No calls tied to a run.</li>}
            </ol>
            {top.noRun >= 0.01 && <p className="cost-foot">{usd(top.noRun)} of it came from calls whose credential names no Paperclip run, so they have no run page.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------- insights */
const thisMonth = () => new Date().toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
const signed = (n: number) => `${n < 0 ? "−" : "+"}${usd(Math.abs(n))}`;
const COVERAGE_WORDS = { accurate: "Accurate", gap: "Gap", unverified: "Not yet checkable", unavailable: "Unavailable" } as const;

/** Four answers above the charts: where the month is heading, what caching saves, what was wasted, and whether the ledger is complete. */
function InsightStrip({ d }: { d: CostLedger }) {
  const { forecast: f, cache, wasted: w, coverage: c } = d.insights;
  const waste = w.failed.usd + w.cancelled.usd + w.looping.usd;
  return (
    <section className="cost-insights" aria-label="Insights">
      <div className="cost-insight">
        <span className="cost-tile-label">Forecast for {thisMonth()}</span>
        <span className="cost-tile-value">{f.projected == null ? "—" : usd(f.projected)}</span>
        <span className="cost-insight-line">{f.projected == null ? "Needs 6 hours of ledger history." : `${usd(f.monthToDate)} so far, ${usd(f.perDay)} a day, ${Math.round(f.daysLeft)} days left`}</span>
        <span className="cost-tile-note">Month so far plus the last 7 days' daily average for the days left.{f.partialMonth ? " The ledger began mid-month, so earlier days are missing." : ""}</span>
      </div>
      <div className="cost-insight">
        <span className="cost-tile-label">Saved by caching</span>
        <span className="cost-tile-value">{cache.savedUsd == null ? "—" : usd(cache.savedUsd)}</span>
        <span className="cost-insight-line">{cache.hit == null ? "No input in this range." : `${pct(cache.hit)} of input came from the cache`}</span>
        <span className="cost-tile-note">Cached tokens × the list price gap between fresh and cached input. List prices, so an estimate; routing can bill more.</span>
      </div>
      <div className={`cost-insight${waste >= 0.01 ? " warn" : ""}`}>
        <span className="cost-tile-label">Wasted spend</span>
        <span className="cost-tile-value">{usd(waste)}</span>
        <span className="cost-insight-line">
          {usd(w.failed.usd)} failed · {usd(w.cancelled.usd)} cancelled · {usd(w.looping.usd)} looping
        </span>
        <span className="cost-tile-note">At most, as a looping run on a cancelled task counts twice. Lists below.</span>
      </div>
      <div className={`cost-insight cost-cover ${c.state}`}>
        <span className="cost-tile-label">Is every call counted?</span>
        <span className="cost-cover-state">
          <span className="cost-cover-dot" aria-hidden />
          {COVERAGE_WORDS[c.state]}
        </span>
        {c.error && <span className="cost-tile-note">OpenRouter's own figure is missing: {c.error}</span>}
        <ul className="cost-cover-rows">
          {c.periods.map((p) => (
            <li key={p.name} className={p.state} title={p.state === "partial" ? `The ledger starts ${when(d.earliest)}, after this period began, so it can't be compared` : `OpenRouter ${usd(p.real)} against ${usd(p.ledger)} itemised`}>
              <span>{p.name}</span>
              {p.state === "partial" ? (
                <span className="muted">ledger starts {when(d.earliest)}</span>
              ) : (
                <span>
                  {p.state === "accurate" ? "matches" : `${signed(p.gap)} (${pct(Math.abs(p.share))})`} <span className="muted">of {usd(p.real)}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
        <span className="cost-tile-note">Gateway ledger against OpenRouter's counter for the key. A gap means calls that skip the gateway.</span>
      </div>
    </section>
  );
}

function TaskCard({ d }: { d: CostLedger }) {
  const t = d.insights.tasks;
  return (
    <section className="cost-card" aria-labelledby="cost-tasks">
      <div className="cost-card-head">
        <h2 id="cost-tasks">Costliest tasks</h2>
        <p className="muted">{t.count ? `${compact(t.count)} tasks spent ${usd(t.usd)} in this range.` : "No calls tied to a task in this range."}</p>
      </div>
      {t.count > 0 && (
        <dl className="cost-facts cost-task-facts">
          <dt>Average per task</dt>
          <dd>{usd(t.perTask)}</dd>
          <dt title={`Among the ${t.sampled} costliest tasks, which are the ones looked up in Paperclip. Cheap tasks are not in it, so it runs high.`}>Average per finished task</dt>
          <dd>
            {usd(t.done.perTask)} {t.done.count > 0 && <span className="muted">median {usd(t.done.median)}, {t.done.count} done of the top {t.sampled}</span>}
          </dd>
        </dl>
      )}
      <ol className="cost-top">
        {t.top.map((x) => (
          <li key={x.issueId}>
            <a href={`#/t/${encodeURIComponent(x.identifier ?? x.issueId)}`} className="cost-top-name">
              {x.identifier && <span className="cost-top-id">{x.identifier}</span>}
              {x.title ?? "Task"}
            </a>
            <span className="cost-top-meta">
              <strong>{usd(x.usd)}</strong> · {compact(x.calls)} calls · {x.agent}
              {x.status && <span className={`cost-status ${x.status}`}>{x.status.replace(/_/g, " ")}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The last 14 days' features (a top-level task and what was delegated under it): what each cost and how long it took. */
function FeaturesCard({ onSignIn }: { onSignIn: () => void }) {
  const { data, error } = useLoad("features", () => api.features(), onSignIn);
  const cols: Col<FeatureCost>[] = [
    { key: "name", label: "Feature", cls: "ct-name", value: (r) => r.createdAt, render: (r) => (
      <a href={`#/t/${encodeURIComponent(r.identifier)}`} className="ct-strong" title={r.title}>
        <span className="cost-top-id">{r.identifier}</span> {r.title}
      </a>
    ) },
    { key: "usd", label: "Spend", cls: "ct-usd", value: (r) => r.usd, render: (r) => usd(r.usd) },
    { key: "elapsed", label: "Elapsed", value: (r) => r.elapsedMs, render: (r) => `${duration(r.elapsedMs)}${r.running ? " so far" : ""}`, title: "From the first task's creation to the last completion or merge (to now while work is open)" },
    { key: "jobs", label: "Jobs", value: (r) => r.jobs, render: (r) => String(r.jobs) },
    { key: "jobtime", label: "Job time", cls: "ct-wide", value: (r) => r.jobMs, render: (r) => (r.jobs ? duration(r.jobMs) : "—"), title: "The time its agents' jobs ran: the span of each job's model calls" },
    { key: "prs", label: "PRs merged", value: (r) => r.prs, render: (r) => String(r.prs) },
    { key: "tasks", label: "Tasks", cls: "ct-wide", value: (r) => r.tasks, render: (r) => String(r.tasks) },
  ];
  const { head, sorted } = useSort(cols, "name");
  return (
    <section className="cost-card" aria-labelledby="cost-features">
      <div className="cost-card-head">
        <h2 id="cost-features">Features, last 14 days</h2>
        <p className="muted">
          A task with everything delegated under it.
          {data && data.unattributed.calls > 0 && ` ${compact(data.unattributed.calls)} calls (${usd(data.unattributed.usd)}) named no task and are in none.`}
        </p>
      </div>
      {error && <div className="offline cost-error">Couldn't load features: {error}</div>}
      {data && !data.features.length && <p className="muted">No task with delegated work was started in the last 14 days.</p>}
      {data && data.features.length > 0 && (
        <div className="ct ct-features" role="table" aria-label="Features">
          {head}
          {sorted(data.features).map((r) => (
            <div key={r.identifier} role="row" className="ct-row">
              {cols.map((c) => (
                <span key={c.key} role="cell" className={c.cls}>
                  {c.render ? c.render(r) : String(c.value(r))}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DepartmentCard({ d }: { d: CostLedger }) {
  const deps = d.insights.departments;
  const max = Math.max(...deps.map((x) => x.usd), 0);
  return (
    <section className="cost-card" aria-labelledby="cost-depts">
      <div className="cost-card-head">
        <h2 id="cost-depts">By department</h2>
        <p className="muted">As the Agents page groups them.</p>
      </div>
      <ul className="cost-kinds">
        {deps.map((x) => (
          <li key={x.id}>
            <div className="cost-kind-text">
              <span className="ct-strong">
                {x.name} {x.agents > 0 && <span className="muted">{x.agents} agent{x.agents === 1 ? "" : "s"}</span>}
              </span>
              <span>
                <strong>{usd(x.usd)}</strong> <span className="muted">· {d.totals.usd ? pct(x.usd / d.totals.usd) : "—"}</span>
              </span>
            </div>
            <div className="cost-kind-bar" aria-hidden>
              <span style={{ width: `${max ? Math.max(x.usd > 0 ? 1 : 0, (x.usd / max) * 100) : 0}%` }} />
            </div>
          </li>
        ))}
        {!deps.length && <li className="cost-empty">No calls in this range.</li>}
      </ul>
    </section>
  );
}

function WastedCard({ d }: { d: CostLedger }) {
  const w = d.insights.wasted;
  return (
    <section className="cost-card" aria-labelledby="cost-wasted">
      <div className="cost-card-head">
        <h2 id="cost-wasted">Wasted spend</h2>
        <p className="muted">Money that bought nothing: failed calls, work on cancelled tasks, runs that looped.</p>
      </div>
      <div className="cost-drill-grid cost-waste-grid">
        <div>
          <h3>
            Failed calls <span className="cost-waste-usd">{usd(w.failed.usd)}</span>
          </h3>
          <p className="cost-waste-note">{compact(w.failed.calls)} calls ended in a refusal or an upstream error.</p>
          <ol className="cost-top">
            {w.failed.list.map((x) => (
              <li key={`${x.agent}${x.status}`}>
                <span className="cost-top-name">{x.agent}</span>
                <span className="cost-top-meta">
                  <strong>{usd(x.usd)}</strong> · {compact(x.calls)} × {x.status.replace(/_/g, " ")}
                </span>
              </li>
            ))}
            {!w.failed.list.length && <li className="muted">None in this range.</li>}
          </ol>
        </div>
        <div>
          <h3>
            Cancelled tasks <span className="cost-waste-usd">{usd(w.cancelled.usd)}</span>
          </h3>
          <p className="cost-waste-note">Spent on tasks that ended cancelled, among the {d.insights.tasks.sampled} costliest.</p>
          <ol className="cost-top">
            {w.cancelled.list.map((x) => (
              <li key={x.issueId}>
                <a href={`#/t/${encodeURIComponent(x.identifier ?? x.issueId)}`} className="cost-top-name">
                  {x.identifier && <span className="cost-top-id">{x.identifier}</span>}
                  {x.title ?? "Task"}
                </a>
                <span className="cost-top-meta">
                  <strong>{usd(x.usd)}</strong> · {compact(x.calls)} calls · {x.agent}
                </span>
              </li>
            ))}
            {!w.cancelled.list.length && <li className="muted">None in this range.</li>}
          </ol>
        </div>
        <div>
          <h3>
            Looping runs <span className="cost-waste-usd">{usd(w.looping.usd)}</span>
          </h3>
          <p className="cost-waste-note">{w.looping.count} runs made {w.looping.threshold} calls or more. Their whole spend is counted.</p>
          <ol className="cost-top">
            {w.looping.list.map((x) => (
              <li key={x.runId}>
                <a href={`#/r/${x.runId}`} className="cost-top-name">
                  Run {x.runId.slice(0, 8)} · {x.agent}
                </a>
                <span className="cost-top-meta">
                  <strong>{usd(x.usd)}</strong> · {compact(x.calls)} calls · {when(x.first)}
                </span>
              </li>
            ))}
            {!w.looping.list.length && <li className="muted">None in this range.</li>}
          </ol>
        </div>
      </div>
    </section>
  );
}

function CostSkeleton() {
  return (
    <div className="cost-skeleton" aria-busy="true" aria-label="Loading costs">
      <div className="cost-overview">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="cost-skel" style={{ height: 112 }} />
        ))}
      </div>
      <div className="cost-insights">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="cost-skel" style={{ height: 150 }} />
        ))}
      </div>
      <div className="cost-skel" style={{ height: 320 }} />
      <div className="cost-split">
        <div className="cost-skel" style={{ height: 240 }} />
        <div className="cost-skel" style={{ height: 240 }} />
      </div>
    </div>
  );
}
