// The owner's app alerts (plain code, no LLM), moved here from the owner channel in lean-core 2f: the channel modules no
// longer reach apps-mcp, the board does. Each alert goes to the owner through the one notify (notify.ts). Any app, any channel.
// - An app incident wakes the DevOps Engineer first (apps-mcp fires its routine); the owner is told only when it has stayed
//   open over 30 minutes or the app had 3 or more incidents in 24 hours, once per hour, and once when it recovers.
// - Resources, once per hour per cause: an app over 90% of its memory limit, or the host disk over 85%.
import type { Store } from "./store.js";

export interface AppStatus { name: string; incident?: { opened_at: number | string; kind: string; detail: string }; stats?: { mem_bytes: number; mem_limit_bytes: number } }
type Kv = Pick<Store, "meta" | "setMeta">;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export async function appWatchTick(d: { apps: () => Promise<AppStatus[]>; diskPct?: () => Promise<number>; store: Kv; notify: (line: string, kind?: "alert" | "done") => void; now?: number }): Promise<void> {
  const now = d.now ?? Date.now();
  const get = (k: string) => d.store.meta(`appwatch:${k}`) ?? "";
  const set = (k: string, v: string) => d.store.setMeta(`appwatch:${k}`, v);
  const apps = await d.apps();
  for (const app of apps) {
    const inc = app.incident;
    if (!inc) {
      if (get(`paged:${app.name}`)) { d.notify(`✅ ${app.name} recovered`, "done"); set(`paged:${app.name}`, ""); }
      continue;
    }
    const opened = typeof inc.opened_at === "number" ? inc.opened_at : Date.parse(inc.opened_at) || now;
    const seen = new Set<number>((JSON.parse(get(`inc:${app.name}`) || "[]") as number[]).filter((at) => now - at < DAY));
    seen.add(opened);
    set(`inc:${app.name}`, JSON.stringify([...seen]));
    if (now - opened < 30 * MIN && seen.size < 3) continue;
    if (now - Number(get(`paged:${app.name}`) || 0) < HOUR) continue;
    d.notify(`⚠️ DevOps Engineer couldn't fix ${app.name}: ${String(inc.detail).slice(0, 300)}`);
    set(`paged:${app.name}`, String(now));
  }
  const alert = (key: string, text: string) => {
    if (now - Number(get(key) || 0) < HOUR) return;
    d.notify(text);
    set(key, String(now));
  };
  for (const a of apps) {
    const m = a.stats;
    if (m && m.mem_limit_bytes > 0 && m.mem_bytes / m.mem_limit_bytes > 0.9) alert(`mem:${a.name}`, `⚠️ ${a.name} is using ${Math.round((100 * m.mem_bytes) / m.mem_limit_bytes)}% of its memory limit`);
  }
  const disk = d.diskPct ? await d.diskPct().catch(() => 0) : 0;
  if (disk > 85) alert("disk", `⚠️ Host disk is ${disk}% full`);
}
