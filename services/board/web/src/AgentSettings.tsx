// An agent's Settings tab (#/team/agents/<key>/settings), docs/design/agent-and-module-pages.md "Agent page".
import { useRef, useState } from "react";
import { useLive } from "./events";
import { AgentGrants } from "./AgentGrants";
import { SignInRequired, api } from "./api";
import { AgentDetails } from "./SettingsAgents";
import { ChangesScope } from "./settings-ui";
import { SkeletonLines } from "./Skeleton";
import type { AgentProfile, SettingsData } from "./types";

/** The agent page's Settings tab (lane B: model, effort, heartbeat, routines, recent changes; lane E: grants via AgentGrants). */
export function AgentSettings({ agentKey, profile, onSignIn }: { agentKey: string; profile?: AgentProfile; onSignIn: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState("");
  // Reload on fleet changes and once a minute, so a shown next run moves on after its schedule fires. Only the newest read
  // lands: an older one finishing late must not undo a pause or resume shown since.
  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    return api.settings().then(
      (d) => n === seq.current && (setData(d), setError("")),
      (e) => n === seq.current && (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
    );
  };
  useLive(["fleet"], load, 60_000);
  const a = data?.agents.find((x) => x.key === agentKey);
  return (
    <ChangesScope onSignIn={onSignIn}>
      {profile && <Details p={profile} />}
      <section className="st-embedded">
        {error && !data ? <p className="fleet-empty">Couldn't load settings: {error}</p> : !data ? <SkeletonLines lines={4} /> : a ? <AgentDetails a={a} data={data} reload={() => void load()} /> : <p className="fleet-empty">This agent has no settings in the compiled config yet.</p>}
      </section>
      <AgentGrants agentKey={agentKey} onSignIn={onSignIn} />
    </ChangesScope>
  );
}

/** Where the agent comes from and its version: the details the page header leaves out (model and effort are edited below). */
function Details({ p }: { p: AgentProfile }) {
  const src = p.source;
  const rows: [string, string | null][] = [
    ["From", src ? `${src.module} module${src.marketplace ? ` (${src.marketplace}${src.tier ? `, ${src.tier}` : ""})` : ""}` : "Your own agent"],
    ["Version", src?.revision ?? null],
    ["Reports to", p.reportsTo],
  ];
  return (
    <dl className="agp-details">
      {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}
