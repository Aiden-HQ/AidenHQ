import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransient, retryTransient } from "../src/retry.ts";

describe("retryTransient", () => {
  it("retries a network blip until it works, gives up after the last delay, and never retries a refusal", async () => {
    let n = 0;
    const blip = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    assert.equal(await retryTransient(async () => (++n < 3 ? Promise.reject(blip) : "ok"), [1, 1, 1]), "ok");
    assert.equal(n, 3);

    n = 0;
    await assert.rejects(retryTransient(async () => (++n, Promise.reject(blip)), [1, 1]), /fetch failed/);
    assert.equal(n, 3, "the first try and one per delay");

    n = 0;
    await assert.rejects(retryTransient(async () => (++n, Promise.reject(new Error("Paperclip PATCH /api/issues/x → 422: blocked"))), [1, 1]), /422/);
    assert.equal(n, 1);
    assert.ok(isTransient(new Error("Paperclip GET /x → 503: unavailable")));
  });
});
