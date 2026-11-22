// A module's setup flow entry point (docs/design/guided-setup.md): "Set up" while its flow isn't done, a quiet "Change setup"
// once it is. GET /api/setup-flows (services/board/src/setup-flows.ts); a module without a flow renders nothing.
import { useEffect, useState } from "react";
import { api } from "./api";

export interface Flow {
  module: string;
  title?: string;
  done?: boolean;
  /** The flow finishes by pairing a phone: false until a chat is paired. */
  paired?: boolean;
  /** Its paste fields and which secrets are saved, and whether its sign-in is in: what its next step is. */
  fields?: { secret: string }[];
  present?: Record<string, boolean>;
  signedIn?: boolean;
}

let cache: Promise<Flow[]> | undefined;
const listeners = new Set<() => void>();

/** The flows, fetched once and shared, until a pairing lands (`forgetFlows`): then the next read is fresh. */
export function flows(): Promise<Flow[]> {
  cache ??= api.setupFlows().then(
    (r) => {
      const list = Array.isArray(r) ? r : (r as { flows?: unknown })?.flows;
      return Array.isArray(list) ? (list as Flow[]) : [];
    },
    () => [],
  );
  return cache;
}

/** Reads the flows again from now on: called when a chat is paired, since it changes every "needs setup" that counted it. */
export function forgetFlows(): void {
  cache = undefined;
  for (const h of listeners) h();
}

/** Calls `h` each time the flows are fetched afresh. */
export function onFlowsChange(h: () => void): () => void {
  listeners.add(h);
  return () => void listeners.delete(h);
}

/** Whether the flow's next step is pairing: its secrets are saved and every sign-in before it is in, so only the phone is left. */
export const pairingNext = (f: Flow) =>
  f.paired === false && (f.fields ?? []).every((x) => f.present?.[x.secret]) && f.signedIn !== false;

export function SetupButton({ module, primary, size, word }: { module: string; primary?: boolean; size?: "sm"; word?: string }) {
  const [flow, setFlow] = useState<Flow | undefined>();
  useEffect(() => {
    let live = true;
    const read = () => void flows().then((l) => live && setFlow(l.find((f) => f.module === module)));
    read();
    const off = onFlowsChange(read);
    return () => {
      live = false;
      off();
    };
  }, [module]);
  if (!flow) return null;
  return (
    <a className={`btn${primary && !flow.done ? " primary" : ""}${size ? ` ${size}` : ""}`} href={`#/setup/${module}${flow.done ? "?change=1" : ""}`}>
      {flow.done ? "Change setup" : (word ?? "Set up")}
    </a>
  );
}
