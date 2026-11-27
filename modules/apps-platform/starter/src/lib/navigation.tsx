import * as React from "react"

// The app's navigation: one store for the address (path and query), so the page on screen always matches the URL after
// a link click, Back or Forward, and a reload. Every route and every piece of URL state reads it:
// - `useLocation()` gives `{ path, search, params }` and re-renders when either the path or the query changes.
// - `Link` is an <a href> that moves without a page load. A modified or middle click, `target`, `download`, another
//   origin and /api/ links do what the browser does.
// - `navigate(href)` moves from code; `{ replace: true }` swaps the current history entry instead of adding one (as does
//   moving to the address already shown, so Back never steps through a duplicate). Every move lands at the top of the new
//   page, including one to the address already shown: a brand or a "home" link always takes you home, scrolled to the top.
// - `useUrlState()` keeps a page's state in the query string (filters, `?item=`): `set` replaces the entry (Back doesn't
//   step through every keystroke), `push` adds one (opening a detail: Back closes it). Empty values are dropped.
// Each route is also listed in server.mjs `PAGES`, so a reload or a shared link to it answers 200.

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
if (typeof window !== "undefined") window.addEventListener("popstate", notify)
const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb))
const address = () => location.pathname + location.search

/** Move to `href`; `scroll` is off for a filter's query edit, which keeps the page where the reader left it. */
function move(href: string, replace: boolean, scroll = true) {
  const to = new URL(href, location.href)
  const target = to.pathname + to.search + to.hash
  if (target === location.pathname + location.search + location.hash) replace = true
  if (replace) history.replaceState(history.state, "", target)
  else history.pushState(null, "", target)
  notify()
  if (scroll) window.scrollTo({ top: 0 })
}

export function navigate(href: string, { replace = false }: { replace?: boolean } = {}) {
  move(href, replace)
}

export function useLocation() {
  const at = React.useSyncExternalStore(subscribe, address)
  return React.useMemo(() => {
    const u = new URL(at, "http://app")
    return { path: u.pathname, search: u.search, params: u.searchParams }
  }, [at])
}

export function Link({ href, onClick, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        if (props.target || props.download !== undefined) return
        const to = new URL(href, location.href)
        if (to.origin !== location.origin || to.pathname.startsWith("/api/")) return
        e.preventDefault()
        navigate(href)
      }}
    />
  )
}

export function useUrlState() {
  const { params } = useLocation()
  return {
    get: (key: string) => params.get(key) ?? "",
    set: (changes: Record<string, string | null>) => write(changes, true),
    push: (changes: Record<string, string | null>) => write(changes, false),
  }
}

function write(changes: Record<string, string | null>, replace: boolean) {
  const params = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(changes)) {
    if (v) params.set(k, v)
    else params.delete(k)
  }
  const qs = params.toString()
  move(`${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`, replace, false)
}
