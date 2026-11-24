// Module pages (board.pages, compiled into the points file): each a module view, an MCP Apps resource the module's own
// connection serves, shown in the Fleet sidebar (docs/design/board-ui.md "Modules"). The board reaches the module only through
// the kernel's view route (POST /v1/views/<module>/mcp, the board's key), which lets a view read its own resource and call the
// tools its page lists, as the owner. The frame is served from the board with its own sandbox CSP: an opaque origin with no
// network, no cookies and no navigation, so the module's HTML reaches nothing but its host's postMessage bridge.
import { existsSync, readFileSync } from "node:fs";

/** One compiled page (modules/board/schemas/pages.json) and its module. */
export interface PagePoint { id: string; title: string; icon: string; order: number; module: string; connection: string; view: string; tools: string[] }

export const VIEW_MIME = "text/html;profile=mcp-app";

/** The frame's own policy (it replaces the board's): inline script and style only, nothing loaded, nothing sent. */
export const FRAME_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function pagePoints(file: string): PagePoint[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).pages ?? []) : [];
}

export class ViewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A view's calls through the kernel. Without the kernel's key, every page says the view is unavailable. */
export function createViewHost({ kernel, pages, fetchFn = fetch }: { kernel?: { url: string; token: string }; pages: () => PagePoint[]; fetchFn?: typeof fetch }) {
  const page = (id: string) => pages().find((p) => p.id === id) ?? (() => { throw new ViewError(404, `no page ${id}`); })();
  async function send(p: PagePoint, method: "resources/read" | "tools/call", params: Record<string, unknown>): Promise<{ result?: any; error?: { code?: number; message?: string } }> {
    if (!kernel) throw new ViewError(503, "module views need the kernel");
    const res = await fetchFn(`${kernel.url.replace(/\/+$/, "")}/v1/views/${p.module}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${kernel.token}`, "content-type": "application/json" },
      body: JSON.stringify({ view: p.view, method, params }),
      signal: AbortSignal.timeout(65_000),
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
  };
}
export type ViewHost = ReturnType<typeof createViewHost>;
