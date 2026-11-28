// Form parts. A Field is a label, a control, and one line under it: help, or the error when there is one. A FieldRow is a
// setting on a settings page: its name and help on the left, its value or control on the right.
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

export function Field({ label, help, error, children }: { label: string; help?: ReactNode; error?: string | null; children: (id: string, describedBy: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>{label}</label>
      {children(id, `${id}-note`)}
      {error ? <span id={`${id}-note`} className="ui-field-error" role="alert">{error}</span> : help ? <span id={`${id}-note`} className="ui-field-help">{help}</span> : null}
    </div>
  );
}

export const Input = ({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) => <input className={`ui-input ${className}`} {...rest} />;

export function Select<T extends string>({ value, options, onChange, className = "", ...rest }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void } & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select className={`ui-select ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)} {...rest}>
      {options.map(([v, name]) => (
        <option key={v} value={v}>{name}</option>
      ))}
    </select>
  );
}

/** On or off. `danger`: off shows red, for a switch where turning it off is the decision (a module, a kill switch). */
export function Switch({ on, onChange, label, disabled, danger }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; danger?: boolean }) {
  return <button type="button" className={`ui-switch${danger ? " danger" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

/** Several choices from a short list. */
export function Checks<T extends string>({ options, value, onChange, label, disabled }: { options: readonly T[]; value: readonly T[]; onChange: (v: T[]) => void; label: string; disabled?: boolean }) {
  return (
    <div className="ui-checks" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <label key={o} className={`ui-check${on ? " on" : ""}`}>
            <input type="checkbox" checked={on} disabled={disabled} onChange={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])} />
            {o}
          </label>
        );
      })}
    </div>
  );
}

export function FieldRow({ title, help, children }: { title: ReactNode; help?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-field-row">
      <div className="ui-field-row-text">
        <b>{title}</b>
        {help && <span>{help}</span>}
      </div>
      {children && <div className="ui-field-row-control">{children}</div>}
    </div>
  );
}
