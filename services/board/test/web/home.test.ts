// @vitest-environment happy-dom
// Home (web/src/Home.tsx): the greeting counts what needs the owner, rows are answered and snoozed in place from the keyboard,
// a block without data is left out, the cursor moves once per snapshot, and #/approvals/<id> opens a card that isn't listed.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { answer, card, home, key, mountApp, settle, unmountApp } from "./app-fixture";

afterEach(unmountApp);

describe("Home", () => {
  it("greets with the count of what needs the owner and leaves out an empty Today", async () => {
    const { el } = await mountApp("#/");
    expect(el.querySelector("h1")?.textContent).toContain("Three things need you; the rest is handled.");
    expect(el.textContent).not.toContain("Today");
  });

  it("approves the card row on J, J, E (newest first) with its digest, and shows a receipt with no Undo", async () => {
    const { el, sent } = await mountApp("#/");
    await key("j");
    await key("j");
    await key("e");
    await settle();
    const decide = sent.find((s) => s.path === `/api/approvals/${card.id}/decide`);
    expect(decide?.body).toMatchObject({ digest: card.digest, decision: "approve" });
    const row = el.querySelector(`#need-${card.id}`)!;
    expect(row.textContent).toContain("Approved");
    expect(row.textContent).not.toContain("Undo");
  });

  it("snoozes an answer row on S, and Undo brings it back", async () => {
    const { el, sent } = await mountApp("#/");
    await key("j");
    await key("s");
    await settle();
    expect(sent.find((s) => s.path === "/api/home/snooze")?.body).toEqual({ id: "id-815:2026-11-26T07:00:00Z", on: true });
    const undo = [...el.querySelectorAll<HTMLButtonElement>("#need-id-815 button")].find((b) => b.textContent === "Undo")!;
    await act(async () => undo.click());
    await settle();
    expect(sent.filter((s) => s.path === "/api/home/snooze").map((s) => s.body)).toContainEqual({ id: "id-815:2026-11-26T07:00:00Z", on: false });
  });

  it("marks the snapshot seen once, and refetches keep the visit's window", async () => {
    const { sent } = await mountApp("#/");
    await settle();
    expect(sent.filter((s) => s.path === "/api/home/seen")).toEqual([{ path: "/api/home/seen", method: "POST", body: { as_of: home.as_of } }]);
    window.dispatchEvent(new Event("focus"));
    const { load } = await import("../../web/src/cache");
    const { QUERIES } = await import("../../web/src/queries");
    await act(async () => void (await load(QUERIES.home.key, QUERIES.home.fetch, false, true)));
    expect(sent.filter((s) => s.path.startsWith("/api/home?")).map((s) => s.path)).toContain(`/api/home?from=${encodeURIComponent(home.since_from)}`);
  });

  it("doesn't mark a later snapshot with nothing new (a mark emits home, which refetches)", async () => {
    let n = 0;
    const { sent } = await mountApp("#/", (path, method) => (path.startsWith("/api/home") && method === "GET" ? answer({ ...home, as_of: `2026-11-26T08:00:0${n++ % 10}.000Z` }) : undefined));
    const { load } = await import("../../web/src/cache");
    const { QUERIES } = await import("../../web/src/queries");
    await act(async () => void (await load(QUERIES.home.key, QUERIES.home.fetch, false, true)));
    await settle();
    expect(sent.filter((s) => s.path === "/api/home/seen")).toHaveLength(1);
  });

  it("opens a row in the drawer over the page, and Esc closes it", async () => {
    const { el } = await mountApp("#/");
    await act(async () => (el.querySelector<HTMLElement>("#need-id-815 .ui-digest-open")!).click());
    expect(el.querySelector(".home-drawer")?.textContent).toContain("Which week?");
    expect(el.querySelector(".home-needs")).not.toBeNull();
    await key("Escape");
    await settle();
    expect(el.querySelector(".home-drawer")).toBeNull();
  });

  it("expands Needs you in place to every row counted, since an approval card has no Tasks page to open", async () => {
    const face = (name: string) => ({ key: name.toLowerCase(), name, job: "Follow-ups", face: null, state: "needs" as const });
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `open-${i}`, kind: "open" as const, teammate: face("Tess"), since: `2026-11-26T0${String(i % 10)}:00:00Z`, task: { identifier: `WOR-${900 + i}`, title: `Reply ${i}` }, question: `Reply to Sam ${i}` }));
    const { el } = await mountApp("#/", (path) => (path.startsWith("/api/home") && !path.startsWith("/api/home/") ? answer({ ...home, needs: rows, greeting: { needs: rows.length } }) : undefined));
    await settle();
    // Ten newest listed; the header shows all twelve.
    expect([...el.querySelectorAll("[id^='need-open-']")].length).toBe(10);
    const viewAll = [...el.querySelectorAll<HTMLButtonElement>(".home-needs button")].find((b) => b.textContent?.startsWith("View all 12"))!;
    expect(viewAll).toBeTruthy();
    await act(async () => viewAll.click());
    await settle();
    expect([...el.querySelectorAll("[id^='need-open-']")].length).toBe(12);
    expect([...el.querySelectorAll(".home-needs button")].some((b) => b.textContent === "Fewer")).toBe(true);
  });

  it("keeps the Home drawer's focus trap out of the way of a task drawer opened over it", async () => {
    const { el } = await mountApp("#/");
    await act(async () => (el.querySelector<HTMLElement>("#need-id-815 .ui-digest-open")!).click());
    const homeDrawer = el.querySelector<HTMLElement>(".home-drawer")!;
    expect(homeDrawer).not.toBeNull();
    // A task drawer over it (the board's Drawer): the Home drawer must not pull Tab or Escape back into itself.
    const over = document.createElement("div");
    over.className = "drawer-backdrop";
    const aside = document.createElement("aside");
    aside.className = "drawer task-drawer";
    over.append(aside);
    document.body.append(over);
    const first = homeDrawer.querySelector<HTMLElement>("button")!;
    const typed = document.createElement("button");
    over.querySelector("aside")!.append(typed);
    typed.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => void document.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => void document.dispatchEvent(esc));
    expect(esc.defaultPrevented).toBe(false);
    expect(el.querySelector(".home-drawer")).not.toBeNull();
    first.focus();
    over.remove();
  });

  it("writes a Source line's zoned time and date as dates, and a zone-less time as written", async () => {
    const { sourceDate } = await import("../../web/src/Home");
    const { when } = await import("../../web/src/util");
    expect(sourceDate("2026-10-05T13:47Z")).toBe(when("2026-10-05T13:47:00Z"));
    expect(sourceDate("2026-10-05T17:47+0400")).toBe(when("2026-10-05T13:47:00Z"));
    expect(sourceDate("2026-10-09")).toMatch(/Oct/);
    expect(sourceDate("2026-11-25 15:13")).toBeNull();
    expect(sourceDate("Thursday")).toBeNull();
  });

  it("keeps a completed decision when Later's snooze lands after it", async () => {
    // A slow connection: the approval is still in flight when Later is clicked; its success lands first, the snooze second.
    let resolveDecide!: (v: unknown) => void;
    let resolveSnooze!: (v: unknown) => void;
    const { el } = await mountApp("#/", (path, method) => {
      if (method !== "POST") return undefined;
      if (path === `/api/approvals/${card.id}/decide`) return new Promise((r) => (resolveDecide = r));
      if (path === "/api/home/snooze") return new Promise((r) => (resolveSnooze = r));
      return undefined;
    });
    await act(async () => el.querySelector<HTMLElement>(`#need-${card.id} .ui-digest-open`)!.click());
    await settle();
    const button = (text: string) => [...el.querySelectorAll<HTMLButtonElement>(".home-drawer button")].find((b) => b.textContent === text)!;
    await act(async () => button("Approve").click());
    await act(async () => button("Later").click());
    await act(async () => {
      resolveDecide(answer({ ok: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    await act(async () => {
      resolveSnooze(answer({ until: "2026-11-27T08:00:00Z" }));
      await new Promise((r) => setTimeout(r, 10));
    });
    await settle();
    const text = el.querySelector(".home-drawer")?.textContent ?? "";
    expect(text).toContain("Approved");
    expect(text).not.toContain("Hidden until");
    // The snooze it could not report is not offered as an Undo the decision can't be reversed by.
    expect(text).not.toContain("Undo");
  });

  it("opens a decided card that isn't in Needs you at #/approvals/<id>", async () => {
    const id = "k-00000000000000d1";
    const { el } = await mountApp(`#/approvals/${id}`, (path) => (path === `/api/approvals/${id}` ? answer({ approval: { ...card, id, state: "rejected", decidedBy: "account:u1" } }) : undefined));
    await settle();
    expect(el.querySelector(".home-drawer")?.textContent).toMatch(/Rejected/);
  });
});
