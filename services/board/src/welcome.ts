// The first-run wizard's server side: what the board should show a new owner (a model gate, the recovery key, the modules'
// wizard flows) and the one welcome chat to Aiden it ends in. A present marker file (data/board/welcome-sent, which
// ops/setup.sh used to write after sending the welcome) counts as finished, so a running instance never sees the wizard.
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AccountError } from "./kernel-auth.js";
import type { SetupFlowPoint, SetupRoute } from "./setup-flows.js";
import type { Store } from "./store.js";
import type { KernelAuth } from "./kernel-auth.js";

const FINISHED = "welcome_finished";

export interface WelcomeDeps {
  accounts: KernelAuth;
  store: Store;
  flows: SetupFlowPoint[];
  marker: string;
  /** Opens the welcome chat with Aiden, written as the owner. */
  post: (text: string) => Promise<{ identifier: string }>;
  /** The zone the install runs in (a server's clock is UTC) and the typed setting change that sets it. */
  timezone: string;
  setTimezone: (timezone: string) => Promise<unknown>;
}

/** The IANA zone the browser named, or "". */
const zoneOf = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(tz) ? tz : "";
  } catch {
    return "";
  }
};

export const welcomeText = (owner: string, done: string[], skipped: string[]) =>
  `Welcome\n\n[setup] ${owner}'s AidenHQ is new. Connected: ${done.join(", ") || "nothing yet"}. Skipped: ${skipped.join(", ") || "nothing"}. Start the first chat with a new owner (your handbook).`;

export function welcomeRoutes(d: WelcomeDeps): SetupRoute[] {
  const wizard = d.flows.filter((f) => f.wizard).sort((a, b) => a.order - b.order);
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
        return { finished: !owner || finished(), modelReady: ready, recoveryKeyWaiting: waiting, wizard: wizard.map((f) => f.module) };
      },
    },
    {
      method: "POST",
      path: /^\/api\/welcome\/finish$/,
      handle: async (_m, body, who) => {
        if (!who.account.owner) throw new AccountError(403, "only the owner finishes the welcome");
        const input = z.object({ done: z.array(z.string().max(63)).max(50), skipped: z.array(z.string().max(63)).max(50), timezone: z.string().max(64).optional() }).strict().parse(body);
        if (finished() || finishing) return { ok: true };
        finishing = true;
        try {
          // Only the modules' own declared titles reach Aiden's chat, never text from the request.
          const titles = (ids: string[]) => wizard.filter((f) => ids.includes(f.module)).map((f) => f.title);
          const { identifier } = await d.post(welcomeText(who.account.name || who.account.email, titles(input.done), titles(input.skipped)));
          // A server's clock is UTC, so an install still on it takes the owner's own zone from their browser, once, here.
          const tz = zoneOf(input.timezone ?? "");
          if (tz && /^(Etc\/)?(UTC|GMT)$/.test(d.timezone)) await d.setTimezone(tz).catch(() => {});
          d.store.setMeta(FINISHED, new Date().toISOString());
          writeFileSync(d.marker, "");
          return { ok: true, identifier };
        } finally {
          finishing = false;
        }
      },
    },
  ];
}
