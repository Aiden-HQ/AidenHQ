import { Badge } from "@/components/ui/badge"
import { STATUS, type Status } from "@/lib/projects"
import { cn } from "@/lib/utils"

/** A status as a coloured dot plus its word, in a crisp outlined badge. */
export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 rounded-md border-[1.5px] bg-background font-semibold", STATUS[status].badge, className)}>
      <span aria-hidden className={cn("size-2 rounded-[2px]", STATUS[status].dot)} />
      {STATUS[status].label}
    </Badge>
  )
}
