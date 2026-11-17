import * as React from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Sparkline } from "@/components/blocks/sparkline"
import { cn } from "@/lib/utils"

// A summary of numbers: one surface split into cells, never a row of floating cards. A cell with
// `onPick` is a toggle that filters the view (`pressed` when its filter is on); the figures count what the filters show.
// The `hero` tone is optional, for the one figure the page is about when one deserves it; a figure that needs attention
// takes its status tone; leave the rest plain. A toned cell writes in its
// status ink (AA on the soft tint), never muted grey on the tint.

const TONE = {
  // The one figure the page is about: the primary gradient, white text. At most one per strip.
  hero: { cell: "bg-primary-gradient", value: "text-primary-foreground" },
  primary: { cell: "bg-primary-soft", value: "text-link" },
  ok: { cell: "bg-ok-soft", value: "text-ok" },
  warn: { cell: "bg-warn-soft", value: "text-warn" },
  danger: { cell: "bg-danger-soft", value: "text-danger" },
  info: { cell: "bg-info-soft", value: "text-info" },
} as const

export type Stat = {
  label: string
  value: React.ReactNode
  /** One short line under the number: what it means, or what changed. */
  note?: React.ReactNode
  /** A status dot (a theme class such as `bg-warn-solid`); the label carries the meaning too. */
  dot?: string
  /** Highlight a figure that needs attention: its cell takes that status's soft tint and its number the status ink. */
  tone?: "hero" | "primary" | "ok" | "warn" | "danger" | "info"
  /** Recent values, oldest first: a small trend line beside the number (a few points; no chart library). */
  trend?: number[]
  pressed?: boolean
  onPick?: () => void
}

// The strip's look: `divided` (one bordered surface split into cells), `plain` (figures on the page, no box), `tinted`
// (each figure on a muted fill, small gaps between).
const STRIP = {
  divided: { strip: "gap-px overflow-hidden rounded-xl border bg-border", cell: "bg-background p-4" },
  plain: { strip: "gap-x-8 gap-y-4", cell: "py-1" },
  tinted: { strip: "gap-2", cell: "rounded-lg bg-muted p-4" },
} as const

export function StatStrip({
  stats,
  loading,
  label = "Summary",
  variant = "divided",
}: {
  stats: Stat[]
  loading?: boolean
  label?: string
  variant?: keyof typeof STRIP
}) {
  return (
    <section
      aria-label={label}
      data-variant={variant}
      className={cn(
        "grid grid-cols-2",
        STRIP[variant].strip,
        stats.length === 3 ? "lg:grid-cols-3" : stats.length >= 4 && "lg:grid-cols-4"
      )}
    >
      {stats.map((s) => {
        const body = (
          <>
            <span className={cn("flex items-center gap-2 text-sm text-muted-foreground", s.tone && TONE[s.tone].value)}>
              {s.dot && <span aria-hidden className={cn("size-2 rounded-full", s.dot)} />}
              {s.label}
            </span>
            {loading ? (
              <Skeleton className="my-1 h-8 w-12" />
            ) : (
              <span className="flex w-full items-end justify-between gap-3">
                <span className={cn("text-3xl font-bold tracking-tight tabular-nums", s.tone && TONE[s.tone].value)}>{s.value}</span>
                {s.trend && s.trend.length > 1 && <Sparkline values={s.trend} className={cn("mb-1", s.tone ? TONE[s.tone].value : "text-chart-1")} />}
              </span>
            )}
            {s.note && <span className={cn("text-xs text-muted-foreground", s.tone && TONE[s.tone].value)}>{s.note}</span>}
          </>
        )
        const cell = cn("flex flex-col items-start gap-1 text-left", STRIP[variant].cell, s.tone && TONE[s.tone].cell, s.tone && variant === "plain" && "rounded-lg px-3")
        return s.onPick ? (
          <button
            key={s.label}
            type="button"
            aria-pressed={!!s.pressed}
            onClick={s.onPick}
            className={cn(
              cell,
              "transition-colors outline-none hover:brightness-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-inset dark:hover:brightness-110",
              s.pressed && "shadow-[inset_0_-3px_0_var(--primary)]"
            )}
          >
            {body}
          </button>
        ) : (
          <div key={s.label} className={cell}>
            {body}
          </div>
        )
      })}
    </section>
  )
}
