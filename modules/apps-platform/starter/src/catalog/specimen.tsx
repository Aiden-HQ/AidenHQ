// Small specimens the catalog shows in frames (`catalog.html?specimen=…`): one preset's look at a glance, and each shell
// variant at full size, so the Designer compares them side by side without leaving the catalog.
import { BellIcon, FolderKanbanIcon, HomeIcon, InboxIcon, LayoutDashboardIcon, PlusIcon, SettingsIcon, UsersIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/status-badge"
import { BareShell } from "@/components/blocks/bare-shell"
import { Page, PageHeader } from "@/components/blocks/page"
import { SidebarShell } from "@/components/blocks/sidebar-shell"
import { StatStrip } from "@/components/blocks/stat-strip"
import { TopBarShell } from "@/components/blocks/top-bar-shell"
import { Field } from "@/components/blocks/form"

const ROWS = [
  ["Billing export", "on-track", "Payments", "4 Dec"],
  ["Search v2", "at-risk", "Platform", "11 Dec"],
  ["Offline mode", "late", "Mobile", "28 Nov"],
] as const

function Sample({ name }: { name?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={name ? name[0].toUpperCase() + name.slice(1) : "Projects"}
        description="Status, owners and due dates across teams."
        actions={
          <>
            <Button variant="outline" size="sm">
              Share
            </Button>
            <Button size="sm" className="bg-primary-gradient">
              <PlusIcon /> New
            </Button>
          </>
        }
      />
      <StatStrip
        stats={[
          { label: "Open", value: 42, note: "8 this week", trend: [3, 5, 4, 6, 8, 7, 9] },
          { label: "At risk", value: 5, dot: "bg-warn-solid", tone: "warn", note: "Need a decision" },
          { label: "Late", value: 2, dot: "bg-danger-solid", tone: "danger", note: "Past due" },
          { label: "Done", value: 118, note: "Last 30 days" },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search projects" className="h-8 w-48" />
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="mine">Mine</TabsTrigger>
          </TabsList>
        </Tabs>
        <Badge variant="soft">Soft</Badge>
        <Badge variant="dot">Dot</Badge>
        <a href="#" className="text-sm text-link underline-offset-4 hover:underline">
          A link
        </a>
      </div>
      <div className="overflow-hidden rounded-xl border">
        <Table variant="compact">
          <TableHeader className="bg-muted/60">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map(([n, s, t, d]) => (
              <TableRow key={n}>
                <TableCell className="pl-4">
                  <span className="font-medium">{n}</span> <span className="text-muted-foreground">· {t}</span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={s} />
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">{d}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

const LOGO = <FolderKanbanIcon className="size-5 text-primary" aria-hidden />
const NAV = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/inbox", label: "Inbox", icon: InboxIcon },
  { href: "/projects", label: "Projects", icon: LayoutDashboardIcon },
  { href: "/people", label: "People", icon: UsersIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
]
const bell = (
  <Button variant="ghost" size="icon" aria-label="Notifications">
    <BellIcon />
  </Button>
)

export function Specimen({ kind, palette }: { kind: string; palette?: string }) {
  if (kind === "preset")
    return (
      <div className="min-h-svh bg-page p-5">
        <Sample name={palette} />
      </div>
    )
  if (kind === "topbar" || kind === "topbar-brand")
    return (
      <div className="min-h-svh bg-page">
        <TopBarShell appName="Acme Projects" logo={LOGO} nav={NAV.slice(0, 3).map(({ href, label }) => ({ href, label }))} path="/projects" actions={bell} variant={kind === "topbar" ? "plain" : "brand"}>
          <Page>
            <Sample />
          </Page>
        </TopBarShell>
      </div>
    )
  if (kind.startsWith("sidebar"))
    return (
      <SidebarShell appName="Acme Ops" logo={LOGO} nav={NAV} path="/projects" title="Projects" actions={bell} variant={kind === "sidebar" ? "sidebar" : kind === "sidebar-inset" ? "inset" : "floating"}>
        <Page>
          <Sample />
        </Page>
      </SidebarShell>
    )
  if (kind === "bare-centered")
    return (
      <BareShell variant="centered">
        <div className="flex flex-col gap-4 rounded-xl border bg-background p-6">
          <h1 className="text-xl font-semibold tracking-tight">Request access</h1>
          <Field label="Work email">
            <Input type="email" placeholder="you@example.com" />
          </Field>
          <Button>Send request</Button>
        </div>
      </BareShell>
    )
  return (
    <BareShell>
      <Page>
        <Sample />
      </Page>
    </BareShell>
  )
}
