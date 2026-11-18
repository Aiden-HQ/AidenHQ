// Generated compose (spec §5.11): hostile manifests (H4, H5) fail compile or get nothing; every service is hardened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose, SERVICE_FIELDS } from "../src/loader/services.ts";

const IMG = `example.com/acme/tool:1.0@sha256:${"a".repeat(64)}`;
const root = mkdtempSync(join(tmpdir(), "mod-"));
mkdirSync(join(root, "srv"));
writeFileSync(join(root, "srv", "Dockerfile"), "FROM scratch\n");
const ctx = { root, local: true, rootServices: ["board", "control"], rootNetworks: ["backplane", "sources"], rootSecrets: ["model_provider_key", "board_internal_token"] };
const gen = (name, def, c = {}) => generateCompose(name, def, { ...ctx, ...c });
const svc = (s, extra = {}) => ({ services: { run: { srv: { image: IMG, ...s } } }, ...extra });

test("H4: a bind mount, a capability, host namespaces, devices, extra hosts, DNS or a network each fail compile", () => {
  const hostile = { volumes: ["/var/run/docker.sock:/var/run/docker.sock"], cap_add: ["SYS_ADMIN"], network_mode: "host", privileged: true, devices: ["/dev/kvm"], pid: "host", ipc: "host", userns_mode: "host", extra_hosts: ["x:10.0.0.1"], dns: ["10.0.0.53"], networks: ["mod-b"], security_opt: ["seccomp=unconfined"], tmpfs: ["/x"], ports: ["0.0.0.0:80:80"] };
  for (const [field, value] of Object.entries(hostile)) assert.throws(() => gen("a", svc({ [field]: value })), new RegExp(`a: services\\.run\\.srv\\.${field} is not allowed`), field);
  assert.throws(() => gen("a", { services: { run: { srv: { image: IMG } }, volumes: {} } }), /services\.volumes is not allowed/);
  // Host paths only through privileged host-metrics, and then only read-only /, /sys, /proc.
  assert.throws(() => gen("a", svc({ host_mounts: ["/:/host:ro"] })), /needs privileged: \[host-metrics\]/);
  assert.throws(() => gen("a", svc({ host_mounts: ["/var/run/docker.sock:/s:ro"] }, { privileged: ["host-metrics"] })), /not a read-only mount/);
  assert.throws(() => gen("a", svc({ host_mounts: ["/:/host"] }, { privileged: ["host-metrics"] })), /not a read-only mount/);
  assert.throws(() => gen("a", svc({}, { privileged: ["root"] })), /not in the closed list/);
  // A data entry can't climb out of the module's data dir.
  assert.throws(() => gen("a", svc({ data: ["../b:/x"] })), /not <folder>:<container path>/);
  // Compose interpolation of anything but its own secrets and allowed host variables.
  assert.throws(() => gen("a", svc({ env: { X: "${AIDENHQ_SECRETS_DIR}/b" } })), /is not allowed/);
  assert.throws(() => gen("a", svc({ command: ["sh", "-c", "cat $HOME/x"] })), /is not allowed/);
  // The board's address, only to a module whose sign-in returns there.
  assert.throws(() => gen("a", svc({ env: { BOARD_URL: "${BOARD_LAN_URL:-}" } })), /is not allowed/);
  assert.equal(gen("a", svc({ env: { BOARD_URL: "${BOARD_LAN_URL:-}" } }, { contributes: { "board.signins": [{ id: "a" }] } })).services["a-srv"].environment.BOARD_URL, "${BOARD_LAN_URL:-}");
});

test("H4: another module's network only through requires; root services and networks only through the legacy list", () => {
  assert.throws(() => gen("a", svc({ join: ["b"] })), /may join only the network of a module it requires \(b\)/);
  assert.deepEqual(Object.keys(gen("a", svc({ join: ["b"] }, { requires: ["b"] })).services["a-srv"].networks), ["mod-a", "mod-b"]);
  assert.throws(() => gen("a", svc({ links: ["backplane"] })), /a may not reach backplane/);
  const g = gen("a", svc({ links: ["board", "sources"] }), { legacy: { links: ["board", "sources"] } });
  assert.deepEqual(Object.keys(g.services["a-srv"].networks), ["mod-a", "mod-a-board", "sources"]);
  assert.deepEqual(g.roots.board.networks, ["mod-a-board"]); // a network only a's linking service and the board share
});

test("H5: a module mounts only its own secrets, data dir and vault dir", () => {
  const def = { secrets: { state: true, provided: ["a_key"] }, services: { data: true, run: { srv: { image: IMG, data: ["db:/data"], state: "/state", env: { KEY: "${secrets.a_key}" } } } } };
  assert.deepEqual(gen("a", def).stateDirs, ["modules/a"]); // compile makes it before compose (a FUSE vault: Docker can't)
  const out = JSON.stringify(gen("a", def));
  assert.ok(out.includes("modules/a/db") && out.includes("modules/a:/state") && out.includes("/a_key"));
  assert.ok(!/modules\/b|b_key|model_provider/.test(out));
  // b's secret, a root secret (even declared as its own) and the vault root are never mounted.
  assert.throws(() => gen("a", { ...def, services: { run: { srv: { image: IMG, env: { K: "${secrets.b_key}" } } } } }), /secret b_key isn't one of a's own/);
  assert.throws(() => gen("a", { secrets: { provided: ["model_provider_key"] }, services: { run: { srv: { image: IMG, secrets: ["model_provider_key"] } } } }), /secret model_provider_key isn't one of a's own/);
  assert.throws(() => gen("a", { services: { run: { srv: { image: IMG, state: "/state" } } } }), /declare secrets.state: true/);
  assert.throws(() => gen("a", { services: { run: { srv: { image: IMG, data: ["db:/data"] } } } }), /declare services.data: true/);
});

test("remote-source modules need image digests; local ones may build in their folder", () => {
  assert.throws(() => gen("a", svc({ image: undefined, build: "./srv" }), { local: false }), /remote source needs an image by digest/);
  assert.throws(() => gen("a", svc({ image: "example.com/acme/tool:latest" })), /pinned by digest/);
  assert.throws(() => gen("a", svc({ image: undefined, build: "../srv" })), /must be a folder in the module/);
  assert.equal(gen("a", svc({ image: undefined, build: "./srv" })).services["a-srv"].image, "aidenhq/a-srv:local");
});

test("generated services carry the hardened settings, their own network and the old name as an alias", () => {
  const g = gen("a", svc({ egress: true, ui_port: 3131, port: 3000 }));
  const s = g.services["a-srv"];
  assert.deepEqual([s.cap_drop, s.security_opt, s.read_only, s.user, s.ports], [["ALL"], ["no-new-privileges:true"], true, "${PUID:-1000}:${PGID:-100}", ["127.0.0.1:3131:3000"]]);
  assert.deepEqual(s.networks, { "mod-a": { aliases: ["srv"] }, "mod-a-egress": { aliases: ["srv"] } });
  assert.equal(g.networks["mod-a"].internal, true);
  assert.equal(g.networks["mod-a-egress"].internal, undefined);
});

test("the schema lists exactly the fields the loader accepts", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/services.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(schema.properties.run.additionalProperties.properties).sort(), [...SERVICE_FIELDS].sort());
});
