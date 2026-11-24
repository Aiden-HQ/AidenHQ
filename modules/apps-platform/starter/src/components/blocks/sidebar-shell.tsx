import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { PoweredBy } from "@/components/powered-by"
import { Link } from "@/lib/navigation"
import { cn } from "@/lib/utils"

// An optional app shell for apps with many destinations or nested groups: a
// collapsible sidebar on desktop and a bottom bar of up to five destinations on phones. An app with a few destinations
// may use TopBarShell instead, or BareShell for no chrome. `variant`: `sidebar` (flush, the default), `floating` or `inset`.
export type NavItem = { href: string; label: string; icon: LucideIcon }

export function SidebarShell({
  appName,
  logo,
  nav,
  path,
  title,
  actions,
  variant = "sidebar",
  children,
}: {
  appName: string
  logo: ReactNode
  nav: NavItem[]
  path: string
  title: string
  actions?: ReactNode
  variant?: "sidebar" | "floating" | "inset"
  children: ReactNode
}) {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant={variant}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link href="/">
                  {logo}
                  <span className="truncate font-semibold tracking-tight">{appName}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((n) => (
                  <SidebarMenuItem key={n.href}>
                    <SidebarMenuButton asChild isActive={n.href === path} tooltip={n.label}>
                      <Link href={n.href} aria-current={n.href === path ? "page" : undefined}>
                        <n.icon />
                        <span>{n.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset id="content" className="min-w-0 max-md:pb-16">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur lg:px-6">
          <SidebarTrigger className="-ml-1 max-md:hidden" />
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4 max-md:hidden" />
          <Link href="/" className="flex items-center gap-2 md:hidden" aria-label={appName}>
            {logo}
          </Link>
          <span className="text-sm font-medium">{title}</span>
          <div className="ml-auto">{actions}</div>
        </header>
        {children}
        <PoweredBy className="mt-auto max-md:mb-16" />
      </SidebarInset>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 flex h-16 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden overflow-x-auto"
      >
        {nav.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={n.href === path ? "page" : undefined}
            className={cn(
              "flex min-w-16 flex-1 shrink-0 px-2 whitespace-nowrap flex-col items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring justify-center gap-1 text-xs font-medium text-muted-foreground",
              n.href === path && "text-link"
            )}
          >
            <n.icon className="size-5" aria-hidden />
            {n.label}
          </Link>
        ))}
      </nav>
    </SidebarProvider>
  )
}
