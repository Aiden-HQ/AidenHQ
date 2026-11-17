import * as React from "react"
import type { LucideIcon } from "lucide-react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"

// A command palette (shadcn's Command in a dialog, cmdk underneath): ⌘K or Ctrl+K opens it from anywhere; people jump to
// a page or run an action by typing. For apps with many destinations or records; most small apps don't need one.
export type PaletteItem = { id: string; label: string; icon?: LucideIcon; shortcut?: string; run: () => void }

export function CommandPalette({
  groups,
  open: controlled,
  onOpenChange,
  placeholder = "Type a command or search…",
}: {
  groups: { heading: string; items: PaletteItem[] }[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  placeholder?: string
}) {
  const [own, setOwn] = React.useState(false)
  const open = controlled ?? own
  const setOpen = onOpenChange ?? setOwn
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(!open)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, setOpen])
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Search for a page or an action">
      <CommandInput placeholder={placeholder} />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.items.map((i) => (
              <CommandItem
                key={i.id}
                value={i.label}
                onSelect={() => {
                  setOpen(false)
                  i.run()
                }}
              >
                {i.icon && <i.icon aria-hidden />}
                {i.label}
                {i.shortcut && <CommandShortcut>{i.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
