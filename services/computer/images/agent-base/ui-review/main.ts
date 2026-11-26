#!/usr/bin/env node
// ui-review: the UI review engine. It captures, measures and asks the model with the prompts it ships; it decides nothing about
// taste. Each subcommand is built by its own lane (a stub exits 2 "not built yet" until then). The contract is types.ts.

const COMMANDS: Record<string, string> = {
  capture: "capture <url> --out <dir> [--pages-file f] [--widths ..] [--themes ..] [--states ..] [--resume] [--baseline <dir>] [--commit sha] [--workers 4]",
  pages: "pages <url> --out <dir> [--map feature-map.json] [--pages-file f]",
  routes: "routes <url> --out <dir>                      (route check: clicks, a local build only)",
  refs: "refs <refs.json> --out <dir>",
  review: "review <dir> [--model id] [--taste file] [--refs refs.json] [--top 10] [--brand file] [--max-usd n (a soft limit: stops starting calls once reached)]",
  "fix-check": "fix-check <before.png> <after.png> --width <w> [--model id] [--taste file]",
};

function help(): string {
  return ["usage: ui-review <command> [options]", "", "commands:", ...Object.values(COMMANDS).map((c) => `  ${c}`), ""].join("\n");
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  process.stdout.write(help());
} else if (cmd === "review" || cmd === "fix-check") {
  const { parseArgs } = await import("node:util");
  const { readFileSync } = await import("node:fs");
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: { model: { type: "string" }, taste: { type: "string" }, refs: { type: "string" }, top: { type: "string" }, brand: { type: "string" }, "max-usd": { type: "string" }, width: { type: "string" } },
  });
  try {
    const { DEFAULT_MODEL, runReview } = await import("./review.ts");
    if (cmd === "review") {
      if (!positionals[0]) throw new Error(`usage: ui-review ${COMMANDS.review}`);
      const r = await runReview(positionals[0], { model: values.model, taste: values.taste, refs: values.refs, brand: values.brand, top: values.top ? Number(values.top) : undefined, maxUsd: values["max-usd"] ? Number(values["max-usd"]) : undefined });
      process.stdout.write(`${r.improvements.length} improvements, ${r.motion.length} motion rows, $${r.cost_usd.toFixed(2)}: ${positionals[0]}/report.md\n`);
    } else {
      if (positionals.length !== 2 || !values.width) throw new Error(`usage: ui-review ${COMMANDS["fix-check"]}`);
      const { fixCheck } = await import("./pairwise.ts");
      process.stdout.write(JSON.stringify(await fixCheck({ before: positionals[0], after: positionals[1], width: Number(values.width), model: values.model ?? DEFAULT_MODEL, taste: values.taste ? readFileSync(values.taste, "utf8").trim() : undefined })) + "\n");
    }
  } catch (e) {
    process.stderr.write(`ui-review ${cmd}: ${(e as Error).message}\n`);
    process.exit(1);
  }
} else if (cmd in COMMANDS) {
  void rest;
  process.stderr.write(`ui-review ${cmd}: not built yet\n`);
  process.exit(2);
} else {
  process.stderr.write(`ui-review: unknown command "${cmd}"\n\n${help()}`);
  process.exit(2);
}
