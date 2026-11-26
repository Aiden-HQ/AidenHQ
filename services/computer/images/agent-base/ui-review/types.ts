// The report contract. Every lane of the engine imports these types; the design service and the code-review ui.scan job read
// report.json as a `Report`. Change a type here first, then its users.

export type Theme = "light" | "dark";
export type State = "default" | "empty" | "error" | "loading";
export type PageKind = "dashboard" | "list" | "detail" | "form" | "settings" | "timeline" | "marketing" | "other";
export type Page = { path: string; shows?: string; kind?: PageKind; source: "feature-map" | "router" | "links" | "sitemap" };
export type QueueItem = { page: string; width: number; theme: Theme; state: State; status: "todo" | "done" | "failed" | "deferred"; tries: number; why?: string };
export type Capture = {
  page: string; width: number; theme: Theme; state: State; url: string; shots: string[]; settled: boolean;
  measures: Measures; motion?: Motion; rules: RuleHit[];
  diffs?: ShotDiff[]; // with --baseline: each shot against the baseline's shot of the same name
};
/** A shot against the baseline's (`pct` of its pixels differ); `compare` (before|after) and `diff` images only when it changed. */
export type ShotDiff = { shot: string; pct: number; compare?: string; diff?: string };
export type Measures = {
  fonts: { size: number; weight: number; n: number }[]; colours: { value: string; n: number }[]; radii: string[]; shadows: string[];
  spacing: { values: number[]; offScale: number[] }; // offScale: values not on the 4px scale
  nearMisses: { a: string; b: string; dx: number }[]; // left edges 1-3px apart
  content: { width: number; viewport: number }; // main content width vs viewport
  ctas: { label: string; filled: boolean; contrast: number; area: number }[];
  contrastFails: number; signatures: Record<"button" | "card" | "heading" | "input", string[]>;
};
export type Motion = {
  transitions: { property: string; duration: number; easing: string; n: number; examples: string[] }[];
  animations: { name: string; target: string; duration: number; easing: string; iterations: number; playState: string }[];
  hover: string[]; active: string[]; keyframes: { name: string; css: string }[]; longFrames: number[]; shifts: number[];
};
export type RuleHit = { rule: string; blocking: boolean; text: string };
export type Improvement = {
  rank: number; category: "polish" | "ease"; where: { page: string; width: number; theme: Theme; region: string };
  weak: string; change: string; why: string; best: string; captures: string[];
  fix?: { status: "shown" | "rejected" | "failed"; diff?: string; before?: string; after?: string; wins?: [number, number]; why?: string; collateral?: string[] };
};
export type MotionRow = { where: string; before: string; after: string; why: string; css: string };
export type Bug = { page: string; width: number; theme: Theme; title: string; evidence: string; captures: string[]; verified: boolean; repro?: string[] };
export type Report = {
  version: 2; target: string; commit?: string; frozenAt: string; model: string;
  coverage: { done: number; total: number; failed: number; deferred: number };
  captures: Capture[]; improvements: Improvement[]; motion: MotionRow[]; bugs: Bug[]; notes: string[]; cost_usd: number;
  blocking?: string[]; preexisting?: string[]; // the rule checks' blocking findings: this run's own, and those its baseline also had
  candidates?: string[]; // the route check's generic heuristics (a control that changed nothing, a link that shows the same page): to look at, never blocking
  blocked: Blocked[]; // requests the live-app guard refused (guard.ts); a socket's method is "WS"
  session?: { rung: "supplied" | "form" | "signup" | "aidenhq" | "patch"; relogins: number }; // a signed-in run: how it signed in, how often again
};
export type Blocked = { method: string; origin: string; path: string; page: string };
