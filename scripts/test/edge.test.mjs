// Shared access at compile: the gate's config and cloudflared's ingress from `edge` + the instance apps' share, and the
// apply-time refusal of any ingress that doesn't target the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { checkIngress, checkPorts, GATE_URL } from "../edge.mjs";

const mods = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");
const TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const edge = { team_domain: "acme.cloudflareaccess.com", tunnel_id: TUNNEL, my_apps: { host: "apps.acme.com", aud: "aud-apps-0001" } };
const roadmap = { name: "roadmap", repo: "acme/roadmap", owner: "a", description: "d", port: 4100, share: { host: "roadmap.acme.com", aud: "aud-roadmap-0001", default_role: "member" } };

function inst(settings, apps) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [], settings: { timezone: "Europe/London", owner_email: "Owner@Acme.com", ...settings } }));
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
    { hostname: "roadmap.acme.com", service: GATE_URL, originRequest: { access: { required: true, teamName: "acme", audTag: ["aud-roadmap-0001"] } } },
    { hostname: "apps.acme.com", service: GATE_URL, originRequest: { access: { required: true, teamName: "acme", audTag: ["aud-apps-0001"] } } },
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

test("edge off: nothing generated; share.host without edge, or an app joining a shared app's network, fails compile", () => {
  const out = compile(mods, inst({}, []));
  assert.equal(out.edge, null);
  assert.equal(out.compose.services.gate, undefined);
  assert.throws(() => compile(mods, inst({}, [roadmap])), /roadmap has share.host, but settings.edge isn't set/);
  const spy = { name: "spy", repo: "acme/spy", owner: "a", description: "d", connects: ["roadmap"] };
  assert.throws(() => compile(mods, inst({ edge }, [roadmap, spy])), /spy connects to roadmap, a shared app/);
});

test("apply refuses ingress whose target isn't the gate", () => {
  const ok = { tunnel: TUNNEL, "credentials-file": "/run/secrets/cloudflared_credentials", ingress: [{ hostname: "roadmap.acme.com", service: GATE_URL, originRequest: { access: { required: true } } }, { service: "http_status:404" }] };
  checkIngress(ok);
  const board = structuredClone(ok);
  board.ingress[0].service = "http://127.0.0.1:3120";
  assert.throws(() => checkIngress(board), /only http:\/\/127\.0\.0\.1:3130, the gate/);
  assert.throws(() => checkIngress({ ...ok, ingress: ok.ingress.slice(0, 1) }), /404 catch-all/);
  assert.throws(() => checkIngress({ ...ok, ingress: [{ service: "http://127.0.0.1:3100" }] }), /404 catch-all/);
  assert.throws(() => checkIngress({ ...ok, "warp-routing": { enabled: true } }), /unexpected key warp-routing/);
});

test("app_login: access needs an aud everywhere; password signs in through the board and keeps Access only where an aud is set", () => {
  const myApps = { host: "apps.acme.com", aud: "aud-apps-0001" };
  const acc = compile(mods, inst({ edge: { ...edge, my_apps: myApps } }, [roadmap]));
  assert.equal(acc.edge.gate.login, "access");
  // The auth listener in both modes: app access is managed through it too.
  assert.equal(acc.edge.gate.auth_url, "http://127.0.0.1:3129");
  assert.deepEqual(acc.edge.gate.my_apps, myApps);
  assert.equal(acc.edge.cloudflared.ingress[1].hostname, "apps.acme.com");
  checkIngress(acc.edge.cloudflared);
  // the gate sees the board's account map and nothing else of data/
  const vols = acc.compose.services.gate.volumes;
  assert.ok(vols.includes("${AIDENHQ_DATA_DIR:-./data}/gate/accounts.json:/accounts/accounts.json:ro"));
  assert.ok(!vols.some((v) => v.includes("/board")));
  assert.throws(() => compile(mods, inst({ edge: { ...edge, my_apps: { host: "apps.acme.com" } } }, [roadmap])), /my_apps needs aud/);
  assert.throws(() => compile(mods, inst({ edge, app_login: "magic" }, [roadmap])), /app_login must be access or password/);
  assert.throws(() => compile(mods, inst({ edge: { tunnel_id: TUNNEL, my_apps: { host: "apps.acme.com", aud: "aud-apps-0001" } } }, [])), /team_domain/);

  const open = { ...roadmap, share: { ...roadmap.share, aud: undefined } };
  const pw = compile(mods, inst({ edge: { tunnel_id: TUNNEL, my_apps: { host: "apps.acme.com" } }, app_login: "password" }, [open]));
  assert.equal(pw.edge.gate.login, "password");
  assert.equal(pw.edge.gate.auth_url, "http://127.0.0.1:3129");
  assert.equal(pw.edge.gate.cookie_domain, undefined); // host-only cookies through the handoff, never a parent-domain one
  assert.equal(pw.edge.gate.issuer, undefined);
  // The gate's proof to the auth listener (both modes), and the board's view of the gate's files (edge only).
  assert.equal(pw.edge.gate.auth_secret_file, "/secrets/auth_listener");
  assert.ok(pw.compose.services.gate.volumes.includes("${AIDENHQ_SECRETS_DIR}/gate_board_secret:/secrets/auth_listener:ro"));
  assert.deepEqual(pw.compose.services.board.volumes, ["./config/gate.json:/config/gate.json:ro", "${AIDENHQ_DATA_DIR:-./data}/gate:/data/gate"]);
  assert.ok(compile(mods, inst({ edge }, [roadmap])).compose.services.gate.volumes.some((v) => v.includes("gate_board_secret")));
  assert.deepEqual(pw.edge.cloudflared.ingress.slice(0, 2), [{ hostname: "roadmap.acme.com", service: GATE_URL }, { hostname: "apps.acme.com", service: GATE_URL }]);
  checkIngress(pw.edge.cloudflared, { login: "password" });
  assert.throws(() => checkIngress(pw.edge.cloudflared), /Access must be required/); // access mode stays strict
  // password with an aud keeps Access on that host, and then needs the team
  const both = compile(mods, inst({ edge: { ...edge, my_apps: { host: "apps.acme.com" } }, app_login: "password" }, [roadmap]));
  assert.equal(both.edge.cloudflared.ingress[0].originRequest.access.required, true);
  assert.throws(() => compile(mods, inst({ edge: { tunnel_id: TUNNEL, my_apps: { host: "apps.acme.com" } }, app_login: "password" }, [roadmap])), /team_domain/);
  // one sign-in host; app hosts anywhere (each gets its own cookie)
  assert.throws(() => compile(mods, inst({ edge: { tunnel_id: TUNNEL }, app_login: "password" }, [open])), /my_apps.host is required/);
  compile(mods, inst({ edge: { tunnel_id: TUNNEL, my_apps: { host: "my.other.org" } }, app_login: "password" }, [open]));
});

test("two services can't claim one host port", () => {
  assert.throws(() => compile(mods, inst({ edge }, [{ ...roadmap, port: 3129 }])), /3129 is the board's auth listener/);
  const app = (name) => ({ name, repo: `acme/${name}`, owner: "a", description: "d", port: 4300 });
  assert.throws(() => compile(mods, inst({}, [app("a"), app("b")])), /port 4300 is claimed by both app a and app b/);
  assert.throws(() => checkPorts([{ services: { primer: { ports: ["127.0.0.1:3129:8084"] } } }], [[3129, "board"]]), /3129 is claimed by both board and primer/);
  checkPorts([{ services: { board: { ports: ["127.0.0.1:3129:3129", "${BOARD_LAN_BIND:-127.0.0.1}:${BOARD_LAN_PORT:-3121}:3121"] } } }], [[3129, "board"]]);
});

test("identity keys: both signers' keys made once, keys.json lists every gate*/apps* key, rewritten in place", async () => {
  const { ensureIdentityKeys } = await import("../identity.mjs");
  const { readFileSync, renameSync, statSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "identity-"));
  assert.deepEqual(ensureIdentityKeys(dir), ["identity/gate.pem", "identity/apps.pem"]);
  assert.deepEqual(ensureIdentityKeys(dir), []);
  const file = join(dir, "identity", "keys.json");
  const keys = () => JSON.parse(readFileSync(file, "utf8")).keys;
  assert.deepEqual(keys().map((k) => k.iss).sort(), ["aidenhq-apps", "aidenhq-gate"]);
  assert.equal(statSync(join(dir, "identity", "gate.pem")).mode & 0o777, 0o600);
  const inode = statSync(file).ino;
  renameSync(join(dir, "identity", "gate.pem"), join(dir, "identity", "gate.old.pem")); // ordinary rotation: both trusted
  assert.deepEqual(ensureIdentityKeys(dir), ["identity/gate.pem"]);
  assert.deepEqual(keys().map((k) => k.iss).sort(), ["aidenhq-apps", "aidenhq-gate", "aidenhq-gate"]);
  assert.equal(statSync(file).ino, inode); // apps bind this one file: the same inode
  rmSync(join(dir, "identity", "gate.old.pem"));
  ensureIdentityKeys(dir);
  assert.equal(keys().length, 2);
});
