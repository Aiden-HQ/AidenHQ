import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAccounts } from "../src/accounts.js";
import { SCOPES } from "../src/google.js";
import { Reconnect } from "../src/reconnect.js";

const credsFile = () => {
  const p = join(mkdtempSync(join(tmpdir(), "grec-")), "creds.json");
  writeFileSync(
    p,
    JSON.stringify({ client_id: "cid", client_secret: "sec", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "old" }, "me@side.io": { refresh_token: "side" } } }),
  );
  return p;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Google's token and profile endpoints, answering as `email`. */
function google(email: string, scope = SCOPES.join(" ")) {
  const calls: { url: string; body?: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return json({ refresh_token: "new", access_token: "at", scope });
    return json({ emailAddress: email });
  }) as typeof fetch;
  return { impl, calls };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("reconnect from the board", () => {
  const redirect = "http://127.0.0.1:3120/google/callback";

  it("refuses unknown accounts and non-loopback redirects", () => {
    const r = new Reconnect(credsFile());
    expect(() => r.start("stranger@x.io", redirect)).toThrow(/isn't a connected account/);
    expect(() => r.start("me@work.com", "https://evil.example/cb")).toThrow(/loopback/);
    expect(() => r.start("me@work.com", "http://aidenhq.local/google/callback")).toThrow(/loopback/);
  });

  it("stores the new refresh token for that account only, keeping the primary and the other accounts", async () => {
    const path = credsFile();
    const g = google("me@work.com");
    const r = new Reconnect(path, g.impl);
    const { url } = r.start("me@work.com", redirect);
    expect(await r.finish(stateOf(url), "code-1")).toEqual({ email: "me@work.com" });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.primary).toBe("me@work.com");
    expect(saved.accounts["me@work.com"]).toMatchObject({ refresh_token: "new" });
    expect(saved.accounts["me@side.io"]).toEqual({ refresh_token: "side" });
    const exchange = new URLSearchParams(g.calls[0]!.body);
    expect(exchange.get("code_verifier")).toBeTruthy();
    expect(exchange.get("redirect_uri")).toBe(redirect);
  });

  it("changes nothing when someone else signs in", async () => {
    const path = credsFile();
    const before = readFileSync(path, "utf8");
    const other = new Reconnect(path, google("me@side.io").impl);
    await expect(other.finish(stateOf(other.start("me@work.com", redirect).url), "c")).rejects.toThrow(/signed in as me@side.io, not me@work.com/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("saves the scopes Google granted, the client's older readonly ones included (a reconnect for Google writes)", async () => {
    const path = credsFile();
    const scope = `${SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.readonly`;
    const r = new Reconnect(path, google("me@work.com", scope).impl);
    await r.finish(stateOf(r.start("me@work.com", redirect).url), "c");
    expect(JSON.parse(readFileSync(path, "utf8")).accounts["me@work.com"].scopes).toEqual(scope.split(" "));
  });

  it("spends each state once, and expires it", async () => {
    const path = credsFile();
    const r = new Reconnect(path, google("me@work.com").impl);
    const state = stateOf(r.start("me@work.com", redirect).url);
    await r.finish(state, "c");
    await expect(r.finish(state, "c")).rejects.toThrow(/expired or was already used/);
    const quick = new Reconnect(path, google("me@work.com").impl, -1);
    await expect(quick.finish(stateOf(quick.start("me@work.com", redirect).url), "c")).rejects.toThrow(/expired/);
    await expect(r.finish("made-up-state-value", "c")).rejects.toThrow(/expired or was already used/);
  });

  it("keeps connected accounts on the client that issued their tokens when another client is pasted", async () => {
    const path = credsFile();
    const dir = mkdtempSync(join(tmpdir(), "gpaste-"));
    writeFileSync(join(dir, "id"), "pasted-id");
    writeFileSync(join(dir, "secret"), "pasted-secret");
    process.env.GOOGLE_CLIENT_ID_FILE = join(dir, "id");
    process.env.GOOGLE_CLIENT_SECRET_FILE = join(dir, "secret");
    try {
      const r = new Reconnect(path, google("me@new.io").impl);
      await r.finish(stateOf(r.start(undefined, redirect).url), "c");
      expect(JSON.parse(readFileSync(path, "utf8")).accounts["me@new.io"]).toMatchObject({ client_id: "pasted-id", client_secret: "pasted-secret" });
      // A client pasted later leaves that account on the one it signed in with.
      writeFileSync(join(dir, "id"), "pasted-later");
      expect(loadAccounts(path).accounts.get("me@new.io")).toMatchObject({ client_id: "pasted-id", client_secret: "pasted-secret" });
    } finally {
      delete process.env.GOOGLE_CLIENT_ID_FILE;
      delete process.env.GOOGLE_CLIENT_SECRET_FILE;
    }
  });
});
