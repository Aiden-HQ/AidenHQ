// The example's data model, filters and formatting. Replace with the app's own; keep the filter rules.

export type Status = "on-track" | "at-risk" | "late" | "done"
export type Source = { label: string; url: string }
export type Project = {
  id: string
  name: string
  team: string
  owner: string
  status: Status
  due: string
  updated: string
  next: string
  source: Source
  history: { at: string; text: string; source: Source }[]
}

// Each status has a word and a colour (the dot): meaning never rests on colour alone.
// `badge`: the outlined badge, a saturated border with the status's ink. Finished work is good news, so it takes the
// brand colour, not grey: a column of grey "Done" badges reads as disabled. Grey is for "not started" or "unknown".
export const STATUS: Record<Status, { label: string; dot: string; badge: string }> = {
  "on-track": { label: "On track", dot: "bg-ok-solid", badge: "border-ok-solid text-ok" },
  "at-risk": { label: "At risk", dot: "bg-warn-solid", badge: "border-warn-solid text-warn" },
  late: { label: "Late", dot: "bg-danger-solid", badge: "border-danger-solid text-danger" },
  done: { label: "Done", dot: "bg-primary", badge: "border-primary text-link" },
}
export const isStatus = (s: string): s is Status => s in STATUS

export type Filters = { q: string; status: string; team: string; sort: string }
export const SORTS = { due: "Due date", updated: "Last updated", name: "Name" } as const
export const isSort = (s: string): s is keyof typeof SORTS => s in SORTS

/** Projects matching the search and team (not status: the summary counts each status within these). */
export function inScope(items: Project[], f: Filters) {
  const q = f.q.trim().toLowerCase()
  return items.filter(
    (p) => (!f.team || p.team === f.team) && (!q || `${p.name} ${p.team} ${p.owner}`.toLowerCase().includes(q))
  )
}

export function applyFilters(items: Project[], f: Filters) {
  const rows = inScope(items, f).filter((p) => !f.status || p.status === f.status)
  const sort = isSort(f.sort) ? f.sort : "due"
  // By due date, finished projects go last: what needs attention comes first.
  return rows.sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "updated"
        ? b.updated.localeCompare(a.updated)
        : Number(a.status === "done") - Number(b.status === "done") || a.due.localeCompare(b.due)
  )
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const DAY = 86400000

/** "4 Dec" (and the year when it isn't this one). */
export function formatDate(iso: string) {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
  })
}

/** "in 5 days", "3 days ago", "tomorrow" for a due date. */
export function relativeDay(iso: string) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return rtf.format(Math.round((new Date(`${iso}T00:00:00`).getTime() - today.getTime()) / DAY), "day")
}

/** "2 hours ago", "yesterday" for a recent time; the date beyond a month. */
export function relativeTime(iso: string) {
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  if (abs < 3600000) return rtf.format(Math.round(diff / 60000), "minute")
  if (abs < DAY) return rtf.format(Math.round(diff / 3600000), "hour")
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), "day")
  return formatDate(iso)
}

export const isOverdue = (p: Project) => {
  const t = new Date()
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`
  return p.status !== "done" && p.due < today
}
export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
