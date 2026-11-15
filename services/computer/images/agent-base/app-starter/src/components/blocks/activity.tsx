import * as React from "react"
import { cn } from "@/lib/utils"

// What changed, newest first: a recent-changes feed in a page's side rail, or an item's history in its
// detail. One line of what happened, an optional line of why, then when and the source, on a quiet rail of dots: no box
// per entry, no pills. Cap it (`limit`) and link the rest; a long history belongs in the detail sheet or its own page.

export type ActivityEntry = {
  id: string
  /** What happened, in plain words: "Due date moved out by 5 days". */
  title: React.ReactNode
  /** Why, or the detail, in one short line. */
  text?: React.ReactNode
  /** When, already formatted ("2 hours ago", "4 Dec"). */
  when: string
  /** The source link: `<a href>` to where it was said. */
  source?: React.ReactNode
  /** Highlight the dot for an entry that needs attention: a theme class such as `bg-danger-solid`. */
  dot?: string
}

export function ActivityList({ entries, limit, more }: { entries: ActivityEntry[]; limit?: number; more?: React.ReactNode }) {
  const shown = limit ? entries.slice(0, limit) : entries
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col">
        {shown.map((e, i) => (
          <li key={e.id} className="relative flex animate-in gap-3 pb-4 duration-(--duration-slow) fade-in-0 last:pb-0">
            {i < shown.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-[4.5px] w-px bg-border" />}
            <span aria-hidden className={cn("relative mt-1.5 size-2.5 shrink-0 rounded-full border-2 border-background bg-primary ring-1 ring-border", e.dot)} />
            <div className="min-w-0 space-y-0.5 text-sm">
              <p className="font-medium">{e.title}</p>
              {e.text && <p className="text-muted-foreground">{e.text}</p>}
              <p className="text-xs text-muted-foreground">
                {e.when}
                {e.source && <> · {e.source}</>}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {more}
    </div>
  )
}
