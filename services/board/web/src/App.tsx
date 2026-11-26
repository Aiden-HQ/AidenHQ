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
import { flushSync } from "react-dom";
import { SignInRequired, api, type Session } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { SignInScreen, RETURN_KEY } from "./Accounts";
import { SettingsView, isCategory, type Category } from "./Settings";
import { AttentionStrip } from "./Attention";
import { ApprovalsView, onYouBeyondCards } from "./Chat";
import { needsOwner } from "./ui/TaskState";
import { clearCache, load, peek, setAccount, subscribe as cacheSubscribe } from "./cache";
import { subscribe } from "./events";
import type { AgentTab } from "./AgentPage";
import type { ModuleTab } from "./ModulePage";
import { QUERIES, VIEW_CHUNKS, hashPath, landsOnBoard, useQuery } from "./queries";
import { ChatWorkspace } from "./Workspace";
import { askForNotifications, notificationsSupported, watchNeedsYou } from "./notify";
import { CardView, GoogleBanner, PlusIcon, PoweredBy, SignInBanners, SortableCard, memberIssue } from "./components";
import { CrewPicker, Drawer } from "./Drawer";
import { SetupFlow } from "./SetupFlow";
import { Markdown, setSlackTeams } from "./markdown";
import { BUCKETS, BUCKET_NAMES, type Board, type Bucket, type Card } from "./types";
import { ago, dayDate, keepsSecureCookies, parkBucket, todayIn } from "./util";
import { panelsOf } from "./sidebar";
import { BottomBar, Palette, SubNav, TopNav, hrefOf, type NavView } from "./Shell";
import { AgentWork, AgentWorkLoading } from "./AgentWork";
import { NOTE_TEXT, useTaskSearch } from "./search";
import { BoardTabs, ConflictBanner, FilterChips, FilterSheet, SaveButton, useTaskBoard } from "./TaskTools";
import { applyFilters, cardMatches, isEmpty } from "./filters";
import { Banner, Segmented } from "./ui";
import { setBoardTimezone } from "./ui/TaskState";
import "./shell.css";

// Pages off the first screen load as their own chunks (warmed on hover and when the browser is idle: queries.ts).
const AppsView = lazy(() => VIEW_CHUNKS.apps().then((m) => ({ default: m.AppsView })));
const CostsView = lazy(() => VIEW_CHUNKS.costs().then((m) => ({ default: m.CostsView })));
const FlowView = lazy(() => VIEW_CHUNKS.flow().then((m) => ({ default: m.FlowView })));
const CrewView = lazy(() => VIEW_CHUNKS.agents().then((m) => ({ default: m.CrewView })));
const ModulesView = lazy(() => VIEW_CHUNKS.modules().then((m) => ({ default: m.ModulesView })));
const AgentPage = lazy(() => VIEW_CHUNKS.agentPage().then((m) => ({ default: m.AgentPage })));
const ModulePage = lazy(() => VIEW_CHUNKS.modulePage().then((m) => ({ default: m.ModulePage })));
const RunPage = lazy(() => VIEW_CHUNKS.run().then((m) => ({ default: m.RunPage })));
const ModuleView = lazy(() => VIEW_CHUNKS.moduleView().then((m) => ({ default: m.ModuleView })));
const SessionsView = lazy(() => VIEW_CHUNKS.sessions().then((m) => ({ default: m.SessionsView })));
const DesignView = lazy(() => VIEW_CHUNKS.design().then((m) => ({ default: m.DesignView })));
/** A page's place while its code arrives (rarely seen: it is warmed early). No spinner: the page paints in a moment. */
const PageLoading = () => <main className="page wide" aria-busy="true" />;

type Items = Record<Bucket, Card[]>;
type Route = { kind: "board" } | { kind: "chat"; ref: string | null } | { kind: "view"; view: View; /** A saved board (#/board?view=<id>). */ saved?: string; /** One approval card (#/approvals/<id>). */ card?: string } | { kind: "settings"; cat: Category | null } | { kind: "agent"; key: string; tab: AgentTab } | { kind: "module"; name: string; tab: ModuleTab } | { kind: "task"; ref: string; focus?: string } | { kind: "run"; id: string } | { kind: "brief" } | { kind: "help" } | { kind: "design" } | { kind: "app"; name: string } | { kind: "setup"; module: string; change?: boolean } | { kind: "page"; id: string; sub?: string } | { kind: "session"; ref: string; fresh?: boolean };

/** My day's Done column: cards shown before "Show more". */
const DONE_PAGE = 10;
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
  // An old #/connect/<id>[?error=…] link: that connection's Connect, on Settings > Connections (read raw: the message is encoded).
  const connect = /^#\/?connect\/([a-z0-9-]{1,63})(?:\?([\s\S]*))?$/.exec(location.hash);
  if (connect) {
    history.replaceState(null, "", `#/settings/connections?connect=${connect[1]}${connect[2] ? `&${connect[2]}` : ""}`);
    return { kind: "settings", cat: "connections" };
  }
  const h = hashPath();
  // #/t/PEN-12 opens a task; #/t/PEN-12/PEN-15 opens it on the agent working in PEN-15.
  if (h.startsWith("t/")) {
    const [ref = "", focus] = h.slice(2).split("/");
    return { kind: "task", ref, ...(focus ? { focus } : {}) };
  }
  // #/agents/<key>[/overview|activity|chats|handbook|settings] opens an agent's page. The old #/settings/agents lands on the Agents list.
  const agent = /^agents\/([a-z0-9-]+)(?:\/(overview|activity|chats|handbook|settings))?$/.exec(h);
  if (agent) return { kind: "agent", key: agent[1]!, tab: (agent[2] as AgentTab | undefined) ?? "overview" };
  if (h === "settings/agents") return { kind: "view", view: "agents" };
  // #/r/<run id> opens a run's trace.
  if (/^r\/(j-[0-9a-f]{16}|[0-9a-f-]{36})$/.test(h)) return { kind: "run", id: h.slice(2) };
  // #/c/ starts a new chat; #/c/WOR-12 opens that chat in the chat workspace.
  if (h === "c" || h.startsWith("c/")) return { kind: "chat", ref: h.slice(2).split("?")[0] || null };
  if (h === "settings/modules" || h === "modules") return { kind: "view", view: "modules" };
  // #/modules/<name>[/<tab>] opens a module's page.
  const mod = /^modules\/([a-z0-9-]+)(?:\/(overview|contents|settings|changes))?$/.exec(h);
  if (mod) return { kind: "module", name: mod[1]!, tab: (mod[2] as ModuleTab | undefined) ?? "overview" };
  // #/settings/<category> opens Settings there; the old tabs (#/connections, #/accounts) are categories now.
  if (h === "settings" || h.startsWith("settings/")) {
    const cat = h.slice("settings/".length).split("?")[0]!;
    return { kind: "settings", cat: isCategory(cat) ? cat : null };
  }
  if (h === "connections" || h === "accounts") return { kind: "settings", cat: h };
  // #/board?view=<id>: Tasks on a saved board (TaskTools.tsx); an unknown id falls back to All tasks.
  const saved = /^board\?view=([0-9a-f-]{36})$/.exec(h);
  if (saved) return { kind: "view", view: "board", saved: saved[1]! };
  // #/approvals/<k-id>: one card, decided here.
  const card = /^approvals\/(k-[0-9a-f]{16})$/.exec(h);
  if (card) return { kind: "view", view: "approvals", card: card[1]! };
  // #/approvals, #/costs, ...: deep links to a tab.
  // A tab link may carry the tab's own state after "?" (#/costs?range=7d).
  if ((VIEWS as string[]).includes(h.split("?")[0]!)) return { kind: "view", view: h.split("?")[0] as View };
  // #/reviews[/…]: the Reviews page is code review's module page now (links from before it moved).
  const rv = /^reviews(?:\/([\w/-]{1,100}))?$/.exec(h);
  if (rv) return { kind: "page", id: "code-review", ...(rv[1] ? { sub: rv[1] } : {}) };
  // #/flow/<tab> opens a Flow tab (Flow.tsx reads the tab itself).
  if (/^flow\/[a-z]+(\?.*)?$/.test(h)) return { kind: "view", view: "flow" };
  const setup = /^setup\/([a-z0-9-]{1,63})(\?change=1)?$/.exec(h);
  if (setup) return { kind: "setup", module: setup[1]!, ...(setup[2] ? { change: true } : {}) };
  if (h === "brief") return { kind: "brief" };
  if (h === "help") return { kind: "help" };
  if (h === "design") return { kind: "design" };
  // #/fleet/<id> opens a module's page (board.pages, ModuleView.tsx).
  const page = /^fleet\/([a-z][a-z0-9-]{0,30})(?:\/([\w/-]{1,100}))?$/.exec(h);
  if (page) return { kind: "page", id: page[1]!, ...(page[2] ? { sub: page[2] } : {}) };
  // #/sessions/<identifier> opens a session (Sessions.tsx); ?new=1 after Start, while the computer admits it.
  const ses = /^sessions\/([A-Za-z0-9-]{1,40})(\?new=1)?$/.exec(h);
  if (ses) return { kind: "session", ref: ses[1]!, ...(ses[2] ? { fresh: true } : {}) };
  // #/apps/<name> opens an app's page.
  const app = /^apps\/([a-z0-9-]+)$/.exec(h);
  if (app) return { kind: "app", name: app[1]! };
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

// "design" (#/design, the design system's catalogue) has no tab of its own; "fleet" is a module's page (#/fleet/<id>).
type View = "chat" | "agents" | "modules" | "approvals" | "board" | "sessions" | "apps" | "costs" | "flow" | "settings" | "design" | "fleet";
const VIEWS: View[] = ["chat", "agents", "modules", "approvals", "board", "sessions", "apps", "costs", "flow", "settings"];
const VIEW_KEY = "aidenhq.view";
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "connections" || v === "accounts") return "settings"; // tabs that moved into Settings
    return v && (VIEWS as string[]).includes(v) ? (v as View) : "chat";
  } catch {
    return "chat";
  }
};

interface Toast {
  id: number;
  text: string;
  /** Sliding out (shell.css .toast.leaving), removed a moment later. */
  leaving?: boolean;
  action?: { label: string; run: () => void };
}

/** A cached board from before Agent work (no `work`) waits for the first read instead of painting. */
const fresh = (b: Board | undefined) => (b && Array.isArray(b.work) ? b : undefined);
/** The board this device last saw (cache.ts), with its Slack hosts set for links. */
function cachedBoard(): Board | undefined {
  const b = fresh(peek<Board>("board")?.data);
  if (b) setSlackTeams(b.slackTeams ?? {});
  return b;
}

export function App() {
  // The device's last board (main.tsx adopted its account) paints at once; /api/board, already on its way, replaces it.
  const [board, setBoard] = useState<Board | null>(() => cachedBoard() ?? null);
  // Every view's state words read times in the board's timezone (ui/TaskState.tsx).
  setBoardTimezone(board?.timezone);
  const [session, setSession] = useState<Session | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [items, setItems] = useState<Items | null>(() => cachedBoard()?.buckets ?? null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route>(parseRoute);
  // The Approvals badge: what the page lists as waiting on the owner (his Tier 2 cards and the other tasks waiting on him).
  const [approvalsOpen, setApprovalsOpen] = useState(0);
  const [notifyAsk, setNotifyAsk] = useState(() => notificationsSupported() && Notification.permission === "default");
  const signInNeeded = useCallback(() => setNeedsSignIn(true), []);
  // Browser notifications and the Approvals count: what needs you, polled while the board is open.
  useEffect(
    () =>
      watchNeedsYou(
        () => api.needsYou().then((r) => (setApprovalsOpen(r.approvals + r.items.filter(onYouBeyondCards).length), { items: r.items.filter((i) => needsOwner(i.state)) })),
        (identifier) => go(`#/c/${identifier}`),
        (tick) => subscribe(["approvals", "chat", "tasks"], tick),
      ),
    [],
  );
  const [showDone, setShowDone] = useState(false);
  // My day's Done column pages its cards (a search can bring hundreds); a new query starts it over.
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const [showRecurring, setShowRecurring] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Bucket>("today");
  // A column's quick-add draft lives here, not in the column: leaving the board unmounts the columns, and the draft stays.
  const [drafts, setDrafts] = useState<Record<Bucket, string>>(() => ({ triage: "", today: "", tomorrow: "", later: "", backlog: "" }));
  const [view, setViewState] = useState<View>(savedView);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** When the board was last asked for (the timer below); opening Tasks asks again when that is over 10s ago. */
  const boardAt = useRef(Date.now());
  /** Shows view `v` (and `next`, the route that led there, in the same commit, so no in-between page is drawn). */
  const setView = useCallback((v: View, next?: Route) => {
    const commit = () => {
      if (next) setRoute(next);
      setViewState(v);
    };
    // A new page cross-fades in (the View Transitions API, where the browser has it; never with reduced motion).
    if (v !== viewRef.current && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      viewRef.current = v;
      document.startViewTransition(() => flushSync(commit));
    } else commit();
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [creating, setCreating] = useState(false);
  const mobile = useMedia("(max-width: 860px)");
  const [palette, setPalette] = useState(false);
  const closePalette = useCallback(() => setPalette(false), []);
  const newTask = useCallback(() => setCreating(true), []);
  // ⌘K / Ctrl K opens the palette from anywhere, typing included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const holdUntil = useRef(0); // ignore polls briefly after a local change, so cards don't jump back
  const itemsRef = useRef<Items | null>(null);
  itemsRef.current = items;
  const dragFrom = useRef<Bucket | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 160);
    }, action ? 7000 : 3500);
  }, []);
  // What Tasks shows: the layout, the filters (the search field is their text) and the saved boards (tabs once the session is confirmed).
  const tb = useTaskBoard({ ready: !!session?.account, routed: route.kind === "view" && route.view === "board" ? route.saved ?? null : undefined, toast, go });
  const query = tb.filters.text ?? "";
  const setQuery = (text: string) => tb.setFilters((f) => ({ ...f, text }));
  // The search field's answer (search.ts): the hits every filter's text term reads, and the closed hits Done shows.
  // My day shows only what its own Done would (the owner's and the crew's); Agent work shows every hit.
  const found = useTaskSearch(query, (c) => (tb.layout === "work" || c.mine !== false) && cardMatches(c, { ...tb.filters, text: "" }), view === "board", !tb.filters.state?.length || tb.filters.state.includes("done"));
  useEffect(() => setDoneShown(DONE_PAGE), [query]);
  const filtering = !isEmpty(tb.filters);
  const [saveOpen, setSaveOpen] = useState(0);

  const loaded = useRef(!!board); // a board is on hand (cached or read)
  const seq = useRef(0); // only the latest board request counts (an old 401 must not undo a sign-in)
  const refresh = useCallback(async (force = false) => {
    const n = ++seq.current;
    try {
      // The first call shares the boot preload; later ones (after a change) fetch again once any running one lands.
      const b = await load("board", api.board, true, n > 1);
      if (n !== seq.current) return;
      setSlackTeams(b.slackTeams ?? {});
      setBoard(b);
      loaded.current = true;
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
    const cached = admin ? fresh(peek<Board>("board")?.data) : undefined;
    if (!cached) return;
    setSlackTeams(cached.slackTeams ?? {});
    setBoard((b) => b ?? cached);
    setItems((i) => i ?? cached.buckets);
  }, [session]);

  // A stale answer's retry (cache.ts) lands in the cache, not through refresh(): paint it unless an edit is being held.
  useEffect(() => cacheSubscribe("board", () => {
    const b = fresh(peek<Board>("board")?.data);
    if (!b || (b as { stale?: unknown }).stale === true) return;
    setBoard(b);
    if (!dragFrom.current && Date.now() > holdUntil.current) setItems(b.buckets);
  }), []);
  // A sign-in finished (in the tab Connect opened): its banner goes at once.
  useEffect(() => subscribe(["connections"], () => void refresh()), [refresh]);
  useEffect(() => {
    if (view !== "board" || (loaded.current && Date.now() - boardAt.current < 10_000)) return;
    boardAt.current = Date.now();
    void refresh();
  }, [view, refresh]);

  useEffect(() => {
    load("session", api.session, false).then((s) => {
      // Back from signing in: open the page the link named (a card, a task) before the sign-in.
      try {
        const back = s.account ? sessionStorage.getItem(RETURN_KEY) : null;
        if (back) (sessionStorage.removeItem(RETURN_KEY), location.hash.length <= 2 && (location.hash = back));
      } catch {}
      setSession(s);
    }, () => {});
    // Tasks, or a first visit with nothing cached (the page waits for a board), needs the inventory now; any other landing paints the
    // cached board and reads it a few seconds later (its header only), so the page opened first gets the server.
    const first = landsOnBoard() || !loaded.current ? undefined : setTimeout(() => void refresh(true), 3_000);
    if (!first) void refresh(true);
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
      // A chat link opens the Chat tab; a tab link opens that tab.
      const v: View | null = r.kind === "chat" ? "chat" : r.kind === "view" ? r.view : r.kind === "agent" ? "agents" : r.kind === "module" ? "modules" : r.kind === "settings" ? "settings" : r.kind === "design" ? "design" : r.kind === "app" ? "apps" : r.kind === "page" ? "fleet" : r.kind === "session" ? "sessions" : null;
      if (v) setView(v, r);
      else setRoute(r);
    };
    hash();
    window.addEventListener("hashchange", hash);
    return () => {
      clearTimeout(first);
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

  /** Snooze: parked by its date (`parkBucket`) now, back on top of Today on `date`. Undo puts it back where it was. */
  async function snoozeCard(id: string, date: string) {
    const cur = itemsRef.current;
    const from = bucketOf(id);
    const park = parkBucket(todayIn(board!.timezone), date);
    if (cur && from) {
      const card = { ...cur[from].find((c) => c.id === id)!, scheduled: { date, bucket: "today" as Bucket }, carried: undefined };
      hold();
      setItems(from === park ? { ...cur, [park]: cur[park].map((c) => (c.id === id ? card : c)) } : { ...cur, [from]: cur[from].filter((c) => c.id !== id), [park]: [card, ...cur[park]] });
    }
    try {
      await api.schedule(id, { date, bucket: "today", park });
      toast(`Snoozed until ${dayDate(date)}`, from ? { label: "Undo", run: () => void api.move(id, from).then(() => refresh(true), (e) => toast(`Couldn't undo: ${(e as Error).message}`)) } : undefined);
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
        run: () => void api.update(card.id, { status: card.status === "in_progress" ? "in_progress" : "todo" }).then(() => refresh(true), (e) => toast(`Couldn't undo: ${(e as Error).message}`)),
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
    return Object.fromEntries(BUCKETS.map((b) => [b, applyFilters(items[b], tb.filters, found.hits)])) as Items;
  }, [items, tb.filters, found.hits]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (palette) return;
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
      if (e.key === "Escape") {
        if (creating) return setCreating(false);
        if (typing) return el.blur();
        if (route.kind !== "board" && route.kind !== "chat" && route.kind !== "view" && route.kind !== "agent" && route.kind !== "settings") return go("#/");
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
      if (k === "a") return go(view === "agents" ? "#/board" : "#/agents");
      // My day's own keys: Agent work binds none.
      if (view !== "board" || tb.layout !== "day") return;
      if (k === "d") return setShowDone((s) => !s);
      if (k === "r") return setShowRecurring((s) => !s);
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
  // Every hook runs before the early returns below (React needs the same hooks on every render).
  const appsQ = useQuery(QUERIES.apps, signInNeeded);
  const pagesQ = useQuery(QUERIES.pages, signInNeeded);
  const pages = pagesQ.data?.pages ?? [];
  // Sessions (the sessions module): its section shows only when the kernel lists the module, with the count working now.
  const sessionsQ = useQuery(QUERIES.sessions, signInNeeded);
  const sessions = sessionsQ.data?.enabled ? { live: sessionsQ.data.sessions.filter((x) => x.state === "running").length } : undefined;
  // An apply can add or remove a module's page while the board is open: Fleet reads them again each time it is opened.
  const inFleet = ["agents", "apps", "modules", "fleet"].includes(view);
  const reloadPages = pagesQ.reload;
  useEffect(() => void (inFleet && reloadPages()), [inFleet, reloadPages]);
  // Signed out, or an admin without an authenticator yet: both are done on the kernel's sign-in pages.
  if (session && !session.account) return <SignInScreen />;

  if (!board || !items || !filtered)
    return error ? (
      <div className="splash">Can't reach the board: {error}</div>
    ) : (
      <div className={`app boot${mobile ? " mobile" : ""}`} aria-busy="true" aria-label="Loading">
        {!mobile && <div className="topnav" />}
        <div className="app-main">{tb.layout === "work" && <AgentWorkLoading />}</div>
      </div>
    );

  const active = activeId ? BUCKETS.flatMap((b) => items[b]).find((c) => c.id === activeId) : undefined;
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, items[b].length])) as Record<Bucket, number>;
  const mergeTargets = BUCKETS.flatMap((b) => items[b]).filter((c) => c.assignee === "me" && !c.recurring);
  const openChat = (identifier: string) => go(`#/c/${identifier}`);
  // Every section has its own address, so the hash and the page never disagree (a click on the page already shown is a no-op).
  const nav = (v: NavView) => go(hrefOf(v));
  const panels = panelsOf(appsQ.data?.apps ?? [], keepsSecureCookies());
  const onBoard = view === "board";
  // A chat (or a settings category) open on a phone takes the whole screen (back arrow to the list).
  const chatFull = mobile && ((view === "chat" && route.kind === "chat") || (view === "settings" && route.kind === "settings" && route.cat !== null));
  const local = ["localhost", "127.0.0.1"].includes(location.hostname); // a tunnel to 3121: the loopback sign-ins work
  const signInConnect = local || !!session?.signInConnect;
  const connectionsOk = !board.google?.error && !board.google?.accounts.some((a) => a.state === "expired") && (board.signIns ?? []).map((s) => s.status).every((c) => !c || !c.configured || c.state !== "expired");
  const openCard = (c: Card) => {
    setSelected(c.id);
    go(`#/t/${c.identifier}`);
  };
  const work = tb.layout === "work";
  // The cards the filter menu counts over: the layout's own, unfiltered.
  const filterCards: Card[] = work ? board.work : [...BUCKETS.flatMap((b) => items[b]), ...board.recurring, ...board.done];
  // While a search is on, Done also holds the matching tasks closed before its 48 hours (the board doesn't hold those).
  // A search answer is in force (the first one for a query keeps the board as it was until it lands).
  const searching = !!query.trim() && found.hits !== undefined;
  const held = new Set([...board.work, ...board.done].map((c) => c.id));
  const older = searching ? found.done.filter((c) => !held.has(c.id)) : [];
  const workCards = applyFilters([...board.work, ...older], tb.filters, found.hits);
  const doneCards = applyFilters([...board.done, ...older.filter((c) => c.mine !== false && !c.recent)], tb.filters, found.hits);
  // My day's Done column: when asked for, or while a search answer has matches there.
  const doneColumn = showDone || (searching && (doneCards.length > 0 || found.hasMore));


  return (
    <div className={`app${mobile ? " mobile" : ""}${view === "chat" ? " on-chat" : ""}`}>
      {!mobile && (
        <TopNav
          view={view}
          approvals={approvalsOpen}
          agentsActive={board.agentsActive}
          onNav={nav}
          spend={board.spend}
          settingsAlert={!connectionsOk}
          notify={notifyAsk ? () => void askForNotifications().then(() => setNotifyAsk(false)) : undefined}
          brief={!!board.brief}
          onPalette={() => setPalette(true)}
          sessions={sessions}
        />
      )}
      <div className="app-row">
      {!mobile && <SubNav view={view} onNav={nav} panels={panels} pages={pages} page={route.kind === "page" ? route.id : undefined} go={go} />}
      <div className="app-main">
      {mobile && (
        <header className="topbar" hidden={chatFull}>
          <a className="brand" href="#/" onClick={() => setQuery("")}>
            <img src="/icon.png" alt="" />
          </a>
          {onBoard && <span className="topbar-title">Tasks</span>}
          <div className="topbar-tools">
            {onBoard && (
              <div className={`search${found.busy ? " busy" : ""}`}>
                <input ref={searchRef} type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
                {found.busy && <span className="search-busy" role="status" aria-label="Searching" />}
              </div>
            )}
            {onBoard && (
              <button className="btn primary" onClick={() => setCreating(true)} title="New task" aria-label="New task">
                <PlusIcon />
              </button>
            )}
            {board.spend && (
              <a className={`spend-today${board.spend.day.spent >= board.spend.day.cap || board.spend.month.spent >= board.spend.month.cap ? " over" : ""}`} href="#/costs" title={`Today's model spend against the day limit; $${board.spend.month.spent.toFixed(2)} of $${board.spend.month.cap} this month`}>
                ${board.spend.day.spent.toFixed(2)}
              </a>
            )}
            {board.brief && (
              <a className="btn" href="#/brief">
                Brief
              </a>
            )}
          </div>
        </header>
      )}
      {onBoard && work && <AttentionStrip onSignIn={signInNeeded} />}
      {!mobile && onBoard && (
        <header className="page-tools tt-tools">
          <div className="tt-row">
            <h1>Tasks</h1>
            <BoardTabs tb={tb} ready={!!session?.account} mobile={false} saveSignal={saveOpen} />
            <span className="spacer" />
            {work && <AsOf board={board} stale={!!error} />}
            <div className={`search${found.busy ? " busy" : ""}`}>
              <input ref={searchRef} type="search" placeholder="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
              {found.busy ? <span className="search-busy" role="status" aria-label="Searching" /> : <kbd>/</kbd>}
            </div>
            {!work && board.recurring.length > 0 && (
              <button className={`btn${showRecurring ? " on" : ""}`} aria-pressed={showRecurring} onClick={() => setShowRecurring(!showRecurring)} title="Recurring tasks (r)">
                Recurring
              </button>
            )}
            {!work && (
              <button className={`btn${showDone ? " on" : ""}`} aria-pressed={showDone} onClick={() => setShowDone(!showDone)} title="Recently done (d)">
                Done
              </button>
            )}
            <button className="btn primary" onClick={() => setCreating(true)} title="New task (c)">
              <PlusIcon /> New task
            </button>
          </div>
          <div className="tt-row tt-filters">
            <FilterChips tb={tb} board={board} cards={filterCards} />
            {found.note && <span className="search-note">{NOTE_TEXT[found.note]}</span>}
            <span className="spacer" />
            {work && (
              <span className="tt-group">
                Group by <Segmented label="Group by" value={tb.groupBy} onChange={tb.setGroupBy} options={[["none", "None"], ["agent", "Agent"]] as const} />
              </span>
            )}
            <SaveButton tb={tb} onSave={() => setSaveOpen((n) => n + 1)} />
          </div>
        </header>
      )}
      {mobile && onBoard && (
        <header className="tt-tools phone">
          <div className="tt-row">
            <BoardTabs tb={tb} ready={!!session?.account} mobile saveSignal={saveOpen} />
            {work && <AsOf board={board} stale={!!error} />}
          </div>
          <div className="tt-row">
            <FilterSheet tb={tb} board={board} cards={filterCards} />
            <SaveButton tb={tb} onSave={() => setSaveOpen((n) => n + 1)} />
          </div>
          {found.note && <p className="search-note">{NOTE_TEXT[found.note]}</p>}
        </header>
      )}
      {onBoard && <ConflictBanner tb={tb} onSaveNew={() => setSaveOpen((n) => n + 1)} />}

      {onBoard && !work && <AttentionStrip onSignIn={signInNeeded} />}

      {error && <div className="offline">Offline: {error}. Retrying…</div>}
      <GoogleBanner google={board.google} />
      <SignInBanners board={board} canConnect={signInConnect} />

      {onBoard && work && board.incomplete && <Banner tone="warn">Showing the newest 2,000 tasks.</Banner>}
      {mobile && onBoard && !work && (
        <nav className="bucket-tabs" aria-label="Buckets">
          {BUCKETS.map((b) => (
            <button key={b} aria-selected={b === tab} onClick={() => setTab(b)}>
              {BUCKET_NAMES[b]}
              {counts[b] > 0 && <span className="count">{counts[b]}</span>}
            </button>
          ))}
        </nav>
      )}

      <ErrorBoundary resetKey={`${view}:${JSON.stringify(route)}`}>
      {view === "chat" && <ChatWorkspace selected={route.kind === "chat" ? route.ref : null} composing={route.kind === "chat" && !route.ref} mobile={mobile} crew={board.assignees} prefix={board.prefix} go={go} onSignIn={signInNeeded} toast={toast} />}
      {view === "approvals" && <ApprovalsView open={openChat} onSignIn={signInNeeded} card={route.kind === "view" && route.view === "approvals" ? route.card : undefined} />}
      {view === "settings" && <SettingsView cat={route.kind === "settings" ? route.cat : null} mobile={mobile} session={session} go={go} onSignIn={signInNeeded} can={{ signIn: signInConnect }} />}
      {view === "modules" && route.kind !== "module" && <Suspense fallback={<PageLoading />}><ModulesView onSignIn={signInNeeded} can={{ signIn: signInConnect }} /></Suspense>}
      {view === "modules" && route.kind === "module" && <Suspense fallback={<PageLoading />}><ModulePage key={route.name} name={route.name} tab={route.tab} go={go} onSignIn={signInNeeded} can={{ signIn: signInConnect }} /></Suspense>}
      {view === "apps" && <Suspense fallback={<PageLoading />}><AppsView key={route.kind === "app" ? route.name : ""} app={route.kind === "app" ? route.name : undefined} onSignIn={signInNeeded} /></Suspense>}
      {view === "design" && <Suspense fallback={<PageLoading />}><DesignView /></Suspense>}
      {view === "fleet" && route.kind === "page" && <Suspense fallback={<PageLoading />}><ModuleView key={`${route.id}/${route.sub ?? ""}`} sub={route.sub} page={pages.find((p) => p.id === route.id)} onSignIn={signInNeeded} /></Suspense>}
      {view === "sessions" && <Suspense fallback={<PageLoading />}><SessionsView key={route.kind === "session" ? route.ref : ""} open={route.kind === "session" ? route.ref : undefined} fresh={route.kind === "session" && route.fresh} mobile={mobile} prefix={board.prefix} go={go} onSignIn={signInNeeded} onChanged={sessionsQ.reload} /></Suspense>}
      {view === "flow" && <Suspense fallback={<PageLoading />}><FlowView onSignIn={signInNeeded} /></Suspense>}
      {view === "costs" && <Suspense fallback={<PageLoading />}><CostsView onSignIn={signInNeeded} /></Suspense>}
      {view === "agents" && route.kind === "agent" && <Suspense fallback={<PageLoading />}><AgentPage key={route.key} agentKey={route.key} tab={route.tab} go={go} onSignIn={signInNeeded} /></Suspense>}
      {view === "agents" && route.kind !== "agent" && <Suspense fallback={<PageLoading />}><CrewView crew={board.assignees} onSignIn={signInNeeded} /></Suspense>}
      {view === "board" && work && <AgentWork board={board} cards={workCards} groupBy={tb.groupBy} mobile={mobile} filtered={filtering} searching={searching} moreDone={found.hasMore ? found.more : undefined} onClear={() => tb.setFilters({})} />}
      {view === "board" && !work && (
      <main className={`columns${doneColumn || showRecurring ? " extra" : ""}`}>
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setActiveId(null), (dragFrom.current = null), void refresh(true))}>
          {visibleBuckets.map((b) => (
            <Column
              key={b}
              bucket={b}
              cards={filtered[b]}
              total={counts[b]}
              board={board}
              selected={selected}
              dragDisabled={filtering}
              onOpen={openCard}
              onDone={markDone}
              onMove={(c, to) => void moveCard(c.id, to)}
              onSnooze={(c, date) => void snoozeCard(c.id, date)}
              onMerge={(c, into) => void mergeCard(c, into)}
              mergeTargets={mergeTargets}
              onAdd={(title) => addTask(title, b)}
              onCarried={b === "today" && !filtering ? (action) => void carriedAction(action) : undefined}
              addRef={b === "triage" ? addRef : undefined}
              draft={drafts[b]}
              onDraft={(title) => setDrafts((d) => (d[b] === title ? d : { ...d, [b]: title }))}
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
              {applyFilters(board.recurring, tb.filters, found.hits).map((c) => (
                <CardView key={c.id} card={c} assignees={board.assignees} onOpen={openCard} />
              ))}
              {!board.recurring.length && <p className="empty">Nothing repeats yet. Open a task and use Repeats.</p>}
            </div>
          </section>
        )}
        {doneColumn && (
          <section className="column column-done">
            <header className="col-head">
              <h2>Done</h2>
              <span className="count">{searching ? `${doneCards.length}${found.hasMore ? "+" : ""}` : board.done.length}</span>
              <span className="hint">{searching ? "Any time" : "Last 48 hours"}</span>
            </header>
            <div className="col-body">
              {doneCards.slice(0, doneShown).map((c) => (
                <CardView key={c.id} card={c} assignees={board.assignees} closed onOpen={openCard} />
              ))}
              {(doneCards.length > doneShown || (searching && found.hasMore)) && (
                <button type="button" className="more-done" onClick={() => { setDoneShown(doneShown + DONE_PAGE * 2); if (doneCards.length <= doneShown + DONE_PAGE * 2) found.more(); }}>
                  {doneCards.length > doneShown ? `Show ${doneCards.length - doneShown} more` : "Show more"}
                </button>
              )}
              {!board.done.length && !searching && <p className="empty">Nothing closed recently.</p>}
            </div>
          </section>
        )}
      </main>
      )}
      </ErrorBoundary>

      <ErrorBoundary resetKey={`overlay:${JSON.stringify(route)}`}>
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
              <button className="btn" onClick={() => void api.update(board.brief!.id, { status: "done" }).then(() => (go("#/"), refresh(true)), (e) => toast(`Couldn't update: ${(e as Error).message}`))}>
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
      {route.kind === "setup" && <SetupFlow key={route.module} module={route.module} change={route.change} onDone={() => go("#/")} onSignIn={signInNeeded} />}
      {creating && (
        <NewTask
          board={board}
          onClose={() => setCreating(false)}
          onCreated={(identifier, agent) => {
            setCreating(false);
            toast(agent ? `Added ${identifier} · ${agent} is on it` : `Added ${identifier} to Triage`);
            if (mobile) setTab("triage"), go("#/board");
            void refresh(true);
          }}
          toast={toast}
        />
      )}
      </ErrorBoundary>

      {mobile && !chatFull && route.kind !== "task" && <BottomBar sessions={!!sessions} view={view} approvals={approvalsOpen} agentsActive={board.agentsActive} onNav={nav} panels={panels} pages={pages} go={go} notify={notifyAsk ? () => void askForNotifications().then(() => setNotifyAsk(false)) : undefined} />}
      </div>
      </div>
      <Palette
        sessions={!!sessions}
        open={palette}
        onClose={closePalette}
        go={go}
        crew={board.assignees}
        apps={appsQ.data?.apps ?? []}
        onNewTask={newTask}
        tasks={[
          { id: "t-work", kind: "Go to", label: "Agent work", icon: "tasks", run: () => tb.select(null, tb.views, "work") },
          ...(tb.views ?? []).map((v) => ({ id: `t-${v.id}`, kind: "Board", label: v.name, icon: "tasks" as const, run: () => tb.select(v.id) })),
          ...(tb.views ? [{ id: "t-save", kind: "Action", label: "Save board", icon: "plus" as const, run: () => (go(tb.view ? `#/board?view=${tb.view.id}` : "#/board"), setSaveOpen((n) => n + 1)) }] : []),
        ]}
      />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.leaving ? " leaving" : ""}`} role="status">
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
  /** The quick-add draft, kept by the board so it survives this column unmounting. */
  draft: string;
  onDraft: (title: string) => void;
  timezone: string;
}

function Column({ bucket, cards, total, board, selected, dragDisabled, onOpen, onDone, onMove, onSnooze, onMerge, mergeTargets, onAdd, onCarried, addRef, draft, onDraft, timezone }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: bucket });
  const [adding, setAdding] = useState(bucket === "triage");
  const hint =
    bucket === "today"
      ? new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: timezone })
      : bucket === "tomorrow" && !board.rollsTomorrow
        ? `Rolls into Today on ${new Date(`${board.rollsOn}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}`
        : HINTS[bucket];
  const carried = onCarried ? cards.filter((c) => c.carried).length : 0;
  async function submit() {
    const t = draft.trim();
    if (!t) return;
    onDraft("");
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
            value={draft}
            placeholder={bucket === "triage" ? "Add a task…  c" : `Add to ${BUCKET_NAMES[bucket]}…`}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onDraft("");
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

/** "As of 10:42": the kernel snapshot the lanes show; after a failed read, how old that last good one is. */
function AsOf({ board, stale }: { board: Board; stale: boolean }) {
  if (!board.asOf) return null;
  const at = new Date(board.asOf).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <span className={`tt-asof${stale ? " stale" : ""}`} title="Every lane is one kernel snapshot">
      As of {at}
      {stale && `, ${ago(board.asOf) === "now" ? "just now" : `${ago(board.asOf)} ago`}`}
    </span>
  );
}

function Help() {
  const rows: [string, string][] = [
    ["⌘K", "Search and jump to any page, agent, chat or app"],
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
  const [created, setCreated] = useState<{ id: string; identifier: string } | null>(null); // locks the title once the task exists
  const crew = board.assignees.filter((a) => a.kind !== "me");
  const agent = crew.find((a) => a.key === pick);
  const name = agent?.name;
  async function create() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      // A retry after addAgent failed reuses the task already made.
      const task = created ?? (await api.create(t, "triage"));
      setCreated(task);
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
        <input className="new-title" autoFocus value={title} readOnly={busy || !!created} placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)} />
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

