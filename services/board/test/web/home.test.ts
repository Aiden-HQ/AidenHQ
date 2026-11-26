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

  it("approves the card row on J, J, J, E with its digest, and shows a receipt with no Undo", async () => {
    const { el, sent } = await mountApp("#/");
    await key("j");
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
    expect(sent.find((s) => s.path === "/api/home/snooze")?.body).toEqual({ id: "id-841", on: true });
    const undo = [...el.querySelectorAll<HTMLButtonElement>("#need-id-841 button")].find((b) => b.textContent === "Undo")!;
    await act(async () => undo.click());
    await settle();
    expect(sent.filter((s) => s.path === "/api/home/snooze").map((s) => s.body)).toContainEqual({ id: "id-841", on: false });
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

  it("opens a decided card that isn't in Needs you at #/approvals/<id>", async () => {
    const id = "k-00000000000000d1";
    const { el } = await mountApp(`#/approvals/${id}`, (path) => (path === `/api/approvals/${id}` ? answer({ approval: { ...card, id, state: "rejected", decidedBy: "account:u1" } }) : undefined));
    await settle();
    expect(el.querySelector(".ui-detail")?.textContent).toMatch(/Rejected/);
  });
});
