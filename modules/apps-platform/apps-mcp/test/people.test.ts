import { expect, it } from "vitest";
import { decideIdentity, proposals } from "../src/people.js";

// Only a proposed link can be decided; the decision records who and why, and a decided link is refused.
it("people: decides a proposed link once, recording who and why", async () => {
  const ran: Record<string, string>[] = [];
  const deps = (status?: string, email = "ann@acme.com", personEmail = "ann@acme.com") =>
    ({ pool: { query: async () => ({ rows: status ? [{ status, email, person_email: personEmail }] : [] }) }, sql: async (_s: string, v: Record<string, string>) => (ran.push(v), "") }) as any;
  const a = { source: "slack", source_user_id: "U1", decision: "confirm" as const, reason: "same email, same name" };
  expect(await decideIdentity(deps("proposed"), "librarian", a)).toMatchObject({ status: "approved", decided_by: "librarian" });
  expect(ran[0]).toMatchObject({ status: "approved", by: "librarian", reason: "same email, same name", uid: "U1" });
  await expect(decideIdentity(deps("approved"), "librarian", a)).rejects.toThrow(/already approved/);
  await expect(decideIdentity(deps(), "librarian", a)).rejects.toThrow(/no identity link/);
  // Code checks a confirm: the link's email must be the person's email, whatever the agent was told; a reject always works.
  await expect(decideIdentity(deps("proposed", "Ann@Other.com"), "librarian", a)).rejects.toThrow(/email/);
  await expect(decideIdentity(deps("proposed", null as any), "librarian", a)).rejects.toThrow(/email/);
  expect(await decideIdentity(deps("proposed", "x@y.com"), "librarian", { ...a, decision: "reject" })).toMatchObject({ status: "rejected" });
});

// Links are proposed only where two sources show the same email; names never link anyone; existing links are kept.
it("people: proposes identity links on an exact email match across sources, nothing else", () => {
  const u = (source: string, user_id: string, email: string | null, display_name = "x", is_bot = false) => ({ source, user_id, email, display_name, is_bot });
  const users = [
    u("slack", "U1", "Ann@Acme.com", "Ann"),
    u("jira", "a-1", "ann@acme.com", "Ann Lee"),
    u("slack", "U2", "bob@acme.com", "Bob"), // one source only: stays unlinked
    u("jira", "b-9", null, "Bob"), // same name, no email: never linked
    u("slack", "U3", "noreply@acme.com"),
    u("jira", "n-1", "noreply@acme.com"), // noreply: skipped
    u("slack", "U4", "cat@acme.com", "Cat"),
    u("jira", "c-1", "cat@acme.com", "Cat", true), // a bot: skipped
    u("slack", "U5", "dan@acme.com", "Dan"),
    u("github", "77", "dan@acme.com", "dan"), // joins Dan's existing person, which a single source can't create
  ];
  const linked = [{ source: "slack", source_user_id: "U5", person_id: 7 }];
  expect(proposals(users, linked)).toEqual([
    { email: "ann@acme.com", display_name: "Ann", person_id: null, members: [{ source: "slack", user_id: "U1", display_name: "Ann" }, { source: "jira", user_id: "a-1", display_name: "Ann Lee" }] },
    { email: "dan@acme.com", display_name: "Dan", person_id: 7, members: [{ source: "github", user_id: "77", display_name: "dan" }] },
  ]);
});
