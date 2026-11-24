// Shared access at compile: the gate's config and cloudflared's ingress from `edge` + the instance apps' share, and the
// apply-time refusal of any ingress that doesn't target the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { checkIngress, AUTH_PORT, GATE_PORT, GATE_SOCKET_URL, GATE_URL, TEST_LISTENER_ADDRESS, TEST_LISTENER_PORT } from "../edge.ts";

const mods = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");
const TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const edge = { team_domain: "acme.cloudflareaccess.com", tunnel_id: TUNNEL, my_apps: { host: "apps.acme.com", aud: "aud-apps-0001" } };
const roadmap = { name: "roadmap", repo: "acme/roadmap", owner: "a", description: "d", port: 4100, share: { host: "roadmap.acme.com", aud: "aud-roadmap-0001", default_role: "member" } };

function inst(settings, apps) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "Owner@Acme.com", ...settings } }));
  writeFileSync(join(dir, "apps.yaml"), YAML.stringify({ apps }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("edge on: every share.host goes to the gate with its own aud, then a 404; the gate and cloudflared run", () => {
  const out = compile(mods, inst({ edge }, [roadmap, { name: "notes", repo: "acme/notes", owner: "a", description: "d", port: 4200 }]));
  assert.deepEqual(out.edge.gate.hosts, { "roadmap.acme.com": { app: "roadmap", port: 4100, aud: "aud-roadmap-0001", default_role: "member" } });
  assert.equal(out.edge.gate.identity_key_file, "/secrets/identity_key");
  assert.equal(out.edge.gate.issuer, "https://acme.cloudflareaccess.com");
  assert.equal(out.edge.gate.owner_email, "owner@acme.com");
  assert.deepEqual(out.edge.cloudflared.ingress, [
    { hostname: "roadmap.acme.com", service: GATE_SOCKET_URL, originRequest: { access: { required: true, teamName: "acme", audTag: ["aud-roadmap-0001"] } } },
    { hostname: "apps.acme.com", service: GATE_SOCKET_URL, originRequest: { access: { required: true, teamName: "acme", audTag: ["aud-apps-0001"] } } },
    { service: "http_status:404" },
  ]);
  assert.equal(out.edge.cloudflared.tunnel, TUNNEL);
  checkIngress(out.edge.cloudflared);
  assert.equal(out.compose.services.gate.network_mode, "host");
  assert.ok(out.compose.services.gate.volumes.includes("${AIDENHQ_SECRETS_DIR}/identity/gate.pem:/secrets/identity_key:ro"));
  assert.ok(!out.compose.services.gate.volumes.some((v) => v.includes("/apps/") || v.includes("apps.pem"))); // no app secrets, no agent key
  assert.deepEqual(out.compose.services.cloudflared.secrets, ["cloudflared_credentials"]);
  // cloudflared reads its config once: a changed ingress must change the service so compose recreates it
  const hash = (o) => o.compose.services.cloudflared.labels["aidenhq.ingress-sha256"];
  const wider = compile(mods, inst({ edge }, [{ ...roadmap, share: { ...roadmap.share, host: "plan.acme.com" } }]));
  assert.notEqual(hash(out), hash(wider));
  assert.equal(hash(out), hash(compile(mods, inst({ edge }, [roadmap]))));
});

test("apply refuses ingress whose target isn't the gate", () => {
  const ok = { tunnel: TUNNEL, "credentials-file": "/run/secrets/cloudflared_credentials", ingress: [{ hostname: "roadmap.acme.com", service: GATE_SOCKET_URL, originRequest: { access: { required: true } } }, { service: "http_status:404" }] };
  checkIngress(ok);
  const board = structuredClone(ok);
  board.ingress[0].service = "http://127.0.0.1:3120";
  assert.throws(() => checkIngress(board), /only unix:\/run\/gate\/gate\.sock, the gate/);
  // The gate's loopback port isn't cloudflared's way in: there CF-Connecting-IP could come from anyone on the host.
  board.ingress[0].service = GATE_URL;
  assert.throws(() => checkIngress(board), /the gate/);
  assert.throws(() => checkIngress({ ...ok, ingress: ok.ingress.slice(0, 1) }), /404 catch-all/);
  assert.throws(() => checkIngress({ ...ok, ingress: [{ service: "http://127.0.0.1:3100" }] }), /404 catch-all/);
  assert.throws(() => checkIngress({ ...ok, "warp-routing": { enabled: true } }), /unexpected key warp-routing/);
});

test("the test user compiles into the gate's test block, with its own listener; absent writes neither", () => {
  const off = compile(mods, inst({ edge }, [roadmap]));
  assert.equal(off.edge.gate.test_user, undefined);
  assert.equal(off.edge.gate.test_listener, undefined);

  const on = compile(mods, inst({ edge: { ...edge, test_user: { email: "Canary@AidenHQ.Test", apps: ["roadmap"] } } }, [roadmap]));
  assert.deepEqual(on.edge.gate.test_user, { email: "canary@aidenhq.test", apps: ["roadmap"] });
  assert.deepEqual(on.edge.gate.test_listener, { address: TEST_LISTENER_ADDRESS, port: TEST_LISTENER_PORT });
  // The listener's own port is reserved, and never one of the gate's or the sign-in listener's.
  assert.notEqual(TEST_LISTENER_PORT, GATE_PORT);
  assert.notEqual(TEST_LISTENER_PORT, AUTH_PORT);
});

test("a test user that isn't a real, separate, once-named shared app is refused", () => {
  const bad = (test_user) => assert.throws(() => compile(mods, inst({ edge: { ...edge, test_user } }, [roadmap, { name: "notes", repo: "acme/notes", owner: "a", description: "d", port: 4200 }])));
  bad({ email: "owner@acme.com", apps: ["roadmap"] }); // the owner's own address
  bad({ email: "canary@aidenhq.test", apps: [] }); // no app
  bad({ email: "canary@aidenhq.test", apps: ["notes"] }); // not shared: no share.host
  bad({ email: "canary@aidenhq.test", apps: ["ghost"] }); // no such app
  bad({ email: "canary@aidenhq.test", apps: ["roadmap", "roadmap"] }); // named twice
  bad({ email: "not an email", apps: ["roadmap"] });
  bad({ email: "canary@aidenhq.test", apps: ["roadmap"], extra: true });
});
