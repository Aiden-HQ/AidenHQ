// A sign-in's own report (SignIn.lines): "Connected as @login" and one row per thing it can say works or doesn't, each with
// its one fix. The board knows nothing of the vendor: a link goes where the proxy says (the vendor's https page in a new tab,
// or a board path such as a module's settings, or a page on the kernel's admin listener), and Reconnect is the sign-in's own
// Connect. A row's suggestion (its hint and action) can be dismissed for good (its `dismiss` key): the row stays, without it.
import { useState } from "react";
import { ConnectButton, type Connectable } from "./Connect";
import { admin, api } from "./api";
import type { SignIn } from "./connections";
import { Button, LinkButton, StatusDot, type StatusTone } from "./ui";
import { clockOpts } from "./util";

const TONE = { ok: "ok", warn: "needs", error: "failed" } as const satisfies Record<string, StatusTone>;
const localTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { ...clockOpts() });

/** How many rows need the owner (the tile's hint). */
export const linesNeeding = (s: SignIn | null) => (s?.state === "ok" ? (s.lines ?? []).filter((l) => l.state !== "ok").length : 0);

export function SignInLines({ c, can }: { c: Connectable & { signIn: SignIn | null }; can: boolean }) {
  const s = c.signIn;
  // Dismissed here: hidden at once, and the board serves the row without its suggestion from now on.
  const [gone, setGone] = useState<string[]>([]);
  if (!s?.lines?.length || s.state !== "ok") return null;
  const dismiss = (key: string) => void api.signInDismiss(c.id, key).then(() => setGone((g) => [...g, key]), () => {});
  return (
    <section className="st-lines" aria-label={`${c.label} state`}>
      {s.login && (
        <h3 className="st-lines-head">
          Connected as <b>@{s.login}</b>
        </h3>
      )}
      <ul>
        {s.lines.map((full) => {
          const l = full.dismiss && gone.includes(full.dismiss) ? { ...full, hint: undefined, action: undefined, dismiss: undefined } : full;
          return (
            <li key={l.label} className={`st-line st-line-${l.state}`}>
              <span className="st-line-label">{l.label}</span>
              <StatusDot tone={TONE[l.state]}>
                {l.value}
                {l.time && !Number.isNaN(Date.parse(l.time)) ? ` ${localTime(l.time)}` : null}
              </StatusDot>
              <span className="st-line-act">
                {l.action?.href && /^(https:\/\/|#\/)/.test(l.action.href) ? (
                  <LinkButton size="sm" href={l.action.href} external={l.action.href.startsWith("https://")}>
                    {l.action.label}
                  </LinkButton>
                ) : l.action?.admin && /^\/[a-z0-9/-]{1,60}$/.test(l.action.admin) && can ? (
                  <LinkButton size="sm" href={`${admin.url}${l.action.admin}`}>
                    {l.action.label}
                  </LinkButton>
                ) : l.action?.reconnect && can ? (
                  <ConnectButton c={c} size="sm" word={l.action.label} />
                ) : null}
                {l.dismiss && can ? (
                  <Button size="sm" variant="quiet" onClick={() => dismiss(l.dismiss!)}>
                    Dismiss
                  </Button>
                ) : null}
              </span>
              {l.hint ? <small className="st-line-hint">{l.hint}</small> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
