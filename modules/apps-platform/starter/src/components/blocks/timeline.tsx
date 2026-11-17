import type * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// A timeline: dated events on one connecting line, oldest or newest first as the view needs (a project's history, an
// incident, an order's journey). ActivityList is the lighter feed for a side rail; Timeline is for a detail view where the
// sequence is the point. `variant`: `dots` (a dot per event) or `icons` (each event's icon in a small circle).
export type TimelineEvent = {
  id: string
  title: React.ReactNode
  when: string
  text?: React.ReactNode
  /** A theme class for the dot, e.g. `bg-danger-solid` (default: a neutral line colour). */
  dot?: string
  icon?: LucideIcon
}

export function Timeline({ events, variant = "dots", className }: { events: TimelineEvent[]; variant?: "dots" | "icons"; className?: string }) {
  return (
    <ol className={cn("relative flex flex-col gap-5", className)}>
      {events.map((e, i) => (
        <li key={e.id} className="relative flex gap-3">
          {i < events.length - 1 && (
            <span aria-hidden className={cn("absolute top-5 bottom-[-20px] w-px bg-border", variant === "icons" ? "left-3.5" : "left-[3.5px]")} />
          )}
          {variant === "icons" && e.icon ? (
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
              <e.icon aria-hidden className="size-3.5" />
            </span>
          ) : (
            <span aria-hidden className={cn("relative mt-1.5 size-2 shrink-0 rounded-full", variant === "icons" && "mx-2.5", e.dot ?? "bg-line-strong")} />
          )}
          <div className={cn("min-w-0 flex-1 text-sm", variant === "icons" && "pt-1")}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="font-medium">{e.title}</p>
              <time className="text-xs text-muted-foreground tabular-nums">{e.when}</time>
            </div>
            {e.text && <p className="mt-0.5 text-muted-foreground">{e.text}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}
