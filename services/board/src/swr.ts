// A page's last good response, served at once while a fresh one is read (stale-while-revalidate). A route's read can be slow
// (the issue inventory, the kernel's lists): the page shows what it last had, marked `stale: true`, and the client asks again
// a moment later. One read per key at a time, and never a failure while there is a good response to show.

/** A response read this recently is served as it is. */
const FRESH_MS = 1_500;
/** An older one waits this long for its refresh before the page shows the last good response instead. */
const WAIT_MS = 800;

interface Entry {
  value: object;
  at: number;
}

export type Served<T> = T & { stale?: true };

export class Swr {
  private last = new Map<string, Entry>();
  private reading = new Map<string, Promise<object>>();

  /** `key`: the route and, for data that differs by account, the account. `load` runs at most once at a time per key. */
  async serve<T extends object>(key: string, load: () => Promise<T>): Promise<Served<T>> {
    const have = this.last.get(key);
    if (have && Date.now() - have.at < FRESH_MS) return have.value as T;
    let read = this.reading.get(key);
    if (!read) {
      read = load().then(
        (value) => (this.last.set(key, { value, at: Date.now() }), value),
      );
      this.reading.set(key, read);
      const done = () => void (this.reading.get(key) === read && this.reading.delete(key));
      read.then(done, done);
    }
    // Nothing to show yet: wait for the read, whatever it takes (its failure is the page's).
    if (!have) return (await read) as T;
    let timer: NodeJS.Timeout | undefined;
    try {
      return (await Promise.race([read, new Promise<never>((_, no) => (timer = setTimeout(no, WAIT_MS)).unref())])) as T;
    } catch {
      read.catch(() => {}); // still on its way (or failed): the last good one is shown
      return { ...(have.value as T), stale: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A write may have changed what pages show: every response is read again by the next request. */
  touch(): void {
    for (const e of this.last.values()) e.at = 0;
  }
}
