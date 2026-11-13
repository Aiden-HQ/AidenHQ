import { FolderKanbanIcon } from "lucide-react"
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import { ProjectsPage } from "@/pages/projects"
import { CatalogPage } from "@/pages/catalog"
import { NotFoundPage } from "@/pages/not-found"

const APP_NAME = "Acme Projects"

// A sample shell: a slim top bar for an app with a few destinations, always visible on phone and desktop. Replace it
// with what fits the app; an app with many destinations can use the SidebarShell block instead (guidelines: Layout and
// navigation). Take "Components" (the /catalog route) out of a real app's navigation.
const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Projects" },
  { href: "/catalog", label: "Components" },
]

export function App() {
  const path = location.pathname
  return (
    <TooltipProvider delayDuration={300}>
      <a
        href="#content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 md:px-8">
          <a href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight" aria-label={APP_NAME}>
            <FolderKanbanIcon className="size-5 text-primary" aria-hidden />
            <span className="max-sm:sr-only">{APP_NAME}</span>
          </a>
          <nav aria-label="Primary" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                aria-current={n.href === path ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-sm:py-3",
                  n.href === path && "bg-accent text-foreground"
                )}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="content" className="min-w-0">
        {path === "/" ? <ProjectsPage /> : path === "/catalog" ? <CatalogPage /> : <NotFoundPage />}
      </main>
      <Toaster />
    </TooltipProvider>
  )
}
