import * as React from "react"
import { ArrowDownRightIcon, ArrowUpRightIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Sparkline } from "@/components/blocks/sparkline"
import { cn } from "@/lib/utils"

// A KPI card (after Tremor's KPI cards): one figure, its change against a stated period, and an optional trend line. For
// a row of related figures prefer StatStrip (one surface split into cells); a KpiCard suits a figure that stands alone or
// a small grid of unrelated ones. `card` is the Card variant (default, flat, bordered, elevated).
export function KpiCard({
  label,
  value,
  delta,
  period,
  trend,
  card = "bordered",
  className,
}: {
  label: string
  value: React.ReactNode
  /** The change, signed, e.g. "+12%" or -3; positive reads as good unless `goodWhen` says otherwise. */
  delta?: { value: string | number; goodWhen?: "up" | "down" }
  /** What the change is measured against, e.g. "vs last week". */
  period?: string
  /** Recent values, oldest first. */
  trend?: number[]
  card?: "default" | "flat" | "bordered" | "elevated"
  className?: string
}) {
  const up = delta !== undefined && !String(delta.value).trim().startsWith("-")
  const good = delta && (delta.goodWhen === "down" ? !up : up)
  return (
    <Card variant={card} className={cn("gap-2 px-5 py-4", className)}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span className="text-3xl font-bold tracking-tight tabular-nums">{value}</span>
        {trend && <Sparkline values={trend} className={cn("mb-1", good === false ? "text-danger" : "text-chart-1")} />}
      </div>
      {delta && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", good ? "text-ok" : "text-danger")}>
            {up ? <ArrowUpRightIcon aria-hidden className="size-3.5" /> : <ArrowDownRightIcon aria-hidden className="size-3.5" />}
            {delta.value}
          </span>
          {period}
        </span>
      )}
    </Card>
  )
}
