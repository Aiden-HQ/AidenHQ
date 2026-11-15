// A launcher restart (a deploy) mid-turn: the turn runs on in its box and the plugin collects its result from the next launcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXEC_MISSING, EXEC_PREP_SCRIPT, EXEC_RUN_SCRIPT, EXEC_WAIT_SCRIPT } from "../lib.mjs";
import { execute } from "../plugin/client.js";

const sh = (script, args, input) => spawnSync("sh", ["-c", script, "sh", ...args], { input, encoding: "utf8" });

test("a detached exec keeps its stdin, output and exit code in the box; any waiter collects it; old ones are cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "aidenhq-exec-"));
  const dir = join(root, "e1");
  try {
    assert.equal(sh(EXEC_PREP_SCRIPT, [dir], "the prompt").status, 0);
    assert.equal(sh(EXEC_RUN_SCRIPT, [dir, "sh", "-c", 'cat; echo " done"; echo oops >&2; exit 3']).status, 0);
    // The old launcher's waiter (still alive in the box after a restart) and the new one's see the same result.
    for (const r of [sh(EXEC_WAIT_SCRIPT, [dir]), sh(EXEC_WAIT_SCRIPT, [dir])]) assert.deepEqual([r.status, r.stdout, r.stderr], [3, "the prompt done\n", "oops\n"]);
    // A later exec's prep clears folders finished over 10 minutes ago.
    utimesSync(join(dir, "code"), new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000));
    assert.equal(sh(EXEC_PREP_SCRIPT, [join(root, "e2")], "").status, 0);
    assert.ok(!existsSync(dir) && existsSync(join(root, "e2", "in")));
    const gone = sh(EXEC_WAIT_SCRIPT, [dir]);
    assert.equal(gone.status, 97);
    assert.match(gone.stderr, new RegExp(EXEC_MISSING));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A launcher on a fixed port; `handle(route, body, res)`. */
function launcher(port, handle) {
  const s = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", () => handle(req.url.slice(1), JSON.parse(b), res));
  });
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}
const close = (s) => new Promise((r) => { s.closeAllConnections(); s.close(r); });

test("the plugin rides out a launcher restart mid-turn and collects the turn's result; a short exec carries no execId", async () => {
  const seen = [];
  const old = await launcher(0, (route, body, res) => {
    seen.push([route, body.execId]);
    if (body.timeoutMs <= 60_000) return res.writeHead(200).end(JSON.stringify({ exitCode: 0, stdout: "short" }));
    res.writeHead(200, { "content-type": "application/json" });
    res.write(" "); // answerSlowly's keep-alive, then the launcher dies: the line drops, nothing listens until the new one
    setTimeout(() => { old.close(); res.socket.destroy(); }, 20);
  });
  const port = old.address().port;
  const c = { launcherUrl: `http://127.0.0.1:${port}`, token: "t" };
  let fresh;
  // The plugin's wait between tries: the new launcher comes up.
  const sleep = async () => {
    fresh ??= await launcher(port, (route, body, res) => {
      seen.push([route, body.execId, body.container]);
      res.writeHead(200).end(JSON.stringify({ exitCode: 0, stdout: "the turn" }));
    });
  };
  try {
    assert.deepEqual(await execute(c, { container: "box", command: "ls", timeoutMs: 15_000 }, { sleep }), { exitCode: 0, stdout: "short" });
    const out = await execute(c, { container: "box", command: "codex", timeoutMs: 3_600_000 }, { sleep });
    assert.deepEqual(out, { exitCode: 0, stdout: "the turn" });
    const [[, shortId], [r1, id], [r2, id2, box]] = seen;
    assert.equal(shortId, undefined);
    assert.deepEqual([r1, r2, box], ["exec", "attach", "box"]);
    assert.ok(id && id === id2);
  } finally {
    await close(old);
    if (fresh) await close(fresh);
  }
});

test("a box that is gone fails the exec at once, with the launcher's reason", async () => {
  let calls = 0;
  const s = await launcher(0, (route, body, res) => {
    calls++;
    res.writeHead(200).end(JSON.stringify({ error: `computer gone: ${body.container}`, status: 404 }));
  });
  try {
    const c = { launcherUrl: `http://127.0.0.1:${s.address().port}`, token: "t" };
    await assert.rejects(execute(c, { container: "box", command: "codex", timeoutMs: 3_600_000 }), /computer launcher exec: 404 computer gone: box/);
    assert.equal(calls, 1);
  } finally {
    await close(s);
  }
});
