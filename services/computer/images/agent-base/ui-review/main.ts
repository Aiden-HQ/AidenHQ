#!/usr/bin/env node
// ui-review: the UI review engine. It captures, measures and asks the model with the prompts it ships; it decides nothing about
// taste. The contract is types.ts.

const COMMANDS: Record<string, string> = {
  capture: "capture <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--widths ..] [--themes ..] [--states ..] [--resume] [--baseline <dir>] [--commit sha] [--workers 4] [--palettes a,b] [--wait-text t] [--mode read|test-write|any] [--session state.json]",
  pages: "pages <url> --out <dir> [--map feature-map.json] [--pages-file f]",
  routes: "routes <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--baseline <dir>] [--mode read|test-write|any] [--session state.json]",
  refs: "refs <refs.json> --out <dir> [--measure]",
  review: "review <capture dir> [--model id] [--effort low|medium|high] [--taste file] [--refs refs.json] [--top 10] [--brand file] [--max-usd n (stops starting calls once reached)]",
  "fix-check": "fix-check <before.png> <after.png> --width <w> [--model id] [--taste file]",
  login: "login supplied --app <app> --out state.json | form --url <u> --user <u> --password-file <f> [--totp-file <f>] --out state.json | signup --url <u> --out state.json",
  browser: "browser start [--url u] [--mode read|test-write|any] [--session state.json] [--out dir]   (prints the CDP port; runs until SIGTERM)",
};

// Each subcommand is its module's `<name>Command(args)`, returning the exit code (loaded only when run).
const BUILT: Record<string, () => Promise<(args: string[]) => Promise<number>>> = {
  capture: async () => (await import("./capture.ts")).captureCommand,
  pages: async () => (await import("./pages.ts")).pagesCommand,
  routes: async () => (await import("./routes.ts")).routesCommand,
  refs: async () => (await import("./refs.ts")).refsCommand,
  review: async () => (await import("./review.ts")).reviewCommand,
  "fix-check": async () => (await import("./pairwise.ts")).fixCheckCommand,
  login: async () => (await import("./login.ts")).loginCommand,
  browser: async () => (await import("./browser.ts")).browserCommand,
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
