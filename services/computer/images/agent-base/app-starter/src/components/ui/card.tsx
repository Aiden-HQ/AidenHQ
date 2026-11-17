import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// A card inside a link lifts 1px with a soft shadow on hover (it enters slower than it leaves).
const linked = "transition-[translate,box-shadow] duration-(--duration-exit) ease-(--ease) [a:hover_&]:-translate-y-px [a:hover_&]:shadow-(--shadow) [a:hover_&]:duration-(--duration) [a:hover_&]:ease-(--ease-out)"

const cardVariants = cva(`flex flex-col gap-6 rounded-xl bg-card py-6 text-card-foreground ${linked}`, {
  variants: {
    variant: {
      default: "border shadow-sm",
      // A muted fill with no line or shadow: a group that sits within the page rather than above it.
      flat: "bg-muted",
      bordered: "border",
      // Lifted off the page: the one object a view is about.
      elevated: "shadow-(--shadow)",
    },
  },
  defaultVariants: { variant: "default" },
})

function Card({ className, variant = "default", ...props }: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" data-variant={variant} className={cn(cardVariants({ variant }), className)} {...props} />
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  cardVariants,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
