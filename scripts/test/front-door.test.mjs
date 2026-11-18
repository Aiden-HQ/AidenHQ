// scripts/front-door.mjs: the public front door's Caddyfile and service (exposure public; docs/design/access.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { caddyfile, caddyService } from "../front-door.mjs";
import { edgeConfig } from "../edge.mjs";

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

test("front door: the service is named exactly `caddy` in the dumped compose (ops/vm/setup.sh greps for it), host network, no caps but 443", () => {
  const svc = caddyService(caddyfile("203.0.113.7"));
  assert.match(YAML.stringify({ services: { caddy: svc } }), /^ {2}caddy:$/m);
  assert.equal(svc.network_mode, "host");
  assert.deepEqual([svc.cap_drop, svc.cap_add], [["ALL"], ["NET_BIND_SERVICE"]]);
  assert.equal(svc.read_only, true);
  assert.notEqual(caddyService(caddyfile("203.0.113.8")).labels["aidenhq.caddyfile-sha256"], svc.labels["aidenhq.caddyfile-sha256"]);
});

// App doors (docs/design/app-doors.md): without settings.edge, local and public installs still run the gate, which serves
// exposed apps to admins; public adds one on-demand Caddy site for <app>.<ip-with-dashes>.sslip.io, asked of the gate.
test("app doors: the gate per exposure, and Caddy's on-demand site for the sslip.io names only when there is a door", () => {
  const door = (exposure) => edgeConfig({ exposure }, [], [], { publicIp: "203.0.113.7", adminUrl: exposure === "public" ? "https://203.0.113.7:8446" : "" });
  const local = door("local");
  assert.deepEqual([local.gate.doors, local.gate.origin, local.gate.login, local.gate.hosts, local.gate.my_apps], [{ base: "localhost", file: "/previews/doors.json", signin: "http://localhost:3120" }, { scheme: "http", port: 3130 }, "password", {}, undefined]);
  assert.equal(local.cloudflared, null);
  assert.ok(local.compose.services.gate.volumes.some((v) => v.endsWith("/previews:/previews:ro")));
  assert.ok(!local.compose.services.gate.volumes.some((v) => v.includes("socket")));
  const pub = door("public");
  assert.deepEqual([pub.gate.doors.base, pub.gate.doors.signin, pub.gate.origin], ["203-0-113-7.sslip.io", "https://203.0.113.7:8446", undefined]);
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
