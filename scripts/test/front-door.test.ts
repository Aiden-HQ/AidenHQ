// scripts/front-door.ts: the public front door's Caddyfile and service (exposure public; docs/design/access.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { caddyfile, caddyService } from "../front-door.ts";
import { edgeConfig } from "../edge.ts";

const site = (file, addr) => file.slice(file.indexOf(`${addr} {`)).split("\n}\n")[0];

test("front door: the board on 443, the admin listener on 8446 with the edge secret, an IP certificate on 443 only", () => {
  const file = caddyfile("203.0.113.7");
  const board = site(file, "https://203.0.113.7"), admin = site(file, "https://203.0.113.7:8446");
  assert.match(board, /reverse_proxy 127\.0\.0\.1:3121 /);
  assert.match(admin, /reverse_proxy 127\.0\.0\.1:3120 /);
  // Only the admin listener believes Caddy's client address, and only beside the secret (read from the compose secret file).
  assert.match(admin, /header_up X-AidenHQ-Client-IP \{remote_host\}\n\t\theader_up X-AidenHQ-Edge \{file\.\/run\/secrets\/edge_board_secret\}/);
  assert.doesNotMatch(admin, /header_up -X-AidenHQ/); // a delete of a name it sets would run after the set and remove it
  assert.doesNotMatch(board, /edge_board_secret/);
  assert.match(board, /header_up -X-AidenHQ-Edge/);
  assert.match(file, /profile shortlived\n\t\t\tdisable_http_challenge/);
  assert.match(file, /admin off/);
  assert.match(file, /auto_https disable_redirects/);
  assert.doesNotMatch(file, /\bdir /); // Let's Encrypt production unless a directory is named
  assert.match(caddyfile("203.0.113.7", "https://acme-staging-v02.api.letsencrypt.org/directory"), /dir https:\/\/acme-staging-v02/);
  for (const bad of ["10.0.0.5", "192.168.1.2", "100.64.0.1", "127.0.0.1", "example.com", "203.0.113.7 {"]) assert.throws(() => caddyfile(bad));
});

// App doors (docs/design/app-doors.md): without settings.edge, local and public installs still run the gate, which serves
// exposed apps to admins; public adds one on-demand Caddy site for <app>.<ip-with-dashes>.sslip.io, asked of the gate.
test("app doors: the gate per exposure, and Caddy's on-demand site for the sslip.io names only when there is a door", () => {
  const door = (exposure) => edgeConfig({ exposure }, [], [], { publicIp: "203.0.113.7", adminUrl: exposure === "public" ? "https://203.0.113.7:8446" : "" });
  const local = door("local");
  assert.deepEqual([local.gate.doors, local.gate.signin, local.gate.origin, local.gate.login, local.gate.hosts, local.gate.my_apps], [{ base: "localhost", file: "/previews/doors.json" }, "http://localhost:3120", { scheme: "http", port: 3130 }, "password", {}, undefined]);
  assert.equal(local.cloudflared, null);
  assert.ok(local.compose.services.gate.volumes.some((v) => v.endsWith("/previews:/previews:ro")));
  assert.ok(!local.compose.services.gate.volumes.some((v) => v.includes("socket")));
  const pub = door("public");
  assert.deepEqual([pub.gate.doors.base, pub.gate.signin, pub.gate.origin], ["203-0-113-7.sslip.io", "https://203.0.113.7:8446", undefined]);
  for (const e of ["tailscale", "cloudflare"]) assert.equal(door(e), null);
  // a LAN VM's board (local, on a LAN address): <app>.localhost would be the viewer's own machine, so no door
  assert.equal(edgeConfig({ exposure: "local" }, [], [], { boardUrl: "http://192.168.1.20:3121" }), null);
  assert.ok(edgeConfig({ exposure: "local" }, [], [], { boardUrl: "http://127.0.0.1:3121" }));
  // settings.edge keeps its own door: no doors block
  assert.equal(edgeConfig({ exposure: "local", edge: { team_domain: "acme.cloudflareaccess.com", tunnel_id: "00000000-0000-0000-0000-000000000000", my_apps: { host: "apps.example.com", aud: "a" } }, owner_email: "o@example.com" }, [], []).gate.doors, undefined);

  const file = caddyfile("203.0.113.7", undefined, pub.gate.doors.base);
  const apps = site(file, "https://*.203-0-113-7.sslip.io");
  assert.match(file, /on_demand_tls \{\n\t\task http:\/\/127\.0\.0\.1:3130\/\.aidenhq\/door-ask\n\t\}/);
  assert.match(apps, /tls \{\n\t\ton_demand\n\t\tissuer acme \{\n\t\t\tdisable_http_challenge/);
  assert.match(apps, /reverse_proxy 127\.0\.0\.1:3130 /);
  assert.match(apps, /header_up -X-AidenHQ-Client-IP\n\t\theader_up -X-AidenHQ-Edge/); // a door names no visitor: no sign-in passes it
  assert.doesNotMatch(apps, /shortlived|edge_board_secret/);
  assert.doesNotMatch(caddyfile("203.0.113.7"), /on_demand|sslip/);
});

// The module door (docs/design/app-doors.md): a module service shared with no host opens at the board's own host on 8447 in
// every exposure mode without edge, through that mode's front door to the gate; its address reaches the service.
test("the module door: the board's host on 8447 in local, public and tailscale; Caddy passes 8447 to the gate", () => {
  const svc = { name: "docs", service: "docs-server", port: 3141, share: { host: "" } };
  const at = (exposure, door) => edgeConfig({ exposure }, [svc], [], door);
  const ts = at("tailscale", { boardUrl: "https://aidenhq.example.ts.net", adminUrl: "https://aidenhq.example.ts.net:8446" });
  assert.deepEqual([ts.gate.hosts, ts.gate.signin, ts.gate.doors, ts.gate.origin, ts.urls], [{ "aidenhq.example.ts.net": { app: "docs", port: 3141, door: true, origin: "https://aidenhq.example.ts.net:8447" } }, "https://aidenhq.example.ts.net:8446", undefined, undefined, { "docs-server": "https://aidenhq.example.ts.net:8447" }]);
  assert.deepEqual(at("public", { publicIp: "203.0.113.7", boardUrl: "https://203.0.113.7", adminUrl: "https://203.0.113.7:8446" }).urls, { "docs-server": "https://203.0.113.7:8447" });
  const local = at("local", {});
  assert.deepEqual([local.gate.hosts.localhost, local.urls], [{ app: "docs", port: 3141, door: true, origin: "http://localhost:3130" }, { "docs-server": "http://localhost:3130" }]); // the tunnel's gate port
  assert.equal(at(undefined, { boardUrl: "https://aidenhq.example.ts.net", adminUrl: "https://aidenhq.example.ts.net:8446" }).urls["docs-server"], "https://aidenhq.example.ts.net:8447"); // unset exposure is tailscale
  assert.equal(at("tailscale", {}), null); // no tailnet board yet: no door
  assert.equal(edgeConfig({ exposure: "tailscale" }, [], [], { boardUrl: "https://aidenhq.example.ts.net", adminUrl: "https://aidenhq.example.ts.net:8446" }), null); // nothing to serve
  assert.throws(() => edgeConfig({ exposure: "local" }, [svc, { ...svc, name: "wiki", service: "wiki-server" }], []), /the module door serves one/);
  // with a share.host the service is shared under edge, at that host
  const edge = { team_domain: "acme.cloudflareaccess.com", tunnel_id: "00000000-0000-0000-0000-000000000000", my_apps: { host: "apps.example.com", aud: "a" } };
  assert.deepEqual(edgeConfig({ edge, owner_email: "o@example.com" }, [{ ...svc, share: { host: "docs.example.com", aud: "d" } }], []).urls, { "docs-server": "https://docs.example.com" });
  assert.match(site(caddyfile("203.0.113.7"), "https://203.0.113.7:8447"), /reverse_proxy 127\.0\.0\.1:3130 [\s\S]*header_up -X-AidenHQ-Edge/);
});
