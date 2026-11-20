// A multi-account connection names the account in its needs and in its served answers, so the kernel clears only the account
// that answered: one account's sign-in expiring never hides behind another's working one.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MultiWorkspace, servedBy, toolFailure } from "../src/accounts.js";
import { readNeed } from "../src/aidenhq-sdk/needs.js";
import { GoogleAuthError } from "../src/google.js";

describe("a multi-account connection's needs", () => {
  it("names the account whose sign-in expired, from the exception or the call", () => {
    const err = new GoogleAuthError("token refresh failed: invalid_grant", true);
    expect(readNeed(toolFailure(err))?.account).toBeUndefined();
    err.account = "a@example.com";
    expect(readNeed(toolFailure(err))).toMatchObject({ cause: "expired", account: "a@example.com" });
    expect(readNeed(toolFailure(new GoogleAuthError("invalid_grant", true), true, "b@example.com"))).toMatchObject({ cause: "expired", account: "b@example.com" });
  });

  it("takes the account from the exception MultiWorkspace raises for it", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "gneed-")), "creds.json");
    writeFileSync(p, JSON.stringify({ client_id: "cid", client_secret: "sec", primary: "a@example.com", accounts: { "a@example.com": { refresh_token: "ra" } } }));
    const ws = new MultiWorkspace(p, "primary", (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch);
    const err = await ws.listEvents("2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z").catch((e) => e);
    expect(readNeed(toolFailure(err))).toMatchObject({ cause: "expired", account: "a@example.com" });
  });

  it("a sweep lists the accounts that answered, never one that failed", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "gneed-")), "creds.json");
    writeFileSync(p, JSON.stringify({ client_id: "cid", client_secret: "sec", primary: "a@example.com", accounts: { "a@example.com": { refresh_token: "ra" }, "b@example.com": { refresh_token: "rb" } } }));
    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token"))
        return String(init?.body).includes("refresh_token=ra")
          ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const ws = new MultiWorkspace(p, "primary", impl);
    const messages = await ws.gmailSearch("in:inbox");
    expect(messages.find((m) => m.account === "a@example.com")).toMatchObject({ error: expect.stringMatching(/invalid_grant|token refresh/) });
    expect(messages.served).toEqual(["b@example.com"]);
    const dead = new MultiWorkspace(p, "primary", (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch);
    expect((await dead.gmailSearch("in:inbox")).served).toEqual([]);
  });

  it("marks the account a read actually found its data in, not the primary it started from", () => {
    // A read with no account starts at the primary but may answer from another: the result names that one.
    expect(servedBy("a@example.com", { account: "b@example.com", text: "x" })).toBe("b@example.com");
    expect(servedBy("a@example.com", [{ account: "b@example.com" }]), "a list's rows name their account").toBe("b@example.com");
    expect(servedBy("a@example.com", { text: "x" }), "no account in the result: the call's own").toBe("a@example.com");
    // A sweep: every account (the whole connection), one, or a mix (nothing marked) — rows or a wrapper's messages.
    const rows = (served: string[]) => Object.assign([], { served });
    expect(servedBy("a@example.com", rows(["a@example.com", "b@example.com"]), 2)).toBeUndefined();
    expect(servedBy("a@example.com", rows(["b@example.com"]), 2)).toBe("b@example.com");
    expect(servedBy("a@example.com", rows(["a@example.com"]), 1), "an explicit account is named").toBe("a@example.com");
    expect(servedBy("a@example.com", rows([]), 2)).toBeNull();
    // gmail_search wraps its rows, tag included: a search served by one of two accounts names that one.
    expect(servedBy("a@example.com", { notice: "x", messages: rows(["b@example.com"]) }, 2)).toBe("b@example.com");
    expect(servedBy("a@example.com", { notice: "x", messages: rows([]) }, 2)).toBeNull();
  });
});
