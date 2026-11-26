// A teammate's face, and its state at a glance: working (it bobs and looks side to side, green dot), needs you (brows up,
// mouth open, an amber ring pulsing) or idle (grey dot). Every face blinks. Drawn from the module's kit spec, else from
// the seed (the agent's key, so a rename never changes it); a module that ships an image gets the same ring and dot over
// it. Motion is CSS (ui.css .ui-face*), so reduced motion stills it. The label carries the state: never colour alone.
import { useState, type CSSProperties } from "react";
import type { RosterFace } from "../types";
import { ACCESSORY, BODY, EXPRESSION, HAIR, blinkSeconds, kitFromSeed, type FaceKit, type FaceState } from "./face-kit";

const WORDS: Record<FaceState, string> = { idle: "idle", working: "working", needs: "needs you" };
const DOT: Record<FaceState, string> = { idle: "var(--faint)", working: "var(--working)", needs: "var(--warn)" };
const fill = (c: string): CSSProperties => ({ fill: c });

/** A roster face (`{src}` | `{kit}` | null) as Face's props. */
export function faceProps(face: RosterFace | null | undefined): { src?: string; kit?: FaceKit } {
  if (!face) return {};
  return "src" in face ? { src: face.src } : { kit: face.kit };
}

export function Face({ seed, src, kit, state = "idle", size = 32, label }: { seed: string; src?: string | null; kit?: FaceKit | null; state?: FaceState; size?: number; label: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const px = Math.min(96, Math.max(16, Math.round(size)));
  const image = src && broken !== src ? src : null;
  const style = { width: px, height: px, "--blink": `${blinkSeconds(seed)}s` } as CSSProperties;
  const ring = state === "needs" && <circle className="ui-face-ring" cx="50" cy="50" r="47" fill="none" strokeWidth="3" style={{ stroke: "var(--warn)" }} />;
  const dot = px >= 28 && (
    <>
      <circle cx="84" cy="84" r="9" style={fill("var(--surface)")} />
      <circle cx="84" cy="84" r="6.5" style={fill(DOT[state])} />
    </>
  );
  return (
    <span className={`ui-face ui-face-${state}`} style={style} role="img" aria-label={`${label}, ${WORDS[state]}`}>
      {image ? (
        <>
          <img className="ui-face-img" src={image} alt="" onError={() => setBroken(image)} />
          <svg viewBox="0 0 100 100" aria-hidden>{ring}{dot}</svg>
        </>
      ) : (
        <KitSvg kit={kit ?? kitFromSeed(seed)} state={state} ring={ring} dot={dot} />
      )}
    </span>
  );
}

function KitSvg({ kit, state, ring, dot }: { kit: FaceKit; state: FaceState; ring: React.ReactNode; dot: React.ReactNode }) {
  const skin = fill(`var(--face-skin-${kit.skin})`);
  const hair = fill(`var(--face-hair-${kit.hair_color})`);
  const brow: CSSProperties = { stroke: `var(--face-brow-${kit.hair_color})` };
  const look = EXPRESSION[state];
  const acc = kit.accessory === "none" ? null : ACCESSORY[kit.accessory];
  const body = kit.body === "none" ? null : BODY[kit.body];
  return (
    <svg viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="48" style={fill(`var(--face-bg-${kit.palette})`)} />
      {ring}
      <g className="ui-face-bob">
        <path d="M17 104 C17 80 33 71 50 71 C67 71 83 80 83 104 Z" style={fill(`var(--face-shirt-${kit.palette})`)} />
        {body && <path d={body.d} strokeWidth={body.width} style={{ fill: body.fill, stroke: body.stroke }} />}
        <rect x="44" y="64" width="12" height="10" rx="4" style={skin} />
        {HAIR[kit.hair].back !== "M0 0" && <path d={HAIR[kit.hair].back} style={hair} />}
        <ellipse cx="50" cy="46" rx="24" ry="25" style={skin} />
        <ellipse cx="26.5" cy="49" rx="3.5" ry="5" style={skin} />
        <ellipse cx="73.5" cy="49" rx="3.5" ry="5" style={skin} />
        <path d={HAIR[kit.hair].top} style={hair} />
        <circle cx="35" cy="56" r="4" fillOpacity="0.22" style={fill("var(--face-blush)")} />
        <circle cx="65" cy="56" r="4" fillOpacity="0.22" style={fill("var(--face-blush)")} />
        <path d={look.browL} fill="none" strokeWidth="2.4" strokeLinecap="round" style={brow} />
        <path d={look.browR} fill="none" strokeWidth="2.4" strokeLinecap="round" style={brow} />
        <ellipse cx="41" cy="48" rx="5.6" ry="6.2" style={fill("var(--face-eye)")} />
        <ellipse cx="59" cy="48" rx="5.6" ry="6.2" style={fill("var(--face-eye)")} />
        <g className="ui-face-look">
          <circle cx="41.5" cy="49" r="3.2" style={fill("var(--face-ink)")} />
          <circle cx="59.5" cy="49" r="3.2" style={fill("var(--face-ink)")} />
          <circle cx="42.6" cy="47.6" r="1.1" style={fill("var(--face-eye)")} />
          <circle cx="60.6" cy="47.6" r="1.1" style={fill("var(--face-eye)")} />
        </g>
        <rect className="ui-face-lid" x="34" y="41.5" width="32" height="13" style={skin} />
        <path d={look.mouth} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ fill: look.open ? "var(--face-mouth)" : "none", stroke: "var(--face-mouth)" }} />
        {acc && <path d={acc.d} strokeWidth={acc.width} strokeLinecap="round" strokeLinejoin="round" style={{ fill: acc.fill, stroke: acc.stroke }} />}
      </g>
      {dot}
    </svg>
  );
}
