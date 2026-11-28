// Which settings the board's general Settings pages own, and the pages themselves (#/settings/<key>). A module's own
// settings are edited on that module's page only (a feature page, or its Settings tab), never here: MODULE_SETTINGS_SKIP
// keeps the few module settings that live under You and Agents off their module's tab.

export const CATEGORIES = [
  { key: "profile", name: "Profile", group: "You" },
  { key: "notifications", name: "Notifications", group: "You" },
  { key: "autonomy", name: "Autonomy", group: "Agents" },
  { key: "spend", name: "Spend", group: "Agents" },
  { key: "connections", name: "Connections", group: "Connect" },
  { key: "accounts", name: "Accounts", group: "Connect" },
  { key: "updates", name: "Updates", group: "System" },
  { key: "access", name: "Board access", group: "System" },
  { key: "backups", name: "Backups", group: "System" },
  { key: "advanced", name: "Advanced", group: "System" },
] as const;
export type Category = (typeof CATEGORIES)[number]["key"];
export const isCategory = (s: string | null | undefined): s is Category => CATEGORIES.some((c) => c.key === s);

/** The settings each general page edits, in row order. `summon` and `summon_signature` are kernel settings. */
export const PAGE_SETTINGS = {
  profile: ["owner_name", "owner_email", "timezone", "time_format"],
  notifications: ["notify_transports", "notify_fyi", "summon", "summon_signature"],
  autonomy: ["autonomy"],
  spend: ["spend_day_usd", "spend_month_usd", "task_usd"],
  updates: ["auto_update"],
  access: ["exposure"],
  backups: ["backup_repository"],
  advanced: ["computers_max"],
} as const satisfies Partial<Record<Category, readonly string[]>>;

/** Every module setting a general page owns: kept off its module's Settings tab. */
export const GENERAL_KEYS = new Set<string>(Object.values(PAGE_SETTINGS).flat());
