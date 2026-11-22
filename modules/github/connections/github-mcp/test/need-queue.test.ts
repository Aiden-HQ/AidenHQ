import { describe, expect, it } from "vitest";
import { GitHubNeed } from "../src/client.js";
import { needQueue, reportNeed } from "../src/module-caller.js";

// The kernel at /v1/connections/need as a fake: each answer is one queued reply, and the last one repeats.
const kernel = (replies: (Response | "hang" | Error)[]) => {
  const seen: { authorization?: string; body: unknown }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ authorization: (init?.headers as Record<string, string> | undefined)?.authorization, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (next === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
};
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const need = () => new GitHubNeed({ cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" });
const log = { warn: () => {} };

describe("an owner-fixable need told to the kernel outside a tool call", () => {
  it("reportNeed says whether the kernel took it, so a refusal or a failure is retried rather than lost", async () => {
    expect(await reportNeed("http://kernel", "key", need(), log, kernel([ok()]).fetcher)).toBe(true);
    expect(await reportNeed("http://kernel", "key", need(), log, kernel([new Response("nope", { status: 503 })]).fetcher)).toBe(false);
    expect(await reportNeed("http://kernel", "key", need(), log, kernel([new Error("ECONNREFUSED")]).fetcher)).toBe(false);
    // Nothing to report is not a failure: a vendor error the owner can't fix isn't sent.
    const vendor = kernel([ok()]);
    expect(await reportNeed("http://kernel", "key", new GitHubNeed({ cause: "unreachable", repo: "acme/x" }), log, vendor.fetcher)).toBe(true);
    expect(vendor.seen).toHaveLength(0);
  });

  it("a report the kernel refused is kept and flushed at the start of the next request, with the same body", async () => {
    const k = kernel([new Response("busy", { status: 503 }), ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "the-key", log, fetcher: k.fetcher, waitMs: 50 });
    await q.tell(need());
    expect(q.pending()).toBe(1);
    expect(k.seen).toHaveLength(1);
    await q.flush();
    expect(q.pending(), "the kernel took it on the retry").toBe(0);
    expect(k.seen).toHaveLength(2);
    expect(k.seen[1]!.body).toEqual(k.seen[0]!.body);
    expect(k.seen[0]!.authorization).toBe("Bearer the-key");
    expect(k.seen[0]!.body).toMatchObject({ connection: "github", need: { cause: "restricted", org: "acme" } });
  });

  it("a report that outlives its bound is kept, so the reply is not blocked past it and the need is not dropped", async () => {
    const k = kernel(["hang", ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "the-key", log, fetcher: k.fetcher, waitMs: 20 });
    const t0 = Date.now();
    await q.tell(need());
    expect(Date.now() - t0, "the reply waited only its bound").toBeLessThan(1_000);
    expect(q.pending()).toBe(1);
    await q.flush();
    expect(q.pending()).toBe(0);
    expect(k.seen).toHaveLength(2);
  });

  it("one need is kept once across repeated reports, and a flush in flight isn't started twice", async () => {
    const k = kernel([new Response("busy", { status: 500 }), ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50 });
    await q.tell(need());
    await q.tell(need());
    expect(q.pending()).toBe(1);
    await Promise.all([q.flush(), q.flush()]);
    expect(q.pending()).toBe(0);
  });
});
