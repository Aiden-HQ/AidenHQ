import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { PoweredBy } from "@/components/powered-by"
import { cn } from "@/lib/utils"

// An optional app shell for an app with a few destinations: a slim top bar (logo and name, links, actions) over the
// page, on phones and desktop. `variant`: `plain` (the page's surface with a bottom line) or `brand` (the palette's deep
// sidebar colour where it has one). Apps with many destinations use SidebarShell; BareShell has no chrome at all.
export type TopBarLink = { href: string; label: string; icon?: LucideIcon }

export function TopBarShell({
  appName,
  logo,
  nav,
  path,
  actions,
  variant = "plain",
  children,
}: {
  appName: string
  logo?: ReactNode
  nav: TopBarLink[]
  path: string
  actions?: ReactNode
  variant?: "plain" | "brand"
  children: ReactNode
}) {
  const brand = variant === "brand"
  return (
    <>
      <SkipLink />
      <header
        data-variant={variant}
        className={cn("sticky top-0 z-10", brand ? "bg-sidebar text-sidebar-foreground" : "border-b bg-background/95 backdrop-blur")}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 md:px-8">
          <a
            href="/"
            className={cn("flex shrink-0 items-center gap-2 font-semibold tracking-tight", brand && "text-sidebar-accent-foreground")}
            aria-label={appName}
          >
            {logo}
            <span className="max-sm:sr-only">{appName}</span>
          </a>
          <nav aria-label="Primary" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {nav.map((n) => (
              <a
                key={n.href}
                href={n.href}
                aria-current={n.href === path ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors max-sm:py-3 [&_svg]:size-4",
                  brand
                    ? "text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                )}
              >
                {n.icon && <n.icon aria-hidden />}
                {n.label}
              </a>
            ))}
          </nav>
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </div>
      </header>
      <main id="content" className="min-w-0">
        {children}
      </main>
      <PoweredBy />
    </>
  )
}

/** The first focusable thing on every shell: jumps past the navigation to the page. */
export function SkipLink() {
  return (
    <a
      href="#content"
      className="sr-only z-50 rounded-md bg-background px-3 py-2 text-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
    >
      Skip to content
    </a>
  )
}
