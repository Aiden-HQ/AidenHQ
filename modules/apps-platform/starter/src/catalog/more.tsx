// The catalog's newer sections: presets and shells side by side (in frames), each component's variants, and the extra
// blocks and components. Everything here is optional; apps import what they need.
import * as React from "react"
import { CopyIcon, FileTextIcon, FolderKanbanIcon, GitPullRequestIcon, HomeIcon, MailIcon, RocketIcon, SearchIcon, SettingsIcon, TrashIcon } from "lucide-react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Combobox } from "@/components/blocks/combobox"
import { CommandPalette } from "@/components/blocks/command-palette"
import { DatePicker, DateRangePicker, type DateRange } from "@/components/blocks/date-picker"
import { KpiCard } from "@/components/blocks/kpi"
import { SettingsGroup, SettingsRow } from "@/components/blocks/settings"
import { StatStrip } from "@/components/blocks/stat-strip"
import { Stepper } from "@/components/blocks/stepper"
import { ColumnToggle, SelectionBar } from "@/components/blocks/table-toolbar"
import { Timeline } from "@/components/blocks/timeline"
import { Tracker } from "@/components/blocks/tracker"

export const PRESETS = [
  ["crisp", "Cool neutral, muted indigo, tight corners, compact (Linear-like)"],
  ["polished", "Blurple with a gradient, navy sidebar, white on blue-grey (Stripe-like)"],
  ["editorial", "Warm paper, terracotta, serif headings"],
  ["dense", "High contrast, strong blue, small type, tight rows"],
  ["ops", "Calm slate and teal"],
  ["indigo", "Bold indigo, deep sidebar, rounder"],
  ["soft", "Gentle violet, roomier, friendly"],
  ["slate", "Slate and indigo (after tweakcn Clean Slate)"],
  ["minimal", "White, near-black, clear blue (after tweakcn Modern Minimal)"],
  ["graphite", "Monochrome greys (after tweakcn Graphite)"],
] as const

export function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
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

function Frame({ src, title, note, height = 420 }: { src: string; title: string; note?: string; height?: number }) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-sm">
        <span className="font-medium">{title}</span>
        {note && <span className="text-muted-foreground"> · {note}</span>}
      </figcaption>
      <iframe src={src} title={title} loading="lazy" className="w-full rounded-lg border bg-background" style={{ height }} />
    </figure>
  )
}

/** Every preset at once, each in a frame, in the page's mode. */
export function PresetGallery({ mode }: { mode: "light" | "dark" }) {
  return (
    <Section title="Theme presets" note="Pick one per app or adapt it: import presets/<name>.css and set <html data-palette>. Starting points, not rules.">
      <div className="grid gap-5 lg:grid-cols-2">
        {PRESETS.map(([id, note]) => (
          <Frame key={id} src={`/catalog.html?specimen=preset&palette=${id}&mode=${mode}`} title={id} note={note} height={400} />
        ))}
      </div>
    </Section>
  )
}

export function ShellGallery({ mode, palette }: { mode: "light" | "dark"; palette: string }) {
  const q = `&mode=${mode}&palette=${palette}`
  return (
    <Section title="Shells" note="Pick the shell that fits the app's navigation, or none: TopBarShell (a few destinations), SidebarShell (many), BareShell (no chrome).">
      <div className="grid gap-5">
        <Frame src={`/catalog.html?specimen=topbar${q}`} title="TopBarShell" note="plain" />
        <Frame src={`/catalog.html?specimen=topbar-brand${q}`} title="TopBarShell" note="brand" />
        <Frame src={`/catalog.html?specimen=sidebar${q}`} title="SidebarShell" note="sidebar" />
        <Frame src={`/catalog.html?specimen=sidebar-inset${q}`} title="SidebarShell" note="inset" />
        <Frame src={`/catalog.html?specimen=bare${q}`} title="BareShell" note="full" />
        <Frame src={`/catalog.html?specimen=bare-centered${q}`} title="BareShell" note="centered" />
      </div>
    </Section>
  )
}

const ROWS = [
  ["Billing export", "Payments", 12, "4 Dec"],
  ["Search v2", "Platform", 4, "11 Dec"],
  ["Offline mode", "Mobile", 9, "28 Nov"],
  ["Audit log", "Identity", 0, "2 Dec"],
] as const

function SampleTable({ variant }: { variant: "default" | "compact" | "striped" }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table variant={variant}>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Project</TableHead>
            <TableHead>Team</TableHead>
            <TableHead className="text-right">Open</TableHead>
            <TableHead className="pr-4 text-right">Due</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map(([n, t, o, d]) => (
            <TableRow key={n}>
              <TableCell className="pl-4 font-medium">{n}</TableCell>
              <TableCell className="text-muted-foreground">{t}</TableCell>
              <TableCell className="text-right tabular-nums">{o}</TableCell>
              <TableCell className="pr-4 text-right tabular-nums">{d}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Each component's flavours, all props: pick what fits the app. */
export function Variants() {
  return (
    <>
      <Section title="Button variants" note="variant: default (solid), soft, outline, secondary, ghost, link, destructive.">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Solid</Button>
          <Button variant="soft">Soft</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button className="bg-primary-gradient">Gradient</Button>
        </div>
      </Section>
      <Section title="Badge variants" note="variant: default (solid), soft, outline, secondary, dot (colour it with [--dot:var(--warn-solid)]).">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Solid</Badge>
          <Badge variant="soft">Soft</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="dot">Live</Badge>
          <Badge variant="dot" className="[--dot:var(--warn-solid)]">
            Degraded
          </Badge>
          <Badge variant="dot" className="[--dot:var(--danger-solid)]">
            Down
          </Badge>
        </div>
      </Section>
      <Section title="Card variants" note="variant: default, flat, bordered, elevated.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(["default", "flat", "bordered", "elevated"] as const).map((v) => (
            <Card key={v} variant={v}>
              <CardHeader>
                <CardTitle className="capitalize">{v}</CardTitle>
                <CardDescription>Weekly digest, Mondays 08:30.</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">What changed and what is due.</CardContent>
            </Card>
          ))}
        </div>
      </Section>
      <Section title="Table variants" note="variant: default, compact, striped.">
        <div className="grid gap-4 lg:grid-cols-3">
          <SampleTable variant="default" />
          <SampleTable variant="compact" />
          <SampleTable variant="striped" />
        </div>
      </Section>
      <Section title="Tabs variants" note="TabsList variant: default (segmented), line (underline), boxed.">
        <div className="flex flex-wrap gap-8">
          {(["default", "line", "boxed"] as const).map((v) => (
            <Tabs key={v} defaultValue="overview">
              <TabsList variant={v}>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="pt-1 text-sm text-muted-foreground">
                {v}
              </TabsContent>
            </Tabs>
          ))}
        </div>
      </Section>
      <Section title="Sheet sides and sizes" note="side: right, left, bottom, top; size (left and right): sm, md, lg, xl.">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["right", "sm"],
              ["right", "lg"],
              ["right", "xl"],
              ["left", "md"],
              ["bottom", "sm"],
            ] as const
          ).map(([side, size]) => (
            <Sheet key={side + size}>
              <SheetTrigger asChild>
                <Button variant="outline">
                  {side} {side === "bottom" ? "" : size}
                </Button>
              </SheetTrigger>
              <SheetContent side={side} size={size}>
                <SheetHeader>
                  <SheetTitle>Billing export</SheetTitle>
                  <SheetDescription>Payments · Ana Silva</SheetDescription>
                </SheetHeader>
                <p className="px-4 pb-4 text-sm">
                  A {side} sheet{side === "bottom" ? "" : `, size ${size}`}.
                </p>
              </SheetContent>
            </Sheet>
          ))}
        </div>
      </Section>
      <Section title="Stat strip variants" note="variant: divided (default), plain, tinted; any figure can carry a trend line.">
        {(["divided", "plain", "tinted"] as const).map((v) => (
          <StatStrip
            key={v}
            variant={v}
            label={v}
            stats={[
              { label: "Open", value: 42, note: `${v}`, trend: [12, 14, 13, 17, 19, 18, 22] },
              { label: "Waiting on us", value: 9, note: "Oldest is 3 days", dot: "bg-warn-solid", tone: "warn" },
              { label: "Closed", value: 118, note: "Last 30 days", trend: [30, 28, 31, 26, 33, 35, 34] },
              { label: "Overdue", value: 3, dot: "bg-danger-solid", note: "Past the agreed date" },
            ]}
          />
        ))}
      </Section>
    </>
  )
}

const TEAM = ["Ana Silva", "Dev Patel", "Kenji Sato", "Lea Martin", "Omar Haddad", "Priya Nair", "Sam Okafor", "Tomás Reyes"].map((n) => ({ value: n.toLowerCase().replace(" ", "-"), label: n }))
const RUNS = Array.from({ length: 45 }, (_, i) => {
  const tone = i === 17 || i === 31 ? "danger" : i % 11 === 4 ? "warn" : i === 44 ? "none" : "ok"
  return { key: `r${i}`, tone: tone as "ok" | "warn" | "danger" | "none", tooltip: `Day ${i + 1}: ${tone === "ok" ? "all checks passed" : tone === "warn" ? "slow" : tone === "danger" ? "failed" : "no data"}` }
})

/** Blocks for internal tools beyond the basics: pickers, palettes, timelines, steps, settings, KPIs, trackers. */
export function MoreBlocks() {
  const [owner, setOwner] = React.useState<string | null>("dev-patel")
  const [reviewers, setReviewers] = React.useState<string[]>(["ana-silva", "kenji-sato"])
  const [due, setDue] = React.useState<Date | undefined>(new Date(2026, 11, 4))
  const [range, setRange] = React.useState<DateRange | undefined>()
  const [cols, setCols] = React.useState(["team", "due"])
  const [selected, setSelected] = React.useState(2)
  const [step, setStep] = React.useState(1)
  const [palette, setPalette] = React.useState(false)
  return (
    <>
      <Section title="KPI cards" note="KpiCard: one figure, its change against a stated period, an optional trend; card variant as Card.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Weekly active" value="1,284" delta={{ value: "+8.2%" }} period="vs last week" trend={[9, 10, 9, 11, 12, 12, 13]} />
          <KpiCard label="Median response" value="3.1h" delta={{ value: "-12%", goodWhen: "down" }} period="vs last week" card="flat" />
          <KpiCard label="Failed runs" value="7" delta={{ value: "+3", goodWhen: "down" }} period="vs yesterday" trend={[2, 3, 2, 4, 5, 7]} card="elevated" />
          <KpiCard label="Spend" value="$412" delta={{ value: "-4%" }} period="month to date" card="default" />
        </div>
      </Section>
      <Section title="Tracker" note="Tracker: one bar per period coloured by status, with tooltips, for uptime, runs or checks.">
        <Tracker title="Nightly sync, last 45 days" takeaway="2 failures, both retried the next night." data={RUNS} />
      </Section>
      <Section title="Pickers" note="Combobox (type to filter; one or several), DatePicker and DateRangePicker (with presets). Keep the values in the URL.">
        <div className="grid max-w-3xl gap-5 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Owner</Label>
            <Combobox aria-label="Owner" options={TEAM} value={owner} onChange={setOwner} placeholder="Choose an owner" search="Search people…" />
          </div>
          <div className="grid gap-2">
            <Label>Reviewers</Label>
            <Combobox aria-label="Reviewers" multiple options={TEAM} value={reviewers} onChange={setReviewers} placeholder="Add reviewers" search="Search people…" />
          </div>
          <div className="grid gap-2">
            <Label>Due date</Label>
            <DatePicker aria-label="Due date" value={due} onChange={setDue} className="w-full" />
          </div>
          <div className="grid gap-2">
            <Label>Period</Label>
            <DateRangePicker aria-label="Period" value={range} onChange={setRange} className="w-full" />
          </div>
        </div>
      </Section>
      <Section title="Table toolbar" note="ColumnToggle (show or hide columns) and SelectionBar (bulk actions while rows are selected).">
        <div className="flex flex-wrap items-center gap-2">
          <ColumnToggle
            columns={[
              { id: "name", label: "Project", fixed: true },
              { id: "team", label: "Team" },
              { id: "owner", label: "Owner" },
              { id: "due", label: "Due" },
            ]}
            visible={cols}
            onChange={setCols}
          />
          <span className="text-sm text-muted-foreground">Showing: {["name", ...cols].join(", ")}</span>
        </div>
        <SelectionBar
          count={selected}
          noun="project"
          onClear={() => setSelected(0)}
          actions={
            <>
              <Button variant="outline" size="sm">
                Change owner
              </Button>
              <Button variant="outline" size="sm">
                <TrashIcon /> Archive
              </Button>
            </>
          }
        />
        {!selected && (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setSelected(2)}>
            Select 2 rows
          </Button>
        )}
      </Section>
      <Section title="Command palette" note="CommandPalette: ⌘K or Ctrl+K from anywhere, pages and actions by typing. For apps with many destinations.">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setPalette(true)}>
            <SearchIcon /> Search… <Kbd className="ml-2">⌘K</Kbd>
          </Button>
        </div>
        <CommandPalette
          open={palette}
          onOpenChange={setPalette}
          groups={[
            {
              heading: "Go to",
              items: [
                { id: "home", label: "Home", icon: HomeIcon, run: () => {} },
                { id: "projects", label: "Projects", icon: FolderKanbanIcon, run: () => {} },
                { id: "settings", label: "Settings", icon: SettingsIcon, shortcut: "⌘,", run: () => {} },
              ],
            },
            { heading: "Actions", items: [{ id: "new", label: "New project", icon: RocketIcon, shortcut: "N", run: () => {} }, { id: "copy", label: "Copy link", icon: CopyIcon, run: () => {} }] },
          ]}
        />
      </Section>
      <Section title="Timeline" note="Timeline: dated events on one line, variant dots or icons, for a detail view where the sequence matters.">
        <div className="grid gap-8 lg:grid-cols-2">
          <Timeline
            events={[
              { id: "1", title: "Moved out by 3 days", when: "2h ago", text: "Waiting on the bank's test environment.", dot: "bg-danger-solid" },
              { id: "2", title: "Marked at risk", when: "Yesterday", dot: "bg-warn-solid" },
              { id: "3", title: "Owner changed to Dev Patel", when: "3 Nov" },
              { id: "4", title: "Created", when: "28 Oct" },
            ]}
          />
          <Timeline
            variant="icons"
            events={[
              { id: "1", title: "Deployed to production", when: "10:42", icon: RocketIcon },
              { id: "2", title: "Pull request merged", when: "10:31", icon: GitPullRequestIcon, text: "Two approvals; checks green." },
              { id: "3", title: "Spec approved", when: "Mon", icon: FileTextIcon },
              { id: "4", title: "Requested by email", when: "Fri", icon: MailIcon },
            ]}
          />
        </div>
      </Section>
      <Section title="Stepper" note="Stepper: where a multi-step form is, variant numbered or bar. Keep the step in the URL.">
        <Stepper steps={["Details", "Owners", "Schedule", "Review"]} current={step} onStep={setStep} />
        <Stepper steps={["Details", "Owners", "Schedule", "Review"]} current={step} variant="bar" className="max-w-sm" />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          <Button size="sm" disabled={step === 3} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        </div>
      </Section>
      <Section title="Settings" note="SettingsGroup and SettingsRow: label and explanation on the left, the control on the right.">
        <SettingsGroup title="Notifications" description="How the app tells you about changes." className="max-w-2xl">
          <SettingsRow label="Weekly digest" description="Projects that changed status, every Monday." htmlFor="s-digest">
            <Switch id="s-digest" defaultChecked />
          </SettingsRow>
          <SettingsRow label="Due-date reminders" description="A day before anything you own is due." htmlFor="s-due">
            <Switch id="s-due" />
          </SettingsRow>
          <SettingsRow label="Danger zone" description="Archive every finished project at once.">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Archive finished…
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Archive 14 finished projects?</AlertDialogTitle>
                  <AlertDialogDescription>They leave every list. You can restore them from Archived.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction>Archive 14 projects</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SettingsRow>
        </SettingsGroup>
      </Section>
    </>
  )
}

/** shadcn/ui components added from its registry (MIT): see THIRD_PARTY.md. */
export function MoreComponents() {
  const [volume, setVolume] = React.useState([60])
  return (
    <>
      <Section title="Empty" note="shadcn's Empty: an icon, a title, one line and the next action, in the place the content would be.">
        <Empty className="max-w-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanbanIcon />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>Projects show up here with their status, owner and due date.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm">Add a project</Button>
          </EmptyContent>
        </Empty>
      </Section>
      <Section title="Inputs and groups" note="InputGroup (addons inside the field), ButtonGroup, RadioGroup, Slider, Progress, Spinner, Kbd.">
        <div className="grid max-w-xl gap-5">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search projects" />
            <InputGroupAddon align="inline-end">
              <Kbd>/</Kbd>
            </InputGroupAddon>
          </InputGroup>
          <ButtonGroup>
            <Button variant="outline">Day</Button>
            <Button variant="outline">Week</Button>
            <Button variant="outline">Month</Button>
          </ButtonGroup>
          <RadioGroup defaultValue="weekly" className="flex gap-4">
            {["daily", "weekly", "never"].map((v) => (
              <div key={v} className="flex items-center gap-2">
                <RadioGroupItem value={v} id={`r-${v}`} />
                <Label htmlFor={`r-${v}`} className="capitalize">
                  {v}
                </Label>
              </div>
            ))}
          </RadioGroup>
          <div className="grid gap-2">
            <Label>Threshold: {volume[0]}%</Label>
            <Slider value={volume} onValueChange={setVolume} max={100} step={5} aria-label="Threshold" />
          </div>
          <Progress value={64} aria-label="Import progress" />
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Spinner /> Syncing 3 sources…
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="c-all" />
            <Label htmlFor="c-all">Select all</Label>
          </div>
        </div>
      </Section>
      <Section title="Disclosure" note="Accordion (several sections, one open), Collapsible (one thing), Popover, HoverCard, ScrollArea.">
        <Accordion type="single" collapsible className="max-w-xl">
          <AccordionItem value="a">
            <AccordionTrigger>Who can see this app?</AccordionTrigger>
            <AccordionContent>Everyone in the workspace, unless an admin narrows it.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>Where does the data come from?</AccordionTrigger>
            <AccordionContent>The shared warehouse, refreshed every 15 minutes.</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Collapsible className="max-w-xl">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              Show 3 older changes
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 text-sm text-muted-foreground">Owner changed · Due date moved · Created</CollapsibleContent>
        </Collapsible>
        <div className="flex flex-wrap gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent className="text-sm">A short form or a few options, next to what it changes.</PopoverContent>
          </Popover>
          <HoverCard>
            <HoverCardTrigger asChild>
              <Button variant="link">Ana Silva</Button>
            </HoverCardTrigger>
            <HoverCardContent className="text-sm">Payments lead · 12 open projects</HoverCardContent>
          </HoverCard>
        </div>
        <ScrollArea className="h-32 max-w-xs rounded-lg border">
          <div className="p-3 text-sm">
            {Array.from({ length: 20 }, (_, i) => (
              <p key={i} className="py-1">
                Run #{1200 - i}
              </p>
            ))}
          </div>
        </ScrollArea>
      </Section>
      <Section title="Calendar" note="shadcn's Calendar (react-day-picker); DatePicker and DateRangePicker wrap it in a popover.">
        <Calendar mode="single" className="w-fit rounded-lg border" />
      </Section>
    </>
  )
}
