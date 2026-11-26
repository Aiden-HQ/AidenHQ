#!/usr/bin/env node
// ui-review: the UI review engine. It captures, measures and asks the model with the prompts it ships; it decides nothing about
// taste. Each subcommand is built by its own lane (a stub exits 2 "not built yet" until then). The contract is types.ts.

const COMMANDS: Record<string, string> = {
  capture: "capture <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--widths ..] [--themes ..] [--states ..] [--resume] [--baseline <dir>] [--commit sha] [--workers 4] [--palettes a,b] [--wait-text t]",
  pages: "pages <url> --out <dir> [--map feature-map.json] [--pages-file f]",
  routes: "routes <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--baseline <dir>]   (clicks: a local build only)",
  refs: "refs <refs.json> --out <dir>",
  review: "review <run dir> [--model id]",
  "fix-check": "fix-check <run dir> --before <dir> --after <dir>",
};

// The built subcommands, each its module's `<name>Command(args)` returning the exit code (loaded only when run).
const BUILT: Record<string, () => Promise<(args: string[]) => Promise<number>>> = {
  capture: async () => (await import("./capture.ts")).captureCommand,
  pages: async () => (await import("./pages.ts")).pagesCommand,
  routes: async () => (await import("./routes.ts")).routesCommand,
};

function help(): string {
  return ["usage: ui-review <command> [options]", "", "commands:", ...Object.values(COMMANDS).map((c) => `  ${c}`), ""].join("\n");
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  process.stdout.write(help());
} else if (cmd in BUILT) {
  process.exitCode = await (await BUILT[cmd]())(rest);
} else if (cmd in COMMANDS) {
  process.stderr.write(`ui-review ${cmd}: not built yet\n`);
  process.exit(2);
} else {
  process.stderr.write(`ui-review: unknown command "${cmd}"\n\n${help()}`);
  process.exit(2);
}
