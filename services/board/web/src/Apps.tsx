import { useEffect } from "react";
import { QUERIES, useQuery } from "./queries";
import { CardGridSkeleton, Updating } from "./Skeleton";
import { agoLabel } from "./util";

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** The apps platform, read-only: what runs, whether it's healthy, who owns it, and any open incident. */
export function AppsView({ onSignIn }: { onSignIn: () => void }) {
  const { data, stale, error, reload } = useQuery(QUERIES.apps, onSignIn);

  useEffect(() => {
    const poll = setInterval(() => document.visibilityState === "visible" && void reload(), 10_000);
    return () => clearInterval(poll);
  }, [reload]);

  const sick = data?.apps.filter((a) => !a.healthy).length ?? 0;
  return (
    <main className="page wide">
      <header className="page-head">
        <div>
          <h1>Apps</h1>
          <p className="page-sub">
            {!data ? "Checking your apps…" : !data.apps.length ? "Nothing deployed yet" : `${data.apps.length} running${sick ? ` · ${sick} need${sick > 1 ? "" : "s"} attention` : " · all healthy"}`}
            <Updating on={stale} />
          </p>
        </div>
      </header>
      {error && <div className="offline">Couldn't load apps: {error}</div>}
      {data?.error && <div className="offline">Apps service: {data.error}</div>}
      {!data ? (
        !error && <CardGridSkeleton count={3} />
      ) : !data.apps.length ? (
        !data.error && <p className="empty-state">No apps yet. Ask the Architect for one in Chat; it shows here once deployed.</p>
      ) : (
        <div className="app-grid">
          {data.apps.map((a) => (
            <article key={a.name} className={`app-card${a.healthy ? "" : " sick"}`}>
              <header className="app-card-head">
                <h3>{a.name}</h3>
                <span className={`pill ${a.healthy ? "pill-working" : "pill-failed"}`}>{a.healthy ? "Healthy" : a.state}</span>
                {a.url ? (
                  <a className="btn" href={a.url} target="_blank" rel="noreferrer noopener">
                    Open
                  </a>
                ) : (
                  a.unpublished && (
                    <span className="muted" title="Apps require a signed-in visitor, and this server has no door that signs one in yet">
                      Add a domain or turn on Tailscale to open apps in a browser
                    </span>
                  )
                )}
              </header>
              <dl className="panel-facts">
                {a.owner && (
                  <>
                    <dt>Owner</dt>
                    <dd>{a.owner}</dd>
                  </>
                )}
                {a.sha && (
                  <>
                    <dt>Version</dt>
                    <dd className="mono">
                      {a.sha.slice(0, 8)}
                      {a.deployed_at && <span className="muted"> · deployed {agoLabel(a.deployed_at)}</span>}
                    </dd>
                  </>
                )}
                {a.stats && (
                  <>
                    <dt>Load</dt>
                    <dd>
                      {a.stats.cpu_pct.toFixed(0)}% CPU · {mb(a.stats.mem_bytes)} of {mb(a.stats.mem_limit_bytes)}
                      <div className="meter" aria-hidden>
                        <i style={{ width: `${Math.min(100, (100 * a.stats.mem_bytes) / (a.stats.mem_limit_bytes || 1))}%` }} />
                      </div>
                    </dd>
                  </>
                )}
              </dl>
              {a.incident && (
                <p className="app-incident">
                  <b>Incident ({a.incident.kind})</b>, opened {agoLabel(a.incident.opened_at)}: {a.incident.detail}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
