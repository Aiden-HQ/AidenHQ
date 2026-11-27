import { describe, expect, it } from "bun:test";
import { checkGoogle, NoGoogleAccounts, toolFailure } from "../src/accounts.js";
import { readNeed } from "../src/aidenhq-sdk/needs.js";
import { GoogleAuthError } from "../src/google.js";

describe("checkGoogle (the board's Test)", () => {
  it("answers one live read in words", async () => {
    expect(await checkGoogle({ listEvents: async () => [] })).toEqual({ ok: true });
    expect(await checkGoogle({ listEvents: async () => { throw new GoogleAuthError("invalid_grant"); } })).toMatchObject({ ok: false, fix: "Reconnect" });
    expect(await checkGoogle({ listEvents: async () => { throw new Error("Google API 503"); } })).toMatchObject({ ok: false, message: expect.stringContaining("503") });
    expect(await checkGoogle(undefined, new NoGoogleAccounts("none"))).toMatchObject({ ok: false, fix: "Connect" });
  });
});

describe("toolFailure (what a tool answers when it can't serve)", () => {
  it("a tool with no Google account answers needs_owner not_connected", () => {
    expect(readNeed(toolFailure(new NoGoogleAccounts("no Google accounts"), false))?.cause).toBe("not_connected");
    expect(readNeed(toolFailure(new Error("credentials file is malformed"), false))?.cause).toBe("not_connected");
  });
  it("a refused refresh answers needs_owner expired; a transient failure stays a plain error", () => {
    expect(readNeed(toolFailure(new GoogleAuthError("token refresh failed: invalid_grant", true)))).toMatchObject({ cause: "expired", detail: expect.stringContaining("invalid_grant") });
    const plain = toolFailure(new GoogleAuthError("token refresh failed: 503"));
    expect(readNeed(plain)).toBeUndefined();
    expect(JSON.parse(plain.content[0]!.text)).toMatchObject({ error: "google_api_error" });
  });
});
