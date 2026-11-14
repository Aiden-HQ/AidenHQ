import { FolderKanbanIcon } from "lucide-react"
import { Toaster } from "@/components/ui/toaster"
import { ThemeToggle } from "@/components/theme-toggle"
import { TopBarShell } from "@/components/blocks/top-bar-shell"
import { ProjectsPage } from "@/pages/projects"
import { NotFoundPage } from "@/pages/not-found"

const APP_NAME = "Acme Projects"

// The example app's shell and routes. Pick the shell that fits the app's navigation (TopBarShell, SidebarShell,
// BareShell or your own); none is required.
const NAV = [{ href: "/", label: "Projects" }]

export function App() {
  const path = location.pathname
  return (
    <>
      <TopBarShell
        appName={APP_NAME}
        logo={<FolderKanbanIcon className="size-5 text-primary" aria-hidden />}
        nav={NAV}
        path={path}
        actions={<ThemeToggle />}
      >
        {path === "/" ? <ProjectsPage /> : <NotFoundPage />}
      </TopBarShell>
      <Toaster />
    </>
  )
}
