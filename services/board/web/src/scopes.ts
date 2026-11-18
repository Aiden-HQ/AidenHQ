// A vendor's OAuth scopes as the owner reads them: grouped by product, one plain verb per scope. Reads the common shapes
// (`read:jira:agent-interface`, `read:all:twg`, `read:me`, `channels:read`); anything else keeps its raw string.

export type Access = "read" | "search" | "write" | "create" | "update" | "delete" | "manage" | "admin";
export type ScopeItem = { scope: string; label: string; access: Access | null };
export type ScopeGroup = { key: string; name: string; items: ScopeItem[] };

const VERBS: Access[] = ["read", "search", "write", "create", "update", "delete", "manage", "admin"];
const isVerb = (x: string | undefined): x is Access => !!x && (VERBS as string[]).includes(x);

/** Product names that don't read well title-cased; any other product id is title-cased. */
const NAMES: Record<string, string> = {
  jsm: "Jira Service Management",
  "jira-align": "Jira Align",
  twg: "Teamwork Graph",
  rovo: "Rovo search",
  code: "Code search",
  github: "GitHub",
  im: "Direct messages",
  mpim: "Group messages",
};
const ACCOUNT = new Set(["me", "account", "user", "profile", "email", "openid", "offline_access", "users.profile"]);
const ACCOUNT_LABELS: Record<string, string> = { me: "Profile", account: "Account", user: "Profile", profile: "Profile", email: "Email address", openid: "Identity", offline_access: "Stay signed in", "users.profile": "Profile" };

const title = (id: string) => NAMES[id] ?? id.split(/[-_.]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const verb = (a: Access) => a.charAt(0).toUpperCase() + a.slice(1);

function parse(scope: string): { product: string; access: Access | null } | null {
  const parts = scope.split(":");
  if (parts.length === 1 && ACCOUNT.has(scope)) return { product: scope, access: null };
  if (parts.length === 2 || parts.length === 3) {
    // action:product[:suffix]; `all` defers to the suffix (read:all:twg is Teamwork Graph).
    if (isVerb(parts[0])) return { product: parts[1] === "all" && parts[2] ? parts[2] : parts[1]!, access: parts[0] };
    // product:action (Slack's channels:read).
    if (parts.length === 2 && isVerb(parts[1])) return { product: parts[0]!, access: parts[1] };
  }
  return null;
}

export function groupScopes(scopes: readonly string[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  const add = (key: string, name: string, item: ScopeItem) => {
    if (!groups.has(key)) groups.set(key, { key, name, items: [] });
    groups.get(key)!.items.push(item);
  };
  for (const scope of scopes) {
    const p = parse(scope);
    if (!p) add("~other", "Other", { scope, label: scope, access: null });
    else if (ACCOUNT.has(p.product)) add("~account", "Your account", { scope, label: ACCOUNT_LABELS[p.product] ?? scope, access: p.access });
    else add(p.product, title(p.product), { scope, label: verb(p.access!), access: p.access });
  }
  const order = (g: ScopeGroup) => (g.key === "~account" ? 0 : g.key === "~other" ? 2 : 1);
  const out = [...groups.values()].sort((a, b) => order(a) - order(b));
  for (const g of out) if (g.key !== "~account" && g.key !== "~other") g.items.sort((a, b) => VERBS.indexOf(a.access!) - VERBS.indexOf(b.access!));
  return out;
}

/** Whether a scope lets agents change things (still reviewed before each write runs). */
export const changes = (a: Access | null) => !!a && a !== "read" && a !== "search";
