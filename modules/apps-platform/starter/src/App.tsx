import type { ComponentType } from "react"
import { FolderKanbanIcon } from "lucide-react"
import { Toaster } from "@/components/ui/toaster"
import { ThemeToggle } from "@/components/theme-toggle"
import { TopBarShell } from "@/components/blocks/top-bar-shell"
import { useLocation } from "@/lib/navigation"
import { ProjectsPage } from "@/pages/projects"
import { TeamsPage } from "@/pages/teams"
import { NotFoundPage } from "@/pages/not-found"

const APP_NAME = "Acme Projects"

// The example app's shell and routes. Pick the shell that fits the app's navigation (TopBarShell, SidebarShell,
// BareShell or your own); none is required. The page comes from `useLocation()`, so a link click, Back/Forward and a
// reload all render the route the URL names. Every route here is also in server.mjs `PAGES`.
const ROUTES: Record<string, ComponentType> = { "/": ProjectsPage, "/teams": TeamsPage }
const NAV = [
  { href: "/", label: "Projects" },
  { href: "/teams", label: "Teams" },
]

export function App() {
  const { path } = useLocation()
  const Page = ROUTES[path] ?? NotFoundPage
  return (
    <>
      <TopBarShell
        appName={APP_NAME}
        logo={<FolderKanbanIcon className="size-5 text-primary" aria-hidden />}
        nav={NAV}
        path={path}
        actions={<ThemeToggle />}
      >
        <Page />
      </TopBarShell>
      <Toaster />
    </>
  )
}
