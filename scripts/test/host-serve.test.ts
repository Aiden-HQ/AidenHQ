import assert from "node:assert/strict";
import { test } from "node:test";
import { strays } from "../host-serve.ts";

const web = (port, proxy) => ({ [`agents.example.ts.net:${port}`]: { Handlers: { "/": { Proxy: proxy } } } });

test("the host's serve keeps Paperclip and the board; an app port there is a stray to turn off", () => {
  const live = {
    TCP: { 443: { HTTPS: true }, 8080: { HTTPS: true }, 8443: { HTTPS: true }, 2222: { TCPForward: "127.0.0.1:22" } },
    Web: { ...web(443, "http://127.0.0.1:3100"), ...web(8080, "http://127.0.0.1:8080"), ...web(8443, "http://127.0.0.1:3120") },
  };
  assert.deepEqual(strays(live).ports.map((p) => [p.port, p.tcp]), [["2222", true], ["8080", false]]);
  delete live.TCP[8080], delete live.TCP[2222], delete live.Web["agents.example.ts.net:8080"];
  assert.deepEqual(strays(live), { ports: [], funnel: [] });
  // The monitoring module's Grafana (loopback 3131) is one of the host's own services.
  live.TCP[8444] = { HTTPS: true };
  Object.assign(live.Web, web(8444, "http://127.0.0.1:3131"));
  assert.deepEqual(strays(live), { ports: [], funnel: [] });
});
