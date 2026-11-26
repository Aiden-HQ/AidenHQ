import { useEffect } from "react";
import type { AppAdmins } from "./api";
import { openAsk } from "./AskAiden";
import { QUERIES, useQuery } from "./queries";
import { Updating } from "./Skeleton";
import type { AppRow } from "./types";
import { Banner, Button, Card, EmptyState, Facts, LinkButton, Meter, Monogram, Page, PageHeader, Section, StatusDot, Tag, Tags, Tile, TileGrid, hueClass, type StatusTone } from "./ui";
import { agoLabel, isLocalDoor, keepsSecureCookies } from "./util";
import "./apps.css";

// Apps (#/apps) and one app's page (#/apps/<name>): what runs on the apps platform, whether it is healthy, where it
// opens, who may open it and what was deployed. Read-only: agents deploy and maintain apps (the DevOps Engineer).

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
const ago = (ms?: number) => (ms ? agoLabel(new Date(ms).toISOString()) : "");
const short = (sha?: string) => sha?.slice(0, 7);

/** apps-mcp's state (healthy, unhealthy, failed, not deployed, unknown) in the board's status vocabulary. */
export function appStatus(a: AppRow): { tone: StatusTone; word: string } {
  if (a.healthy) return { tone: "ok", word: "Running" };
  if (a.state === "unhealthy") return { tone: "failed", word: "Unhealthy" };
  if (a.state === "failed") return { tone: "failed", word: "Deploy failed" };
  if (a.state === "not deployed") return { tone: "idle", word: "Not deployed" };
  return { tone: "idle", word: "Checking" };
}

/** Who may open it, from the kernel's app access (an app's default role; blocked: only people its admins add). Nothing
 *  when the kernel lists no access for it (not shared through the gate) or hasn't answered yet. */
function access(admins?: AppAdmins) {
  if (!admins) return null;
  return admins.default === "blocked" ? "People its admins add" : `Everyone signed in, as ${admins.default}`;
}

const DEPLOY_TONE: Record<string, StatusTone> = { healthy: "ok", failed: "failed", build_failed: "failed", rolled_back: "idle" };
const DEPLOY_WORD: Record<string, string> = { healthy: "Healthy", failed: "Failed", build_failed: "Build failed", rolled_back: "Rolled back" };

export function AppsView({ app, onSignIn }: { app?: string; onSignIn: () => void }) {
  const { data, stale, error, reload } = useQuery(QUERIES.apps, onSignIn);
  const { data: acc } = useQuery(QUERIES.appAccess, onSignIn);
  useEffect(() => {
    const poll = setInterval(() => document.visibilityState === "visible" && void reload(), 10_000);
    return () => clearInterval(poll);
  }, [reload]);
  const admins = (name: string) => acc?.apps.find((x) => x.app === name);
  if (app) {
    const a = data?.apps.find((x) => x.name === app);
    if (a) return <AppPage a={a} admins={admins(a.name)} />;
    return (
      <Page>
        <PageHeader crumb={<><a href="#/apps">Apps</a> / {app}</>} title={app} />
        {data ? <EmptyState action={<LinkButton href="#/apps">All apps</LinkButton>}>No app named {app} runs here.</EmptyState> : <div className="apps-skeleton" aria-busy="true" />}
      </Page>
    );
  }

  // What needs attention first: broken, then not running yet, then running.
  const rank = (a: AppRow) => ["failed", "idle", "ok"].indexOf(appStatus(a).tone);
  const apps = [...(data?.apps ?? [])].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  const sick = apps.filter((a) => appStatus(a).tone === "failed").length;
  const running = apps.filter((a) => a.healthy).length;
  return (
    <Page>
      <PageHeader
        title="Apps"
        sub={
          <>
            {!data ? "Checking your apps…" : !apps.length ? "Nothing deployed yet." : `${running} of ${apps.length} running${sick ? `, ${sick} need${sick > 1 ? "" : "s"} attention` : ""}. Agents build, deploy and look after them.`}
            <Updating on={stale} />
          </>
        }
      />
      {error && <Banner tone="danger">Couldn't load apps: {error}</Banner>}
      {data?.error && <Banner tone="warn">The apps platform didn't answer: {data.error}</Banner>}
      {data?.node?.login_url && (
        <Banner tone="warn">
          Agent-built apps need one Tailscale sign-in. <a href={data.node.login_url} target="_blank" rel="noreferrer">Approve the apps node</a> as yourself; apps then open on your tailnet.
        </Banner>
      )}
      {!data ? (
        !error && <TileGrid>{[0, 1, 2].map((i) => <div key={i} className="apps-skeleton" aria-hidden />)}</TileGrid>
      ) : !apps.length ? (
        !data.error && <EmptyState action={<Button variant="primary" onClick={() => openAsk({ chat: "" })}>Ask Aiden</Button>}>No apps yet. Ask Aiden for one; it shows here once it is deployed.</EmptyState>
      ) : (
        <TileGrid>
          {apps.map((a) => <AppTile key={a.name} a={a} admins={admins(a.name)} />)}
        </TileGrid>
      )}
    </Page>
  );
}

/**
 * The way into an app: Open where this browser can sign in; a local door doesn't open in Safari (it keeps no Secure cookie
 * on plain http), so there a Copy link; no door yet: nothing (the tile or page says why).
 */
function OpenAction({ a, secureCookies, primary }: { a: AppRow; secureCookies: boolean; primary?: boolean }) {
  if (!a.url) return null;
  if (isLocalDoor(a.url) && !secureCookies)
    return (
      <Button size={primary ? undefined : "sm"} onClick={() => void navigator.clipboard?.writeText(a.url!)}>
        Copy link
      </Button>
    );
  return (
    <LinkButton variant={primary ? "primary" : undefined} size={primary ? undefined : "sm"} href={a.url} external>
      Open
    </LinkButton>
  );
}

/** Why it can't be opened, in apps-mcp's words; or that this browser can't sign in to a local door. */
function doorNote(a: AppRow, secureCookies: boolean) {
  if (!a.url && a.unpublished) return typeof a.unpublished === "string" ? a.unpublished : "Opens in a browser through Tailscale's apps node or a shared host.";
  if (isLocalDoor(a.url) && !secureCookies) return "Apps open in Chrome or Firefox on this Mac.";
  return null;
}

export function AppTile({ a, admins, secureCookies = keepsSecureCookies() }: { a: AppRow; admins?: AppAdmins; secureCookies?: boolean }) {
  const s = appStatus(a);
  const note = a.incident?.detail ?? doorNote(a, secureCookies);
  return (
    <Tile
      href={`#/apps/${a.name}`}
      name={a.name}
      title={a.name}
      tone={s.tone === "failed" ? "failed" : undefined}
      status={<StatusDot tone={s.tone}>{s.word}</StatusDot>}
      facts={
        <>
          {a.sha && <span title={a.deployed_by ? `deployed by ${a.deployed_by}` : undefined}><code>{short(a.sha)}</code> {ago(a.deployed_at)}</span>}
          {access(admins) && <span>{access(admins)}</span>}
          {a.stats && <span>{mb(a.stats.mem_bytes)} of {mb(a.stats.mem_limit_bytes)}</span>}
        </>
      }
      foot={note ?? (a.url ? a.url.replace(/^https?:\/\//, "") : a.state === "failed" ? "Its last deploy failed: open it for the deploys." : undefined)}
      action={<OpenAction a={a} secureCookies={secureCookies} />}
    >
      {a.owner ? `Looked after by ${a.owner}.` : "No agent looks after it."}
    </Tile>
  );
}

function AppPage({ a, admins, secureCookies = keepsSecureCookies() }: { a: AppRow; admins?: AppAdmins; secureCookies?: boolean }) {
  const s = appStatus(a);
  const note = doorNote(a, secureCookies);
  const mem = a.stats ? a.stats.mem_bytes / (a.stats.mem_limit_bytes || 1) : 0;
  return (
    <Page className={hueClass(a.name)}>
      <PageHeader
        crumb={<><a href="#/apps">Apps</a> / {a.name}</>}
        face={<Monogram name={a.name} size={44} />}
        square
        title={a.name}
        status={
          <>
            <StatusDot tone={s.tone}>{s.word}</StatusDot>
            {a.sha && <span>{short(a.sha)} deployed {ago(a.deployed_at)}{a.deployed_by ? ` by ${a.deployed_by}` : ""}</span>}
          </>
        }
        sub={a.url ? <a className="apps-url" href={a.url} target="_blank" rel="noreferrer noopener">{a.url.replace(/^https?:\/\//, "")}</a> : note}
        actions={<OpenAction a={a} secureCookies={secureCookies} primary />}
      />
      {a.incident && (
        <Banner tone="danger">
          <b>Incident ({a.incident.kind})</b>, opened {agoLabel(a.incident.opened_at)}: {a.incident.detail}
        </Banner>
      )}
      {a.url && note && <Banner tone="warn">{note}</Banner>}
      <div className="ui-split">
        <div>
          <Section title="Deploys" count={a.deploys?.length ?? 0} hint="Newest first: which commit, by whom, and how it ended.">
            {a.deploys?.length ? (
              <div className="ui-rows">
                {a.deploys.map((d, i) => (
                  <div key={`${d.sha}-${i}`} className="apps-deploy">
                    <StatusDot tone={DEPLOY_TONE[d.status] ?? "idle"}>{DEPLOY_WORD[d.status] ?? d.status}</StatusDot>
                    <code>{short(d.sha)}</code>
                    <span className="apps-deploy-by">{d.by}</span>
                    <time dateTime={new Date(d.at).toISOString()} title={new Date(d.at).toLocaleString()}>{ago(d.at)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>Not deployed yet. The DevOps Engineer deploys it once its first change is merged.</EmptyState>
            )}
          </Section>
        </div>
        <div>
          <Section title="Health">
            <Card>
              <Facts
                items={[
                  ["State", <StatusDot key="s" tone={s.tone}>{s.word}</StatusDot>],
                  a.stats && ["CPU", `${a.stats.cpu_pct.toFixed(0)}%`],
                  a.stats && ["Memory", <div key="m" className="apps-mem"><span>{mb(a.stats.mem_bytes)} of {mb(a.stats.mem_limit_bytes)}</span><Meter value={mem} tone={mem > 0.85 ? "needs" : undefined} label="Memory" /></div>],
                ]}
              />
            </Card>
          </Section>
          <Section title="Access">
            <Card>
              <Facts
                items={[
                  ["Who can open it", access(admins) ?? <span className="ui-none">not shared through a sign-in</span>],
                  admins && ["Its admins", admins.admins.length ? <Tags key="a">{admins.admins.map((e) => <Tag key={e}>{e}</Tag>)}</Tags> : <span className="ui-none">none yet</span>],
                ]}
              />
              {admins && <p><a href={`https://${admins.host}/.aidenhq/access`} target="_blank" rel="noreferrer noopener">Manage who can open it</a> on its access page.</p>}
            </Card>
          </Section>
          <Section title="About">
            <Card>
              <Facts
                items={[
                  ["Looked after by", a.owner ?? <span className="ui-none">no agent</span>],
                  ["Deploys", a.auto_deploy === false ? "When an agent asks" : "Each merged change"],
                  !!a.repo && ["Source", <code key="r">{a.repo}</code>],
                  !!a.panel && ["In the nav", a.panel],
                ]}
              />
            </Card>
          </Section>
        </div>
      </div>
    </Page>
  );
}
