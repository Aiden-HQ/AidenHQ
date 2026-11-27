// Onboarding's server side: what the board should show a new owner (a model gate, the recovery key) and its finish, which
// lands him on Home. A present marker file
// (data/board/welcome-sent, which ops/setup.sh used to write) counts as finished, so a running instance never sees onboarding.
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AccountError } from "./kernel-auth.js";
import type { SetupRoute } from "./setup-flows.js";
import type { Store } from "./store.js";
import type { KernelAuth } from "./kernel-auth.js";

export const FINISHED = "welcome_finished";

export interface WelcomeDeps {
  accounts: KernelAuth;
  store: Store;
  marker: string;
}

export function welcomeRoutes(d: WelcomeDeps): SetupRoute[] {
  const finished = () => Boolean(d.store.meta(FINISHED)) || existsSync(d.marker);
  let finishing = false;
  return [
    {
      method: "GET",
      path: /^\/api\/welcome$/,
      handle: async (_m, _b, who) => {
        const ready = (await d.accounts.call<{ ready: boolean }>("model_ready", who)).ready;
        // Only the owner is walked through setup (saving a secret and pairing are the owner's).
        const owner = who.account.owner;
        const waiting = owner && !finished() ? (await d.accounts.call<{ waiting: boolean }>("recovery_key_waiting", who).catch(() => ({ waiting: false }))).waiting : false;
        return { finished: !owner || finished(), modelReady: ready, recoveryKeyWaiting: waiting };
      },
    },
    {
      method: "POST",
      path: /^\/api\/welcome\/finish$/,
      handle: async (_m, body, who) => {
        if (!who.account.owner) throw new AccountError(403, "only the owner finishes the welcome");
        z.object({}).strict().parse(body ?? {});
        if (finished() || finishing) return { ok: true };
        finishing = true;
        try {
          d.store.setMeta(FINISHED, new Date().toISOString());
          writeFileSync(d.marker, "");
          return { ok: true };
        } finally {
          finishing = false;
        }
      },
    },
  ];
}
