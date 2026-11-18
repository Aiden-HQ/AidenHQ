import { RotateCwIcon, UsersIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Page, PageHeader } from "@/components/blocks/page"
import { StatePanel, TableSkeleton } from "@/components/blocks/states"
import { useProjects } from "@/hooks/use-projects"
import { Link } from "@/lib/navigation"
import { STATUS, type Status } from "@/lib/projects"

// A second route, to show navigation between pages: each team links to the projects page filtered to it (`/?team=…`),
// so the state travels in the URL and Back returns here.

export function TeamsPage() {
  const { status, items, error, reload } = useProjects()
  const teams = [...new Set(items.map((p) => p.team))].sort().map((team) => {
    const of = items.filter((p) => p.team === team)
    return { team, total: of.length, count: (s: Status) => of.filter((p) => p.status === s).length }
  })
  const shown: Status[] = ["on-track", "at-risk", "late"]

  return (
    <Page>
      <PageHeader title="Teams" description="Each team's projects by status. Pick a team to see its projects." />
      {status === "error" && !items.length ? (
        <StatePanel icon={RotateCwIcon} title="Couldn't load teams" role="alert">
          {error}
          <Button variant="outline" className="mt-4" onClick={reload}>
            <RotateCwIcon /> Try again
          </Button>
        </StatePanel>
      ) : status === "loading" && !items.length ? (
        <TableSkeleton label="Loading teams" />
      ) : !teams.length ? (
        <StatePanel icon={UsersIcon} title="No teams yet">
          Teams show up here once they have a project.
        </StatePanel>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/60">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Team</TableHead>
                {shown.map((s) => (
                  <TableHead key={s} className="text-right">
                    {STATUS[s].label}
                  </TableHead>
                ))}
                <TableHead className="pr-4 text-right">Projects</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((t) => (
                <TableRow key={t.team}>
                  <TableCell className="py-3 pl-4">
                    <Link href={`/?team=${encodeURIComponent(t.team)}`} className="font-medium underline-offset-4 hover:underline">
                      {t.team}
                    </Link>
                  </TableCell>
                  {shown.map((s) => (
                    <TableCell key={s} className="text-right tabular-nums">
                      {t.count(s).toLocaleString()}
                    </TableCell>
                  ))}
                  <TableCell className="pr-4 text-right tabular-nums">{t.total.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  )
}
