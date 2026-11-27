import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { healthChecks } from "../src/app.js";
import { canonicalNotePath } from "../src/render/notes.js";
import { makeEnv } from "./helpers.js";

const vaultAt = (root: string, writeRoots: string[], meetingsRoot?: string) => ({
  vault: { root, read_roots: writeRoots, write_roots: writeRoots, ...(meetingsRoot ? { meetings_root: meetingsRoot } : {}) },
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

  it("fails when canonical notes would land outside the write roots", async () => {
    // write_roots names Notes but meetings_root still says Meetings: the write root takes writes, yet every new
    // canonical note is rejected as outside the allowed folders.
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    mkdirSync(join(root, "Notes"));
    const env = makeEnv({ cfg: vaultAt(root, ["Notes"]) });
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(false);
    expect(h.checks.vault_writable?.ok).toBe(false);
    expect(h.detail).toContain("canonical notes under Meetings cannot be read");
  });

  it("fails when the folder for the month being published is read-only", async () => {
    // The probe must be the folder publishing writes now: a writable meetings_root with a read-only current month fails.
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    const env = makeEnv({ cfg: vaultAt(root, ["Meetings"]) });
    // The folder publishing would use now, from the same function that builds the path.
    const now = new Date().toISOString();
    const note = canonicalNotePath("Meetings", { calendar_event_id: "t", title: "T", start_at: now, end_at: now, timezone: env.cfg.timezone, attendees: [] });
    const month = join(root, dirname(note));
    mkdirSync(month, { recursive: true });
    chmodSync(month, 0o555);
    const h = await healthChecks(env.app);
    // A root uid bypasses the mode, so this case can only be asserted by a normal user.
    if (process.getuid?.() === 0) {
      expect(h.ok).toBe(true);
      return;
    }
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("cannot be written");
  });

  it("fails when the current month's folder is a dangling symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    const env = makeEnv({ cfg: vaultAt(root, ["Meetings"]) });
    const now = new Date().toISOString();
    const note = canonicalNotePath("Meetings", { calendar_event_id: "t", title: "T", start_at: now, end_at: now, timezone: env.cfg.timezone, attendees: [] });
    const month = join(root, dirname(dirname(note)));
    mkdirSync(dirname(month), { recursive: true });
    symlinkSync(join(root, "gone"), month);
    const h = await healthChecks(env.app);
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("cannot be written");
  });

  it("fails when the nested meetings folder is read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "ops-mcp-health-vault-"));
    mkdirSync(join(root, "Notes", "Meetings"), { recursive: true });
    chmodSync(join(root, "Notes", "Meetings"), 0o555);
    const env = makeEnv({ cfg: vaultAt(root, ["Notes"], "Notes/Meetings") });
    const h = await healthChecks(env.app);
    if (process.getuid?.() === 0) return;
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("cannot be written");
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
