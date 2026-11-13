import { BlocksIcon, FolderKanbanIcon, type LucideIcon } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import { ProjectsPage } from "@/pages/projects"
import { CatalogPage } from "@/pages/catalog"
import { NotFoundPage } from "@/pages/not-found"

const APP_NAME = "Acme Projects"

// Primary destinations: always visible, in the sidebar on desktop and the bottom bar on phones (never behind a menu).
const NAV: { href: string; label: string; icon: LucideIcon; title: string }[] = [
  { href: "/", label: "Projects", icon: FolderKanbanIcon, title: "Projects" },
  { href: "/catalog", label: "Components", icon: BlocksIcon, title: "Components" },
]

export function App() {
  const path = location.pathname
  const current = NAV.find((n) => n.href === path)
  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider>
        <a
          href="#content"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <a href="/">
                    <Logo />
                    <span className="truncate font-bold tracking-tight text-sidebar-accent-foreground">{APP_NAME}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map((n) => (
                    <SidebarMenuItem key={n.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={n.href === path}
                        tooltip={n.label}
                        className="data-[active=true]:bg-primary-gradient data-[active=true]:text-primary-foreground data-[active=true]:shadow-sm"
                      >
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
          <SidebarFooter>
            <p className="px-2 text-xs text-sidebar-muted-foreground group-data-[collapsible=icon]:hidden">Sample data</p>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset id="content" className="min-w-0 max-md:pb-16">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur lg:px-6">
            <SidebarTrigger className="-ml-1 max-md:hidden" />
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4 max-md:hidden" />
            <a href="/" className="flex items-center gap-2 md:hidden" aria-label={APP_NAME}>
              <Logo />
            </a>
            <span className="text-sm font-medium">{current?.title ?? "Not found"}</span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
          {path === "/" ? <ProjectsPage /> : path === "/catalog" ? <CatalogPage /> : <NotFoundPage />}
        </SidebarInset>
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-20 flex h-16 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          {NAV.map((n) => (
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
      <Toaster />
    </TooltipProvider>
  )
}

function Logo() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-gradient text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.2)]">
      <FolderKanbanIcon className="size-4" aria-hidden />
    </span>
  )
}
