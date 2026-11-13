import { Button } from "@/components/ui/button"

export function NotFoundPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This address doesn't match a page in the app.</p>
      <Button asChild variant="outline" className="mt-2">
        <a href="/">Back to projects</a>
      </Button>
    </div>
  )
}
