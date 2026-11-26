// Home on day one (Home.tsx, when /api/home has `start`): the last step of onboarding while this tab finishes it, the
// teammate the owner queued next (Set up, or Later) beside Needs you, and the rest of the team he can bring in below. The
// first result itself is Home's own blocks; nothing here repeats them.
import { useState, type CSSProperties } from "react";
import { SignInRequired, api } from "./api";
import type { HireRow, HomeStart } from "./types";
import { quoted } from "./TeammateSetup";
import { Button, Face, LinkButton, Stepper, faceProps } from "./ui";
import { WELCOME_SESSION } from "./Welcome";
import "./onboarding.css";

const welcoming = () => {
  try {
    return sessionStorage.getItem(WELCOME_SESSION) === "1";
  } catch {
    return false;
  }
};

/** "Step 3 of 3 · Your home", above Home's greeting, while this tab finishes onboarding. */
export const WelcomeStepper = () => (welcoming() ? <Stepper steps={["Your first teammate", "Where we reach you", "Your home"]} current={2} label="Getting started" /> : null);

/** The teammate the owner queued next: Set up opens it on the hiring page; Later moves it to his later list. */
export function NextUp({ next, reload }: { next: HireRow; reload: () => void }) {
  const [error, setError] = useState("");
  const later = async () => {
    setError("");
    try {
      const q = await api.teammateQueue();
      await api.setTeammateQueue({ ...q, next: q.next.filter((r) => r !== next.ref), later: [...q.later.filter((r) => r !== next.ref), next.ref].slice(-20) });
      reload();
    } catch (e) {
      setError(e instanceof SignInRequired ? "Sign in again to change this." : (e as Error).message);
    }
  };
  return (
    <section className="gs-next ui-card" aria-label="Next up">
      <span className="wl-label">Next up</span>
      <div className="gs-next-who">
        <Face seed={next.key} {...faceProps(next.face)} size={56} label={next.name} />
        <span className="gs-next-name">
          <b>{next.name}</b> · {next.job}
        </span>
      </div>
      <p className="gs-next-desc">{next.description}</p>
      {next.sample && <blockquote className="wl-quote">{quoted(next.sample)}</blockquote>}
      <div className="gs-next-actions">
        <LinkButton variant="primary" size="sm" href={`#/team/hire?setup=${encodeURIComponent(next.ref)}`}>Set up {next.name}</LinkButton>
        <Button variant="quiet" size="sm" className="press" onClick={() => void later()}>Later</Button>
        {error && <span className="wl-bad" role="alert">{error}</span>}
      </div>
    </section>
  );
}

/** The rest of the catalog's teammates as a row of faces, and the way to all of them. */
export function MoreTeam({ more }: { more: HomeStart["more"] }) {
  if (!more.length) return null;
  return (
    <section className="gs-more ui-card enter" style={{ "--i": 3 } as CSSProperties} aria-label="More your team can do">
      <b className="gs-more-title">More your team can do</b>
      <span className="gs-faces">
        {more.slice(0, 8).map((m) => <Face key={m.key} seed={m.key} {...faceProps(m.face)} size={32} label={`${m.name} · ${m.job}`} />)}
      </span>
      <span className="gs-more-line">{more.length === 1 ? "One more teammate" : `${more.length} more teammates`}, set up one at a time</span>
      <a className="wl-link" href="#/team/hire">See everyone <span aria-hidden>→</span></a>
    </section>
  );
}
