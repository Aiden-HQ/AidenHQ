import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// A select you can type into (shadcn's combobox pattern: Popover + Command), for lists too long to scan: people, repos,
// projects. One value, or several with `multiple` (chosen ones show as removable badges). For a handful of options use
// Select; for filters, keep the value in the URL like any other filter.
export type ComboOption = { value: string; label: string }

type Single = { multiple?: false; value: string | null; onChange: (v: string | null) => void }
type Multi = { multiple: true; value: string[]; onChange: (v: string[]) => void }

export function Combobox({
  options,
  placeholder = "Choose…",
  search = "Search…",
  empty = "Nothing matches.",
  className,
  ...p
}: (Single | Multi) & { options: ComboOption[]; placeholder?: string; search?: string; empty?: string; className?: string; "aria-label"?: string }) {
  const [open, setOpen] = React.useState(false)
  const chosen = p.multiple ? p.value : p.value ? [p.value] : []
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v
  const pick = (v: string) => {
    if (p.multiple) p.onChange(chosen.includes(v) ? chosen.filter((c) => c !== v) : [...chosen, v])
    else {
      p.onChange(v === p.value ? null : v)
      setOpen(false)
    }
  }
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" aria-expanded={open} aria-label={p["aria-label"]} className="w-full justify-between font-normal">
            <span className={cn("truncate", !chosen.length && "text-muted-foreground")}>
              {!chosen.length ? placeholder : p.multiple ? `${chosen.length} chosen` : labelOf(chosen[0])}
            </span>
            <ChevronsUpDownIcon aria-hidden className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command>
            <CommandInput placeholder={search} />
            <CommandList>
              <CommandEmpty>{empty}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.value} value={`v:${encodeURIComponent(o.value)}`} keywords={[o.label, o.value]} onSelect={() => pick(o.value)}>
                    <CheckIcon aria-hidden className={cn(chosen.includes(o.value) ? "opacity-100" : "opacity-0")} />
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {p.multiple && chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((v) => (
            <Badge key={v} variant="secondary" className="gap-1 pr-1">
              {labelOf(v)}
              <button type="button" aria-label={`Remove ${labelOf(v)}`} onClick={() => pick(v)} className="rounded-sm hover:bg-accent">
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
