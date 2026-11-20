// The shipped compose plugin is the one this Dockerfile builds, at the versions the security brief requires.
// The plugin is compiled in the `compose` stage from compose-plugin/go.mod and copied into the final image; if that
// ever falls back to a published image's plugin, the binaries those images carry (compose v5.6.1: x/net v0.58.0,
// klauspost/compress v1.20.0) reopen GO-2026-6612 and GO-2026-6865.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("..", import.meta.url));
const DOCKERFILE = readFileSync(`${DIR}/Dockerfile`, "utf8");
const GO_MOD = readFileSync(`${DIR}/compose-plugin/go.mod`, "utf8");
const GO_SUM = readFileSync(`${DIR}/compose-plugin/go.sum`, "utf8");

const PLUGIN = "/usr/local/lib/docker/cli-plugins/docker-compose";
const PLUGIN_SRC = "/usr/local/bin/docker-compose";
const FLOORS = { "github.com/docker/compose/v5": "5.7.1", "golang.org/x/net": "0.62.0", "github.com/klauspost/compress": "1.20.2" };

type Stage = { image: string; alias?: string; body: string };

/** Dockerfile stages in order, each with its image ref, alias and instructions joined into one searchable string. */
function stages(text: string): Stage[] {
  const out: Stage[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from) out.push({ image: from[1]!, alias: from[2], body: "" });
    else if (out.length) out[out.length - 1]!.body += ` ${line.replace(/\\$/, "")}`;
  }
  return out;
}

/** `v0.62.0` as [0, 62, 0]; a leading `v` is optional. */
function version(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(have: string, floor: string): boolean {
  const a = version(have);
  const b = version(floor);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

const moduleVersion = (mod: string): string => {
  const m = new RegExp(`^\\s*${mod.replace(/[./]/g, (c) => `\\${c}`)} (v\\S+)$`, "m").exec(GO_MOD);
  if (!m) throw new Error(`${mod} is not required`);
  return m[1]!;
};

describe("the compose plugin in the apps-mcp image", () => {
  const all = stages(DOCKERFILE);
  const compose = all.find((s) => s.alias === "compose");
  const final = all[all.length - 1]!;

  it("is built from source in a compose stage on a digest-pinned Go image", () => {
    expect(compose).toBeDefined();
    expect(compose!.image).toMatch(/^golang:1\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/);
    expect(compose!.body).toContain("COPY compose-plugin/go.mod compose-plugin/go.sum");
    expect(compose!.body).toContain("go mod download");
    expect(compose!.body).toMatch(new RegExp(`go build .*-o ${PLUGIN_SRC} github\\.com/docker/compose/v5/cmd`));
  });

  it("is the plugin the final image installs, not one copied out of the docker CLI image", () => {
    expect(final.body).toContain(`COPY --from=compose ${PLUGIN_SRC} ${PLUGIN}`);
    const pluginCopies = final.body.split(/ (?:COPY|ADD) /).filter((s) => s.includes("cli-plugins/docker-compose"));
    expect(pluginCopies).toHaveLength(1);
    expect(final.body).not.toMatch(/--from=docker\s+\S*cli-plugins\/docker-compose/);
    expect(final.body).toContain("COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker");
  });

  it("carries x/net and klauspost/compress at or above the advisories' fixes", () => {
    expect(moduleVersion("github.com/docker/compose/v5")).toBe(`v${FLOORS["github.com/docker/compose/v5"]}`);
    expect(atLeast(moduleVersion("golang.org/x/net"), FLOORS["golang.org/x/net"])).toBe(true);
    expect(atLeast(moduleVersion("github.com/klauspost/compress"), FLOORS["github.com/klauspost/compress"])).toBe(true);
    // go.sum has to resolve each floor or `go mod download` fails the build on a cold cache.
    for (const mod of ["golang.org/x/net", "github.com/klauspost/compress"] as const) {
      expect(GO_SUM).toContain(`${mod} v${FLOORS[mod]} `);
      expect(GO_SUM).toContain(`${mod} v${FLOORS[mod]}/go.mod `);
    }
  });

  it("stamps the built binary with the compose version its go.mod pins", () => {
    const stamped = /-X github\.com\/docker\/compose\/v5\/internal\.Version=(v[0-9][0-9.]*)/.exec(compose!.body);
    expect(stamped?.[1]).toBe(moduleVersion("github.com/docker/compose/v5"));
  });

  it("builds and runs on digest-pinned node images", () => {
    const nodes = all.filter((s) => s.image.startsWith("node:"));
    expect(nodes.length).toBeGreaterThan(0);
    for (const s of nodes) expect(s.image).toMatch(/^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/);
  });
});
