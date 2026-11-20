// A sign-in's own report (SignIn.lines): "Connected as @login" and one row per thing it can say works or doesn't, each with
// its one fix. The board knows nothing of the vendor: a link goes where the proxy says (GitHub's page, never a board host),
// and Reconnect is the sign-in's own Connect.
import { ConnectButton, type Connectable } from "./Connect";
import type { SignIn } from "./connections";
import { LinkButton, StatusDot, type StatusTone } from "./ui";

const TONE = { ok: "ok", warn: "needs", error: "failed" } as const satisfies Record<string, StatusTone>;

/** How many rows need the owner (the tile's hint). */
export const linesNeeding = (s: SignIn | null) => (s?.state === "ok" ? (s.lines ?? []).filter((l) => l.state !== "ok").length : 0);

export function SignInLines({ c, can }: { c: Connectable & { signIn: SignIn | null }; can: boolean }) {
  const s = c.signIn;
  if (!s?.lines?.length || s.state !== "ok") return null;
  return (
    <section className="st-lines" aria-label={`${c.label} state`}>
      {s.login && (
        <h3 className="st-lines-head">
          Connected as <b>@{s.login}</b>
        </h3>
      )}
      <ul>
        {s.lines.map((l) => (
          <li key={l.label} className={`st-line st-line-${l.state}`}>
            <span className="st-line-label">{l.label}</span>
            <StatusDot tone={TONE[l.state]}>{l.value}</StatusDot>
            <span className="st-line-act">
              {l.action?.href ? (
                <LinkButton size="sm" href={l.action.href} external>
                  {l.action.label}
                </LinkButton>
              ) : l.action?.reconnect && can ? (
                <ConnectButton c={c} size="sm" word={l.action.label} />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
