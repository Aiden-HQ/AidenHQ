import * as React from "react"
import { cn } from "@/lib/utils"

// Three charts that cover most internal tools, with no chart library: `BarList` to compare a few
// categories (horizontal bars from zero, labels and values readable on a phone), `TrendChart` for one measure over
// time (a smooth line over a soft area) and `ScheduleChart` for dated items on a calendar (a point or a from-to bar
// per row, against today). Each is a <figure> whose caption states the takeaway, which is also its text alternative. Colours are the theme's
// chart series (`chart-1…6`). Chart only what a number or a table can't say better; with fewer than two points
// `TrendChart` shows the number instead of a line. A missing value is a gap, never a zero.

export function BarList({
  title,
  takeaway,
  data,
  format = (n) => n.toLocaleString(),
  color = "bg-chart-1",
}: {
  title: string
  /** The one sentence a reader should take away ("Payments has twice the open items of any other team"). */
  takeaway: string
  data: { label: string; value: number; href?: string }[]
  format?: (n: number) => string
  /** A theme class for the bars: bg-chart-1…6. */
  color?: string
}) {
  const max = Math.max(0, ...data.map((d) => d.value))
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{takeaway}</span>
      </figcaption>
      <ul className="flex flex-col gap-2">
        {data.map((d) => (
          <li key={d.label} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-sm">
            {d.href ? (
              <a href={d.href} className="truncate underline-offset-4 hover:underline">
                {d.label}
              </a>
            ) : (
              <span className="truncate">{d.label}</span>
            )}
            <span aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
              <span className={cn("block h-full rounded-full", color)} style={{ width: `${max ? (d.value / max) * 100 : 0}%` }} />
            </span>
            <span className="text-right tabular-nums">{format(d.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

export function TrendChart({
  title,
  takeaway,
  points,
  format = (n) => n.toLocaleString(),
  color = "text-chart-1",
}: {
  title: string
  takeaway: string
  /** Oldest first. `label` is what the axis shows (a formatted date); `value` null is a gap. */
  points: { label: string; value: number | null }[]
  format?: (n: number) => string
  /** A theme class for the line: text-chart-1…6. */
  color?: string
}) {
  const known = points.filter((p) => p.value !== null) as { label: string; value: number }[]
  const last = known.at(-1)
  const W = 600, H = 160, PAD = 4
  const max = Math.max(1, ...known.map((p) => p.value))
  const x = (i: number) => (points.length < 2 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1))
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)
  // One smooth segment per run of known values, so a gap stays a gap; each gets the area beneath it.
  const runs: [number, number][][] = [[]]
  points.forEach((p, i) => (p.value === null ? runs.push([]) : runs.at(-1)!.push([x(i), y(p.value)])))
  const segments = runs
    .filter((r) => r.length)
    .map((r) => {
      let line = `M${r[0][0].toFixed(1)},${r[0][1].toFixed(1)}`
      for (let i = 1; i < r.length; i++) {
        const [x0, y0] = r[i - 1], [x1, y1] = r[i], cx = ((x0 + x1) / 2).toFixed(1)
        line += ` C${cx},${y0.toFixed(1)} ${cx},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`
      }
      return { line, area: `${line} L${r.at(-1)![0].toFixed(1)},${y(0)} L${r[0][0].toFixed(1)},${y(0)} Z` }
    })
  const fill = React.useId().replace(/:/g, "")

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-wrap items-end justify-between gap-2">
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-sm text-muted-foreground">{takeaway}</span>
        </span>
        {last && <span className="text-2xl font-bold tracking-tight tabular-nums">{format(last.value)}</span>}
      </figcaption>
      {known.length >= 2 && (
        <div aria-hidden className="flex flex-col gap-1">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("h-40 w-full overflow-visible", color)}>
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} className="stroke-border" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="stroke-line-strong" vectorEffect="non-scaling-stroke" />
            <defs>
              <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity={0.28} />
                <stop offset="1" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>
            {segments.map((s) => (
              <g key={s.line}>
                <path d={s.area} fill={`url(#${fill})`} />
                <path d={s.line} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </g>
            ))}
          </svg>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{points[0]?.label}</span>
            <span>Peak {format(Math.max(...known.map((p) => p.value)))}</span>
            <span>{points.at(-1)?.label}</span>
          </div>
        </div>
      )}
    </figure>
  )
}

export type ScheduleRow = {
  id: string
  label: string
  /** The item's detail; `onOpen` handles a plain click (open the sheet), modified clicks follow the link. */
  href?: string
  onOpen?: () => void
  /** Where the row started (a first plan, a start date), ISO `yyyy-mm-dd`. Omit for a single point. */
  from?: string
  /** The date that matters now, ISO `yyyy-mm-dd`. */
  to: string
  /** A theme text class for the mark: `text-chart-1` (default) or a status (`text-danger-solid`, `text-ok-solid`). */
  color?: string
  /** A short signal after the date: "+3d" in `text-danger`. */
  note?: React.ReactNode
}

const DAY_MS = 86400000
const dayOf = (iso: string) => new Date(`${iso}T00:00:00`).getTime()

/**
 * Dated items on one calendar: a point per row, or a bar from `from` to `to` when the two differ, with today marked.
 * The axis fits the dates (weekly ticks up to ten weeks, monthly beyond), so a cluster of close dates spreads across the
 * width instead of bunching in one corner. One compact line per row; undated items aren't plotted (list them apart).
 * This is the view, not a companion: don't repeat the same rows as a table under it.
 */
export function ScheduleChart({
  title,
  takeaway,
  rows,
  legend = [],
  today = new Date().toISOString().slice(0, 10),
  format = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
}: {
  title: string
  takeaway: string
  rows: ScheduleRow[]
  /** What each mark colour means, when rows use more than one: `{ label: "Late", color: "text-danger-solid" }`. */
  legend?: { label: string; color: string }[]
  today?: string
  format?: (iso: string) => string
}) {
  const days = rows.flatMap((r) => (r.from ? [dayOf(r.from), dayOf(r.to)] : [dayOf(r.to)])).concat(dayOf(today))
  const start = Math.min(...days) - 3 * DAY_MS
  const end = Math.max(...days) + 3 * DAY_MS
  const at = (t: number) => `${(((t - start) / (end - start)) * 100).toFixed(2)}%`
  const weekly = end - start <= 70 * DAY_MS
  const ticks: { t: number; label: string }[] = []
  for (const d = new Date(start); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
    if (weekly ? d.getDay() === 1 : d.getDate() === 1)
      ticks.push({ t: d.getTime(), label: d.toLocaleDateString(undefined, weekly ? { day: "numeric", month: "short" } : { month: "short" }) })
  }
  const grid = "grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 sm:grid-cols-[minmax(0,14rem)_1fr_5.5rem]"
  const lines = (
    <>
      {ticks.map((k) => (
        <span key={k.t} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: at(k.t) }} />
      ))}
      <span aria-hidden className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary/70" style={{ left: at(dayOf(today)) }} />
    </>
  )

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{takeaway}</span>
      </figcaption>
      <div className="flex flex-col">
        <div className={cn(grid, "h-7 text-xs text-muted-foreground")}>
          <span />
          <span aria-hidden className="relative overflow-hidden">
            {ticks
              // A tick label (drawn to the right of its line) close to the Today marker would collide with it; the line stays.
              .filter((k) => k.t < dayOf(today) - (end - start) * 0.1 || k.t > dayOf(today) + (end - start) * 0.04)
              .map((k) => (
                <span key={k.t} className="absolute top-1 pl-1.5 whitespace-nowrap" style={{ left: at(k.t) }}>
                  {k.label}
                </span>
              ))}
            <span className="absolute top-1 -translate-x-1/2 rounded-sm bg-primary px-1.5 font-medium text-primary-foreground" style={{ left: at(dayOf(today)) }}>
              Today
            </span>
          </span>
          <span className="hidden text-right sm:block">Date</span>
        </div>
        <ul className="flex flex-col">
          {rows.map((r) => {
            const moved = r.from && r.from !== r.to
            const [a, b] = moved ? [dayOf(r.from!), dayOf(r.to)].sort((x, y) => x - y) : [0, 0]
            return (
              <li key={r.id} className={cn(grid, "h-8 items-center rounded-md transition-colors hover:bg-muted/60")}>
                <span className="min-w-0 truncate pl-1 text-sm" title={r.label}>
                  {r.href ? (
                    <a
                      href={r.href}
                      onClick={(e) => {
                        if (!r.onOpen || e.metaKey || e.ctrlKey || e.shiftKey) return
                        e.preventDefault()
                        r.onOpen()
                      }}
                      className="font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      {r.label}
                    </a>
                  ) : (
                    r.label
                  )}
                </span>
                <span aria-hidden className={cn("relative h-full", r.color ?? "text-chart-1")}>
                  {lines}
                  {moved && (
                    <>
                      <span className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-current opacity-35" style={{ left: at(a), width: `calc(${at(b)} - ${at(a)})` }} />
                      <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-current bg-background" style={{ left: at(dayOf(r.from!)) }} />
                    </>
                  )}
                  <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-background" style={{ left: at(dayOf(r.to)) }} />
                </span>
                <span className="text-right text-xs tabular-nums max-sm:sr-only">
                  {moved && <span className="sr-only">{format(r.from!)} to </span>}
                  {format(r.to)}
                  {r.note && <span className="ml-1">{r.note}</span>}
                </span>
              </li>
            )
          })}
        </ul>
        {(legend.length > 0 || rows.some((r) => r.from && r.from !== r.to)) && (
          <p aria-hidden className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {legend.map((l) => (
              <span key={l.label} className={cn("flex items-center gap-1.5", l.color)}>
                <span className="size-2.5 rounded-full bg-current" />
                <span className="text-muted-foreground">{l.label}</span>
              </span>
            ))}
            {rows.some((r) => r.from && r.from !== r.to) && (
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full border-2 border-current" />
                First date, then where it moved
              </span>
            )}
          </p>
        )}
      </div>
    </figure>
  )
}
