// A module page's Sign-ins panel (board.pages secret_maps), drawn by the board under the page's frame: per key (an app) Set, Replace
// or Clear one entry of a JSON-map secret. The values go from here to the kernel's vault as the signed-in admin and never come back:
// the board only ever learns which keys are set, and the fields are emptied once a save lands.
import { useCallback, useEffect, useState } from "react";
import { api, SignInRequired } from "./api";
import type { SecretMapView } from "./types";
import { Button, Field, Input, Section, StatusDot } from "./ui";

type Key = SecretMapView["keys"][number];

export function SecretMaps({ page, reload, onSignIn }: { page: string; /** Changes when the page starts over (a saved setting went live): the keys are read again. */ reload: number; onSignIn: () => void }) {
  const [maps, setMaps] = useState<SecretMapView[]>([]);
  const [open, setOpen] = useState<{ secret: string; key: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const read = useCallback(() => api.pageSecrets(page).then((r) => setMaps(r.maps), (e: Error) => (e instanceof SignInRequired ? onSignIn() : setMaps([]))), [page, onSignIn]);
  useEffect(() => void read(), [read, reload]);
  const close = () => (setOpen(null), setValues({}));
  async function send(m: SecretMapView, k: Key, v: Record<string, string> | null) {
    setBusy(true);
    setSaid("");
    try {
      await api.pageSecretSet(page, m.secret, k.key, v);
      setSaid(v ? `Saved the sign-in for ${k.key}.` : `Cleared the sign-in for ${k.key}.`);
      close();
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      else setSaid(`Not saved: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      void read();
    }
  }
  if (!maps.some((m) => m.keys.length)) return null;
  return (
    <>
      {maps.map((m) => (
        <Section key={m.secret} title="Sign-ins" hint="Kept in the vault. A saved value is never shown again: Replace sets a new one.">
          <div className="mod-rows mv-signins">
            {m.keys.map((k) => {
              const editing = open?.secret === m.secret && open.key === k.key;
              return (
                <div key={k.key} className="mv-signin">
                  <div className="mv-signin-row">
                    <b className="mv-signin-key">{k.key}</b>
                    <StatusDot tone={k.set ? "ok" : "idle"}>{k.set ? "Set" : "Not set"}</StatusDot>
                    <span className="mv-signin-actions">
                      {k.listed && !editing && <Button size="sm" onClick={() => (setValues({}), setOpen({ secret: m.secret, key: k.key }))} disabled={busy}>{k.set ? "Replace" : "Set"}</Button>}
                      {k.set && !editing && <Button size="sm" variant="quiet" onClick={() => void send(m, k, null)} disabled={busy}>Clear</Button>}
                    </span>
                  </div>
                  {editing && (
                    <form className="mv-signin-form" autoComplete="off" onSubmit={(e) => (e.preventDefault(), void send(m, k, values))}>
                      {m.fields.map((f) => (
                        <Field key={f.name} label={f.label}>
                          {(id) => <Input id={id} name={f.name} type={f.kind === "text" ? "text" : "password"} autoComplete="off" spellCheck={false} value={values[f.name] ?? ""} onChange={(e) => setValues((x) => ({ ...x, [f.name]: e.target.value }))} />}
                        </Field>
                      ))}
                      <div className="mv-signin-buttons">
                        <Button variant="quiet" onClick={close} disabled={busy}>Cancel</Button>
                        <Button variant="primary" type="submit" disabled={busy || !Object.values(values).some((v) => v)}>{busy ? "Saving…" : "Save"}</Button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ))}
      {said && <p className="mv-said" role="status">{said}</p>}
    </>
  );
}
