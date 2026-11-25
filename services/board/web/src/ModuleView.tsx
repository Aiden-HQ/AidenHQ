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
import { Button, Page, PageHeader } from "./ui";
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
  "--font-sans": "--font",
  "--border-radius-md": "--radius-md",
};
function hostContext() {
  const root = getComputedStyle(document.documentElement);
  const variables = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, root.getPropertyValue(v).trim()]));
  return { theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", styles: { variables }, displayMode: "inline", platform: matchMedia("(max-width: 720px)").matches ? "mobile" : "web", locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function ModuleView({ page, sub, onSignIn }: { page: PageRow | undefined; /** The part of the address after the page's own (#/fleet/<id>/<sub>): handed to the view in its host context. */ sub?: string; onSignIn: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState("");
  // A page proposes from the settings as applied, so a proposal built while another change to the same settings is still under way
  // (filed from any page, a refresh ago, or a Save whose answer was lost) would overwrite it. The filed changes are the one truth:
  // Save waits while one touching the proposal's settings is in flight, and when it lands the page starts over from the live settings.
  const [changes, setChanges] = useState<FiledChange[]>([]);
  const refresh = useCallback(() => api.settingsChanges().then((r) => setChanges(r.changes), () => {}), []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 3_000);
    return () => clearInterval(t);
  }, [refresh]);
  const keys = new Set(proposal?.changes.map((c) => c.key));
  const blocking = changes.find((c) => IN_FLIGHT.includes(c.stage) && c.items.some((i) => "key" in i && keys.has(i.key)));
  const watched = useRef("");
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState("");
  const loads = useRef(0);
  const started = useRef(false);
  const id = page?.id;
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
    async function onMessage(e: MessageEvent) {
      // Only the frame this page made, never another window or frame; its origin is "null" (opaque), so the source is the check.
      if (!frame.current || e.source !== frame.current.contentWindow || loads.current > 1) return;
      const m = e.data as Msg;
      if (m?.jsonrpc !== "2.0") return;
      if (m.method === "ui/initialize") return (started.current = true), answer(m, { result: { protocolVersion: PROTOCOL, hostInfo: { name: "AidenHQ board", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: { ...hostContext(), route: sub ?? "" } } });
      if (m.method === "ui/notifications/size-changed" && typeof m.params?.height === "number") return setHeight(Math.min(4000, Math.max(160, Math.ceil(m.params.height))));
      // A link the view asks to open: http(s) only, in a new tab the page can't reach back from.
      if (m.method === "ui/open-link") {
        const url = typeof m.params?.url === "string" && URL.canParse(m.params.url) ? new URL(m.params.url) : null;
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return answer(m, { error: { code: -32602, message: "only http and https links open" } });
        window.open(url.href, "_blank", "noopener,noreferrer");
        return answer(m, { result: {} });
      }
      if (m.method !== "tools/call") return; // ui/notifications/initialized needs nothing; anything else isn't offered
      const r: { result?: unknown; error?: { code?: number; message?: string } } = await api.viewCall(id!, String(m.params?.name ?? ""), m.params?.arguments).catch((err: Error) => {
        if (err instanceof SignInRequired) onSignIn();
        return { error: { code: -32000, message: err.message } };
      });
      // A settings change the tool proposed: shown on the bar below, saved only by the owner's click (/save checks it).
      const changes = (r.result as { structuredContent?: { _aidenhq?: { settings_change?: unknown } } } | undefined)?.structuredContent?._aidenhq?.settings_change;
      if (live && Array.isArray(changes) && changes.length) setProposal({ changes: changes as Proposal["changes"] }), setSaid("");
      if (live && loads.current <= 1) answer(m, r.error ? { error: { code: r.error.code ?? -32000, message: String(r.error.message ?? "failed") } } : { result: r.result });
    }
    window.addEventListener("message", onMessage);
    return () => (live = false, window.removeEventListener("message", onMessage));
  }, [id, sub, onSignIn, attempt]);

  useEffect(() => {
    if (blocking) return void (watched.current = blocking.identifier);
    const id = watched.current;
    if (!id) return;
    watched.current = "";
    const f = changes.find((c) => c.identifier === id);
    if (f?.stage === "applied") return setSaid(`${id} is live; the page starts over from it.`), setProposal(null), setAttempt((a) => a + 1);
    if (f) setSaid(`${id} was not applied (${f.stage})${f.detail ? `: ${f.detail}` : ""}.`);
  }, [blocking, changes]);

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
      <PageHeader title={page.title} sub={`From the ${page.module} module.`} />
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
    </Page>
  );
}
