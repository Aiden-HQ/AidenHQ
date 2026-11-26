// #/design, the teammate kit: faces (the ten roster characters, seed faces, a shipped image), the teammate chip, the
// Home parts (decision rows, digest, section cards, the detail pane), Ask Aiden's side panel, the onboarding parts
// (stepper, option cards), disclosure, key caps and the motion classes. Fixture text only.
import { useId, useState } from "react";
import { Button, Card, DecisionRow, DetailPane, DigestList, Disclosure, Face, Kbd, OptionCard, Section, SectionCard, SidePanel, Stepper, Tag, TeammateChip, type FaceKit, type FaceState } from "./ui";
import type { RosterAgent } from "./types";

type Mate = [key: string, name: string, job: string, kit: FaceKit];
const k = (hair: FaceKit["hair"], accessory: FaceKit["accessory"], body: FaceKit["body"], skin: number, hair_color: number, palette: number): FaceKit => ({ hair, accessory, body, skin, hair_color, palette });
/** The ten default teammates and their kit specs (each module declares its own: phase 1, task 11). */
const ROSTER: Mate[] = [
  ["chief-of-staff", "Aiden", "Chief of staff", k("short", "none", "tie", 0, 0, 0)],
  ["open-loops", "Tess", "Follow-up chaser", k("long", "headset", "none", 1, 1, 1)],
  ["meetings", "Nora", "Meeting notes", k("long", "pencil", "notepad", 2, 2, 2)],
  ["reviewer-manager", "Max", "PR reviewer", k("spiky", "glasses", "none", 3, 3, 3)],
  ["ship", "Sam", "Release manager", k("short", "cap", "none", 4, 4, 4)],
  ["maintainer", "Mia", "Repo maintainer", k("bun", "none", "badge", 5, 5, 5)],
  ["app-maintainer", "Iris", "App builder", k("curly", "earrings", "none", 6, 6, 6)],
  ["architect", "Archie", "Agent Architect", k("short", "hard-hat", "none", 7, 7, 7)],
  ["security-watch", "Vik", "Security", k("short", "headband", "shield", 8, 0, 8)],
  ["assistant", "Rhea", "Researcher", k("long", "round-glasses", "none", 9, 8, 9)],
];
const SEEDS = ["engineer", "inbox-agent", "ui-designer", "fleet-steward", "red-teamer", "acme-notes"];
const STATES: FaceState[] = ["idle", "working", "needs"];
const by = (name: string) => ROSTER.find((m) => m[1] === name)!;

function agent([key, name, job, kit]: Mate, state: RosterAgent["state"] = "idle", hidden = false): RosterAgent {
  return {
    id: `id-${key}`, key, name, title: null, system: false, department: { id: "general", name: "General", order: 0 }, model: null, reportsTo: null,
    state, running: state === "working" ? 1 : 0, queued: 0, workingSince: null, schedules: [], lastRunAt: null, lastRunStatus: null,
    ...(hidden ? {} : { teammate: { job, sample: "", staff: [], controls: [], face: { kit } } }),
  };
}
const face = (name: string, size = 36, state: FaceState = "idle") => {
  const [key, n, , kit] = by(name);
  return <Face seed={key} kit={kit} state={state} size={size} label={n} />;
};

export function TeamCatalogue() {
  return (
    <>
      <FacesSection />
      <ChipSection />
      <DecisionSection />
      <DigestSection />
      <PaneSection />
      <SidePanelSection />
      <OnboardingSection />
      <SmallPartsSection />
      <MotionSection />
    </>
  );
}

function FacesSection() {
  return (
    <Section title="Faces" hint="A teammate's face shows its state: working bobs and looks around, needs you raises its brows inside an amber ring, idle rests. The label says it too.">
      <div className="dsg-faces">
        {ROSTER.map(([key, name, job, kit]) => (
          <div key={key} className="dsg-face-card">
            <div className="dsg-face-name"><b>{name}</b> · {job}<code>{kit.hair} · {kit.accessory} · {kit.body}</code></div>
            <div className="dsg-face-states">
              {STATES.map((s) => (
                <div key={s} className="dsg-face-state">
                  <Face seed={key} kit={kit} state={s} size={96} label={name} />
                  <span><Face seed={key} kit={kit} state={s} size={40} label={name} /><Face seed={key} kit={kit} state={s} size={24} label={name} /></span>
                  <small>{s === "needs" ? "needs you" : s}</small>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="dsg-face-card">
        <div className="dsg-face-name"><b>From the seed</b> · an agent whose module picks no face: the kit draws one from its key</div>
        <div className="dsg-row">
          {SEEDS.map((s, i) => (
            <span key={s} className="dsg-seed"><Face seed={s} state={STATES[i % 3]} size={48} label={s} /><code>{s}</code></span>
          ))}
        </div>
      </div>
      <div className="dsg-face-card">
        <div className="dsg-face-name"><b>Shipped image</b> · a module's own face file (GET /api/faces/acme-bot), with the same ring and dot</div>
        <div className="dsg-row">
          {STATES.map((s) => (
            <span key={s} className="dsg-seed"><Face seed="acme-bot" src="/api/faces/acme-bot" state={s} size={56} label="Acme bot" /><Face seed="acme-bot" src="/api/faces/acme-bot" state={s} size={24} label="Acme bot" /></span>
          ))}
          <span className="dsg-seed"><Face seed="acme-bot" src="/api/faces/missing" size={56} label="Acme bot" /><code>image fails: seed face</code></span>
        </div>
      </div>
    </Section>
  );
}

function ChipSection() {
  return (
    <Section title="Teammate chip" hint="Face, name and job. A hidden agent shows its name only.">
      <div className="dsg-row dsg-chips">
        <TeammateChip agent={agent(by("Tess"))} />
        <TeammateChip agent={agent(by("Sam"), "working")} />
        <TeammateChip agent={agent(by("Rhea"))} state="needs" />
        <TeammateChip agent={agent(by("Max"))} job={false} />
        <TeammateChip agent={agent(by("Iris"))} href="#/design" size={32} />
        <TeammateChip agent={agent(["engineer", "Engineer", "", by("Aiden")[3]], "working", true)} />
      </div>
    </Section>
  );
}

const DRAFT = "Hi Jonas, checking in on the signed vendor contract. Is anything holding it up on your side? We're speaking at 16:30 today, so if it's easier we can close it out on the call.\n\nThanks";

function DecisionSection() {
  const [sent, setSent] = useState(false);
  const [week, setWeek] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [active, setActive] = useState(0);
  return (
    <Section title="Decision rows" hint="One thing that needs you, answered in place. Answered, it collapses to a receipt.">
      <SectionCard title="Needs you" count={[sent, week, allowed].filter((x) => !x).length} action={<><span><Kbd>J</Kbd> <Kbd>K</Kbd> move</span><span><Kbd>E</Kbd> done</span><span><Kbd>S</Kbd> snooze</span></>} flush>
        <DecisionRow i={0} active={active === 0} onOpen={() => setActive(0)} face={face("Tess", 36, sent ? "working" : "needs")} who="Tess" role="Follow-up chaser" meta="5 days quiet" overdue
          question="Send a chaser to Jonas Weber about the Northwind contract?" detail={DRAFT}
          actions={<><Button variant="primary" onClick={() => setSent(true)}>Send</Button><Button>Edit</Button><Button variant="quiet">Not now</Button></>}
          receipt={sent ? { text: "Sent as you. Tess watches for a reply.", onUndo: () => setSent(false) } : null} />
        <DecisionRow i={1} active={active === 1} onOpen={() => setActive(1)} face={face("Rhea", 36, week ? "idle" : "needs")} who="Rhea" role="Researcher" meta="40 min"
          question="Weekly metrics digest: compare against last week, or the same week last month?"
          actions={<><Button onClick={() => setWeek("Last week")}>Last week</Button><Button onClick={() => setWeek("Same week last month")}>Same week last month</Button><Button variant="quiet">Something else…</Button></>}
          receipt={week ? { text: `${week}. Rhea remembers this for next week.`, onUndo: () => setWeek(null) } : null} />
        <DecisionRow i={2} active={active === 2} onOpen={() => setActive(2)} face={face("Iris", 36, allowed ? "working" : "needs")} who="Iris" role="App builder" meta="2 h"
          question={<>Let the Hiring pipeline app read your “Recruiting” Gmail label?</>}
          actions={<><Button variant="primary" onClick={() => setAllowed(true)}>Allow</Button><Button>Deny</Button><span>Read only · that one label</span></>}
          receipt={allowed ? { text: "Allowed. Iris is connecting it.", onUndo: () => setAllowed(false) } : null} />
        <DecisionRow i={3} face={face("Max")} who="Max" role="PR reviewer" meta="yesterday" question="Merge PR #812 once CI is green?" receipt={{ text: "Merged at 06:10. Nothing to undo." }} />
      </SectionCard>
    </Section>
  );
}

const DIGEST = [
  { id: "1", face: face("Sam", 24), text: "Invoices export v2 shipped. PR #812 merged at 06:10 after review.", link: { label: "See PR", href: "#/design" } },
  { id: "2", face: face("Tess", 24), text: "6 chasers sent overnight; Priya and Omar replied.", link: { label: "Replies", href: "#/design" } },
  { id: "3", face: face("Nora", 24), text: "Leadership sync notes: 4 actions, 2 of them yours.", link: { label: "Notes", href: "#/design" } },
  { id: "4", face: face("Mia", 24), text: "3 bugs triaged, 1 fix merged." },
];

function DigestSection() {
  return (
    <Section title="Digest and section card" hint="What happened while you were away, top three; a card with a header for each block of Home.">
      <div className="dsg-two">
        <SectionCard title="Since you last looked" meta="Overnight" flush>
          <DigestList items={DIGEST} more={{ label: "All 9", href: "#/design" }} />
        </SectionCard>
        <SectionCard title="Today" meta="3 meetings" action={<a href="#/design">Calendar</a>}>
          <TeammateChip agent={agent(by("Nora"))} />
          <p className="dsg-p">Nora prepped all three: notes from the last sync, open actions, and who owes what.</p>
        </SectionCard>
      </div>
    </Section>
  );
}

function PaneSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Detail pane" hint="Beside its list, non-modal; Escape closes it. Full screen on a phone.">
      <div className="dsg-stage">
        <div className="dsg-stage-main">
          <Button variant="primary" onClick={() => setOpen(!open)}>{open ? "Close details" : "Open details"}</Button>
          <p className="dsg-p">The page stays usable while the pane is open.</p>
        </div>
        <DetailPane open={open} onClose={() => setOpen(false)} title="Details" actions={<><Button variant="primary">Last week</Button><Button>Same week last month</Button></>}>
          <div className="dsg-pane-who">
            {face("Rhea", 40, "needs")}
            <div>
              <small>Rhea · Weekly metrics digest</small>
              <h3>Which week should the digest compare against?</h3>
              <p className="dsg-p">Last week had the holiday dip in US traffic, so week-over-week will look like a 14% jump. Same week last month avoids that.</p>
            </div>
          </div>
        </DetailPane>
      </div>
    </Section>
  );
}

function SidePanelSection() {
  const [open, setOpen] = useState(false);
  const history = <button type="button" className="btn quiet" aria-label="Chat history"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>;
  return (
    <Section title="Side panel" hint="Ask Aiden: a conversation beside the page. Escape closes it; a sheet on a phone.">
      <div className="dsg-stage dsg-stage-tall">
        <div className="dsg-stage-main">
          <Button variant="primary" onClick={() => setOpen(!open)}>{face("Aiden", 20)} Ask Aiden <Kbd>⌘J</Kbd></Button>
        </div>
        <SidePanel open={open} onClose={() => setOpen(false)} title="Ask Aiden" sub="Chief of staff · knows your whole team" face={face("Aiden", 36, "working")} headerActions={history}
          footer={<input className="ui-input" placeholder="Ask Aiden, or @ a teammate" aria-label="Message Aiden" />}>
          <p className="dsg-bubble">Why is the invoices release stuck?</p>
          <div className="dsg-pane-who">
            {face("Aiden", 28)}
            <p className="dsg-p">Sam (Release manager) owns this, so I asked Sam. The deploy check failed once on a flaky test; a retry usually clears it.</p>
          </div>
        </SidePanel>
      </div>
    </Section>
  );
}

function OnboardingSection() {
  const radio = useId();
  const [channel, setChannel] = useState("telegram");
  const [jobs, setJobs] = useState<string[]>(["chase"]);
  const toggle = (v: string) => (on: boolean) => setJobs(on ? [...jobs, v] : jobs.filter((j) => j !== v));
  return (
    <Section title="Stepper and option cards" hint="A short flow's progress; a choice as a card (a real radio or checkbox).">
      <Stepper label="Getting started" steps={["Your first teammate", "How it reaches you", "Your home"]} current={0} />
      <div className="ui-grid">
        <OptionCard type="radio" name={radio} value="telegram" checked={channel === "telegram"} onChange={() => setChannel("telegram")} title="Telegram" badge={<Tag tone="ok">Recommended</Tag>} sub="One-tap buttons on your phone." />
        <OptionCard type="radio" name={radio} value="slack" checked={channel === "slack"} onChange={() => setChannel("slack")} title="Slack" sub="A direct message from your own bot." />
        <OptionCard type="checkbox" name="jobs" value="chase" checked={jobs.includes("chase")} onChange={toggle("chase")} media={face("Tess", 32)} title="People owe me things" sub="Tess tracks them and drafts a chaser when it goes quiet." />
        <OptionCard type="checkbox" name="jobs" value="notes" checked={jobs.includes("notes")} onChange={toggle("notes")} media={face("Nora", 32)} title="Meetings I can't keep up with" sub="Nora writes the notes and files your own actions." />
      </div>
    </Section>
  );
}

function SmallPartsSection() {
  return (
    <Section title="Disclosure and key caps">
      <Card>
        <Disclosure summary="Team behind Max (2)">
          <p className="dsg-p">AI reviewer: approves Max's GitHub posts before they go out.</p>
          <p className="dsg-p">Review engines: Codex and Claude Code runs in a sealed box.</p>
        </Disclosure>
      </Card>
      <div className="dsg-row">{["J", "K", "E", "S", "⌘K", "⌘J", "Esc"].map((x) => <Kbd key={x}>{x}</Kbd>)}</div>
    </Section>
  );
}

function MotionSection() {
  const [run, setRun] = useState(0);
  return (
    <Section title="Motion" hint=".enter arrives rising, staggered by --i; .lift rises on hover; .press gives under the pointer. Reduced motion stills it all." aside={<Button size="sm" onClick={() => setRun(run + 1)}>Replay</Button>}>
      <div key={run} className="dsg-enter">
        {ROSTER.slice(0, 6).map((m, i) => (
          <div key={m[0]} className="enter dsg-enter-row" style={{ "--i": i } as React.CSSProperties}>
            <TeammateChip agent={agent(m)} />
          </div>
        ))}
      </div>
      <div className="dsg-two">
        <div className="ui-card lift">.lift: hover me</div>
        <button type="button" className="ui-card press dsg-press">.press: press me</button>
      </div>
    </Section>
  );
}
