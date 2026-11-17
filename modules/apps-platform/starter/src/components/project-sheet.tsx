import * as React from "react"
import { ExternalLinkIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { StatusBadge } from "@/components/status-badge"
import { DetailList } from "@/components/blocks/detail-list"
import { formatDate, isOverdue, relativeDay, relativeTime, STATUS, type Project, type Source, type Status } from "@/lib/projects"
import { cn } from "@/lib/utils"

// A project's detail beside the list: status first, then the facts with their sources, then history, newest first.
export function ProjectSheet({
  project,
  onClose,
  onStatus,
}: {
  project?: Project
  onClose: () => void
  onStatus: (p: Project, s: Status) => void
}) {
  const last = React.useRef(project)
  if (project) last.current = project
  const p = project ?? last.current // keeps the content while the sheet animates closed
  return (
    <Sheet open={!!project} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        {p && (
          <>
            <SheetHeader className="gap-1 px-6 pt-6 pb-4">
              <SheetTitle className="pr-8 text-xl font-semibold tracking-tight">{p.name}</SheetTitle>
              <SheetDescription>
                {p.team} · {p.owner}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-6 pb-8">
              <section aria-label="Current status" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={p.status} className="px-2.5 py-1 text-sm" />
                  <span className={cn("text-sm text-muted-foreground", isOverdue(p) && "text-danger")}>
                    Due {formatDate(p.due)}
                    {p.status !== "done" && ` · ${relativeDay(p.due)}`}
                  </span>
                </div>
                {p.next && (
                  <p className="text-sm leading-relaxed">
                    <span className="font-medium">Next step:</span> {p.next}
                  </p>
                )}
              </section>

              <div className="flex flex-col gap-2">
                <Label htmlFor="project-status">Change status</Label>
                <Select value={p.status} onValueChange={(v) => onStatus(p, v as Status)}>
                  <SelectTrigger id="project-status" className="w-full sm:w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STATUS) as Status[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        <span aria-hidden className={cn("size-2 rounded-full", STATUS[s].dot)} />
                        {STATUS[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <section aria-labelledby="details-heading" className="flex flex-col gap-3">
                <h3 id="details-heading" className="text-sm font-semibold">
                  Details
                </h3>
                <DetailList
                  items={[
                    { label: "Team", value: p.team },
                    { label: "Owner", value: p.owner },
                    { label: "Due", value: formatDate(p.due) },
                    { label: "Last updated", value: relativeTime(p.updated) },
                    { label: "Source", value: <SourceLink source={p.source} /> },
                  ]}
                />
              </section>

              <section aria-labelledby="history-heading" className="flex flex-col gap-3">
                <h3 id="history-heading" className="text-sm font-semibold">
                  History
                </h3>
                <ol className="flex flex-col gap-4 border-l pl-5">
                  {p.history.map((h, i) => (
                    <li key={i} className="relative text-sm">
                      <span aria-hidden className="absolute top-1.5 -left-[25px] size-2 rounded-full bg-line-strong ring-4 ring-background" />
                      <p>{h.text}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {relativeTime(h.at)} · <SourceLink source={h.source} />
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function SourceLink({ source }: { source: Source }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline"
    >
      {source.label}
      <ExternalLinkIcon aria-hidden className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}
