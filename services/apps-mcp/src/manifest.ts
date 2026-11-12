// An app's manifest (docs/design/access.md, App manifest): `aidenhq-app.yaml` at the app's
// path, versioned with the code that interprets its roles. App-authored, so validated strictly. Optional.
import { parse } from "yaml";
import { z } from "zod";

export const MANIFEST_FILE = "aidenhq-app.yaml";
const CORE = ["blocked", "member", "admin"];

const Schema = z
  .object({
    roles: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "a role name is lowercase letters, digits and -").refine((n) => !CORE.includes(n), "blocked, member and admin are core roles"),
          meaning: z.string().min(1).max(120).refine((m) => !/[\p{Cc}<>]/u.test(m), "a meaning is one line of plain text"),
        }).strict(),
      )
      .max(10)
      .default([]),
    default_role: z.string().optional(),
  })
  .strict()
  .refine((m) => new Set(m.roles.map((r) => r.name)).size === m.roles.length, "role names must be unique")
  .refine((m) => !m.default_role || (m.default_role !== "admin" && ["blocked", "member", ...m.roles.map((r) => r.name)].includes(m.default_role)), "default_role is blocked, member or a declared role (never admin)");

export type Manifest = z.output<typeof Schema>;

/** The manifest's text (absent: no custom roles) → the manifest, or throws with what is wrong. */
export function parseManifest(text: string | undefined): Manifest {
  if (text === undefined || !text.trim()) return { roles: [] };
  const r = Schema.safeParse(parse(text) ?? {});
  if (!r.success) throw new Error(`${MANIFEST_FILE}: ${r.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
  return r.data;
}
