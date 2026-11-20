// primer_get_digest: what other people did on the owner's documents since a time. The titles, names and quoted text in it
// are other people's words (Primer fences them with its own random tag), so the whole answer reaches the agent as data.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fence } from "./aidenhq-sdk/fence.js";

export const DIGEST_TOOL = "primer_get_digest";

export function fenceDigest(result: CallToolResult, name: string): CallToolResult {
  if (name !== DIGEST_TOOL || result.isError || !Array.isArray(result.content)) return result;
  return { ...result, content: result.content.map((c) => (c.type === "text" ? { ...c, text: fence(c.text, "primer:digest") } : c)) };
}
