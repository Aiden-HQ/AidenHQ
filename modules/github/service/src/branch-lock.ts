// One destructive step per branch at a time, across this process. A publish (service.ts) pushes a branch and only then opens or
// updates its PR and records the new owner (notePrTask); the watch's cleanup (ship's loop.ts abandon) closes a PR and may delete
// its head branch, through ship-routes.ts, which holds this lock for it. A delete landing in the gap between the push and the ownership write destroys the ref a successor just pushed, so both
// take this lock, keyed by the repo and branch they act on. Re-entrant per async call chain (`heldByMe`), so a step that calls
// another locked step for the same branch can never deadlock on itself.
import { AsyncLocalStorage } from "node:async_hooks";

const held = new Map<string, Promise<void>>();
const heldByMe = new AsyncLocalStorage<Set<string>>();

/** Run `fn` while nothing else runs for this repo's branch; a caller that comes later waits for it. */
export async function withBranch<T>(repo: string, branch: string, fn: () => Promise<T>): Promise<T> {
  const key = `${repo.toLowerCase()}|${branch.toLowerCase()}`;
  const mine = heldByMe.getStore();
  if (mine?.has(key)) return fn(); // this call chain already holds it: never wait on itself
  const prior = held.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const chained = prior.then(() => gate); // the next caller waits for this one, however this one ends
  held.set(key, chained);
  await prior.catch(() => undefined);
  const held2 = new Set(mine ?? []);
  held2.add(key);
  try {
    return await heldByMe.run(held2, fn);
  } finally {
    release();
    if (held.get(key) === chained) held.delete(key);
  }
}
