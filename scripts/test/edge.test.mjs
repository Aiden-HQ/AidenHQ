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
import { checkIngress, checkPorts, GATE_SOCKET_URL, GATE_URL } from "../edge.mjs";

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

test("header-jwt: a front door needs no tunnel or team; identity and front compile into the gate, every host needs an aud", () => {
  const e = { identity: { header: "x-front-identity", issuer: "https://auth.example.com", jwks_url: "https://auth.example.com/jwks.json", auth_method: "sso" }, front: { address: "100.101.102.103", port: 8445 }, my_apps: { host: "apps.acme.com", aud: "service:apps" } };
  const app = { ...roadmap, share: { host: "roadmap.acme.com", aud: "service:roadmap", default_role: "member" } };
  const out = compile(mods, inst({ app_login: "header-jwt", edge: e }, [app]));
  assert.equal(out.edge.gate.login, "header-jwt");
  assert.deepEqual(out.edge.gate.identity, e.identity);
  assert.deepEqual(out.edge.gate.front, e.front);
  assert.equal(out.edge.gate.hosts["roadmap.acme.com"].aud, "service:roadmap");
  assert.equal(out.edge.cloudflared, null);
  assert.equal(out.compose.services.cloudflared, undefined);
  assert.throws(() => compile(mods, inst({ app_login: "header-jwt", edge: e }, [{ ...app, share: { host: "roadmap.acme.com" } }])), /needs share.aud/);
  assert.throws(() => compile(mods, inst({ app_login: "header-jwt", edge: { ...e, front: { address: "203.0.113.5", port: 8445 } } }, [app])), /tailnet IPv4/);
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
  assert.deepEqual(pw.edge.cloudflared.ingress.slice(0, 2), [{ hostname: "roadmap.acme.com", service: GATE_SOCKET_URL }, { hostname: "apps.acme.com", service: GATE_SOCKET_URL }]);
  checkIngress(pw.edge.cloudflared, { login: "password" });
  // cloudflared reaches the gate only over the socket they alone share (the gate believes CF-Connecting-IP only there).
  assert.equal(pw.edge.gate.socket, "/run/gate/gate.sock");
  for (const svc of ["gate", "cloudflared"]) assert.ok(pw.compose.services[svc].volumes.includes("${AIDENHQ_DATA_DIR:-./data}/gate/socket:/run/gate"));
  assert.throws(() => checkIngress(pw.edge.cloudflared), /Access must be required/); // access mode stays strict
  // password with an aud keeps Access on that host, and then needs the team
  const both = compile(mods, inst({ edge: { ...edge, my_apps: { host: "apps.acme.com" } }, app_login: "password" }, [roadmap]));
  assert.equal(both.edge.cloudflared.ingress[0].originRequest.access.required, true);
  assert.throws(() => compile(mods, inst({ edge: { tunnel_id: TUNNEL, my_apps: { host: "apps.acme.com" } }, app_login: "password" }, [roadmap])), /team_domain/);
  // one sign-in host; app hosts anywhere (each gets its own cookie)
  assert.throws(() => compile(mods, inst({ edge: { tunnel_id: TUNNEL }, app_login: "password" }, [open])), /my_apps.host is required/);
  compile(mods, inst({ edge: { tunnel_id: TUNNEL, my_apps: { host: "my.other.org" } }, app_login: "password" }, [open]));
});

test("previews: *.<host> per shared app after the exact hosts, behind that app's own aud; the gate gets the band and the file", () => {
  const out = compile(mods, inst({ edge: { ...edge, previews: true } }, [roadmap]));
  assert.deepEqual(out.edge.gate.previews, { file: "/previews/previews.json", ports: [39100, 39399] });
  assert.deepEqual(out.edge.cloudflared.ingress.slice(-2), [
    { hostname: "*.roadmap.acme.com", service: GATE_SOCKET_URL, originRequest: { access: { required: true, teamName: "acme", audTag: ["aud-roadmap-0001"] } } },
    { service: "http_status:404" },
  ]);
  checkIngress(out.edge.cloudflared);
  assert.ok(out.compose.services.gate.volumes.includes("${AIDENHQ_DATA_DIR:-./data}/previews:/previews:ro"));
  assert.throws(() => compile(mods, inst({ edge: { ...edge, previews: { aud: "aud-shared-001" } } }, [roadmap])), /own Access audience/);
  assert.throws(() => compile(mods, inst({ edge }, [{ ...roadmap, share: { ...roadmap.share, host: "pr-2.roadmap.acme.com" } }])), /previews'/);
  const rule = (hostname) => ({ ingress: [{ hostname, service: GATE_SOCKET_URL, originRequest: { access: { required: true, audTag: ["a"] } } }, { service: "http_status:404" }] });
  assert.throws(() => checkIngress(rule("*.com")), /hostname/);
  assert.throws(() => checkIngress(rule("*")), /hostname/);
  assert.throws(() => checkIngress(rule("a.*.acme.com")), /hostname/);
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

test("in-app feedback: only feedback_to gets a tier0 routine, and its agent can't read private sources or send", () => {
  const withAgent = (connections) => {
    const dir = inst({ edge }, [{ ...roadmap, owner: "boss", feedback_to: "feedback" }, { ...roadmap, name: "notes", port: 4200, share: { ...roadmap.share, host: "notes.acme.com", aud: "aud-notes-0001" } }]);
    mkdirSync(join(dir, "agents", "feedback"));
    writeFileSync(join(dir, "agents", "feedback", "agent.yaml"), YAML.stringify({ name: "Feedback", description: "Reads one app's feedback.", model: "m", budget: 1, connections }));
    writeFileSync(join(dir, "agents", "feedback", "AGENTS.md"), "# Feedback\n");
    return dir;
  };
  const out = compile(mods, withAgent({}));
  const feedback = Object.values(out.paperclip.routines).filter((r) => r.title.startsWith("App feedback:"));
  assert.deepEqual(feedback.map(({ title, agent, concurrency, autonomy }) => ({ title, agent, concurrency, autonomy })), [{ title: "App feedback: roadmap", agent: "feedback", concurrency: "coalesce_if_active", autonomy: "tier0" }]);
  assert.match(feedback[0].description, /\{\{count\}\}.*as data/s);
  const granted = out.paperclip.agents.feedback.enabled_tools;
  assert.ok(Object.keys(granted).every((c) => ["apps", "paperclip_tasks"].includes(c)), JSON.stringify(granted));
  // Any other connection (a private read such as Slack or Drive, an outbound send) or a write beyond its task tools fails.
  assert.throws(() => compile(mods, withAgent({ tasks: ["t"] })), /may use only apps, paperclip_tasks, not tasks/);
  assert.throws(() => compile(mods, inst({ edge }, [{ ...roadmap, feedback_to: "nobody" }])), /feedback_to names nobody/);
});
