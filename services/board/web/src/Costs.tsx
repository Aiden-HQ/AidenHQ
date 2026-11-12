import { useCallback, useEffect, useRef, useState } from "react";
import { SignInRequired, api } from "./api";
import type { CostRow, CostWindow, Costs } from "./types";

const WINDOWS: [CostWindow, string][] = [["today", "Today (UTC)"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"]];
type SortKey = "name" | "runs" | "perRun" | "input" | "cached" | "output" | "usd";
const COLS: [SortKey, string, string][] = [
  ["name", "Agent or component", "c-name"],
  ["runs", "Runs", "c-runs"],
  ["input", "Input", "c-tok"],
  ["cached", "Cached", "c-tok"],
  ["output", "Output", "c-tok"],
  ["perRun", "$ / run", "c-per"],
  ["usd", "$", "c-usd"],
];

const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n: number | null | undefined) => (n == null ? "—" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(n >= 100 ? 0 : 2)}`);
/** Per run: small numbers keep two significant digits ($0.00064), so cheap high-frequency agents can be compared. */
const usdRun = (n: number | null) => (n == null ? "—" : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toPrecision(2)}` : "$0");
const short = (model: string) => model.replace(/^openrouter\//, "").split("/").pop()!.replace(/^~/, "");
const perRun = (r: CostRow) => (r.usd != null && r.runs ? r.usd / r.runs : null);
const value = (r: CostRow, k: SortKey) => (k === "name" ? r.name.toLowerCase() : k === "perRun" ? (perRun(r) ?? -1) : k === "usd" ? (r.usd ?? -1) : r[k]);

/** What each agent and system component spent on models: OpenRouter's billed cost where we see it, calibrated estimates elsewhere. */
export function CostsView({ onSignIn }: { onSignIn: () => void }) {
  const [win, setWin] = useState<CostWindow>("7d");
  const [data, setData] = useState<Costs | null>(null);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "usd", desc: true });

  const [loading, setLoading] = useState(false);
  // The parent re-renders every few seconds with a new onSignIn: held in a ref so it never re-triggers a load.
  const signIn = useRef(onSignIn);
  signIn.current = onSignIn;
  const latest = useRef(0);

  // Loads on open, on a window change and on Refresh only; what's on screen stays until the new figures arrive.
  const load = useCallback(async () => {
    const n = ++latest.current;
    setLoading(true);
    try {
      const d = await api.costs(win);
      if (n === latest.current) (setData(d), setError(""));
    } catch (e) {
      if (n !== latest.current) return;
      if (e instanceof SignInRequired) signIn.current();
      else setError((e as Error).message);
    } finally {
      if (n === latest.current) setLoading(false);
    }
  }, [win]);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = [...(data?.rows ?? [])].sort((a, b) => {
    const x = value(a, sort.key), y = value(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
  });
  const total = data?.total;
  const share = (r: CostRow) => (r.usd != null && total?.usd ? `${Math.round((r.usd / total.usd) * 100)}%` : "—");
  const onSort = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }));
  const gap = data?.check.real != null ? data.check.real - data.check.itemised : null;

  return (
    <main className="page wide">
      <header className="page-head">
        <div>
          <h1>Costs</h1>
          <p className="page-sub">{!data ? "Loading…" : `${usd(total!.usd)} (${usd(total!.billed)} billed, the rest estimated) · ${tokens(total!.input + total!.cached + total!.output)} tokens · ${total!.runs} runs`}</p>
        </div>
        <div className="seg-tabs" role="tablist" aria-label="Window">
          {WINDOWS.map(([w, label]) => (
            <button key={w} role="tab" aria-selected={win === w} className={win === w ? "on" : ""} onClick={() => setWin(w)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {error && <div className="offline">Couldn't load costs: {error}</div>}
      {data && !data.pricesAvailable && <div className="offline">OpenRouter's price list is unreachable: tokens only, no dollars.</div>}
      {!data ? (
        !error && <span className="spinner" />
      ) : (
        <>
          <section className="cost-table" role="table" aria-label="Costs by agent and component" aria-busy={loading} style={data.window !== win ? { opacity: 0.55 } : undefined}>
            <div className="cost-row cost-head" role="row">
              {COLS.map(([k, label, cls]) => (
                <button key={k} role="columnheader" className={`${cls}${sort.key === k ? " sorted" : ""}`} aria-sort={sort.key === k ? (sort.desc ? "descending" : "ascending") : "none"} onClick={() => onSort(k)}>
                  {label}
                  {sort.key === k && <span aria-hidden>{sort.desc ? " ↓" : " ↑"}</span>}
                </button>
              ))}
              <button role="columnheader" className={`c-share${sort.key === "usd" ? " sorted" : ""}`} onClick={() => onSort("usd")}>
                Share
              </button>
            </div>
            {!rows.length && <p className="cost-empty">No model usage in this window.</p>}
            {rows.map((r) => (
              <div key={`${r.kind}:${r.name}`} className="cost-row" role="row">
                <div className="c-name" role="cell">
                  <div className="cost-who">
                    <span className="cost-name">{r.name}</span>
                    {r.kind === "system" && <span className="pill">System</span>}
                  </div>
                  <div className="cost-models" title={r.models.map((m) => m.model).join(", ")}>
                    {r.models.map((m) => short(m.model)).join(", ")}
                    <span className="cost-sub">
                      {" · "}
                      {tokens(r.input)} in · {tokens(r.cached)} cached · {tokens(r.output)} out
                      {perRun(r) != null && ` · ${usdRun(perRun(r))}/run`}
                    </span>
                  </div>
                </div>
                <div className="c-runs" role="cell">{r.runs || "—"}</div>
                <div className="c-tok" role="cell">{tokens(r.input)}</div>
                <div className="c-tok" role="cell">{tokens(r.cached)}</div>
                <div className="c-tok" role="cell">{tokens(r.output)}</div>
                <div className="c-per" role="cell">{usdRun(perRun(r))}</div>
                <div className="c-usd" role="cell" title={r.reported ? "As OpenRouter billed it" : r.partial ? "Some models have no list price; this covers the rest" : "Estimated: tokens × list price × the model's billed/list ratio (billed calls included as billed)"}>
                  {usd(r.usd)}
                  {r.partial && r.usd != null ? "+" : ""}
                  {r.usd != null && <span className="cost-tag">{r.reported ? "billed" : "est."}</span>}
                </div>
                <div className="c-share" role="cell">{share(r)}</div>
              </div>
            ))}
            {total && rows.length > 0 && (
              <div className="cost-row cost-total" role="row">
                <div className="c-name" role="cell">
                  <span className="cost-name">Total</span>
                  <div className="cost-models">
                    <span className="cost-sub">
                      {tokens(total.input)} in · {tokens(total.cached)} cached · {tokens(total.output)} out
                    </span>
                  </div>
                </div>
                <div className="c-runs" role="cell">{total.runs}</div>
                <div className="c-tok" role="cell">{tokens(total.input)}</div>
                <div className="c-tok" role="cell">{tokens(total.cached)}</div>
                <div className="c-tok" role="cell">{tokens(total.output)}</div>
                <div className="c-per" role="cell" />
                <div className="c-usd" role="cell">{usd(total.usd)}</div>
                <div className="c-share" role="cell">100%</div>
              </div>
            )}
          </section>

          <section className="cost-check" style={data.window !== win ? { opacity: 0.55 } : undefined}>
            <h2>Against OpenRouter, {data.check.period}</h2>
            {data.check.real == null ? (
              <p className="muted">
                Itemised here: {usd(data.check.itemised)}. OpenRouter's own total isn't available{data.check.error ? `: ${data.check.error}` : ""}.
              </p>
            ) : (
              <dl className="cost-facts">
                <dt>OpenRouter charged</dt>
                <dd>{usd(data.check.real)}</dd>
                <dt>Itemised here</dt>
                <dd>{usd(data.check.itemised)}</dd>
                <dt>Not itemised</dt>
                <dd>
                  {gap == null ? "—" : gap < 0 ? `−${usd(-gap)} (the estimates run above what OpenRouter charged)` : usd(gap)}
                  {gap != null && gap >= 0 && data.check.real > 0 && <span className="muted"> ({Math.round((gap / data.check.real) * 100)}%)</span>}
                </dd>
              </dl>
            )}
            <p className="cost-note">
              Billed: what OpenRouter charged for each call, for agents in their own computers (through the gateway), Engineer jobs and the AI reviewer. Estimated: agents in Paperclip's own container, whose calls go to OpenRouter directly;
              their dollars are Paperclip's tokens (a resumed session's repeated count taken off) × the list price of the model OpenRouter routed to × what billed calls of the same model
              (Engineer jobs aside) cost against that list price over the last 7 days
              {Object.keys(data.ratios).length ? ` (${Object.entries(data.ratios).map(([m, x]) => `${short(m)} ×${x.toFixed(2)}`).join(", ")})` : ""}. Today and yesterday are UTC days, to match OpenRouter's daily bars. Not
              itemised: Docs and Confluence summaries, the runner's task intake, CI code reviews if they use this key, Paperclip runs that failed before reporting tokens, and other
              companies on the same key.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
