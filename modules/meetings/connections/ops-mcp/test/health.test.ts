import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { healthChecks } from "../src/app.js";
import { makeEnv } from "./helpers.js";

const vaultAt = (root: string, writeRoots: string[]) => ({
  vault: { root, read_roots: writeRoots, write_roots: writeRoots },
});

describe("healthChecks vault", () => {
  it("names vault_writable at the top level and reads an unmounted vault as missing", async () => {
    // The image's own /vault: it exists, and nothing is mounted into it, so the configured write roots are absent.
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    const env = makeEnv({ cfg: vaultAt(root, ["Meetings"]) });
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(false);
    expect(h.state).toBe("missing");
    expect(h.detail).toContain("vault_writable: not writable: Meetings");
  });

  it("is a named failure, not missing, when a folder is mounted but write_roots names none of it", async () => {
    // VAULT_FOLDERS names Notes while the shipped write_roots still says Meetings: a misconfigured vault, not an unset one.
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    mkdirSync(join(root, "Notes"));
    const env = makeEnv({ cfg: vaultAt(root, ["Meetings"]) });
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(false);
    expect(h.state).toBeUndefined();
    expect(h.detail).toContain("vault_available:");
    expect(h.detail).toContain("vault_writable: not writable: Meetings");
  });

  it("stays a named failure, not missing, when the vault is mounted but unwritable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    mkdirSync(join(root, "Meetings"));
    chmodSync(join(root, "Meetings"), 0o555);
    const env = makeEnv({ cfg: vaultAt(root, ["Meetings"]) });
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(false);
    expect(h.state).toBeUndefined();
    expect(h.detail).toContain("vault_writable: not writable: Meetings");
  });

  it("needs a searchable write root, not only a writable one", async () => {
    // A rw-only directory cannot be traversed, so a note cannot be created in it even though W_OK passes.
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    mkdirSync(join(root, "Meetings"));
    chmodSync(join(root, "Meetings"), 0o644);
    const env = makeEnv({ cfg: vaultAt(root, ["Meetings"]) });
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(false);
    expect(h.checks.vault_available?.ok).toBe(false);
    expect(h.checks.vault_writable?.ok).toBe(false);
  });

  it("is ok when the configured write roots take writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    mkdirSync(join(root, "Projects"));
    mkdirSync(join(root, "Meetings"));
    const env = makeEnv({ cfg: vaultAt(root, ["Projects", "Meetings"]) });
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(true);
    expect(h.state).toBeUndefined();
    expect(h.detail).toBeUndefined();
    expect(h.checks.vault_available?.ok).toBe(true);
  });
});
