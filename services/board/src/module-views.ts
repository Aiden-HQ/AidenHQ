// Module pages (board.pages, compiled into the points file): each a module view, an MCP Apps resource the module's own
// connection serves, shown in the Fleet sidebar (docs/design/board-ui.md "Modules"). The board reaches the module only through
// the kernel's view route (POST /v1/views/<module>/mcp, the board's key), which lets a view read its own resource and call the
// tools its page lists, as the owner. The frame is served from the board with its own sandbox CSP: an opaque origin with no
// network, no cookies and no navigation, so the module's HTML reaches nothing but its host's postMessage bridge.
import { existsSync, readFileSync } from "node:fs";

/** One compiled page (modules/board/schemas/pages.json) and its module. */
export interface SecretMap { secret: string; keys_from: string; fields: { name: string; label: string; kind: "text" | "password" | "totp" }[] }
export interface PagePoint { id: string; title: string; icon: string; order: number; module: string; connection: string; view: string; tools: string[]; settings?: string[]; secret_maps?: SecretMap[] }

/** Each setting's applied value: the compiled config (readSources) carries { value, set } per key. */
export const appliedValues = (settings: Record<string, { value: unknown }> | undefined): Record<string, unknown> => Object.fromEntries(Object.entries(settings ?? {}).map(([k, e]) => [k, e.value]));

/** A key the kernel's vault merge takes (kernel/src/module-secrets.ts MAP_KEY). */
export const MAP_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The keys a secret map may hold: `keys_from` ("ui_testing.apps[].name") read from the setting's applied value, valid keys only, in order, once each. */
export function mapKeys(keysFrom: string, settings: Record<string, unknown>): string[] {
  const [path, field] = keysFrom.split("[].") as [string, string];
  let v: unknown = settings;
  for (const k of path.split(".")) v = v && typeof v === "object" && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined;
  const out = (Array.isArray(v) ? v : []).flatMap((e) => (e && typeof e === "object" && typeof (e as Record<string, unknown>)[field] === "string" && MAP_KEY.test((e as Record<string, string>)[field]!) ? [(e as Record<string, string>)[field]!] : []));
  return [...new Set(out)];
}

export const VIEW_MIME = "text/html;profile=mcp-app";
/** How the frame route sends a module's view (never HTML of the board's own). */
export const FRAME_TYPE = "text/html; charset=utf-8";

/** The frame's own policy (it replaces the board's): inline script and style only, nothing loaded, nothing sent. */
export const FRAME_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** One compiled board read (modules/board/schemas/reads.json): a read tool the board calls for the owner's own view, by id. */
export interface ReadPoint { id: string; module: string; connection: string; tool: string }

export function readPoints(file: string): ReadPoint[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).reads ?? []) : [];
}

export function pagePoints(file: string): PagePoint[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).pages ?? []) : [];
}

/** Whether a page may propose a change to this setting: one only its own module declares, or one its declaration lists. */
export const mayPropose = (page: PagePoint, key: string, owners: string[]) => (page.settings ?? []).includes(key) || owners.join() === page.module;

export class ViewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A view's calls through the kernel. Without the kernel's key, every page says the view is unavailable. */
export function createViewHost({ kernel, pages, reads = () => [], fetchFn = fetch }: { kernel?: { url: string; token: string }; pages: () => PagePoint[]; reads?: () => ReadPoint[]; fetchFn?: typeof fetch }) {
  const page = (id: string) => pages().find((p) => p.id === id) ?? (() => { throw new ViewError(404, `no page ${id}`); })();
  async function send(p: { module: string; view: string }, method: "resources/read" | "tools/call", params: Record<string, unknown>): Promise<{ result?: any; error?: { code?: number; message?: string } }> {
    if (!kernel) throw new ViewError(503, "module views need the kernel");
    const res = await fetchFn(`${kernel.url.replace(/\/+$/, "")}/v1/views/${p.module}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${kernel.token}`, "content-type": "application/json" },
      body: JSON.stringify({ view: p.view, method, params }),
      // No deadline of the board's own: the kernel's call holds its connection's tool timeout and answers when it passes.
    }).catch((e: Error) => { throw new ViewError(502, `${p.module} didn't answer (${e.message})`); });
    const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } };
    if (!res.ok) throw new ViewError(res.status === 403 ? 403 : 502, String(data.error?.message ?? `${p.module} failed (${res.status})`).slice(0, 300));
    return data as never;
  }
  return {
    pages,
    page,
    /** The view's HTML, as its connection serves it (text or base64 blob, the MCP Apps mime type). */
    async html(id: string): Promise<string> {
      const p = page(id);
      const r = await send(p, "resources/read", { uri: p.view });
      const c = (r.result?.contents ?? []).find((x: { uri?: string }) => x?.uri === p.view);
      if (!c || String(c.mimeType ?? "").replace(/\s/g, "") !== VIEW_MIME) throw new ViewError(502, `${p.module} didn't serve ${p.view} as ${VIEW_MIME}`);
      return typeof c.text === "string" ? c.text : Buffer.from(String(c.blob ?? ""), "base64").toString("utf8");
    },
    /** One tools/call of the page's view: the module's JSON-RPC answer (`result` or `error`). */
    call: (id: string, name: string, args: unknown) => send(page(id), "tools/call", { name, arguments: args ?? {} }),
    reads,
    /** A declared board read (board.reads) by id: the parsed JSON of its tool's first text block. A JSON-RPC error or a tool
     * result with isError (a module's "Refused: …") is a 502, never data. */
    async read(id: string, args: Record<string, unknown>): Promise<unknown> {
      const r = reads().find((x) => x.id === id);
      if (!r) throw new ViewError(404, `no read ${id}`);
      const out = await send({ module: r.module, view: `read:${id}` }, "tools/call", { name: r.tool, arguments: args });
      const text = (out.result?.content ?? []).find((c: { type?: string }) => c?.type === "text")?.text;
      if (out.error || out.result?.isError) throw new ViewError(502, String(out.error?.message ?? text ?? `${r.module} refused ${r.tool}`).slice(0, 300));
      try {
        return JSON.parse(String(text));
      } catch {
        throw new ViewError(502, `${r.module} ${r.tool} answered no JSON`);
      }
    },
  };
}
export type ViewHost = ReturnType<typeof createViewHost>;
