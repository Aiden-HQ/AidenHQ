// The ship service's HTTP API. The board's Ship page (the `board` provider, with ship_api_token) and the config tools share the
// same validation (config-tool.ts); the page files a change as the owner through the board's own settings path, so a loosening
// is the owner's own save.
//   GET  /settings                          → { setting, read_at, problems, covered, paused, presets, defaults, repos }   the raw
//                                             setting, the effective settings of every listed repo, and the fingerprint a change builds on
//   POST /settings/preview { repo, change, read_at } → { change: { kind: "setting", key: "ship", value }, summary, loosens, owner }
//                                             the whole new value validated like ship_configure; `owner`: it loosens, so only the
//                                             owner files it. `repo` is owner/name or `defaults`; `change` a preset name, a map of
//                                             fields, or null (drop the entry)
//   POST /settings/validate { value }       → { errors, loosens }   a whole `ship` value (the advanced editor), against the current one
//   POST /validate { settings: { ship } }   → { ok, errors }   the module's validate hook, before the board saves the setting
//   GET  /status                            → { paused, covered, repos: [{ repo, handoff, approve, merge }], adoptions: { <status>: n }, metrics, open }
//   GET  /adoptions?repo=&status=           → { adoptions }   the adoption records (state.json)
//   GET  /metrics?repo=                     → { repos: [{ repo, adopted, merged, stalled, merges_per_adoption }] }   (rounds, cost and
//                                             time to merge arrive with the loop's flow facts)
//   GET  /v1/admitted?repo=&pr=&fork=&member=   → { admitted, why }   code review's module token only (admission before spend)
//   GET  /v1/generation?repo=&pr=           → { generation, status }  the github module's token only (its writes' generation check)
// Errors are { error, detail }.   GET /healthz
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { admitted } from "./admission.ts";
import { applyShipChange, stamp } from "./config-tool.ts";
import { effective, loosens, PRESETS, validate } from "./settings.ts";
import { status } from "./status.ts";
import type { State } from "./state.ts";

type Dict = Record<string, unknown>;
const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

async function body(req: IncomingMessage): Promise<Dict> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { n += (c as Buffer).length; if (n > 64_000) throw new Error("the body is too large"); chunks.push(c as Buffer); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch {}
  throw new Error("send a JSON object");
}

export function handler(d: {
  raw: () => Dict; covered: () => string[]; gated: () => string[] | undefined; state: State; token: () => string;
  /** Whether a bearer is the named module's token (undefined: the kernel couldn't say). */
  isModule: (authorization: string, module: string) => Promise<boolean | undefined>;
}) {
  const authorized = (req: IncomingMessage) => {
    const want = Buffer.from(d.token()), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
  };
  const module = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const ok = await d.isModule(String(req.headers.authorization ?? ""), name);
    if (!ok) send(res, ok === undefined ? 503 : 401, { error: "unauthorized", detail: ok === undefined ? "the kernel couldn't say whose token this is; try again" : `only the ${name} module's token` });
    return !!ok;
  };
  const view = () => {
    const raw = d.raw(), covered = d.covered();
    const repos = Object.fromEntries(Object.keys((raw.repos as Dict) ?? {}).map((r) => [r, effective(raw, r, covered)]));
    return { setting: raw, read_at: stamp(raw), problems: validate(raw, covered, d.gated()), covered, paused: raw.paused === true, presets: PRESETS, defaults: effective(raw, "*/*", ["*/*"]), repos };
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return send(res, 400, { error: "bad request" }); }
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    const q = url.searchParams;
    if (route === "GET /healthz") return send(res, 200, { ok: true });
    if (route === "GET /v1/admitted" || route === "GET /v1/generation") {
      if (!(await module(req, res, route === "GET /v1/admitted" ? "code-review" : "github"))) return;
      const repo = (q.get("repo") ?? "").toLowerCase(), pr = Number(q.get("pr"));
      if (!REPO.test(repo) || !Number.isInteger(pr) || pr < 1) return send(res, 400, { error: "bad_request", detail: "repo (owner/name) and pr" });
      if (route === "GET /v1/generation") { const a = d.state.get(repo, pr); return send(res, 200, { generation: a?.generation ?? null, status: a?.status ?? null }); }
      return send(res, 200, admitted(d.raw(), d.covered(), d.state, { repo, number: pr, fork: q.get("fork") === "1", member: q.get("member") === "1" }));
    }
    if (!authorized(req)) return send(res, 401, { error: "unauthorized", detail: "send the ship API token" });
    try {
      // The module's `validate` hook (the kernel posts the settings being saved).
      if (route === "POST /validate") {
        const b = await body(req);
        const v = (b.settings as Dict | undefined)?.ship;
        if (v === undefined) return send(res, 200, { ok: true });
        const errors = validate(v, d.covered(), d.gated());
        return send(res, 200, errors.length ? { ok: false, errors: errors.map((message) => ({ field: "ship", message })) } : { ok: true });
      }
      if (route === "GET /settings") return send(res, 200, view());
      if (route === "POST /settings/preview") {
        const b = await body(req);
        const r = applyShipChange(d.raw(), { repo: String(b.repo), change: b.change, readAt: String(b.read_at), covered: d.covered(), gated: d.gated() });
        return send(res, 200, { change: { kind: "setting", key: "ship", value: r.value }, summary: r.summary, loosens: r.loosens, owner: r.loosens.length > 0 });
      }
      if (route === "POST /settings/validate") {
        const b = await body(req);
        const errors = validate(b.value, d.covered(), d.gated());
        return send(res, 200, { errors, loosens: errors.length ? [] : loosens(d.raw(), b.value) });
      }
      if (route === "GET /status" || route === "GET /metrics") { const r = status(d.raw(), d.covered(), d.state, q.get("repo") ?? undefined); return send(res, 200, route === "GET /status" ? r : { repos: r.metrics }); }
      if (route === "GET /adoptions") return send(res, 200, { adoptions: d.state.all().filter((a) => (!q.get("repo") || a.repo.toLowerCase() === q.get("repo")!.toLowerCase()) && (!q.get("status") || a.status === q.get("status"))) });
      return send(res, 404, { error: "not_found" });
    } catch (e) {
      return send(res, 400, { error: "bad_request", detail: String((e as Error).message).slice(0, 500) });
    }
  };
}
