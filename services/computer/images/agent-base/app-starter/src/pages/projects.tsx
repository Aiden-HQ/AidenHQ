import * as React from "react"
import { AlertTriangleIcon, FolderKanbanIcon, LinkIcon, RotateCwIcon, SearchIcon, SearchXIcon, XIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/status-badge"
import { Page, PageHeader } from "@/components/blocks/page"
import { StatStrip } from "@/components/blocks/stat-strip"
import { Pagination, paginate, SortHead } from "@/components/blocks/data-table"
import { StatePanel, TableSkeleton } from "@/components/blocks/states"
import { ToastAction } from "@/components/ui/toast"
import { ProjectSheet } from "@/components/project-sheet"
import { useProjects } from "@/hooks/use-projects"
import { toast } from "@/hooks/use-toast"
import { Link, useUrlState } from "@/lib/navigation"
import {
  applyFilters,
  formatDate,
  inScope,
  isOverdue,
  isSort,
  isStatus,
  relativeDay,
  relativeTime,
  STATUS,
  type Filters,
  type Project,
  type Status,
} from "@/lib/projects"
import { cn } from "@/lib/utils"

// The example page: a page header, a summary that counts what the filters show, filters that apply as they change and
// live in the URL, a sortable, paged table, details in a sheet, and every state (loading, error, empty, no match, unknown
// value). It imports only what it uses; the other blocks and components (src/components/) are there when a page needs
// them. Copy the composition, not the data.

// Rows per page. 10 so the sample shows paging; real tables show 25 to 50.
const PAGE_SIZE = 10

export function ProjectsPage() {
  const url = useUrlState()
  const { status, items, error, reload, setStatus } = useProjects()
  const f: Filters = { q: url.get("q"), status: url.get("status"), team: url.get("team"), sort: url.get("sort") }
  const openId = url.get("item")
  const pushed = React.useRef(false)

  const teams = React.useMemo(() => [...new Set(items.map((p) => p.team))].sort(), [items])
  const scoped = React.useMemo(() => inScope(items, f), [items, f.q, f.team])
  const ready = status === "ready" || items.length > 0
  const unknown = [
    f.status && !isStatus(f.status) && ["status", f.status],
    ready && f.team && !teams.includes(f.team) && ["team", f.team],
    ready && openId && !items.some((p) => p.id === openId) && ["item", openId],
  ].filter(Boolean) as [string, string][]
  const rows = unknown.some(([k]) => k !== "item") ? [] : applyFilters(items, f)
  const page = paginate(rows, Number(url.get("page")), PAGE_SIZE)
  const sortBy = isSort(f.sort) ? f.sort : "due"
  // A filter or sort change goes back to the first page.
  const filter = (changes: Record<string, string | null>) => url.set({ ...changes, page: null })
  const sortHead = (col: "name" | "due" | "updated") => ({
    active: sortBy === col,
    direction: col === "updated" ? ("descending" as const) : ("ascending" as const),
    onSort: () => filter({ sort: col === "due" ? null : col }),
  })
  const filtered = Boolean(f.q || f.status || f.team)
  const open = items.find((p) => p.id === openId)
  const lastUpdate = items.reduce((m, p) => (p.updated > m ? p.updated : m), "")

  const clearFilters = () => filter({ q: null, status: null, team: null })
  const openItem = (id: string) => {
    pushed.current = true
    url.push({ item: id })
  }
  const closeItem = () => {
    if (pushed.current) history.back()
    else url.set({ item: null })
    pushed.current = false
  }
  const itemHref = (id: string) => {
    const p = new URLSearchParams(location.search)
    p.set("item", id)
    return `?${p}`
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(location.href)
      toast({ title: "Link copied", description: "It opens this view with the same filters." })
    } catch {
      toast({ variant: "destructive", title: "Couldn't copy the link", description: "Copy it from the address bar instead." })
    }
  }

  async function changeStatus(p: Project, next: Status) {
    const r = await setStatus(p.id, next)
    if (r.ok)
      toast({
        title: "Status changed",
        description: `${p.name} is now ${STATUS[next].label.toLowerCase()}.`,
        action: (
          <ToastAction altText="Undo the status change" onClick={() => setStatus(p.id, p.status)}>
            Undo
          </ToastAction>
        ),
      })
    else toast({ variant: "destructive", title: "Couldn't change the status", description: r.error })
  }

  return (
    <Page>
      <PageHeader
        title="Projects"
        description={
          <>
            Status, owners and due dates across teams.
            {lastUpdate && <> Updated {relativeTime(lastUpdate)}.</>}
          </>
        }
        actions={
          <Button variant="outline" onClick={share}>
            <LinkIcon /> Share view
          </Button>
        }
      />

      <Summary items={scoped} loading={!ready && status === "loading"} active={f.status} onPick={(s) => filter({ status: s })} />

      <section aria-labelledby="list-heading" className="flex flex-col gap-4">
        <h2 id="list-heading" className="sr-only">
          Project list
        </h2>
        <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter projects">
          <div className="relative w-full sm:w-72">
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search projects"
              placeholder="Search name, team or owner"
              className="pl-9"
              value={f.q}
              onChange={(e) => filter({ q: e.target.value })}
            />
          </div>
          <Select value={isStatus(f.status) ? f.status : "all"} onValueChange={(v) => filter({ status: v === "all" ? null : v })}>
            <SelectTrigger aria-label="Status" className="min-w-0 flex-1 sm:w-40 sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              {(Object.keys(STATUS) as Status[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS[s].label} <span className="text-muted-foreground tabular-nums">{scoped.filter((p) => p.status === s).length}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={teams.includes(f.team) ? f.team : "all"} onValueChange={(v) => filter({ team: v === "all" ? null : v })}>
            <SelectTrigger aria-label="Team" className="min-w-0 flex-1 sm:w-40 sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every team</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtered && (
            <Button variant="ghost" onClick={clearFilters} className="max-sm:order-last max-sm:w-full">
              <XIcon /> Clear filters
            </Button>
          )}
          <p className="w-full text-sm text-muted-foreground tabular-nums sm:ml-auto sm:w-auto" aria-live="polite">
            {ready && `${rows.length} of ${items.length} projects`}
          </p>
        </div>

        {unknown.length > 0 && (
          <Alert role="status">
            <AlertTriangleIcon />
            <AlertTitle>This link has a value the app doesn't know</AlertTitle>
            <AlertDescription>
              <p>{unknown.map(([k, v]) => `No ${k === "item" ? "project" : k} called "${v}".`).join(" ")}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => filter(Object.fromEntries(unknown.map(([k]) => [k, null])))}
              >
                Show all projects
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {status === "error" && !items.length ? (
          <StatePanel icon={RotateCwIcon} title="Couldn't load projects" role="alert">
            {error} Your filters are kept.
            <Button variant="outline" className="mt-4" onClick={reload}>
              <RotateCwIcon /> Try again
            </Button>
          </StatePanel>
        ) : !ready ? (
          <TableSkeleton label="Loading projects" />
        ) : items.length === 0 ? (
          <StatePanel icon={FolderKanbanIcon} title="No projects yet">
            Projects show up here with their status, owner and due date as teams add them.
          </StatePanel>
        ) : rows.length === 0 && !unknown.length ? (
          <StatePanel icon={SearchXIcon} title="No projects match these filters">
            Try another status, team or search, or clear the filters.
            <Button variant="outline" className="mt-4" onClick={clearFilters}>
              Clear filters
            </Button>
          </StatePanel>
        ) : rows.length > 0 ? (
          <>
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader className="bg-muted/60">
                <TableRow className="hover:bg-transparent">
                  <SortHead {...sortHead("name")} className="pl-4">
                    Project
                  </SortHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Owner</TableHead>
                  <SortHead {...sortHead("due")} className="pr-4 text-right">
                    Due
                  </SortHead>
                  <SortHead {...sortHead("updated")} className="hidden pr-4 text-right xl:table-cell">
                    Updated
                  </SortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((p) => (
                  <TableRow
                    key={p.id}
                    className="animate-in cursor-pointer duration-(--duration-slow) fade-in-0"
                    data-state={p.id === openId ? "selected" : undefined}
                    onClick={() => openItem(p.id)}
                  >
                    <TableCell className="py-3 pl-4 whitespace-normal">
                      <Link
                        href={itemHref(p.id)}
                        className="font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return
                          e.preventDefault()
                          openItem(p.id)
                        }}
                      >
                        {p.name}
                      </Link>
                      {/* The meta line under the name instead of a low-value column of its own. */}
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {p.team}
                        <span className="md:hidden"> · {p.owner}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {p.owner}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      <div>{formatDate(p.due)}</div>
                      {p.status !== "done" && (
                        <div className={cn("text-xs text-muted-foreground", isOverdue(p) && "text-danger")}>{relativeDay(p.due)}</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden pr-4 text-right text-muted-foreground xl:table-cell">{relativeTime(p.updated)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination {...page} onPage={(n) => url.set({ page: n > 1 ? String(n) : null })} />
          </>
        ) : null}
      </section>

      <ProjectSheet project={open} onClose={closeItem} onStatus={changeStatus} />
    </Page>
  )
}

/** The summary strip: each figure picks its status filter. They count what the search and team show. */
function Summary({ items, loading, active, onPick }: { items: Project[]; loading: boolean; active: string; onPick: (s: string | null) => void }) {
  const count = (s: Status) => items.filter((p) => p.status === s).length
  const soon = items.filter((p) => p.status !== "done" && !isOverdue(p) && relativeDayCount(p.due) <= 7).length
  // A figure whose click wouldn't change anything isn't a button: "All projects" while nothing is filtered has nothing
  // to clear, so it stays a plain figure.
  const pick = (key: Status | null) =>
    key === null && !active ? {} : { pressed: key === active, onPick: () => onPick(key === null || key === active ? null : key) }
  return (
    <StatStrip
      loading={loading}
      stats={[
        { label: "All projects", value: items.length, note: `${count("done")} done`, ...pick(null) },
        { label: "On track", value: count("on-track"), note: `${soon} due within a week`, dot: STATUS["on-track"].dot, ...pick("on-track") },
        { label: "At risk", value: count("at-risk"), note: "Need a decision or help", dot: STATUS["at-risk"].dot, tone: count("at-risk") ? "warn" : undefined, ...pick("at-risk") },
        { label: "Late", value: count("late"), note: "Past their due date", dot: STATUS.late.dot, tone: count("late") ? "danger" : undefined, ...pick("late") },
      ]}
    />
  )
}

const relativeDayCount = (iso: string) => Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000)

