// The board's alerts for the owner (a critical monitoring alert, a paused routine, Fleet Ops unreachable, an app incident):
// each goes through the one notify, queued at the kernel (POST /v1/notify with the board's key) for owner-channel, which
// reaches the owner. Until startNotify runs (and in tests, onOwnerAlert) nothing is sent.
/** alert: something is wrong now (a page); done: a plain notice (never muted). */
export type Kind = "alert" | "done";
type Sink = (text: string, kind: Kind) => void;
let sink: Sink = () => {};

/** One message for the owner. */
export const ownerAlert = (text: string, kind: Kind = "alert"): void => sink(text, kind);

export function startNotify(kernel: { url: string; token: string }, log: { warn(o: object, m: string): void }): void {
  // A few tries a minute apart: the kernel restarts on an apply, and the caller has already marked the alert as sent.
  const post = async (body: string, tries: number): Promise<void> => {
    const r = await fetch(`${kernel.url}/v1/notify`, { method: "POST", headers: { authorization: `Bearer ${kernel.token}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000) }).catch((err: Error) => err);
    if (!(r instanceof Error) && r.ok) return;
    if (tries > 1) return void setTimeout(() => void post(body, tries - 1), 60_000).unref();
    log.warn({ err: r instanceof Error ? String(r) : r.status }, "owner alert not queued");
  };
  sink = (text, kind) => void post(JSON.stringify({ kind, text }), 5);
}

/** Where alerts go instead (tests). */
export const onOwnerAlert = (fn: Sink): void => void (sink = fn);
