import * as React from "react"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

// Form layout: one column, a visible label on every control, the hint or error under it and wired to it
// (`aria-describedby`, `aria-invalid`), optional fields marked, groups of fields under a heading, and the buttons at the
// end, primary first, full width on phones. Put a form on the page background (`Page width="narrow"`), or in one Card.

type FieldProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }

/**
 * A labelled control. Pass one control (Input, Textarea, Checkbox…) as the child and it gets the id and aria; for a
 * Select, pass a function that spreads them onto the SelectTrigger: `{(p) => <Select><SelectTrigger {...p}>…}`.
 */
export function Field({
  label,
  hint,
  error,
  optional,
  children,
}: {
  label: string
  hint?: React.ReactNode
  error?: React.ReactNode
  optional?: boolean
  children: React.ReactElement<FieldProps> | ((props: FieldProps) => React.ReactNode)
}) {
  const id = React.useId()
  const note = error || hint ? `${id}-note` : undefined
  const props: FieldProps = { id, "aria-describedby": note, "aria-invalid": error ? true : undefined }
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {typeof children === "function" ? children(props) : React.cloneElement(children, props)}
      {note && (
        <p id={note} className={cn("text-sm", error ? "text-danger" : "text-muted-foreground")}>
          {error || hint}
        </p>
      )}
    </div>
  )
}

/** A group of fields under a heading; groups are divided by a line, never boxed. */
export function FormSection({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-5">
      <Separator className="first:hidden" />
      <div className="space-y-1">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** The form's buttons, at the end: the primary first, full width on phones. */
export function FormActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 pt-2 sm:flex-row [&>*]:max-sm:w-full">{children}</div>
}
