import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInRequired, api, type ReviewsSetup } from "./api";
import type { CodeReview, Finding, Profile, RepoConfig, RepoRow, Review, ReviewInsights, ReviewerRow, Run, Severity } from "../../src/reviews";
import { Banner, Button, Card, Dialog, EmptyState, Facts, Field, Input, LinkButton, Meter, Page, PageHeader, Section, Segmented, Select, StatBlock, StatusDot, Switch, Tabs, Tag, Tags, Tile, TileGrid, hueClass, type StatusTone } from "./ui";
import { agoLabel, elapsed } from "./util";
import "./reviews.css";

// The Reviews page (#/reviews/<tab>, #/reviews/r/<run>; docs/design/code-review.md, "Setting it up and using it"): the
// code-review module's runs, watched repos, reviewers and insights. The module runs and posts every review; this page reads
// its state, starts one-off and trial runs, and saves settings.code_review as a settings change (Tier 1, applied by the
// kernel). PR titles and every finding's text are the PR author's or a model's words: shown as plain text, never as links.

const TABS = [["reviews", "Reviews"], ["repos", "Repos"], ["reviewers", "Reviewers"], ["insights", "Insights"]] as const;
type Tab = (typeof TABS)[number][0];
type Route = { tab: Tab } | { run: string };
const routeOf = (): Route => {
  const h = location.hash.replace(/^#\/?/, "");
  const run = /^reviews\/r\/([\w-]{1,80})$/.exec(h)?.[1];
  if (run) return { run };
  const t = /^reviews\/([a-z]+)/.exec(h)?.[1];
  return { tab: TABS.some(([k]) => k === t) ? (t as Tab) : "reviews" };
};

/** The defaults a newly watched repo starts from (the module's REPO_DEFAULTS). */
const REPO_DEFAULTS: Required<Omit<RepoConfig, "repo" | "ignore">> & { ignore: string[] } = { on_open: "standard", on_push: "quick", on_risk: "deep", drafts: false, forks: "manual", month_usd: 50, max_nits: 5, ignore: [] };
const ENGINES = [["codex", "Codex"], ["claude-code", "Claude Code (not built yet)"], ["codegenie", "CodeGenie (not built yet)"]] as const;
const EFFORTS = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["max", "Max"]] as const;
const MODELS = ["~deepseek/deepseek-flash-latest", "~openai/gpt-sol-latest", "~openai/gpt-luna-latest", "~anthropic/claude-latest"];
const SEVERITIES: [Severity, string][] = [["important", "Important"], ["nit", "Nit"], ["pre_existing", "Pre-existing"]];
const SKIPS: Record<string, string> = { draft: "Draft PR", fork: "Fork PR, waiting for someone with write access to ask", budget: "Over the repo's monthly cap", instance_budget: "Over the monthly cap across repos", unchanged: "Nothing changed since the last review", superseded: "A newer push replaced it", stopped: "Reviews stopped on this PR", ignored: "Only ignored files changed" };
const skipWords = (why: string | null) => (why ? (SKIPS[why] ?? why.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())) : "Skipped");
const usd = (n: number | null | undefined, digits = 2) => (n == null ? "—" : `$${n.toFixed(digits)}`);
const short = (sha: string) => sha.slice(0, 7);
const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
/** A link the service gave, only when it points at GitHub. */
const githubLink = (u?: string | null) => (u && /^https:\/\/github\.com\//.test(u) ? u : undefined);
const modelName = (m: string) => m.replace(/^~/, "").replace(/-latest$/, "").split("/").pop() ?? m;
const STATUS: Record<Run["status"], [StatusTone, string]> = { queued: ["idle", "Queued"], running: ["busy", "Reviewing"], done: ["done", "Reviewed"], skipped: ["idle", "Skipped"], failed: ["failed", "Failed"] };
const live = (r: Run) => r.status === "queued" || r.status === "running";

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

const ReviewerTag = ({ name }: { name: string }) => (
  <span className={`rv-reviewer ${hueClass(name)}`}>
    <i aria-hidden />
    {name}
  </span>
);

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ----------------------------------------------------------------------------- the page */
let mounted = 0;

export function ReviewsView({ onSignIn }: { onSignIn: () => void }) {
  const [route, setRoute] = useState<Route>(routeOf);
  const [setup, setSetup] = useState<ReviewsSetup | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [repos, setRepos] = useState<RepoRow[] | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerRow[] | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ identifier: string; what: string } | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "oneoff"; url?: string; reviewer?: string } | { kind: "repo"; repo?: RepoConfig } | { kind: "reviewer"; name?: string } | { kind: "cap" }>(null);

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
  const loadRuns = useCallback(() => api.reviews({ limit: 200 }).then((r) => setRuns(r.runs), fail), [fail]);
  const loadRepos = useCallback(() => api.reviewRepos().then((r) => setRepos(r.repos), fail), [fail]);
  const loadReviewers = useCallback(() => api.reviewers().then((r) => setReviewers(r.reviewers), fail), [fail]);
  useEffect(() => void loadSetup(), [loadSetup]);
  const ready = Boolean(setup?.module && setup.github.connected);
  useEffect(() => {
    if (!ready) return;
    void loadRuns();
    void loadRepos();
    void loadReviewers();
  }, [ready, loadRuns, loadRepos, loadReviewers]);
  // A run under way: the list follows it.
  const anyLive = runs?.some(live) ?? false;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void loadRuns(), 8_000);
    return () => clearInterval(t);
  }, [anyLive, loadRuns]);

  const config = setup?.config ?? null;
  /** The owner's edit of settings.code_review, filed as a settings change; the page shows it until it applies. */
  const save = useCallback(
    async (value: CodeReview, what: string) => {
      const r = await api.reviewConfig(value);
      setSaved({ identifier: r.identifier, what });
      setDialog(null);
    },
    [],
  );
  const spent = (repos ?? []).reduce((s, r) => s + r.spent_usd, 0);
  const tab = "tab" in route ? route.tab : "reviews";

  if ("run" in route) return <RunPage id={route.run} reviewers={Object.keys(config?.reviewers ?? {})} onSignIn={onSignIn} />;

  const header = (
    <PageHeader
      title="Code review"
      sub="Reviews on your pull requests, posted to GitHub as comments. Advice only: nothing blocks a merge."
      actions={
        ready && config ? (
          <>
            <button type="button" className="rv-spend" onClick={() => setDialog({ kind: "cap" })} title="This month's review spend across repos, against the cap. Change the cap.">
              <span>
                {usd(spent)} <span className="rv-spend-of">of {usd(config.month_usd, 0)} this month</span>
              </span>
              <Meter value={spent / config.month_usd} tone={spent >= config.month_usd ? "failed" : spent >= config.month_usd * 0.8 ? "needs" : undefined} label="Spend this month against the cap" />
            </button>
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
      {saved && (
        <Banner action={<a className="btn sm" href={`#/t/${saved.identifier}`}>Open {saved.identifier}</a>}>
          Saved: {saved.what}. It takes effect once the change is reviewed and applied, usually within a few minutes.
        </Banner>
      )}
      {setup?.problems.length ? <Banner tone="warn">settings.code_review in instance.yaml has a problem: {setup.problems.join("; ")}. Saving here replaces it with a valid value.</Banner> : null}
      {!setup ? (
        !error && <div className="rv-loading" aria-busy="true" />
      ) : !setup.module ? (
        <EmptyState action={<LinkButton variant="primary" href="#/modules/code-review">Open the Code review module</LinkButton>}>
          Code review is off on this instance. Turn on the Code review module to get a review on every pull request. Nothing runs or spends until you pick a repo.
        </EmptyState>
      ) : ready && runs === null ? (
        !error && <div className="rv-loading" aria-busy="true" />
      ) : !ready || (!config?.repos.length && !runs?.length) ? (
        <Start setup={setup} onWatch={() => setDialog({ kind: "repo" })} onOneOff={(url) => setDialog({ kind: "oneoff", url })} />
      ) : (
        <>
          <Tabs label="Reviews views" tabs={TABS} value={tab} href={(t) => `#/reviews/${t}`} />
          {tab === "reviews" && <RunsTab runs={runs} onOneOff={() => setDialog({ kind: "oneoff" })} />}
          {tab === "repos" && config && <ReposTab config={config} repos={repos} onEdit={(repo) => setDialog({ kind: "repo", repo })} onWatch={() => setDialog({ kind: "repo" })} />}
          {tab === "reviewers" && config && <ReviewersTab config={config} rows={reviewers} onEdit={(name) => setDialog({ kind: "reviewer", name })} onNew={() => setDialog({ kind: "reviewer" })} />}
          {tab === "insights" && <InsightsTab onSignIn={onSignIn} />}
        </>
      )}

      {dialog?.kind === "oneoff" && <OneOffDialog reviewers={Object.keys(config?.reviewers ?? { standard: 1 })} url={dialog.url} reviewer={dialog.reviewer} onClose={() => setDialog(null)} />}
      {dialog?.kind === "repo" && config && <RepoDialog config={config} edit={dialog.repo} onClose={() => setDialog(null)} onSave={save} />}
      {dialog?.kind === "reviewer" && config && <ReviewerDialog config={config} name={dialog.name} onClose={() => setDialog(null)} onSave={save} />}
      {dialog?.kind === "cap" && config && <CapDialog config={config} spent={spent} onClose={() => setDialog(null)} onSave={save} />}
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
      </div>
      <ol className="rv-steps">
        <li className={connected ? "done" : "now"}>
          <span className="rv-step-mark">{connected ? <Check /> : "1"}</span>
          <div className="rv-step-body">
            <b>{connected ? "GitHub is connected" : "Connect GitHub"}</b>
            <span>{connected ? "Reviews post as your GitHub App where it's installed, otherwise as you." : "Sign in with a code at github.com. Reviews read PRs and post comments through it."}</span>
          </div>
          {!connected && <LinkButton variant="primary" href="#/settings/connections?connect=github">Connect GitHub</LinkButton>}
        </li>
        <li className={connected ? "now" : "later"}>
          <span className="rv-step-mark">2</span>
          <div className="rv-step-body">
            <b>Watch a repo</b>
            <span>Standard review when a PR opens, a quick one on each push, deep for high-risk changes. $50 a month cap to start.</span>
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
      <p className="rv-start-ask">You can also ask Aiden in chat: “watch acme/payments, deep for anything under src/billing”.</p>
    </section>
  );
}

/* ----------------------------------------------------------------------------- Reviews tab */
type Filter = "all" | "important" | "skipped";
function RunsTab({ runs, onOneOff }: { runs: Run[] | null; onOneOff: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [repo, setRepo] = useState("");
  const repoNames = useMemo(() => [...new Set((runs ?? []).map((r) => r.repo))].sort(), [runs]);
  if (!runs) return <div className="rv-loading" aria-busy="true" />;
  const shown = runs.filter((r) => r.kind !== "try" && (!repo || r.repo === repo) && (filter === "all" || (filter === "important" ? r.important > 0 : r.status === "skipped" || r.status === "failed")));
  const counts = { important: runs.filter((r) => r.kind !== "try" && r.important > 0).length, skipped: runs.filter((r) => r.kind !== "try" && (r.status === "skipped" || r.status === "failed")).length };
  return (
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
        <EmptyState action={<Button onClick={onOneOff}>Review a PR</Button>}>{runs.length ? "No reviews match this filter." : "No reviews yet. The first one starts when a watched repo gets a pull request, or paste a PR link to review one now."}</EmptyState>
      ) : (
        <div className="rv-runs" role="list">
          {shown.map((r) => (
            <RunRow key={r.id} r={r} />
          ))}
        </div>
      )}
    </Section>
  );
}

function RunRow({ r }: { r: Run }) {
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
        <ReviewerTag name={r.reviewer} />
        {r.kind !== "auto" && <span className="rv-run-kind">{r.kind === "command" ? "asked on GitHub" : r.kind === "oneoff" ? "one-off" : "escalated"}</span>}
      </span>
      <span className="rv-run-sev">{r.status === "done" ? <Severities v={r} compact /> : null}</span>
      <span className="rv-run-cost">{r.cost_usd ? usd(r.cost_usd) : ""}</span>
      <time className="rv-run-time" dateTime={r.started} title={new Date(r.started).toLocaleString()}>{live(r) ? elapsed(r.started) : agoLabel(r.ended ?? r.started)}</time>
    </a>
  );
}

/* ----------------------------------------------------------------------------- one review */
function RunPage({ id, reviewers, onSignIn }: { id: string; reviewers: string[]; onSignIn: () => void }) {
  const [data, setData] = useState<{ run: Run; review: Review | null } | null>(null);
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
  const { run, review } = data;
  const [tone, word] = STATUS[run.status];
  const trial = run.kind === "try";
  return (
    <Page className={`rv-page ${hueClass(run.reviewer)}`} label="Review">
      <PageHeader
        crumb={<>{crumb} / {run.repo}</>}
        title={`${run.repo} #${run.number}`}
        status={
          <span className="rv-head-status">
            <StatusDot tone={tone}>{word}</StatusDot>
            <ReviewerTag name={run.reviewer} />
            {run.status === "done" && <Severities v={run} />}
          </span>
        }
        sub={run.title}
        actions={
          <>
            {!trial && <Button onClick={() => setAgain(true)}>Review again</Button>}
            <LinkButton href={githubLink(run.review_url) ?? prUrl(run.repo, run.number)} external>{run.review_url ? "Open the review on GitHub" : "Open the PR"}</LinkButton>
          </>
        }
      />
      {error && <Banner tone="danger">{error}</Banner>}
      {trial && <Banner>A trial run: nothing was posted to GitHub. These are the findings this reviewer would have posted.</Banner>}
      {run.status === "skipped" && <Banner tone="warn">Skipped: {skipWords(run.why)}. A skip is said on the PR too, in the review's acknowledgement comment.</Banner>}
      {run.status === "failed" && <Banner tone="danger">The review didn't finish{run.why ? `: ${run.why}` : ""}. Nothing was posted. Ask again with “Review again”, or comment “@aiden review” on the PR.</Banner>}
      {review?.coverage.incomplete && <Banner tone="warn">Partial review: {review.coverage.incomplete}. Files outside the reviewed set weren't checked, so fewer findings here doesn't mean clean.</Banner>}
      <div className="ui-split">
        <div>
          {running ? (
            <Card className="rv-running">
              <StatusDot tone="busy">{run.status === "queued" ? "Waiting for a free slot" : "Reading the diff and checking each finding"}</StatusDot>
              <span className="rv-muted">Started {elapsed(run.started)} ago. This page updates when it's done.</span>
            </Card>
          ) : review ? (
            <Findings review={review} />
          ) : run.status === "done" ? (
            <EmptyState>The findings of this run are no longer kept.</EmptyState>
          ) : null}
        </div>
        <div>
          {review?.triage && (
            <Card className={`rv-triage rv-risk-${review.triage.risk}`}>
              <div className="rv-card-head">
                <b>Triage</b>
                <Tag tone={review.triage.risk === "high" ? "failed" : review.triage.risk === "trivial" ? "ok" : "neutral"}>{review.triage.risk === "high" ? "High risk" : review.triage.risk === "trivial" ? "Trivial" : "Normal risk"}</Tag>
              </div>
              <p className="rv-prose">{review.triage.summary}</p>
            </Card>
          )}
          <Card>
            <Facts
              items={[
                ["Reviewer", run.reviewer],
                ["Asked by", run.kind === "auto" ? "Repo trigger" : run.kind === "command" ? "@aiden review on GitHub" : run.kind === "oneoff" ? "One-off" : run.kind === "escalation" ? "Escalated (high risk)" : "Trial"],
                ["Head", <a key="h" className="rv-mono" href={`https://github.com/${run.repo}/commit/${run.head}`} target="_blank" rel="noreferrer noopener">{short(run.head)}</a>],
                review ? ["Scope", review.full || !review.incremental_from ? "Whole PR" : <span key="s">Changes since <span className="rv-mono">{short(review.incremental_from)}</span></span>] : null,
                review ? ["Files", `${review.coverage.reviewed.length} reviewed${review.coverage.excluded.length ? `, ${review.coverage.excluded.length} excluded` : ""}`] : null,
                ["Cost", usd(run.cost_usd)],
                ["Started", new Date(run.started).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })],
                run.ended ? ["Took", elapsed(run.started, Date.parse(run.ended))] : null,
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
      {again && <OneOffDialog reviewers={reviewers.length ? reviewers : [run.reviewer]} url={prUrl(run.repo, run.number)} reviewer={run.reviewer} onClose={() => setAgain(false)} />}
    </Page>
  );
}

function Findings({ review }: { review: Review }) {
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
                <FindingCard key={f.id} f={f} review={review} />
              ))}
            </div>
          </Section>
        ) : null;
      })}
    </>
  );
}

function FindingCard({ f, review }: { f: Finding; review: Review }) {
  const [copied, setCopied] = useState(false);
  const where = `${f.path}:${f.line}${f.end_line && f.end_line !== f.line ? `-${f.end_line}` : ""}`;
  const blob = `https://github.com/${review.repo}/blob/${review.head}/${f.path.split("/").map(encodeURIComponent).join("/")}#L${f.line}${f.end_line ? `-L${f.end_line}` : ""}`;
  // "Copy as fix brief": location, evidence and the wanted outcome, for the author's coding agent.
  const brief = [`Fix in ${review.repo} (PR #${review.pr}, ${short(review.head)}): ${f.title}`, `Where: ${where}`, `Why: ${f.why}`, `Evidence: ${f.evidence}`, `Wanted: ${f.fix_brief}`].join("\n");
  return (
    <article className={`rv-finding rv-${f.severity}`}>
      <header className="rv-finding-head">
        <h3>{f.title}</h3>
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
function OneOffDialog({ reviewers, url: url0 = "", reviewer: r0, onClose }: { reviewers: string[]; url?: string; reviewer?: string; onClose: () => void }) {
  const [url, setUrl] = useState(url0);
  const [reviewer, setReviewer] = useState(r0 ?? (reviewers.includes("standard") ? "standard" : (reviewers[0] ?? "standard")));
  const [focus, setFocus] = useState("");
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const valid = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(url.trim());
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.reviewRun({ pr_url: url.trim(), reviewer, ...(focus.trim() ? { focus: focus.trim() } : {}), ...(full ? { full } : {}) });
      location.hash = `#/reviews/r/${encodeURIComponent(r.run.id)}`;
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
          <Button variant="primary" disabled={!valid || busy} onClick={() => void run()}>{busy ? "Starting…" : "Run review"}</Button>
        </>
      }
    >
      <p>Any PR your GitHub sign-in can read. The review posts to the PR like a watched repo's would.</p>
      <Field label="Pull request" error={url && !valid ? "A PR link, like https://github.com/acme/payments/pull/42" : err || null}>
        {(id, d) => <Input id={id} aria-describedby={d} autoFocus placeholder="https://github.com/acme/payments/pull/42" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />}
      </Field>
      <div className="rv-grid2">
        <Field label="Reviewer">{(id) => <Select id={id} value={reviewer} options={reviewers.map((n) => [n, n] as const)} onChange={setReviewer} />}</Field>
        <Field label="Scope" help={full ? "Every file in the PR" : "Only what changed since the last review"}>
          {() => <Segmented label="Scope" value={full ? "full" : "new"} onChange={(v) => setFull(v === "full")} options={[["new", "New changes"], ["full", "Whole PR"]]} />}
        </Field>
      </div>
      <Field label="Focus" help="Optional: what to look at hardest, like “the retry logic” or “auth checks”.">
        {(id, d) => <Input id={id} aria-describedby={d} value={focus} maxLength={300} onChange={(e) => setFocus(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------- Repos tab */
function ReposTab({ config, repos, onEdit, onWatch }: { config: CodeReview; repos: RepoRow[] | null; onEdit: (r: RepoConfig) => void; onWatch: () => void }) {
  const row = (name: string) => repos?.find((r) => r.repo.toLowerCase() === name.toLowerCase());
  return (
    <Section title="Watched repos" count={config.repos.length} aside={<Button variant="primary" onClick={onWatch}>Watch a repo</Button>}>
      {!config.repos.length ? (
        <EmptyState action={<Button variant="primary" onClick={onWatch}>Watch a repo</Button>}>No repo is watched. Watch one to get a review on each of its pull requests.</EmptyState>
      ) : (
        <TileGrid>
          {config.repos.map((r) => {
            const live = row(r.repo);
            const cap = r.month_usd ?? REPO_DEFAULTS.month_usd;
            const spent = live?.spent_usd ?? 0;
            const id = live?.identity;
            return (
              <Tile
                key={r.repo}
                name={r.repo}
                title={r.repo}
                onOpen={() => onEdit(r)}
                status={id === undefined ? undefined : id === "app" ? <StatusDot tone="ok">Posts as the App</StatusDot> : id === "owner" ? <StatusDot tone="info">Posts as you</StatusDot> : <StatusDot tone="failed">Can't post</StatusDot>}
                facts={
                  <Tags>
                    <Tag title="When a PR opens">Open: {r.on_open === null ? "off" : (r.on_open ?? REPO_DEFAULTS.on_open)}</Tag>
                    <Tag title="On each push">Push: {r.on_push === null ? "off" : (r.on_push ?? REPO_DEFAULTS.on_push)}</Tag>
                    <Tag title="A high-risk PR escalates to">Risk: {r.on_risk === null ? "off" : (r.on_risk ?? REPO_DEFAULTS.on_risk)}</Tag>
                    {(r.drafts ?? false) && <Tag>Drafts</Tag>}
                    {(r.forks ?? "manual") === "auto" && <Tag tone="needs">Forks automatic</Tag>}
                    {r.ignore?.length ? <Tag title={r.ignore.join("\n")}>{r.ignore.length} ignored</Tag> : null}
                  </Tags>
                }
                foot={
                  <span className="rv-tile-spend">
                    <Meter value={spent / cap} tone={spent >= cap ? "failed" : spent >= cap * 0.8 ? "needs" : undefined} label={`${r.repo} spend this month`} />
                    <span>{usd(spent)} of {usd(cap, 0)} this month{live?.open_prs ? ` · ${live.open_prs} open PR${live.open_prs === 1 ? "" : "s"}` : ""}</span>
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
function RepoDialog({ config, edit, onClose, onSave }: { config: CodeReview; edit?: RepoConfig; onClose: () => void; onSave: (v: CodeReview, what: string) => Promise<void> }) {
  const [repo, setRepo] = useState(edit?.repo ?? "");
  const [f, setF] = useState({ ...REPO_DEFAULTS, ...edit, ignore: edit?.ignore ?? [] });
  const [ignoreText, setIgnoreText] = useState((edit?.ignore ?? []).join("\n"));
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ repo: string; private: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (edit) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void api.reviewAvailable(q.trim()).then((r) => setFound(r.repos), () => setFound([])), q ? 250 : 0);
    return () => clearTimeout(timer.current);
  }, [q, edit]);
  const names = Object.keys(config.reviewers);
  const opts = [...names.map((n) => [n, n] as const), ["", "Don't review"] as const];
  const watched = new Set(config.repos.map((r) => r.repo.toLowerCase()));
  const typed = /^[\w.-]+\/[\w.-]+$/.test(q.trim()) ? q.trim() : "";
  const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo) && (edit || !watched.has(repo.toLowerCase()));
  const entry = (): RepoConfig => {
    const ignore = ignoreText.split("\n").map((s) => s.trim()).filter(Boolean);
    return { repo, on_open: f.on_open || null, on_push: f.on_push || null, on_risk: f.on_risk || null, drafts: f.drafts, forks: f.forks, month_usd: f.month_usd, max_nits: f.max_nits, ...(ignore.length ? { ignore } : {}) };
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
          <Button variant="primary" disabled={!validRepo || busy || !(f.month_usd > 0)} onClick={() => void submit({ ...config, repos: edit ? config.repos.map((r) => (r.repo === edit.repo ? entry() : r)) : [...config.repos, entry()] }, edit ? `${repo} updated` : `watch ${repo}`)}>
            {busy ? "Saving…" : edit ? "Save" : "Watch repo"}
          </Button>
        </>
      }
    >
      {err && <Banner tone="danger">{err}</Banner>}
      {!edit && (
        <div className="rv-picker">
          <Field label="Repository" help={repo ? <>Selected: <b>{repo}</b></> : "Repos your GitHub sign-in can read. Type owner/name for one that isn't listed."}>
            {(id, d) => <Input id={id} aria-describedby={d} autoFocus placeholder="Search, or type acme/payments" value={q} onChange={(e) => setQ(e.target.value)} />}
          </Field>
          <div className="rv-picker-list" role="listbox" aria-label="Repositories">
            {typed && !found?.some((x) => x.repo.toLowerCase() === typed.toLowerCase()) && (
              <button type="button" role="option" aria-selected={repo === typed} className={repo === typed ? "on" : ""} onClick={() => setRepo(typed)} disabled={watched.has(typed.toLowerCase())}>
                <span>{typed}</span>
                <span className="rv-muted">{watched.has(typed.toLowerCase()) ? "already watched" : "use this name"}</span>
              </button>
            )}
            {found === null ? (
              <span className="rv-muted rv-picker-note">Loading your repos…</span>
            ) : !found.length && !typed ? (
              <span className="rv-muted rv-picker-note">{q ? "No repo matches." : "No repos found for your sign-in."}</span>
            ) : (
              found.slice(0, 40).map((x) => {
                const on = watched.has(x.repo.toLowerCase());
                return (
                  <button key={x.repo} type="button" role="option" aria-selected={repo === x.repo} className={repo === x.repo ? "on" : ""} disabled={on} onClick={() => setRepo(x.repo)}>
                    <span>{x.repo}</span>
                    <span className="rv-muted">{on ? "watched" : x.private ? "private" : "public"}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
      <div className="rv-grid3">
        <Field label="When a PR opens">{(id) => <Select id={id} value={f.on_open ?? ""} options={opts} onChange={(v) => setF({ ...f, on_open: v })} />}</Field>
        <Field label="On each push" help="Only the new changes">{(id, d) => <Select id={id} aria-describedby={d} value={f.on_push ?? ""} options={opts} onChange={(v) => setF({ ...f, on_push: v })} />}</Field>
        <Field label="High-risk PRs get" help="After triage flags it">{(id, d) => <Select id={id} aria-describedby={d} value={f.on_risk ?? ""} options={opts} onChange={(v) => setF({ ...f, on_risk: v })} />}</Field>
      </div>
      <div className="rv-grid3">
        <Field label="Monthly cap" help="Reviews past it are skipped, with a comment saying why">
          {(id, d) => (
            <span className="rv-money">
              <span aria-hidden>$</span>
              <Input id={id} aria-describedby={d} type="number" min={1} step={5} value={f.month_usd} onChange={(e) => setF({ ...f, month_usd: Number(e.target.value) })} />
            </span>
          )}
        </Field>
        <Field label="Draft PRs">{() => <span className="rv-switch"><Switch on={f.drafts} label="Review draft PRs" onChange={(on) => setF({ ...f, drafts: on })} />{f.drafts ? "Reviewed" : "Skipped"}</span>}</Field>
        <Field label="PRs from forks" help={f.forks === "manual" ? "Someone with write access comments @aiden review" : "Reviewed like any PR"}>
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

function CapDialog({ config, spent, onClose, onSave }: { config: CodeReview; spent: number; onClose: () => void; onSave: (v: CodeReview, what: string) => Promise<void> }) {
  const [cap, setCap] = useState(config.month_usd);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Monthly cap across repos"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !(cap > 0) || cap === config.month_usd} onClick={() => (setBusy(true), void onSave({ ...config, month_usd: cap }, `monthly cap $${cap}`).catch((e: Error) => (setErr(e.message), setBusy(false))))}>{busy ? "Saving…" : "Save cap"}</Button>
        </>
      }
    >
      <p>{usd(spent)} spent this month. Each repo keeps its own cap too; a review is skipped when either is reached.</p>
      <Field label="Cap" error={err || null}>
        {(id) => (
          <span className="rv-money">
            <span aria-hidden>$</span>
            <Input id={id} type="number" min={1} step={10} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
          </span>
        )}
      </Field>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------- Reviewers tab */
function ReviewersTab({ config, rows, onEdit, onNew }: { config: CodeReview; rows: ReviewerRow[] | null; onEdit: (name: string) => void; onNew: () => void }) {
  const stat = (n: string) => rows?.find((r) => r.name === n);
  const usedBy = (n: string) => config.repos.filter((r) => [r.on_open ?? REPO_DEFAULTS.on_open, r.on_push ?? REPO_DEFAULTS.on_push, r.on_risk ?? REPO_DEFAULTS.on_risk].includes(n)).length;
  return (
    <Section title="Reviewers" count={Object.keys(config.reviewers).length} hint="Each is a whole recipe: engine, model, effort, how many finders, and whether a verifier re-checks each finding." aside={<Button variant="primary" onClick={onNew}>New reviewer</Button>}>
      <TileGrid>
        {Object.entries(config.reviewers).map(([name, p]) => {
          const s = stat(name);
          const used = usedBy(name);
          return (
            <Tile
              key={name}
              name={name}
              title={p.label ?? name}
              onOpen={() => onEdit(name)}
              face={<span className={`rv-face ${hueClass(name)}`} aria-hidden>{name.slice(0, 1).toUpperCase()}</span>}
              status={p.engine !== "codex" ? <StatusDot tone="needs">Engine not built yet</StatusDot> : undefined}
              facts={
                <Tags>
                  <Tag tone="accent">{modelName(p.model)}</Tag>
                  <Tag>{p.effort} effort</Tag>
                  <Tag>{p.finders} finder{p.finders === 1 ? "" : "s"}</Tag>
                  <Tag tone={p.verify ? "ok" : "neutral"}>{p.verify ? (p.verifier ? `verified by ${modelName(p.verifier)}` : "verified") : "not verified"}</Tag>
                  {used ? <Tag title={config.repos.filter((r) => [r.on_open, r.on_push, r.on_risk].includes(name)).map((r) => r.repo).join("\n")}>{used} repo{used === 1 ? "" : "s"}</Tag> : null}
                </Tags>
              }
              foot={
                <span className="rv-tile-cost">
                  <b>{s?.avg_usd != null ? `~${usd(s.avg_usd)}` : "No runs yet"}</b>
                  {s?.avg_usd != null && <span> a review, from {s.runs} run{s.runs === 1 ? "" : "s"}</span>}
                </span>
              }
              action={<Button size="sm" onClick={() => onEdit(name)}>Edit</Button>}
            >
              {p.focus ? `Focus: ${p.focus}` : `${name === "triage" ? "Summarises each PR and labels its risk" : "General review"}, on ${p.engine}.`}
            </Tile>
          );
        })}
      </TileGrid>
    </Section>
  );
}

const BLANK: Profile = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "high", finders: 2, verify: true };

function ReviewerDialog({ config, name: name0, onClose, onSave }: { config: CodeReview; name?: string; onClose: () => void; onSave: (v: CodeReview, what: string) => Promise<void> }) {
  const [name, setName] = useState(name0 ?? "");
  const [p, setP] = useState<Profile>(name0 ? config.reviewers[name0]! : BLANK);
  const [contextText, setContextText] = useState((p.context ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [trial, setTrial] = useState<{ url: string; run?: Run; review?: Review | null; err?: string; busy?: boolean }>({ url: "" });
  const [recent, setRecent] = useState<{ url: string; repo: string; number: number; title: string }[] | null>(null);
  useEffect(() => void api.reviewRecent().then((r) => setRecent(r.prs), () => setRecent([])), []);
  const profile = (): Profile => {
    const context = contextText.split("\n").map((s) => s.trim()).filter(Boolean);
    const { context: _c, verifier, focus, label, ...rest } = p;
    return { ...rest, ...(rest.verify && verifier ? { verifier } : {}), ...(context.length ? { context } : {}), ...(focus?.trim() ? { focus: focus.trim() } : {}), ...(label?.trim() ? { label: label.trim() } : {}) };
  };
  const nameOk = /^[a-z][a-z0-9_-]{0,39}$/.test(name) && (name === name0 || !config.reviewers[name]);
  const used = config.repos.filter((r) => [r.on_open ?? REPO_DEFAULTS.on_open, r.on_push ?? REPO_DEFAULTS.on_push, r.on_risk ?? REPO_DEFAULTS.on_risk].includes(name0 ?? ""));
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
  const save = () => {
    const reviewers = Object.fromEntries(Object.entries(config.reviewers).flatMap(([k, v]) => (k === name0 ? [[name, profile()]] : [[k, v]])));
    if (!name0) reviewers[name] = profile();
    // A rename follows into each repo that named it.
    const repos = name0 && name0 !== name ? config.repos.map((r) => ({ ...r, ...Object.fromEntries((["on_open", "on_push", "on_risk"] as const).flatMap((k) => (r[k] === name0 ? [[k, name]] : []))) })) : config.repos;
    void submit({ ...config, reviewers, repos }, name0 ? `reviewer ${name} updated` : `new reviewer ${name}`);
  };
  const remove = () => {
    const reviewers = Object.fromEntries(Object.entries(config.reviewers).filter(([k]) => k !== name0));
    void submit({ ...config, reviewers }, `reviewer ${name0} removed`);
  };
  // "Try on a recent PR": one run that never posts, followed until it ends.
  const tryIt = async () => {
    setTrial({ url: trial.url, busy: true });
    try {
      const { run } = await api.reviewTry({ reviewer: profile(), pr_url: trial.url });
      setTrial({ url: trial.url, run, busy: true });
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 4_000));
        const d = await api.review(run.id);
        if (!live(d.run)) return setTrial({ url: trial.url, run: d.run, review: d.review });
        setTrial({ url: trial.url, run: d.run, busy: true });
      }
      setTrial({ url: trial.url, run, err: "Still running after ten minutes: open it from Reviews later." });
    } catch (e) {
      setTrial({ url: trial.url, err: (e as Error).message });
    }
  };
  const trialUrlOk = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(trial.url);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={name0 ? `Reviewer ${name0}` : "New reviewer"}
      actions={
        <>
          {name0 && (
            <Button variant="danger" className="rv-left" disabled={busy || used.length > 0} title={used.length ? `Used by ${used.map((r) => r.repo).join(", ")}` : undefined} onClick={remove}>
              Remove
            </Button>
          )}
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !nameOk || !p.model} onClick={save}>{busy ? "Saving…" : name0 ? "Save reviewer" : "Add reviewer"}</Button>
        </>
      }
    >
      {err && <Banner tone="danger">{err}</Banner>}
      <div className="rv-grid2">
        <Field label="Name" help="Used in @aiden review <name>" error={name && !nameOk ? (config.reviewers[name] && name !== name0 ? "That name is taken" : "Lowercase letters, digits, - or _") : null}>
          {(id, d) => <Input id={id} aria-describedby={d} autoFocus={!name0} placeholder="prod-security" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />}
        </Field>
        <Field label="Engine" help={p.engine !== "codex" ? "Saved now, but runs are refused until this engine is built" : undefined}>
          {(id, d) => <Select id={id} aria-describedby={d} value={p.engine} options={ENGINES} onChange={(v) => setP({ ...p, engine: v })} />}
        </Field>
      </div>
      <div className="rv-grid2">
        <Field label="Model">
          {(id) => (
            <>
              <Input id={id} list="rv-models" value={p.model} onChange={(e) => setP({ ...p, model: e.target.value.trim() })} />
              <datalist id="rv-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
            </>
          )}
        </Field>
        <Field label="Effort">{() => <Segmented label="Effort" value={p.effort} options={EFFORTS} onChange={(v) => setP({ ...p, effort: v })} />}</Field>
      </div>
      <div className="rv-grid3">
        <Field label="Finders" help="Parallel passes over the diff">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={8} value={p.finders} onChange={(e) => setP({ ...p, finders: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />}
        </Field>
        <Field label="Verify findings" help="Keeps only findings confirmed at a file and line">
          {() => <span className="rv-switch"><Switch on={p.verify} label="Verify findings" onChange={(on) => setP({ ...p, verify: on })} />{p.verify ? "On" : "Off"}</span>}
        </Field>
        <Field label="Verifier model" help="Empty: the same model">
          {(id, d) => <Input id={id} aria-describedby={d} list="rv-models" disabled={!p.verify} value={p.verifier ?? ""} onChange={(e) => setP({ ...p, verifier: e.target.value.trim() || undefined })} />}
        </Field>
      </div>
      <div className="rv-grid2">
        <Field label="Focus" help="What this reviewer looks for, like security or data migrations">
          {(id, d) => <textarea id={id} aria-describedby={d} className="ui-input rv-textarea" rows={2} maxLength={500} value={p.focus ?? ""} onChange={(e) => setP({ ...p, focus: e.target.value })} />}
        </Field>
        <Field label="Extra context files" help="Paths in the repo, one a line, read from the base branch">
          {(id, d) => <textarea id={id} aria-describedby={d} className="ui-input rv-textarea" rows={2} placeholder="docs/threat-model.md" value={contextText} onChange={(e) => setContextText(e.target.value)} />}
        </Field>
      </div>
      <div className="rv-try">
        <div className="rv-try-head">
          <b>Try on a recent PR</b>
          <span className="rv-muted">Runs once with these settings and shows the findings here. Nothing is posted.</span>
        </div>
        <div className="rv-inline">
          {recent?.length ? (
            <Select aria-label="Recent pull request" value={trial.url} options={[["", "Pick a recent PR…"], ...recent.slice(0, 20).map((x) => [x.url, `${x.repo} #${x.number} ${x.title.slice(0, 60)}`] as const)]} onChange={(v) => setTrial({ url: v })} />
          ) : (
            <Input aria-label="Pull request" placeholder="https://github.com/acme/payments/pull/42" value={trial.url} onChange={(e) => setTrial({ url: e.target.value.trim() })} />
          )}
          <Button disabled={!trialUrlOk || trial.busy || !p.model} onClick={() => void tryIt()}>{trial.busy ? "Running…" : "Try it"}</Button>
        </div>
        {trial.err && <Banner tone="danger">{trial.err}</Banner>}
        {trial.run && trial.busy && <StatusDot tone="busy">{trial.run.status === "queued" ? "Queued" : `Reviewing, ${elapsed(trial.run.started)}`}</StatusDot>}
        {trial.run && !trial.busy && (
          <div className="rv-try-result">
            <span className="rv-try-line">
              {trial.run.status === "done" ? <Severities v={trial.run} /> : <StatusDot tone="failed">{trial.run.status === "skipped" ? skipWords(trial.run.why) : (trial.run.why ?? "Failed")}</StatusDot>}
              <span className="rv-muted">{usd(trial.run.cost_usd)} · {trial.run.ended ? elapsed(trial.run.started, Date.parse(trial.run.ended)) : ""}</span>
              <a className="btn quiet sm" href={`#/reviews/r/${encodeURIComponent(trial.run.id)}`} onClick={onClose}>Open</a>
            </span>
            {trial.review?.findings.slice(0, 5).map((f) => (
              <span key={f.id} className={`rv-try-finding rv-${f.severity}`}>
                <i aria-hidden />
                <span className="rv-try-title">{f.title}</span>
                <span className="rv-mono rv-muted">{f.path}:{f.line}</span>
              </span>
            ))}
          </div>
        )}
      </div>
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
