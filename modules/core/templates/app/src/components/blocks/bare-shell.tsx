import type { ReactNode } from "react"
import { PoweredBy } from "@/components/powered-by"
import { cn } from "@/lib/utils"

// An optional shell with no chrome: just the page, for a single-view app, an embed, a sign-in or a status page.
// `variant`: `full` (the page as it is) or `centered` (a narrow column in the middle of a muted page, for a form or a
// short message). Apps with navigation use TopBarShell or SidebarShell.
export function BareShell({ variant = "full", children }: { variant?: "full" | "centered"; children: ReactNode }) {
  return (
    <main
      id="content"
      data-variant={variant}
      className={cn("min-w-0", variant === "centered" && "flex min-h-svh items-center justify-center bg-page px-4 py-10")}
    >
      {variant === "centered" ? (
        <div className="w-full max-w-md">
          {children}
          <PoweredBy />
        </div>
      ) : (
        <>
          {children}
          <PoweredBy />
        </>
      )}
    </main>
  )
}
