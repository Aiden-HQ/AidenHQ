import * as React from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// A summary of numbers: one surface split into cells, never a row of floating cards (guidelines §2). A cell with
// `onPick` is a toggle that filters the view (`pressed` when its filter is on); the figures count what the filters show.
// Give the page's main figure the `hero` tone and a figure that needs attention its status tone; leave the rest plain. A toned cell writes in its
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
  pressed?: boolean
  onPick?: () => void
}

export function StatStrip({ stats, loading, label = "Summary" }: { stats: Stat[]; loading?: boolean; label?: string }) {
  return (
    <section
      aria-label={label}
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border",
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
              <span className={cn("text-3xl font-bold tracking-tight tabular-nums", s.tone && TONE[s.tone].value)}>{s.value}</span>
            )}
            {s.note && <span className={cn("text-xs text-muted-foreground", s.tone && TONE[s.tone].value)}>{s.note}</span>}
          </>
        )
        const cell = cn("flex flex-col items-start gap-1 bg-background p-4 text-left", s.tone && TONE[s.tone].cell)
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
