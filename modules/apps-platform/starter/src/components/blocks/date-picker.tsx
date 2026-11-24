import * as React from "react"
import { CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// Date and date-range pickers (shadcn's date picker: Popover + Calendar, react-day-picker underneath). A range picker
// can offer presets ("Last 7 days") beside the calendar, the way analytics tools do. Keep the chosen dates in the URL
// as ISO days (YYYY-MM-DD) like any other filter.
export type { DateRange }

const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  className,
  "aria-label": label,
}: {
  value?: Date
  onChange: (d: Date | undefined) => void
  placeholder?: string
  className?: string
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label} className={cn("justify-start font-normal", !value && "text-muted-foreground", className)}>
          <CalendarIcon aria-hidden />
          {value ? fmt(value) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value}
          onSelect={(d) => {
            onChange(d)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export type RangePreset = { label: string; range: () => DateRange }
const daysAgo = (n: number) => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n)
}
export const RANGE_PRESETS: RangePreset[] = [
  { label: "Last 7 days", range: () => ({ from: daysAgo(6), to: daysAgo(0) }) },
  { label: "Last 30 days", range: () => ({ from: daysAgo(29), to: daysAgo(0) }) },
  { label: "Last 90 days", range: () => ({ from: daysAgo(89), to: daysAgo(0) }) },
  { label: "This year", range: () => ({ from: new Date(new Date().getFullYear(), 0, 1), to: daysAgo(0) }) },
]

export function DateRangePicker({
  value,
  onChange,
  presets = RANGE_PRESETS,
  placeholder = "Pick dates",
  className,
  "aria-label": label,
}: {
  value?: DateRange
  onChange: (r: DateRange | undefined) => void
  /** Shortcuts beside the calendar; pass [] for none. */
  presets?: RangePreset[]
  placeholder?: string
  className?: string
  "aria-label"?: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label} className={cn("justify-start font-normal", !value?.from && "text-muted-foreground", className)}>
          <CalendarIcon aria-hidden />
          {value?.from ? (value.to ? `${fmt(value.from)} – ${fmt(value.to)}` : fmt(value.from)) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-auto p-0 max-sm:flex-col" align="start">
        {presets.length > 0 && (
          <div className="flex flex-col gap-0.5 border-r p-2 max-sm:flex-row max-sm:flex-wrap max-sm:border-r-0 max-sm:border-b">
            {presets.map((p) => (
              <Button key={p.label} variant="ghost" size="sm" className="justify-start font-normal" onClick={() => onChange(p.range())}>
                {p.label}
              </Button>
            ))}
          </div>
        )}
        <Calendar mode="range" selected={value} defaultMonth={value?.from} onSelect={onChange} numberOfMonths={2} />
      </PopoverContent>
    </Popover>
  )
}
