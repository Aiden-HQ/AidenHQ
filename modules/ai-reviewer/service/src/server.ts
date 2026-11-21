// The AI reviewer module's service (reviewer@1, aidenhq-sdk/reviewer.ts): the kernel sends each review here with this
// module's key; the verdict goes back to the kernel with the review's own token. Model calls go through the gateway with
// the reviewer token the kernel minted for that review; the model's only tools read the request's own change (review.ts changeTools).
import http from "node:http";
import { readFileSync } from "node:fs";
import { serveReviewer } from "./aidenhq-sdk/reviewer.ts";
import type { Review } from "./aidenhq-sdk/reviewer.ts";
import { openRouterAsk, review } from "./review.ts";

const gateway = process.env.AIDENHQ_GATEWAY_URL ?? "http://10.231.0.1:8201";
const log = (msg: string, f = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(f));

/** One request through the reviewer, with the review's model token: the reviewer's own defaults for anything not sent. */
export const reviewWith = (url: string): Review => (request, { modelToken, onPanel }) => review({ ...request, ask: openRouterAsk(modelToken, { url, retryDelaysMs: [] }) /* the gateway retries transient failures */, onPanel });

if (import.meta.main) {
  const handle = serveReviewer(reviewWith(`${gateway}/api/v1/chat/completions`), { key: readFileSync(process.env.REVIEWER_KEY_FILE!, "utf8").trim(), log });
  // The instance (a fresh one each start) is in /healthz: the kernel fails the reviews a recreated service lost.
  const instance = handle.instance;
  http.createServer(async (req, res) => {
    if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, instance }));
    if (!(await handle(req, res))) res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no such route"}');
  }).listen(Number(process.env.PORT ?? 8095), () => log("listening", { port: Number(process.env.PORT ?? 8095) }));
}
