// scripts/front-door.ts: the public front door's Caddyfile and service (exposure public; docs/design/access.md).
import assert from "node:assert/strict";
import { test } from "node:test";

import { caddyfile } from "../front-door.ts";

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
