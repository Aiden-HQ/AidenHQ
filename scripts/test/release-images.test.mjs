import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { buildable, computerPulls, useReleaseImages } from "../release-images.mjs";
import { resolveRelease } from "../../kernel/src/loader/release.ts";

const sha = (c) => `sha256:${c.repeat(64)}`;
const ref = (n, c) => `ghcr.io/acme/${n}@${sha(c)}`;
const kernel = "a".repeat(40);

test("apply pulls pinned images instead of building: a release's images replace the builds they name, the rest build", () => {
  const dir = mkdtempSync(join(tmpdir(), "rel-"));
  const compose = { services: { board: { build: "./services/board", image: "aidenhq/board:local" }, "apps-mcp": { build: "./a", image: "aidenhq/apps-mcp:local" }, paperclip: { image: `x/paperclip@${sha("e")}` } } };
  writeFileSync(join(dir, "compose.yaml"), YAML.stringify(compose));
  mkdirSync(join(dir, "modules/chat/connections/lane"), { recursive: true });
  writeFileSync(join(dir, "modules/chat/module.yaml"), YAML.stringify({ services: { run: { "chat-lane": { build: "./connections/lane" }, whisper: { build: "./w" } } } }));
  // The names a release can carry are exactly what this checkout builds.
  const chains = buildable(dir);
  assert.deepEqual(chains.flat().map((i) => i.name), ["board", "apps-mcp", "chat-lane", "chat-whisper", "computer-browser", "computer-agent-base", "computer-engineer"]);
  assert.equal(chains.at(-1)[1].base, "computer-browser");

  const release = resolveRelease({ release: "2026.11", kernel, marketplace: { name: "aidenhq", source: {}, sha: "b".repeat(40) }, modules: {}, images: { board: ref("board", "1"), "chat-lane": ref("chat-lane", "2"), "computer-browser": ref("computer-browser", "3") } }, { product: kernel });
  const generated = { services: { "chat-lane": { build: "/m/lane", image: "aidenhq/chat-lane:local", read_only: true }, "chat-whisper": { build: "/m/w", image: "aidenhq/chat-whisper:local" } } };
  const out = YAML.parse(YAML.stringify(useReleaseImages(generated, compose, release.images), { lineWidth: 0 }), { customTags: [{ tag: "!reset", resolve: () => "RESET" }] });
  assert.deepEqual(out.services.board, { image: ref("board", "1"), build: "RESET" });
  assert.deepEqual(out.services["chat-lane"], { image: ref("chat-lane", "2"), read_only: true });
  assert.equal(out.services["chat-whisper"].build, "/m/w");
  assert.equal(out.services["apps-mcp"], undefined);
  assert.deepEqual(computerPulls({ browser: "aidenhq/computer-browser:abc", engineer: "aidenhq/computer-engineer:def" }, release.images), { "aidenhq/computer-browser:abc": ref("computer-browser", "3") });
  // No images: nothing changes (dev, forks).
  assert.deepEqual(useReleaseImages(generated, compose, {}), generated);
  assert.throws(() => resolveRelease({ release: "2026.11", kernel, marketplace: { name: "aidenhq", source: {}, sha: "b".repeat(40) }, modules: {}, images: { board: "ghcr.io/acme/board:latest" } }, { product: kernel }), /images\.board must be/);
});
