// The Slack module's one manifest source makes both of its setup links, and the one-shot move of the listener's data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { found, manifests, createLink, pasteText } from "../slack-manifest.mjs";
import { moveSlackLive } from "../../ops/slack-live-move.mjs";

const moduleYaml = readFileSync(new URL("../../modules/slack/module.yaml", import.meta.url), "utf8");

test("module.yaml's basic link and advanced paste text are the manifest source's", () => {
  const m = manifests();
  const f = found(moduleYaml);
  assert.deepEqual(f.link, [createLink(m.basic)], "run: node scripts/slack-manifest.mjs --write");
  assert.deepEqual(f.paste, [pasteText(m.advanced)], "run: node scripts/slack-manifest.mjs --write");
});

test("basic asks only for the person's reads; advanced adds the bot, Socket Mode and the events on top", () => {
  const { basic, advanced } = manifests();
  assert.equal(basic.oauth_config.scopes.bot, undefined);
  assert.equal(basic.features, undefined);
  assert.ok(basic.oauth_config.scopes.user.includes("search:read.public"));
  for (const dropped of ["team:read", "dnd:read", "pins:read", "bookmarks:read", "links:read", "search:read"]) assert.ok(!advanced.oauth_config.scopes.user.includes(dropped), dropped);
  assert.deepEqual(advanced.oauth_config.scopes.user, basic.oauth_config.scopes.user);
  assert.ok(["channels:history", "groups:history", "chat:write", "commands"].every((s) => advanced.oauth_config.scopes.bot.includes(s)));
  assert.equal(advanced.settings.socket_mode_enabled, true);
  assert.equal(basic.settings.socket_mode_enabled, false);
  assert.ok(!advanced.settings.event_subscriptions.bot_events.includes("reaction_added") && !advanced.settings.event_subscriptions.user_events.includes("file_shared"));
});

test("the listener's data moves from channel-slack to slack once, and an existing instance keeps its database", () => {
  const data = mkdtempSync(join(tmpdir(), "slack-move-"));
  mkdirSync(join(data, "modules", "channel-slack", "slack-live"), { recursive: true });
  writeFileSync(join(data, "modules", "channel-slack", ".data_version"), "0\n");
  writeFileSync(join(data, "modules", "channel-slack", "slack-live", "slack-live.sqlite"), "paired owner");
  mkdirSync(join(data, "modules", "slack", "slack-live"), { recursive: true }); // compile made it, empty
  assert.equal(moveSlackLive(data), "moved");
  assert.equal(readFileSync(join(data, "modules", "slack", "slack-live", "slack-live.sqlite"), "utf8"), "paired owner");
  assert.ok(!existsSync(join(data, "modules", "channel-slack")));
  assert.equal(moveSlackLive(data), "fresh");
  assert.equal(moveSlackLive(mkdtempSync(join(tmpdir(), "slack-fresh-"))), "fresh");
});
