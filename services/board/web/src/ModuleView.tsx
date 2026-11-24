// A module's Fleet page (board.pages): the module's own view (an MCP Apps resource) in a sandboxed frame, and this host's half of
// the MCP Apps bridge (modelcontextprotocol/ext-apps, 2026-01-26) over postMessage. The frame is an opaque origin with no network
// (the board serves it with a sandbox CSP), so everything it does goes through here: its tool calls go to the board's
// /api/pages/<page>/call (the kernel lets through only the tools its page declares), and a setting it proposes is saved only by
// the owner's own click on the bar below the frame. Docs: docs/design/board-ui.md "Modules".
import { useEffect, useRef, useState } from "react";
import { api, SignInRequired } from "./api";
import type { PageRow } from "./types";
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

export function ModuleView({ page, onSignIn }: { page: PageRow | undefined; onSignIn: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState("");
  // The frame's document: the bridge serves only the first one each attempt loads (a view that navigates itself is stopped),
  // and one that hasn't said ui/initialize a few seconds after loading failed (its module is down, or the view is broken).
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
    async function onMessage(e: MessageEvent) {
      // Only the frame this page made, never another window or frame; its origin is "null" (opaque), so the source is the check.
      if (!frame.current || e.source !== frame.current.contentWindow || loads.current > 1) return;
      const m = e.data as Msg;
      if (m?.jsonrpc !== "2.0") return;
      if (m.method === "ui/initialize") return (started.current = true), answer(m, { result: { protocolVersion: PROTOCOL, hostInfo: { name: "AidenHQ board", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: hostContext() } });
      if (m.method === "ui/notifications/size-changed" && typeof m.params?.height === "number") return setHeight(Math.min(4000, Math.max(160, Math.ceil(m.params.height))));
      if (m.method !== "tools/call") return; // ui/notifications/initialized needs nothing; anything else isn't offered
      const r: { result?: unknown; error?: { code?: number; message?: string } } = await api.viewCall(id!, String(m.params?.name ?? ""), m.params?.arguments).catch((err: Error) => {
        if (err instanceof SignInRequired) onSignIn();
        return { error: { code: -32000, message: err.message } };
      });
      // A settings change the tool proposed: shown on the bar below, saved only by the owner's click (/save checks it).
      const changes = (r.result as { structuredContent?: { _aidenhq?: { settings_change?: unknown } } } | undefined)?.structuredContent?._aidenhq?.settings_change;
      if (Array.isArray(changes) && changes.length) setProposal({ changes: changes as Proposal["changes"] }), setSaid("");
      if (loads.current <= 1) answer(m, r.error ? { error: { code: r.error.code ?? -32000, message: String(r.error.message ?? "failed") } } : { result: r.result });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id, onSignIn]);

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
      setProposal(null);
      setSaid(`Saved as ${r.identifier}: the change applies in a moment.`);
    } catch (e) {
      setSaid(`Not saved: ${(e as Error).message}`);
    } finally {
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
            {proposal.changes.map((c) => (
              <pre key={c.key}>
                {c.key} = {JSON.stringify(c.value, null, 2)}
              </pre>
            ))}
          </div>
          <div className="mv-proposal-actions">
            <Button variant="quiet" onClick={() => setProposal(null)} disabled={saving}>Discard</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
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
