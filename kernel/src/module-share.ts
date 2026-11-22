// Sharing a local module (docs/design/sharing.md): its portable content at one instance commit, exactly what a publish
// sends. Only what a local module may hold leaves: module.yaml, its agents' AGENTS.md and skills/ (regular blobs read from
// git at that commit, never the working tree). Memory, the owner profile, secrets and setting values never leave: they are
// not module files, and the scan below is only a backstop for prose that copied one of them in. The preview shows the
// result; the owner's save is bound to its digest (github's share.ts digestOf, the code host computes it the same way).
import { execFile } from "node:child_process";
import YAML from "yaml";
import { digestOf } from "../../modules/github/service/src/share.ts";

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
const SECRET_SHAPES = /\b(sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|ahq[a-z]?_[A-Za-z0-9]{16,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

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
  for (const [key, r] of Object.entries<Dict>(def.routines ?? {})) {
    const why = !agents.includes(r?.agent) ? `it runs as ${String(r?.agent)}, who isn't in this module` : r?.event?.resource != null ? "it watches a channel or repo of this instance" : undefined;
    if (why) (doc.deleteIn(["routines", key]), notShared.push({ path: `module.yaml routines.${key}`, why }));
  }
  if (doc.get("routines") && !Object.keys(doc.toJS().routines ?? {}).length) doc.delete("routines");

  // Each agent's effective grants as compiled, and whether any writes: an importer runs the module trusted only when it says so.
  const grants = Object.fromEntries(agents.map((k) => [k, Object.entries<string[]>(d.compiled.agents?.[k]?.enabled_tools ?? {}).flatMap(([c, ts]) => ts.map((t) => `${c}.${t}`)).sort()]));
  const writes = Object.values(grants).flat().some((ct) => {
    const [c, t] = ct.split(".") as [string, string];
    const tools = d.compiled.mcp_servers?.[c]?.tools ?? {};
    return [...(tools.write ?? []), ...(tools.destructive ?? [])].includes(t);
  });

  const files: Record<string, string> = {};
  for (const [rel, oid] of blobs) {
    if (rel === "module.yaml") continue;
    const handbook = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(rel);
    if (!(handbook && agents.includes(handbook[1]!)) && !rel.startsWith("skills/")) { notShared.push({ path: rel, why: "a local module shares only module.yaml, its agents' AGENTS.md and skills/" }); continue; }
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
  const secrets = values(d.secrets, 6).flatMap(forms);
  const settings = Object.entries(d.settings).flatMap(([k, v]) => values(scalars(v), 6).flatMap((s) => forms(s).map((f) => [k, f] as const)));
  const facts = values(d.memory, 20);
  const profile = values(d.profile.split("\n").map((l) => l.replace(/^\s*(?:[-*>#]+\s*)+/, "")), 20);
  const others = d.catalog.filter((m) => m.tier === "local" && m.name !== name).map((m) => `modules/${m.name}/`);
  for (const [file, text] of Object.entries(files)) {
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
