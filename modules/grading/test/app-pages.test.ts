// A rubric's page path is captured as the rubric names it (WOR-9900): a query string's state is kept, its placeholder encoded
// rather than dropped, and the capture reaches a long page's named region instead of stopping at its first 8,000 characters.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PAGE_CAP, PAGE_MAX, PAGE_TOTAL, gradePrompt, liveEvidence, rubricPaths } from "../service/src/grader/grade.ts";

/** apps-mcp's plainPath (api.ts:32-38), the check every captured path must still pass; kept here so this suite needs no install. */
const PLAIN_QUERY = /^[A-Za-z0-9._~=&%+,:-]*$/;
const plain = (path: string) => {
  const [p = "", ...q] = path.split("?");
  assert.match(p, /^\/[A-Za-z0-9._~\/-]*$/, `${path}: a plain path`);
  assert.ok(!p.includes("//") && !p.split("/").some((s) => s === "." || s === ".."), `${path}: no traversal`);
  assert.equal(q.length <= 1, true, `${path}: one ?`);
  assert.match(q.join("?"), PLAIN_QUERY, `${path}: a plain query`);
};

const APP = { name: "roadmap-keeper", sha: "a".repeat(40) };

describe("rubricPaths", () => {
  it("keeps a query string as written, encoding a placeholder value rather than dropping it", () => {
    const paths = rubricPaths(["The /slipped?q=<item> page shows the item's row", "and the root /?q=<item> filters to it"]);
    assert.deepEqual(paths, ["/", "/slipped?q=%3Citem%3E", "/?q=%3Citem%3E"]);
    for (const p of paths) plain(p);
  });

  it("keeps a concrete query, a retired route, and the prose around them", () => {
    assert.deepEqual(rubricPaths(["`/slipped?q=CMBT` lists it"]), ["/", "/slipped?q=CMBT"]);
    assert.deepEqual(rubricPaths(["The /audit page shows both original ETA events."]), ["/", "/audit"]);
    assert.deepEqual(rubricPaths(['The "/changes?tab=open" page, not /audit/.. or 390/1280']), ["/", "/changes?tab=open"]);
  });

  it("keeps a quoted value's space whole, and ends a bare value at the prose's space", () => {
    // A quote is the rubric's own wrapping: it ends the value, so the prose after it is never swallowed into the query.
    assert.deepEqual(rubricPaths(['the "/items?q=ETA-7" page']), ["/", "/items?q=ETA-7"]);
    // A value's own quotes are dropped and the value kept whole, space included.
    assert.deepEqual(rubricPaths(['the /items?q="Big ETA" page']), ["/", "/items?q=Big%20ETA"]);
    // Unquoted, the space is the prose's: the URL the rubric wrote ends there, and nothing past it is invented.
    assert.deepEqual(rubricPaths(["/items?name=Big ETA"]), ["/", "/items?name=Big"]);
    // Every character plainPath takes stays as written, `+` included.
    assert.equal(rubricPaths(["/items?q=a&b=c+d"]).at(-1), "/items?q=a&b=c+d");
  });

  it("ends a query at an inner quote instead of pairing it with a later one and swallowing prose", () => {
    const paths = rubricPaths(['the /items?q=x" then /audit shows both events']);
    assert.deepEqual(paths, ["/", "/items?q=x", "/audit"]);
  });

  it("never reads a `/` inside a query as another route", () => {
    assert.deepEqual(rubricPaths(["/items?next=/audit&q=1 shows it"]), ["/", "/items?next=%2Faudit&q=1"]);
    plain(rubricPaths(["/items?next=/audit&q=1 shows it"])[1]!);
  });

  it("resumes the scan after the query's encoded end, not its raw end", () => {
    // The value "Big ETA" encodes longer than it was written; the scan must not land inside it and lose the route after it.
    assert.deepEqual(rubricPaths(['/items?q="Big ETA" and /audit shows both']), ["/", "/items?q=Big%20ETA", "/audit"]);
    // A multi-byte character is longer encoded still.
    assert.deepEqual(rubricPaths(['/items?q="日本" then /changes shows it']), ["/", "/items?q=%E6%97%A5%E6%9C%AC", "/changes"]);
  });

  it("treats a quote closing a quoted URL as the URL's end, not as a value's opening quote", () => {
    // The URL is wrapped in quotes and its own value is quoted: only the first quote closes the URL, the inner pair is the value.
    assert.deepEqual(rubricPaths(['see "/items?q=x" then /audit']), ["/", "/items?q=x", "/audit"]);
  });

  it("keeps a quoted value inside a Markdown code span", () => {
    // A backtick is a code span, not a prose quote: the value inside it is the rubric's.
    assert.deepEqual(rubricPaths(['`/items?q="Big ETA"` lists it']), ["/", "/items?q=Big%20ETA"]);
    assert.deepEqual(rubricPaths(['`/items?q="a&b=c"` and `/audit`']), ["/", "/items?q=a%26b%3Dc", "/audit"]);
  });

  it("encodes a quoted value before it joins other query parameters", () => {
    // An `&` inside a quoted value must stay that value, not start a new parameter.
    assert.equal(rubricPaths(['/items?q="a&b=c" lists it'])[1], "/items?q=a%26b%3Dc");
    assert.equal(rubricPaths(['/items?q="a+b" lists it'])[1], "/items?q=a%2Bb");
    assert.equal(rubricPaths(['/items?q="x/y" lists it'])[1], "/items?q=x%2Fy");
    for (const p of rubricPaths(['/items?q="a&b=c" x'])) plain(p);
  });

  it("bounds the list at five paths, as before", () => {
    assert.equal(rubricPaths(["/a /b /c /d /e /f"]).length, 5);
  });
});

describe("liveEvidence", () => {
  /** A fake apps-mcp view: each page's snapshot is `snapshot(path)`, cut by apps-mcp's own cap. */
  const view = (snapshot: (path: string) => string) => async (name: string, path: string) => {
    assert.equal(name, APP.name);
    const snap = snapshot(path);
    return { status: 200, url: `http://127.0.0.1:8080${path}`, title: "Roadmap", timed_out: false, snapshot: snap, truncated: snap.length > PAGE_CAP, snapshotCap: PAGE_CAP, sha_before: APP.sha, sha_after: APP.sha };
  };

  it("captures a page longer than the old 8,000-character window whole, with the named row near its end", async () => {
    const row = '- row "original ETA event: CMBT slipped"';
    const long = `${"- row \"filler\"\n".repeat(1_500)}${row}`; // ~21,000 characters: past the old PAGE_MAX and the old SNAPSHOT_CAP
    assert.ok(long.length > 20_000 && long.length < PAGE_MAX);
    const ev = await liveEvidence(APP, ["the /slipped?q=<item> page shows the original ETA event"], { view: view((p) => (p === "/slipped?q=%3Citem%3E" ? long : "- heading \"Home\"")) });
    const page = Object.entries(ev.data).find(([, text]) => (text as string).includes("CMBT slipped"))?.[1] as string;
    assert.ok(page, "the named row's page is in the data");
    assert.ok(page.endsWith(row), "the whole page, not a prefix, so the named row near its end is there");
    const fact = ev.facts.find((f: string) => f.includes("/slipped?q=%3Citem%3E"))!;
    assert.doesNotMatch(fact, /text cut/, "a page under the cap says nothing was cut");
  });

  it("asks apps-mcp for PAGE_CAP, and keeps the cut fact honest when a page is still longer than PAGE_MAX", async () => {
    const huge = "- row \"filler\"\n".repeat(20_000); // 280,000 characters: longer than the capture cap
    const ev = await liveEvidence(APP, ["the /audit page shows both original ETA events"], {
      view: async (_n: string, _p: string) => {
        return { status: 200, url: "http://127.0.0.1:8080/changes", title: "Updates", timed_out: false, snapshot: huge.slice(0, PAGE_CAP), truncated: huge.length > PAGE_CAP, snapshotCap: PAGE_CAP, sha_before: APP.sha, sha_after: APP.sha };
      },
    });
    const fact = ev.facts.find((f: string) => f.includes("/audit"))!;
    const shown = (ev.data.LIVE_PAGE_2 as string).length;
    assert.equal(shown, PAGE_MAX, "the block is still bounded by PAGE_MAX");
    assert.match(fact, new RegExp(`text cut to its first ${PAGE_MAX} of \\d+ characters \\(the snapshot itself was cut at ${PAGE_CAP}\\)`));
  });

  it("shares PAGE_TOTAL across five pages, so all five are represented and together stay bounded", async () => {
    const page = "- row \"filler\"\n".repeat(9_000); // 126,000 characters each, over PAGE_MAX
    const ev = await liveEvidence(APP, ["/a /b /c /d"], { view: view(() => page) });
    const kept = Object.values(ev.data).map((text) => (text as string).length);
    assert.equal(kept.length, 5);
    assert.ok(kept.every((n) => n === Math.floor(PAGE_TOTAL / 5)), "each page keeps its equal share");
    assert.ok(kept.reduce((a, b) => a + b, 0) <= PAGE_TOTAL, "the five blocks together stay within PAGE_TOTAL");
    assert.ok(ev.facts.every((f: string) => /text cut to its first \d+ of \d+ characters \(all pages together keep/.test(f)), "each cut page says which bound cut it");
  });

  it("gives the pages that were cut the share a short page did not use", async () => {
    const long = "- row \"filler\"\n".repeat(9_000); // 126,000 characters: cut at its equal share
    const short = "- heading \"Home\"\n"; // well under its share
    const ev = await liveEvidence(APP, ["/a /b /c /d"], { view: view((p) => (p === "/a" ? short : long)) });
    const lengths = Object.values(ev.data).map((text) => (text as string).length);
    assert.ok(lengths.reduce((a, b) => a + b, 0) <= PAGE_TOTAL, "all pages together stay within PAGE_TOTAL");
    // Paths are ["/", "/a", "/b", "/c", "/d"]: the second is the short one.
    assert.ok((ev.data.LIVE_PAGE_2 as string).endsWith(short), "the short page keeps exactly its own text, uncut");
    assert.doesNotMatch(ev.facts[1]!, /text cut/, "a page under its share says nothing was cut");
    // A cut page (the first) takes what the short page left, above its equal share, so no budget goes unused.
    assert.ok(lengths[0]! > Math.floor(PAGE_TOTAL / 5), "a cut page takes what the short page left, above its equal share");
    assert.ok(lengths.every((n) => n <= PAGE_MAX), "no page exceeds PAGE_MAX");
  });

  it("records an app with no HTTP surface as not-applicable, not as a page it failed to capture", async () => {
    // apps-mcp's answer for a warehouse-shaped app (stateful, expose: false, no health.url): no page exists to render.
    const ev = await liveEvidence(APP, ["Every nav link's page renders at its own path"], {
      view: async () => ({ unavailable: `${APP.name} has no health.url, so there's no page to view`, noHttp: true }),
    });
    assert.equal(ev.data && Object.keys(ev.data).length, 0, "no live page is made up for an app with no page");
    assert.equal(ev.facts.length, 1);
    assert.match(ev.facts[0], new RegExp(`^app ${APP.name}: no HTTP surface \\(${APP.name} has no health\\.url`));
    assert.match(ev.facts[0], /so it has no live pages and its page criteria do not apply$/);
    assert.doesNotMatch(ev.facts[0], /not captured/, "a page that never existed is not a capture that failed");
  });

  it("keeps a restricted or non-local app reading as could-not-capture, never as no page", async () => {
    for (const unavailable of [`${APP.name} is restricted to roles, so the grader doesn't capture its pages`, `${APP.name} runs on docker context vps; only local apps can be viewed`]) {
      const ev = await liveEvidence(APP, ["Every nav link's page renders at its own path"], { view: async () => ({ unavailable }) });
      assert.equal(ev.facts.length, 1);
      assert.match(ev.facts[0], new RegExp(`^app ${APP.name}: live pages could not be captured \\(`));
      assert.doesNotMatch(ev.facts[0], /no HTTP surface|page criteria do not apply/, `${unavailable}: a page the grader could not look at is not a page that doesn't exist`);
    }
  });

  it("tells the grader a scoped criterion whose condition the facts deny is met, not unknown", () => {
    const { system } = gradePrompt({ rubric: ["Where the app serves HTTP, every nav link's page renders at its own path"], deliverable: { kind: "app" }, facts: [], data: {} });
    assert.match(system, /page criteria do not apply"\), the criterion is met: answer yes/);
    assert.match(system, /could not be captured \(a restricted or non-local app\) is not such a fact and leaves the criterion unknown/);
  });

  it("puts a long page's whole text into its fenced block in the grader's prompt", async () => {
    const long = `${"- row \"filler\"\n".repeat(2_000)}- row "the named row"`; // ~28,000 characters, over the old 20,000 prompt cut
    const { user } = gradePrompt({ rubric: ["the /changes page shows the named row"], deliverable: { kind: "app" }, facts: [], data: { LIVE_PAGE_1: long } });
    assert.match(user, /<<<LIVE_PAGE_1\n/);
    assert.ok(user.includes("- row \"the named row\"\nLIVE_PAGE_1>>>"), "the end of a long page is in the prompt");
  });
});
