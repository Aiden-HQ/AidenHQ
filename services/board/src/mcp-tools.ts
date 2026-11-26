// The owner MCP's own tool names (mcp.ts registers exactly these). Compile refuses a module page whose tool or opener takes one
// (scripts/modules.ts modulePages), so a page can never shadow, or fail to register beside, a board tool.
export const OWNER_TOOLS = ["status", "ask", "tasks", "get_task", "create_task", "update_task", "approvals", "decide", "fleet", "modules", "change_settings", "update", "connect", "teammates", "set_up_teammate", "notify_test", "finish_onboarding", "apps", "costs"] as const;
