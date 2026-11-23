// #/design: every part of the board's design system (ui/), in the light and the dark theme side by side, for review.
// A new part lands here when it lands in ui/. Fixture text only; nothing here reads or writes the instance.
import { useState } from "react";
import { Banner, Button, Card, Checks, Dialog, EmptyState, Facts, Field, FieldRow, Input, LinkButton, ListRow, ListRows, Menu, Meter, Monogram, Page, PageHeader, Section, Segmented, Select, StatBlock, StatusDot, Switch, Tabs, Tag, Tags, TaskState, Tile, TileGrid, hueClass, type StatusTone } from "./ui";
import type { ShownState } from "./types";
import "./design.css";

const day = (i: number) => "MTWTFSS"[i]!;
const BARS = [3, 5, 0, 2, 6, 4, 1].map((v, i) => ({ label: day(i), value: v, title: `${day(i)}: ${v} done` }));
const TONES: [StatusTone, string, string][] = [
  ["working", "Working", "under way"],
  ["ok", "Connected", "healthy, on"],
  ["needs", "Needs you", "waiting on you"],
  ["failed", "Failed", "broken, rejected"],
  ["idle", "Stopped", "off, unknown"],
  ["done", "Done", "finished"],
  ["info", "Built in", "informational"],
  ["busy", "Changing", "changing now"],
  ["hue", "Aiden", "the item's colour"],
];
const SURFACES = ["bg", "col", "surface", "surface-2", "border", "border-strong", "text", "muted", "faint", "accent", "accent-soft"];
const STATUS = ["working", "warn", "urgent", "danger", "ok-text", "warn-text", "bad-text"];
const SCALE: [string, string][] = [["3xl", "Stat value"], ["2xl", "Page title"], ["xl", "Dialog title"], ["lg", "Section title"], ["row", "List row"], ["body", "Body"], ["md", "Control"], ["base", "Secondary"], ["sm", "Help, facts"], ["xs", "Tag"], ["2xs", "Axis label"]];

const at = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const st = (o: Partial<ShownState> & Pick<ShownState, "kind" | "reason" | "lane">): ShownState => ({ task: "t", identifier: null, idle_wakes: 0, since: at(10), holder: null, attention: [], ...o });
const TASK_STATES: ShownState[] = [
  st({ kind: "waiting", reason: "owner_wait", lane: "needs_you", question: "keep v1?", attention: [{ who: "owner", why: "owner_wait", ref: "wait:t", since: at(10) }] }),
  st({ kind: "working", reason: "job_running", lane: "needs_you", stage: "CI running", attention: [{ who: "owner", why: "card", ref: "record:k", since: at(10) }] }),
  st({ kind: "idle", reason: "failed", lane: "blocked", refLabel: "timed out", attention: [{ who: "agent", why: "failed", ref: "job:j", since: at(10) }] }),
  st({ kind: "idle", reason: "unknown", lane: "blocked", attention: [{ who: "agent", why: "unknown", ref: "task:t", since: at(10) }] }),
  st({ kind: "waiting", reason: "card_review", lane: "waiting", refLabel: "merge the sbom fix" }),
  st({ kind: "waiting", reason: "blocked", lane: "blocked", refLabel: "WOR-5121" }),
  st({ kind: "idle", reason: "orphaned", lane: "idle" }),
  st({ kind: "waiting", reason: "chat_turn", lane: "idle" }),
  st({ kind: "done", reason: "closed", lane: "done", grade: "pass" }),
];
const TASK_TITLES = ["Decide the brief's weekly scope", "Fix the sbom job", "Ingest the Slack channel list", "Lint the Primer docs", "Refile the weekly tasks", "Close the parent task", "Idle with nothing scheduled", "A chat waiting for your next message", "Hold the closed PR"];

export function DesignView() {
  return (
    <Page className="dsg" label="Design system">
      <PageHeader
        title="Design system"
        sub="Every part of the board, in both themes. A new page starts from a PageHeader and Sections, and takes everything else from here: docs/design/board-ui.md."
      />
      <div className="dsg-themes">
        {(["light", "dark"] as const).map((t) => (
          <div key={t} data-theme={t} className="dsg-theme">
            <div className="dsg-theme-name">{t === "light" ? "Light" : "Dark"}</div>
            <Catalogue />
          </div>
        ))}
      </div>
    </Page>
  );
}

function Catalogue() {
  const [seg, setSeg] = useState<"all" | "done" | "stopped">("all");
  const [on, setOn] = useState(true);
  const [picked, setPicked] = useState<string[]>(["telegram"]);
  const [zone, setZone] = useState<"utc" | "dubai">("dubai");
  const [url, setUrl] = useState("grafana.example");
  const [dialog, setDialog] = useState(false);
  return (
    <div className="dsg-cat">
      <Section title="Colour">
        <div className="dsg-swatches">
          {SURFACES.map((c) => <Swatch key={c} name={c} />)}
        </div>
        <div className="dsg-swatches">
          {STATUS.map((c) => <Swatch key={c} name={c} />)}
        </div>
        <div className="dsg-swatches">
          {Array.from({ length: 8 }, (_, i) => <Swatch key={i} name={`hue-${i}`} />)}
        </div>
      </Section>

      <Section title="Type" hint="One family; fluid from the body size up.">
        <div className="dsg-scale">
          {SCALE.map(([k, use]) => (
            <div key={k} className="dsg-scale-row">
              <span style={{ fontSize: `var(--text-${k})` }}>{use}</span>
              <code>--text-{k}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Page header">
        <Card className={hueClass("roadmap-keeper")}>
          <PageHeader
            crumb={<><a href="#/apps">Apps</a> / roadmap-keeper</>}
            face={<Monogram name="roadmap-keeper" size={44} />}
            square
            title="roadmap-keeper"
            status={<><StatusDot tone="ok">Running</StatusDot><span>deployed 2h ago</span></>}
            sub="The team's roadmap, kept by the Roadmap Keeper."
            actions={<><Button>Copy link</Button><LinkButton variant="primary" href="#/design">Open</LinkButton></>}
          />
        </Card>
      </Section>

      <Section title="Tabs and segmented">
        <Tabs label="Example" tabs={[["overview", "Overview"], ["deploys", "Deploys"], ["access", "Access"]] as const} value="overview" href={() => "#/design"} />
        <Segmented label="Show" value={seg} onChange={setSeg} options={[["all", "All"], ["done", "Done"], ["stopped", "Stopped"]] as const} />
      </Section>

      <Section title="Status" hint="One vocabulary: a dot and a word.">
        <div className={`dsg-grid ${hueClass("Aiden")}`}>
          {TONES.map(([t, word, means]) => (
            <div key={t} className="dsg-pair">
              <StatusDot tone={t}>{word}</StatusDot>
              <span className="dsg-note">{t}: {means}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Tags" hint="Facts, not states.">
        <Tags>
          <Tag>3 agents</Tag>
          <Tag tone="accent">2 of 9 tools</Tag>
          <Tag tone="ok">read</Tag>
          <Tag tone="needs">newer available</Tag>
          <Tag tone="failed">write</Tag>
        </Tags>
      </Section>

      <Section title="Buttons" hint="One primary per view.">
        <div className="dsg-row">
          <Button variant="primary">Save URL</Button>
          <Button>Check again</Button>
          <Button variant="quiet">Cancel</Button>
          <Button variant="danger">Remove</Button>
          <Button size="sm">Copy link</Button>
          <Button disabled>Filing…</Button>
          <Menu label="More" items={[{ label: "Pause", onSelect: () => {} }, { label: "Remove", danger: true, onSelect: () => {} }]} />
        </div>
      </Section>

      <Section title="Fields">
        <Card>
          <Field label="Grafana URL" help="Your Grafana, e.g. https://grafana.example.com." error={url.startsWith("https://") ? null : "Start it with https://."}>
            {(id, note) => (
              <div className="ui-input-row">
                <Input id={id} aria-describedby={note} aria-invalid={!url.startsWith("https://")} value={url} onChange={(e) => setUrl(e.target.value)} />
                <Button variant="primary">Review change</Button>
              </div>
            )}
          </Field>
          <Field label="Timezone" help="Where schedules and briefs run.">
            {(id, note) => <Select id={id} aria-describedby={note} value={zone} onChange={setZone} options={[["utc", "UTC"], ["dubai", "Asia/Dubai"]] as const} />}
          </Field>
        </Card>
        <div className="ui-rows">
          <FieldRow title="Outbound sends" help="Agents may send messages and emails outside the board.">
            <Switch on={on} onChange={setOn} label="Outbound sends" danger />
          </FieldRow>
          <FieldRow title="Channels" help="Where agents reach you.">
            <Checks label="Channels" options={["telegram", "slack", "voice"] as const} value={picked as ("telegram" | "slack" | "voice")[]} onChange={setPicked} />
          </FieldRow>
          <FieldRow title="Owner name" help="As agents address you.">
            <span>Alex Example</span>
          </FieldRow>
        </div>
      </Section>

      <Section title="Banners">
        <Banner action={<Button size="sm">Review</Button>}>A newer version of jira is available.</Banner>
        <Banner tone="warn">Glean is set up, but not signed in yet.</Banner>
        <Banner tone="danger" action={<Button size="sm">Open the module</Button>}><b>AHQ-2026-007 (high)</b>: issue comments were read without fencing.</Banner>
      </Section>

      <Section title="Task state" hint="The kernel's one state for a task: a dot and a word, what it is doing or waiting for, ⚠ when an agent must act.">
        <ListRows>
          {TASK_STATES.map((st, n) => (
            <ListRow key={n} href="#/design" status={<TaskState state={st} />} title={TASK_TITLES[n]!} id={`WOR-${5120 + n}`} from={n % 2 ? "Fleet Ops" : "You"} time={["2h", "12m", "8m", "1h", "4m", "40m", "25m", "7h", "3m"][n]!} />
          ))}
        </ListRows>
      </Section>

      <Section title="Tiles">
        <TileGrid>
          <Tile href="#/design" name="roadmap-keeper" title="roadmap-keeper" status={<StatusDot tone="ok">Running</StatusDot>} facts={<><span>3e9a1c2</span><span>2h ago</span></>} foot="Everyone signed in" action={<Button size="sm">Open</Button>}>
            The team's roadmap, kept by the Roadmap Keeper.
          </Tile>
          <Tile href="#/design" name="vendor-invoices" title="vendor-invoices" tone="failed" status={<StatusDot tone="failed">Unhealthy</StatusDot>} facts={<><span>5bd2e88</span><span>50m ago</span></>} foot="Health check failing">
            Invoices reconciled against the budget sheet.
          </Tile>
        </TileGrid>
      </Section>

      <Section title="Numbers">
        <Card className={hueClass("Aiden")}>
          <StatBlock label="Tasks done" value={21} sub="9 the week before" bars={BARS} />
          <Facts items={[["Memory", <><span>182 MB of 512 MB</span><Meter value={182 / 512} label="Memory" /></>], ["CPU", "3%"], ["Version", <code key="v">3e9a1c2</code>]]} />
        </Card>
      </Section>

      <Section title="Empty and dialog">
        <EmptyState action={<Button variant="primary" onClick={() => setDialog(true)}>Open a dialog</Button>}>No apps yet. Ask the Architect for one in Chat; it shows here once deployed.</EmptyState>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Turn off outbound sends?" actions={<><Button variant="quiet" onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => setDialog(false)}>File change</Button></>}>
          <p>Agents stop sending messages and emails outside the board. You approve the change on its card.</p>
        </Dialog>
      </Section>
    </div>
  );
}

const Swatch = ({ name }: { name: string }) => (
  <span className="dsg-swatch">
    <i style={{ background: `var(--${name})` }} />
    <code>{name}</code>
  </span>
);
