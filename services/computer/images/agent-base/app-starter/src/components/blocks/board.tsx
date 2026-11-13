import * as React from "react"
import { cn } from "@/lib/utils"

// A board (guidelines: Data views): items grouped into lanes by stage or status, side by side, when the question people ask is
// "what is in each stage". Keep the stages the app already shows. Each lane is
// a tinted column (no border) of compact items on the background (one border, no pills: the lane already says the
// status); the lane's own text is full-strength ink, so the tint never holds muted text (no grey on grey). A long lane
// shows `limit` items and a "Show all" button; an empty lane says so in one line. Lanes stack on phones. Read-only:
// moving an item is an action in its detail sheet, not drag and drop.

export type BoardItem = {
  id: string
  title: string
  /** The item's detail: a real link (`?item=…`), so Cmd-click and Back work. */
  href: string
  /** Called on a plain click (open the detail sheet); modified clicks follow the link. */
  onOpen?: () => void
  /** One short line under the title: "Payments · 19 Nov". */
  meta?: React.ReactNode
  /** A small signal on the right of the meta line: an avatar, "+3d" in `text-danger`. */
  aside?: React.ReactNode
}

export type BoardLane = {
  id: string
  title: string
  /** The lane's status dot (a theme class such as `bg-ok-solid`); the title carries the meaning too. */
  dot?: string
  items: BoardItem[]
  /** What an empty lane says, in the user's words ("Nothing shipped this quarter"). */
  empty?: string
}

export function Board({ lanes, limit = 8, label = "Board", selected }: { lanes: BoardLane[]; limit?: number; label?: string; selected?: string }) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 md:grid md:auto-cols-[minmax(12.5rem,1fr)] md:grid-flow-col md:items-start md:overflow-x-auto md:pb-1"
    >
      {lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} limit={limit} selected={selected} />
      ))}
    </section>
  )
}

function Lane({ lane, limit, selected }: { lane: BoardLane; limit: number; selected?: string }) {
  const [all, setAll] = React.useState(false)
  const id = React.useId()
  const shown = all ? lane.items : lane.items.slice(0, limit)
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/70 p-2 dark:bg-muted">
      <h3 id={id} className="flex items-center gap-2 px-1.5 pt-1 text-sm font-semibold">
        {lane.dot && <span aria-hidden className={cn("size-2 rounded-[2px]", lane.dot)} />}
        <span className="truncate">{lane.title}</span>
        <span className="ml-auto text-xs font-medium tabular-nums">{lane.items.length}</span>
      </h3>
      {lane.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong bg-background px-3 py-4 text-center text-xs text-muted-foreground">
          {lane.empty ?? "Nothing here"}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((item) => (
            <li key={item.id}>
              <a
                href={item.href}
                aria-current={item.id === selected ? "true" : undefined}
                onClick={(e) => {
                  if (!item.onOpen || e.metaKey || e.ctrlKey || e.shiftKey) return
                  e.preventDefault()
                  item.onOpen()
                }}
                className="flex animate-in flex-col gap-1 rounded-lg border bg-background px-3 py-2.5 duration-(--duration-slow) fade-in-0 outline-none transition-colors hover:border-line-strong focus-visible:ring-[3px] focus-visible:ring-ring aria-[current=true]:border-primary"
              >
                <span className="line-clamp-2 text-sm font-medium">{item.title}</span>
                {(item.meta || item.aside) && (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">{item.meta}</span>
                    {item.aside && <span className="ml-auto shrink-0 tabular-nums">{item.aside}</span>}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      {lane.items.length > limit && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="rounded-md px-1.5 py-1 text-left text-xs font-semibold text-link outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          {all ? "Show fewer" : `Show all ${lane.items.length}`}
        </button>
      )}
    </section>
  )
}
