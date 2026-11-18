import { describe, expect, it } from "vitest";
import { ownContainerId, resolveOwnImage } from "../src/self-image.js";

const ID = "ab".repeat(32);

describe("own image", () => {
  it("runs helpers by its image id, held by a platform tag so a rebuild of apps-mcp's tag can't drop it", async () => {
    const id = `sha256:${"f".repeat(64)}`;
    const asked: string[][] = [];
    const docker = async (args: string[]) => {
      asked.push(args);
      return args[0] === "inspect" ? `${id}\n` : args[0] === "image" ? `${"f".repeat(64)}\n${"e".repeat(64)}\n` : "";
    };
    expect(await resolveOwnImage(docker, () => "abc123")).toBe(id);
    expect(asked).toEqual([
      ["inspect", "--format", "{{.Image}}", "abc123"],
      ["tag", id, `aidenhq/apps-mcp-helper:${"f".repeat(64)}`],
      ["image", "ls", "aidenhq/apps-mcp-helper", "--format", "{{.Tag}}"],
      ["rmi", `aidenhq/apps-mcp-helper:${"e".repeat(64)}`],
    ]);
  });

  it("refuses when the image can't be resolved", async () => {
    await expect(resolveOwnImage(async () => { throw new Error("no such container"); }, () => "x")).rejects.toThrow(/cannot resolve apps-mcp's own image/);
    await expect(resolveOwnImage(async () => "\n", () => "x")).rejects.toThrow(/cannot resolve/);
    await expect(resolveOwnImage(async () => "aidenhq/apps-mcp:local\n", () => "x")).rejects.toThrow(/not an image id/);
  });

  it("reads the container id from the mounts, else the hostname", () => {
    const files: Record<string, string> = { "/proc/self/mountinfo": `1 2 0:1 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw`.replace("/var/lib", "/var/lib").replace("docker/containers", "docker/containers"), "/etc/hostname": "host12\n" };
    expect(ownContainerId((p) => files[p]!)).toBe(ID);
    files["/proc/self/mountinfo"] = "nothing";
    expect(ownContainerId((p) => files[p]!)).toBe("host12");
  });
});

describe("helper containers", () => {
  it("run in the configured own image: the health probe and app_api's transport", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createPlatform } = await import("../src/platform.js");
    const { parseApp } = await import("../src/registry.js");
    const dir = mkdtempSync(join(tmpdir(), "own-image-"));
    const log = join(dir, "runs.log");
    writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" >> ${log}\ncase " $* " in *" -i "*) cat >/dev/null;; esac\necho '{"status":200,"body":"ok"}'\n`);
    chmodSync(join(dir, "docker"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      const registryPath = join(dir, "apps.yaml");
      writeFileSync(registryPath, "apps:\n  - { name: notes, repo: example-org/notes, owner: a, description: d, health: { url: 'http://web:8080/api/health' } }\n");
      const p = createPlatform(
        { registryPath, modulesRegistryPath: join(dir, "m.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "x.pem"), identityKeysHostFile: join(dir, "k.json"), dbPath: join(dir, "s.sqlite"), urlBase: "", edgeDir: dir, healthImage: "sha256:ownimage", git: { appsData: dir, gitDir: dir } },
        { warn: () => {}, info: () => {} },
      );
      await p.probe(p.find("notes"));
      await p.sendApi(p.find("notes"), { method: "GET", path: "/" } as never, "c".repeat(64));
      const runs = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("run "));
      expect(runs.length).toBe(2);
      for (const r of runs) expect(r).toContain(" sha256:ownimage node -e");
    } finally {
      process.env.PATH = path;
    }
  });
});
