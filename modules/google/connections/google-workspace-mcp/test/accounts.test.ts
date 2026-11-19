import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { healthBody, loadAccounts, readCredentials } from "../src/accounts.js";

const file = (content: unknown) => {
  const p = join(mkdtempSync(join(tmpdir(), "gacc-")), "creds.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
};

describe("google accounts", () => {
  it("reads multiple accounts sharing the client, honouring primary", () => {
    const { primary, accounts } = loadAccounts(
      file({ client_id: "c", client_secret: "s", primary: "me@work.com", accounts: { "me@side.io": { refresh_token: "r2" }, "me@work.com": { refresh_token: "r1" } } }),
    );
    expect(primary).toBe("me@work.com");
    expect([...accounts.keys()].sort()).toEqual(["me@side.io", "me@work.com"]);
    expect(accounts.get("me@side.io")).toMatchObject({ client_id: "c", client_secret: "s", refresh_token: "r2" });
  });

  it("falls back to the first account when primary is unknown, and fails when empty", () => {
    expect(loadAccounts(file({ client_id: "c", primary: "x@y.z", accounts: { "a@b.c": { refresh_token: "r" } } })).primary).toBe("a@b.c");
    expect(() => loadAccounts(file({ client_id: "c", accounts: {} }))).toThrow(/no Google accounts/);
  });

});

describe("the client pasted on the board", () => {
  const withClient = (id: string, secret: string, fn: () => void) => {
    const dir = mkdtempSync(join(tmpdir(), "gsec-"));
    writeFileSync(join(dir, "id"), id);
    writeFileSync(join(dir, "secret"), secret);
    process.env.GOOGLE_CLIENT_ID_FILE = join(dir, "id");
    process.env.GOOGLE_CLIENT_SECRET_FILE = join(dir, "secret");
    try {
      fn();
    } finally {
      delete process.env.GOOGLE_CLIENT_ID_FILE;
      delete process.env.GOOGLE_CLIENT_SECRET_FILE;
    }
  };
  const stored = { client_id: "old", client_secret: "olds", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "r1" } } };

  it("a pasted client keeps stored accounts", () => {
    withClient("new.apps.googleusercontent.com\n", "GOCSPX-new\n", () => {
      const path = file(stored);
      expect(loadAccounts(path).accounts.get("me@work.com")).toMatchObject({ client_id: "new.apps.googleusercontent.com", client_secret: "GOCSPX-new", refresh_token: "r1" });
      expect(readCredentials(path, true)).toEqual(stored); // writes never copy the pasted secret into the file
    });
  });

  it("an existing google_oauth.json client still works", () => {
    withClient("", "", () => expect(loadAccounts(file(stored)).accounts.get("me@work.com")).toMatchObject({ client_id: "old", client_secret: "olds" }));
    expect(loadAccounts(file(stored)).accounts.get("me@work.com")?.client_id).toBe("old"); // secret files not mounted at all
  });
});

describe("the guided flow", () => {
  it("makes a Desktop client (no redirect to register), and says Internal vs External and the 7-day limit before it starts", () => {
    const yaml = readFileSync(join(import.meta.dirname, "../../../module.yaml"), "utf8");
    const steps = /steps: \|\n((?: {8}.*\n|\n)+)/.exec(yaml)?.[1] ?? "";
    expect(yaml).toMatch(/needs_name: "Google only accepts a named address/);
    expect(steps).toMatch(/Desktop app/);
    expect(steps).not.toContain("google/callback");
    expect(steps).toMatch(/Internal.*External/s);
    expect(steps).toMatch(/7 days/);
    expect(steps.length).toBeLessThan(4000); // the schema's limit
    expect(yaml).toMatch(/google_client_id[\s\S]*?public_client: true/);
    expect(steps).toContain("https://console.cloud.google.com/projectcreate");
  });
});

describe("healthBody", () => {
  it("answers state missing when no Google account is connected, and a plain failure for a file that won't load", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    const caught = (path: string) => { try { loadAccounts(path); } catch (e) { return e; } };
    const empty = caught(join(dir, "absent.json"));
    expect(healthBody(false, empty)).toMatchObject({ ok: false, state: "missing" });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(healthBody(false, caught(bad))).not.toHaveProperty("state");
    expect(healthBody(true)).toEqual({ ok: true });
  });
});
