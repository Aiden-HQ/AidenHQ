import { describe, expect, it } from "vitest";
import { checkGoogle, NoGoogleAccounts } from "../src/accounts.js";
import { GoogleAuthError } from "../src/google.js";

describe("checkGoogle (the board's Test)", () => {
  it("answers one live read in words", async () => {
    expect(await checkGoogle({ listEvents: async () => [] })).toEqual({ ok: true });
    expect(await checkGoogle({ listEvents: async () => { throw new GoogleAuthError("invalid_grant"); } })).toMatchObject({ ok: false, fix: "Reconnect" });
    expect(await checkGoogle({ listEvents: async () => { throw new Error("Google API 503"); } })).toMatchObject({ ok: false, message: expect.stringContaining("503") });
    expect(await checkGoogle(undefined, new NoGoogleAccounts("none"))).toMatchObject({ ok: false, fix: "Connect" });
  });
});
