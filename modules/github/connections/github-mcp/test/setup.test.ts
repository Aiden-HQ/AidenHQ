import { describe, expect, it } from "vitest";
import { GitHub, GitHubRefused } from "../src/github.js";
import { setup } from "../src/setup.js";
import { accessFor } from "./fake-access.js";

const BASE = "b".repeat(40), TIP = "c".repeat(40), NEW = "d".repeat(40);
const body = (over: object = {}) => ({ repo: "acme/widgets", base: BASE, branch: "aidenhq/deepsec-setup", expected_tip: null, files: { ".deepsec/INFO.md": "# info\n" }, title: "Add deepsec", body: "Setup.", ...over });

/** A fake GitHub: the branch's tip (null: absent), the open PRs, and every write it received. */
function fake(o: { tip?: string | null; open?: { html_url: string; number: number }[] }) {
  const writes: { method: string; path: string; body: any }[] = [];
  const access = accessFor((url, init) => {
    const u = new URL(url), method = init.method ?? "GET", path = u.pathname;
    const json = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, path, body: json });
    const ok = (b: unknown, status = 200) => ({ status, json: async () => b });
    if (path.startsWith("/repos/acme/widgets/branches/")) return o.tip ? ok({ commit: { sha: o.tip } }) : ok({ message: "Branch not found" }, 404);
    if (path.startsWith("/repos/acme/widgets/commits/")) return ok({ commit: { tree: { sha: "t".repeat(40) } } });
    if (path.endsWith("/git/trees")) return ok({ sha: "e".repeat(40) }, 201);
    if (path.endsWith("/git/commits")) return ok({ sha: NEW }, 201);
    if (path.includes("/git/refs")) return ok({}, method === "POST" ? 201 : 200);
    if (path === "/repos/acme/widgets/pulls" && method === "GET") return ok(o.open ?? []);
    if (path === "/repos/acme/widgets/pulls") return ok({ html_url: "https://github.com/acme/widgets/pull/9", number: 9 }, 201);
    if (path === "/repos/acme/widgets") return ok({ default_branch: "main" });
    return ok({ message: `unexpected ${method} ${path}` }, 500);
  });
  return { gh: new GitHub(access), writes };
}

describe("code review's setup op", () => {
  it("makes one commit on a new branch off base and opens the PR to the default branch", async () => {
    const { gh, writes } = fake({ tip: null });
    const r = await setup(gh, body());
    expect(r).toMatchObject({ pr_url: "https://github.com/acme/widgets/pull/9", tip: NEW });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /repos/acme/widgets/git/trees", "POST /repos/acme/widgets/git/commits", "POST /repos/acme/widgets/git/refs", "POST /repos/acme/widgets/pulls"]);
    expect(writes[1]!.body.parents).toEqual([BASE]);
    expect(writes[1]!.body.message).toContain("Co-authored-by: AidenHQ");
    expect(writes[2]!.body).toEqual({ ref: "refs/heads/aidenhq/deepsec-setup", sha: NEW });
    expect(writes[3]!.body).toMatchObject({ head: "aidenhq/deepsec-setup", base: "main" });
  });

  it("refuses paths outside the allowlist, before any write", async () => {
    const { gh, writes } = fake({ tip: null });
    for (const files of [{ "src/index.ts": "x" }, { ".deepsec/INFO.md": "ok", ".github/workflows/ci.yml": "x" }, { ".deepsec/../src/a.ts": "x" }, {}]) {
      await expect(setup(gh, body({ files }))).rejects.toThrow(GitHubRefused);
    }
    await expect(setup(gh, body({ branch: "main" }))).rejects.toThrow(/aidenhq\//);
    expect(writes).toEqual([]);
  });

  it("refuses when the branch tip moved, or exists when none was expected", async () => {
    const moved = fake({ tip: "f".repeat(40) });
    await expect(setup(moved.gh, body({ expected_tip: TIP }))).rejects.toThrow(/not the cccccccccccc/);
    const exists = fake({ tip: TIP });
    await expect(setup(exists.gh, body())).rejects.toThrow(/new branch/);
    const gone = fake({ tip: null });
    await expect(setup(gone.gh, body({ expected_tip: TIP }))).rejects.toThrow(GitHubRefused);
    expect([moved.writes, exists.writes, gone.writes]).toEqual([[], [], []]);
  });

  it("moves an existing branch forward from its tip and reuses the open PR", async () => {
    const { gh, writes } = fake({ tip: TIP, open: [{ html_url: "https://github.com/acme/widgets/pull/4", number: 4 }] });
    const r = await setup(gh, body({ expected_tip: TIP }));
    expect(r).toMatchObject({ pr_url: "https://github.com/acme/widgets/pull/4", tip: NEW, objects: [] });
    expect(writes.find((w) => w.path.endsWith("/git/commits"))!.body.parents).toEqual([TIP]);
    expect(writes.find((w) => w.method === "PATCH")).toMatchObject({ path: "/repos/acme/widgets/git/refs/heads/aidenhq/deepsec-setup", body: { sha: NEW } });
    expect(writes.some((w) => w.path.endsWith("/pulls"))).toBe(false);
  });
});
