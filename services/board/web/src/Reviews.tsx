import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInRequired, api, type ReviewsSetup } from "./api";
import { IN_FLIGHT } from "./settings-ui";
import type { FiledChange } from "./types";
import { LENSES, MAX_COMBOS, REPO_DEFAULTS, comboLabel, type CatalogOption, type CodeReview, type Combo, type EngineCatalog, type Finding, type FindingRow, type Gate, type Outcome, type RepoConfig, type ReposView, type Review, type ReviewInsights, type Run, type RunStatus, type Severity, type TreeBatch, type Verdict } from "../../src/reviews";
import { Banner, Button, Card, Dialog, EmptyState, Facts, Field, Input, LinkButton, Page, PageHeader, Section, Segmented, Select, StatBlock, StatusDot, Switch, Tabs, Tag, Tags, Tile, TileGrid, hueClass, type StatusTone } from "./ui";
import { agoLabel, elapsed } from "./util";
import { Markdown } from "./markdown";
import "./reviews.css";

// The Reviews page (#/reviews/<tab>, #/reviews/r/<run>; docs/design/code-review.md, "Setting it up and using it"): the
// code-review module's runs, watched repos and insights. The module runs and posts every review; this page reads
// its state, starts one-off runs, and saves settings.code_review as a settings change (the owner's save is his
// approval; the kernel writes and applies it, and the page follows it until it is live). PR titles and every finding's text are the PR author's or a model's words: shown as plain text, never as links.

const TABS = [["reviews", "Reviews"], ["repos", "Repos"], ["insights", "Insights"]] as const;
type Tab = (typeof TABS)[number][0];
type Route = { tab: Tab } | { run: string } | { batch: string } | { create: true };
const routeOf = (): Route => {
  const h = location.hash.replace(/^#\/?/, "");
  const run = /^reviews\/r\/([\w-]{1,80})$/.exec(h)?.[1];
  if (run) return { run };
  if (h === "reviews/new") return { create: true };
  const batch = /^reviews\/b\/([\w-]{1,80})$/.exec(h)?.[1];
  if (batch) return { batch };
  const t = /^reviews\/([a-z]+)/.exec(h)?.[1];
  return { tab: TABS.some(([k]) => k === t) ? (t as Tab) : "reviews" };
};

const SEVERITIES: [Severity, string][] = [["important", "Important"], ["nit", "Nit"], ["pre_existing", "Pre-existing"]];
/** A skip's reason ("draft: …", the service's words after the colon) in the page's words. */
const SKIPS: Record<string, string> = { draft: "Draft PR", fork: "Fork PR, waiting for someone with write access to ask", closed: "PR closed", stopped: "Reviews stopped on this PR", superseded: "A newer push replaced it" };
const skipWords = (why: string | null) => {
  if (!why) return "Skipped";
  const key = why.split(":")[0]!.trim().toLowerCase();
  return SKIPS[key] ?? why.replace(/^./, (c) => c.toUpperCase());
};
/** When a run happened: its start, or for a skip (which never starts) its end. */
const when = (r: Run) => r.started ?? r.ended ?? new Date().toISOString();
const usd = (n: number | null | undefined, digits = 2) => (n == null ? "—" : `$${n.toFixed(digits)}`);
const short = (sha: string) => sha.slice(0, 7);
const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
/** A link the service gave, only when it points at GitHub. */
const githubLink = (u?: string | null) => (u && /^https:\/\/github\.com\//.test(u) ? u : undefined);
const STATUS: Record<Run["status"], [StatusTone, string]> = { queued: ["idle", "Queued"], running: ["busy", "Reviewing"], done: ["done", "Reviewed"], skipped: ["idle", "Skipped"], failed: ["failed", "Failed"] };
const live = (r: { status: RunStatus }) => r.status === "queued" || r.status === "running";
const OUTCOMES: Record<Outcome, [string, "ok" | "needs" | "neutral"]> = { fixed: ["Fixed", "ok"], dismissed: ["Dismissed", "neutral"], open_at_merge: ["Open at merge", "needs"], open_at_close: ["Open at close", "neutral"] };
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const took = (r: Run) => (r.duration_ms != null ? (r.duration_ms >= 60_000 ? `${Math.floor(r.duration_ms / 60_000)}m ${Math.round((r.duration_ms % 60_000) / 1000)}s` : `${Math.max(1, Math.round(r.duration_ms / 1000))}s`) : r.started && r.ended ? elapsed(r.started, Date.parse(r.ended)) : null);
/** The combos a review of this repo asks for by default: its on_open ones, else the defaults. */
const defaultCombos = (config: CodeReview | null, repo: string): Combo[] => config?.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.on_open.length ? config!.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())!.on_open : REPO_DEFAULTS.on_open;

/* ----------------------------------------------------------------------------- small parts */
/** A run's findings by severity: three marks, a zero one faint. */
function Severities({ v, compact }: { v: { important: number; nit: number; pre_existing: number }; compact?: boolean }) {
  return (
    <span className="rv-sev" aria-label={SEVERITIES.map(([k, n]) => `${v[k]} ${n.toLowerCase()}`).join(", ")}>
      {SEVERITIES.map(([k, name]) => (
        <span key={k} className={`rv-sev-mark rv-${k}${v[k] ? "" : " zero"}`} title={`${v[k]} ${name.toLowerCase()}`}>
          <i aria-hidden />
          {v[k]}
          {!compact && <span className="rv-sev-word"> {name.toLowerCase()}</span>}
        </span>
      ))}
    </span>
  );
}

/** Which engine, model and effort a run came from. */
const ComboTag = ({ c, engines }: { c: Pick<Combo, "engine" | "model" | "effort">; engines: EngineCatalog | null }) => (
  <span className={`rv-reviewer ${hueClass(c.engine)}`} title={`${c.engine} · ${c.model} · ${c.effort}`}>
    <i aria-hidden />
    {comboLabel(c, engines ?? undefined)}
  </span>
);

const MODEL_ID = /^~?[\w.-]+\/[\w.:~-]+$/;
const CUSTOM = "__custom";
/** One moment's (or one ask's) combos: a row each of engine, model and effort, up to MAX_COMBOS. */
/** `gates`: each row has a Mandatory switch (its review gates the repo's merges); a one-off has none. */
function ComboPicker({ label, value, onChange, engines, none, gates, single, noEngine }: { label: string; value: Combo[]; onChange: (v: Combo[]) => void; engines: EngineCatalog; none?: string; gates?: boolean; single?: boolean; noEngine?: boolean }) {
  const set = (i: number, c: Combo) => onChange(value.map((x, j) => (j === i ? c : x)));
  const fresh = (): Combo => ({ engine: "codex", model: engines.codex.models[0]!, effort: "medium" });
  return (
    <div className="rv-combos" role="group" aria-label={label}>
      {!value.length && <span className="rv-muted rv-combo-none">{none ?? "None"}</span>}
      {value.map((c, i) => {
        const e = engines[c.engine];
        const custom = !e.models.includes(c.model);
        return (
          <div key={i} className="rv-combo">
            {!noEngine && <Select aria-label={`${label} ${i + 1} engine`} value={c.engine} options={(Object.keys(engines) as (keyof EngineCatalog)[]).map((k) => [k, engines[k].label] as const)} onChange={(k) => set(i, { engine: k, model: engines[k].models[0]!, effort: engines[k].efforts.includes(c.effort) ? c.effort : "medium", ...(c.mandatory ? { mandatory: true } : {}) })} />}
            <span className="rv-combo-model">
              <Select aria-label={`${label} ${i + 1} model`} value={custom ? CUSTOM : c.model} options={[...e.models.map((m) => [m, m.replace(/^~/, "")] as const), [CUSTOM, "Other model…"] as const]} onChange={(m) => set(i, { ...c, model: m === CUSTOM ? "" : m })} />
              {custom && <Input aria-label={`${label} ${i + 1} model id`} aria-invalid={!MODEL_ID.test(c.model)} placeholder="vendor/model, like z-ai/glm-5.3" value={c.model} autoFocus={!c.model} onChange={(ev) => set(i, { ...c, model: ev.target.value.trim() })} />}
            </span>
            <Select aria-label={`${label} ${i + 1} effort`} value={c.effort} options={e.efforts.map((x) => [x, x] as const)} onChange={(x) => set(i, { ...c, effort: x })} />
            {gates && (
              <span className="rv-combo-gate" title="Its review gates merges: a PR merges only once it reviewed the head and its important findings are resolved">
                <Switch on={!!c.mandatory} label={`${label} ${i + 1} mandatory`} onChange={(on) => { const { mandatory: _m, ...rest } = c; set(i, on ? { ...rest, mandatory: true } : rest); }} />
                Mandatory
              </span>
            )}
            {!single && <Button size="sm" variant="quiet" aria-label={`Remove ${label} ${i + 1}`} title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</Button>}
          </div>
        );
      })}
      {!single && value.length < MAX_COMBOS && <Button size="sm" className="rv-combo-add" onClick={() => onChange([...value, fresh()])}>Add</Button>}
    </div>
  );
}
const combosOk = (v: Combo[]) => v.every((c) => MODEL_ID.test(c.model));

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Saves settings.code_review as one settings change. */
type Save = (value: CodeReview, what: string) => Promise<void>;

/* ----------------------------------------------------------------------------- the page */
let mounted = 0;

export function ReviewsView({ onSignIn }: { onSignIn: () => void }) {
  const [route, setRoute] = useState<Route>(routeOf);
  const [setup, setSetup] = useState<ReviewsSetup | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [batches, setBatches] = useState<TreeBatch[]>([]);
  const [repos, setRepos] = useState<ReposView | null>(null);
  const [engines, setEngines] = useState<EngineCatalog | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ identifier: string; what: string } | null>(null);
  /** The change saved here, else the newest one to settings.code_review (the board's settings changes): under way, live, or why not. */
  const [filed, setFiled] = useState<FiledChange | null>(null);
  const savedId = useRef("");
  const [dialog, setDialog] = useState<null | { kind: "oneoff"; url?: string } | { kind: "repo"; repo?: RepoConfig }>(null);

  useEffect(() => {
    const on = () => location.hash.startsWith("#/reviews") && setRoute(routeOf());
    window.addEventListener("hashchange", on);
    mounted++;
    return () => {
      window.removeEventListener("hashchange", on);
      mounted--;
      // The top tabs switch without touching the hash (as Flow): leaving Reviews drops its link. Deferred for StrictMode's remount.
      setTimeout(() => !mounted && location.hash.startsWith("#/reviews") && history.replaceState(null, "", "#/"));
    };
  }, []);

  const fail = useCallback((e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)), [onSignIn]);
  const loadSetup = useCallback(() => api.reviewsSetup().then(setSetup, fail), [fail]);
  const loadRuns = useCallback(() => api.reviews({ limit: 200 }).then((r) => (setRuns(r.runs), setBatches(r.batches ?? [])), fail), [fail]);
  const loadRepos = useCallback(() => api.reviewRepos().then(setRepos, fail), [fail]);
  const loadEngines = useCallback(() => api.reviewEngines().then((r) => setEngines(r.engines), fail), [fail]);
  const loadFiled = useCallback(() => api.settingsChanges().then((r) => setFiled(r.changes.find((c) => c.identifier === savedId.current) ?? r.changes.find((c) => c.items.some((i) => i.kind === "setting" && i.key === "code_review")) ?? null), () => {}), []);
  useEffect(() => void loadSetup(), [loadSetup]);
  useEffect(() => void loadFiled(), [loadFiled]);
  // A change under way: followed until it is live (then the setting is read again) or stops.
  const applying = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const wasApplying = useRef(applying);
  useEffect(() => {
    if (wasApplying.current && !applying) void loadSetup();
    wasApplying.current = applying;
    if (!applying) return;
    const t = setInterval(() => void loadFiled(), 5_000);
    return () => clearInterval(t);
  }, [applying, loadFiled, loadSetup]);
  const ready = Boolean(setup?.module && setup.github.connected);
  useEffect(() => {
    if (!ready) return;
    void loadRuns();
    void loadRepos();
    void loadEngines();
  }, [ready, loadRuns, loadRepos, loadEngines]);
  // A run under way: the list follows it.
  const anyLive = (runs?.some(live) ?? false) || batches.some(live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void loadRuns(), 8_000);
    return () => clearInterval(t);
  }, [anyLive, loadRuns]);

  const config = setup?.config ?? null;
  /** The owner's edit of settings.code_review, filed as a settings change; the page shows it until it applies. */
  const save: Save = useCallback(
    async (value, what) => {
      const r = await api.reviewConfig({ value });
      savedId.current = r.identifier;
      setSaved({ identifier: r.identifier, what });
      setDialog(null);
      void loadFiled();
    },
    [loadFiled],
  );
  const spent = repos?.day_spent_usd ?? 0;
  const tab = "tab" in route ? route.tab : "reviews";

  if ("create" in route) {
    if (engines) return <RepoReviewPage config={config} engines={engines} />;
    const retry = () => { setError(""); void loadSetup(); if (ready) { void loadRuns(); void loadRepos(); void loadEngines(); } };
    return (
      <Page className="rv-page" label="New repo review">
        <PageHeader crumb={<a href="#/reviews/reviews">Code review</a>} title="New repo review" />
        {error ? (
          <Banner tone="danger">Couldn't load what a repo review needs: {error} <Button onClick={retry}>Retry</Button></Banner>
        ) : setup && !ready ? (
          <EmptyState action={<LinkButton variant="primary" href={setup.module ? "#/settings/connections?connect=github" : "#/modules/code-review"}>{setup.module ? "Connect GitHub" : "Open the Code review module"}</LinkButton>}>
            {setup.module ? "Connect GitHub to review a repo." : "Code review is off on this instance. Turn on the Code review module to review a repo."}
          </EmptyState>
        ) : (
          <div className="rv-loading" aria-busy="true" />
        )}
      </Page>
    );
  }
  if ("batch" in route) return <BatchPage id={route.batch} batch={batches.find((b) => b.id === route.batch)} onSignIn={onSignIn} reload={loadRuns} />;
  if ("run" in route) return <RunPage id={route.run} config={config} engines={engines} onSignIn={onSignIn} />;

  const header = (
    <PageHeader
      title="Code review"
      sub="Reviews on your pull requests, posted to GitHub as comments. Advice only: nothing blocks a merge."
      actions={
        ready && config ? (
          <>
            <span className="rv-spend" title="Today's review spend across repos (UTC)">
              {usd(spent)} <span className="rv-spend-of">today</span>
            </span>
            <Button onClick={() => (location.hash = "#/reviews/new")}>Review a repo</Button>
            <Button variant="primary" onClick={() => setDialog({ kind: "oneoff" })}>Review a PR</Button>
          </>
        ) : undefined
      }
    />
  );

  return (
    <Page className="rv-page" label="Code review">
      {header}
      {error && <Banner tone="danger">Couldn't load reviews: {error}</Banner>}
      {(saved || (filed && (applying || filed.stage === "failed"))) && (
        <Banner tone={filed?.stage === "failed" || filed?.stage === "rejected" ? "danger" : "info"}>
          {saved ? `Saved: ${saved.what}. ` : ""}
          {!filed || (saved && filed.identifier !== saved.identifier) || applying ? "Applying now, usually within a few minutes." : filed.stage === "applied" ? "Live." : filed.stage === "failed" ? `The change didn't apply, so nothing changed${filed.detail ? `: ${filed.detail}` : "."}` : "The change was not applied."}
        </Banner>
      )}
      {repos?.errors?.length ? <Banner tone="warn">Code review skips part of its setting: {repos.errors.slice(0, 3).join("; ")}. Fix it from Repos.</Banner> : null}
      {setup?.problems.length ? <Banner tone="warn">settings.code_review in instance.yaml has a problem: {setup.problems.join("; ")}. Saving here replaces it with a valid value.</Banner> : null}
      {!setup ? (
        !error && <div className="rv-loading" aria-busy="true" />
      ) : !setup.module ? (
        <EmptyState action={<LinkButton variant="primary" href="#/modules/code-review">Open the Code review module</LinkButton>}>
          Code review is off on this instance. Turn on the Code review module to get a review on every pull request. Nothing runs or spends until you pick a repo.
        </EmptyState>
      ) : ready && runs === null ? (
        !error && <div className="rv-loading" aria-busy="true" />
      ) : !ready || (!config?.repos.length && !runs?.length && !batches.length) ? (
        <Start setup={setup} onWatch={() => setDialog({ kind: "repo" })} onOneOff={(url) => setDialog({ kind: "oneoff", url })} />
      ) : (
        <>
          <div>
            <Tabs label="Reviews views" tabs={TABS} value={tab} href={(t) => `#/reviews/${t}`} />
          </div>
          {tab === "reviews" && <RunsTab runs={runs} batches={batches} engines={engines} onOneOff={() => setDialog({ kind: "oneoff" })} />}
          {tab === "repos" && config && <ReposTab config={config} repos={repos} engines={engines} onEdit={(repo) => setDialog({ kind: "repo", repo })} onWatch={() => setDialog({ kind: "repo" })} />}
          {tab === "insights" && <InsightsTab onSignIn={onSignIn} />}
        </>
      )}

      {dialog?.kind === "oneoff" && engines && <OneOffDialog config={config} engines={engines} url={dialog.url} onClose={() => setDialog(null)} />}
      {dialog?.kind === "repo" && config && engines && <RepoDialog config={config} engines={engines} edit={dialog.repo} onClose={() => setDialog(null)} onSave={save} />}
    </Page>
  );
}

/* ----------------------------------------------------------------------------- first run */
function Start({ setup, onWatch, onOneOff }: { setup: ReviewsSetup; onWatch: () => void; onOneOff: (url: string) => void }) {
  const connected = setup.github.connected;
  const [url, setUrl] = useState("");
  return (
    <section className="rv-start" aria-label="Set up code review">
      <div className="rv-start-lead">
        <h2>Get a review on every pull request.</h2>
        <p>Pick a repo to watch, or paste a PR link for a one-off review. Each review posts inline comments marked by severity, and a summary with what was covered and what it cost.</p>
        <span className="rv-sev rv-legend">
          {SEVERITIES.map(([k, name]) => (
            <span key={k} className={`rv-sev-mark rv-${k}`}>
              <i aria-hidden />
              {name}
            </span>
          ))}
        </span>
      </div>
      <figure className="rv-sample" aria-label="An example finding">
        <article className="rv-finding rv-important">
          <header className="rv-finding-head">
            <h3>A retried charge can post twice to the ledger</h3>
            <span className="rv-where rv-mono">src/billing/charge.ts:88</span>
          </header>
          <p className="rv-prose">The idempotency key is written after the provider call returns, so a crash in between charges again on retry.</p>
        </article>
        <figcaption>An example of what lands on the PR, next to the line it is about.</figcaption>
      </figure>
      <ol className="rv-steps">
        <li className={connected ? "done" : "now"}>
          <span className="rv-step-mark">{connected ? <Check /> : "1"}</span>
          <div className="rv-step-body">
            <b>{connected ? "GitHub is connected" : "Connect GitHub"}</b>
            <span>{connected ? "Reviews post as you, labelled as AidenHQ." : "Sign in with a code at github.com. Reviews read PRs and post comments through it."}</span>
          </div>
          {!connected && <LinkButton variant="primary" href="#/settings/connections?connect=github">Connect GitHub</LinkButton>}
        </li>
        <li className={connected ? "now" : "later"}>
          <span className="rv-step-mark">2</span>
          <div className="rv-step-body">
            <b>Watch a repo</b>
            <span>A review when a PR opens and a lighter one on each push, by the engines and models you pick.</span>
          </div>
          <Button variant={connected ? "primary" : "default"} disabled={!connected} onClick={onWatch}>Watch a repo</Button>
        </li>
      </ol>
      <form
        className="rv-start-oneoff"
        onSubmit={(e) => {
          e.preventDefault();
          onOneOff(url.trim());
        }}
      >
        <label htmlFor="rv-start-url">Or review one PR now</label>
        <div className="rv-inline">
          <Input id="rv-start-url" placeholder="https://github.com/acme/payments/pull/42" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!connected} inputMode="url" />
          <Button type="submit" disabled={!connected || !url.trim()}>Review</Button>
        </div>
      </form>
      <p className="rv-start-ask">You can also ask Aiden in chat: “watch acme/payments, and review each new PR with two models”.</p>
    </section>
  );
}

/* ----------------------------------------------------------------------------- Reviews tab */
type Filter = "all" | "important" | "skipped";
function RunsTab({ runs, batches, engines, onOneOff }: { runs: Run[] | null; batches: TreeBatch[]; engines: EngineCatalog | null; onOneOff: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [repo, setRepo] = useState("");
  const repoNames = useMemo(() => [...new Set([...(runs ?? []).map((r) => r.repo), ...batches.map((b) => b.repo)])].sort(), [runs, batches]);
  if (!runs) return <div className="rv-loading" aria-busy="true" />;
  const shown = runs.filter((r) => (!repo || r.repo === repo) && (filter === "all" || (filter === "important" ? r.important > 0 : r.status === "skipped" || r.status === "failed")));
  const shownBatches = batches.filter((b) => (!repo || b.repo === repo) && (filter === "all" || (filter === "important" ? b.verdict === "blocked" || b.verdict === "concerns" : b.status === "skipped" || b.status === "failed")));
  const counts = { important: runs.filter((r) => r.important > 0).length, skipped: runs.filter((r) => (r.status === "skipped" || r.status === "failed")).length };
  return (
    <>
    {shownBatches.length > 0 && (
      <Section title="Repo reviews" count={shownBatches.length}>
        <div className="rv-runs" role="list">
          {shownBatches.map((b) => (
            <BatchRow key={b.id} b={b} />
          ))}
        </div>
      </Section>
    )}
    <Section
      title="Recent reviews"
      count={shown.length}
      aside={
        <div className="rv-filters">
          {repoNames.length > 1 && <Select aria-label="Repo" value={repo} options={[["", "All repos"], ...repoNames.map((n) => [n, n] as const)]} onChange={setRepo} />}
          <Segmented label="Show" value={filter} onChange={setFilter} options={[["all", "All"], ["important", `Important (${counts.important})`], ["skipped", `Skipped or failed (${counts.skipped})`]]} />
        </div>
      }
    >
      {!shown.length ? (
        <EmptyState action={<Button onClick={onOneOff}>Review a PR</Button>}>{runs.length || batches.length ? "No reviews match this filter." : "No reviews yet. The first one starts when a watched repo gets a pull request, or paste a PR link to review one now."}</EmptyState>
      ) : (
        <div className="rv-runs" role="list">
          {shown.map((r) => (
            <RunRow key={r.id} r={r} engines={engines} />
          ))}
        </div>
      )}
    </Section>
    </>
  );
}

const VERDICTS: Record<Verdict, [string, "failed" | "needs" | "ok" | "neutral"]> = { blocked: ["Blocked", "failed"], concerns: ["Concerns", "needs"], incomplete: ["Incomplete", "neutral"], clean: ["Clean", "ok"] };
function BatchRow({ b }: { b: TreeBatch }) {
  const [tone, word] = STATUS[b.status];
  const at = b.started ?? b.ended ?? new Date().toISOString();
  return (
    <a className="rv-run rv-batch" href={`#/reviews/b/${encodeURIComponent(b.id)}`} role="listitem">
      <StatusDot tone={tone}>{b.status === "done" ? "Reported" : word}</StatusDot>
      <span className="rv-run-pr">
        <span className="rv-run-ref">
          {b.repo} <b className="rv-mono">{b.sha7}</b>
        </span>
        <span className="rv-run-title">{b.status === "failed" || b.status === "skipped" ? (b.why ?? word) : "Whole-repo review"}</span>
      </span>
      <span className="rv-run-who">{b.verdict ? <Tag tone={VERDICTS[b.verdict][1]}>{VERDICTS[b.verdict][0]}</Tag> : null}</span>
      <span className="rv-run-sev" />
      <span className="rv-run-cost">{b.cost_usd ? usd(b.cost_usd) : ""}</span>
      <time className="rv-run-time" dateTime={at} title={new Date(at).toLocaleString()}>{b.status === "queued" ? "queued" : live(b) ? elapsed(at) : agoLabel(b.ended ?? at)}</time>
    </a>
  );
}

/** One whole-repo review's report, as the service rendered it (untrusted text: the Markdown part sanitises it). The list's polling refreshes `batch`; the report is read again when the batch's state moves. */
function BatchPage({ id, batch, onSignIn, reload }: { id: string; batch: TreeBatch | undefined; onSignIn: () => void; reload: () => unknown }) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState("");
  const state = `${batch?.status}|${batch?.ended}|${batch?.published}`;
  // Followed until the report and its Primer outcome are in, whether or not the list was already polling when it was started.
  const settled = batch?.status === "done" && batch.published;
  useEffect(() => {
    if (settled) return;
    const t = setInterval(() => void reload(), 4_000);
    return () => clearInterval(t);
  }, [settled, reload]);
  useEffect(() => {
    let stale = false;
    api.reviewReport(id).then(
      (r) => !stale && (setMd(r.markdown), setError("")),
      (e) => !stale && (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
    );
    return () => {
      stale = true;
    };
  }, [id, state, onSignIn]);
  useEffect(() => setMd(null), [id]);
  const [tone, word] = batch ? STATUS[batch.status] : (["idle", ""] as const);
  const link = (u?: string) => (u && /^https:\/\//.test(u) ? u : undefined);
  return (
    <Page className="rv-page" label="Repo review">
      <PageHeader
        crumb={<a href="#/reviews/reviews">Code review</a>}
        title={batch ? `${batch.repo} ${batch.sha7}` : "Repo review"}
        status={batch ? <span className="rv-head-status"><StatusDot tone={tone}>{batch.status === "done" ? "Reported" : word}</StatusDot>{batch.verdict && <Tag tone={VERDICTS[batch.verdict][1]}>{VERDICTS[batch.verdict][0]}</Tag>}</span> : undefined}
        actions={
          <>
            {link(batch?.primer_url) && <LinkButton href={link(batch?.primer_url)!} external>Open in Primer</LinkButton>}
            {link(batch?.report_url) && <LinkButton href={link(batch?.report_url)!} external>Open the report</LinkButton>}
          </>
        }
      />
      {batch && (batch.status === "failed" || batch.status === "skipped") && batch.why && <Banner tone="danger">{batch.why}</Banner>}
      {batch && batch.status === "done" && batch.why && <Banner tone="warn">{batch.why}. The report is below.</Banner>}
      {error && batch?.status === "done" ? <Banner tone="danger">Couldn't load this report: {error}</Banner> : md === null ? <div className="rv-loading" aria-busy="true" /> : <Card className="rv-report"><Markdown text={md} prefix="" className="md" /></Card>}
      {batch?.runs?.length ? (
        <Card className="rv-report">
          <h3>Findings by option</h3>
          <p className="muted">The report above keeps within Primer's size; each option's page lists all of its findings.</p>
          <ul>{batch.runs.map((r) => <li key={r.id}><a href={`#/reviews/r/${encodeURIComponent(r.id)}`}>{r.option}</a>: {r.status}{r.status === "done" ? `, ${r.important} important, ${r.nit} nits, ${r.pre_existing} pre-existing` : ""}</li>)}</ul>
        </Card>
      ) : null}
    </Page>
  );
}

function RunRow({ r, engines }: { r: Run; engines: EngineCatalog | null }) {
  const [tone, word] = STATUS[r.status];
  return (
    <a className={`rv-run${r.status === "done" ? " is-done" : ""}${r.status === "done" && r.important ? " has-important" : ""}`} href={`#/reviews/r/${encodeURIComponent(r.id)}`} role="listitem">
      <StatusDot tone={tone}>{word}</StatusDot>
      <span className="rv-run-pr">
        <span className="rv-run-ref">
          {r.repo} <b>#{r.number}</b>
        </span>
        <span className="rv-run-title" title={r.title}>{r.status === "skipped" ? skipWords(r.why) : r.status === "failed" ? (r.why ?? "The review didn't finish") : (r.title ?? `at ${short(r.head)}`)}</span>
      </span>
      <span className="rv-run-who">
        <ComboTag c={r} engines={engines} />
        {r.kind !== "auto" && <span className="rv-run-kind">{r.kind === "command" ? "asked on GitHub" : "one-off"}</span>}
      </span>
      <span className="rv-run-sev">{r.status === "done" ? <Severities v={r} compact /> : null}</span>
      <span className="rv-run-cost" title={r.tokens_in || r.tokens_out ? `${tokens(r.tokens_in)} in, ${tokens(r.tokens_out)} out${took(r) ? `, ${took(r)}` : ""}` : undefined}>{r.cost_usd ? usd(r.cost_usd) : ""}</span>
      <time className="rv-run-time" dateTime={when(r)} title={new Date(when(r)).toLocaleString()}>{r.status === "queued" ? "queued" : live(r) ? elapsed(when(r)) : agoLabel(r.ended ?? when(r))}</time>
    </a>
  );
}

/* ----------------------------------------------------------------------------- one review */
function RunPage({ id, config, engines, onSignIn }: { id: string; config: CodeReview | null; engines: EngineCatalog | null; onSignIn: () => void }) {
  const [data, setData] = useState<{ run: Run; review: Review | null; findings: FindingRow[]; gate: Gate | null } | null>(null);
  const [error, setError] = useState("");
  const [again, setAgain] = useState(false);
  const load = useCallback(() => api.review(id).then((d) => (setData(d), setError("")), (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message))), [id, onSignIn]);
  useEffect(() => void load(), [load]);
  const running = data ? live(data.run) : false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 4_000);
    return () => clearInterval(t);
  }, [running, load]);

  const crumb = <a href="#/reviews/reviews">Code review</a>;
  if (!data) return <Page className="rv-page"><PageHeader crumb={crumb} title="Review" />{error ? <Banner tone="danger">Couldn't load this review: {error}</Banner> : <div className="rv-loading" aria-busy="true" />}</Page>;
  const { run, review, findings, gate } = data;
  const [tone, word] = STATUS[run.status];
  const outcomes = new Map(findings.map((f) => [f.id, f.outcome]));
  return (
    <Page className={`rv-page ${hueClass(run.engine)}`} label="Review">
      <PageHeader
        crumb={<>{crumb} / {run.repo}</>}
        title={run.target === "tree" ? `${run.repo} @ ${short(run.head)}` : `${run.repo} #${run.number}`}
        status={
          <span className="rv-head-status">
            <StatusDot tone={tone}>{word}</StatusDot>
            <ComboTag c={run} engines={engines} />
            {run.status === "done" && <Severities v={run} />}
          </span>
        }
        sub={run.title}
        actions={
          <>
            {run.target === "tree" ? (
              <>
                {run.batch && <LinkButton href={`#/reviews/b/${encodeURIComponent(run.batch)}`}>Open the repo review</LinkButton>}
                <LinkButton href={githubLink(run.url) ?? `https://github.com/${run.repo}/tree/${run.head}`} external>Open the commit</LinkButton>
              </>
            ) : (
              <>
                <Button disabled={!engines} onClick={() => setAgain(true)}>Review again</Button>
                <LinkButton href={githubLink(run.review_url) ?? prUrl(run.repo, run.number)} external>{run.review_url ? "Open the review on GitHub" : "Open the PR"}</LinkButton>
              </>
            )}
          </>
        }
      />
      {error && <Banner tone="danger">{error}</Banner>}
      {run.status === "skipped" && <Banner tone="warn">Skipped: {skipWords(run.why)}. A skip is said on the PR too, in the review's acknowledgement comment.</Banner>}
      {run.status === "failed" && <Banner tone="danger">The review didn't finish{run.why ? `: ${run.why}` : ""}. Nothing was posted. Ask again with “Review again”, or comment “aiden review” on the PR.</Banner>}
      {review?.coverage.incomplete && <Banner tone="warn">Partial review: {review.coverage.incomplete}. Files outside the reviewed set weren't checked, so fewer findings here doesn't mean clean.</Banner>}
      <div className="ui-split">
        <div>
          {running ? (
            <Card className="rv-running">
              <StatusDot tone="busy">{run.status === "queued" ? "Waiting for a free slot" : "Reading the diff and checking each finding"}</StatusDot>
              <span className="rv-muted">{run.started ? `Started ${elapsed(run.started)} ago.` : "Waiting to start."} This page updates when it's done.</span>
            </Card>
          ) : review ? (
            <Findings review={review} outcomes={outcomes} />
          ) : findings.length ? (
            <FindingRows rows={findings} />
          ) : run.status === "done" ? (
            <EmptyState>The findings of this run are no longer kept.</EmptyState>
          ) : null}
        </div>
        <div>
          {gate && <MergeGate run={run} gate={gate} onChanged={() => void load()} onSignIn={onSignIn} />}
          <Card>
            <Facts
              items={[
                ["Reviewed by", comboLabel(run, engines ?? undefined)],
                ["Asked by", run.kind === "auto" ? "Repo trigger" : run.kind === "command" ? "aiden review on GitHub" : "One-off"],
                ["Head", <a key="h" className="rv-mono" href={`https://github.com/${run.repo}/commit/${run.head}`} target="_blank" rel="noreferrer noopener">{short(run.head)}</a>],
                review ? ["Scope", review.full || !review.incremental_from ? "Whole PR" : <span key="s">Changes since <span className="rv-mono">{short(review.incremental_from)}</span></span>] : null,
                review ? ["Files", `${review.coverage.reviewed.length} reviewed${review.coverage.excluded.length ? `, ${review.coverage.excluded.length} excluded` : ""}`] : null,
                ["Cost", usd(run.cost_usd)],
                run.tokens_in || run.tokens_out ? ["Tokens", `${tokens(run.tokens_in)} in, ${tokens(run.tokens_out)} out`] : null,
                ["When", new Date(when(run)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })],
                took(run) ? ["Took", took(run)] : null,
              ]}
            />
          </Card>
          {review && review.withheld.important + review.withheld.nit + review.withheld.pre_existing > 0 && (
            <Card>
              <b>Not posted again</b>
              <span className="rv-muted">Already on the PR from an earlier review of this branch:</span>
              <Severities v={review.withheld} />
            </Card>
          )}
          {review && review.stale_guidance.length > 0 && (
            <Card>
              <b>Guidance this change may make stale</b>
              <ul className="rv-list">{review.stale_guidance.map((g) => <li key={g}>{g}</li>)}</ul>
            </Card>
          )}
          {review && review.coverage.excluded.length > 0 && (
            <details className="rv-excluded">
              <summary>Excluded files ({review.coverage.excluded.length})</summary>
              <ul className="rv-list">{review.coverage.excluded.map((f) => <li key={f} className="rv-mono">{f}</li>)}</ul>
            </details>
          )}
        </div>
      </div>
      {again && engines && <OneOffDialog config={config} engines={engines} url={prUrl(run.repo, run.number)} onClose={() => setAgain(false)} />}
    </Page>
  );
}

/** A gated repo's merge verdict for the PR's current head: why it waits, and a Dismiss for each open important finding. */
function MergeGate({ run, gate, onChanged, onSignIn }: { run: Run; gate: Gate; onChanged: () => void; onSignIn: () => void }) {
  const [dismissing, setDismissing] = useState<Gate["open"][number] | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => (setDismissing(null), setReason(""), setError(""));
  const dismiss = () => {
    if (!dismissing) return;
    setBusy(true);
    api.dismissFinding({ repo: run.repo, number: run.number, id: dismissing.id, reason: reason.trim() }).then(
      () => (close(), onChanged()),
      (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
    ).finally(() => setBusy(false));
  };
  return (
    <Card className="rv-gate">
      <span className="rv-head-status">
        <b>Merge gate</b>
        <StatusDot tone={gate.verdict === "pass" ? "done" : "busy"}>{gate.verdict === "pass" ? "May merge" : "Waiting"}</StatusDot>
        <span className="rv-muted rv-mono">{short(gate.head)}</span>
      </span>
      {gate.reasons.map((r) => (
        <span key={r.code} className="rv-gate-reason">
          {r.text}
          {r.unblock && <span className="rv-muted"> {r.unblock.replace(/^./, (c) => c.toUpperCase())}.</span>}
        </span>
      ))}
      {gate.open.length > 0 && (
        <ul className="rv-list rv-gate-open">
          {gate.open.map((f) => (
            <li key={f.id}>
              <span><span className="rv-mono">{f.path}:{f.line}</span> {f.title}</span>
              <Button size="sm" variant="quiet" onClick={() => setDismissing(f)}>Dismiss</Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={!!dismissing}
        onClose={close}
        title="Dismiss this finding"
        actions={<><Button variant="quiet" onClick={close}>Cancel</Button><Button disabled={busy || !reason.trim()} onClick={dismiss}>Dismiss</Button></>}
      >
        {dismissing && <span className="rv-muted"><span className="rv-mono">{dismissing.path}:{dismissing.line}</span> {dismissing.title}</span>}
        <Field label="Why" help="Kept with the finding; it no longer holds the merge. Reported again later, it opens again.">{() => <Input aria-label="Why" value={reason} autoFocus onChange={(ev) => setReason(ev.target.value)} />}</Field>
        {error && <Banner tone="danger">{error}</Banner>}
      </Dialog>
    </Card>
  );
}

/** A finding's outcome, once known. */
const OutcomeTag = ({ o }: { o: Outcome | null | undefined }) => (o ? <Tag tone={OUTCOMES[o][1]}>{OUTCOMES[o][0]}</Tag> : null);

/** The findings when the review's own record is gone: what the service still lists. */
function FindingRows({ rows }: { rows: FindingRow[] }) {
  return (
    <Section title="Findings" count={rows.length}>
      <div className="rv-findings">
        {rows.map((f) => (
          <article key={f.id} className={`rv-finding rv-${f.severity}`}>
            <header className="rv-finding-head">
              <h3>{f.title}</h3>
              <span className="rv-where rv-mono">{f.path}:{f.line}</span>
            </header>
            <OutcomeTag o={f.outcome} />
          </article>
        ))}
      </div>
    </Section>
  );
}

function Findings({ review, outcomes }: { review: Review; outcomes: Map<string, Outcome | null> }) {
  if (!review.findings.length)
    return (
      <EmptyState>
        No issues found in {review.coverage.reviewed.length} file{review.coverage.reviewed.length === 1 ? "" : "s"}{review.coverage.incomplete ? " of the part that was reviewed" : ""}.
      </EmptyState>
    );
  return (
    <>
      {SEVERITIES.map(([sev, name]) => {
        const list = review.findings.filter((f) => f.severity === sev);
        return list.length ? (
          <Section key={sev} title={name} count={list.length} hint={sev === "pre_existing" ? "In code this PR touches, but older than it" : undefined}>
            <div className="rv-findings">
              {list.map((f) => (
                <FindingCard key={f.id} f={f} review={review} outcome={outcomes.get(f.id)} />
              ))}
            </div>
          </Section>
        ) : null;
      })}
    </>
  );
}

function FindingCard({ f, review, outcome }: { f: Finding; review: Review; outcome: Outcome | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const where = `${f.path}:${f.line}${f.end_line && f.end_line !== f.line ? `-${f.end_line}` : ""}`;
  const blob = `https://github.com/${review.repo}/blob/${review.head}/${f.path.split("/").map(encodeURIComponent).join("/")}#L${f.line}${f.end_line ? `-L${f.end_line}` : ""}`;
  // "Copy as fix brief": location, evidence and the wanted outcome, for the author's coding agent.
  const brief = [`Fix in ${review.repo} (PR #${review.pr}, ${short(review.head)}): ${f.title}`, `Where: ${where}`, `Why: ${f.why}`, `Evidence: ${f.evidence}`, `Wanted: ${f.fix_brief}`].join("\n");
  return (
    <article className={`rv-finding rv-${f.severity}`}>
      <header className="rv-finding-head">
        <h3>{f.title}</h3>
        <OutcomeTag o={outcome} />
        <a className="rv-where rv-mono" href={blob} target="_blank" rel="noreferrer noopener" title="Open this line on GitHub">{where}</a>
      </header>
      <p className="rv-prose">{f.why}</p>
      <details className="rv-why">
        <summary>Why flagged</summary>
        <pre className="rv-evidence">{f.evidence}</pre>
        <p className="rv-prose"><b>Wanted:</b> {f.fix_brief}</p>
      </details>
      <footer className="rv-finding-foot">
        <Button
          size="sm"
          variant="quiet"
          onClick={() =>
            void navigator.clipboard?.writeText(brief).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
          }
        >
          {copied ? "Copied" : "Copy as fix brief"}
        </Button>
        {githubLink(f.url) && <a className="btn quiet sm" href={githubLink(f.url)} target="_blank" rel="noreferrer noopener">View the comment</a>}
      </footer>
    </article>
  );
}

/* ----------------------------------------------------------------------------- one-off */
function OneOffDialog({ config, engines, url: url0 = "", onClose }: { config: CodeReview | null; engines: EngineCatalog; url?: string; onClose: () => void }) {
  const [url, setUrl] = useState(url0);
  const [combos, setCombos] = useState<Combo[]>(() => defaultCombos(config, /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url0)?.[1] ?? ""));
  const edited = useRef(false);
  const [focus, setFocus] = useState("");
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const valid = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(url.trim());
  // The repo's own on_open combos, until the owner picks others.
  const repoName = valid ? url.trim().split("/").slice(3, 5).join("/") : "";
  useEffect(() => {
    if (repoName && !edited.current) setCombos(defaultCombos(config, repoName));
  }, [repoName, config]);
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.reviewRun({ pr_url: url.trim(), combos, ...(focus.trim() ? { focus: focus.trim() } : {}), ...(full ? { full } : {}) });
      location.hash = r.runs.length === 1 ? `#/reviews/r/${encodeURIComponent(r.runs[0]!.id)}` : "#/reviews/reviews";
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Review a pull request"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid || busy || !combos.length || !combosOk(combos)} onClick={() => void run()}>{busy ? "Starting…" : "Run review"}</Button>
        </>
      }
    >
      <p>Any PR your GitHub sign-in can read. The review posts to the PR as you, signed by AidenHQ, like a watched repo's would.</p>
      <Field label="Pull request" error={url && !valid ? "A PR link, like https://github.com/acme/payments/pull/42" : err || null}>
        {(id, d) => <Input id={id} aria-describedby={d} autoFocus placeholder="https://github.com/acme/payments/pull/42" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />}
      </Field>
      <div>
        <Field label="Scope" help={full ? "Every file in the PR" : "Only what changed since the last review"}>
          {() => <Segmented label="Scope" value={full ? "full" : "new"} onChange={(v) => setFull(v === "full")} options={[["new", "New changes"], ["full", "Whole PR"]]} />}
        </Field>
      </div>
      <Field label="Reviewed by" help="One review per row, each posted on its own">
        {() => <ComboPicker label="Reviewer" value={combos} engines={engines} onChange={(v) => ((edited.current = true), setCombos(v))} />}
      </Field>
      <Field label="Focus" help="Optional: what to look at hardest, like “the retry logic” or “auth checks”.">
        {(id, d) => <Input id={id} aria-describedby={d} value={focus} maxLength={300} onChange={(e) => setFocus(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------- repo review (a whole repo at a commit) */
const LENS_WORDS: Record<(typeof LENSES)[number], [string, string]> = {
  correctness: ["Correctness", "Logic errors, broken edge cases, wrong assumptions"],
  security: ["Security", "Live weaknesses: injection, auth, secrets, unsafe dependencies"],
  maintainability: ["Maintainability", "Dead code, duplication, complexity, tangled structure"],
  performance: ["Performance", "Slow paths, wasted work, heavy dependencies"],
};
const SHA = /^[0-9a-f]{40}$/i;
function RepoReviewPage({ config, engines }: { config: CodeReview | null; engines: EngineCatalog }) {
  const [repo, setRepo] = useState("");
  const [commit, setCommit] = useState("");
  const [combos, setCombos] = useState<Combo[]>(() => defaultCombos(config, "").slice(0, 1));
  const [options, setOptions] = useState<CatalogOption[] | null>(null);
  const [sha, setSha] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const commitOk = !commit.trim() || SHA.test(commit.trim());
  const edited = useRef(false);
  // The catalog for this repo and commit: what applies there, with the recommended ones ticked (until the owner ticks their own).
  useEffect(() => {
    setOptions(null);
    setSha("");
    setErr("");
    if (!repo || !commitOk) return;
    let stale = false;
    const timer = setTimeout(() => {
      void api.reviewCatalog(repo, commit.trim() || undefined).then(
        (c) => {
          if (stale) return;
          const ids = new Set(c.options.map((o) => o.id));
          setOptions(c.options);
          setSha(c.sha);
          // The owner's own ticks stay across a new commit (those the commit still offers); otherwise the recommended ones.
          setTicked((t) => (edited.current ? new Set([...t].filter((id) => ids.has(id))) : new Set(c.options.filter((o) => o.recommended).map((o) => o.id))));
        },
        (e) => !stale && setErr((e as Error).message),
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [repo, commit, commitOk]);
  const toggle = (id: string) => {
    edited.current = true;
    setTicked((t) => {
      const n = new Set(t);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const c = combos[0];
  const chosen = options ? options.filter((o) => ticked.has(o.id)).map((o) => o.id) : [];
  const run = async () => {
    if (!c || !sha || !chosen.length) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.reviewTreeRun({ target: { tree: true, repo, commit: sha }, options: chosen, combo: { model: c.model, effort: c.effort } });
      location.hash = `#/reviews/b/${encodeURIComponent(r.batch)}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Page className="rv-page" label="New repo review">
      <PageHeader crumb={<a href="#/reviews/reviews">Code review</a>} title="New repo review" sub="Reviews a whole repo at one commit with the options you tick. The report lands on this page, and in Primer when it is connected. Nothing is posted to GitHub." />
      {err && <Banner tone="danger">{err}</Banner>}
      <Card className="rv-form">
      <div className="rv-split">
        <RepoPicker repo={repo} onPick={(r) => ((edited.current = false), setTicked(new Set()), setCombos(defaultCombos(config, r).slice(0, 1)), setRepo(r))} />
        <Field label="Commit" help={options && sha ? <>Reviewing <b className="rv-mono">{sha.slice(0, 7)}</b></> : "Optional. A full commit SHA; the default branch's head when empty."} error={commitOk ? null : "A full 40-character commit SHA"}>
          {(id, d) => <Input id={id} aria-describedby={d} className="rv-mono" placeholder="default branch head" value={commit} onChange={(e) => setCommit(e.target.value)} spellCheck={false} />}
        </Field>
      </div>
      <Field label="Options" help="Ready-made checks in four lenses. Recommended ones for this repo are ticked.">
        {() =>
          !repo ? (
            <span className="rv-muted">Pick a repo to see what applies to it.</span>
          ) : !commitOk ? (
            <span className="rv-muted">Fix the commit to see what applies.</span>
          ) : options === null ? (
            err ? null : <div className="rv-loading rv-loading-sm" aria-busy="true" />
          ) : (
            <div className="rv-lenses">
              {LENSES.map((lens) => {
                const opts = options.filter((o) => o.lens === lens);
                return (
                  <section key={lens} className={`rv-lens rv-lens-${lens}`} aria-label={LENS_WORDS[lens][0]}>
                    <h4>{LENS_WORDS[lens][0]}</h4>
                    <p className="rv-muted">{LENS_WORDS[lens][1]}</p>
                    {!opts.length ? <span className="rv-muted rv-lens-none">Nothing applies here</span> : opts.map((o) => (
                      <label key={o.id} className="rv-opt">
                        <input type="checkbox" checked={ticked.has(o.id)} onChange={() => toggle(o.id)} />
                        <span className="rv-opt-name">{o.id}
                        <span className="rv-opt-tags">
                          {o.runs_code && <Tag tone="needs" title="Runs the repo's own code in a sandbox">runs code</Tag>}
                          {o.cost === "high" && <Tag tone="failed" title="Spends a lot of the install's spend limit">high cost</Tag>}
                        </span></span>
                        <span className="rv-muted rv-opt-src" title={`${o.source.repo} ${o.source.version}, ${o.source.licence}`}>{o.source.repo.split("/").pop()} {o.source.version}</span>
                      </label>
                    ))}
                  </section>
                );
              })}
            </div>
          )
        }
      </Field>
      <Field label="Model options run by" help="The model and effort for options that call a model">{() => <ComboPicker single noEngine label="Reviewer" value={combos} engines={engines} onChange={setCombos} />}</Field>
      </Card>
      <div className="rv-form-actions">
        <Button variant="quiet" onClick={() => (location.hash = "#/reviews/reviews")}>Cancel</Button>
        <Button variant="primary" disabled={!repo || !commitOk || !sha || !chosen.length || !c || !MODEL_ID.test(c.model) || busy} onClick={() => void run()}>{busy ? "Starting…" : "Run review"}</Button>
      </div>
    </Page>
  );
}

/** Pick a repo your GitHub sign-in can read, or type owner/name. `taken` repos (lower case) are listed but not pickable. */
function RepoPicker({ repo, onPick, taken, takenWord }: { repo: string; onPick: (repo: string) => void; taken?: Set<string>; takenWord?: [string, string] }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ repo: string; private: boolean }[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void api.reviewAvailable(q.trim()).then((r) => setFound(r.repos), () => setFound([])), q ? 250 : 0);
    return () => clearTimeout(timer.current);
  }, [q]);
  const typed = /^[\w.-]+\/[\w.-]+$/.test(q.trim()) ? q.trim() : "";
  const isTaken = (r: string) => Boolean(taken?.has(r.toLowerCase()));
  return (
    <div className="rv-picker">
      <Field label="Repository" help={repo ? <>Selected: <b>{repo}</b></> : "Repos your GitHub sign-in can read. Type owner/name for one that isn't listed."}>
        {(id, d) => <Input id={id} aria-describedby={d} autoFocus placeholder="Search, or type acme/payments" value={q} onChange={(e) => setQ(e.target.value)} />}
      </Field>
      <div className="rv-picker-list" role="listbox" aria-label="Repositories">
        {typed && !found?.some((x) => x.repo.toLowerCase() === typed.toLowerCase()) && (
          <button type="button" role="option" aria-selected={repo === typed} className={repo === typed ? "on" : ""} onClick={() => onPick(typed)} disabled={isTaken(typed)}>
            <span>{typed}</span>
            <span className="rv-muted">{isTaken(typed) ? takenWord![0] : "use this name"}</span>
          </button>
        )}
        {found === null ? (
          <span className="rv-muted rv-picker-note">Loading your repos…</span>
        ) : !found.length && !typed ? (
          <span className="rv-muted rv-picker-note">{q ? "No listed repo matches: type its full name, like acme/payments." : "Type a repo's full name, like acme/payments."}</span>
        ) : (
          found.slice(0, 40).map((x) => (
            <button key={x.repo} type="button" role="option" aria-selected={repo === x.repo} className={repo === x.repo ? "on" : ""} disabled={isTaken(x.repo)} onClick={() => onPick(x.repo)}>
              <span>{x.repo}</span>
              <span className="rv-muted">{isTaken(x.repo) ? takenWord![1] : x.private ? "private" : "public"}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- Repos tab */
function ReposTab({ config, repos, engines, onEdit, onWatch }: { config: CodeReview; repos: ReposView | null; engines: EngineCatalog | null; onEdit: (r: RepoConfig) => void; onWatch: () => void }) {
  const row = (name: string) => repos?.repos.find((r) => r.repo.toLowerCase() === name.toLowerCase());
  return (
    <Section title="Watched repos" count={config.repos.length} aside={<Button variant="primary" onClick={onWatch}>Watch a repo</Button>}>
      {!config.repos.length ? (
        <EmptyState action={<Button variant="primary" onClick={onWatch}>Watch a repo</Button>}>No repo is watched. Watch one to get a review on each of its pull requests.</EmptyState>
      ) : (
        <TileGrid>
          {config.repos.map((r) => {
            const live = row(r.repo);
            const moment = (k: "on_open" | "on_push", name: string) => (r[k].length ? r[k].map((c, i) => <Tag key={`${k}${i}`} title={`${name}: ${c.engine} · ${c.model} · ${c.effort}`}>{name}: {comboLabel(c, engines ?? undefined)}</Tag>) : <Tag key={k} title={name}>{name}: off</Tag>);
            const spent = live?.day_spent_usd ?? 0;
            const id = live?.identity;
            return (
              <Tile
                key={r.repo}
                name={r.repo}
                title={r.repo}
                onOpen={() => onEdit(r)}
                status={live?.error ? <StatusDot tone="failed" title={live.error}>Can't watch</StatusDot> : !id ? undefined : <StatusDot tone="info">{id === "app" ? "Posts as the App" : "Posts as you"}</StatusDot>}
                facts={
                  <Tags>
                    {moment("on_open", "Open")}
                    {moment("on_push", "Push")}
                    {(r.drafts ?? false) && <Tag>Drafts</Tag>}
                    {(r.forks ?? "manual") === "auto" && <Tag tone="needs">Forks automatic</Tag>}
                    {r.ignore?.length ? <Tag title={r.ignore.join("\n")}>{r.ignore.length} ignored</Tag> : null}
                  </Tags>
                }
                foot={
                  <span className="rv-tile-spend">
                    <span>{usd(spent)} today</span>
                  </span>
                }
                action={<Button size="sm" onClick={() => onEdit(r)}>Edit</Button>}
              />
            );
          })}
        </TileGrid>
      )}
    </Section>
  );
}

/** Watch a repo (no `edit`), or edit or stop watching one. */
function RepoDialog({ config, engines, edit, onClose, onSave }: { config: CodeReview; engines: EngineCatalog; edit?: RepoConfig; onClose: () => void; onSave: Save }) {
  const [repo, setRepo] = useState(edit?.repo ?? "");
  const [f, setF] = useState({ ...REPO_DEFAULTS, ...edit, ignore: edit?.ignore ?? [] });
  const [ignoreText, setIgnoreText] = useState((edit?.ignore ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const watched = new Set(config.repos.map((r) => r.repo.toLowerCase()));
  const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo) && (edit || !watched.has(repo.toLowerCase()));
  const entry = (): RepoConfig => {
    const ignore = ignoreText.split("\n").map((s) => s.trim()).filter(Boolean);
    return { repo, on_open: f.on_open, on_push: f.on_push, drafts: f.drafts, forks: f.forks, max_nits: f.max_nits, ...(ignore.length ? { ignore } : {}) };
  };
  const submit = async (value: CodeReview, what: string) => {
    setBusy(true);
    setErr("");
    try {
      await onSave(value, what);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const others = config.repos.filter((r) => r.repo !== edit?.repo);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={edit ? edit.repo : "Watch a repo"}
      actions={
        <>
          {edit && <Button variant="danger" className="rv-left" disabled={busy} onClick={() => void submit({ ...config, repos: others }, `stop watching ${edit.repo}`)}>Stop watching</Button>}
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!validRepo || busy || !combosOk([...f.on_open, ...f.on_push])} onClick={() => void submit({ ...config, repos: edit ? config.repos.map((r) => (r.repo === edit.repo ? entry() : r)) : [...config.repos, entry()] }, edit ? `${repo} updated` : `watch ${repo}`)}>
            {busy ? "Saving…" : edit ? "Save" : "Watch repo"}
          </Button>
        </>
      }
    >
      {err && <Banner tone="danger">{err}</Banner>}
      {!edit && <RepoPicker repo={repo} onPick={setRepo} taken={watched} takenWord={["already watched", "watched"]} />}
      <Field label="When a PR opens" help="Each row is one review, posted on its own">{() => <ComboPicker gates label="When a PR opens" value={f.on_open} engines={engines} none="No review" onChange={(v) => setF({ ...f, on_open: v })} />}</Field>
      <Field label="On each push" help="Only the new changes">{() => <ComboPicker gates label="On each push" value={f.on_push} engines={engines} none="No review" onChange={(v) => setF({ ...f, on_push: v })} />}</Field>
      <div className="rv-grid2">
        <Field label="Draft PRs">{() => <span className="rv-switch"><Switch on={f.drafts} label="Review draft PRs" onChange={(on) => setF({ ...f, drafts: on })} />{f.drafts ? "Reviewed" : "Skipped"}</span>}</Field>
        <Field label="PRs from forks" help={f.forks === "manual" ? "Someone with write access comments aiden review" : "Reviewed like any PR"}>
          {(id) => <Select id={id} value={f.forks} options={[["manual", "When asked"], ["auto", "Automatically"]]} onChange={(v) => setF({ ...f, forks: v })} />}
        </Field>
      </div>
      <details className="rv-more" open={Boolean(edit?.ignore?.length)}>
        <summary>More options</summary>
        <div className="rv-grid2">
          <Field label="Ignore paths" help="One pattern a line, like **/generated/** or *.lock">
            {(id, d) => <textarea id={id} aria-describedby={d} className="ui-input rv-textarea" rows={3} value={ignoreText} onChange={(e) => setIgnoreText(e.target.value)} />}
          </Field>
          <Field label="Nits per review" help="At most this many nits are posted">
            {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} max={50} value={f.max_nits} onChange={(e) => setF({ ...f, max_nits: Number(e.target.value) })} />}
          </Field>
        </div>
      </details>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------- Insights tab */
const PERIODS = [["7", "7d"], ["30", "30d"], ["90", "90d"]] as const;
function InsightsTab({ onSignIn }: { onSignIn: () => void }) {
  const [days, setDays] = useState<(typeof PERIODS)[number][0]>("30");
  const [ins, setIns] = useState<ReviewInsights | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let on = true;
    setIns(null);
    api.reviewInsights(Number(days)).then((d) => on && setIns(d), (e) => on && (e instanceof SignInRequired ? onSignIn() : setErr((e as Error).message)));
    return () => {
      on = false;
    };
  }, [days, onSignIn]);
  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  // At most 30 bars: a 90-day period sums each three days.
  const bucket = <T extends { day: string }>(xs: T[], f: (x: T) => number) => {
    const step = Math.ceil(xs.length / 30);
    return Array.from({ length: Math.ceil(xs.length / step) }, (_, i) => xs.slice(i * step, (i + 1) * step)).map((g) => ({ day: g[0]!.day, v: g.reduce((s, x) => s + f(x), 0) }));
  };
  // A date under every few bars (the first and the last always), so the axis reads at any width.
  const tick = (i: number, n: number, d: string) => (i === 0 || i === n - 1 || (n > 10 ? i % Math.ceil(n / 5) === 0 && n - 1 - i >= Math.ceil(n / 10) : true) ? label(d) : "");
  const sevTotal = ins ? ins.severity.important + ins.severity.nit + ins.severity.pre_existing : 0;
  const maxRepo = Math.max(0, ...(ins?.by_repo.map((r) => r.cost) ?? []));
  return (
    <>
      <div className="rv-insights-bar">
        <span className="rv-muted">From every review run's start and end ({days === "7" ? "last week" : `last ${days} days`}).</span>
        <Segmented label="Period" options={PERIODS} value={days} onChange={setDays} />
      </div>
      {err && <Banner tone="danger">{err}</Banner>}
      {!ins ? (
        !err && <div className="rv-loading" aria-busy="true" />
      ) : !ins.total.reviews && !ins.skips.length && !ins.total.failed ? (
        <EmptyState>No reviews in this period yet.</EmptyState>
      ) : (
        <>
          <div className="rv-stats">
            <Card className="hue-0">
              <StatBlock label="Reviews" value={ins.total.reviews} sub={`on ${ins.total.prs} PR${ins.total.prs === 1 ? "" : "s"}${ins.total.failed ? `, ${ins.total.failed} failed` : ""}`} bars={bucket(ins.days, (d) => d.reviews).map((b, i, all) => ({ label: tick(i, all.length, b.day), value: b.v, title: `${label(b.day)}: ${b.v} reviews` }))} />
            </Card>
            <Card className="hue-4">
              <StatBlock label="Spend" value={usd(ins.total.cost)} sub={ins.total.reviews ? `${usd(ins.total.cost / ins.total.reviews)} a review on average` : "no finished reviews"} bars={bucket(ins.days, (d) => d.cost).map((b, i, all) => ({ label: tick(i, all.length, b.day), value: b.v, title: `${label(b.day)}: ${usd(b.v)}` }))} />
            </Card>
            <Card>
              <StatBlock label="Findings" value={sevTotal} sub={<Severities v={ins.severity} />} />
              {sevTotal > 0 && (
                <div className="rv-stack" role="img" aria-label={SEVERITIES.map(([k, n]) => `${ins.severity[k]} ${n}`).join(", ")}>
                  {SEVERITIES.map(([k]) => ins.severity[k] ? <i key={k} className={`rv-${k}`} style={{ flexGrow: ins.severity[k] }} /> : null)}
                </div>
              )}
            </Card>
            <Card>
              <StatBlock label="Fixed and auto-resolved" value={ins.resolved_rate == null ? "—" : `${Math.round(ins.resolved_rate * 100)}%`} sub={ins.resolved_rate == null ? "Shows once a PR is pushed again after a review" : "of findings were fixed and their threads resolved"} />
            </Card>
          </div>
          <div className="ui-split">
            <Section title="Cost by repo" count={ins.by_repo.length}>
              <div className="rv-bars">
                {ins.by_repo.map((r, i) => (
                  <div key={r.repo} className={`rv-bar hue-${[0, 1, 6, 4, 2, 5, 3, 7][i % 8]}`}>
                    <span className="rv-bar-name">{r.repo}</span>
                    <span className="rv-bar-track"><i style={{ width: `${maxRepo ? (r.cost / maxRepo) * 100 : 0}%` }} /></span>
                    <span className="rv-bar-val">{usd(r.cost)}</span>
                    <span className="rv-bar-sub rv-muted">{r.reviews} review{r.reviews === 1 ? "" : "s"} · {r.prs} PR{r.prs === 1 ? "" : "s"} · {r.prs ? usd(r.cost / r.prs) : "—"} a PR</span>
                  </div>
                ))}
              </div>
            </Section>
            <Section title="Skipped" count={ins.skips.reduce((s, x) => s + x.n, 0)}>
              {ins.skips.length ? (
                <div className="rv-skips">
                  {ins.skips.map((s) => (
                    <div key={s.why}>
                      <span>{skipWords(s.why)}</span>
                      <b>{s.n}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState>Nothing was skipped.</EmptyState>
              )}
            </Section>
          </div>
        </>
      )}
    </>
  );
}
