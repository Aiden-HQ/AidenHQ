// The component catalog: a dev-only preview of the starter's library (`bun run catalog`). It is not an app route and is
// never built: `vite build` builds index.html only, and index.css doesn't scan this folder. Apps leave it out.
// `?specimen=preset|topbar|topbar-brand|sidebar|sidebar-inset|bare|bare-centered` renders one specimen (the catalog's frames).
import "@/lib/csp"
import "./catalog.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CatalogPage } from "./catalog"
import { Specimen } from "./specimen"

const q = new URLSearchParams(location.search)
const specimen = q.get("specimen")

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      {specimen ? (
        <Specimen kind={specimen} palette={q.get("palette") ?? undefined} />
      ) : (
        <main id="content">
          <CatalogPage />
        </main>
      )}
      <Toaster />
    </TooltipProvider>
  </StrictMode>
)
