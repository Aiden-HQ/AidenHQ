// Home (GET /api/home): what needs the owner, what the team did since he last looked, his world today, the teammates with
// news, in one response. Built from what the board already reads (the kernel's task states and cards,
// Paperclip's tasks, the roster) and two module reads (board.reads: owner-channel's `told` ledger, google's
// `calendar_today`). Who a row is from is always a teammate: a hidden agent's row is its teammate's (teammates.ts).
import type { Logger } from "pino";
import type { ShownState } from "./task-state.js";
import { waitsForAnswer, type TaskStates } from "./task-state.js";
import type { StateRow } from "./aidenhq-sdk/task-state-types.js";
import type { RosterAgent, RosterFace } from "./activity.js";
import { askedQuestions, boundQuestions, chatAgent, oneLine, type Question } from "./chats.js";
import type { ViewHost } from "./module-views.js";
import type { Comment, Issue, Paperclip } from "./paperclip.js";
import type { Approval, Records } from "./records.js";
import type { Compiled } from "./settings.js";
import type { Store } from "./store.js";
import { grantsKeyOf, teammateFor, teammateKeys } from "./teammates.js";

export type FaceRef = { key: string; name: string; job: string; face: RosterFace; state: "idle" | "working" | "needs" };
type TaskRef = { identifier: string; title: string };
/** A person waiting on the owner's reply (an open task labelled needs-response, which Intake files): who, and where they wrote. */
export type Reply = { person: string | null; source: "slack" | "gmail" | null };
export type NeedRow =
  | { id: string; kind: "answer"; teammate: FaceRef; since: string; task: TaskRef; question: string; detail?: string; options: string[]; questions: Question[]; waitSince: string }
  | { id: string; kind: "approval"; teammate: FaceRef; since: string; task: TaskRef | null; question: string; card: object }
  | { id: string; kind: "open"; teammate: FaceRef; since: string; task: TaskRef; question: string; reply?: Reply };
export type SinceItem = { teammate: FaceRef; text: string; at: string; task: string | null; kind: "done" | "fyi" | "digest" | "closed" };
export type Home = {
  as_of: string;
  since_from: string;
  /** Every read behind Since answered (a failed ledger or closed-task read leaves it false, so the cursor stays). */
  since_complete: boolean;
  greeting: { needs: number };
  needs: NeedRow[];
  since: { groups: { teammate: FaceRef; latest: SinceItem; count: number }[]; items: SinceItem[]; total: number } | null;
  world: {
    waiting_on: { id: string; identifier: string; title: string; age_days: number; quiet_days: number }[] | null;
    today: { timezone: string; events: { id: string; start: string; title: string; all_day: boolean; prep?: string }[] } | null;
  };
  team: { teammate: FaceRef; line: string }[];
};

export type HomeDeps = {
  pc: Pick<Paperclip, "openIssues" | "closedSince" | "comments">;
  taskStates: TaskStates;
  records: Pick<Records, "allOf">;
  views?: Pick<ViewHost, "read">;
  store: Store;
  compiled: () => Compiled | null;
  roster: () => Promise<RosterAgent[]>;
  /** The app's own: rows as views show them, a card with its task's identifier, a card as the board shows it. */
  shownRows: (rows: StateRow[]) => Promise<ShownState[]>;
  named: (a: Approval) => Promise<Approval>;
  shownApproval: (a: Approval) => object;
  /** The calendar read's 5-minute cache (one per app). */
  cache: { today?: { at: number; value: Home["world"]["today"] } };
  log: Logger;
  now?: () => number;
};

const DAY = 86_400_000;
/** The since window's oldest start: the ledger's age. */
const MAX_WINDOW = 14 * DAY;
const TODAY_MS = 5 * 60_000;
/** The most people waiting on a reply that Needs you lists (the oldest first); Intake can file many. */
const REPLIES = 10;
/** Kinds of ledger rows Home tells again (decisions and alerts are needs or already seen). */
const SINCE_KINDS = ["done", "fyi", "digest"];
/** The most since items one response carries ("All N" says when it shows fewer than the total). */
const SINCE_ITEMS = 200;
type Told = { source: string; task: string | null; kind: string; at: string; cursor: string; text: string };

/** The text inside the ledger's ``` fence (owner-channel fences what agents wrote), first line, as one plain line. */
export const toldLine = (t: string) => oneLine((/^(`{3,})\n([\s\S]*)\n\1$/.exec(t)?.[2] ?? t).split("\n").find((l) => l.trim()) ?? "");

/** 08:00 on the next calendar day in `tz` after `now` (a snooze's end: never later the same morning). */
export function nextEight(now: number, tz: string): string {
  const parts = (at: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  // The zone's offset at an instant: its wall clock read as UTC, less the instant.
  const offset = (at: number) => { const p = parts(at); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(at / 1000) * 1000; };
  const p = parts(now);
  for (const add of [1, 2]) {
    const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day! + add, 8);
    const at = wall - offset(wall - offset(wall));
    if (at > now) return new Date(at).toISOString();
  }
  return new Date(now + DAY).toISOString();
}

/** Every teammate, always (the owner sees his whole team): those with news since he looked first, newest first, with
 * their latest line; the rest in roster order, "Nothing new" (blank when the
 * digest read was partial: no news can't be told from an unread ledger). */
function teamRow(keys: ReturnType<typeof teammateKeys>, since: Home["since"], complete: boolean, face: (key: string) => FaceRef): Home["team"] {
  const news = since?.groups ?? [];
  const told = new Set(news.map((g) => g.teammate.key));
  return [
    ...news.map((g) => ({ teammate: g.teammate, line: g.latest.text })),
    ...[...keys.keys()].filter((k) => !told.has(k)).map((k) => ({ teammate: face(k), line: complete ? "Nothing new" : "" })),
  ];
}

export async function buildHome(d: HomeDeps, viewer: { accountId: string }, from?: string): Promise<Home> {
  const nowMs = (d.now ?? Date.now)();
  const as_of = new Date(nowMs).toISOString();
  const keys = teammateKeys(d.compiled());
  const keyOfAgent = (id: string | null | undefined) => (id ? grantsKeyOf(id) ?? "" : "");
  const cursor = from ?? d.store.homeSeen(viewer.accountId) ?? new Date(nowMs - DAY).toISOString();
  const since_from = new Date(Math.max(Date.parse(cursor) || 0, nowMs - MAX_WINDOW)).toISOString();

  let partial = false;
  const [read, open, cards, roster, told, closed, today] = await Promise.all([
    d.taskStates.read({ open: true }),
    d.pc.openIssues(),
    d.records.allOf("owner").then((l) => Promise.all(l.map(d.named))),
    d.roster().catch(() => [] as RosterAgent[]),
    toldSince(d, since_from, nowMs).catch((err) => {
      d.log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "home: what the owner was told isn't readable");
      partial = true;
      return undefined;
    }),
    closedSince(d, since_from).catch((err) => (d.log.warn({ err: String(err).slice(0, 300) }, "home: closed tasks not read"), (partial = true), [] as Issue[])),
    calendarToday(d, nowMs),
  ]);
  const byId = new Map(open.map((i) => [i.id, i]));
  const labelled = (i: Issue, name: string) => (i.labels ?? []).some((l) => l.name === name);
  const ref = (i: Issue): TaskRef => ({ identifier: i.identifier, title: i.title });

  // A teammate as Home shows it: the roster's name and face (phase 1's), its compiled job; `state` once the needs are known.
  const owners = new Set<string>();
  const face = (agentKey: string): FaceRef => {
    const key = teammateFor(agentKey, keys);
    const r = roster.find((a) => a.key === key);
    const state = owners.has(key) ? "needs" : r?.state === "working" ? "working" : "idle";
    return { key, name: r?.name ?? String(d.compiled()?.agents?.[key]?.name ?? key), job: r?.teammate?.job ?? keys.get(key)?.job ?? "", face: r?.teammate?.face ?? null, state };
  };

  // Needs: every task with the owner's attention (a card on it is the card's row), every owner card.
  const snoozed = d.store.snoozed(viewer.accountId, as_of);
  const states = await d.shownRows(read.tasks.filter((r) => byId.has(r.task) && r.attention.some((a) => a.who === "owner" && ["owner_wait", "handback", "card"].includes(a.why))));
  const cardRows = new Map(cards.map((c) => [c.id, c]));
  /** `snooze`: the key a snooze hides it by: an answer row's task and wait (a new question on the task is a new row), else its id. */
  type Pending = { id: string; snooze?: string; agentKey: string; build: () => NeedRow };
  const pending: Pending[] = [];
  const onTask = new Set<string>();
  for (const st of states) {
    const i = byId.get(st.task)!;
    const agentKey = keyOfAgent(i.assigneeAgentId ?? chatAgent(i));
    const owner = st.attention.filter((a) => a.who === "owner");
    const card = owner.map((a) => (a.why === "card" && a.ref.startsWith("record:") ? cardRows.get(a.ref.slice(7)) : undefined)).find(Boolean);
    if (card) {
      onTask.add(card.id);
      pending.push({ id: card.id, agentKey: keyOfAgent(card.requesterId) || agentKey, build: () => approvalRow(card, ref(i)) });
      continue;
    }
    if (waitsForAnswer(st) && st.wait_since) {
      const q = boundQuestions(askedQuestions(await d.pc.comments(i.id).catch(() => [] as Comment[]), i.assigneeAgentId), st.question ?? "");
      pending.push({ id: i.id, snooze: `${i.id}:${st.wait_since}`, agentKey, build: () => ({ id: i.id, kind: "answer", teammate: face(agentKey), since: st.wait_since!, task: ref(i), question: st.question ?? "", ...(st.detail ? { detail: st.detail } : {}), options: q[0]?.options ?? [], questions: q, waitSince: st.wait_since! }) });
      continue;
    }
    const a = owner.find((x) => x.why !== "card");
    if (a) pending.push({ id: i.id, agentKey, build: () => ({ id: i.id, kind: "open", teammate: face(agentKey), since: a.since, task: ref(i), question: st.question || st.note || i.title }) });
  }
  for (const c of cards) if (!onTask.has(c.id)) pending.push({ id: c.id, agentKey: keyOfAgent(c.requesterId), build: () => approvalRow(c, byId.has(c.issueId) ? ref(byId.get(c.issueId)!) : null) });
  function approvalRow(c: Approval, task: TaskRef | null): NeedRow {
    return { id: c.id, kind: "approval", teammate: face(keyOfAgent(c.requesterId)), since: c.createdAt, task, question: c.sentence, card: d.shownApproval(c) };
  }
  const shown = pending.filter((p) => !snoozed.has(p.snooze ?? p.id));
  for (const p of shown) owners.add(teammateFor(p.agentKey, keys));
  const asks = shown.map((p) => p.build()).sort((a, b) => a.since.localeCompare(b.since));
  // People waiting on the owner's reply come after the teammates' asks (those hold a teammate's work), oldest first: a long
  // run of replies never buries a card.
  // (A task with an ask or a card on it is already a row above.)
  // (Snoozed asks count too: a snoozed ask hides its task, it does not turn it into a reply.)
  const asked = new Set(pending.flatMap((p) => { const r = p.build(); return [r.id, ...(r.task ? [r.task.identifier] : [])]; }));
  const replies = open
    .filter((i) => labelled(i, "needs-response") && !asked.has(i.id) && !asked.has(i.identifier) && !snoozed.has(i.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, REPLIES)
    .map((i): NeedRow => {
      // Intake's task format: the description opens with `Type:` (Slack, Email) and `From:`; the title is "Reply to <person>: <topic>".
      const field = (k: string) => new RegExp(`^${k}:[ \\t]*(.+)$`, "im").exec(i.description ?? "")?.[1]?.trim();
      const type = field("Type")?.toLowerCase() ?? "";
      const source: Reply["source"] = type.startsWith("slack") ? "slack" : type.startsWith("email") ? "gmail" : /\bsource:(slack|gmail)\b/i.test(i.description ?? "") ? (/\bsource:slack\b/i.test(i.description ?? "") ? "slack" : "gmail") : null;
      const m = /^Reply to (.+?):\s*(.*)$/i.exec(i.title);
      return { id: i.id, kind: "open", teammate: face(keyOfAgent(i.assigneeAgentId)), since: i.createdAt, task: ref(i), question: m?.[2] || i.title, reply: { person: field("From") ?? m?.[1] ?? null, source } };
    });
  const needs = [...asks, ...replies];

  // Since: what the owner was told, and the tasks finished, since the window began; one item per task, the newest.
  const items: SinceItem[] = [];
  for (const t of told ?? []) if (SINCE_KINDS.includes(t.kind)) items.push({ teammate: face(t.source === "kernel" ? "" : t.source), text: toldLine(t.text), at: t.at, task: t.task, kind: t.kind as SinceItem["kind"] });
  for (const i of closed) {
    const at = i.completedAt ?? i.cancelledAt;
    if (!at || at < since_from || !i.assigneeAgentId || labelled(i, "chat")) continue;
    items.push({ teammate: face(keyOfAgent(i.assigneeAgentId)), text: `${i.completedAt ? "Done" : "Cancelled"}: ${i.title}`, at, task: i.identifier, kind: "closed" });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  const seenTask = new Set<string>();
  const kept = items.filter((x) => !x.task || (!seenTask.has(x.task) && (seenTask.add(x.task), true)));
  const groups = new Map<string, { teammate: FaceRef; latest: SinceItem; count: number }>();
  for (const x of kept) {
    const g = groups.get(x.teammate.key);
    if (g) g.count++;
    else groups.set(x.teammate.key, { teammate: x.teammate, latest: x, count: 1 });
  }
  // Groups and the total count every item in the window; the items themselves are the newest SINCE_ITEMS.
  const since = kept.length ? { groups: [...groups.values()], items: kept.slice(0, SINCE_ITEMS), total: kept.length } : null;

  // World: what the owner waits on (open tasks labelled waiting-on) and his calendar today.
  const waiting = open.filter((i) => labelled(i, "waiting-on") && !snoozed.has(i.id)).map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, age_days: Math.floor((nowMs - Date.parse(i.createdAt)) / DAY), quiet_days: Math.floor((nowMs - Date.parse(i.lastActivityAt ?? i.updatedAt)) / DAY) }));
  const prepFor = (id: string) => open.find((i) => i.description?.includes(id))?.identifier;
  const world = {
    waiting_on: waiting.length ? waiting : null,
    today: today && { timezone: today.timezone, events: today.events.map((e) => { const prep = prepFor(e.id); return { ...e, ...(prep ? { prep } : {}) }; }) },
  };

  return {
    as_of,
    since_from,
    since_complete: !partial,
    greeting: { needs: needs.length },
    needs,
    since,
    world,
    team: teamRow(keys, since, !partial, face),
  };
}

/**
 * The ledger's delivered rows since `from`, a page at a time until the window is covered (the 14-day clamp bounds it, so
 * nothing in the window is skipped while the seen cursor moves past it); undefined when no module declares it; a failed read throws.
 */
async function toldSince(d: HomeDeps, from: string, nowMs: number): Promise<Told[] | undefined> {
  if (!d.views) return undefined;
  const days = Math.min(14, Math.max(1, Math.ceil((nowMs - Date.parse(from)) / DAY)));
  const out: Told[] = [];
  try {
    let before: string | undefined;
    for (;;) {
      const rows = (await d.views.read("told", { days, limit: 50, state: "delivered", ...(before ? { before } : {}) })) as Told[];
      out.push(...rows.filter((r) => r.at >= from));
      const last = rows.at(-1);
      if (rows.length < 50 || !last || last.at < from) break;
      before = last.cursor;
    }
  } catch (err) {
    // An absent read (no module declares it) is no news; a failed one is an incomplete digest (the caller's).
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
  return out;
}

/** The tasks finished since `from`, every page of them (Paperclip filters by update time, so the window bounds the read). */
async function closedSince(d: HomeDeps, from: string): Promise<Issue[]> {
  const out: Issue[] = [];
  for (;;) {
    const rows = await d.pc.closedSince(from, "200", out.length);
    out.push(...rows);
    if (rows.length < 200) return out;
  }
}

/** google's calendar_today, kept 5 minutes; null when the read is absent, fails or the day is empty. */
async function calendarToday(d: HomeDeps, nowMs: number): Promise<Home["world"]["today"]> {
  const c = d.cache.today;
  if (c && nowMs - c.at < TODAY_MS) return c.value;
  let value: Home["world"]["today"] = null;
  if (d.views) {
    try {
      const r = (await d.views.read("calendar_today", {})) as { timezone: string; events: { id: string; start: string; title: string; all_day: boolean }[] };
      value = r.events.length ? { timezone: r.timezone, events: r.events.map(({ id, start, title, all_day }) => ({ id, start, title, all_day })) } : null;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) d.log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "home: today's calendar isn't readable");
    }
  }
  d.cache.today = { at: nowMs, value };
  return value;
}
