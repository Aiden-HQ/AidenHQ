// The Flow page's charts (Flow.tsx): small hand-written SVG, drawn at the container's real width so text stays crisp. Every
// chart has an accessible label, a hover/focus tooltip (useTip), and says "Flow fills in as work happens." when it has no data.
// Colours come from tokens: --series-N for categories (fixed order), ink tokens for text.
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

export const EMPTY = "Flow fills in as work happens.";
export const series = (i: number) => `var(--series-${((i % 9) + 9) % 9})`;

/* ----------------------------------------------------------------------------- tooltip */
type TipState = { x: number; y: number; body: React.ReactNode } | null;
const TipCtx = createContext<{ show: (at: { clientX: number; clientY: number } | Element, body: React.ReactNode) => void; hide: () => void }>({ show: () => {}, hide: () => {} });

/** One floating tooltip for everything inside: beside the pointer (or the focused mark), kept inside the window. */
export function TipLayer({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<TipState>(null);
  const el = useRef<HTMLDivElement>(null);
  const show = useCallback((at: { clientX: number; clientY: number } | Element, body: React.ReactNode) => {
    if (at instanceof Element) {
      const r = at.getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.bottom, body });
    } else setTip({ x: at.clientX, y: at.clientY, body });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!tip || !el.current) return setPos(null);
    const w = el.current.offsetWidth, h = el.current.offsetHeight;
    const left = tip.x + 14 + w > innerWidth - 8 ? Math.max(8, tip.x - 14 - w) : tip.x + 14;
    const top = tip.y + 14 + h > innerHeight - 8 ? Math.max(8, tip.y - 14 - h) : tip.y + 14;
    setPos({ left, top });
  }, [tip]);
  return (
    <TipCtx.Provider value={{ show, hide }}>
      {children}
      {tip && (
        <div ref={el} className="fl-tip" role="tooltip" style={pos ?? { left: -9999, top: 0 }}>
          {tip.body}
        </div>
      )}
    </TipCtx.Provider>
  );
}
export const useTip = () => useContext(TipCtx);

/** Hover and focus handlers that show `body` for one mark. */
export function tipProps(tip: ReturnType<typeof useTip>, body: () => React.ReactNode) {
  return {
    onPointerMove: (e: React.PointerEvent) => tip.show(e, body()),
    onPointerLeave: tip.hide,
    onFocus: (e: React.FocusEvent) => tip.show(e.currentTarget, body()),
    onBlur: tip.hide,
  };
}

/** A tooltip's lines: a heading, then label/value rows with an optional colour key. */
export function TipBody({ head, rows, foot }: { head: React.ReactNode; rows?: [React.ReactNode, React.ReactNode, string?][]; foot?: React.ReactNode }) {
  return (
    <>
      <div className="fl-tip-head">{head}</div>
      {rows?.map(([k, v, c], i) => (
        <div key={i} className="fl-tip-row">
          {c ? <i style={{ background: c }} /> : <span />}
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
      {foot && <div className="fl-tip-foot">{foot}</div>}
    </>
  );
}

/* ----------------------------------------------------------------------------- sizing and scales */
/** A callback ref plus the node's width: it measures whenever the node appears (a chart that mounted empty gets its plot later). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

/** Round axis ticks from 0 to a little over `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => +(i * step).toFixed(10));
}

/** Round duration ticks (1m, 5m, 1h, 6h, 1d …) from 0 to a little over `max` seconds. */
export function durTicks(max: number, count = 4): number[] {
  const steps = [60, 300, 600, 900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86_400, 2 * 86_400, 7 * 86_400];
  const step = steps.find((x) => max / x <= count) ?? 7 * 86_400;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/** Duration ticks for a log axis, in seconds. */
const LOG_TICKS = [60, 600, 3600, 6 * 3600, 86_400, 7 * 86_400, 30 * 86_400];
export function logScale(min: number, max: number, a: number, b: number) {
  const lo = Math.log(Math.max(1, min)), hi = Math.log(Math.max(min + 1, max));
  const f = (v: number) => a + ((Math.log(Math.max(1, v)) - lo) / (hi - lo || 1)) * (b - a);
  return { f, ticks: LOG_TICKS.filter((t) => t >= min && t <= max) };
}

/** A short date label: "Nov 12". */
export const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function Empty() {
  return <p className="fl-empty">{EMPTY}</p>;
}

/** A chart's legend: a swatch and a name per series, always shown for two or more. */
export function Legend({ items }: { items: { label: string; color: string; hatch?: boolean }[] }) {
  return (
    <ul className="fl-legend">
      {items.map((x) => (
        <li key={x.label}>
          <i className={x.hatch ? "hatch" : ""} style={{ background: x.color }} />
          {x.label}
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------------------- sparkline */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return <svg className="fl-spark" aria-hidden />;
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const W = 100, H = 28;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join("");
  const [li, lv] = pts.at(-1)!;
  return (
    <svg className="fl-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`${d}L${x(li)},${H}L${x(pts[0]![0])},${H}Z`} className="fl-spark-area" />
      <path d={d} className="fl-spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={x(li)} cy={y(lv)} r="2.2" className="fl-spark-dot" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ----------------------------------------------------------------------------- columns (stacked or grouped) */
export interface ColSeries { key: string; label: string; color: string }
export function Columns({ xs, series: ss, value, mode = "stack", fmt, label, height = 200, xLabel = day, durations = false }: {
  xs: string[]; series: ColSeries[]; value: (x: number, s: string) => number | null; mode?: "stack" | "group"; fmt: (v: number) => string; label: string; height?: number; xLabel?: (x: string) => string;
  /** Values are seconds: ticks at round durations. */
  durations?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const totals = xs.map((_, i) => (mode === "stack" ? ss.reduce((a, s) => a + (value(i, s.key) ?? 0), 0) : Math.max(0, ...ss.map((s) => value(i, s.key) ?? 0))));
  if (!xs.length || totals.every((t) => !t)) return <Empty />;
  const ticks = (durations ? durTicks : niceTicks)(Math.max(...totals));
  const max = ticks.at(-1)!;
  const top = 8, bottom = 22, left = 44, right = 4, H = height;
  const plotW = Math.max(10, w - left - right), plotH = H - top - bottom;
  const band = plotW / xs.length;
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const barW = mode === "stack" ? Math.max(2, Math.min(32, band * 0.66)) : Math.max(1.5, Math.min(14, (band * 0.7) / ss.length));
  const every = Math.max(1, Math.ceil(xs.length / Math.max(1, Math.floor(plotW / 70))));
  return (
    <div className="fl-chart">
      {ss.length > 1 && <Legend items={ss} />}
      <div ref={ref} className="fl-plot">{w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={w - right} y1={y(t)} y2={y(t)} className={t ? "fl-grid" : "fl-axis"} />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fl-tick">{fmt(t)}</text>
            </g>
          ))}
          {xs.map((x, i) => {
            let acc = 0;
            const segs = ss.map((s, j) => {
              const v = value(i, s.key) ?? 0;
              if (mode === "group") return v > 0 ? <rect key={s.key} x={left + band * i + (band - barW * ss.length) / 2 + j * barW} y={y(v)} width={Math.max(1, barW - 1)} height={y(0) - y(v)} rx={Math.min(2, barW / 3)} style={{ fill: s.color }} /> : null;
              if (v <= 0) return null;
              const y0 = y(acc), y1 = y(acc + v);
              acc += v;
              return <rect key={s.key} x={left + band * i + (band - barW) / 2} y={y1} width={barW} height={Math.max(0.5, y0 - y1 - (acc > v ? 1.5 : 0))} rx={1.5} style={{ fill: s.color }} />;
            });
            const body = () => <TipBody head={xLabel(x)} rows={ss.map((s): [string, string, string] => [s.label, value(i, s.key) == null ? "—" : fmt(value(i, s.key)!), s.color])} />;
            return (
              <g key={x}>
                {segs}
                <rect x={left + band * i} y={top} width={band} height={plotH} className="fl-hit" tabIndex={0} aria-label={`${xLabel(x)}: ${ss.map((s) => `${s.label} ${value(i, s.key) == null ? "none" : fmt(value(i, s.key)!)}`).join(", ")}`} {...tipProps(tip, body)} />
                {i % every === 0 && <text x={left + band * i + band / 2} y={H - 6} textAnchor="middle" className="fl-tick">{xLabel(x)}</text>}
              </g>
            );
          })}
        </svg>
      )}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- lines and stacked area */
export function Lines({ xs, series: ss, value, fmt, label, height = 180, stacked = false, yMax, xLabel = day }: {
  xs: string[]; series: ColSeries[]; value: (x: number, s: string) => number | null; fmt: (v: number) => string; label: string; height?: number; stacked?: boolean; yMax?: number; xLabel?: (x: string) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const tip = useTip();
  const cum = xs.map((_, i) => {
    let acc = 0;
    return ss.map((s) => (stacked ? (acc += value(i, s.key) ?? 0) : value(i, s.key)));
  });
  const all = cum.flat().filter((v): v is number => v != null);
  if (xs.length < 2 || !all.some((v) => v)) return <Empty />;
  const ticks = niceTicks(yMax ?? Math.max(...all));
  const max = yMax ?? ticks.at(-1)!;
  const top = 8, bottom = 22, left = 44, right = 8, H = height;
  const plotW = Math.max(10, w - left - right), plotH = H - top - bottom;
  const x = (i: number) => left + (i / (xs.length - 1)) * plotW;
  const y = (v: number) => top + plotH - (Math.min(v, max) / max) * plotH;
  const every = Math.max(1, Math.ceil(xs.length / Math.max(1, Math.floor(plotW / 70))));
  const path = (j: number) => cum.map((c, i) => (c[j] == null ? null : `${x(i).toFixed(1)},${y(c[j]!).toFixed(1)}`)).filter(Boolean);
  const pick = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(xs.length - 1, Math.round(((e.clientX - r.left) / r.width) * (xs.length - 1))));
    setHover(i);
    tip.show(e, <TipBody head={xLabel(xs[i]!)} rows={[...ss].reverse().map((s): [string, string, string] => [s.label, value(i, s.key) == null ? "—" : fmt(value(i, s.key)!), s.color])} />);
  };
  return (
    <div className="fl-chart">
      {ss.length > 1 && <Legend items={ss} />}
      <div ref={ref} className="fl-plot">{w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label}>
          {(yMax ? [0, max / 2, max] : ticks).map((t) => (
            <g key={t}>
              <line x1={left} x2={w - right} y1={y(t)} y2={y(t)} className={t ? "fl-grid" : "fl-axis"} />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fl-tick">{fmt(t)}</text>
            </g>
          ))}
          {ss.map((s, j) => {
            const pts = path(j);
            if (!stacked) return <polyline key={s.key} points={pts.join(" ")} className="fl-line" style={{ stroke: s.color }} />;
            const below = j ? path(j - 1).reverse() : [`${x(xs.length - 1)},${y(0)}`, `${x(0)},${y(0)}`];
            return <polygon key={s.key} points={[...pts, ...below].join(" ")} className="fl-area" style={{ fill: s.color }} />;
          })}
          {xs.map((d, i) => i % every === 0 && <text key={d} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === xs.length - 1 ? "end" : "middle"} className="fl-tick">{xLabel(d)}</text>)}
          {hover != null && (
            <g className="fl-cross">
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotH} />
              {!stacked && ss.map((s, j) => cum[hover]![j] != null && <circle key={s.key} cx={x(hover)} cy={y(cum[hover]![j]!)} r={4} style={{ fill: s.color }} />)}
            </g>
          )}
          <rect x={left} y={top} width={plotW} height={plotH} className="fl-hit" onPointerMove={pick} onPointerLeave={() => (setHover(null), tip.hide())} />
        </svg>
      )}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- dots on a log time axis */
export interface Dot { key: string; x: number; y: number; color: string; tip: () => React.ReactNode; label: string; onClick?: () => void }
/**
 * Dots over a log duration axis. `x` is either a time (ms, `cats` absent) or a category index (`cats`: one column each, dots
 * jittered within it). `lines` are horizontal references: across the plot, or per category (`cat`).
 */
export function DotPlot({ dots, lines = [], cats, label, height = 260, fmtY, legend }: {
  dots: Dot[]; lines?: { y: number; label: string; cat?: number }[]; cats?: { label: string; color: string }[]; label: string; height?: number; fmtY: (s: number) => string; legend?: { label: string; color: string }[];
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const tip = useTip();
  if (!dots.length) return <Empty />;
  const ys = [...dots.map((d) => d.y), ...lines.map((l) => l.y)];
  const top = 10, bottom = cats ? 40 : 22, left = 48, right = cats ? 8 : 84, H = height;
  const plotW = Math.max(10, w - left - right), plotH = H - top - bottom;
  const sy = logScale(Math.max(30, Math.min(...ys) * 0.8), Math.max(...ys) * 1.2, top + plotH, top);
  const xs = dots.map((d) => d.x);
  const x0 = cats ? -0.5 : Math.min(...xs), x1 = cats ? cats.length - 0.5 : Math.max(...xs, x0 + 1);
  const sx = (v: number) => left + ((v - x0) / (x1 - x0)) * plotW;
  const band = cats ? plotW / cats.length : 0;
  const xticks = cats ? [] : Array.from({ length: 5 }, (_, i) => x0 + (i / 4) * (x1 - x0));
  return (
    <div className="fl-chart">
      {legend && <Legend items={legend} />}
      {cats && w > 0 && (w - 56) / cats.length < 72 && <Legend items={cats} />}
      <div ref={ref} className="fl-plot">{w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label}>
          {sy.ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={w - right} y1={sy.f(t)} y2={sy.f(t)} className="fl-grid" />
              <text x={left - 8} y={sy.f(t)} dy="0.32em" textAnchor="end" className="fl-tick">{fmtY(t)}</text>
            </g>
          ))}
          {cats?.map((c, i) => (
            <g key={c.label}>
              {i > 0 && <line x1={left + band * i} x2={left + band * i} y1={top} y2={top + plotH} className="fl-grid" />}
              <rect x={band >= 72 ? left + band * i + 6 : left + band * i + band / 2 - 3.5} y={H - bottom + 11} width={7} height={7} rx={2} style={{ fill: c.color }} />
              {band >= 72 && <text x={left + band * i + 18} y={H - bottom + 18} className="fl-tick" textAnchor="start">{c.label}</text>}
            </g>
          ))}
          {xticks.map((t, i) => <text key={i} x={sx(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} className="fl-tick">{day(new Date(t).toISOString())}</text>)}
          {lines.map((l, i) => {
            const a = l.cat != null ? left + band * l.cat + 6 : left, b = l.cat != null ? left + band * (l.cat + 1) - 6 : w - right;
            return (
              <g key={i} className="fl-ref">
                <line x1={a} x2={b} y1={sy.f(l.y)} y2={sy.f(l.y)} />
                {l.cat == null ? <text x={b + 6} y={sy.f(l.y)} dy="0.32em">{l.label}</text> : <title>{l.label}</title>}
              </g>
            );
          })}
          {dots.map((d, i) => {
            const jitter = cats ? (((i * 7919) % 100) / 100 - 0.5) * Math.min(band * 0.6, 60) : 0;
            return (
              <circle
                key={d.key}
                cx={sx(d.x) + jitter}
                cy={sy.f(d.y)}
                r={4.5}
                className={`fl-dot${d.onClick ? " link" : ""}`}
                style={{ fill: d.color }}
                tabIndex={0}
                role={d.onClick ? "link" : undefined}
                aria-label={d.label}
                onClick={d.onClick}
                onKeyDown={(e) => e.key === "Enter" && d.onClick?.()}
                {...tipProps(tip, d.tip)}
              />
            );
          })}
        </svg>
      )}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- horizontal bar list (HTML) */
export function BarList({ rows, fmt, label }: { rows: { key: string; label: React.ReactNode; value: number; sub?: React.ReactNode; color?: string; tip?: () => React.ReactNode }[]; fmt: (v: number) => string; label: string }) {
  const tip = useTip();
  if (!rows.length) return <Empty />;
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ul className="fl-barlist" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} tabIndex={r.tip ? 0 : undefined} {...(r.tip ? tipProps(tip, r.tip) : {})}>
          <span className="fl-barlist-label">{r.label}</span>
          <span className="fl-barlist-track"><i style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--series-0)" }} /></span>
          <b>{fmt(r.value)}</b>
          {r.sub != null && <span className="fl-barlist-sub">{r.sub}</span>}
        </li>
      ))}
    </ul>
  );
}
