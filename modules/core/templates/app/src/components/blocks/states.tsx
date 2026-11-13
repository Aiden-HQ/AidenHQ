import * as React from "react"
import { Skeleton } from "@/components/ui/skeleton"

// Every data view's empty, error and loading states, in the place the content would be (guidelines §8): one container,
// written for this view. Empty says what goes here and the one action that fills it; an error says what went wrong, what
// was kept and offers Try again (`role="alert"`); a filter that empties the view says so and offers Clear filters.

export function StatePanel({
  icon: Icon,
  title,
  role,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  /** "alert" for errors. */
  role?: "alert" | "status"
  children?: React.ReactNode
}) {
  return (
    <div role={role} className="flex animate-in flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center duration-(--duration-slow) fade-in-0 zoom-in-95">
      <span aria-hidden className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary-soft text-link">
        <Icon className="size-5" />
      </span>
      <h3 className="font-semibold">{title}</h3>
      {children && <div className="mt-1 flex max-w-sm flex-col items-center text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

/** Skeleton rows shaped like the table that will replace them, so nothing jumps when it loads. */
export function TableSkeleton({ rows = 6, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="overflow-hidden rounded-xl border">
      <div className="h-10 border-b bg-muted/60" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-4 last:border-0">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
