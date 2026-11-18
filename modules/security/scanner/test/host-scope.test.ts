import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The inventory is made on the host by the product checkout's ops/security-sbom.sh (this repository is the product's
// modules/). Its `host` target is what the operator remediates: apt packages and ops/vm/pins.json. A checkout, task
// worktree or tool cache in a home is another project's dependency tree, and no host remediation clears a lockfile in a
// clone, so the host target scans / without the homes while /usr, /opt, /etc and the dpkg database stay in it.
it("the host target scans / with ./home/** and ./root/** excluded, and the system package tree still in it", async () => {
  const product = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\necho 0\n"); // the Docker socket's group
  writeFileSync(join(dir, "bin/docker"), '#!/usr/bin/env bash\n[ "$1" = run ] && printf "%s\\n" "$*" >> "$CALLS"\nexit 0\n');
  for (const f of ["stat", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  const calls = join(dir, "calls");
  const err = await new Promise<string>((resolve) =>
    execFile("bash", [join(product, "ops/security-sbom.sh")], {
      cwd: product,
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, AIDENHQ_DATA_DIR: join(dir, "data"), AIDENHQ_INSTANCE_DIR: "" },
    }, (_e, _o, stderr) => resolve(String(stderr))),
  );
  const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  const line = lines.find((l) => l.includes("--source-name host"));
  expect(line, `the host target runs:\n${err || lines.join("\n")}`).toBeDefined();
  expect(line).toMatch(/-v \/:\/host:ro .* dir:\/host /); // the root filesystem, read-only
  const excludes = [...line!.matchAll(/--exclude (\S+)/g)].map((m) => m[1]!);
  expect(excludes).toContain("./home/**");
  expect(excludes).toContain("./root/**");
  // Every exclusion is anchored at a top-level path, so none can cover the system package set the operator acts on.
  const top = excludes.map((p) => p.replace(/^\.\//, "").replace(/\/\*\*$/, ""));
  for (const d of ["usr", "opt", "etc", "var/lib/dpkg"]) {
    expect(top.some((p) => p === d || d.startsWith(`${p}/`) || p.startsWith(`${d}/`)), `${d} is scanned`).toBe(false);
  }
});
