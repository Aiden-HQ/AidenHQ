#!/usr/bin/env node
// AidenHQ runner: turns your comments on Paperclip tasks labelled "engineer" into
// coding jobs (an engine module on engine@1) in runner-owned git worktrees on this machine.
import { cfg, log } from "./main/context.ts";
import "./main/poll.ts";
import { adoptRuns, loop, reportActivity, saveMetrics, shutdown } from "./main/unsplit.ts";

// ------------------------------------------------------------------ main

log("runner started", { config: cfg.file, label: cfg.label, orgs: cfg.allowed_orgs, poll_seconds: cfg.poll_seconds });
// systemd's stop or restart (KillMode=process: the runs aren't signalled), well inside its 90s stop timeout.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => void shutdown(0, 60_000));
// SIGUSR2 (apply-config, after a deploy): the same, with longer for an apply in flight, and exit code 75 so systemd's
// Restart=on-failure starts the new code.
process.on("SIGUSR2", () => void shutdown(75, 10 * 60_000));
adoptRuns();
void loop();
// The board's Agents view: on a timer, because a poll can take minutes (intake, GitHub checks).
reportActivity();
setInterval(reportActivity, 30_000);
setInterval(saveMetrics, 30_000).unref();
