// Organisations that run internal apps (modules/marketplace.json `organisations`, compiled into the board's points with each
// client resolved to its module's secret). Choosing one writes those public client values through the admin secret write, and
// the connections then sign in as usual: one client path, nothing looked up at sign-in.
import { existsSync, readFileSync } from "node:fs";
import { AccountError, type KernelAuth } from "./kernel-auth.js";
import type { SetupRoute } from "./setup-flows.js";
import type { Store } from "./store.js";

export interface OrganisationPoint {
  id: string;
  name: string;
  domains: string[];
  clients: { module: string; secret: string; value: string }[];
}

export function organisationPoints(file: string): OrganisationPoint[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).organisations ?? []) : [];
}

/** The organisation whose email domain the address is at (a subdomain counts), if any. */
export function suggested(orgs: OrganisationPoint[], email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return orgs.find((o) => o.domains.some((d) => domain === d || domain.endsWith(`.${d}`)))?.id ?? null;
}

const CHOSEN = "organisation";
/** The organisation whose app a module's client is, until the owner pastes another (setup-flows.ts clears it). */
export const appliedKey = (module: string) => `organisation_client:${module}`;

export function organisationRoutes(d: { orgs: OrganisationPoint[]; accounts: KernelAuth; store: Store; onApplied?: () => void }): SetupRoute[] {
  const routes: SetupRoute[] = [
    {
      method: "GET",
      path: /^\/api\/organisations$/,
      handle: async (_m, _b, who) => ({
        organisations: d.orgs.map((o) => ({ id: o.id, name: o.name, domains: o.domains, connections: [...new Set(o.clients.map((c) => c.module))] })),
        suggested: suggested(d.orgs, who.account.email),
        chosen: d.store.meta(CHOSEN) ?? null,
        applied: Object.fromEntries([...new Set(d.orgs.flatMap((o) => o.clients.map((c) => c.module)))].flatMap((mod) => (d.store.meta(appliedKey(mod)) ? [[mod, d.store.meta(appliedKey(mod))]] : []))),
      }),
    },
    {
      // Only the compiled catalog's values, by the organisation's id: nothing from the request reaches the vault. One at a time,
      // since each save restarts that connection's service.
      method: "POST",
      path: /^\/api\/organisations\/([a-z][a-z0-9-]{1,40})\/apply$/,
      handle: async (m, b, who) => {
        const org = d.orgs.find((o) => o.id === m[1]);
        if (!org) throw new AccountError(404, "no such organisation");
        // A setup page applies only its own module's client; the wizard and Settings apply the organisation's whole entry.
        const only = typeof (b as { module?: unknown } | null)?.module === "string" ? (b as { module: string }).module : undefined;
        const results: { module: string; secret: string; ok: boolean; error?: string }[] = [];
        const clients = org.clients.filter((x) => !only || x.module === only);
        if (!clients.length) throw new AccountError(404, `${org.name} has no app for ${only}`);
        for (const c of clients) {
          try {
            await d.accounts.call("save_secret", who, { module: c.module, secret: c.secret, value: c.value });
            results.push({ module: c.module, secret: c.secret, ok: true });
          } catch (e) {
            results.push({ module: c.module, secret: c.secret, ok: false, error: String((e as Error).message).slice(0, 200) });
          }
        }
        // A module's client is the organisation's only when all its values were written; a partial write leaves a mixed one.
        for (const mod of new Set(clients.map((c) => c.module))) {
          if (results.filter((r) => r.module === mod).every((r) => r.ok)) d.store.setMeta(appliedKey(mod), org.id);
          else d.store.delMeta(appliedKey(mod));
        }
        const ok = results.every((r) => r.ok);
        if (ok && !only) d.store.setMeta(CHOSEN, org.id);
        d.onApplied?.();
        return { ok, results };
      },
    },
  ];
  // A ready admin (password and authenticator); the kernel then lets only the owner write a secret.
  return routes.map((r) => ({
    ...r,
    handle: async (m, b, who, host) => {
      if (!who.ready || who.account.role !== "admin") throw new AccountError(403, "totp");
      return r.handle(m, b, who, host);
    },
  }));
}
