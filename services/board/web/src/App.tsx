import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInRequired, api, type Session } from "./api";
import { SignInScreen } from "./Accounts";
import { SettingsView, isCategory, type Category } from "./Settings";
import { ApprovalsView } from "./Chat";
import { clearCache, load, peek, setAccount } from "./cache";
import { subscribe } from "./events";
import { VIEW_CHUNKS, prefetchView } from "./queries";
import { ChatWorkspace } from "./Workspace";
import { askForNotifications, notificationsSupported, watchNeedsYou } from "./notify";
import { CardView, GearIcon, GoogleBanner, PlusIcon, PoweredBy, SignInBanners, SortableCard, memberIssue } from "./components";
import { CrewPicker, Drawer } from "./Drawer";
import { Markdown, setSlackTeams } from "./markdown";
import { BUCKETS, BUCKET_NAMES, type Board, type Bucket, type Card } from "./types";
import { dayDate, matches } from "./util";

// Pages off the first screen load as their own chunks (warmed on hover and when the browser is idle: queries.ts).
const ActivityView = lazy(() => VIEW_CHUNKS.activity().then((m) => ({ default: m.ActivityView })));
const AppsView = lazy(() => VIEW_CHUNKS.apps().then((m) => ({ default: m.AppsView })));
const CostsView = lazy(() => VIEW_CHUNKS.costs().then((m) => ({ default: m.CostsView })));
const CrewView = lazy(() => VIEW_CHUNKS.agents().then((m) => ({ default: m.CrewView })));
const RunPage = lazy(() => VIEW_CHUNKS.run().then((m) => ({ default: m.RunPage })));
/** A page's place while its code arrives (rarely seen: it is warmed early). No spinner: the page paints in a moment. */
const PageLoading = () => <main className="page wide" aria-busy="true" />;

type Items = Record<Bucket, Card[]>;
type Route = { kind: "board" } | { kind: "chat"; ref: string | null } | { kind: "view"; view: View } | { kind: "settings"; cat: Category | null } | { kind: "task"; ref: string; focus?: string } | { kind: "run"; id: string } | { kind: "brief" } | { kind: "help" };

const HINTS: Record<Bucket, string> = {
  triage: "New tasks land here",
  today: "",
  tomorrow: "Rolls into Today",
  later: "This week or so",
  backlog: "Someday",
};

const isBucket = (id: unknown) => (BUCKETS as string[]).includes(String(id));

/**
 * What a dragged card is over: a card under the pointer (closest one), else the column under the
 * pointer. closestCorners alone prefers a small card in the old column over a tall empty one.
 * Inside a column, the gaps between cards count as the nearest card, and anywhere below the last
 * card counts as the column itself, which means "the bottom".
 */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return rectIntersection(args);
  const cards = hits.filter((h) => !isBucket(h.id));
  if (cards.length) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((d) => cards.some((c) => c.id === d.id)) });
  const column = hits.find((h) => isBucket(h.id));
  const pointer = args.pointerCoordinates;
  if (!column || !pointer) return hits;
  const inColumn = args.droppableContainers.filter((d) => d.data.current?.sortable?.containerId === column.id);
  const bottom = Math.max(...inColumn.map((d) => args.droppableRects.get(d.id)?.bottom ?? -Infinity));
  if (!inColumn.length || pointer.y > bottom) return [column];
  return closestCenter({ ...args, droppableContainers: inColumn });
};

/**
 * Mouse and pen only. Pointer events fire for touches too, and this sensor would claim them before
 * the TouchSensor saw them, turning every swipe that moved 6px into a drag instead of a scroll.
 */
class MouseOrPenSensor extends PointerSensor {
  static activators = PointerSensor.activators.map((a) => ({
    ...a,
    handler: (e: Parameters<typeof a.handler>[0], opts: Parameters<typeof a.handler>[1]) => e.nativeEvent.pointerType !== "touch" && a.handler(e, opts),
  }));
}

function parseRoute(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  // #/t/PEN-12 opens a task; #/t/PEN-12/PEN-15 opens it on the agent working in PEN-15.
  if (h.startsWith("t/")) {
    const [ref = "", focus] = h.slice(2).split("/");
    return { kind: "task", ref, ...(focus ? { focus } : {}) };
  }
  // #/r/<run id> opens a run's trace.
  if (/^r\/[0-9a-f-]{36}$/.test(h)) return { kind: "run", id: h.slice(2) };
  // #/c/ starts a new chat; #/c/WOR-12 opens that chat in the chat workspace.
  if (h === "c" || h.startsWith("c/")) return { kind: "chat", ref: h.slice(2).split("?")[0] || null };
  // #/settings/<category> opens Settings there; the old tabs (#/connections, #/modules, #/accounts) are categories now.
  if (h === "settings" || h.startsWith("settings/")) {
    const cat = h.slice("settings/".length);
    return { kind: "settings", cat: isCategory(cat) ? cat : null };
  }
  if (h === "connections" || h === "modules" || h === "accounts") return { kind: "settings", cat: h };
  // #/approvals, #/activity, ...: deep links to a tab.
  // A tab link may carry the tab's own state after "?" (#/costs?range=7d).
  if ((VIEWS as string[]).includes(h.split("?")[0]!)) return { kind: "view", view: h.split("?")[0] as View };
  if (h === "brief") return { kind: "brief" };
  if (h === "help") return { kind: "help" };
  return { kind: "board" };
}
const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

type View = "chat" | "agents" | "approvals" | "activity" | "board" | "apps" | "costs" | "settings";
const VIEWS: View[] = ["chat", "agents", "approvals", "activity", "board", "apps", "costs", "settings"];
// Daily work in the bar; configuration (connections, modules, accounts, instance settings) is behind the Settings gear.
const TABS: [View, string][] = [["chat", "Chat"], ["approvals", "Approvals"], ["agents", "Agents"], ["apps", "Apps"], ["board", "Tasks"], ["activity", "Activity"], ["costs", "Costs"]];
const VIEW_KEY = "aidenhq.view";
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "connections" || v === "modules" || v === "accounts") return "settings"; // tabs that moved into Settings
    return v && (VIEWS as string[]).includes(v) ? (v as View) : "chat";
  } catch {
    return "chat";
  }
};

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

/** The board this device last saw (cache.ts), with its Slack hosts set for links. */
function cachedBoard(): Board | undefined {
  const b = peek<Board>("board")?.data;
  if (b) setSlackTeams(b.slackTeams ?? {});
  return b;
}

export function App() {
  // The device's last board (main.tsx adopted its account) paints at once; /api/board, already on its way, replaces it.
  const [board, setBoard] = useState<Board | null>(() => cachedBoard() ?? null);
  const [session, setSession] = useState<Session | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [items, setItems] = useState<Items | null>(() => cachedBoard()?.buckets ?? null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route>(parseRoute);
  // The Approvals badge counts the cards the owner can decide there (not every needs-you item: some are tasks outside it).
  const [approvalsOpen, setApprovalsOpen] = useState(0);
  const [notifyAsk, setNotifyAsk] = useState(() => notificationsSupported() && Notification.permission === "default");
  const signInNeeded = useCallback(() => setNeedsSignIn(true), []);
  // Browser notifications and the Approvals count: what needs you, polled while the board is open.
  useEffect(
    () =>
      watchNeedsYou(
        () => api.needsYou().then((r) => (setApprovalsOpen(r.approvals), r)),
        (identifier) => go(`#/c/${identifier}`),
        (tick) => subscribe(["approvals", "chat"], tick),
      ),
    [],
  );
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Bucket>("today");
  const [view, setViewState] = useState<View>(savedView);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** When the board was last asked for (the timer below); opening Tasks asks again when that is over 10s ago. */
  const boardAt = useRef(Date.now());
  const setView = useCallback((v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [creating, setCreating] = useState(false);
  const mobile = useMedia("(max-width: 860px)");
  const holdUntil = useRef(0); // ignore polls briefly after a local change, so cards don't jump back
  const itemsRef = useRef<Items | null>(null);
  itemsRef.current = items;
  const dragFrom = useRef<Bucket | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 3500);
  }, []);

  const seq = useRef(0); // only the latest board request counts (an old 401 must not undo a sign-in)
  const refresh = useCallback(async (force = false) => {
    const n = ++seq.current;
    try {
      // The first call shares the boot preload; later ones (after a change) fetch again once any running one lands.
      const b = await load("board", api.board, true, n > 1);
      if (n !== seq.current) return;
      setSlackTeams(b.slackTeams ?? {});
      setBoard(b);
      setError("");
      setNeedsSignIn(false);
      if (force || Date.now() > holdUntil.current) setItems(b.buckets);
    } catch (e) {
      if (n !== seq.current) return;
      if (e instanceof SignInRequired) (clearCache(), setNeedsSignIn(true));
      else setError((e as Error).message);
    }
  }, []);
  // The cache (cache.ts) belongs to the signed-in account; with one, the last board paints at once while /api/board loads.
  useEffect(() => {
    if (!session) return;
    const admin = session.account?.role === "admin";
    setAccount(admin ? session.account!.id : null);
    const cached = admin ? peek<Board>("board")?.data : undefined;
    if (!cached) return;
    setSlackTeams(cached.slackTeams ?? {});
    setBoard((b) => b ?? cached);
    setItems((i) => i ?? cached.buckets);
  }, [session]);

  useEffect(() => {
    if (view !== "board" || Date.now() - boardAt.current < 10_000) return;
    boardAt.current = Date.now();
    void refresh();
  }, [view, refresh]);

  useEffect(() => {
    load("session", api.session, false).then(setSession, () => {});
    void refresh(true);
    // Every 10s on Tasks; elsewhere only the header reads it (the working dot, sign-in banners, the brief): once a minute.
    const t = setInterval(() => {
      if (document.visibilityState !== "visible" || dragFrom.current || (viewRef.current !== "board" && Date.now() - boardAt.current < 60_000)) return;
      boardAt.current = Date.now();
      void refresh();
    }, 10_000);
    const vis = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", vis);
    const hash = () => {
      const r = parseRoute();
      setRoute(r);
      // A chat link opens the Chat tab; a tab link opens that tab.
      if (r.kind === "chat") setView("chat");
      if (r.kind === "view") setView(r.view);
      if (r.kind === "settings") setView("settings");
    };
    hash();
    window.addEventListener("hashchange", hash);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("hashchange", hash);
    };
  }, [refresh]);

  // Mobile starts on Triage when there's something to sort, else Today.
  const startedTab = useRef(false);
  useEffect(() => {
    if (items && !startedTab.current) {
      startedTab.current = true;
      setTab(items.triage.length ? "triage" : "today");
    }
  }, [items]);

  const hold = () => (holdUntil.current = Date.now() + 4000);
  const bucketOf = (id: string, src = itemsRef.current): Bucket | undefined => (src ? BUCKETS.find((b) => src[b].some((c) => c.id === id)) : undefined);

  // ---------------------------------------------------------------- actions

  async function moveCard(id: string, to: Bucket, position: "top" | "bottom" = "top") {
    const cur = itemsRef.current;
    const from = bucketOf(id);
    if (!cur || !from) return;
    const card = cur[from].find((c) => c.id === id)!;
    if (from !== to) {
      hold();
      setItems({ ...cur, [from]: cur[from].filter((c) => c.id !== id), [to]: position === "top" ? [card, ...cur[to]] : [...cur[to], card] });
    }
    try {
      await api.move(id, to, position);
      if (from !== to) toast(`Moved to ${BUCKET_NAMES[to]}`);
    } catch (e) {
      toast(`Couldn't move: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  /** Snooze: into Backlog now, back on top of Today on `date`. Undo puts it back where it was. */
  async function snoozeCard(id: string, date: string) {
    const cur = itemsRef.current;
    const from = bucketOf(id);
    if (cur && from) {
      const card = { ...cur[from].find((c) => c.id === id)!, scheduled: { date, bucket: "today" as Bucket }, carried: undefined };
      hold();
      setItems(from === "backlog" ? { ...cur, backlog: cur.backlog.map((c) => (c.id === id ? card : c)) } : { ...cur, [from]: cur[from].filter((c) => c.id !== id), backlog: [card, ...cur.backlog] });
    }
    try {
      await api.schedule(id, { date, bucket: "today", park: "backlog" });
      toast(`Snoozed until ${dayDate(date)}`, from ? { label: "Undo", run: () => void api.move(id, from).then(() => refresh(true)) } : undefined);
      void refresh(true);
    } catch (e) {
      toast(`Couldn't snooze: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  async function reorder(id: string, delta: number) {
    const cur = itemsRef.current;
    const b = bucketOf(id);
    if (!cur || !b) return;
    const list = cur[b];
    const i = list.findIndex((c) => c.id === id);
    const j = Math.max(0, Math.min(list.length - 1, i + delta));
    if (i === j) return;
    const next = arrayMove(list, i, j);
    hold();
    setItems({ ...cur, [b]: next });
    await api.order(b, next.map((c) => c.id)).catch(() => refresh(true));
  }

  async function markDone(card: Card) {
    const cur = itemsRef.current;
    const b = bucketOf(card.id);
    if (cur && b) hold(), setItems({ ...cur, [b]: cur[b].filter((c) => c.id !== card.id) });
    try {
      await api.update(card.id, { status: "done" });
      toast(`${card.identifier} done`, {
        label: "Undo",
        run: () => void api.update(card.id, { status: card.status === "in_progress" ? "in_progress" : "todo" }).then(() => refresh(true)),
      });
      void refresh();
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  /** Merge a task into another of yours from the board: it's cancelled, so it leaves its column. */
  async function mergeCard(card: Card, into: Card) {
    const cur = itemsRef.current;
    const b = bucketOf(card.id);
    if (cur && b) hold(), setItems({ ...cur, [b]: cur[b].filter((c) => c.id !== card.id) });
    try {
      const r = await api.merge(card.id, into.identifier);
      toast(`${r.merged} merged into ${r.into}`, { label: "Open", run: () => go(`#/t/${r.into}`) });
      void refresh(true);
    } catch (e) {
      toast(`Couldn't merge: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  /** All of Today's carried-over tasks at once: keep them for today, or move them on. */
  async function carriedAction(action: "keep" | "tomorrow" | "later") {
    const cur = itemsRef.current;
    if (!cur) return;
    const carried = cur.today.filter((c) => c.carried);
    hold();
    if (action === "keep") setItems({ ...cur, today: cur.today.map((c) => ({ ...c, carried: undefined })) });
    else setItems({ ...cur, today: cur.today.filter((c) => !c.carried), [action]: [...carried.map((c) => ({ ...c, carried: undefined })), ...cur[action]] });
    try {
      const { count } = await api.carried(action);
      toast(action === "keep" ? "Kept for today" : `Moved ${count} to ${BUCKET_NAMES[action]}`);
      void refresh(true);
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  async function addTask(title: string, bucket: Bucket) {
    try {
      const t = await api.create(title, bucket);
      toast(`Added ${t.identifier} to ${BUCKET_NAMES[bucket]}`);
      await refresh(true);
    } catch (e) {
      toast(`Couldn't add: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- drag and drop

  const sensors = useSensors(
    useSensor(MouseOrPenSensor, { activationConstraint: { distance: 6 } }),
    // touch: a deliberate long press drags, anything that moves first scrolls
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    dragFrom.current = bucketOf(String(e.active.id)) ?? null;
    if (e.activatorEvent.type === "touchstart") navigator.vibrate?.(10);
  }

  function containerOf(id: string): Bucket | undefined {
    return (BUCKETS as string[]).includes(id) ? (id as Bucket) : bucketOf(id);
  }

  function onDragOver(e: DragOverEvent) {
    const over = e.over && String(e.over.id);
    const id = String(e.active.id);
    const cur = itemsRef.current;
    if (!over || !cur) return;
    const from = bucketOf(id);
    const to = containerOf(over);
    if (!from || !to) return;
    if (from === to) {
      // below the last card of its own column: show it at the bottom
      const list = cur[from];
      if (over === to && list[list.length - 1]?.id !== id) setItems({ ...cur, [from]: [...list.filter((c) => c.id !== id), list.find((c) => c.id === id)!] });
      return;
    }
    const card = cur[from].find((c) => c.id === id)!;
    const idx = cur[to].findIndex((c) => c.id === over);
    const target = [...cur[to]];
    target.splice(idx < 0 ? target.length : idx, 0, card);
    setItems({ ...cur, [from]: cur[from].filter((c) => c.id !== id), [to]: target });
  }

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    const over = e.over && String(e.over.id);
    const from = dragFrom.current;
    setActiveId(null);
    dragFrom.current = null;
    let cur = itemsRef.current;
    if (!cur || !over) return void refresh(true);
    const b = bucketOf(id);
    if (!b) return;
    const list = cur[b];
    const oldIndex = list.findIndex((c) => c.id === id);
    const newIndex = over === b ? list.length - 1 : list.findIndex((c) => c.id === over);
    if (newIndex >= 0 && oldIndex !== newIndex) {
      cur = { ...cur, [b]: arrayMove(list, oldIndex, newIndex) };
      setItems(cur);
    }
    hold();
    void api.order(b, cur[b].map((c) => c.id)).catch(() => refresh(true));
    if (from && from !== b) toast(`Moved to ${BUCKET_NAMES[b]}`);
  }

  // ---------------------------------------------------------------- keyboard

  const visibleBuckets: Bucket[] = mobile ? [tab] : BUCKETS;
  const filtered = useMemo(() => {
    if (!items) return null;
    return Object.fromEntries(BUCKETS.map((b) => [b, items[b].filter((c) => matches(c, query))])) as Items;
  }, [items, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
      if (e.key === "Escape") {
        if (creating) return setCreating(false);
        if (typing) return el.blur();
        if (route.kind !== "board" && route.kind !== "chat" && route.kind !== "view" && route.kind !== "settings") return go("#/");
        if (query) return setQuery("");
        return setSelected(null);
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (route.kind === "task" || route.kind === "brief" || route.kind === "run" || view === "chat") return;
      const lists = filtered;
      if (!lists) return;
      const cols = visibleBuckets;
      const pos = () => {
        for (const b of cols) {
          const i = lists[b].findIndex((c) => c.id === selected);
          if (i >= 0) return { b, i };
        }
        return undefined;
      };
      const select = (card: Card | undefined) => {
        if (!card) return;
        setSelected(card.id);
        requestAnimationFrame(() => document.querySelector(`[data-card="${card.id}"]`)?.scrollIntoView({ block: "nearest" }));
      };
      const p = pos();
      const k = e.key;
      if (k === "/") return e.preventDefault(), searchRef.current?.focus();
      if (k === "c" || k === "n") return e.preventDefault(), setCreating(true);
      if (k === "b") return go("#/brief");
      if (k === "?") return go("#/help");
      if (k === "d") return setShowDone((s) => !s);
      if (k === "r") return setShowRecurring((s) => !s);
      if (k === "a") return setView(view === "agents" ? "board" : "agents");
      if (view !== "board") return;
      if (k === "j" || k === "ArrowDown") {
        e.preventDefault();
        if (e.shiftKey && p) return void reorder(lists[p.b][p.i]!.id, 1);
        if (!p) return select(cols.map((b) => lists[b][0]).find(Boolean));
        return select(lists[p.b][p.i + 1]);
      }
      if (k === "k" || k === "ArrowUp") {
        e.preventDefault();
        if (e.shiftKey && p) return void reorder(lists[p.b][p.i]!.id, -1);
        if (p) return select(lists[p.b][p.i - 1]);
        return;
      }
      if (k === "J" && p) return e.preventDefault(), void reorder(lists[p.b][p.i]!.id, 1);
      if (k === "K" && p) return e.preventDefault(), void reorder(lists[p.b][p.i]!.id, -1);
      if ((k === "h" || k === "ArrowLeft" || k === "l" || k === "ArrowRight") && !mobile) {
        e.preventDefault();
        const dir = k === "h" || k === "ArrowLeft" ? -1 : 1;
        let ci = p ? cols.indexOf(p.b) : 0;
        for (let n = 0; n < cols.length; n++) {
          ci += dir;
          if (ci < 0 || ci >= cols.length) return;
          const list = lists[cols[ci]!];
          if (list.length) return select(list[Math.min(p?.i ?? 0, list.length - 1)]);
        }
        return;
      }
      if (!p) return;
      const card = lists[p.b][p.i]!;
      if (k === "Enter" || k === "o") return go(`#/t/${card.identifier}`);
      if (k === "m") return e.preventDefault(), document.querySelector<HTMLButtonElement>(`[data-card="${card.id}"] [aria-label="Merge into"]`)?.click();
      if (k === "e" || k === "x") {
        const next = lists[p.b][p.i + 1] ?? lists[p.b][p.i - 1];
        setSelected(next?.id ?? null);
        return void markDone(card);
      }
      const n = Number(k);
      if (n >= 1 && n <= BUCKETS.length) {
        const next = lists[p.b][p.i + 1] ?? lists[p.b][p.i - 1];
        if (BUCKETS[n - 1] !== p.b && mobile) setSelected(next?.id ?? null);
        return void moveCard(card.id, BUCKETS[n - 1]!);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- render

  // A 401 or "totp" from any view means the session ended or changed: ask again which screen to show.
  useEffect(() => {
    if (needsSignIn) void api.session().then(setSession, () => {});
  }, [needsSignIn]);
  // Signed out, or an admin without an authenticator yet: both are done on the kernel's sign-in pages.
  if (session && !session.account) return <SignInScreen />;

  if (!board || !items || !filtered)
    return <div className="splash">{error ? <>Can't reach the board: {error}</> : <span className="spinner" />}</div>;

  const active = activeId ? BUCKETS.flatMap((b) => items[b]).find((c) => c.id === activeId) : undefined;
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, items[b].length])) as Record<Bucket, number>;
  const mergeTargets = BUCKETS.flatMap((b) => items[b]).filter((c) => c.assignee === "me" && !c.recurring);
  const openChat = (identifier: string) => go(`#/c/${identifier}`);
  const tabs = TABS;
  const onBoard = view === "board";
  // A chat (or a settings category) open on a phone takes the whole screen (back arrow to the list).
  const chatFull = mobile && ((view === "chat" && route.kind === "chat") || (view === "settings" && route.kind === "settings" && route.cat !== null));
  const local = ["localhost", "127.0.0.1"].includes(location.hostname); // a tunnel to 3121: the loopback sign-ins work
  const googleConnect = local || !!session?.googleConnect;
  const connectionsOk = !board.google?.error && !board.google?.accounts.some((a) => a.state === "expired") && [board.glean, board.grafana, board.clickhouse, board.jira].every((c) => !c || !c.configured || c.state === "ok" || c.state === "unknown");
  const openCard = (c: Card) => {
    setSelected(c.id);
    go(`#/t/${c.identifier}`);
  };

  return (
    <div className={`app${mobile ? " mobile" : ""}${view === "chat" ? " on-chat" : ""}`}>
      <header className="topbar" hidden={chatFull}>
        <a className="brand" href="#/" onClick={() => setQuery("")}>
          <img src="/icon.png" alt="" />
          <span>AidenHQ</span>
        </a>
        {!mobile && (
          <nav className="main-tabs" aria-label="Sections">
            {tabs.map(([v, name]) => (
              <button key={v} className={`btn${view === v ? " on" : ""}`} aria-current={view === v ? "page" : undefined} onClick={() => setView(v)} onPointerEnter={() => prefetchView(v)} onFocus={() => prefetchView(v)}>
                {v === "agents" && board.agentsActive > 0 && <span className="live-dot" title={`${board.agentsActive} working`} />}
                {name}
                {v === "approvals" && approvalsOpen > 0 && <span className="btn-count needs">{approvalsOpen}</span>}
              </button>
            ))}
          </nav>
        )}
        {/* The page's tools: one group on the right that drops to its own row when the bar runs out of room. */}
        <div className="topbar-tools">
        {onBoard && (
          <div className="search">
            <input ref={searchRef} type="search" placeholder="Search  /" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        {onBoard && board.recurring.length > 0 && (
          <button className={`btn${showRecurring ? " on" : ""}`} onClick={() => setShowRecurring(!showRecurring)} title="Recurring tasks (r)">
            Recurring
          </button>
        )}
        {onBoard && (
          <button className={`btn${showDone ? " on" : ""}`} onClick={() => setShowDone(!showDone)} title="Recently done (d)">
            Done
          </button>
        )}
        {onBoard && (
          <button className="btn primary" onClick={() => setCreating(true)} title="New task (c)">
            {mobile ? <PlusIcon /> : "New task"}
          </button>
        )}
        {notifyAsk && (
          <button className="btn" onClick={() => void askForNotifications().then(() => setNotifyAsk(false))} title="Get a browser notification when something needs you">
            Notify me
          </button>
        )}
        {board.brief && (
          <a className="btn" href="#/brief" title="Today's brief (b)">
            Brief
          </a>
        )}
        <a className={`btn settings-btn${view === "settings" ? " on" : ""}`} href="#/settings" onClick={() => setView("settings")} aria-current={view === "settings" ? "page" : undefined} title="Settings: connections, agents, approvals, accounts and the instance">
          <GearIcon />
          {!mobile && "Settings"}
          {!connectionsOk && <span className="needs-dot" title="A connection needs you" />}
        </a>
        {!mobile && (
          <a className="icon-btn" href="#/help" title="Keyboard shortcuts (?)">
            ?
          </a>
        )}
        </div>
      </header>

      {error && <div className="offline">Offline: {error}. Retrying…</div>}
      <GoogleBanner google={board.google} canReconnect={googleConnect} />
      <SignInBanners board={board} canConnect={local} />

      {mobile && !chatFull && (
        <nav className="tabs">
          {tabs.filter(([v]) => v !== "board").map(([v, name]) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)} onPointerEnter={() => prefetchView(v)} onFocus={() => prefetchView(v)}>
              {name}
              {v === "approvals" && approvalsOpen > 0 && <span className="count">{approvalsOpen}</span>}
            </button>
          ))}
          {BUCKETS.map((b) => (
            <button key={b} className={view === "board" && b === tab ? "on" : ""} onClick={() => (setTab(b), setView("board"))}>
              {BUCKET_NAMES[b]}
              {counts[b] > 0 && <span className="count">{counts[b]}</span>}
            </button>
          ))}
        </nav>
      )}

      {view === "chat" && <ChatWorkspace selected={route.kind === "chat" ? route.ref : null} composing={route.kind === "chat" && !route.ref} mobile={mobile} crew={board.assignees} prefix={board.prefix} go={go} onSignIn={signInNeeded} toast={toast} />}
      {view === "approvals" && <ApprovalsView open={openChat} onSignIn={signInNeeded} />}
      {view === "activity" && <Suspense fallback={<PageLoading />}><ActivityView onSignIn={signInNeeded} /></Suspense>}
      {view === "settings" && <SettingsView cat={route.kind === "settings" ? route.cat : null} mobile={mobile} session={session} go={go} onSignIn={signInNeeded} can={{ signIn: local, google: googleConnect }} />}
      {view === "apps" && <Suspense fallback={<PageLoading />}><AppsView onSignIn={signInNeeded} /></Suspense>}
      {view === "costs" && <Suspense fallback={<PageLoading />}><CostsView onSignIn={signInNeeded} /></Suspense>}
      {view === "agents" && <Suspense fallback={<PageLoading />}><CrewView crew={board.assignees} onSignIn={signInNeeded} /></Suspense>}
      <main className="columns" hidden={view !== "board"}>
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setActiveId(null), (dragFrom.current = null), void refresh(true))}>
          {visibleBuckets.map((b) => (
            <Column
              key={b}
              bucket={b}
              cards={filtered[b]}
              total={counts[b]}
              board={board}
              selected={selected}
              dragDisabled={!!query}
              onOpen={openCard}
              onDone={markDone}
              onMove={(c, to) => void moveCard(c.id, to)}
              onSnooze={(c, date) => void snoozeCard(c.id, date)}
              onMerge={(c, into) => void mergeCard(c, into)}
              mergeTargets={mergeTargets}
              onAdd={(title) => addTask(title, b)}
              onCarried={b === "today" ? (action) => void carriedAction(action) : undefined}
              addRef={b === "triage" ? addRef : undefined}
              timezone={board.timezone}
            />
          ))}
          <DragOverlay dropAnimation={null}>{active && <CardView card={active} assignees={board.assignees} overlay onOpen={() => {}} />}</DragOverlay>
        </DndContext>
        {showRecurring && (
          <section className="column column-done">
            <header className="col-head">
              <h2>Recurring</h2>
              <span className="count">{board.recurring.length}</span>
              <span className="hint">Runs land on top of Today</span>
            </header>
            <div className="col-body">
              {board.recurring.filter((c) => matches(c, query)).map((c) => (
                <CardView key={c.id} card={c} assignees={board.assignees} onOpen={openCard} />
              ))}
              {!board.recurring.length && <p className="empty">Nothing repeats yet. Open a task and use Repeats.</p>}
            </div>
          </section>
        )}
        {showDone && (
          <section className="column column-done">
            <header className="col-head">
              <h2>Done</h2>
              <span className="count">{board.done.length}</span>
              <span className="hint">Last 48 hours</span>
            </header>
            <div className="col-body">
              {board.done.filter((c) => matches(c, query)).map((c) => (
                <CardView key={c.id} card={c} assignees={board.assignees} closed onOpen={openCard} />
              ))}
              {!board.done.length && <p className="empty">Nothing closed recently.</p>}
            </div>
          </section>
        )}
      </main>

      {route.kind === "task" && (
        <Drawer
          key={route.ref}
          refId={route.ref}
          focus={route.focus}
          board={board}
          onClose={() => go("#/")}
          onChanged={() => void refresh(true)}
          onMove={(id, b) => moveCard(id, b)}
          onSnooze={(id, date) => snoozeCard(id, date)}
          toast={toast}
        />
      )}
      {route.kind === "brief" && board.brief && (
        <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && go("#/")}>
          <aside className="drawer brief" role="dialog" aria-label="Brief">
            <header className="drawer-head">
              <span className="ident">{board.brief.identifier}</span>
              <span className="spacer" />
              <button className="btn" onClick={() => void api.update(board.brief!.id, { status: "done" }).then(() => (go("#/"), refresh(true)))}>
                Mark read
              </button>
              <a className="icon-btn" href="#/" aria-label="Close">
                ✕
              </a>
            </header>
            <div className="drawer-scroll">
              <Markdown text={board.brief.description} prefix={board.prefix} className="brief-md" />
            </div>
          </aside>
        </div>
      )}
      {route.kind === "run" && <Suspense fallback={null}><RunPage key={route.id} id={route.id} onClose={() => (history.length > 1 ? history.back() : go("#/"))} onSignIn={signInNeeded} /></Suspense>}
      {route.kind === "help" && <Help />}
      {creating && (
        <NewTask
          board={board}
          onClose={() => setCreating(false)}
          onCreated={(identifier, agent) => {
            setCreating(false);
            toast(agent ? `Added ${identifier} · ${agent} is on it` : `Added ${identifier} to Triage`);
            if (mobile) setTab("triage"), setView("board");
            void refresh(true);
          }}
          toast={toast}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ColumnProps {
  bucket: Bucket;
  cards: Card[];
  total: number;
  board: Board;
  selected: string | null;
  dragDisabled: boolean;
  onOpen: (c: Card) => void;
  onDone: (c: Card) => void;
  onMove: (c: Card, b: Bucket) => void;
  onSnooze: (c: Card, date: string) => void;
  onMerge: (c: Card, into: Card) => void;
  mergeTargets: Card[];
  onAdd: (title: string) => Promise<void>;
  onCarried?: (action: "keep" | "tomorrow" | "later") => void;
  addRef?: React.RefObject<HTMLInputElement | null>;
  timezone: string;
}

function Column({ bucket, cards, total, board, selected, dragDisabled, onOpen, onDone, onMove, onSnooze, onMerge, mergeTargets, onAdd, onCarried, addRef, timezone }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: bucket });
  const [adding, setAdding] = useState(bucket === "triage");
  const [title, setTitle] = useState("");
  const hint =
    bucket === "today"
      ? new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: timezone })
      : bucket === "tomorrow" && !board.rollsTomorrow
        ? `Rolls into Today on ${new Date(`${board.rollsOn}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}`
        : HINTS[bucket];
  const carried = onCarried ? cards.filter((c) => c.carried).length : 0;
  async function submit() {
    const t = title.trim();
    if (!t) return;
    setTitle("");
    await onAdd(t);
  }
  return (
    <section className={`column column-${bucket}${isOver ? " over" : ""}${bucket === "triage" && total ? " has-items" : ""}`}>
      <header className="col-head">
        <h2>{BUCKET_NAMES[bucket]}</h2>
        <span className="count">{total}</span>
        <span className="hint">{hint}</span>
        <span className="spacer" />
        {bucket !== "triage" && (
          <button className="icon-btn subtle" title={`Add to ${BUCKET_NAMES[bucket]}`} aria-label={`Add to ${BUCKET_NAMES[bucket]}`} onClick={() => setAdding(!adding)}>
            <PlusIcon />
          </button>
        )}
      </header>
      {adding && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={addRef}
            value={title}
            placeholder={bucket === "triage" ? "Add a task…  c" : `Add to ${BUCKET_NAMES[bucket]}…`}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTitle("");
                (e.target as HTMLInputElement).blur();
                if (bucket !== "triage") setAdding(false);
              }
            }}
          />
        </form>
      )}
      <div className="col-body" ref={setNodeRef}>
        {carried > 0 && (
          <div className="carried-bar" title="Left unfinished from earlier days: keep them for today, or move them on">
            <span className="carried-text">
              <b>{carried}</b> carried over
            </span>
            <span className="carried-actions">
              <button className="btn" title="Keep them for today" onClick={() => onCarried!("keep")}>
                Keep
              </button>
              <button className="btn" title="Move them to Tomorrow" onClick={() => onCarried!("tomorrow")}>
                → Tomorrow
              </button>
              <button className="btn" title="Move them to Later" onClick={() => onCarried!("later")}>
                → Later
              </button>
            </span>
          </div>
        )}
        <SortableContext id={bucket} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((c) => (
            <SortableCard
              key={c.id}
              card={c}
              assignees={board.assignees}
              selected={c.id === selected}
              disabled={dragDisabled}
              onOpen={onOpen}
              onDone={onDone}
              onMove={onMove}
              onSnooze={onSnooze}
              onMerge={onMerge}
              targets={mergeTargets}
              timezone={timezone}
              current={bucket}
            />
          ))}
        </SortableContext>
        {!cards.length && <p className="empty">{total ? "No matches." : bucket === "triage" ? "All sorted." : "Nothing here."}</p>}
      </div>
    </section>
  );
}

function Help() {
  const rows: [string, string][] = [
    ["j / k  ↓ ↑", "Select next / previous"],
    ["h / l  ← →", "Previous / next column"],
    ["Enter", "Open task"],
    ["e", "Done"],
    ["1 – 5", "Move to Triage, Today, Tomorrow, Later, Backlog"],
    ["m", "Merge into another task"],
    ["J / K  ⇧↓ ⇧↑", "Move down / up in the column"],
    ["c", "New task, for you or someone in the crew (lands in Triage)"],
    ["/", "Search"],
    ["b", "Today's brief"],
    ["d", "Show recently done"],
    ["r", "Show recurring tasks"],
    ["a", "Crew: who is working on what"],
    ["⌘↵", "Send reply / save description"],
    ["Esc", "Close"],
  ];
  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && go("#/")}>
      <div className="help" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard</h2>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="muted small">Drag cards to rank them; Tomorrow moves into Today at the start of the next workday, below what's left over. Open a task to bring it back on a date or make it repeat.</p>
        <PoweredBy />
      </div>
    </div>
  );
}

/**
 * A new task: just a todo for you, or someone from the crew starts on it with your
 * instructions. Either way it's your task, in Triage.
 */
function NewTask({ board, onClose, onCreated, toast }: { board: Board; onClose: () => void; onCreated: (identifier: string, agent?: string) => void; toast: (text: string) => void }) {
  const [title, setTitle] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const crew = board.assignees.filter((a) => a.kind !== "me");
  const agent = crew.find((a) => a.key === pick);
  const name = agent?.name;
  async function create() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const task = await api.create(t, "triage");
      if (agent) await api.addAgent(task.id, agent.key, text.trim() || t);
      onCreated(task.identifier, name);
    } catch (e) {
      toast(`Couldn't add: ${(e as Error).message}`);
      setBusy(false);
    }
  }
  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="new-task"
        role="dialog"
        aria-label="New task"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2>New task</h2>
        <input className="new-title" autoFocus value={title} placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} />
        <CrewPicker crew={crew} pick={pick} setPick={setPick} me />
        {agent && (
          <textarea
            value={text}
            placeholder={`Instructions for ${name}: links, repositories, what to report back. Leave empty to use the title.`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), void create();
            }}
          />
        )}
        <div className="row-end">
          <span className="muted small new-where">Lands in Triage</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
            {agent ? `Create and start ${name}` : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

