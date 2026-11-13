import * as React from "react"

// State that lives in the URL's query string, so a view can be shared and survives a refresh (guidelines: Filters, search and updates).
// `set` replaces the entry (filters: Back doesn't step through every keystroke); `push` adds one (opening a detail:
// Back closes it). Empty values are dropped from the URL.

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
if (typeof window !== "undefined") window.addEventListener("popstate", notify)

function write(changes: Record<string, string | null>, mode: "replace" | "push") {
  const params = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(changes)) (v ? params.set(k, v) : params.delete(k))
  const qs = params.toString()
  const url = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`
  if (mode === "push") history.pushState(null, "", url)
  else history.replaceState(history.state, "", url)
  notify()
}

export function useUrlState() {
  const search = React.useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => location.search
  )
  const params = React.useMemo(() => new URLSearchParams(search), [search])
  return {
    get: (key: string) => params.get(key) ?? "",
    set: (changes: Record<string, string | null>) => write(changes, "replace"),
    push: (changes: Record<string, string | null>) => write(changes, "push"),
  }
}
