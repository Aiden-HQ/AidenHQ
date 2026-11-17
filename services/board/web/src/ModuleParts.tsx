// Shared by the Modules list and a module's page: the on/off switch with its turn-off confirm, and which modules need setup.
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { ChangePreview, ChangeProgress, IN_FLIGHT, StatusPill, Switch, useFiled } from "./settings-ui";
import type { ModuleRow } from "./types";

/** Installed modules whose setup flow isn't done (GET /api/setup-flows; absent or failing: none). */
export function useSetupNeeded(): Set<string> {
  const [needed, setNeeded] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.setupFlows().then((r) => setNeeded(new Set((r.flows ?? []).map((f) => f.module))), () => {});
  }, []);
  return needed;
}

type Toggled = Pick<ModuleRow, "name" | "agents" | "routines" | "neededBy" | "state">;

/** The switch, its confirm dialog and the change preview for one module; place `switchEl` in a header or row, `dialog` anywhere, `body` where the preview opens. */
export function useModuleToggle(m: Toggled) {
  const filed = useFiled((c) => c.kind === "module" && c.name === m.name);
  const [want, setWant] = useState<boolean | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const isOn = m.state !== "off";
  const fixed = m.state === "core" || m.state === "dependency";
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const switchEl = fixed ? null : <Switch on={want ?? isOn} label={`${m.name}: ${isOn ? "on" : "off"}`} redOff disabled={busy} onChange={(v) => (v ? setWant(true) : !isOn ? setWant(null) : setConfirmOff(true))} />;
  const dialog = confirmOff && (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && setConfirmOff(false)}>
      <div className="new-task" role="dialog" aria-label={`Turn off ${m.name}?`}>
        <h2>Turn off {m.name}?</h2>
        {m.neededBy.length > 0 ? (
          <p>Another module needs it: {m.neededBy.join(", ")}. Turn that off first.</p>
        ) : (
          <>
            {(m.agents.length > 0 || m.routines.length > 0) && <p>These stop: {[...m.agents.map((a) => `agent ${a}`), ...m.routines.map((r) => `routine ${r}`)].join(", ")}.</p>}
            <p>Their tasks and the module's data on disk are kept; turning it back on resumes.</p>
          </>
        )}
        <div className="ap-bar">
          <span className="spacer" />
          <button className="btn" autoFocus onClick={() => setConfirmOff(false)}>{m.neededBy.length ? "Close" : "Cancel"}</button>
          {m.neededBy.length === 0 && <button className="btn primary" onClick={() => (setConfirmOff(false), setWant(false))}>Turn off</button>}
        </div>
      </div>
    </div>
  );
  const meta: ReactNode = busy ? <StatusPill tone="busy">Changing</StatusPill> : undefined;
  const progress = filed && <ChangeProgress f={filed} />;
  const preview =
    want !== null && want !== isOn ? (
      <ChangePreview items={[{ kind: "module", name: m.name, on: want }]} was={[isOn]} onCancel={() => setWant(null)} onDone={() => setWant(null)} note={want ? "You approve it on the card. A module that needs settings (a URL, a site) asks for them on its page once it is on." : "You approve it on the card. Its agents stop and its connections close."} />
    ) : null;
  return { filed, want, setWant, isOn, fixed, busy, switchEl, dialog, meta, progress, preview };
}
