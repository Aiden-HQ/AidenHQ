import * as React from "react"
import { cn } from "@/lib/utils"

// A page frame and header (guidelines: Layout and navigation): room for tables and dashboards (`wide`), a reading width for
// forms and settings (`narrow`), sections 24px apart, and a header with the title, one line of context and the actions.

export function Page({ width = "wide", className, children }: { width?: "wide" | "narrow"; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-5 md:px-8 md:py-8",
        width === "wide" ? "max-w-6xl" : "max-w-2xl",
        className
      )}
    >
      {children}
    </div>
  )
}

/** One title, one line of context (what this is, how fresh), and at most one primary action on the right. */
export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** A titled section of a page: a heading clearly smaller than the page title, an optional note and actions. */
export function PageSection({
  title,
  description,
  count,
  actions,
  className,
  children,
}: {
  title: string
  description?: React.ReactNode
  /** How many items the section holds, beside the heading. */
  count?: number
  actions?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id={id} className="flex items-baseline gap-2 text-lg font-semibold tracking-tight">
            {title}
            {count !== undefined && <span className="text-sm font-medium text-muted-foreground tabular-nums">{count}</span>}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

/**
 * The main column and a side rail on wide screens (stacked on phones): the board or table in `children`, secondary
 * things (a recent-changes feed, a detail page's facts, related items) in `aside`, so a page isn't one long stack of
 * equal full-width sections and the space beside a narrow block isn't left empty.
 */
export function PageSplit({ aside, children }: { aside: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      <aside className="flex min-w-0 flex-col gap-6">{aside}</aside>
    </div>
  )
}
