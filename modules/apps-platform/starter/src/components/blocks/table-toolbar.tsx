import type * as React from "react"
import { Columns3Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Table extras (after shadcn's data-table example and Origin UI's tables), for tables with many columns or bulk actions.
// No table library: the page owns its columns and selection, keeps them in the URL where they change the view
// (`?cols=`), and passes them here.

/** Show or hide columns. Columns marked `fixed` (the name, usually) can't be hidden. */
export function ColumnToggle({
  columns,
  visible,
  onChange,
}: {
  columns: { id: string; label: string; fixed?: boolean }[]
  visible: string[]
  onChange: (visible: string[]) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Columns3Icon /> Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={c.fixed || visible.includes(c.id)}
            disabled={c.fixed}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onChange(on ? [...visible, c.id] : visible.filter((v) => v !== c.id))}
          >
            {c.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A bar that replaces the filters while rows are selected: how many, the bulk actions, and a way out. */
export function SelectionBar({ count, noun = "item", actions, onClear }: { count: number; noun?: string; actions: React.ReactNode; onClear: () => void }) {
  if (!count) return null
  return (
    <div role="region" aria-label="Selection" className="flex flex-wrap items-center gap-2 rounded-lg border bg-primary-soft px-3 py-2">
      <span className="text-sm font-medium text-link tabular-nums" aria-live="polite">
        {count} {noun}
        {count === 1 ? "" : "s"} selected
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions}
        <Button variant="ghost" size="sm" onClick={onClear}>
          <XIcon /> Clear
        </Button>
      </div>
    </div>
  )
}
