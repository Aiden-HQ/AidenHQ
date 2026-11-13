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
import { cn } from "@/lib/utils"

// An optional app shell for apps with many destinations or nested groups (guidelines: Layout and navigation): a
// collapsible sidebar on desktop and a bottom bar of up to five destinations on phones. An app with a few destinations
// uses a top bar instead (the starter's App.tsx). Swap it in for that shell's markup when the app outgrows a top bar.
export type NavItem = { href: string; label: string; icon: LucideIcon }

export function SidebarShell({
  appName,
  logo,
  nav,
  path,
  title,
  actions,
  children,
}: {
  appName: string
  logo: ReactNode
  nav: NavItem[]
  path: string
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <a href="/">
                  {logo}
                  <span className="truncate font-semibold tracking-tight">{appName}</span>
                </a>
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
                      <a href={n.href} aria-current={n.href === path ? "page" : undefined}>
                        <n.icon />
                        <span>{n.label}</span>
                      </a>
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
          <a href="/" className="flex items-center gap-2 md:hidden" aria-label={appName}>
            {logo}
          </a>
          <span className="text-sm font-medium">{title}</span>
          <div className="ml-auto">{actions}</div>
        </header>
        {children}
      </SidebarInset>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 flex h-16 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {nav.slice(0, 5).map((n) => (
          <a
            key={n.href}
            href={n.href}
            aria-current={n.href === path ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground",
              n.href === path && "text-link"
            )}
          >
            <n.icon className="size-5" aria-hidden />
            {n.label}
          </a>
        ))}
      </nav>
    </SidebarProvider>
  )
}
