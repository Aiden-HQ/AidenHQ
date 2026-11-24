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

/** MCP Apps style variable -> the board token it reads (ui/tokens.css), resolved to a value on this page. */
const COLORS: Record<string, string> = {
  "--color-background-primary": "--surface",
  "--color-background-secondary": "--surface-2",
  "--color-background-tertiary": "--col",
  "--color-background-info": "--accent-soft",
  "--color-text-primary": "--text",
  "--color-text-secondary": "--muted",
  "--color-text-tertiary": "--faint",
  "--color-text-info": "--accent",
  "--color-text-danger": "--bad-text",
  "--color-text-success": "--ok-text",
  "--color-text-warning": "--warn-text",
  "--color-text-inverse": "--accent-text",
  "--color-border-primary": "--border",
  "--color-border-secondary": "--border-strong",
  "--color-ring-primary": "--accent",
};
const PLAIN: Record<string, string> = { "--font-sans": "--font", "--font-mono": "--mono", "--border-radius-sm": "--radius-sm", "--border-radius-md": "--radius-md", "--border-radius-lg": "--radius", "--font-text-sm-size": "--text-sm", "--font-text-md-size": "--text-body" };

/** The board's tokens as MCP Apps style variables, as this page resolves them now (light-dark() included). */
function styleVariables(): Record<string, string> {
  const probe = document.createElement("i");
  probe.style.display = "none";
  document.body.append(probe);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(COLORS)) {
    probe.style.color = `var(${v})`;
    out[k] = getComputedStyle(probe).color;
  }
  probe.remove();
  const root = getComputedStyle(document.documentElement);
  for (const [k, v] of Object.entries(PLAIN)) out[k] = root.getPropertyValue(v).trim();
  return out;
}
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const hostContext = () => ({ theme: dark() ? "dark" : "light", styles: { variables: styleVariables() }, displayMode: "inline", availableDisplayModes: ["inline"], platform: matchMedia("(max-width: 720px)").matches ? "mobile" : "web", locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

export function ModuleView({ page, onSignIn }: { page: PageRow | undefined; onSignIn: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState("");
  const id = page?.id;

  useEffect(() => {
    if (!id) return;
    let ready = false;
    const post = (m: object) => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...m }, "*");
    const answer = (req: Msg, body: { result: unknown } | { error: { code: number; message: string } }) => post({ id: req.id, ...body });
    async function onMessage(e: MessageEvent) {
      // Only the frame this page made, never another window or frame; its origin is "null" (opaque), so the source is the check.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as Msg;
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return;
      switch (m.method) {
        case "ui/initialize":
          return answer(m, { result: { protocolVersion: PROTOCOL, hostInfo: { name: "AidenHQ board", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: hostContext() } });
        case "ui/notifications/initialized":
          ready = true;
          return;
        case "ui/notifications/size-changed":
          if (typeof m.params?.height === "number") setHeight(Math.min(4000, Math.max(160, Math.ceil(m.params.height))));
          return;
        case "ping":
          return answer(m, { result: {} });
        case "tools/call": {
          const r: { result?: unknown; error?: { code?: number; message?: string } } = await api.viewCall(id!, String(m.params?.name ?? ""), m.params?.arguments).catch((err: Error) => {
            if (err instanceof SignInRequired) onSignIn();
            return { error: { code: -32000, message: err.message } };
          });
          const changes = (r.result as { structuredContent?: { _aidenhq?: { settings_change?: unknown } } } | undefined)?.structuredContent?._aidenhq?.settings_change;
          if (Array.isArray(changes) && changes.length) setProposal({ changes: changes as Proposal["changes"] }), setSaid("");
          return answer(m, r.error ? { error: { code: r.error.code ?? -32000, message: String(r.error.message ?? "failed") } } : { result: r.result });
        }
        default:
          if (m.id !== undefined) answer(m, { error: { code: -32601, message: `${m.method} isn't offered by this host` } });
      }
    }
    window.addEventListener("message", onMessage);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const themed = () => ready && post({ method: "ui/notifications/host-context-changed", params: { theme: dark() ? "dark" : "light", styles: { variables: styleVariables() } } });
    scheme.addEventListener("change", themed);
    return () => {
      window.removeEventListener("message", onMessage);
      scheme.removeEventListener("change", themed);
      if (ready) post({ id: "teardown", method: "ui/resource-teardown", params: { reason: "navigation" } });
    };
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
              <code key={c.key}>
                {c.key} = {JSON.stringify(c.value).slice(0, 300)}
              </code>
            ))}
          </div>
          <div className="mv-proposal-actions">
            <Button variant="quiet" onClick={() => setProposal(null)} disabled={saving}>Discard</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}
      {said && <p className="mv-said" role="status">{said}</p>}
      <iframe ref={frame} className="mv-frame" key={page.id} title={page.title} src={`/api/pages/${page.id}/frame`} sandbox="allow-scripts allow-forms" style={{ height }} />
    </Page>
  );
}
