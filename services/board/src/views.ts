// Saved boards (the Tasks page's tabs): a name and what the page shows, `{layout, filters, groupBy}`, ids never names. One
// schema reads and writes the spec, so a row is always what the page can draw. Stored per account (store.ts `views`).
import { z } from "zod";

const LANES = ["needs_you", "working", "waiting", "blocked", "idle", "done"] as const;
const ids = z.array(z.string().min(1).max(64)).max(100);

export const ViewSpecSchema = z
  .object({
    layout: z.enum(["day", "work"]),
    groupBy: z.enum(["none", "agent"]),
    filters: z
      .object({
        /** Agent ids, "me" (You) or "none" (Unassigned). */
        agent: ids,
        state: z.array(z.enum(LANES)).max(LANES.length),
        label: ids,
        priority: z.array(z.enum(["critical", "high", "medium", "low"])).max(4),
        /** Project ids, or "none" (no project). */
        project: ids,
        updated: z.enum(["today", "7d", "30d"]).nullable(),
        text: z.string().max(200),
      })
      .partial()
      .strict(),
  })
  .strict();
export type ViewSpec = z.infer<typeof ViewSpecSchema>;

const name = z.string().trim().min(1).max(60);
export const CreateViewSchema = z.object({ name, spec: ViewSpecSchema }).strict();
export const UpdateViewSchema = z.object({ name: name.optional(), spec: ViewSpecSchema.optional(), rev: z.number().int().min(1) }).strict();

export interface View {
  id: string;
  name: string;
  spec: ViewSpec;
  rev: number;
}
