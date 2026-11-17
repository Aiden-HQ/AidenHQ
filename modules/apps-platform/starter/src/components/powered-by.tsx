import { cn } from "@/lib/utils"

// A small "Powered by AidenHQ" credit, which every shell renders at the foot of the page by default. Not required:
// the app's owner may move or remove it.
export const AIDENHQ_REPO = "https://github.com/Aiden-HQ/AidenHQ"

export function PoweredBy({ className }: { className?: string }) {
  return (
    <footer className={cn("px-4 py-6 text-center text-xs text-muted-foreground", className)}>
      <a href={AIDENHQ_REPO} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">
        Powered by AidenHQ
      </a>
    </footer>
  )
}
