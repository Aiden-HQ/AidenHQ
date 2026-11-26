// A teammate as the owner meets it: its face and "Name · Job" (a hidden agent shows its name only). A link when given href.
import type { RosterAgent, RosterTeammate } from "../types";

/** What the chip reads: a roster entry, or Home's FaceRef shaped as one ({key, name, teammate: {job, face}}). */
export type ChipAgent = Pick<RosterAgent, "name"> & { key?: string; id?: string; state?: RosterAgent["state"]; teammate?: Pick<RosterTeammate, "job" | "face"> };
import { Face, faceProps } from "./Face";
import type { FaceState } from "./face-kit";

/** The face's state from the roster: needs you wins, then working (a queued run counts), else idle. */
export function faceStateOf(a: Pick<ChipAgent, "state">, needsYou?: boolean): FaceState {
  if (needsYou) return "needs";
  return a.state === "working" || a.state === "queued" ? "working" : "idle";
}

export function TeammateChip({ agent, state, size = 24, job = true, href }: { agent: ChipAgent; state?: FaceState; size?: number; job?: boolean; href?: string }) {
  const role = job ? agent.teammate?.job : undefined;
  const inner = (
    <>
      <Face seed={agent.key ?? agent.id ?? agent.name} {...faceProps(agent.teammate?.face)} state={state ?? faceStateOf(agent)} size={size} label={agent.name} />
      <span className="ui-mate-text">
        <b>{agent.name}</b>
        {role && <span> · {role}</span>}
      </span>
    </>
  );
  return href ? <a className="ui-mate" href={href}>{inner}</a> : <span className="ui-mate">{inner}</span>;
}
