// ops/vm/public-fw.sh: the public interface's open ports follow the exposure mode (docs/design/access.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fw = join(dirname(fileURLToPath(import.meta.url)), "../../ops/vm/public-fw.sh");
const open = (exposure) => {
  const out = execFileSync("bash", [fw, "--print"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, PUBLIC_IF: "eth0", ...(exposure ? { EXPOSURE: exposure } : {}) } });
  return [...out.matchAll(/iifname "eth0" (tcp|udp) dport (\d+) accept/g)].map((m) => `${m[1]}/${m[2]}`).filter((p) => !["udp/68", "udp/546"].includes(p));
};

test("public-fw: each mode opens exactly its ports; unset is tailscale, an unknown mode SSH only", () => {
  assert.deepEqual(open("public"), ["tcp/22", "tcp/443"]);
  assert.deepEqual(open("tailscale"), ["tcp/22", "udp/41641"]);
  assert.deepEqual(open("cloudflare"), ["tcp/22"]);
  assert.deepEqual(open("local"), ["tcp/22"]);
  assert.deepEqual(open(undefined), ["tcp/22", "udp/41641"]);
  assert.deepEqual(open("wide-open"), ["tcp/22"]);
});
