#!/usr/bin/env node
// ui-review: the UI review engine. It captures, measures and asks the model with the prompts it ships; it decides nothing about
// taste. The contract is types.ts.

const COMMANDS: Record<string, string> = {
  capture: "capture <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--widths ..] [--themes ..] [--states ..] [--resume] [--baseline <dir>] [--commit sha] [--workers 4] [--palettes a,b] [--wait-text t] [--mode read|test-write|any] [--session state.json]",
  pages: "pages <url> --out <dir> [--map feature-map.json] [--pages-file f]",
  routes: "routes <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--baseline <dir>] [--mode read|test-write|any] [--session state.json]",
  refs: "refs <refs.json> --out <dir> [--measure]",
  review: "review <capture dir> [--model id] [--effort low|medium|high] [--taste file] [--refs refs.json] [--top 10] [--brand file] [--max-usd n (stops starting calls once reached)]",
  flows: "flows <capture dir> --out flows.md [--personas file]",
  bugs: "bugs <capture dir> [--model id]   (candidate bugs into candidates.json: leads, never reported)",
  repro: "repro <clicks.json> --out <dir> [--url u] [--session state.json] [--mode read|test-write|any] [--model id] [--max-usd n]",
  "fix-check": "fix-check <before.png> <after.png> --width <w> [--model id] [--taste file]",
  login: "login supplied --app <app> --out state.json | form --url <u> --user <u> --password-file <f> [--totp-file <f>] --out state.json | signup --url <u> --out state.json | aidenhq --app <app> --out state.json",
  browser: "browser start [--url u] [--mode read|test-write|any] [--session state.json] [--out dir] [--record dir]   (the signed-in, guarded Chrome the clicking pass attaches to: prints the CDP port; runs until SIGTERM; --record: a webm per flow)",
  "issue-body": "issue-body <dir> --app <app> --run-url <url> --run <id>   (the design issue and one per verified bug, as JSON: marker, title, body)",
  put: "put --run <id> <file>[=<name>]...   (files onto a design run: design_evidence_put, 8 MB per call, a recording alone)",
  get: "get --run <id> --out <dir> <name>...   (a design run's files: design_image)",
};

// Each subcommand is its module's `<name>Command(args)`, returning the exit code (loaded only when run).
const BUILT: Record<string, () => Promise<(args: string[]) => Promise<number>>> = {
  capture: async () => (await import("./capture.ts")).captureCommand,
  pages: async () => (await import("./pages.ts")).pagesCommand,
  routes: async () => (await import("./routes.ts")).routesCommand,
  refs: async () => (await import("./refs.ts")).refsCommand,
  review: async () => (await import("./review.ts")).reviewCommand,
  flows: async () => (await import("./flows.ts")).flowsCommand,
  bugs: async () => (await import("./bugs.ts")).bugsCommand,
  repro: async () => (await import("./repro.ts")).reproCommand,
  "fix-check": async () => (await import("./pairwise.ts")).fixCheckCommand,
  login: async () => (await import("./login.ts")).loginCommand,
  browser: async () => (await import("./browser.ts")).browserCommand,
  "issue-body": async () => (await import("./issue.ts")).issueBodyCommand,
  put: async () => (await import("./evidence.ts")).putCommand,
  get: async () => (await import("./evidence.ts")).getCommand,
};

function help(): string {
  return ["usage: ui-review <command> [options]", "", "commands:", ...Object.values(COMMANDS).map((c) => `  ${c}`), ""].join("\n");
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  process.stdout.write(help());
} else if (cmd in BUILT) {
  process.exitCode = await (await BUILT[cmd]())(rest);
  // Done (browser start returns only once stopped): a call still in flight (a sibling of a failed model call, a page's open socket) never keeps the command alive.
  setTimeout(() => process.exit(), 1000).unref();
} else {
  process.stderr.write(`ui-review: unknown command "${cmd}"\n\n${help()}`);
  process.exit(2);
}
