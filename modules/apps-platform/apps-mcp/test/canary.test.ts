// app_page_canary (canary.ts): mint → one-shot browser on the canary network → the page's own POST /.aidenhq/notify → revoke.
// The browser and kernel are fakes here, so the whole contract runs in CI; the real Chrome, the real test listener and a real
// page run in render.e2e.test.ts (AIDENHQ_BROWSER_E2E=1).
import assert from "node:assert/strict";
import { describe, expect, it } from "bun:test";
import { CANARY_NETWORK, WEB_NETWORK, renderArgs } from "../src/view.js";
import { CANARY_BASE, CANARY_DISCOVERY, CANARY_LISTENER_ADDRESS, CANARY_PORT, CANARY_SCRIPT, canaryContent, canaryOrigin, pageCanary, type CanaryDeps } from "../src/canary.js";
import { parseApp } from "../src/registry.js";

const app = parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "app-maintainer", description: "d", port: 4100, share: { host: "roadmap.example.com", aud: "aud-roadmap-0001" } });

/** A kernel that mints one session and records every call; `run` is the browser's answer. */
function deps(o: { mintStatus?: number; run?: object | (() => Promise<string>); onRun?: (input: any) => void; revokeStatus?: number } = {}) {
  const calls: { path: string; body: any }[] = [];
  const runs: { network: string; script: string; input: any; timeout: number }[] = [];
  const d: CanaryDeps = {
    kernel: async (path, body) => {
      calls.push({ path, body });
      if (path === "/v1/test-session") return o.mintStatus && o.mintStatus !== 200 ? { status: o.mintStatus, json: { error: { message: "refused" } } } : { status: 200, json: { id: "sess-1", app: "roadmap-keeper", host: "roadmap.example.com", expires: new Date(Date.now() + 900_000).toISOString(), code: "c".repeat(43), state: "0".repeat(32) } };
      if (path === "/v1/test-session/revoke") return { status: o.revokeStatus ?? 200, json: { revoked: 1 } };
      return { status: 404, json: {} };
    },
    run: async (network, script, input, timeout, before) => {
      runs.push({ network, script, input, timeout });
      o.onRun?.(input);
      // The renderer's own `before` (mint), as platform.ts runs it once the slot is this render's.
      const merged = before ? { ...input, ...(await before()) } : input;
      runs.at(-1)!.input = merged;
      const r = typeof o.run === "function" ? await o.run() : o.run ?? {};
      return JSON.stringify(r);
    },
  };
  return { d, calls, runs };
}

describe("app_page_canary", () => {
  it("mints for the app, runs the page on the canary network, and returns notify: fired with the reference and screenshot", async () => {
    const { d, calls, runs } = deps({ run: { status: 200, intake: true, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap Keeper", notify: "fired", notifyStatus: 204, reference: "TEST-RT-2026-11-24-1", submittedAt: "2026-11-24T09:00:00.000Z", png: "iVBORw0KGgo=" } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "TEST-RT-2026-11-24-1 canary", path: "/intake" }, d);
    expect(r).toMatchObject({ ok: true, status: 200, notify: "fired", notifyStatus: 204, reference: "TEST-RT-2026-11-24-1", screenshot: "iVBORw0KGgo=", session: { id: "sess-1", revoked: true } });
    // The session was minted for this app only, and revoked by id after the run.
    expect(calls.map((c) => [c.path, c.body])).toEqual([["/v1/test-session", { app: "roadmap-keeper" }], ["/v1/test-session/revoke", { sessionId: "sess-1" }]]);
    // The browser ran on the canary network, at the listener's host for this app, with the handoff's code and the text.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.network).toBe(CANARY_NETWORK);
    expect(runs[0]!.input).toMatchObject({ listener: `http://roadmap-keeper.${CANARY_BASE}:${CANARY_PORT}`, listenerAddress: CANARY_LISTENER_ADDRESS, code: "c".repeat(43), state: "0".repeat(32), path: "/intake", text: "TEST-RT-2026-11-24-1 canary" });
    // The tool's answer carries the screenshot as its own content part.
    const content = canaryContent(r);
    expect(content.content).toHaveLength(2);
    expect(content.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
  });

  it("a page that fired notify but never showed a reference is not a successful submission", async () => {
    // A same-origin analytics POST answering 200 is not the intake: without a reference the page itself displays, nothing
    // proves the feedback was saved, so the canary reports it unverified rather than ok.
    const { d } = deps({ run: { status: 200, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap", notify: "fired", notifyStatus: 204, reference: null } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, d);
    expect(r).toMatchObject({ ok: false, status: 200, notify: "fired", notifyStatus: 204, reference: null, session: { revoked: true } });
  });

  it("a reference the page showed before the click is never proof this submission saved", async () => {
    // The page already says "Reference ABC-123"; a regression posts only analytics and still calls notify. No intake POST can
    // be named, so the canary stays unverified even though the old reference is on screen.
    const { d } = deps({ run: { status: 200, intake: false, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap", notify: "fired", notifyStatus: 204, reference: null } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, d);
    expect(r).toMatchObject({ ok: false, notify: "fired", notifyStatus: 204, session: { revoked: true } });
  });

  it("an intake the app refused is not a successful submission, even when the page still fires notify", async () => {
    const { d } = deps({ run: { status: 500, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap", notify: "fired", notifyStatus: 204, reference: null } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, d);
    expect(r).toMatchObject({ ok: false, status: 500, notify: "fired", notifyStatus: 204, session: { revoked: true } });
  });

  it("a page that never posts notify is not-fired, and the session is still revoked", async () => {
    const { d, calls } = deps({ run: { status: 200, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap", notify: "not-fired", notifyStatus: null, reference: null } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, d);
    expect(r).toMatchObject({ ok: false, notify: "not-fired", notifyStatus: null, session: { revoked: true } });
    expect(calls.at(-1)).toEqual({ path: "/v1/test-session/revoke", body: { sessionId: "sess-1" } });
  });

  it("a refused mint never starts a browser; a failed browser run still revokes and reports why", async () => {
    // The mint happens as the render takes its slot, so the browser is never launched and there is nothing to revoke.
    const refused = deps({ mintStatus: 403 });
    await expect(pageCanary(app, { app: "roadmap-keeper", text: "x" }, refused.d)).rejects.toThrow(/refused \(403\)/);
    expect(refused.calls.map((c) => c.path)).toEqual(["/v1/test-session"]); // nothing to revoke
    const failed = deps({ run: { error: "no feedback field on the page", finalUrl: `${canaryOrigin("roadmap-keeper")}/` } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, failed.d);
    expect(r).toMatchObject({ ok: false, error: "no feedback field on the page", session: { revoked: true } });
    expect(failed.calls.at(-1)).toEqual({ path: "/v1/test-session/revoke", body: { sessionId: "sess-1" } });
  });

  it("an app that isn't shared has no test listener: refused before any session", async () => {
    const { d, calls } = deps();
    await expect(pageCanary(parseApp({ name: "notes", repo: "example-org/notes", owner: "a", description: "d" }), { app: "notes", text: "x" }, d)).rejects.toThrow(/isn't a shared app/);
    expect(calls).toEqual([]);
  });

  it("mints only once the render has a slot, so a queued run never spends the 60-second handoff", async () => {
    const { d, calls, runs } = deps({ run: { notify: "fired", notifyStatus: 204, reference: "R-1" } });
    let mintedWhenRun = false;
    const origRun = d.run;
    d.run = async (network, script, input, timeout, before) => {
      expect(calls.map((c) => c.path)).toEqual([]); // nothing minted while the browser was still waiting for a slot
      const raw = await origRun(network, script, input, timeout, before);
      mintedWhenRun = calls.some((c) => c.path === "/v1/test-session");
      return raw;
    };
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, d);
    expect(mintedWhenRun).toBe(true);
    expect(runs[0]!.input).toMatchObject({ code: "c".repeat(43), state: "0".repeat(32) });
    expect(r.session).toMatchObject({ id: "sess-1", revoked: true });
  });

  it("the renderer maps every *.canary.localhost name to the listener, follows the handoff, and reads the page's own notify", () => {
    const script = CANARY_SCRIPT;
    // The renderer is a JavaScript program built by string concatenation: a stray semicolon or an unescaped quote would
    // break apps-mcp only at run time, where no typecheck sees it. It must parse.
    assert.doesNotThrow(() => new Function(script));
    expect(script).toContain('"/.auth/handoff?"');
    expect(script).toContain("--host-resolver-rules=MAP *.canary.localhost");
    expect(script).toContain('new URL(n.url).pathname === "/.aidenhq/notify"');
    expect(script).toContain("document.body.innerText");
    // The feedback form is chosen by its own wording, never "the first textbox and the first button"; the discovery rule is
    // exercised on the real snapshot outline in the tests below.
    expect(script).toContain("const FEEDBACK =");
    // "message" and bare "comment" are not feedback wording: a chat composer must never be taken for the intake.
    expect(script).not.toMatch(/const FEEDBACK = \/[^/]*message/);
    expect(script).toContain("const field = await canaryFindField(snap");
    // The submit is chosen from the form that owns the filled field (the DOM form property, so a footer button linked by
    // form="…" counts), never from the page at large, and the send rule runs in Node (the tests exercise it directly).
    expect(script).toContain("data-aidenhq-canary-scope");
    expect(script).toContain("const scope = document.querySelector('[data-aidenhq-canary-scope]')");
    expect(script).toContain("const own = (b) => f ? true : dialogOf(b) === dlg;");
    expect(script).toContain("const inScope = (b) => f ? b.form === f : !!scope && scope.contains(b) && !b.form;");
    expect(script).toContain("const isSubmit = (b) =>");
    expect(script).toContain("const submit = canarySubmit(scopeOf && scopeOf.list, scopeOf && scopeOf.form);");
    // A dialog that is not a <form> scopes the submit to the field's own dialog, and only there may a type=button button send.
    expect(script).toContain("const SEL = \"'[role=dialog],[role=alertdialog],dialog'\"");
    // The scope is pinned to the field that was filled, not to whatever has focus when the controls are listed.
    expect(script.indexOf('data-aidenhq-canary-scope')).toBeLessThan(script.indexOf("const controls = await within"));
    expect(script).toContain("const own = (b) => f ? true : dialogOf(b) === dlg;");
    expect(script).toContain("data-aidenhq-canary-submit");
    expect(script).toContain("no submit control in the feedback form");
    // The fill is tied to the element that was marked, never to whatever has focus after a re-render, and the control's
    // accessible name is read the same way when it is listed and when it is marked (an icon-only button has no text).
    expect(script).toContain("data-aidenhq-canary-field");
    expect(script).toContain("the feedback field did not keep the text");
    expect(script).toContain("const nameOf = (b) =>");
    // Evidence starts at the click: a POST a fill triggered is never read as the submission's intake.
    expect(script.indexOf("const submittedAt = Date.now();")).toBeLessThan(script.indexOf('await ab("click", "[data-aidenhq-canary-submit]")'));
    // The handoff's code and state never come back in a URL or an error the tool returns.
    expect(script).toContain("const scrub =");
    expect(script).toContain("finalUrl: scrub(finalUrl)");
    // The intake is the POST before notify that carries the reference, not whatever the page posts last.
    expect(script).toContain("x.at <= notify.at");
    expect(script).toContain("intakeAnswer ?? (intake.length === 1 ? intake[0] : null)");
    // Service workers are bypassed: the gate's own answer is what the canary sees, never a cached or synthesized one.
    expect(script).toContain("Network.setBypassServiceWorker");
    expect(script).toContain("notify && !notify.synthetic ? (notify.hop ?? notify.status) : null");
    // The notify's own answer is waited for, and it is the POST's first hop.
    expect(script).toContain("notify.status == null && Date.now() - tn < 10000");
    // The intake is the POST whose reference the page shows, not any POST with an id.
    // A whole token only: a body's id 42 is not shown by "142" or "4200" the page prints for something else.
    expect(script).toContain("shows(shown, v) && !shows(beforeShown, v)");
    expect(script).toContain("t.replace(/[.:]+$/, '')");
    expect(script).toContain("intake.some((x) => x.status == null)");
    // The image's launch maps the canary names to the listener's address, and the network is the one renderArgs allows.
    expect(renderArgs(CANARY_NETWORK, "img")).toContain(CANARY_NETWORK);
    // No DNS that could leave the host from the canary bridge (the listener's name comes from Chrome's resolver rule).
    expect(renderArgs(CANARY_NETWORK, "img")).toContain("--dns");
    expect(renderArgs(CANARY_NETWORK, "img")[renderArgs(CANARY_NETWORK, "img").indexOf("--dns") + 1]).toBe("127.0.0.1");
    expect(renderArgs(WEB_NETWORK, "img")).not.toContain("--dns");
    expect(renderArgs(CANARY_NETWORK, "img").slice(0, -1).join(" ")).not.toMatch(/--cap-add|--privileged|-v |--volume|--mount/);
  });
  // The discovery rules run here on the very snapshot outline the canary reads, so the dialog shape that broke the live run is
  // covered without Chrome: the same source string is what the renderer executes.
  describe("feedback form discovery", () => {
    const api = () => new Function(CANARY_DISCOVERY + "; return { canaryTree, canaryField, canaryEntries, canaryFindField, canarySubmit };")() as {
      canaryTree: (text: string, refs?: Record<string, { role: string; name: string }>) => { role: string; name: string; ref: string }[];
      canaryField: (nodes: unknown[]) => { role: string; name: string; ref: string } | null;
      canaryEntries: (nodes: unknown[]) => { role: string; name: string; ref: string }[];
      canaryFindField: (snap: () => Promise<{ tree: unknown[] }>, click: (entry: { role: string; name: string; ref: string }) => Promise<boolean | void>, back?: () => Promise<void>) => Promise<{ role: string; name: string; ref: string } | null>;
      canarySubmit: (controls: unknown[], inForm: boolean) => { tag: string; type: string; word: string } | null;
    };
    // The page as roadmap-keeper's /?intake=feedback renders it (WOR-11418): a banner button, the page's own display-name box,
    // and the feedback dialog the button opens.
    const LANDING = `
- banner
  - generic
    - button "Add item" [ref=e7]
    - button "Provide feedback" [ref=e8]
- main
  - heading "Roadmap" [level=1, ref=e5]
  - textbox "Display name" [ref=e6]`;
    const DIALOG = `
- dialog "Provide feedback"
  - heading "Provide feedback" [level=2, ref=e9]
  - paragraph
    - StaticText "Tell us what should change on the roadmap. Feedback about the page or the data goes to Roadmap Keeper."
  - form
    - LabelText
      - StaticText "What should change?"
    - textbox "What should change?" [required, ref=e10]
    - button "Cancel" [ref=e11]
    - button "Send feedback" [ref=e12]
  - button "Close" [ref=e13]`;

    it("follows the page's own 'Provide feedback' button to open the dialog before choosing a field", async () => {
      const { canaryTree, canaryField, canaryEntries, canaryFindField } = api();
      const landing = canaryTree(LANDING);
      // Nothing on the landing page is a feedback field, and the walk's entry is the button, not the display-name box.
      expect(canaryField(landing)).toBeNull();
      expect(canaryEntries(landing)[0]).toMatchObject({ role: "button", name: "Provide feedback", ref: "e8" });
      const clicks: string[] = [];
      let shown = LANDING;
      const field = await canaryFindField(async () => ({ tree: canaryTree(shown) }), async (entry) => {
        clicks.push(entry.name);
        shown = LANDING + DIALOG;
      });
      expect(clicks).toEqual(["Provide feedback"]);
      expect(field).toMatchObject({ role: "textbox", name: "What should change?", ref: "e10" });
    });

    it("only follows a button that says it opens the form, never a feedback listing's write control", async () => {
      const { canaryTree, canaryEntries, canaryFindField } = api();
      // A member-visible listing: "Withdraw feedback" and "Resolve feedback" would change real records under the test identity.
      // Only "Provide feedback" is an opener, so it is the one clicked.
      const listing = `
- heading "Feedback for this page" [level=2, ref=e1]
- listitem
  - text "Wording is unclear"
  - button "Withdraw feedback" [ref=e2]
  - button "Resolve feedback" [ref=e3]
- button "Provide feedback" [ref=e4]`;
      expect(canaryEntries(canaryTree(listing)).map((e) => e.name)).toEqual(["Provide feedback"]);
      const clicks: string[] = [];
      let shown = listing;
      const field = await canaryFindField(async () => ({ tree: canaryTree(shown) }), async (entry) => {
        clicks.push(entry.name);
        shown = listing + DIALOG;
      });
      expect(clicks).toEqual(["Provide feedback"]);
      expect(field).toMatchObject({ name: "What should change?", ref: "e10" });
    });

    it("reports 'no feedback field on the page' and submits nothing when no feedback form opens", async () => {
      const { canaryTree, canaryField, canaryFindField } = api();
      const profile = canaryTree(`
- main
  - heading "Profile" [level=1, ref=e1]
  - textbox "Display name" [ref=e2]
  - button "Save" [ref=e3]`);
      expect(canaryField(profile)).toBeNull();
      expect(await canaryFindField(async () => ({ tree: profile }), async () => { throw new Error("clicked a control that is not a feedback entry"); })).toBeNull();
      // No filled field means pageCanary returns before any fill or submit (the renderer's own guard).
      expect(CANARY_SCRIPT).toContain('if (!field) return out({ error: "no feedback field on the page"');
      expect(CANARY_SCRIPT.indexOf('if (!field) return out({ error: "no feedback field on the page"')).toBeLessThan(CANARY_SCRIPT.indexOf('await ab("fill", "@" + box, r.text);'));
      expect(CANARY_SCRIPT).toContain('await ab("click", "[data-aidenhq-canary-submit]")');
      // Both real guards exist, and each comes before the click that submits.
      const clickAt = CANARY_SCRIPT.indexOf('await ab("click", "[data-aidenhq-canary-submit]")');
      const noSubmit = CANARY_SCRIPT.indexOf('if (!submit) return out({ error: "no submit control in the feedback form');
      const noMark = CANARY_SCRIPT.indexOf('if (!marked.result) return out({ error: "no submit control in the feedback form');
      expect(noSubmit).toBeGreaterThan(-1);
      expect(noMark).toBeGreaterThan(-1);
      expect(noSubmit).toBeLessThan(clickAt);
      expect(noMark).toBeLessThan(clickAt);
    });

    it("does not take a send-named control for the entry point, nor a feedback-named button that destroys data", () => {
      const { canaryTree, canaryEntries } = api();
      // Only the submit is on the page: clicking it would send nothing, so there is no entry to follow.
      expect(canaryEntries(canaryTree(`
- form
  - textbox "What should change?" [ref=e1]
  - button "Send feedback" [ref=e2]`))).toEqual([]);
      // A feedback listing's write controls are feedback-named too, and clicking one would change a real record. Only a
      // control that says it opens the form is an entry; the destructive and state-changing ones never are.
      const listing = canaryTree(`
- listitem
  - text "Looks good"
  - button "Withdraw feedback" [ref=e1]
  - button "Resolve feedback" [ref=e2]
  - button "Upvote feedback" [ref=e3]
  - button "Delete feedback" [ref=e4]
  - button "Feedback history" [ref=e5]
  - button "Provide feedback" [ref=e6]`);
      expect(canaryEntries(listing).map((e) => e.name)).toEqual(["Provide feedback"]);
      expect(canaryEntries(listing)[0]).toMatchObject({ role: "button", name: "Provide feedback", ref: "e6" });
    });

    it("reads the ref from snapshot metadata, never from a quoted accessible name", () => {
      const { canaryTree, canaryEntries } = api();
      // An item's title carries the literal text "ref=e1"; the button's own ref is e2. Discovery must use e2, or the click
      // lands on whatever control happens to own e1.
      const along = canaryTree(`
- button "Provide feedback ref=e9"
- button "Provide feedback" [ref=e1]`);
      // The first button has no ref of its own, but its accessible name contains "ref=e9"; discovery must not take that for
      // a ref, so the only clickable opener is the second one with the real ref.
      expect(along[0]).toMatchObject({ name: "Provide feedback ref=e9", ref: "" });
      expect(along[1]).toMatchObject({ ref: "e1" });
      expect(canaryEntries(along).map((e) => e.ref)).toEqual(["e1"]);
    });

    it("refuses two fields that both name themselves feedback", () => {
      const { canaryTree, canaryField } = api();
      expect(canaryField(canaryTree(`
- dialog "Provide feedback"
  - textbox "Your feedback" [ref=e1]
  - textbox "Feedback about the page" [ref=e2]
  - button "Send feedback" [ref=e3]`))).toBeNull();
    });

    it("goes back from a history page a feedback link navigates to, then follows the button that opens the form", async () => {
      const { canaryTree, canaryEntries, canaryFindField } = api();
      // The "Feedback history" link really navigates: the destination has no feedback control, so the walk must return to
      // the page it started on and click "Provide feedback" there (a control from the start page, not the destination's).
      const landing = `
- link "Feedback history" [ref=e1]
- button "Provide feedback" [ref=e2]`;
      // The history page reuses the refs: its own copy of the nav, and nothing that opens a feedback form.
      const history = `
- link "Roadmap" [ref=e3]
- heading "Feedback history" [level=1, ref=e4]`;
      expect(canaryEntries(canaryTree(landing)).map((e) => e.name)).toEqual(["Feedback history", "Provide feedback"]);
      let shown = landing;
      const clicks: string[] = [], backs: string[] = [];
      const field = await canaryFindField(async () => ({ tree: canaryTree(shown) }), async (entry) => {
        clicks.push(entry.name);
        if (entry.name === "Feedback history") shown = history;
        if (entry.name === "Provide feedback") shown = landing + DIALOG;
      }, async () => {
        backs.push(shown);
        shown = landing;
      });
      expect(clicks).toEqual(["Feedback history", "Provide feedback"]);
      expect(backs).toEqual([history]);
      expect(field).toMatchObject({ name: "What should change?", ref: "e10" });
    });

    it("takes a feedback send, not a share or settings control that merely mentions feedback", () => {
      const { canarySubmit } = api();
      // Both labels mention feedback; only "Send feedback" submits the filled field. A lone share/settings control is refused
      // rather than clicked.
      expect(canarySubmit([
        { tag: "BUTTON", type: "button", text: "Share feedback link" },
        { tag: "BUTTON", type: "button", text: "Send feedback" },
      ], false)).toMatchObject({ word: "Send feedback" });
      expect(canarySubmit([{ tag: "BUTTON", type: "button", text: "Share feedback link" }], false)).toBeNull();
      expect(canarySubmit([{ tag: "BUTTON", type: "button", text: "Feedback settings" }], false)).toBeNull();
      // An icon-only button's accessible name is what it is marked by, so the listing and the marking see the same word.
      expect(canarySubmit([{ tag: "BUTTON", type: "button", text: "Submit your feedback" }], false)).toMatchObject({ word: "Submit your feedback" });
    });

    it("never submits a control from a dialog nested inside the field's dialog", () => {
      const { canarySubmit } = api();
      // The field's dialog has a "Send feedback"; a nested confirmation dialog has one too. Only the outer one sends it.
      expect(canarySubmit([
        { tag: "BUTTON", type: "button", text: "Cancel", nested: false },
        { tag: "BUTTON", type: "button", text: "Send feedback", nested: true },
      ], false)).toBeNull();
      expect(canarySubmit([
        { tag: "BUTTON", type: "button", text: "Send feedback", nested: true },
        { tag: "BUTTON", type: "button", text: "Send feedback", nested: false },
      ], false)).toMatchObject({ word: "Send feedback" });
    });
  });
});
