import * as React from "react"

// A detail view's facts as label-value pairs (guidelines §12): after the status and next step, before history. Empty
// values are left out rather than shown as "—"; put the source link in the value when the fact came from somewhere.

export function DetailList({ items }: { items: { label: string; value?: React.ReactNode }[] }) {
  const shown = items.filter((i) => i.value !== undefined && i.value !== null && i.value !== "")
  return (
    <dl className="grid grid-cols-[minmax(6rem,8rem)_1fr] gap-x-4 gap-y-3 text-sm">
      {shown.map((i) => (
        <React.Fragment key={i.label}>
          <dt className="text-muted-foreground">{i.label}</dt>
          <dd className="min-w-0 break-words">{i.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}
