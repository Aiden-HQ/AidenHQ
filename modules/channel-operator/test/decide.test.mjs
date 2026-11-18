// The watcher's CLI spends exactly the named card's own token (fresh for this channel), and honours its setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, parseArgs } from "../bin/decide";

const files = (setting) => (p) => (p.endsWith("channel_operator_token") ? "op-token\n" : JSON.stringify({ modules: { "channel-operator": { settings: { operator_decide: setting } } } }));
function kernel(cards) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/v1/channel/cards?resync=1")) return new Response(JSON.stringify({ cards }));
    return new Response(JSON.stringify({ ok: true, id: "k-0000000000000001", identifier: "WOR-1", sentence: "Push.", state: "stale" }));
  };
  return { calls, f };
}
const env = { AIDENHQ_SECRETS_DIR: "/v", AIDENHQ_CONFIG_DIR: "/c", AIDENHQ_KERNEL_URL: "http://k" };
const card = { id: "k-0000000000000001", kind: "push", panel: false, tokens: { approve: "ta", reject: "tr" } };

test("a stale reject spends the card's reject token, with the channel's own token", async () => {
  const { calls, f } = kernel([card]);
  assert.equal(await decide(["k-0000000000000001", "reject", "--stale"], { env, fetch: f, read: files("all") }), "stale: WOR-1 Push.");
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer op-token", "Bearer op-token"]);
  assert.deepEqual(calls[1].body, { token: "tr", sender: "watcher", stale: true });
});

test("refuses bad arguments, an unknown card and a card its setting keeps for the owner", async () => {
  assert.throws(() => parseArgs(["k-0000000000000001", "approve", "--stale"]), /only for a reject/);
  assert.throws(() => parseArgs(["WOR-1", "approve"]), /usage/);
  await assert.rejects(decide(["k-0000000000000002", "approve"], { env, fetch: kernel([card]).f, read: files("all") }), /no pending card/);
  await assert.rejects(decide(["k-0000000000000001", "approve"], { env, fetch: kernel([{ ...card, panel: true }]).f, read: files("standard") }), /kept for the owner/);
});
