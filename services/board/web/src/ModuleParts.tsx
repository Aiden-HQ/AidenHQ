// Shared by the Modules list and a module's page: the on/off switch with its turn-off confirm, the Turn on card, a
// module's state in one word, its facts, and which modules need setup.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { pairingNext, useFlows } from "./SetupButton";
import { ChangePreview, IN_FLIGHT, useChanges, useFiled } from "./settings-ui";
import type { Advisory, BrowseModule, FiledChange, ModuleRow } from "./types";
import { StatusDot, Switch, type StatusTone } from "./ui";

/** The installed modules whose setup flow isn't done, and the unfinished ones whose next step is pairing. */
export function useSetupState(): { needed: Set<string>; pairing: Set<string> } {
  const list = useFlows() ?? [];
  return useMemo(
    () => ({
      needed: new Set(list.filter((f) => !f.done).map((f) => f.module)),
      pairing: new Set(list.filter((f) => !f.done && pairingNext(f)).map((f) => f.module)),
    }),
    [list],
  );
}

/** Installed modules whose setup flow isn't done (GET /api/setup-flows; absent or failing: none). */
export function useSetupNeeded(): Set<string> {
  return useSetupState().needed;
}

/** What an enabled but unpaired module's action says: pair the phone, then its setup is done. */
export const PAIR_ACTION = "Pair your phone";

/**
 * The unfinished flows whose next step is pairing: saved secrets and every sign-in behind them are done, so pairing is all
 * that is left. A flow still asking for a secret or a sign-in needs that first, not "Pair your phone".
 */
export function useSetupPairing(): Set<string> {
  return useSetupState().pairing;
}

type Toggled = Pick<ModuleRow, "name" | "id" | "agents" | "routines" | "neededBy" | "state">;

/** A centred dialog over the page; a press outside closes it. */
export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="new-task mods-dialog" role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** The switch, its confirm dialog and the change preview (in a dialog) for one module. */
export function useModuleToggle(m: Toggled) {
  const filed = useFiled((c) => c.kind === "module" && c.name === m.id);
  const [want, setWant] = useState<boolean | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const isOn = m.state !== "off";
  const fixed = m.state === "core" || m.state === "dependency";
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const switchEl = fixed ? null : <Switch on={want ?? isOn} label={`${m.name}: ${isOn ? "on" : "off"}`} danger disabled={busy} onChange={(v) => (v ? setWant(true) : !isOn ? setWant(null) : setConfirmOff(true))} />;
  const dialog = confirmOff ? (
    <Dialog label={`Turn off ${m.name}?`} onClose={() => setConfirmOff(false)}>
      <h2>Turn off {m.name}?</h2>
      {m.neededBy.length > 0 ? (
        <p>Another module needs it: {m.neededBy.join(", ")}. Turn that off first.</p>
      ) : (
        <>
          {(m.agents.length > 0 || m.routines.length > 0) && <p>These stop: {[...m.agents.map((a) => `agent ${a}`), ...m.routines.map((r) => `routine ${r}`)].join(", ")}.</p>}
          <p>Their tasks and the module's data on disk are kept; turning it back on resumes.</p>
        </>
      )}
      <div className="mods-dialog-actions">
        <span className="spacer" />
        <button className="btn" autoFocus onClick={() => setConfirmOff(false)}>{m.neededBy.length ? "Close" : "Cancel"}</button>
        {m.neededBy.length === 0 && <button className="btn primary" onClick={() => (setConfirmOff(false), setWant(false))}>Turn off</button>}
      </div>
    </Dialog>
  ) : want !== null && want !== isOn ? (
    <Dialog label={`${want ? "Turn on" : "Turn off"} ${m.name}`} onClose={() => setWant(null)}>
      <h2>{want ? "Turn on" : "Turn off"} {m.name}</h2>
      <ChangePreview items={[{ kind: "module", name: m.id, on: want }]} was={[isOn]} onCancel={() => setWant(null)} onDone={() => setWant(null)} note={want ? "A module that needs settings (a URL, a site) asks for them on its page once it is on." : "Its agents stop and its connections close."} />
    </Dialog>
  ) : null;
  return { filed, want, setWant, isOn, fixed, busy, switchEl, dialog };
}

/** What turning it on adds, who approves, then Turn on: files the same change the switch does. */
export function TurnOnCard({ m, info, onClose }: { m: Pick<ModuleRow, "name" | "id" | "description" | "marketplace" | "tier">; info?: BrowseModule; onClose: () => void }) {
  const { file, toast } = useChanges();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const adds = info?.adds ?? [];
  const taps = adds.some((a) => a.startsWith("needs")) || m.tier !== "official";
  const go = async () => {
    setBusy(true);
    try {
      const task = await file([{ kind: "module", name: m.id, on: true }]);
      toast(`Turning on ${m.name}: requested (${task}).`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog label={`Turn on ${m.name}`} onClose={onClose}>
      <h2>Turn on {m.name}</h2>
      <p>{m.description}</p>
      <p>{m.tier === "official" ? "An official module." : `From ${publisher(m)}.`}{info ? " It adds:" : ""}</p>
      {info && <ul className="mods-adds">{adds.length ? adds.map((a) => <li key={a}>{a}</li>) : <li>nothing beyond its own settings</li>}</ul>}
      <p className="muted">
        {taps ? "It adds access or sign-ins, so after the AI review you tap to approve." : "The AI reviewer checks it; you tap only if it turns out to add new authority."}
        {info?.setupFlow ? ` Afterwards: ${info.setupFlow.title}.` : ""}
      </p>
      {error && <p className="st-error" role="alert">{error}</p>}
      <div className="mods-dialog-actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" autoFocus onClick={() => void go()} disabled={busy}>{busy ? "Requesting…" : "Turn on"}</button>
      </div>
    </Dialog>
  );
}

/** "Official", or where a third-party module comes from and how far it is checked. */
export const publisher = (m: Pick<ModuleRow, "marketplace" | "tier">) => (m.tier === "official" ? "Official" : `${m.marketplace}, ${m.tier}`);

/** Why a module can't be turned off, or undefined when it can. */
export const lockedWhy = (m: Pick<ModuleRow, "state" | "neededBy">) => (m.state === "core" ? "Part of the core: always on" : m.state === "dependency" ? `Needed by ${m.neededBy.length ? m.neededBy.join(", ") : "another module"}` : undefined);

const STAGE: Partial<Record<FiledChange["stage"], string>> = { working: "In review", applying: "Applying", failed: "Change failed", rejected: "Turned down" };

/**
 * A module's state in one tone and word: a change under way or stopped, a security fix, setup, a sign-in, then on or off.
 * `pairing`: the module's setup flow finished by pairing a phone. A module switched on with that unfinished says so,
 * instead of reading on beside "Needs setup", and `action` names what closes it.
 */
export function moduleState(
  m: Pick<ModuleRow, "state">,
  o: { filed?: FiledChange; setup?: boolean; pairing?: boolean; connect?: boolean; advisory?: Advisory },
): { tone: StatusTone; word: string; action?: string } {
  const f = o.filed;
  if (f && (f.stage === "failed" || f.stage === "rejected")) return { tone: "failed", word: STAGE[f.stage]! };
  if (f && f.stage === "waiting" && f.tier !== 1) return { tone: "needs", word: "Waiting for you" };
  if (f && IN_FLIGHT.includes(f.stage)) return { tone: "working", word: STAGE[f.stage] ?? "In review" };
  if (o.advisory) return { tone: "failed", word: "Security fix" };
  if (o.setup) return o.pairing && m.state !== "off" && m.state !== "core" ? { tone: "needs", word: "Enabled, not paired", action: PAIR_ACTION } : { tone: "needs", word: "Needs setup" };
  if (o.connect) return { tone: "needs", word: "Not connected" };
  if (m.state === "core") return { tone: "working", word: "Always on" };
  if (m.state === "off") return { tone: "done", word: "Off" };
  return { tone: "working", word: "On" };
}

export function ModuleStatus({ s }: { s: { tone: StatusTone; word: string } }) {
  return <StatusDot tone={s.tone}>{s.word}</StatusDot>;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const Icon = ({ d }: { d: string }) => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICON = {
  agent: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.3 2.6-3.5 5-3.5s4.4 1.2 5 3.5",
  connection: "M6.5 9.5l3-3M5 7.5L3.8 8.7a2.5 2.5 0 0 0 3.5 3.5L8.5 11M11 8.5l1.2-1.2a2.5 2.5 0 0 0-3.5-3.5L7.5 5",
  routine: "M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM8 5.5V8l1.8 1.2",
  app: "M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v4H3zM9 9.5h4v4H9z",
  pin: "M8 14V9.5M5 9.5h6M6 3h4l-.5 3.5 1.5 3H5l1.5-3z",
  lock: "M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2",
};
export const LockIcon = () => <Icon d={ICON.lock} />;

/** What a module brings, as counts with small icons; empty when it brings nothing countable. */
export function ModuleFacts({ m }: { m: Pick<ModuleRow, "agents" | "connections" | "routines" | "apps" | "pinned"> }) {
  const facts: [keyof typeof ICON, string][] = [];
  if (m.agents.length) facts.push(["agent", plural(m.agents.length, "agent")]);
  if (m.connections.length) facts.push(["connection", plural(m.connections.length, "connection")]);
  if (m.routines.length) facts.push(["routine", plural(m.routines.length, "routine")]);
  if (m.apps.length) facts.push(["app", plural(m.apps.length, "app")]);
  if (m.pinned) facts.push(["pin", `Pinned at ${m.pinned}`]);
  if (!facts.length) return null;
  return (
    <>
      {facts.map(([k, text]) => (
        <span key={k}>
          <Icon d={ICON[k]} />
          {text}
        </span>
      ))}
    </>
  );
}
