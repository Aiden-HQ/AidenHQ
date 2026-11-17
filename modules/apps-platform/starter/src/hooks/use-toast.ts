import * as React from "react"
import type { ToastActionElement, ToastProps } from "@/components/ui/toast"

// A tiny store for toasts: `toast({ title, description, action, variant })` from anywhere, `useToast()` in <Toaster />.
// At most three on screen; the oldest goes first.

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}

const LIMIT = 3
let toasts: ToasterToast[] = []
let count = 0
const listeners = new Set<(t: ToasterToast[]) => void>()
const emit = () => listeners.forEach((l) => l(toasts))

function dismiss(id: string) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, open: false } : t))
  emit()
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    emit()
  }, 300)
}

export function toast(props: Omit<ToasterToast, "id">) {
  const id = String(++count)
  toasts = [{ ...props, id, open: true, onOpenChange: (open: boolean) => !open && dismiss(id) }, ...toasts].slice(0, LIMIT)
  emit()
  return { id, dismiss: () => dismiss(id) }
}

export function useToast() {
  const [state, setState] = React.useState(toasts)
  React.useEffect(() => {
    listeners.add(setState)
    return () => void listeners.delete(setState)
  }, [])
  return { toasts: state, toast, dismiss }
}
