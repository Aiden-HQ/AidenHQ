// The Maintainer's issue watcher (watcher.ts) as a service: its state in data/modules/maintainer/state.json, the kernel's log of
// the github change feed's issue events and github-mcp's trust reads, both with this module's own token.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { factEmitter, kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import { maintainerFeed, maintainerReads, maintainerTriageWake, maintainerWake, startMaintainer } from "./watcher.ts";

const stateFile = process.env.MAINTAINER_STATE_FILE ?? "/data/state.json";
const state = (() => {
  try { return JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, string>; } catch { return {} as Record<string, string>; }
})();
const store = {
  meta: (key: string) => state[key],
  setMeta(key: string, value: string) {
    state[key] = value;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
  },
};
const log = { info: (o: object, m: string) => console.log(new Date().toISOString(), m, JSON.stringify(o)), warn: (o: object, m: string) => console.warn(new Date().toISOString(), m, JSON.stringify(o)) };

// Flow's issue.triaged facts (role kernel.facts), with this module's token; off until the token file has its content.
let facts: ReturnType<typeof factEmitter> | undefined;
const emitter = () => {
  if (facts) return facts;
  let token = "";
  try { token = readFileSync(process.env.MAINTAINER_TOKEN_FILE ?? "", "utf8").trim(); } catch {}
  if (token) facts = factEmitter(kernelClient(process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", token), (m, f) => log.warn(f ?? {}, m));
  return facts;
};

startMaintainer({
  wiring: () => { const [fire, reads, feed, triage] = [maintainerWake(), maintainerReads(), maintainerFeed(), maintainerTriageWake()]; return fire && reads && feed && triage ? { fire, ...reads, feed, triage, repos: () => parseRepos(process.env.MAINTAINER_REPOS ?? ""), emit: (f) => emitter()?.emit(f) } : undefined; },
  store, log,
});

// The Fleet page's connection `maintainer` (config-tool.ts): the owner's own calls from the board, on the service key.
const readKey = () => { try { return readFileSync(process.env.MAINTAINER_SERVICE_KEY_FILE ?? "", "utf8").trim(); } catch { return ""; } };
const jwks = kernelJwks(`${process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130"}/v1/jwks`);
const mcp = serveMcp(
  createMcp("maintainer", configTools({ repos: () => process.env.MAINTAINER_REPOS ?? "", shipRepos: () => process.env.MAINTAINER_SHIP_REPOS ?? "" }), [{ uri: "ui://maintainer/page", html: pageHtml(new URL("./", import.meta.url)) }]),
  readKey, (req) => verifyCaller(req, jwks, "maintainer"),
);
createServer(async (req, res) => {
  if (await mcp(req, res)) return;
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8102, "0.0.0.0");
