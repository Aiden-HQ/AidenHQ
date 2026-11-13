import * as React from "react"
import type { Project, Status } from "@/lib/projects"

// Loads the projects once and keeps them; a refresh keeps the old rows on screen (guidelines: States and speed). `setStatus` is
// optimistic: the row changes at once and rolls back if the server refuses.
// Sample only: ?preview=loading|error|empty shows that state, so a reviewer can screenshot each one. Delete it with the
// sample data.

type State = { status: "loading" | "ready" | "error"; items: Project[]; error?: string }

export function useProjects() {
  const preview = new URLSearchParams(location.search).get("preview")
  const [state, setState] = React.useState<State>({ status: "loading", items: [] })

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, status: s.items.length ? "ready" : "loading", error: undefined }))
    try {
      if (preview === "loading") return
      if (preview === "error") throw new Error("The server didn't answer.")
      const res = await fetch("/api/items")
      if (!res.ok) throw new Error(`The server answered ${res.status}.`)
      const { items } = (await res.json()) as { items: Project[] }
      setState({ status: "ready", items: preview === "empty" ? [] : items })
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: e instanceof Error ? e.message : String(e) }))
    }
  }, [preview])

  React.useEffect(() => void load(), [load])

  const current = React.useRef(state)
  current.current = state

  const setStatus = React.useCallback(async (id: string, status: Status) => {
    const before = current.current.items.find((p) => p.id === id)
    setState((s) => ({ ...s, items: s.items.map((p) => (p.id === id ? { ...p, status } : p)) }))
    try {
      const res = await fetch(`/api/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The server answered ${res.status}.`)
      const saved = (await res.json()) as Project
      setState((s) => ({ ...s, items: s.items.map((p) => (p.id === id ? saved : p)) }))
      return { ok: true as const, before }
    } catch (e) {
      setState((s) => ({ ...s, items: s.items.map((p) => (p.id === id && before ? before : p)) }))
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  }, [])

  return { ...state, reload: load, setStatus }
}
