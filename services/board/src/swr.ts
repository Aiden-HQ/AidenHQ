// A page's last good response, served at once while a fresh one is read (stale-while-revalidate). A route's read can be slow
// (the issue inventory, the kernel's lists): the page shows what it last had, marked `stale: true`, and the client asks again
// a moment later. One read per key at a time, and never a failure while there is a good response to show.

/** A response read this recently is served as it is. */
const FRESH_MS = 1_500;
/** A read that finished after its caller was shown the last good response stays fresh this long, so the client's retry gets it. */
const LATE_FRESH_MS = 5_000;
/** An older response waits this long for its refresh before the page shows the last good response instead. */
const WAIT_MS = 800;

interface Entry {
  value: object;
  /** Served as it is until then (ms). */
  until: number;
}
interface Read {
  promise: Promise<object>;
  /** The invalidation generation it started in. */
  gen: number;
  /** Its caller stopped waiting for it. */
  late: boolean;
}

export type Served<T> = T & { stale?: true };

export class Swr {
  private last = new Map<string, Entry>();
  private reading = new Map<string, Read>();
  private gen = 0;

  /**
   * `key`: the route and, for data that differs by account, the account. `load` runs at most once at a time per key.
   * `waitMs`: how long a refresh may take before the last good response is shown instead (a page whose controls act on what it
   * shows waits for the answer; the last good one is then shown only when the read fails).
   */
  async serve<T extends object>(key: string, load: () => Promise<T>, waitMs = WAIT_MS): Promise<Served<T>> {
    const have = this.last.get(key);
    if (have && Date.now() < have.until) return have.value as T;
    let read = this.reading.get(key);
    if (!read) {
      const r: Read = { gen: this.gen, late: false, promise: undefined as unknown as Promise<object> };
      r.promise = load().then((value) => {
        // A read that began before the latest change is kept to show in a pinch, never as fresh.
        this.last.set(key, { value, until: r.gen === this.gen ? Date.now() + (r.late ? LATE_FRESH_MS : FRESH_MS) : 0 });
        return value;
      });
      this.reading.set(key, r);
      const done = () => void (this.reading.get(key) === r && this.reading.delete(key));
      r.promise.then(done, done);
      read = r;
    }
    const reading = read;
    // What the read answered, marked stale when a change came after it began (the client asks again, and then starts a new read).
    const answer = async () => {
      const value = (await reading.promise) as T;
      return reading.gen === this.gen ? value : { ...value, stale: true as const };
    };
    // Nothing to show yet: wait for the read, whatever it takes (its failure is the page's).
    if (!have) return answer();
    let timer: NodeJS.Timeout | undefined;
    try {
      return (await Promise.race([answer(), new Promise<never>((_, no) => (timer = setTimeout(no, waitMs)).unref())])) as Served<T>;
    } catch {
      reading.late = true;
      reading.promise.catch(() => {}); // still on its way (or failed): the last good one is shown
      return { ...(have.value as T), stale: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A write or a change may have changed what pages show: every response, and any read already under way, is read again. */
  touch(): void {
    this.gen++;
    for (const e of this.last.values()) e.until = 0;
  }
}
