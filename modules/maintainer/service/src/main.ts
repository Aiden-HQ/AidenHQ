// The Maintainer's issue watcher (watcher.ts) as a service: its state in data/modules/maintainer/state.json, github-mcp's
// issue read with the token it shares with this service, and the routines' signed webhooks on the compose network.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { maintainerIssues, maintainerTriageWake, maintainerWake, startMaintainer, triageLimits } from "./watcher.ts";

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

startMaintainer({
  wiring: () => { const [fire, issues, triage] = [maintainerWake(), maintainerIssues(), maintainerTriageWake()]; return fire && issues ? { fire, issues, triage, limits: triageLimits() } : undefined; },
  store, log,
});
setInterval(() => {}, 2 ** 30); // the watcher's own timers don't hold the process open
