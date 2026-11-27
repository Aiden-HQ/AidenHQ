import * as React from "react"
import { BellIcon, ChevronDownIcon, FolderKanbanIcon, InfoIcon, MoreHorizontalIcon, PlusIcon, RotateCwIcon, SearchXIcon, SettingsIcon, TrashIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ToastAction } from "@/components/ui/toast"
import { StatusBadge } from "@/components/status-badge"
import { ActivityList } from "@/components/blocks/activity"
import { Board } from "@/components/blocks/board"
import { BarList, ScheduleChart, TrendChart, type ScheduleRow } from "@/components/blocks/charts"
import { Pagination, paginate, SortHead } from "@/components/blocks/data-table"
import { DetailList } from "@/components/blocks/detail-list"
import { Field, FormActions, FormSection } from "@/components/blocks/form"
import { PageHeader, PageSection, PageSplit } from "@/components/blocks/page"
import { StatStrip } from "@/components/blocks/stat-strip"
import { StatePanel, TableSkeleton } from "@/components/blocks/states"
import { useThemeMode } from "@/components/theme-toggle"
import { toast } from "@/hooks/use-toast"
import { useUrlState } from "@/lib/navigation"
import { MoreBlocks, MoreComponents, PresetGallery, PRESETS, ShellGallery, Variants } from "./more"

// Every building block and component the starter has, themed, in one page (dev-only: `bun run catalog`). ?palette= and
// ?mode= pick the theme (the pickers set them), so `ui-review capture <dev url>/catalog.html --palettes neutral,crisp` covers any
// palette or preset. Nothing here is required: apps import what they need.

const PALETTES = ["neutral", "warm", "contrast", "data", ...PRESETS.map(([id]) => id)] as const

export function CatalogPage() {
  const url = useUrlState()
  const [mode, chooseMode] = useThemeMode()
  const palette = PALETTES.find((p) => p === url.get("palette")) ?? "neutral"
  React.useEffect(() => document.documentElement.setAttribute("data-palette", palette), [palette])

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-4 py-6 md:px-8 md:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Components</h1>
          <p className="text-sm text-muted-foreground">
            The building blocks pages are composed from, then the shadcn/ui components, in the AidenHQ theme.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={palette} onValueChange={(v) => url.set({ palette: v === "neutral" ? null : v })}>
            <SelectTrigger aria-label="Palette" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PALETTES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            variant="outline"
            value={url.get("mode") || mode}
            onValueChange={(v) => {
              if (!v) return
              url.set({ mode: null })
              chooseMode(v as "light" | "dark" | "system")
            }}
            aria-label="Mode"
          >
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
            <ToggleGroupItem value="system">System</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </header>

      <PresetGallery mode={document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"} />
      <ShellGallery mode={document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"} palette={palette} />
      <Blocks />
      <MoreBlocks />
      <Variants />

      <Section title="Colour" note="Surfaces, text and the status colours. Status is always a dot plus a word.">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {[
            ["Page", "bg-page"],
            ["Background", "bg-background"],
            ["Muted", "bg-muted"],
            ["Primary", "bg-primary"],
            ["OK", "bg-ok-solid"],
            ["Warning", "bg-warn-solid"],
            ["Danger", "bg-danger-solid"],
            ["Info", "bg-info-solid"],
          ].map(([name, cls]) => (
            <div key={name} className="flex items-center gap-3 text-sm">
              <span className={`size-8 shrink-0 rounded-md border ${cls}`} />
              {name}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status="on-track" />
          <StatusBadge status="at-risk" />
          <StatusBadge status="late" />
          <StatusBadge status="done" />
        </div>
      </Section>

      <Section title="Type" note="One title per page, clearly smaller section headings, one body size.">
        <div className="space-y-2">
          <p className="text-2xl font-bold tracking-tight">Page title</p>
          <p className="text-lg font-semibold tracking-tight">Section heading</p>
          <p className="text-sm font-medium">Item name (in tables, lanes, lists)</p>
          <p className="text-sm">Body text for tables and forms.</p>
          <p className="text-sm text-muted-foreground">Secondary text: context, hints and metadata.</p>
          <p className="text-xs text-muted-foreground">Smallest text: captions and column headers.</p>
        </div>
      </Section>

      <Section title="Button" note="One primary action per view. Destructive buttons name the action.">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Save project</Button>
          <Button variant="outline">Share view</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">
            <TrashIcon /> Archive
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" variant="outline" aria-label="Add">
            <PlusIcon />
          </Button>
          <Button disabled>Disabled</Button>
          <Button aria-busy="true" disabled>
            Saving…
          </Button>
        </div>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
      </Section>

      <Section title="Form controls" note="Every control has a visible label; hints sit under the field.">
        <div className="grid max-w-md gap-5">
          <div className="grid gap-2">
            <Label htmlFor="c-name">Project name</Label>
            <Input id="c-name" placeholder="Billing export" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-err">Due date</Label>
            <Input id="c-err" aria-invalid="true" aria-describedby="c-err-hint" defaultValue="31 Feb" />
            <p id="c-err-hint" className="text-sm text-danger">
              Enter a real date, like 4 Dec.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-team">Team</Label>
            <Select defaultValue="payments">
              <SelectTrigger id="c-team" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="payments">Payments</SelectItem>
                <SelectItem value="platform">Platform</SelectItem>
                <SelectItem value="mobile">Mobile</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-notes">Notes</Label>
            <Textarea id="c-notes" placeholder="What changed and why" aria-describedby="c-notes-hint" />
            <p id="c-notes-hint" className="text-sm text-muted-foreground">
              Optional. Links to sources help most.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Checkbox id="c-check" defaultChecked />
            <Label htmlFor="c-check">Notify the owner</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch id="c-switch" />
            <Label htmlFor="c-switch">Weekly digest</Label>
          </div>
        </div>
      </Section>

      <Section title="Toggle group and tabs">
        <ToggleGroup type="single" variant="outline" defaultValue="week" aria-label="Range">
          <ToggleGroupItem value="day">Day</ToggleGroupItem>
          <ToggleGroupItem value="week">Week</ToggleGroupItem>
          <ToggleGroupItem value="month">Month</ToggleGroupItem>
        </ToggleGroup>
        <Tabs defaultValue="overview" className="max-w-md">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-2 text-sm text-muted-foreground">
            The current state at a glance.
          </TabsContent>
          <TabsContent value="history" className="pt-2 text-sm text-muted-foreground">
            Every change, newest first.
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Menus and tooltips">
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                Actions <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <SettingsIcon /> Settings
              </DropdownMenuItem>
              <DropdownMenuItem>
                <BellIcon /> Notifications
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <TrashIcon /> Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More">
                <MoreHorizontalIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      <Section title="Dialog, sheet and toast" note="A sheet for details beside a list, a dialog only for a short decision.">
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Archive project…</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Archive "Billing export"?</DialogTitle>
                <DialogDescription>It leaves every list. You can restore it from Archived.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="destructive">Archive</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Billing export</SheetTitle>
                <SheetDescription>Payments · Ana Silva</SheetDescription>
              </SheetHeader>
              <p className="px-4 text-sm">Details open beside the list, and Back closes them.</p>
              <SheetFooter>
                <Button>Save</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Button
            variant="outline"
            onClick={() =>
              toast({
                title: "Project archived",
                description: "Billing export left every list.",
                action: <ToastAction altText="Undo the archive">Undo</ToastAction>,
              })
            }
          >
            Show toast
          </Button>
          <Button
            variant="outline"
            onClick={() => toast({ variant: "destructive", title: "Couldn't save", description: "The server didn't answer. Your changes are kept." })}
          >
            Error toast
          </Button>
        </div>
      </Section>

      <Section title="Table" note="One bordered container, header on a muted row, numbers right-aligned.">
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/60">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Open items</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="pl-4 font-medium">Billing export</TableCell>
                <TableCell>
                  <StatusBadge status="on-track" />
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">12</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pl-4 font-medium">Search v2</TableCell>
                <TableCell>
                  <StatusBadge status="at-risk" />
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">4</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section title="Card" note="For a single object or a settings group: never a card inside a card, never a grid of cards for data.">
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Weekly digest</CardTitle>
            <CardDescription>Sent on Mondays at 08:30.</CardDescription>
            <CardAction>
              <Switch aria-label="Weekly digest" defaultChecked />
            </CardAction>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Projects that changed status, and what is due this week.</CardContent>
          <CardFooter>
            <Button variant="outline" size="sm">
              Preview
            </Button>
          </CardFooter>
        </Card>
      </Section>

      <Section title="Alert, loading and avatars">
        <Alert className="max-w-xl">
          <InfoIcon />
          <AlertTitle>Partial data</AlertTitle>
          <AlertDescription>3 of 5 sources answered. The totals below count only those.</AlertDescription>
        </Alert>
        <div role="status" aria-label="Loading" className="flex max-w-sm flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="flex items-center gap-2">
          <Avatar>
            <AvatarFallback>AS</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>DP</AvatarFallback>
          </Avatar>
        </div>
      </Section>

      <Section title="Breadcrumb and separator">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Projects</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbPage>Billing export</BreadcrumbPage>
          </BreadcrumbList>
        </Breadcrumb>
        <Separator className="max-w-md" />
      </Section>

      <MoreComponents />
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t pt-8 first-of-type:border-0 first-of-type:pt-0">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

// The building blocks (src/components/blocks/): what pages are composed from. The example page uses them for real.
const SAMPLE = Array.from({ length: 23 }, (_, i) => ({ name: `Request ${i + 1}`, open: (i * 7) % 13 }))

// Sample data shaped like the hard cases real apps bring: uneven lanes (one empty, one long), long titles, and dates
// bunched into a few weeks with one outlier.
const TOPICS = ["Billing export", "Search v2", "Offline mode", "Audit log", "Cost alerts", "Status page", "Refund flow", "SSO rollout", "Usage dashboards", "Push notifications"]
const TEAMS = ["Payments", "Platform", "Mobile", "Identity", "Data"]
const title = (i: number) => (i % 5 === 2 ? `${TOPICS[i % TOPICS.length]} for partner accounts, with the reconciliation report and its exports` : TOPICS[i % TOPICS.length] + (i >= TOPICS.length ? ` phase ${Math.floor(i / TOPICS.length) + 1}` : ""))
const items = (lane: string, n: number, offset: number) =>
  Array.from({ length: n }, (_, k) => {
    const i = k + offset
    return { id: `${lane}-${k}`, title: title(i), href: "#", meta: `${TEAMS[i % TEAMS.length]} · ${(i % 27) + 1} Dec`, aside: i % 4 === 1 ? <span className="text-danger">+{(i % 9) + 2}d</span> : undefined }
  })
const BOARD = [
  { id: "backlog", title: "Backlog", dot: "bg-line-strong", items: items("backlog", 6, 0) },
  { id: "planned", title: "Planned", dot: "bg-info-solid", items: items("planned", 3, 3) },
  { id: "progress", title: "In progress", dot: "bg-warn-solid", items: items("progress", 5, 7) },
  { id: "review", title: "In review", dot: "bg-ok-solid", items: [], empty: "Nothing waiting for review" },
  { id: "done", title: "Done", dot: "bg-primary", items: items("done", 34, 12) },
]

const isoIn = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
const SCHEDULE: ScheduleRow[] = Array.from({ length: 24 }, (_, i) => {
  const to = i === 23 ? 38 : Math.round(i * 0.9) - 6
  const moved = i % 6 === 1
  const late = to < 0 && i % 3 === 0
  return {
    id: `s${i}`,
    label: title(i),
    href: "#",
    from: moved ? isoIn(to - 5 - (i % 4)) : undefined,
    to: isoIn(to),
    color: late ? "text-danger-solid" : moved ? "text-warn-solid" : "text-chart-1",
    note: moved ? <span className="text-danger">+{5 + (i % 4)}d</span> : late ? <span className="text-danger">Late</span> : undefined,
  }
})

const ACTIVITY = [
  { id: "a1", title: "Billing export moved out by 3 days", text: "Waiting on the bank's test environment.", when: "2 hours ago", source: <a href="#" className="text-link hover:underline">Team update</a>, dot: "bg-danger-solid" },
  { id: "a2", title: "Search v2 is at risk", text: "The index rebuild needs a decision on storage.", when: "Yesterday", source: <a href="#" className="text-link hover:underline">Planning notes</a>, dot: "bg-warn-solid" },
  { id: "a3", title: "Audit log shipped", text: "Live for every workspace.", when: "2 days ago", source: <a href="#" className="text-link hover:underline">Release notes</a> },
  { id: "a4", title: "Refund flow added", when: "3 days ago" },
  { id: "a5", title: "SSO rollout started", when: "4 days ago" },
  { id: "a6", title: "Cost alerts owner changed", when: "5 days ago" },
]

function Blocks() {
  const [sort, setSort] = React.useState<"name" | "open">("open")
  const [pageNo, setPageNo] = React.useState(1)
  const [picked, setPicked] = React.useState<string | null>("waiting")
  const sorted = [...SAMPLE].sort((a, b) => (sort === "open" ? b.open - a.open : a.name.localeCompare(b.name, undefined, { numeric: true })))
  const page = paginate(sorted, pageNo, 5)
  const sortBy = (col: "name" | "open") => () => {
    setSort(col)
    setPageNo(1)
  }
  return (
    <>
      <Section title="Page header" note="Page and PageHeader: one title, one line of context, actions on the right (one primary at most).">
        <PageHeader
          title="Requests"
          description="Everything people asked of the team. Updated 5 minutes ago."
          actions={
            <>
              <Button variant="outline">Export</Button>
              <Button>
                <PlusIcon /> New request
              </Button>
            </>
          }
        />
      </Section>

      <Section title="Stat strip" note="One surface split into cells, never floating cards. The figures that need attention get a tone; a cell can toggle the view's filter.">
        <StatStrip
          stats={[
            { label: "Open", value: 42, note: "8 opened this week", tone: "hero" },
            {
              label: "Waiting on us",
              value: 9,
              note: "Oldest is 3 days",
              dot: "bg-warn-solid",
              tone: "warn",
              pressed: picked === "waiting",
              onPick: () => setPicked((p) => (p === "waiting" ? null : "waiting")),
            },
            { label: "Overdue", value: 3, note: "Past the agreed date", dot: "bg-danger-solid", tone: "danger" },
            { label: "Closed", value: 118, note: "Last 30 days" },
          ]}
        />
      </Section>

      <Section title="Data table" note="SortHead and Pagination: sort and page live in the URL with the filters, and a filter change returns to page 1.">
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader className="bg-muted/60">
                <TableRow className="hover:bg-transparent">
                  <SortHead active={sort === "name"} onSort={sortBy("name")} className="pl-4">
                    Request
                  </SortHead>
                  <SortHead active={sort === "open"} direction="descending" onSort={sortBy("open")} className="pr-4 text-right">
                    Open items
                  </SortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell className="pl-4 font-medium">{r.name}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{r.open}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination {...page} onPage={setPageNo} />
        </div>
      </Section>

      <Section title="States" note="Every data view has these, in the place the content would be, written for that view.">
        <div className="grid gap-4 lg:grid-cols-2">
          <StatePanel icon={FolderKanbanIcon} title="No requests yet">
            Requests show up here as people send them.
            <Button variant="outline" className="mt-4">
              Add the first request
            </Button>
          </StatePanel>
          <StatePanel icon={SearchXIcon} title="No requests match these filters">
            Try another status or search, or clear the filters.
            <Button variant="outline" className="mt-4">
              Clear filters
            </Button>
          </StatePanel>
          <StatePanel icon={RotateCwIcon} title="Couldn't load requests">
            The server didn't answer. Your filters are kept.
            <Button variant="outline" className="mt-4">
              <RotateCwIcon /> Try again
            </Button>
          </StatePanel>
          <TableSkeleton rows={3} label="Loading requests" />
        </div>
      </Section>

      <Section title="Detail list" note="A detail view's facts after its status: label and value, empty ones left out, sources linked.">
        <div className="max-w-md">
          <DetailList
            items={[
              { label: "Requested by", value: "Ana Silva" },
              { label: "Team", value: "Payments" },
              { label: "Due", value: "4 Dec" },
              { label: "Notes", value: "" },
              {
                label: "Source",
                value: (
                  <a href="https://tracker.example.com/PAY-412" className="text-link underline-offset-4 hover:underline">
                    PAY-412
                  </a>
                ),
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Form layout" note="Field, FormSection and FormActions: one column, labels always visible, hints and errors wired to their field.">
        <form className="flex max-w-xl flex-col gap-8" onSubmit={(e) => e.preventDefault()}>
          <FormSection title="Request" description="What you need and by when.">
            <Field label="Title">
              <Input defaultValue="Quarterly access review" />
            </Field>
            <Field label="Due date" error="Enter a real date, like 4 Dec.">
              <Input defaultValue="31 Feb" />
            </Field>
            <Field label="Team">
              {(p) => (
                <Select defaultValue="identity">
                  <SelectTrigger {...p} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="identity">Identity</SelectItem>
                    <SelectItem value="payments">Payments</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Details" hint="Links to sources help most." optional>
              <Textarea />
            </Field>
          </FormSection>
          <FormActions>
            <Button type="submit">Send request</Button>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </FormActions>
        </form>
      </Section>

      <Section
        title="Board"
        note="Items in lanes by stage, side by side, when the question is what is in each stage. Each lane shows its count, a long lane shows 8 and Show all, an empty lane says so. Keep the lanes an app already has."
      >
        <Board lanes={BOARD} />
      </Section>

      <Section
        title="Page split and activity"
        note="PageSplit puts secondary things in a side rail on wide screens; ActivityList is what changed, newest first, on a quiet rail (no box per entry)."
      >
        <PageSplit
          aside={
            <PageSection title="What changed" count={ACTIVITY.length}>
              <ActivityList
                entries={ACTIVITY}
                limit={4}
                more={
                  <a href="#" className="text-sm font-medium text-link underline-offset-4 hover:underline">
                    All {ACTIVITY.length} changes
                  </a>
                }
              />
            </PageSection>
          }
        >
          <PageSection title="Needs attention" count={3} description="Most severe first.">
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableBody>
                  {[
                    ["Billing export", "late", "Due date passed 3 days ago with no update."],
                    ["Search v2", "at-risk", "Waiting on a decision about the index."],
                    ["Status page", "at-risk", "Owner is out until Monday."],
                  ].map(([name, s, why]) => (
                    <TableRow key={name}>
                      <TableCell className="py-3 pl-4 whitespace-normal">
                        <div className="font-medium">{name}</div>
                        <div className="text-sm text-muted-foreground">{why}</div>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <StatusBadge status={s as "late" | "at-risk"} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </PageSection>
        </PageSplit>
      </Section>

      <Section title="Charts" note="BarList to compare a few things, TrendChart for one measure over time, ScheduleChart for dated items against today. The caption states the takeaway.">
        <ScheduleChart
          title="Launch dates this quarter"
          takeaway="Most launches land in the next three weeks; four moved later than first planned."
          rows={SCHEDULE}
          legend={[
            { label: "Planned", color: "text-chart-1" },
            { label: "Moved later", color: "text-warn-solid" },
            { label: "Late", color: "text-danger-solid" },
          ]}
        />
        <div className="mt-6 grid gap-8 lg:grid-cols-2">
          <BarList
            title="Open requests by team"
            takeaway="Payments holds half of what's open."
            data={[
              { label: "Payments", value: 21 },
              { label: "Identity", value: 9 },
              { label: "Platform", value: 7 },
              { label: "Mobile", value: 5 },
            ]}
          />
          <TrendChart
            title="Requests opened per week"
            takeaway="Up three weeks running; one week has no data."
            points={[
              { label: "6 Oct", value: 12 },
              { label: "13 Oct", value: 9 },
              { label: "20 Oct", value: 14 },
              { label: "27 Oct", value: null },
              { label: "3 Nov", value: 16 },
              { label: "10 Nov", value: 19 },
              { label: "17 Nov", value: 23 },
            ]}
          />
        </div>
      </Section>
    </>
  )
}
