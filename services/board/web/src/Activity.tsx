// Activity: what each agent did, by day, with a link to the chat.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import type { ActivityItem } from "./types";

export function ActivityView({ onSignIn }: { onSignIn: () => void }) {
  const [days, setDays] = useState<{ day: string; items: ActivityItem[] }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => api.activity(7).then((r) => setDays(r.days), (e: Error) => (e instanceof SignInRequired ? onSignIn() : setError(e.message)));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [onSignIn]);
  const label = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="page-sub">What your agents finished in the last 7 days</p>
        </div>
      </header>
      {error && <div className="alert">{error}</div>}
      {!days ? (
        <span className="spinner" />
      ) : !days.length ? (
        <p className="empty-state">Nothing finished in the last week yet.</p>
      ) : (
        days.map((d) => (
          <section key={d.day} className="activity-day">
            <h3>{label(d.day)}</h3>
            <ul>
              {d.items.map((i, n) => (
                <li key={`${i.chat}-${n}`} className={i.kind === "failed" ? "activity-failed" : ""}>
                  <time>{new Date(i.when).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
                  <span className={`activity-dot${i.kind === "failed" ? " bad" : ""}`} aria-hidden />
                  <a href={i.link}>{i.sentence}</a>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
