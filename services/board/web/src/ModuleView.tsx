// A module's Fleet page (board.pages): the module's own view (an MCP Apps resource) in a sandboxed frame, and this host's half of
// the MCP Apps bridge (modelcontextprotocol/ext-apps, 2026-01-26) over postMessage. The frame is an opaque origin with no network
// (the board serves it with a sandbox CSP), so everything it does goes through here: its tool calls go to the board's
// /api/pages/<page>/call (the kernel lets through only the tools its page declares), and a setting it proposes is saved only by
// the owner's own click on the bar below the frame. Docs: docs/design/board-ui.md "Modules".
import { useCallback, useEffect, useRef, useState } from "react";
import { api, SignInRequired } from "./api";
import type { PageRow } from "./types";
import { IN_FLIGHT } from "./settings-ui";
import type { FiledChange } from "./types";
import { SecretMaps } from "./SecretMaps";
import { Button, Page, PageHeader } from "./ui";
import { openAsk } from "./AskAiden";
import "./modules.css";

const PROTOCOL = "2026-01-26";
type Msg = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, any> };
type Proposal = { changes: { kind: string; key: string; value: unknown }[] };

/** The MCP Apps style variables a page uses, from the board's tokens (ui/tokens.css) as written: light-dark() values resolve in
 *  the frame by the `theme` the view sets as its color-scheme. */
const TOKENS: Record<string, string> = {
  "--color-background-primary": "--surface",
  "--color-background-secondary": "--surface-2",
  "--color-text-primary": "--text",
  "--color-text-secondary": "--muted",
  "--color-text-danger": "--bad-text",
  "--color-text-inverse": "--accent-text",
  "--color-border-primary": "--border",
  "--color-ring-primary": "--accent",
  "--color-background-tertiary": "--col",
  "--color-background-info": "--accent-soft",
  "--color-background-danger": "--strip-bad-bg",
  "--color-background-success": "--strip-ok-bg",
  "--color-background-warning": "--strip-warn-bg",
  "--color-text-tertiary": "--faint",
  "--color-text-info": "--accent",
  "--color-text-success": "--ok-text",
  "--color-text-warning": "--warn-text",
  "--color-border-secondary": "--border-strong",
  "--font-sans": "--font",
  "--font-text-xs-size": "--text-xs",
  "--font-text-sm-size": "--text-sm",
  "--font-text-md-size": "--text-md",
  "--border-radius-xs": "--radius-sm",
  "--border-radius-sm": "--radius-sm",
  "--border-radius-md": "--radius-md",
  "--border-radius-lg": "--radius",
  "--shadow-sm": "--shadow",
  "--shadow-md": "--shadow-hover",
  "--shadow-lg": "--shadow-lg",
};
function hostContext() {
  const root = getComputedStyle(document.documentElement);
  const variables = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, root.getPropertyValue(v).trim()]));
  return { theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", styles: { variables }, displayMode: "inline", platform: matchMedia("(max-width: 720px)").matches ? "mobile" : "web", locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function ModuleView({ page, sub, onSignIn }: { page: PageRow | undefined; /** The part of the address after the page's own (#/team/m/<id>/<sub>): handed to the view in its host context. */ sub?: string; onSignIn: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState("");
  // A page proposes from the settings as applied, so a proposal built while another change to the same settings is still under way
  // (filed from any page, a refresh ago, or a Save whose answer was lost) would overwrite it. The filed changes are the one truth:
  // Save waits while one touching the proposal's settings is in flight, and when it lands the page starts over from the live settings.
  const [changes, setChanges] = useState<FiledChange[]>([]);
  const latest = useRef(0);
  // Only the newest request's answer counts: an older read must not undo what a newer one showed.
  const refresh = useCallback(() => { const n = ++latest.current; return api.settingsChanges().then((r) => void (n === latest.current && setChanges(r.changes)), () => {}); }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 3_000);
    return () => clearInterval(t);
  }, [refresh]);
  const keys = new Set(proposal?.changes.map((c) => c.key));
  const blocking = changes.find((c) => IN_FLIGHT.includes(c.stage) && c.items.some((i) => "key" in i && keys.has(i.key)));
  // Every change this page has had to wait for, or saved: the page starts over once one of them is applied.
  const watched = useRef(new Set<string>());
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState("");
  const loads = useRef(0);
  const started = useRef(false);
  const id = page?.id;
  const roster = useRef<Promise<Record<string, string>> | undefined>(undefined);
  const names = () => (roster.current ??= Promise.race([api.roster().then((r) => Object.fromEntries(r.roster.filter((a) => a.key && a.teammate).map((a) => [a.key!, a.name])), () => ({})), new Promise<Record<string, string>>((ok) => setTimeout(() => ok({}), 1500))]));
  useEffect(() => {
    loads.current = 0;
    started.current = false;
  }, [id, attempt]);
  function loaded() {
    loads.current += 1;
    if (loads.current > 1) return setBroken("The page left its own view, so the board stopped it.");
    const at = frame.current;
    setTimeout(() => frame.current === at && !started.current && setBroken("The page didn't start: its module may be restarting or off."), 8_000);
  }

  useEffect(() => {
    if (!id) return;
    const answer = (req: Msg, body: { result: unknown } | { error: { code: number; message: string } }) => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", id: req.id, ...body }, "*");
    let live = true;
    // The frame inherits the board's color-scheme, so the view must follow a system theme change too, or the browser paints an
    // opaque backdrop behind it (MCP Apps ui/notifications/host-context-changed).
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const restyle = () => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: hostContext() }, "*");
    dark.addEventListener("change", restyle);
    async function onMessage(e: MessageEvent) {
      // Only the frame this page made, never another window or frame; its origin is "null" (opaque), so the source is the check.
      if (!frame.current || e.source !== frame.current.contentWindow || loads.current > 1) return;
      const m = e.data as Msg;
      if (m?.jsonrpc !== "2.0") return;
      if (m.method === "ui/initialize") {
        started.current = true;
        // `teammates`: each teammate's key and current name (an owner may rename one), for a view that speaks of its own.
        const teammates = await names();
        if (!live || e.source !== frame.current?.contentWindow || loads.current > 1) return;
        return answer(m, { result: { protocolVersion: PROTOCOL, hostInfo: { name: "AidenHQ board", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: { ...hostContext(), teammates, route: sub ?? "" } } });
      }
      if (m.method === "ui/notifications/size-changed" && typeof m.params?.height === "number") return setHeight(Math.min(4000, Math.max(160, Math.ceil(m.params.height))));
      // A link the view asks to open: http(s) only, in a new tab the page can't reach back from.
      if (m.method === "ui/open-link") {
        const url = typeof m.params?.url === "string" && URL.canParse(m.params.url) ? new URL(m.params.url) : null;
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return answer(m, { error: { code: -32602, message: "only http and https links open" } });
        window.open(url.href, "_blank", "noopener,noreferrer");
        return answer(m, { result: {} });
      }
      // A message the view asks to send (MCP Apps ui/message): Ask Aiden opens with its text ready, the owner sends it.
      if (m.method === "ui/message") {
        const content = m.params?.content;
        const text = Array.isArray(content) ? (content as { type?: string; text?: unknown }[]).find((c) => c?.type === "text")?.text : undefined;
        if (typeof text !== "string" || !text.trim()) return answer(m, { error: { code: -32602, message: "a message has text" } });
        // An unsent message already in Ask Aiden stays: the view's text goes after it.
        let prior = "";
        try { prior = localStorage.getItem("draft:ask") ?? ""; } catch { /* no storage: nothing to keep */ }
        openAsk({ text: (prior.trim() ? `${prior.trimEnd()}\n\n${text}` : text).slice(0, 4000) });
        return answer(m, { result: {} });
      }
      if (m.method !== "tools/call") return; // ui/notifications/initialized needs nothing; anything else isn't offered
      const r: { result?: unknown; error?: { code?: number; message?: string } } = await api.viewCall(id!, String(m.params?.name ?? ""), m.params?.arguments).catch((err: Error) => {
        if (err instanceof SignInRequired) onSignIn();
        return { error: { code: -32000, message: err.message } };
      });
      // A settings change the tool proposed: shown on the bar below, saved only by the owner's click (/save checks it).
      const changes = (r.result as { structuredContent?: { _aidenhq?: { settings_change?: unknown } } } | undefined)?.structuredContent?._aidenhq?.settings_change;
      if (live && Array.isArray(changes)) changes.length ? (setProposal({ changes: changes as Proposal["changes"] }), setSaid("")) : setProposal(null); // an explicit empty proposal (every edit put back) clears the bar
      if (live && loads.current <= 1) answer(m, r.error ? { error: { code: r.error.code ?? -32000, message: String(r.error.message ?? "failed") } } : { result: r.result });
    }
    window.addEventListener("message", onMessage);
    return () => (live = false, window.removeEventListener("message", onMessage), dark.removeEventListener("change", restyle));
  }, [id, sub, onSignIn, attempt]);

  useEffect(() => {
    for (const c of changes) if (IN_FLIGHT.includes(c.stage) && c.items.some((i) => "key" in i && keys.has(i.key))) watched.current.add(c.identifier);
    for (const id of watched.current) {
      const f = changes.find((c) => c.identifier === id);
      if (!f || IN_FLIGHT.includes(f.stage)) continue;
      watched.current.delete(id);
      if (f.stage === "applied") return watched.current.clear(), setSaid(`${id} is live; the page starts over from it.`), setProposal(null), setAttempt((a) => a + 1);
      setSaid(`${id} was not applied (${f.stage})${f.detail ? `: ${f.detail}` : ""}.`);
    }
  }, [changes, proposal]);

  if (!page)
    return (
      <Page>
        <PageHeader title="No such page" sub="The module that declared it is off or removed." />
      </Page>
    );
  async function save() {
    if (!proposal) return;
    setSaving(true);
    try {
      const r = await api.viewSave(page!.id, proposal.changes);
      watched.current.add(r.identifier);
      setSaid(`Saved as ${r.identifier}: the change applies in a moment.`);
    } catch (e) {
      setSaid(`Not saved: ${(e as Error).message}`);
    } finally {
      await refresh(); // even a lost answer may have filed it: the lock then follows it
      setSaving(false);
    }
  }
  return (
    <Page className="module-view">
      <PageHeader title={page.title} />
      {proposal && (
        <div className="mv-proposal" role="region" aria-label="Proposed change">
          <div className="mv-proposal-text">
            <b>Save this change to {page.module}'s settings?</b>
            {blocking && <p className="mv-said">{blocking.identifier} changes the same settings and is {blocking.stage === "waiting" ? "waiting for approval" : "being applied"}: Save unlocks once it is decided, and it starts the page over from the result.</p>}
            {proposal.changes.map((c) => (
              <pre key={c.key}>
                {c.key} = {JSON.stringify(c.value, null, 2)}
              </pre>
            ))}
          </div>
          <div className="mv-proposal-actions">
            <Button variant="quiet" onClick={() => (setProposal(null), setAttempt((a) => a + 1))} /* a discarded edit must not linger in the page: it starts over from what is saved */ disabled={saving}>Discard</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving || !!blocking}>{saving ? "Saving…" : blocking ? "Applying…" : "Save"}</Button>
          </div>
        </div>
      )}
      {said && <p className="mv-said" role="status">{said}</p>}
      {broken ? (
        <div className="mv-broken" role="alert">
          <p>{broken}</p>
          <Button onClick={() => (setBroken(""), setAttempt((a) => a + 1))}>Try again</Button>
        </div>
      ) : (
        <iframe ref={frame} className="mv-frame" key={`${page.id}-${attempt}`} title={page.title} src={`/api/pages/${page.id}/frame`} sandbox="allow-scripts allow-forms" style={{ height }} onLoad={loaded} />
      )}
      {/* The page's sign-in keys (board.pages secret_maps), the board's own panel: values go to the vault from here, never through the frame. */}
      <SecretMaps page={page.id} reload={attempt} onSignIn={onSignIn} />
    </Page>
  );
}
