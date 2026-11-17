import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// A status tracker (after Tremor's Tracker): one thin bar per period (a day, a run, a deploy) coloured by its status, for
// uptime, job runs or check history at a glance. Each bar has a tooltip; the caption states the takeaway. Needs a
// TooltipProvider above it (the SidebarShell has one; otherwise wrap the app).
export type TrackerTone = "ok" | "warn" | "danger" | "none"
const TONE: Record<TrackerTone, string> = { ok: "bg-ok-solid", warn: "bg-warn-solid", danger: "bg-danger-solid", none: "bg-muted" }

export function Tracker({
  title,
  takeaway,
  data,
  className,
}: {
  title: string
  takeaway?: string
  data: { key: string; tone: TrackerTone; tooltip: string }[]
  className?: string
}) {
  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {takeaway && <span className="text-sm text-muted-foreground">{takeaway}</span>}
      </figcaption>
      <div className="flex h-8 w-full gap-[2px]" role="img" aria-label={`${title}. ${takeaway ?? ""}`}>
        {data.map((d) => (
          <Tooltip key={d.key}>
            <TooltipTrigger asChild>
              <span className={cn("h-full flex-1 rounded-[2px] first:rounded-l-sm last:rounded-r-sm hover:opacity-80", TONE[d.tone])} />
            </TooltipTrigger>
            <TooltipContent>{d.tooltip}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </figure>
  )
}
