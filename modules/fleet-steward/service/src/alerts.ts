// Monitoring alerts (modules/monitoring, docs/design/monitoring.md). Alertmanager posts its webhook here (POST /alerts, on the
// network only it and this service share); firing alerts are kept until resolved, and the detector's `alert` group opens one
// incident per alert and recovers it on resolve. A newly firing `severity: critical` alert also tells the owner in one fixed line.
// An alert's label and annotation text is free text: it reaches the Steward only inside fence(), never the owner.
import { fence } from "./aidenhq-sdk/fence.ts";
import type { Incident, Kv } from "./detector.ts";

const KEY = "alerts";
type Firing = Record<string, { name: string; severity: string; summary: string; since: string; told?: boolean }>;
export interface Alert { status: "firing" | "resolved"; fingerprint: string; labels: Record<string, string>; annotations: Record<string, string>; startsAt?: string }

/** A label value as a short slug (a-z, 0-9, _ and -): alert names and severities are ours, but never trusted as text. */
const slug = (v: unknown, max: number) => String(v ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
const strings = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter(([, x]) => typeof x === "string")) as Record<string, string>;

/** What Alertmanager sent, checked: at most 500 alerts, each with a hex fingerprint and a firing or resolved status. */
export function parseAlerts(body: unknown): Alert[] {
  const list = (body as { alerts?: unknown })?.alerts;
  if (!Array.isArray(list) || list.length > 500) throw new Error("alerts must be a list of at most 500");
  return list.map((a) => {
    if (!/^[0-9a-f]{1,32}$/.test(String(a?.fingerprint)) || !["firing", "resolved"].includes(a?.status)) throw new Error("an alert needs a hex fingerprint and a status");
    return { status: a.status, fingerprint: a.fingerprint, labels: strings(a.labels), annotations: strings(a.annotations), ...(typeof a.startsAt === "string" && a.startsAt.length <= 40 ? { startsAt: a.startsAt } : {}) };
  });
}

/** What is firing now, by fingerprint. */
export function firing(kv: Pick<Kv, "get">): Firing {
  try {
    return JSON.parse(kv.get(KEY) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * What the owner reads for each critical rule (modules/monitoring/prometheus/rules.yml): fixed sentences, never alert text.
 * Label and annotation values can carry names an agent's app chose, so none of them reaches the owner's channel.
 */
const OWNER_SENTENCE: Record<string, string> = {
  disknearlyfull: "a disk on the host is nearly full",
  coreservicedown: "a core service has been down for over 5 minutes",
  applyfailed: "an apply failed validation or its health check, so the host is on the last known good; the reason and log are in the Fleet Steward's check",
};

/** Alertmanager's webhook body: firing alerts are kept (or updated), resolved ones dropped. */
export function receiveAlerts(kv: Kv, alerts: Alert[], notify: (text: string) => Promise<void>, now = new Date()): Promise<{ firing: number }> {
  // One at a time: a call reads the map, awaits the owner notice, then writes the map back, so overlapping calls would drop each other's alerts.
  const run = serial.then(() => applyAlerts(kv, alerts, notify, now));
  serial = run.catch(() => {});
  return run;
}
let serial: Promise<unknown> = Promise.resolve();

async function applyAlerts(kv: Kv, alerts: Alert[], notify: (text: string) => Promise<void>, now: Date): Promise<{ firing: number }> {
  const f = firing(kv);
  for (const a of alerts) {
    if (a.status === "resolved") { delete f[a.fingerprint]; continue; }
    // Our rules' names are identifiers; anything else is not a name we wrote.
    const name = /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(a.labels.alertname ?? "") ? a.labels.alertname!.toLowerCase() : "unnamed";
    const severity = slug(a.labels.severity, 20) || "warning";
    // Free text (the rule's summary with label values in it): bounded here, fenced as data in the incident's reason.
    const summary = String(a.annotations.summary ?? a.annotations.description ?? "").slice(0, 300);
    // The owner hears of a critical alert once, when it starts firing; the Steward works every alert. Marked told only once the
    // notice went out: a kernel that was down is tried again on the next webhook or tick.
    let told = f[a.fingerprint]?.told;
    if (!told && severity === "critical") told = await notify(`Monitoring: ${name} (critical): ${OWNER_SENTENCE[name] ?? "a critical alert fired"}. The Fleet Steward is on it.`).then(() => true, () => false);
    const since = f[a.fingerprint]?.since ?? (a.startsAt && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(a.startsAt) && !a.startsAt.startsWith("0001") ? a.startsAt : now.toISOString());
    f[a.fingerprint] = { name, severity, summary, since, ...(told ? { told } : {}) };
  }
  kv.set(KEY, JSON.stringify(f));
  return { firing: Object.keys(f).length };
}

/**
 * The detector's `alert` group: one incident per firing alert, its text fenced as data. Alertmanager's live list is the truth,
 * not only its one-shot webhook: a vanished series recovers.
 */
export async function alertIncidents(kv: Kv, notify: (text: string) => Promise<void>, alertmanager = "http://alertmanager:9093", fetcher: typeof fetch = fetch): Promise<Incident[]> {
  const res = await fetcher(`${alertmanager}/api/v2/alerts`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  const live = res?.ok ? await res.json().then((j) => (Array.isArray(j) && j.length <= 500 ? j : undefined), () => undefined) : undefined;
  if (live) {
    const now = [...live.map((a: Alert) => ({ ...a, status: "firing" as const })), ...Object.keys(firing(kv)).filter((fp) => !live.some((a: Alert) => a.fingerprint === fp)).map((fp) => ({ status: "resolved" as const, fingerprint: fp, labels: {}, annotations: {} }))];
    await receiveAlerts(kv, parseAlerts({ alerts: now }), notify);
  }
  return Object.entries(firing(kv)).map(([fp, a]) => {
    const text = a.summary ? `; its text (from the monitoring rule's labels):\n${fence(a.summary, "monitoring.alert")}` : "";
    return { key: fp, reason: `alert ${a.name} (${a.severity}, since ${a.since}); query Prometheus or Grafana for the series${text}`, ...(a.severity === "critical" ? { critical: true } : {}) };
  });
}
