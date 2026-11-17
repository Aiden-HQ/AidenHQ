import { cn } from "@/lib/utils"

/** A small trend line in the current text colour, decorative (the number and note beside it carry the meaning). */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 64},${22 - ((v - min) / span) * 20}`).join(" ")
  return (
    <svg aria-hidden viewBox="0 0 64 24" preserveAspectRatio="none" className={cn("h-6 w-16 shrink-0", className)}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
