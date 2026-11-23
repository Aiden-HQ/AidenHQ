import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubNeed } from "../src/client.js";
import { needQueue, reportNeed, reportOrgOk } from "../src/module-caller.js";

// The kernel at /v1/connections/need as a fake: each answer is one queued reply, and the last one repeats.
const replies = (list: (Response | "hang" | Error)[]) => {
  const rest = [...list];
  const seen: { authorization?: string; body: unknown }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ authorization: (init?.headers as Record<string, string> | undefined)?.authorization, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = rest.length > 1 ? rest.shift()! : rest[0]!;
    if (next === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
};
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const busy = () => new Response("busy", { status: 503 });
const bad = () => new Response("bad request", { status: 400 });
const need = () => new GitHubNeed({ cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid" });
const log = { warn: () => {} };

describe("an owner-fixable need told to the kernel outside a tool call", () => {
  it("reportNeed says whether the kernel has it, or whether a retry can help", async () => {
    expect(await reportNeed("http://kernel", "key", need(), log, replies([ok()]).fetcher)).toBe("taken");
    expect(await reportNeed("http://kernel", "key", need(), log, replies([busy()]).fetcher)).toBe("retry");
    expect(await reportNeed("http://kernel", "key", need(), log, replies([new Error("ECONNREFUSED")]).fetcher)).toBe("retry");
    expect(await reportNeed("http://kernel", "key", need(), log, replies([bad()]).fetcher)).toBe("refused");
    // Nothing to report is not a failure: a vendor error the owner can't fix isn't sent.
    const vendor = replies([ok()]);
    expect(await reportNeed("http://kernel", "key", new GitHubNeed({ cause: "unreachable", repo: "acme/x" }), log, vendor.fetcher)).toBe("taken");
    expect(vendor.seen).toHaveLength(0);
  });

  it("a report the kernel couldn't take is kept and flushed once at the next request, with the same body", async () => {
    const k = replies([busy(), ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "the-key", log, fetcher: k.fetcher, waitMs: 50 });
    await q.tell(need());
    expect(q.pending()).toBe(1);
    await q.flush();
    expect(q.pending(), "the kernel took it on the retry").toBe(0);
    expect(k.seen).toHaveLength(2);
    expect(k.seen[1]!.body).toEqual(k.seen[0]!.body);
    expect(k.seen[0]!.authorization).toBe("Bearer the-key");
    expect(k.seen[0]!.body).toMatchObject({ connection: "github", need: { cause: "restricted", org: "acme" } });
  });

  // The code host's workflow-scope refusal is told to the owner through this queue (main.ts's reportNeed): a kernel that is
  // restarting when the push fails must not lose it, so the scope need is kept and sent again on the next flush.
  it("a workflow-scope need the kernel couldn't take is kept and retried", async () => {
    const k = replies([busy(), ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50 });
    const need = new GitHubNeed({ cause: "scope", scope: "workflow" }, "GitHub needs the `workflow` permission: reconnect GitHub on the board (Settings, Connections)");
    await q.tell(need);
    expect(q.pending()).toBe(1);
    await q.flush();
    expect(q.pending()).toBe(0);
    expect(k.seen.map((s) => s.body)).toEqual([
      { connection: "github", need: { cause: "scope", detail: need.message, scope: "workflow" } },
      { connection: "github", need: { cause: "scope", detail: need.message, scope: "workflow" } },
    ]);
  });

  // The owner reconnects with `workflow` ticked while the notice is kept: replaying it would mark the fresh grant down.
  it("a kept workflow-scope need the fresh grant covers is dropped, not replayed", async () => {
    let scope = "repo, read:org, project";
    const k = replies([busy()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50, covers: (s) => scope.split(", ").includes(s) });
    const need = new GitHubNeed({ cause: "scope", scope: "workflow" }, "GitHub needs the `workflow` permission");
    await q.tell(need);
    expect(q.pending()).toBe(1);
    scope = "repo, read:org, workflow, project";
    await q.flush();
    expect(k.seen, "the fixed grant was not told it lacks the scope").toHaveLength(1);
    expect(q.pending()).toBe(0);
    // A need met after the grant is not staged at all.
    await q.tell(need);
    expect(q.pending()).toBe(0);
    expect(k.seen).toHaveLength(1);
  });

  it("a permanent refusal (a 4xx) is dropped, not retried on every request", async () => {
    const k = replies([bad()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50 });
    await q.tell(need());
    expect(q.pending()).toBe(0);
    await q.flush();
    expect(k.seen, "the refused report was not sent again").toHaveLength(1);
  });

  it("each kept need is visited at most once per flush, so a refusing kernel is not hammered in one pass", async () => {
    const k = replies([busy()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50 });
    await q.tell(need());
    const before = k.seen.length;
    await q.flush();
    expect(k.seen.length - before, "one attempt for the one kept need").toBe(1);
    expect(q.pending()).toBe(1);
  });

  it("a report that outlives its bound is kept, so the reply is not blocked past it and the need is not dropped", async () => {
    const k = replies(["hang", ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 20 });
    const t0 = Date.now();
    await q.tell(need());
    expect(Date.now() - t0, "the reply waited only its bound").toBeLessThan(1_000);
    expect(q.pending()).toBe(1);
    await q.flush();
    expect(q.pending()).toBe(0);
  });

  it("kept needs survive a restart: a new queue reads them from disk and sends them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    const first = replies([busy()]);
    const q1 = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: first.fetcher, waitMs: 50, file });
    await q1.tell(need());
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
    // The container restarts: a fresh queue reads the file and retries it, then clears it on success.
    const second = replies([ok()]);
    const q2 = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: second.fetcher, waitMs: 50, file });
    expect(q2.pending()).toBe(1);
    await q2.flush();
    expect(q2.pending()).toBe(0);
    expect(second.seen[0]!.body).toMatchObject({ connection: "github", need: { cause: "restricted", org: "acme" } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(0);
  });

  it("one need is kept once across repeated reports", async () => {
    const k = replies([busy(), busy()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50 });
    await q.tell(need());
    await q.tell(need());
    expect(q.pending()).toBe(1);
  });

  it("the need is on disk before the first attempt, so a restart inside the wait still sends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    let onDiskWhenAsked: unknown;
    const fetcher = (async () => {
      onDiskWhenAsked = JSON.parse(readFileSync(file, "utf8"));
      return busy();
    }) as unknown as typeof fetch;
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher, waitMs: 50, file });
    await q.tell(need());
    expect(Array.isArray(onDiskWhenAsked) && onDiskWhenAsked.length, "written before the POST went out").toBe(1);
    expect(q.pending()).toBe(1);
  });

  it("a kept sign-in need met on an older credential is dropped, never replayed onto the reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    let credential = "first";
    const signIn = () => new GitHubNeed({ cause: "expired" });
    const k = replies([busy(), ok()]);
    const q1 = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50, file, generation: () => credential });
    await q1.tell(signIn());
    expect(q1.pending()).toBe(1);
    // The owner reconnects while it is kept: the next flush must not send it.
    credential = "second";
    const before = k.seen.length;
    await q1.flush();
    expect(k.seen.length, "no replay onto the fresh credential").toBe(before);
    expect(q1.pending()).toBe(0);
    // A need met after the reconnect is sent as usual.
    await q1.tell(signIn());
    await q1.flush();
    expect(q1.pending()).toBe(0);
    expect(k.seen.at(-1)!.body).toMatchObject({ connection: "github", need: { cause: "expired" } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(0);
  });

  it("a need kept by an older version (no credential recorded) is adopted, not read as a reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    // The pre-upgrade file: no `gen` on the row, and a token installed since.
    writeFileSync(file, JSON.stringify([{ key: "expired\u0000\u0000\u0000", need: { cause: "expired", detail: "sign-in expired" } }]));
    const k = replies([ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50, file, generation: () => "installed" });
    expect(q.pending(), "kept through the upgrade").toBe(1);
    await q.flush();
    expect(k.seen, "and sent once").toHaveLength(1);
    expect(q.pending()).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(0);
  });

  it("a restart does not evict a staged need before it is replayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    // A full queue (the cap) plus the one tell() staged and was posting when the process died.
    const rows = Array.from({ length: 21 }, (_, n) => ({ key: `restricted\u0000\u0000acme${n}\u0000`, need: { cause: "restricted", org: `acme${n}`, detail: "x" }, gen: "g" }));
    writeFileSync(file, JSON.stringify(rows));
    const k = replies([ok()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50, file, generation: () => "g" });
    expect(q.pending(), "all 21 are replayed, not capped to 20 up front").toBe(21);
    await q.flush();
    expect(k.seen, "every staged need was sent before the cap").toHaveLength(21);
    expect(q.pending()).toBe(0);
  });

  it("a kept need that is not a sign-in failure survives a reconnect", async () => {
    let credential = "first";
    const k = replies([busy(), busy()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50, generation: () => credential });
    await q.tell(need());
    credential = "second";
    await q.flush();
    expect(q.pending(), "an org restriction is not fixed by reconnecting").toBe(1);
    expect(k.seen.at(-1)!.body).toMatchObject({ connection: "github", need: { cause: "restricted", org: "acme" } });
  });
});

describe("a successful owner call to an org", () => {
  it("is reported as that org's clear in one fire-and-forget POST, and never throws into the call it reports", async () => {
    const seen: { url: string; authorization?: string; body: unknown }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: (init?.headers as Record<string, string> | undefined)?.authorization, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ woken: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    reportOrgOk("http://kernel", "the-key", "github", "Acme", log, fetcher, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ url: "http://kernel/v1/connections/ok", authorization: "Bearer the-key", body: { connection: "github", org: "Acme" } }]);
    // A refused or failed report is logged once and never retried (a retry would be a success landing after a newer refusal);
    // the org's next query reports again.
    const said: string[] = [];
    const warns = { warn: (_o: object, m: string) => void said.push(m) };
    let n = 0;
    reportOrgOk("http://kernel", "k", "github", "refused-org", warns, (async () => { n++; return new Response("no", { status: 400 }); }) as unknown as typeof fetch, 5_000);
    reportOrgOk("http://kernel", "k", "github", "down-org", warns, (async () => { n++; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch, 5_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(n, "one POST each, no retries").toBe(2);
    expect(said).toEqual(["the kernel refused a connection success report", "a connection success report failed; the org's next query reports it again"]);
  });

  // A need and a clear for one org reach the kernel in the order this process saw them, so neither can undo the other.
  it("sends one org's need and clear in the order they were observed", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = (async (input: RequestInfo | URL) => {
      const what = String(input).split("/v1/connections/")[1]!;
      order.push(`${what}:sent`);
      if (what === "need") await gate;
      order.push(`${what}:done`);
      return new Response(JSON.stringify({ ok: true, woken: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    // A refusal's need is still in flight when the org answers: the clear waits for it, so it cannot land before it.
    const need = reportNeed("http://kernel", "k", new GitHubNeed({ cause: "restricted", org: "Acme", url: "https://github.com/settings/connections/applications/cid" }), log, fetcher);
    reportOrgOk("http://kernel", "k", "github", "acme", log, fetcher);
    await new Promise((r) => setTimeout(r, 10));
    expect(order, "the clear waits for the need already sent for the org").toEqual(["need:sent"]);
    release();
    expect(await need).toBe("taken");
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["need:sent", "need:done", "ok:sent", "ok:done"]);

    // A refusal observed after a success is sent after it, and a success after a refusal still clears it: the newer answer wins.
    order.length = 0;
    reportOrgOk("http://kernel", "k", "github", "acme", log, fetcher);
    await reportNeed("http://kernel", "k", new GitHubNeed({ cause: "sso", org: "Acme", url: "https://github.com/orgs/acme/sso" }), log, fetcher);
    reportOrgOk("http://kernel", "k", "github", "ACME", log, fetcher);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["ok:sent", "ok:done", "need:sent", "need:done", "ok:sent", "ok:done"]);
  });

  it("a kept sso/restricted report for an org the call just reached is dropped, not replayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    const k = replies([busy()]);
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher: k.fetcher, waitMs: 50, file });
    await q.tell(new GitHubNeed({ cause: "restricted", org: "Acme", url: "https://github.com/settings/connections/applications/cid" }));
    await q.tell(new GitHubNeed({ cause: "sso", org: "other", url: "https://github.com/orgs/other/sso" }));
    await q.tell(new GitHubNeed({ cause: "scope", scope: "read:org" }));
    expect(q.pending()).toBe(3);
    q.forget("acme");
    expect(q.pending(), "only acme's kept restriction went, whatever its casing").toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).map((r: { need: { org?: string } }) => r.need.org)).toEqual(["other", undefined]);
    const before = k.seen.length;
    await q.flush();
    expect(k.seen.slice(before).map((s) => s.body), "acme's stale report is not replayed").not.toContainEqual(expect.objectContaining({ need: expect.objectContaining({ org: "Acme" }) }));
  });

  it("a flush does not send or delete a newer report that replaced an entry it started with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    const kept = (url: string, org = "acme") => ({ cause: "restricted", detail: "d", org, url });
    writeFileSync(file, JSON.stringify([
      { key: ["restricted", "", "other", ""].join("\u0000"), need: kept("https://github.com/settings/connections/applications/old", "other") },
      { key: ["restricted", "", "acme", ""].join("\u0000"), need: kept("https://github.com/settings/connections/applications/old") },
    ]));
    let release: (r: Response) => void = () => {};
    const seen: { need: { org?: string; url?: string } }[] = [];
    let hang = true, busyOnce = false;
    const fetcher = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body);
      if (hang) { hang = false; return new Promise<Response>((r) => (release = r)); }
      // acme refused again meets a kernel that cannot take it now, so the newer report is kept (the next pass takes it).
      if (body.need.org === "acme" && body.need.url?.endsWith("/new") && !busyOnce) { busyOnce = true; return new Response("busy", { status: 503 }); }
      return ok();
    }) as unknown as typeof fetch;
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher, waitMs: 50, file });
    const pass = q.flush();
    await new Promise((r) => setTimeout(r, 20));
    // The org is refused again with a newer link while the pass is on the first entry: it replaces acme's old entry.
    await q.tell(new GitHubNeed({ cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/new" }));
    release(ok());
    await pass;
    const tail = () => seen.map((b) => `${b.need.org}:${b.need.url?.split("/").at(-1)}`);
    expect(tail(), "the stale payload for acme never went in that pass").toEqual(["other:old", "acme:new"]);
    expect(q.pending(), "and the newer acme report is still kept").toBe(1);
    await q.flush();
    expect(tail(), "it is sent on its own turn").toEqual(["other:old", "acme:new", "acme:new"]);
    expect(q.pending()).toBe(0);
  });

  it("a success while a flush awaits an earlier report does not let that pass send the forgotten one", async () => {
    // Two needs kept by an earlier process, read back from disk: nothing is sent until the flush.
    const dir = mkdtempSync(join(tmpdir(), "needs-"));
    const file = join(dir, "connection-needs.json");
    const kept = (org: string) => ({ cause: "restricted", detail: "d", org, url: "https://github.com/settings/connections/applications/cid" });
    writeFileSync(file, JSON.stringify([
      { key: ["restricted", "", "other", ""].join("\u0000"), need: kept("other") },
      { key: ["restricted", "", "acme", ""].join("\u0000"), need: kept("acme") },
    ]));
    let release: (r: Response) => void = () => {};
    const seen: { need: { org?: string } }[] = [];
    let first = true;
    const fetcher = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? "{}")));
      if (first) { first = false; return new Promise<Response>((r) => (release = r)); }
      return ok();
    }) as unknown as typeof fetch;
    const q = needQueue({ kernelUrl: "http://kernel", key: () => "k", log, fetcher, waitMs: 50, file });
    expect(q.pending()).toBe(2);
    const pass = q.flush(); // sends the first and waits for its answer
    await new Promise((r) => setTimeout(r, 20));
    q.forget("acme"); // acme answered meanwhile
    release(ok());
    await pass;
    expect(seen.map((b) => b.need.org), "acme's report never went in that pass").toEqual(["other"]);
    await q.flush();
    expect(seen.map((b) => b.need.org)).toEqual(["other"]);
    expect(q.pending()).toBe(0);
  });
});
