import { useCallback, useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import type { FlowStage, FlowSummary, IdleItem, Waterfall } from "../../src/flow";
import { QUERIES, useQuery } from "./queries";
import { Banner, Dialog, EmptyState, Page, PageHeader, Section, Segmented, Select, StatBlock } from "./ui";
import { agoLabel } from "./util";
import "./flow.css";

// The Flow page (#/flow), "bottlenecks first" (docs/design/flow.md §6): where the period's time went per stage, the tiles
// (DORA, churn, first-pass, cost), and the items idle now. An idle item opens its waterfall; a stage opens the items behind its p75.
// A stage with fewer than five occurrences shows its count and raw durations, never a percentile.

/* ----------------------------------------------------------------------------- formatting */
/** Seconds as "40s", "12m", "1h 40m", "2d 3h". */
export function dur(s: number | null | undefined): string {
  if (s == null) return "—";
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  if (t < 86_400) return `${Math.floor(t / 3600)}h ${Math.round((t % 3600) / 60)}m`;
  return `${Math.floor(t / 86_400)}d ${Math.round((t % 86_400) / 3600)}h`;
}
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const words = (reason: string) => reason.replace(/_/g, " ");

/** The reason that held the most time at a stage, with its share of all its waiting; none when nothing waited. */
export function dominantWait(waits: Record<string, number>): { reason: string; share: number } | null {
  const all = Object.entries(waits);
  const total = all.reduce((a, [, v]) => a + v, 0);
  if (!total) return null;
  const [reason, v] = all.sort((a, b) => b[1] - a[1])[0]!;
  return { reason, share: v / total };
}

const PERIODS = [["7", "7d"], ["30", "30d"], ["90", "90d"]] as const;

/* ----------------------------------------------------------------------------- the page */
export function FlowView({ onSignIn }: { onSignIn: () => void }) {
  const [days, setDays] = useState<(typeof PERIODS)[number][0]>("7");
  const [scope, setScope] = useState("all");
  const [data, setData] = useState<{ summary: FlowSummary | null; idle: IdleItem[] } | null>(null);
  const [error, setError] = useState("");
  const [item, setItem] = useState<string | null>(null);
  const modules = useQuery(QUERIES.modules, onSignIn).data?.modules;

  const load = useCallback(async () => {
    try {
      setData(await api.flow(Number(days), scope));
      setError("");
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      else setError((e as Error).message);
    }
  }, [days, scope, onSignIn]);
  useEffect(() => {
    void load();
  }, [load]);

  const scopes: [string, string][] = [["all", "All"], ...(modules ?? []).filter((m) => m.state === "on" || m.state === "dependency").map((m): [string, string] => [m.name, m.name])];
  const s = data?.summary;
  const empty = !s || (s.stages.length === 0 && !s.dora && data.idle.length === 0);

  return (
    <Page className="flow-page" label="Flow">
      <PageHeader
        title="Flow"
        sub="Where the fleet's time goes: how long work spends in each stage, and what it waits on."
        actions={
          <div className="flow-controls">
            <Segmented label="Period" options={PERIODS} value={days} onChange={setDays} />
            {scopes.length > 1 && <Select aria-label="Scope" value={scope} options={scopes} onChange={setScope} />}
          </div>
        }
      />
      {error && <Banner tone="danger">Couldn't load Flow: {error}</Banner>}
      {!data ? (
        !error && <div className="flow-loading" aria-busy="true" />
      ) : empty ? (
        <FlowEmpty />
      ) : (
        <>
          <Section title="Where the time went" hint="Median per item; the line marks the p75">
            <StageBars stages={s.stages} onItem={setItem} />
          </Section>
          <Tiles s={s} />
          <Section title="Idle now" count={data.idle.length} hint="Oldest first">
            {data.idle.length === 0 ? <EmptyState>Nothing is waiting without a reason.</EmptyState> : <IdleList items={data.idle} onOpen={setItem} />}
          </Section>
        </>
      )}
      <ItemDialog id={item} onClose={() => setItem(null)} />
    </Page>
  );
}

/** Nothing recorded yet: Flow fills in as work happens. */
export function FlowEmpty() {
  return <EmptyState>Flow fills in as work happens.</EmptyState>;
}

/* ----------------------------------------------------------------------------- stages */
function StageBars({ stages, onItem }: { stages: FlowStage[]; onItem: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const total = (st: FlowStage, p: "p50" | "p75") => (st[`work_${p}`] ?? 0) + (st[`wait_${p}`] ?? 0);
  const scale = Math.max(1, ...stages.map((st) => (st.n >= 5 ? total(st, "p75") : 0)));
  return (
    <div className="flow-stages">
      {stages.map((st) => {
        const few = st.n < 5;
        const dom = dominantWait(st.waits);
        const work = st.work_p50 ?? 0;
        const wait = st.wait_p50 ?? 0;
        return (
          <div key={st.name} className="flow-stage">
            <button type="button" className="flow-stage-row" aria-expanded={open === st.name} onClick={() => setOpen(open === st.name ? null : st.name)}>
              <span className="flow-stage-name">{st.label}</span>
              {few ? (
                <span className="flow-stage-few">{st.n} {st.n === 1 ? "item" : "items"}: {st.samples?.length ? st.samples.map(dur).join(", ") : "no durations yet"}</span>
              ) : (
                <>
                  <span className="flow-bar" role="img" aria-label={`median ${dur(work + wait)}, p75 ${dur(total(st, "p75"))}`}>
                    <i className="work" style={{ width: `${(work / scale) * 100}%` }} />
                    <i className="wait" style={{ width: `${(wait / scale) * 100}%` }} />
                    <b style={{ left: `${(total(st, "p75") / scale) * 100}%` }} title={`p75 ${dur(total(st, "p75"))}`} />
                  </span>
                  <span className="flow-stage-value">{dur(work + wait)}</span>
                </>
              )}
              {dom && <span className="flow-stage-why">waiting: {words(dom.reason)} {pct(dom.share)}</span>}
            </button>
            {open === st.name && <StageItems stage={st} onItem={onItem} />}
          </div>
        );
      })}
    </div>
  );
}

/** The items behind a stage's p75 (the slowest occurrences), each opening its waterfall; raw durations for a stage too small for a percentile. */
function StageItems({ stage, onItem }: { stage: FlowStage; onItem: (id: string) => void }) {
  if (stage.n < 5) return <p className="flow-stage-detail">Fewer than five occurrences, so no percentiles: {stage.samples?.map(dur).join(", ") || "no durations yet"}.</p>;
  const slow = stage.slow ?? [];
  if (!slow.length) return <p className="flow-stage-detail">The kernel lists no items for this stage yet.</p>;
  return (
    <ul className="flow-slow" aria-label={`Slowest ${stage.label} items`}>
      {slow.map((x) => (
        <li key={x.task}>
          <button type="button" onClick={() => onItem(x.task)}>
            <span>{x.identifier ?? x.task}</span>
            <span className="flow-dim">{dur(x.seconds)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------------------- tiles and idle */
function Tiles({ s }: { s: FlowSummary }) {
  const { dora, churn, fleet } = s;
  const first = fleet.first_pass_grade ?? fleet.first_pass_review;
  return (
    <div className="flow-tiles" aria-label="Summary">
      {dora && (
        <>
          <StatBlock label="Deploys per day" value={dora.deploys_per_day.toFixed(1)} />
          <StatBlock label="Lead time p50" value={dur(dora.lead_p50)} />
          <StatBlock label="Failure rate" value={pct(dora.failure_rate)} />
          <StatBlock label="Time to restore" value={dur(dora.restore_p50)} />
        </>
      )}
      {churn && <StatBlock label="Churn, 30 days" value={pct(churn.rewritten_30d)} sub={`${churn.hot_lines} lines rewritten 3+ times`} />}
      <StatBlock label="First pass" value={pct(first)} sub="done without a retry" />
      <StatBlock label="$ per merged PR" value={usd(fleet.cost_per_outcome)} />
    </div>
  );
}

function IdleList({ items, onOpen }: { items: IdleItem[]; onOpen: (id: string) => void }) {
  return (
    <ul className="flow-idle">
      {items.map((i) => (
        <li key={i.task}>
          <button type="button" onClick={() => onOpen(i.task)}>
            <span className="flow-idle-id">{i.identifier}</span>
            <span className="flow-idle-since">{agoLabel(i.since).replace(" ago", "")}</span>
            <span className="flow-idle-why">{words(i.reason)}</span>
            <span className="flow-dim">{i.holder ?? ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------------------- waterfall */
function ItemDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [w, setW] = useState<{ id: string; data?: Waterfall; error?: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    api.flowItem(id).then((data) => live && setW({ id, data }), (e: Error) => live && setW({ id, error: e.message }));
    return () => {
      live = false;
    };
  }, [id]);
  const cur = w && w.id === id ? w : null;
  return (
    <Dialog open={!!id} onClose={onClose} title={cur?.data ? `Waterfall · ${cur.data.root}` : "Waterfall"} wide>
      {cur?.error ? <Banner tone="danger">{cur.error}</Banner> : cur?.data ? <WaterfallView w={cur.data} /> : <p className="flow-note">Loading…</p>}
    </Dialog>
  );
}

type Span = { key: string; kind: "stage" | "idle"; label: string; who: string; start: number; end: number | null; open: boolean };

export function WaterfallView({ w }: { w: Waterfall }) {
  const spans: Span[] = [
    ...w.stages.map((x, i): Span => ({ key: `s${i}`, kind: "stage", label: x.label, who: x.actor ?? "unknown", start: Date.parse(x.start), end: x.end ? Date.parse(x.end) : null, open: !x.end })),
    ...w.idle.map((x, i): Span => ({ key: `i${i}`, kind: "idle", label: `idle: ${x.blocked_on ? `blocked on ${x.blocked_on}` : words(x.reason)}`, who: x.holder ?? "", start: Date.parse(x.start), end: x.end ? Date.parse(x.end) : null, open: !x.end })),
  ].sort((a, b) => a.start - b.start);
  if (!spans.length) return <p className="flow-note">Nothing recorded for this item yet.</p>;
  const t0 = spans[0]!.start;
  const now = Date.now();
  const t1 = Math.max(...spans.map((x) => x.end ?? now), t0 + 1);
  return (
    <ol className="flow-fall" aria-label="Stages and idle gaps">
      {spans.map((x) => {
        const end = x.end ?? now;
        return (
          <li key={x.key} className={x.kind}>
            <span className="flow-fall-label">{x.label}{x.who && <span className="flow-dim"> · {x.who}</span>}</span>
            <span className="flow-fall-track" aria-hidden>
              <i style={{ left: `${((x.start - t0) / (t1 - t0)) * 100}%`, width: `${Math.max(0.8, ((end - x.start) / (t1 - t0)) * 100)}%` }} />
            </span>
            <span className="flow-fall-dur">{dur((end - x.start) / 1000)}{x.open && " so far"}</span>
          </li>
        );
      })}
    </ol>
  );
}

