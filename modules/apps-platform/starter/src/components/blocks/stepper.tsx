import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// Steps for a multi-step form or a setup flow (after Origin UI's stepper): where the person is, what is done and what is
// left. Keep the current step in the URL (`useUrlState`) so Back works; each step validates before the next. `variant`:
// `numbered` (circles with numbers and labels) or `bar` (a thin segmented bar with the current label, for tight spaces).
export function Stepper({
  steps,
  current,
  onStep,
  variant = "numbered",
  className,
}: {
  steps: string[]
  /** The current step's index (0-based). */
  current: number
  /** Lets people go back to a finished step; steps ahead stay locked. */
  onStep?: (index: number) => void
  variant?: "numbered" | "bar"
  className?: string
}) {
  if (variant === "bar")
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <p className="text-sm">
          <span className="text-muted-foreground tabular-nums">
            Step {current + 1} of {steps.length}:
          </span>{" "}
          <span className="font-medium">{steps[current]}</span>
        </p>
        <div aria-hidden className="flex gap-1">
          {steps.map((s, i) => (
            <span key={s} className={cn("h-1 flex-1 rounded-full", i <= current ? "bg-primary" : "bg-muted")} />
          ))}
        </div>
      </div>
    )
  return (
    <ol className={cn("flex items-center gap-2", className)} aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current
        const body = (
          <>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                done && "border-primary bg-primary text-primary-foreground",
                i === current && "border-primary text-link",
                i > current && "text-muted-foreground"
              )}
            >
              {done ? <CheckIcon aria-hidden className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("text-sm whitespace-nowrap max-sm:sr-only", i === current ? "font-medium" : "text-muted-foreground")}>{s}</span>
          </>
        )
        return (
          <li key={s} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none" aria-current={i === current ? "step" : undefined}>
            {done && onStep ? (
              <button type="button" onClick={() => onStep(i)} className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
                {body}
              </button>
            ) : (
              <span className="flex items-center gap-2">{body}</span>
            )}
            {i < steps.length - 1 && <span aria-hidden className={cn("h-px min-w-4 flex-1", done ? "bg-primary" : "bg-border")} />}
          </li>
        )
      })}
    </ol>
  )
}
