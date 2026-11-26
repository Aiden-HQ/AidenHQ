// Hiring (#/team/hire): every teammate the catalog lists, official modules and every installed marketplace's (third-party
// listings included), filtered by what is available, on the team, per marketplace and by area. Hire sets one up in the
// detail pane (TeammateSetup, with its name step). "Describe who you need" hands the description to the agent holding the
// architect role, renders its answer form, and takes the short path (install, or extend a teammate) or hands off to its chat.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnswerForm } from "./AnswerForm";
import { SignInRequired, api } from "./api";
import { Markdown } from "./markdown";
import { openQuestions } from "./questions";
import { RowFace, TeammateSetup, quoted } from "./TeammateSetup";
import { TrialResult } from "./Welcome";
import { Bone } from "./Skeleton";
import type { ChatDetail, HireRow, TeammatesList, TrialView } from "./types";
import { Button, DetailPane, Disclosure, EmptyState, Face, Input, LinkButton, Page, PageHeader, Segmented, Stepper, Tag, faceProps } from "./ui";
import "./hire.css";

/** The marketplace's display name: "AidenHQ" for the official one. */
const market = (m: string) => (m === "aidenhq" ? "AidenHQ" : m.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => `${d ? " " : ""}${c.toUpperCase()}`));
const words = (r: HireRow) => [r.name, r.job, r.description, r.module, r.department, ...r.connections, ...r.requires].join(" ").toLowerCase();

export function Hire({ setup, install, chat, onSignIn }: { setup?: string; install?: string; chat?: string; onSignIn: () => void }) {
  const [data, setData] = useState<TeammatesList | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api.teammates().then(setData, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message))), [onSignIn]);
  useEffect(() => void load(), [load]);
  const [describing, setDescribing] = useState(!!chat);
  if (!data)
    return (
      <Page className="hire" label="Hire a teammate">
        <PageHeader title="Hire a teammate" sub="Each teammate does one job well." />
        {error ? <EmptyState>Couldn't load teammates: {error}</EmptyState> : <div className="hire-grid" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <Bone key={i} h={212} className="hire-bone" />)}</div>}
      </Page>
    );
  if (describing || chat) return <Describe key={chat ?? ""} data={data} chat={chat} onBack={() => (setDescribing(false), chat && location.replace("#/team/hire"))} reload={load} onSignIn={onSignIn} />;
  return <Browse data={data} setup={setup} install={install} onDescribe={() => setDescribing(true)} reload={load} onSignIn={onSignIn} />;
}

type Show = "available" | "team" | `m:${string}`;

function Browse({ data, setup, install, onDescribe, reload, onSignIn }: { data: TeammatesList; setup?: string; install?: string; onDescribe: () => void; reload: () => void; onSignIn: () => void }) {
  const rows = data.rows;
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("available");
  const [area, setArea] = useState("all");
  // The pane's teammate: ?setup=<ref> or ?install=<id> opens it; Hire on a card too.
  const [open, setOpen] = useState<string | null>(() => rows.find((r) => r.ref === setup || (install && r.id === install))?.ref ?? null);
  const markets = [...new Set(rows.map((r) => r.marketplace))].sort((a, b) => Number(b === "aidenhq") - Number(a === "aidenhq") || a.localeCompare(b));
  const areas = [...new Set(rows.map((r) => r.department))].sort();
  const onTeam = rows.filter((r) => r.onTeam).length;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => (show === "team" ? r.onTeam : !r.onTeam && (show === "available" || `m:${r.marketplace}` === show)) && (area === "all" || r.department === area) && (!t || words(r).includes(t)));
  }, [rows, q, show, area]);
  const row = rows.find((r) => r.ref === open);
  // Where the pane sits above the grid, bring it into view.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => void (open && matchMedia("(max-width: 1099px)").matches && body.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })), [open]);
  const thirdParty = markets.some((m) => m !== "aidenhq");
  const builderRow = rows.find((r) => r.module === "agent-builder");
  return (
    <Page className="hire" label="Hire a teammate">
      <PageHeader
        title="Hire a teammate"
        sub="Each teammate does one job well. Showing who you can add; your current team is under “On your team”."
        actions={<a className="hire-link" href="#/team/modules">Browse raw modules <span aria-hidden>→</span></a>}
      />
      <DescribeBand builder={data.builder} builderRow={builderRow} onDescribe={onDescribe} onHire={(r) => setOpen(r.ref)} />
      <div className="hire-controls">
        <label className="hire-search">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <Input type="search" placeholder="Search by job, name or tool" aria-label="Search teammates" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="hire-filter">
          <span className="hire-filter-label">Show</span>
          <Segmented<Show> label="Show" value={show} onChange={setShow} options={[["available", "Available"], ["team", `On your team (${onTeam})`], ...markets.map((m) => [`m:${m}`, market(m)] as const)]} />
        </span>
        {areas.length > 1 && (
          <span className="hire-filter">
            <span className="hire-filter-label">Area</span>
            <Segmented label="Area" value={area} onChange={setArea} options={[["all", "All"], ...areas.map((a) => [a, a] as const)]} />
          </span>
        )}
      </div>
      <div ref={body} className={`hire-body${row ? " paned" : ""}`}>
        {shown.length ? (
          <div className="hire-grid">
            {shown.map((r, i) => (
              <article key={r.ref} className={`hire-card ui-card lift enter${r.ref === open ? " on" : ""}`} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
                <div className="hire-card-head">
                  <RowFace row={r} size={48} />
                  <div className="hire-card-who">
                    <h3><b>{r.name}</b> · {r.job}</h3>
                    <span className="hire-card-market">{market(r.marketplace)} marketplace{r.department ? ` · ${r.department}` : ""}</span>
                  </div>
                </div>
                <p className="hire-card-desc">{r.description}</p>
                <Disclosure summary="Advanced">
                  <dl className="hire-adv">
                    <dt>Module</dt>
                    <dd><code>{r.id}</code></dd>
                    {r.requires.length > 0 && (<><dt>Turns on</dt><dd>{r.requires.join(", ")}</dd></>)}
                    {r.connections.length > 0 && (<><dt>Connects</dt><dd>{r.connections.join(", ")}</dd></>)}
                    {r.browse && (<><dt>Source</dt><dd>Listed by {market(r.marketplace)}; reviewed when installed</dd></>)}
                  </dl>
                </Disclosure>
                <div className="hire-card-foot">
                  <Tag tone={r.onTeam ? "ok" : "neutral"}>{r.onTeam ? "On your team" : "Not hired"}</Tag>
                  {r.onTeam ? (
                    <LinkButton size="sm" href={`#/team/${r.key}`}>Talk to {r.name}</LinkButton>
                  ) : (
                    <Button variant="primary" size="sm" className="press" onClick={() => setOpen(r.ref)}>Hire</Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState action={show === "available" && !thirdParty ? <LinkButton size="sm" href="#/team/modules">Add a marketplace</LinkButton> : <Button size="sm" onClick={onDescribe}>Describe who you need instead</Button>}>
            {q ? `Nothing matches “${q}”.` : show === "team" ? "Nobody from here is on your team yet." : !thirdParty ? "Everyone in the official marketplace is on your team. Add a marketplace to see more." : "Nobody here matches."}
          </EmptyState>
        )}
        {row && (
          <DetailPane open title={`Hire ${row.name}`} onClose={() => (setOpen(null), location.hash.includes("?") && location.replace("#/team/hire"))}>
            <HirePane key={row.ref} row={row} onSignIn={onSignIn} onHired={reload} />
          </DetailPane>
        )}
      </div>
    </Page>
  );
}

/**
 * The detail pane: who it is, then TeammateSetup with its name step; done, the trial's result and the way to them. A link only
 * selects the teammate: nothing is filed or started until the owner clicks Hire or Set up.
 */
function HirePane({ row, onSignIn, onHired }: { row: HireRow; onSignIn: () => void; onHired: () => void }) {
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [go, setGo] = useState(false);
  return (
    <div className="hire-pane">
      <div className="hire-pane-who">
        <RowFace row={row} size={64} />
        <div>
          <h3><b>{row.name}</b> · {row.job}</h3>
          <p>{row.description}</p>
        </div>
      </div>
      {row.sample && <blockquote className="wl-quote">{quoted(row.sample)}</blockquote>}
      {!go ? (
        <>
          <p className="hire-pane-note">
            {row.browse ? `From ${market(row.marketplace)}: its module is reviewed when it is installed. ` : ""}
            {row.requires.length ? `Turns on ${row.requires.join(", ")} with it. ` : ""}
            {row.connections.length ? "You connect what it needs next; read-only until you say otherwise." : "Nothing to connect."}
          </p>
          <Button variant="primary" className="press" onClick={() => setGo(true)}>{row.onTeam ? `Set up ${row.name}` : `Hire ${row.name}`}</Button>
        </>
      ) : (
        <TeammateSetup row={row} nameStep onDone={(r) => (setTrial(r.trial), onHired())} onSignIn={onSignIn} />
      )}
      {trial && (
        <>
          <TrialResult row={row} trial={trial} />
          <LinkButton variant="primary" href={`#/team/${row.key}`}>Open {row.name}</LinkButton>
        </>
      )}
    </div>
  );
}

/** The band above the grid: describe who you need (to the builder), or, with no builder, hire one first. */
function DescribeBand({ builder, builderRow, onDescribe, onHire }: { builder: TeammatesList["builder"]; builderRow?: HireRow; onDescribe: () => void; onHire: (r: HireRow) => void }) {
  return (
    <section className="hire-band ui-card">
      {builder ? <Face seed={builder.key} {...faceProps(builder.face)} size={48} label={builder.name} /> : builderRow ? <RowFace row={builderRow} size={48} /> : null}
      <div className="hire-band-text">
        <h2>Describe who you need</h2>
        <p>{builder ? `“Someone who prepares me for board meetings.” We check your marketplaces first, and ${builder.name} builds one only if nothing fits.` : builderRow ? `To describe a teammate, hire ${builderRow.name} (${builderRow.job}) first.` : "Describing a teammate needs an agent builder on your team."}</p>
      </div>
      {builder ? (
        <Button variant="primary" className="press" onClick={onDescribe}>Describe a teammate <span aria-hidden>→</span></Button>
      ) : builderRow && !builderRow.onTeam ? (
        <Button variant="primary" className="press" onClick={() => onHire(builderRow)}>Hire {builderRow.name}</Button>
      ) : null}
    </section>
  );
}

const EXAMPLES = ["Someone who answers customer questions in Slack", "Someone who keeps the roadmap doc current", "Someone who watches our costs every week"];
// Archie's options are checked against what this page listed, never trusted (D14): anything else is a plain answer.
const INSTALL = /^Install ([a-z0-9-]+(?:@[a-z0-9-]+)?)$/;
const EXTEND = /^Extend ([a-z0-9-]+)$/;

type Next = { kind: "install"; row: HireRow } | { kind: "extend"; row: HireRow } | { kind: "handoff" };

/** Describe → Look for existing → Set up: the description is a chat with the builder; its answer form picks the path. */
function Describe({ data, chat: chatId, onBack, reload, onSignIn }: { data: TeammatesList; chat?: string; onBack: () => void; reload: () => void; onSignIn: () => void }) {
  const builder = data.builder;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chat, setChat] = useState<ChatDetail | null>(null);
  // The accepted path, kept per chat in this tab: a reload during setup resumes it (the answered form no longer shows).
  const nextKey = `aidenhq.hire-next.${chatId ?? ""}`;
  const [next, setNextState] = useState<Next | null>(() => {
    try {
      const saved = chatId ? (JSON.parse(sessionStorage.getItem(nextKey) ?? "null") as { kind: Next["kind"]; ref?: string } | null) : null;
      if (saved?.kind === "handoff") return { kind: "handoff" };
      const row = saved?.ref ? data.rows.find((r) => r.ref === saved.ref) : undefined;
      return row && (saved?.kind === "install" || saved?.kind === "extend") ? { kind: saved.kind, row } : null;
    } catch {
      return null;
    }
  });
  const clearNext = () => {
    try {
      sessionStorage.removeItem(nextKey);
    } catch {
      /* nothing kept */
    }
  };
  const setNext = (n: Next) => {
    setNextState(n);
    try {
      sessionStorage.setItem(nextKey, JSON.stringify(n.kind === "handoff" ? n : { kind: n.kind, ref: n.row.ref }));
    } catch {
      /* no storage: the path holds for this page only */
    }
  };
  const [trial, setTrial] = useState<TrialView | null>(null);
  const fail = useCallback((e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)), [onSignIn]);
  useEffect(() => {
    if (!chatId || next) return;
    const look = () => api.chat(chatId).then(setChat, fail);
    void look();
    const t = setInterval(() => document.visibilityState === "visible" && void look(), 4000);
    return () => clearInterval(t);
  }, [chatId, next, fail]);
  const team = data.rows.filter((r) => r.onTeam).length;
  const markets = [...new Set(data.rows.map((r) => market(r.marketplace)))];
  const submit = async () => {
    if (!builder || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { identifier } = await api.newChat(text.trim(), builder.key);
      // In the address, so a reload resumes the look.
      location.hash = `#/team/hire?chat=${encodeURIComponent(identifier)}`;
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  const asking = chat && openQuestions(chat.messages);
  const answer = async (label: string) => {
    if (!chat?.state?.wait_since) throw new Error("This question was already answered or has changed.");
    await api.answer(chat.identifier, label, chat.state.wait_since);
    const inst = INSTALL.exec(label)?.[1];
    const ext = EXTEND.exec(label)?.[1];
    const installRow = inst ? data.rows.find((r) => r.id === inst && !r.onTeam) : undefined;
    const extendRow = ext ? data.rows.find((r) => r.key === ext && r.onTeam) : undefined;
    // The "Which way?" form carries Build new; any other form is a clarifying question, and the look goes on.
    const final = asking?.kind === "reply" && (asking.questions ?? []).some((q) => q.options?.includes("Build new"));
    if (installRow) setNext({ kind: "install", row: installRow });
    else if (extendRow) setNext({ kind: "extend", row: extendRow });
    else if (final) setNext({ kind: "handoff" });
    else void api.chat(chat.identifier).then(setChat, fail);
  };
  const step = !chatId ? 0 : next?.kind === "install" ? 2 : 1;
  const chatLink = builder && chatId ? `#/team/${builder.key}/c/${chatId}` : "#/team";
  return (
    <Page className="hire" label="Hire a teammate">
      <PageHeader
        crumb={<a href="#/team/hire" onClick={(e) => (e.preventDefault(), onBack())}>← Hire a teammate</a>}
        title="Describe who you need"
        sub="We look for one that already exists before building anything new · about 2 minutes if one fits"
      />
      <Stepper steps={["Describe", "Look for existing", "Set up"]} current={step} />
      {!builder ? (
        <EmptyState>Describing a teammate needs an agent builder on your team.</EmptyState>
      ) : step === 0 ? (
        <div className="hire-describe">
          <section className="hire-ask ui-card enter">
            <div className="hire-ask-head">
              <Face seed={builder.key} {...faceProps(builder.face)} size={48} label={builder.name} />
              <div>
                <h2>Who do you need?</h2>
                <p>Say it like you would to a recruiter: the job, when it happens, and what good looks like.</p>
              </div>
            </div>
            <form onSubmit={(e) => (e.preventDefault(), void submit())} className="hire-ask-form">
              <label className="ui-field-label" htmlFor="hire-job">Describe the job</label>
              <textarea id="hire-job" className="ui-input hire-textarea" rows={4} value={text} placeholder="Someone who prepares me for every board meeting: reads the deck, past minutes and open questions, and sends me a one-page brief the day before." onChange={(e) => setText(e.target.value)} />
              <div className="hire-examples">
                <span>Or start from:</span>
                {EXAMPLES.map((x) => <Button key={x} size="sm" className="press" onClick={() => setText(x)}>{x}</Button>)}
              </div>
              {error && <p className="tms-error" role="alert">{error}</p>}
              <div className="hire-ask-foot">
                <span className="hire-step-note">Step 1 of 3</span>
                <Button type="submit" variant="primary" className="press" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Look for existing teammates"}</Button>
              </div>
            </form>
          </section>
          <aside className="hire-where ui-card enter" style={{ "--i": 1 } as CSSProperties}>
            <span className="wl-label">Where we look first</span>
            <ol>
              <li><b>Your team ({team})</b><span>Someone you have may only need one more job.</span></li>
              <li><b>Your marketplaces</b><span>{markets.join(", ")}: tested teammates you install in a click.</span></li>
              <li><b>{builder.name} builds one</b><span>Only if nothing fits, reusing what you already have.</span></li>
            </ol>
            <p className="hire-step-note">Nothing is installed or run until you confirm.</p>
          </aside>
        </div>
      ) : next?.kind === "install" ? (
        <section className="hire-setup ui-card enter">
          <div className="hire-pane-who">
            <RowFace row={next.row} size={56} />
            <div>
              <h3><b>{next.row.name}</b> · {next.row.job}</h3>
              <p>{next.row.description}</p>
            </div>
          </div>
          <TeammateSetup row={next.row} nameStep onDone={(r) => (setTrial(r.trial), clearNext(), reload())} onSignIn={onSignIn} />
          {trial && (
            <>
              <TrialResult row={next.row} trial={trial} />
              <div className="hire-ask-foot"><LinkButton variant="primary" href={`#/team/${next.row.key}`}>Open {next.row.name}</LinkButton></div>
            </>
          )}
        </section>
      ) : next ? (
        <section className="hire-look ui-card enter">
          <div className="hire-ask-head">
            <Face seed={builder.key} {...faceProps(builder.face)} size={48} label={builder.name} />
            <div>
              <h2>{next.kind === "extend" ? `${builder.name} is adding this to ${next.row.name}` : `${builder.name} takes it from here`}</h2>
              <p>{next.kind === "extend" ? "You'll see the change for approval." : "The design, the build and a trial on your own data continue in your chat."}</p>
            </div>
          </div>
          <div className="hire-ask-foot"><LinkButton variant="primary" href={chatLink}>Open the chat with {builder.name}</LinkButton></div>
        </section>
      ) : (
        <section className="hire-look ui-card enter">
          <div className="hire-ask-head">
            <Face seed={builder.key} {...faceProps(builder.face)} size={48} state={asking ? "needs" : "working"} label={builder.name} />
            <div>
              <h2>{asking ? "What we found" : "Looking in your team and marketplaces first"}</h2>
              <p>{asking ? `${builder.name} checked your team and your marketplaces. Pick one; nothing is installed until you set it up.` : `${builder.name} is looking in your team and marketplaces.`}</p>
            </div>
          </div>
          {asking && asking.kind === "reply" ? (
            <div className="hire-answer">
              <Markdown text={asking.text} prefix={chat.identifier.split("-")[0] ?? ""} />
              <AnswerForm key={asking.id} questions={asking.questions ?? []} onAnswer={answer} askedAbove />
            </div>
          ) : (
            <div className="hire-skel" aria-busy="true" aria-label="Looking">
              {[0, 1, 2].map((i) => (
                <div key={i} className="hire-skel-row">
                  <Bone w={40} h={40} />
                  <span><Bone h={13} w="40%" /><Bone h={12} w={`${80 - i * 12}%`} /></span>
                </div>
              ))}
            </div>
          )}
          {error && <p className="tms-error" role="alert">{error}</p>}
          <div className="hire-ask-foot">
            <a className="hire-link" href={chatLink}>Open the chat</a>
          </div>
        </section>
      )}
    </Page>
  );
}
