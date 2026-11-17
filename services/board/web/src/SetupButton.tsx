// A module's setup flow entry point (docs/design/guided-setup.md): "Set up" while its flow isn't done, a quiet "Run setup again"
// once it is. GET /api/setup-flows comes from the guided-setup work; until it lands (404) this renders nothing.
import { useEffect, useState } from "react";
import { api } from "./api";

export interface Flow {
  module: string;
  title?: string;
  done?: boolean;
}

let cache: Promise<Flow[]> | undefined;
/** The flows, fetched once per page load and shared. */
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

export function SetupButton({ module, primary }: { module: string; primary?: boolean }) {
  const [flow, setFlow] = useState<Flow | undefined>();
  useEffect(() => {
    let live = true;
    void flows().then((l) => live && setFlow(l.find((f) => f.module === module)));
    return () => {
      live = false;
    };
  }, [module]);
  if (!flow) return null;
  return (
    <a className={`btn${primary && !flow.done ? " primary" : ""}`} href={`#/setup/${module}`}>
      {flow.done ? "Run setup again" : "Set up"}
    </a>
  );
}
