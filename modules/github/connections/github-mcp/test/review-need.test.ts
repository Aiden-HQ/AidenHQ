import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { GitHubNeed, needResult } from "../src/client.js";
import { GitHubRefused } from "../src/github.js";
import { reviewErrorAnswer } from "../src/review-need.js";
import { readNeed } from "../src/vendor/needs.js";

/** The review route's answer read back the way the executor reads a needs_owner answer (vendor/needs.ts readNeed). */
const asExecutorResult = (err: unknown) => {
  const { status, body } = reviewErrorAnswer(err);
  return { status, need: readNeed({ isError: true, structuredContent: body }) };
};

describe("the review route's answer to an error", () => {
  it("carries an owner-fixable GitHubNeed as needs_owner (the kernel's shape), never a bare 502", () => {
    const url = "https://github.com/settings/connections/applications/cid";
    const { status, need } = asExecutorResult(new GitHubNeed({ cause: "restricted", org: "acme", url }));
    expect(status).toBe(502);
    expect(need).toEqual({ cause: "restricted", org: "acme", url, detail: expect.stringContaining("acme organization restricts OAuth apps") });
  });

  it("carries an sso need with its org and the vendor's url", () => {
    const url = "https://github.com/orgs/acme/sso?authorization_request=x";
    const err = new GitHubNeed({ cause: "sso", org: "acme", url });
    expect(reviewErrorAnswer(err).body).toMatchObject({ error: "needs_owner", need: { cause: "sso", org: "acme", url } });
  });

  it("keeps a vendor outage or rate limit a plain error, never needs_owner", () => {
    const rate = reviewErrorAnswer(new GitHubNeed({ cause: "rate_limited", until: "2026-11-21T21:00:00.000Z" }));
    expect(rate.status).toBe(502);
    expect(rate.body.error).toBe("github_rate_limited");
    expect(readNeed({ isError: true, structuredContent: rate.body })).toBeUndefined();
    expect(reviewErrorAnswer(new GitHubNeed({ cause: "unreachable", repo: "acme/secret" })).body.error).toBe("github_unreachable");
  });

  it("leaves a GitHubRefused, a Zod error and malformed JSON the request's own 400", () => {
    expect(reviewErrorAnswer(new GitHubRefused("the review is of another PR"))).toEqual({ status: 400, body: { error: "refused", detail: "the review is of another PR" } });
    const zod = reviewErrorAnswer(z.object({ repo: z.string() }).safeParse({}).error);
    expect(zod.status).toBe(400);
    expect(zod.body.error).toBe("refused");
    expect(reviewErrorAnswer(new SyntaxError("Unexpected token < in JSON")).status).toBe(400);
  });

  it("answers an untyped failure with github_error and its detail", () => {
    expect(reviewErrorAnswer(new Error("the box said no"))).toEqual({ status: 502, body: { error: "github_error", detail: "the box said no" } });
  });
});

describe("needResult and reviewErrorAnswer agree on the need", () => {
  it("both name the same cause, org and url for a restricted refusal", () => {
    const err = new GitHubNeed({ cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" });
    const viaTool = readNeed(needResult(err));
    const { need } = asExecutorResult(err);
    expect(need).toEqual(viaTool);
  });
});
