// An agent's Settings tab (#/agents/<key>/settings), docs/design/agent-and-module-pages.md "Agent page".
import { useEffect, useState } from "react";
import { AgentGrants } from "./AgentGrants";
import { SignInRequired, api } from "./api";
import { AgentDetails } from "./SettingsAgents";
import { ChangesScope } from "./settings-ui";
import { SkeletonLines } from "./Skeleton";
import type { SettingsData } from "./types";

/** The agent page's Settings tab (lane B: model, effort, heartbeat, routines, caps, recent changes; lane E: grants via AgentGrants). */
export function AgentSettings({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.settings().then(setData, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)));
  }, [onSignIn]);
  const a = data?.agents.find((x) => x.key === agentKey);
  return (
    <ChangesScope onSignIn={onSignIn}>
      <section className="st-embedded">
        {error ? <p className="fleet-empty">Couldn't load settings: {error}</p> : !data ? <SkeletonLines lines={4} /> : a ? <AgentDetails a={a} data={data} /> : <p className="fleet-empty">This agent has no settings in the compiled config yet.</p>}
      </section>
      <AgentGrants agentKey={agentKey} onSignIn={onSignIn} />
    </ChangesScope>
  );
}
