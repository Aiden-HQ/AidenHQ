// Sharing a local module (docs/design/sharing.md): its portable content at one instance commit, exactly what a publish
// sends. Only what a local module may hold leaves: module.yaml, its agents' AGENTS.md and skills/ (regular blobs read from
// git at that commit, never the working tree). Memory, the owner profile, secrets and setting values never leave: they are
// not module files, and the scan below is only a backstop for prose that copied one of them in. The preview shows the
// result; the owner's save is bound to its digest (github's share.ts digestOf, the code host computes it the same way).
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { digestOf } from "../../modules/github/service/src/share.ts";
import { SECRET_SHAPES } from "./memory.ts";

type Dict = Record<string, any>;
export type Finding = { file: string; rule: "secret-value" | "setting-value" | "memory-fact" | "profile-fact" | "secret-shaped" | "local-reference" | "symlink" | "too-big"; detail: string };
export type Export = { module: string; source: string; files: Record<string, string>; notShared: { path: string; why: string }[]; findings: Finding[]; isolation: "trusted" | "untrusted"; scripts: string[]; grants: Record<string, string[]>; digest: string };
export type ExportDeps = {
  /** The kernel's checkout of the instance repo, and the commit exported. */
  instanceDir: string; sha: string;
  /** config/modules.json and config/paperclip.yaml as compiled. */
  catalog: Dict[]; compiled: Dict;
  /** The instance's own setting values (set in instance.yaml), the vault's secret values, every agent's memory facts and the owner profile. */
  settings: Record<string, unknown>; secrets: string[]; memory: string[]; profile: string;
  /** The instance repo (owner/name): a reference to it is local. */
  instanceRepo?: string;
};
export class ShareRefused extends Error { status = 422; }

const MAX_FILES = 100, MAX_BYTES = 512 * 1024;
/** A skill file's path, as a publish may write it (modules/github/schemas/publish_module.json). */
const SKILL_PATH = /^skills\/[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;

const git = (dir: string, args: string[]) => new Promise<Buffer>((ok, no) => execFile("git", ["-C", dir, ...args], { encoding: "buffer", maxBuffer: 64 << 20, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } }, (e, out) => (e ? no(e) : ok(out))));

/** A value as it may be written down: plain, base64 and URL-encoded. */
const forms = (v: string) => [v, Buffer.from(v).toString("base64").replace(/=+$/, ""), encodeURIComponent(v)];
/** Every scalar of a setting's value, as text. */
const scalars = (v: unknown): string[] => (v === null || v === undefined ? [] : typeof v === "object" ? Object.values(v as Dict).flatMap(scalars) : [String(v)]);

/** The portable content of local module `name` at `d.sha`, with what isn't shared and why, and the scan's findings. */
export async function exportModule(name: string, d: ExportDeps): Promise<Export> {
  const entry = d.catalog.find((m) => m.name === name);
  if (entry?.tier !== "local") throw new ShareRefused(`${name} isn't a local module: only the instance's own modules are shared`);
  const prefix = `modules/${name}/`;
  const listed = (await git(d.instanceDir, ["ls-tree", "-r", "-z", "--full-tree", d.sha, "--", prefix])).toString("utf8").split("\0").filter(Boolean);
  const findings: Finding[] = [];
  const notShared: { path: string; why: string }[] = [];
  const blobs = new Map<string, string>();
  for (const line of listed) {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, type, oid] = meta.split(" ");
    const rel = path.slice(prefix.length);
    if (mode === "120000") { findings.push({ file: rel, rule: "symlink", detail: "a symlink: share the file itself" }); continue; }
    if (type !== "blob") { notShared.push({ path: rel, why: "not a regular file" }); continue; }
    blobs.set(rel, oid!);
  }
  const yamlText = blobs.has("module.yaml") ? (await git(d.instanceDir, ["cat-file", "blob", blobs.get("module.yaml")!])).toString("utf8") : undefined;
  if (yamlText === undefined) throw new ShareRefused(`modules/${name} has no module.yaml at ${d.sha.slice(0, 12)}`);
  const doc = YAML.parseDocument(yamlText);
  const def: Dict = doc.toJS() ?? {};
  const agents = Object.keys(def.agents ?? {});

  // module.yaml as written, but for what only makes sense on this instance.
  for (const k of agents) {
    if (def.agents[k]?.reports_to != null) (doc.deleteIn(["agents", k, "reports_to"]), notShared.push({ path: `module.yaml agents.${k}.reports_to`, why: "it names an agent on this instance; the importer sets the reporting line" }));
    if (def.agents[k]?.image != null) (doc.deleteIn(["agents", k, "image"]), notShared.push({ path: `module.yaml agents.${k}.image`, why: "an agent computer is this instance's" }));
  }
  // A skill from another of this instance's local modules (library.<name>) isn't in the share: an importer couldn't compile it.
  const localModules = d.catalog.filter((m) => m.tier === "local" && m.name !== name).map((m) => String(m.name));
  for (const k of agents) for (const sk of [def.agents[k]?.skills ?? []].flat().map(String)) {
    if (localModules.includes(sk.split(".")[0]!)) findings.push({ file: "module.yaml", rule: "local-reference", detail: `agent ${k} uses skill ${sk}, from this instance's ${sk.split(".")[0]} module: share that skill inside this module, or drop it` });
  }
  for (const [key, r] of Object.entries<Dict>(def.routines ?? {})) {
    const why = !agents.includes(r?.agent) ? `it runs as ${String(r?.agent)}, who isn't in this module` : r?.event?.resource != null ? "it watches a channel or repo of this instance" : undefined;
    if (why) (doc.deleteIn(["routines", key]), notShared.push({ path: `module.yaml routines.${key}`, why }));
  }
  if (doc.get("routines") && !Object.keys(doc.toJS().routines ?? {}).length) doc.delete("routines");

  // Each agent's effective grants as compiled, and whether any writes: an importer runs the module trusted only when it says so.
  const grants = Object.fromEntries(agents.map((k) => [k, Object.entries<string[]>(d.compiled.agents?.[k]?.enabled_tools ?? {}).flatMap(([c, ts]) => ts.map((t) => `${c}.${t}`)).sort()]));
  // A write as the compiler counts one for an untrusted module (scripts/modules.ts): write and destructive tools, and self_change.
  const writes = Object.values(grants).flat().some((ct) => {
    const [c, t] = ct.split(".") as [string, string];
    const tools = d.compiled.mcp_servers?.[c]?.tools ?? {};
    return [...(tools.write ?? []), ...(tools.destructive ?? [])].includes(t) || ct === "paperclip_tasks.self_change";
  });

  const files: Record<string, string> = {};
  for (const [rel, oid] of blobs) {
    if (rel === "module.yaml") continue;
    const handbook = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(rel);
    if (!(handbook && agents.includes(handbook[1]!)) && !SKILL_PATH.test(rel)) { notShared.push({ path: rel, why: "a local module shares only module.yaml, its agents' AGENTS.md and skills/" }); continue; }
    const buf = await git(d.instanceDir, ["cat-file", "blob", oid]);
    if (buf.includes(0)) { notShared.push({ path: rel, why: "a binary file" }); continue; }
    files[rel] = buf.toString("utf8");
  }
  const scripts = Object.keys(files).filter((p) => p.startsWith("skills/") && !p.endsWith(".md")).sort();
  const isolation = writes || scripts.length ? "trusted" : "untrusted";
  if (isolation === "trusted") doc.set("isolation", "trusted");
  files["module.yaml"] = doc.toString({ lineWidth: 0 });

  // The backstop scan: what never leaves, in case prose copied it in.
  const values = (list: string[], min: number) => [...new Set(list.map((v) => v.trim()).filter((v) => v.length >= min))];
  // A vault file whole, and each value inside one: a JSON credential's string values (its field names are no secret), else
  // each line of the file (a key file, an env-style file's values).
  const leaves = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : []);
  const inside = (s: string) => { try { return leaves(JSON.parse(s)); } catch { return s.split("\n").map((l) => l.trim().replace(/^(?:export\s+)?[\w.-]+\s*=\s*/, "").replace(/^(["'])(.*)\1$/, "$2")); } };
  const secrets = values(d.secrets.flatMap((s) => [s, ...inside(s)]), 6).flatMap(forms);
  const settings = Object.entries(d.settings).flatMap(([k, v]) => values(scalars(v), 6).flatMap((s) => forms(s).map((f) => [k, f] as const)));
  const facts = values(d.memory, 20);
  const profile = values(d.profile.split("\n").map((l) => l.replace(/^\s*(?:[-*>#]+\s*)+/, "")), 20);
  const others = d.catalog.filter((m) => m.tier === "local" && m.name !== name).map((m) => `modules/${m.name}/`);
  // Every file's name is scanned too, as its own entry: a name can carry a value its text doesn't.
  const names = Object.keys(files).join("\n");
  for (const [file, text] of [...Object.entries(files), ["(file names)", names] as [string, string]]) {
    const low = text.toLowerCase();
    if (secrets.some((s) => text.includes(s))) findings.push({ file, rule: "secret-value", detail: "a vault secret's value" });
    for (const [k] of settings.filter(([, s]) => text.includes(s))) findings.push({ file, rule: "setting-value", detail: `the value of the setting ${k}` });
    if (facts.some((f) => text.includes(f))) findings.push({ file, rule: "memory-fact", detail: "a fact from an agent's memory" });
    if (profile.some((l) => text.includes(l))) findings.push({ file, rule: "profile-fact", detail: "a line of the owner's profile" });
    if (SECRET_SHAPES.test(text)) findings.push({ file, rule: "secret-shaped", detail: "text shaped like a token or key" });
    const ref = others.find((p) => text.includes(p)) ?? (d.instanceRepo && low.includes(d.instanceRepo.toLowerCase()) ? d.instanceRepo : undefined);
    if (ref) findings.push({ file, rule: "local-reference", detail: `it names ${ref}, which is this instance's` });
  }
  const bytes = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
  if (Object.keys(files).length > MAX_FILES || bytes > MAX_BYTES) findings.push({ file: "", rule: "too-big", detail: `${Object.keys(files).length} files, ${bytes} bytes: a shared module is at most ${MAX_FILES} files and ${MAX_BYTES / 1024} KB` });
  const unique = [...new Map(findings.map((f) => [`${f.file}|${f.rule}|${f.detail}`, f])).values()];
  return { module: name, source: d.sha, files, notShared, findings: unique, isolation, scripts, grants, digest: digestOf(d.sha, files) };
}

/** Every value in the vault (its files, at any depth, up to 64 KB each): what the scan looks for. */
export function vaultValues(dir: string): string[] {
  if (!dir) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    let names: string[];
    try { names = readdirSync(at); } catch { return; }
    for (const n of names) {
      const p = join(at, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && st.size <= 65_536) out.push(readFileSync(p, "utf8"));
      } catch { /* unreadable: nothing to compare */ }
    }
  };
  walk(dir);
  return out;
}

type Owner = { account: string; via: string };
/**
 * The two share routes (backplane POST /v1/modules/share/preview and /v1/modules/share). The preview exports the module at
 * the instance's main and asks the code host where it would land (the branch's tip). The share is the owner's board save of
 * that preview, on his own settings task: the module unchanged since, the same export at the same source (same digest, no
 * findings), filed as his own decided github.publish_module bound to the repo, ref and base tip he saw.
 */
export function createSharing(d: {
  instanceDir: string; configDir: string; instanceRepo: () => string | undefined;
  secrets: () => string[]; memory: () => string[];
  /** The code host's answer for a destination: its tip, whether it is private, and a folder or entry that isn't this module's. */
  tip: (b: { repo: string; ref: string; module: string }) => Promise<{ repo: string; base: string; private: boolean; conflict?: string; existing?: string[] }>;
  ownerTask: (task: unknown, credential?: unknown) => Promise<{ issue: Dict; account?: string }>;
  /** Whether a share was filed on this task already. */
  filed: (task: string) => boolean;
  file: (args: Dict, task: string, owner: Owner) => Promise<{ id: string; tier: number; state: string }>;
}) {
  const refuse = (m: string): never => { throw new ShareRefused(m); };
  const text = async (args: string[]) => (await git(d.instanceDir, args)).toString("utf8").trim();
  const main = async () => (await text(["fetch", "-q", "origin", "main"]), text(["rev-parse", "--verify", "origin/main^{commit}"]));
  const tree = (sha: string, module: string) => text(["rev-parse", "--verify", `${sha}:modules/${module}`]).catch(() => "");
  /** The export at `sha`, scanned against the owner's profile at `profileAt` (a save reads today's main: a line added since counts). */
  async function exportAt(module: string, sha: string, profileAt = sha) {
    const compiled: Dict = YAML.parse(readFileSync(join(d.configDir, "paperclip.yaml"), "utf8")) ?? {};
    const catalog: Dict[] = JSON.parse(readFileSync(join(d.configDir, "modules.json"), "utf8"));
    // Only the values this instance set: a module default is public text, not the owner's. Both the applied ones and the ones in
    // instance.yaml at the shared commit (set there, not yet applied).
    // Every value a setting has here, side by side: applied, at the shared commit and at the newest main (`also`).
    const at = async (c: string): Promise<Dict> => (YAML.parse(await text(["cat-file", "blob", `${c}:instance.yaml`]).catch(() => "")) ?? {}).settings ?? {};
    const sides = [Object.fromEntries(Object.entries<Dict>(compiled.settings ?? {}).filter(([, v]) => v?.set).map(([k, v]) => [k, v.value])), await at(sha), await at(profileAt)];
    const settings: Dict = Object.create(null);
    for (const side of sides) for (const [k, v] of Object.entries(side)) settings[k] = [...(settings[k] ?? []), v];
    // The profile at the shared commit's newest main and the one agents run with now (applied): a line in either never leaves.
    const profile = [await text(["cat-file", "blob", `${profileAt}:owner/profile.md`]).catch(() => ""), String(compiled.owner_profile ?? "")].join("\n");
    return exportModule(module, { instanceDir: d.instanceDir, sha, catalog, compiled, settings, secrets: d.secrets(), memory: d.memory(), profile, instanceRepo: d.instanceRepo() });
  }
  const shape = (b: Dict) => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(b.module))) refuse("module is a local module's name");
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(b.repo))) refuse("repo is a GitHub owner/name");
    if (!/^(?!-)(?!.*\.\.)[\w./-]{1,200}$/.test(String(b.ref))) refuse("ref is a branch name");
    return { module: String(b.module), repo: String(b.repo), ref: String(b.ref) };
  };
  return {
    /** What a share would send, exactly, and where: the files whole only when nothing blocks it. */
    async preview(b: Dict) {
      const { module, repo, ref } = shape(b);
      const x = await exportAt(module, await main());
      const to = await d.tip({ repo, ref, module });
      const clean = !x.findings.length;
      return {
        module, repo: to.repo, ref, source: x.source, base: to.base, digest: x.digest, private: to.private, ...(to.conflict ? { conflict: to.conflict } : {}),
        files: Object.keys(x.files).sort().map((path) => ({ path, bytes: Buffer.byteLength(x.files[path]!), ...(clean ? { text: x.files[path] } : {}) })),
        // What the publish deletes from the destination's folder (at the tip the save binds): the folder becomes exactly `files`.
        removes: (to.existing ?? []).filter((p) => !Object.hasOwn(x.files, p)).sort(),
        notShared: x.notShared, findings: x.findings, isolation: x.isolation, scripts: x.scripts, grants: x.grants,
      };
    },
    /** The owner's board save of a preview: filed and decided as his account, or refused (a new preview is needed). */
    async share(b: Dict) {
      const { module, repo, ref } = shape(b);
      const cred = b.credential as { board?: unknown } | undefined;
      if (typeof cred?.board !== "string") refuse("a share is the owner's save on the board, signed in");
      const { account } = await d.ownerTask(b.task, cred);
      if (!account) refuse("that sign-in has ended: sign in again");
      if (d.filed(String(b.task))) refuse("a share was already filed on that task: preview and save again");
      for (const k of ["source", "base"]) if (!/^[0-9a-f]{40}$/.test(String(b[k]))) refuse(`${k} is the preview's commit`);
      if (!/^[0-9a-f]{64}$/.test(String(b.digest))) refuse("digest is the preview's");
      const now = await main();
      if ((await tree(now, module)) !== (await tree(String(b.source), module))) refuse(`the ${module} module changed since your preview: preview again`);
      const x = await exportAt(module, String(b.source), now);
      if (x.findings.length) refuse(`not shared: ${x.findings.map((f) => `${f.file || module} (${f.detail})`).join("; ").slice(0, 600)}`);
      if (x.digest !== b.digest) refuse("what would be shared isn't what you previewed: preview again");
      const args = { repo, ref, base: String(b.base), source: x.source, module, files: Object.keys(x.files).sort().map((path) => ({ path, text: x.files[path]! })), digest: x.digest };
      const r = await d.file(args, String(b.task), { account: account!, via: "save" });
      return { record: r.id, tier: r.tier, state: r.state };
    },
  };
}
