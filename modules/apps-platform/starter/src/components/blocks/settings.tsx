import * as React from "react"
import { cn } from "@/lib/utils"

// Settings rows (after the settings pages in shadcn's blocks): a label and one line of explanation on the left, the
// control on the right, rows divided by lines inside one group. For forms people fill in once, use FormSection and Field.
export function SettingsGroup({ title, description, children, className }: { title?: string; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const id = React.useId()
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("flex flex-col gap-3", className)}>
      {title && (
        <div className="space-y-1">
          <h2 id={id} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className="divide-y rounded-xl border">{children}</div>
    </section>
  )
}

/** One setting. `htmlFor` ties the label to the control (give the control that id). */
export function SettingsRow({ label, description, htmlFor, children }: { label: string; description?: React.ReactNode; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5">
      <div className="min-w-0 flex-1 space-y-0.5 sm:min-w-64">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
