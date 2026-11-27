// Runs under Node (spend.test.ts spawns it): a gateway whose upstream refuses the connection answers 502 and charges $0.
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../../src/gateway/lib.ts";
import { mintToken } from "../../src/gateway/token.ts";
import { modelsList } from "../models-list.ts";

const serve = (handler: http.RequestListener) => new Promise<{ s: http.Server; url: string }>((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` })); });
const closed = await serve(() => {});
await new Promise((r) => closed.s.close(r));
const list = await modelsList({ flat: { in: 0, cached_in: 0, out: 1, max_output: 10_000 } });
const dir = mkdtempSync(join(tmpdir(), "spend-refused-"));
writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: { ag: { key: "eng" } } }));
writeFileSync(join(dir, "gateway.json"), "{}");
const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: closed.url, modelsUrl: list.url, jobLive: () => true, retryDelaysMs: [0, 0] });
const front = await serve((req, res) => gw.handle(req, res));
const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("js", { kind: "job", job: "j-WOR-1", agentId: "ag", issueId: "WOR-1" }, Date.now())}` }, body: JSON.stringify({ model: "flat", messages: [] }) });
const rows = (gw.db.prepare("SELECT status, cost_usd FROM calls").all() as { status: string; cost_usd: number }[]).map((x) => [x.status, x.cost_usd]);
console.log(JSON.stringify({ status: res.status, rows }));
front.s.close(); gw.close(); list.close();
process.exit(0);
