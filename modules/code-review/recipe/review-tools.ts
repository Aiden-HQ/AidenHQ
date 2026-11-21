#!/usr/bin/env node
// The code reviewer's only tools (the `code-review` job runs codex with its shell off): a stdio MCP server that reads the
// PR's tree and its git history, and nothing else. No tool runs the PR's code, writes a file or opens a connection, so the
// review needs no sandbox (the CI container can't give codex one: no user namespaces) and a PR can't use the reviewer to
// change its own verdict. Every path stays inside the checkout; git runs with fixed arguments, no pager, external diff or
// textconv. TypeScript navigation (definition, references, diagnostics) comes from a pinned typescript-language-server
// when REVIEW_LSP names it (the workflow installs it): no dependencies of the PR are installed, nothing is fetched (type
// acquisition off) and no tsserver plugin can load (refused when the PR tracks any node_modules/). Node 22+.
//   node review-tools.ts <checkout> <base sha>
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Git = (...args: string[]) => string;
type Args = Record<string, any>; // the model's JSON arguments: each tool reads what it declares in its schema
interface Tool { description: string; schema: Record<string, unknown>; required?: string[]; run: (a: Args) => string | Promise<string> }
interface Pos { line: number }
interface Range { start: Pos }
interface Loc { uri?: string; targetUri?: string; range?: Range; targetRange?: Range }
interface Diag { range: Range; message: string }
interface Rpc { id?: number; method?: string; params?: { uri: string; diagnostics: Diag[] }; error?: { message: string }; result?: unknown }
interface Lsp { request: (method: string, params: unknown) => Promise<Loc | Loc[] | null | undefined>; open: (rel: string) => Promise<string>; diags: Map<string, Diag[]> }
interface Msg { id?: number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Args } }

const MAX = 100_000; // characters one tool answer carries (about 25k tokens); a longer one is paged (`from`), never cut

/**
 * One page of a tool's answer: its lines from `from` (1-based) up to MAX characters, naming where the next page starts. A line
 * longer than MAX counts as several lines of MAX characters each, so every character of any answer is a page away.
 */
export function page(text: string, from: unknown = 1) {
  const lines = text.split("\n").flatMap((l) => (l.length > MAX ? l.match(new RegExp(`[^]{1,${MAX}}`, "g"))! : [l]));
  const start = Math.min(Math.max(1, Math.floor(Number(from)) || 1), lines.length);
  const out: string[] = [];
  let size = 0, i = start - 1;
  for (; i < lines.length && (!out.length || size + lines[i]!.length + 1 <= MAX); i++) (out.push(lines[i]!), (size += lines[i]!.length + 1));
  return i < lines.length ? `${out.join("\n")}\n[answer lines ${start}-${i} of ${lines.length} (a line over ${MAX} characters counts as several): call again with from: ${i + 1} for the rest]` : out.join("\n");
}

/**
 * What is wrong with a tool call's arguments against its declared schema (and `from`), or undefined: a wrong type is refused
 * before the tool runs, so the tool and code's record of what it read take the same value.
 */
export function argsProblem(tool: { schema: Record<string, unknown>; required?: string[] } | undefined, args: Record<string, unknown>) {
  if (!tool) return "no such tool";
  const props: Record<string, unknown> = { ...tool.schema, from: { type: "integer" } };
  for (const [k, v] of Object.entries(args ?? {})) {
    const type = (props[k] as { type?: string } | undefined)?.type;
    if (!type) return `no argument ${k}`;
    if (!(type === "integer" ? Number.isInteger(v) : type === "boolean" ? typeof v === "boolean" : typeof v === type)) return `${k} must be ${type === "integer" ? "an integer" : `a ${type}`}`;
  }
  const missing = (tool.required ?? []).find((k) => args?.[k] === undefined);
  return missing ? `${missing} is required` : undefined;
}

/** The tools, bound to one checkout and the PR's base commit. Each returns text; a bad argument throws. */
export function tools(root: string, base: string): Record<string, Tool> {
  root = realpathSync(root);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("base must be a full commit sha");
  // A path inside the checkout, never under .git, symlinks resolved (a link out of the tree is refused).
  const inside = (p: unknown = ".") => {
    const abs = resolve(root, String(p));
    const real = realpathSync(abs);
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split("/").includes(".git")) throw new Error(`${p} is outside the repository`);
    return rel || ".";
  };
  // No system or global git config (a home-directory .gitconfig could name a pager, fsmonitor or diff program): only the
  // checkout's own .git/config, which actions/checkout wrote and the PR can't change.
  // Pathspecs are literal: a file the PR names `:(glob)*` or `:!x` is that file, never a pattern.
  const env = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
  const git: Git = (...args) => (execFileSync("git", ["--no-pager", ...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, env }));
  const str = { type: "string" };
  return {
    diff: {
      description: `The PR's changes: git diff from its base (${base.slice(0, 12)}, the merge base) to the checked-out head, for the whole tree or one path. stat: true lists changed files with line counts instead.`,
      schema: { path: str, stat: { type: "boolean" } },
      run: ({ path, stat }) => git("diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(stat === true ? ["--stat=200"] : []), `${base}...HEAD`, "--", inside(path)),
    },
    log: {
      description: "The PR's commits since its base, with their messages.",
      schema: {},
      run: () => git("log", "--no-color", "--format=%h %an%n%B", `${base}..HEAD`),
    },
    read_file: {
      description: "A file of the PR's head, with line numbers; start and end (1-based, inclusive) for a range.",
      schema: { path: str, start: { type: "integer" }, end: { type: "integer" } },
      required: ["path"],
      run: ({ path, start = 1, end }) => {
        const rel = inside(path);
        if (statSync(resolve(root, rel)).isDirectory()) throw new Error(`${path} is a directory: use list_files`);
        // A binary file isn't text to review (git diff shows it as "Binary files differ").
        if (readFileSync(resolve(root, rel)).subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file`);
        const lines = readFileSync(resolve(root, rel), "utf8").replace(/\n$/, "").split("\n");
        const from = Math.max(1, Number(start) || 1), to = Math.min(lines.length, Number(end) || lines.length);
        return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join("\n");
      },
    },
    blame: {
      description: "Who last changed each line of a file at the PR's head (git blame), for a line range (start, end).",
      schema: { path: str, start: { type: "integer" }, end: { type: "integer" } },
      required: ["path"],
      run: ({ path, start, end }) => git("blame", "--no-progress", ...(start ? [`-L${Number(start)},${Number(end) || ""}`] : []), "HEAD", "--", inside(path)),
    },
    show: {
      description: "One commit of the repository's history by its sha (as log or blame print it): its message and patch, or with path, that file as it was at the commit.",
      schema: { sha: str, path: str },
      required: ["sha"],
      run: ({ sha, path }) => {
        if (!/^[0-9a-f]{7,40}$/.test(String(sha))) throw new Error("sha: a commit sha (7-40 hex characters)");
        return path ? git("show", `${sha}:${String(path).replace(/^\/+/, "")}`) : git("show", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", "--patch", sha);
      },
    },
    list_files: {
      description: "The tracked files under a directory of the PR's head (the whole repository by default).",
      schema: { path: str },
      run: ({ path }) => git("ls-files", "--", inside(path)),
    },
    search: {
      description: "Lines matching a regular expression (extended, case-sensitive unless ignore_case) in the PR's head, with line numbers; optionally under one path.",
      schema: { pattern: str, path: str, ignore_case: { type: "boolean" } },
      required: ["pattern"],
      run: ({ pattern, path, ignore_case }) => {
        try { return git("grep", "-n", "-I", "-E", "--no-color", ...(ignore_case ? ["-i"] : []), "-e", String(pattern), "--", inside(path)); }
        catch (e) { if ((e as { status?: number }).status === 1) return "no matches"; throw e; }
      },
    },
    ...(process.env.REVIEW_LSP ? lspTools(root, inside, git) : {}),
  };
}

/** definition, references, diagnostics for TypeScript and JavaScript, from typescript-language-server (REVIEW_LSP). */
function lspTools(root: string, inside: (p?: unknown) => string, git: Git): Record<string, Tool> {
  let lsp: Lsp | undefined;
  const start = () => {
    if (git("ls-files").split("\n").some((f) => f.split("/").includes("node_modules"))) throw new Error("the PR tracks a node_modules/ directory: no TypeScript navigation (a tsserver plugin could load from it)");
    const child = spawn(process.env.REVIEW_LSP!, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: "/nonexistent" } });
    let buf = Buffer.alloc(0), id = 0;
    const waiting = new Map<number, (m: Rpc) => void>(), diags = new Map<string, Diag[]>();
    child.stdout.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const h = buf.indexOf("\r\n\r\n");
        if (h < 0) return;
        const n = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())?.[1]);
        if (buf.length < h + 4 + n) return;
        const m = JSON.parse(buf.subarray(h + 4, h + 4 + n).toString());
        buf = buf.subarray(h + 4 + n);
        if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
        else if (m.method === "textDocument/publishDiagnostics") diags.set(m.params.uri, m.params.diagnostics);
        else if (m.id !== undefined && m.method) send({ id: m.id, result: null }); // a server request (configuration, progress)
      }
    });
    const send = (m: Record<string, unknown>) => { const b = JSON.stringify({ jsonrpc: "2.0", ...m }); child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); };
    const request = (method: string, params: unknown) => new Promise<Loc | Loc[] | null | undefined>((ok, fail) => {
      const i = ++id;
      const t = setTimeout(() => { waiting.delete(i); fail(new Error(`${method} timed out`)); }, 60_000);
      waiting.set(i, (m: Rpc) => { clearTimeout(t); m.error ? fail(new Error(m.error.message)) : ok(m.result as Loc | Loc[] | null | undefined); });
      send({ id: i, method, params });
    });
    const tsserver = join(dirname(realpathSync(process.env.REVIEW_LSP!)), "..", "..", "typescript", "lib", "tsserver.js");
    const ready = request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { publishDiagnostics: {} } }, initializationOptions: { tsserver: { path: tsserver }, disableAutomaticTypingAcquisition: true, plugins: [] } })
      .then(() => send({ method: "initialized", params: {} }));
    const opened = new Set();
    const open = async (rel: string) => {
      await ready;
      const uri = pathToFileURL(resolve(root, rel)).href;
      if (!opened.has(uri)) {
        opened.add(uri);
        send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: /\.[mc]?tsx?$/.test(rel) ? "typescript" : "javascript", version: 1, text: readFileSync(resolve(root, rel), "utf8") } } });
        // The project is loaded once the file's diagnostics arrive (the semantic ones a moment after the syntactic ones).
        for (let i = 0; i < 150 && !diags.has(uri); i++) await new Promise((ok) => setTimeout(ok, 200));
        await new Promise((ok) => setTimeout(ok, 3000));
      }
      return uri;
    };
    lsp = { request, open, diags };
    return lsp;
  };
  const at = async ({ path, line, symbol }: Args) => {
    const rel = inside(path);
    const text = readFileSync(resolve(root, rel), "utf8").split("\n")[Number(line) - 1] ?? "";
    const character = text.search(new RegExp(`\\b${String(symbol).replace(/[^\w$]/g, "")}\\b`));
    if (character < 0) throw new Error(`${symbol} isn't on line ${line} of ${path}`);
    const l = lsp ?? start();
    return { textDocument: { uri: await l.open(rel) }, position: { line: Number(line) - 1, character } };
  };
  const where = (locs: Loc | Loc[] | null | undefined) => [locs ?? []].flat().map((x) => `${relative(root, fileURLToPath((x.uri ?? x.targetUri)!))}:${(x.range ?? x.targetRange)!.start.line + 1}`).join("\n") || "none found";
  const pos = { path: { type: "string" }, line: { type: "integer" }, symbol: { type: "string" } };
  return {
    definition: { description: "Where a TypeScript/JavaScript symbol on a line of the PR's head is defined (language server).", schema: pos, required: ["path", "line", "symbol"], run: async (a: Args) => where(await (lsp ?? start()).request("textDocument/definition", await at(a))) },
    references: { description: "Every reference to a TypeScript/JavaScript symbol on a line of the PR's head (language server).", schema: pos, required: ["path", "line", "symbol"], run: async (a: Args) => (where(await (lsp ?? start()).request("textDocument/references", { ...(await at(a)), context: { includeDeclaration: false } }))) },
    diagnostics: {
      description: "TypeScript's errors for one file of the PR's head (language server; the PR's dependencies aren't installed, so unresolved packages are expected).",
      schema: { path: { type: "string" } }, required: ["path"],
      run: async ({ path }: Args) => {
        const l = lsp ?? start(), uri = await l.open(inside(path));
        return (l.diags.get(uri) ?? []).map((d: Diag) => `${d.range.start.line + 1}: ${d.message}`).join("\n") || "no errors";
      },
    },
  };
}

/** Serves `tools` over MCP (newline-delimited JSON-RPC on stdin/stdout). */
export function serve(t: Record<string, Tool>, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  const send = (msg: Record<string, unknown>) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  createInterface({ input }).on("line", (line) => {
    let m: Msg;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return; // notifications
    const ok = (result: unknown) => send({ id: m.id, result });
    if (m.method === "initialize") return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "repo", version: "1" } });
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list") {
      // Every answer is paged: `from` asks for the page that starts at that line of it.
      const from = { from: { type: "integer", description: `the answer's line to start at, for an answer over ${MAX} characters (it names the next page's line)` } };
      return ok({ tools: Object.entries(t).map(([name, d]) => ({ name, description: d.description, inputSchema: { type: "object", properties: { ...d.schema, ...from }, ...(d.required ? { required: d.required } : {}) }, annotations: { readOnlyHint: true, openWorldHint: false } })) });
    }
    if (m.method === "tools/call") {
      const d = t[m.params?.name!];
      const bad = d && argsProblem(d, m.params?.arguments ?? {});
      if (bad) return ok({ content: [{ type: "text", text: `bad arguments: ${bad}` }], isError: true });
      if (!d) return send({ id: m.id, error: { code: -32602, message: `no tool ${m.params?.name}` } });
      return Promise.resolve().then(() => d.run(m.params!.arguments ?? {})).then(
        (text) => ok({ content: [{ type: "text", text: page(text, m.params!.arguments?.from) }], isError: false }),
        (e) => ok({ content: [{ type: "text", text: String(e.stderr || e.message).slice(0, 2000) }], isError: true }));
    }
    send({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) serve(tools(process.argv[2]!, process.argv[3]!));
