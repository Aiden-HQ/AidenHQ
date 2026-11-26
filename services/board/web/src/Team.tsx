// Team (#/team): the teammates, each a card with its face and state, "Name · Role", what it is doing now, Rename, and who
// works behind it. A card opens the teammate's page (#/team/<key>). Hidden agents are on Team › All agents.
import { useState, type CSSProperties } from "react";
import { SignInRequired, api } from "./api";
import { load } from "./cache";
import { useLive } from "./events";
import { QUERIES, useQuery } from "./queries";
import { FleetSkeleton } from "./Skeleton";
import type { RosterAgent } from "./types";
import { Button, Dialog, EmptyState, Face, Field, Input, Page, PageHeader, Tile, faceProps, faceStateOf } from "./ui";
import { teammateNameProblem } from "../../src/teammate-name";
import { ago } from "./util";
import "./team.css";

/** The roster's teammates (an agent with a `teammate:` block), Aiden first. */
export const teammatesOf = (roster: RosterAgent[]) => roster.filter((a) => a.key && a.teammate).sort((a, b) => Number(b.key === "chief-of-staff") - Number(a.key === "chief-of-staff"));

/** One line on what a teammate is doing: what needs you, what it works on, or how long it has been idle. */
export function statusLine(a: RosterAgent, needs: number): string {
  if (a.state === "paused") return "Paused";
  if (needs) return `${needs === 1 ? "One thing needs" : `${needs} things need`} you`;
  if (a.state === "working" || a.state === "queued") return a.stateNote ?? (a.state === "queued" ? "About to start" : "Working");
  if (a.state === "failing") return a.stateNote ?? "Its last run failed";
  return a.lastRunAt ? `Idle since ${ago(a.lastRunAt)}` : "Idle";
}

export function TeamView({ onSignIn }: { go: (h: string) => void; onSignIn: () => void }) {
  const rosterQ = useQuery(QUERIES.roster, onSignIn);
  const home = useQuery(QUERIES.home, onSignIn).data;
  useLive(["fleet"], rosterQ.reload, 30_000);
  const roster = rosterQ.data?.roster;
  if (!roster) return <Page label="Team">{rosterQ.error ? <EmptyState>Couldn't load your team: {rosterQ.error}</EmptyState> : <FleetSkeleton groups={[4]} />}</Page>;
  const mates = teammatesOf(roster);
  const names = new Map(roster.map((a) => [a.key, a.name]));
  const needs = (key: string) => home?.needs.filter((n) => n.teammate.key === key).length ?? 0;
  return (
    <Page className="team" label="Team">
      <PageHeader title="Your team" sub="Each teammate owns one part of your work. Talk to them by name; the agents behind them do the rest." />
      <div className="team-grid">
        {mates.map((a, i) => {
          const n = needs(a.key!);
          const staff = a.teammate!.staff.map((k) => names.get(k) ?? k);
          return (
            <div key={a.key} className="enter" style={{ "--i": i } as CSSProperties}>
              <Tile
                href={`#/team/${a.key}`}
                name={a.key!}
                title={`${a.name} · ${a.teammate!.job}`}
                tone={n ? "needs" : undefined}
                face={<Face seed={a.key!} {...faceProps(a.teammate!.face)} state={faceStateOf(a, n > 0)} size={64} label={a.name} />}
                foot={staff.length ? `Behind the scenes: ${staff.join(", ")}` : "Works on its own"}
                action={<RenameButton agent={a} roster={roster} />}
              >
                {statusLine(a, n)}
              </Tile>
            </div>
          );
        })}
        <div className="enter" style={{ "--i": mates.length } as CSSProperties}>
          <Tile tone="ghost" href="#/team/architect" name="hire" title="Hire a teammate" face={<span className="team-plus" aria-hidden>+</span>}>
            Security, repo upkeep, or describe your own: Archie designs it with you.
          </Tile>
        </div>
      </div>
    </Page>
  );
}

/**
 * Rename a teammate: the name is checked as it is typed with the rule the server uses (no other agent's name or key), then
 * filed as a settings change; it applies on the next apply.
 */
export function RenameButton({ agent, roster }: { agent: RosterAgent; roster: RosterAgent[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState("");
  const [filed, setFiled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const others = Object.fromEntries(roster.filter((a) => a.key).map((a) => [a.key!, { name: a.name }]));
  const problem = name === agent.name ? undefined : teammateNameProblem(name, agent.key!, others);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.changeSettings([{ kind: "agent", agent: agent.key!, field: "name", value: name }]);
      setFiled(r.identifier);
      void load(QUERIES.roster.key, QUERIES.roster.fetch, QUERIES.roster.persist, true).catch(() => {});
    } catch (e) {
      setError(e instanceof SignInRequired ? "Sign in again to rename." : (e as Error).message);
    }
    setBusy(false);
  };
  const close = () => (setOpen(false), setFiled(null), setError(""), setName(agent.name));
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Rename</Button>
      <Dialog
        open={open}
        onClose={close}
        title={`Rename ${agent.name}`}
        actions={
          filed ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="quiet" onClick={close}>Cancel</Button>
              <Button variant="primary" disabled={busy || !!problem || name === agent.name} onClick={() => void save()}>{busy ? "Renaming…" : "Rename"}</Button>
            </>
          )
        }
      >
        {filed ? (
          <p>
            Filed as <a href={`#/t/${filed}`}>{filed}</a>; {name} is the new name once it applies.
          </p>
        ) : (
          <form onSubmit={(e) => (e.preventDefault(), !problem && name !== agent.name && void save())}>
            <Field label="Name" error={problem || error || null} help={`${agent.teammate?.job ?? "Its job"} stays the same.`}>
              {(id, note) => <Input id={id} aria-describedby={note} value={name} autoFocus maxLength={24} aria-invalid={!!problem || !!error} onChange={(e) => setName(e.target.value)} />}
            </Field>
          </form>
        )}
      </Dialog>
    </>
  );
}
