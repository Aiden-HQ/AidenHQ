import pino from "pino";
import { describe, expect, it } from "bun:test";
import { siteCloudId, siteHooks } from "../src/site.js";

const site = "https://acme.atlassian.net";
const sites = (url: string) => ({ content: [{ type: "text", text: JSON.stringify({ data: { resources: [{ cloudId: "fdd7", url, products: [{ id: "jira", access: "read-only" }] }] } }) }] });
const tool = (name: string, props: Record<string, object>) => ({ name, inputSchema: { type: "object" as const, properties: props, required: Object.keys(props) } });

describe("the site pin", () => {
  it("finds the cloudId under data.resources (Atlassian's shape, 2026-11), and only for the configured site", () => {
    expect(siteCloudId(sites(site), site)).toBe("fdd7");
    expect(siteCloudId(sites(site), "https://initech.atlassian.net")).toBeUndefined();
  });

  it("hides cloudId from the schemas and sets it on calls whose tool takes it, never on the others", async () => {
    const h = siteHooks(site, pino({ level: "silent" }));
    const issue = tool("getJiraIssue", { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } });
    const me = tool("atlassianUserInfo", {});
    (await h.connected!({ callTool: async () => sites(site) } as never, []))?.();
    expect(h.tools!([issue, me])[0]!.inputSchema).toEqual({ type: "object", properties: { issueIdOrKey: { type: "string" } }, required: ["issueIdOrKey"] });
    expect(h.args!("getJiraIssue", { issueIdOrKey: "A-1", cloudId: "other" }, issue)).toEqual({ issueIdOrKey: "A-1", cloudId: "fdd7" });
    expect(h.args!("atlassianUserInfo", {}, me)).toEqual({});
    // A caller's cloudId never reaches a tool whose schema doesn't name it (another site the account can reach).
    expect(h.args!("atlassianUserInfo", { cloudId: "other" }, me)).toEqual({});
    expect(h.health!()).toBeUndefined();
  });

  it("refuses site calls when the account can't reach the configured site, and says so in the health", async () => {
    const h = siteHooks(site, pino({ level: "silent" }));
    (await h.connected!({ callTool: async () => sites("https://initech.atlassian.net") } as never, []))?.();
    expect(() => h.args!("getJiraIssue", {}, tool("getJiraIssue", { cloudId: {} }))).toThrow(/can't reach https:\/\/acme/);
    expect(h.health!()).toMatch(/can't reach/);
  });
});
