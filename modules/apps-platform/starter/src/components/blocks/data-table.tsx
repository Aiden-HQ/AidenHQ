import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TableHead } from "@/components/ui/table"
import { cn } from "@/lib/utils"

// The pieces a data table needs beyond shadcn's Table: sortable headers that say which way they sort,
// and a page of rows at a time, with the page in the URL (`?page=`) like the filters. Reset the page when a filter changes.

/** A column header that sorts. The page keeps the sort in the URL (`?sort=`) and passes whether this column is active;
 * the active one is a heading with `aria-sort`, not a button, since clicking it again would sort the same way. */
export function SortHead({
  active,
  direction = "ascending",
  onSort,
  className,
  children,
}: {
  active: boolean
  direction?: "ascending" | "descending"
  onSort: () => void
  className?: string
  children: React.ReactNode
}) {
  const Arrow = direction === "descending" ? ArrowDownIcon : ArrowUpIcon
  return (
    <TableHead className={className} aria-sort={active ? direction : undefined}>
      {active ? (
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          {children}
          <Arrow aria-hidden className="size-3.5" />
        </span>
      ) : (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring"
          )}
        >
          {children}
          <Arrow aria-hidden className="size-3.5 opacity-0" />
        </button>
      )}
    </TableHead>
  )
}

/** One page of rows. `page` is 1-based (from the URL); out-of-range pages clamp to the nearest real one. */
export function paginate<T>(rows: T[], page: number, size = 25) {
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages)
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: Math.min(p * size, rows.length), total: rows.length }
}

/** "26–50 of 132" with Previous and Next, under the table. Hidden when everything fits on one page. */
export function Pagination({
  page,
  pages,
  from,
  to,
  total,
  onPage,
}: {
  page: number
  pages: number
  from: number
  to: number
  total: number
  onPage: (page: number) => void
}) {
  if (pages <= 1) return null
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground tabular-nums">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeftIcon aria-hidden /> Previous
        </Button>
        <Button variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <ChevronRightIcon aria-hidden />
        </Button>
      </div>
    </nav>
  )
}
