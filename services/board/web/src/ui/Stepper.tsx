// Where the owner is in a short flow: "Step 1 of 3 · Your first teammate" and one bar per step. `current` is 0-based;
// `label` leads (the flow's name, e.g. "Getting started").
export function Stepper({ steps, current, label }: { steps: string[]; current: number; label?: React.ReactNode }) {
  const at = Math.min(Math.max(current, 0), steps.length - 1);
  const text = `Step ${at + 1} of ${steps.length} · ${steps[at] ?? ""}`;
  return (
    <div className="ui-stepper">
      {label && <span className="ui-stepper-label">{label}</span>}
      <span className="ui-stepper-text">{text}</span>
      <span className="ui-stepper-bars" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={at + 1} aria-valuetext={text}>
        {steps.map((s, i) => <i key={s} className={i <= at ? "on" : undefined} />)}
      </span>
    </div>
  );
}
