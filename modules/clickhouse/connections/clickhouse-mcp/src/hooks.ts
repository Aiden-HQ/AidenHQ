// The checks clickhouse-mcp applies to every call before it leaves (policy.ts), as the vendor proxy's hooks.
import { checkCall, isRead, NEVER, QueryRefused, truncateResult } from "./policy.js";
import type { Hooks } from "./vendor/proxy.js";

export const hooks: Hooks = {
  deny: NEVER,
  isRead,
  args(name, args) {
    try {
      return checkCall(name, args);
    } catch (err) {
      if (err instanceof QueryRefused) throw new Error(`Query refused by AidenHQ: ${err.message}. Queries are read-only and stay inside the database.`);
      throw err;
    }
  },
  result: (r) => truncateResult(r),
};
