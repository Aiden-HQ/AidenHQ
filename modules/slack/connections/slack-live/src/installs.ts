// One installation record per Slack app, in this module's store (`inst:<app id>`): the instance's own app and every dedicated agent
// app. It joins what the two flows each learn: apps.ts (the app was made or updated, from which manifest) and reach.ts (its token
// pair was checked: which workspace, which bot user). The board's list and the socket workers are both derived from these records.
import type { Store } from "./store.js";

export type Install = {
  app_id: string;
  at: number;
  /** Absent for the instance's own app; the agent key for a dedicated app. */
  agent?: string;
  part?: string;
  /** The manifest hash it was made or updated from (apps.ts). */
  hash?: string;
  /** The checked token pair (reach.ts): the workspace, the bot's user id, and a fingerprint of the pair. */
  team_id?: string;
  bot_user?: string;
  fp?: string;
};

export const installs = (store: Store) => {
  const get = (id: string): Install | undefined => {
    const v = store.getKv(`inst:${id}`);
    return v ? (JSON.parse(v) as Install) : undefined;
  };
  const all = (): Install[] => store.listKv("inst:").map((r) => JSON.parse(r.v) as Install);
  return {
    get,
    all,
    /** Merges `patch` into the app's record (made on first use). */
    put(id: string, patch: Partial<Install>): Install {
      const next = { ...(get(id) ?? { app_id: id, at: 0 }), ...patch, app_id: id, at: Date.now() };
      store.setKv(`inst:${id}`, JSON.stringify(next));
      return next;
    },
    del: (id: string) => store.delKv(`inst:${id}`),
    /** The instance's own app: the newest record without an agent. */
    instance: (): Install | undefined => all().filter((i) => !i.agent).sort((a, b) => b.at - a.at)[0],
    ofAgent: (agent: string): Install | undefined => all().filter((i) => i.agent === agent).sort((a, b) => b.at - a.at)[0],
  };
};
export type Installs = ReturnType<typeof installs>;

/** The one record the instance's app had before there was one per app (`app:last`, `app:<id>`): carried over once, and the old keys are gone. */
export function adoptLegacy(store: Store): void {
  const last = store.getKv("app:last");
  if (!last) return;
  const { id, part } = JSON.parse(last) as { id: string; part: string };
  installs(store).put(id, { part, ...(store.getKv(`app:${id}`) ? { hash: store.getKv(`app:${id}`)! } : {}) });
  for (const r of store.listKv("app:")) store.delKv(r.k);
}
