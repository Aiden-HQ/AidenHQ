// DELETE once no instance has a pr-watch.json left: the Dependabot tasks github's old PR watch filed carry github's marker, so only
// github can close them (ship's re-filing of the same source returns the same task, which ship may not close). Each pass closes the
// task of every listed PR that is no longer open, keeps the rest, and deletes the file once none is left.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Gh = (method: string, path: string) => Promise<{ status: number; body: any }>;
type Kernel = (method: string, path: string, body: unknown) => Promise<unknown>;

export async function sweepLegacyDependabot(cacheDir: string, gh: Gh, kernel: Kernel): Promise<void> {
  const file = join(cacheDir, "pr-watch.json");
  if (!existsSync(file)) return;
  const all: Record<string, { dependabot?: Record<string, string> }> = JSON.parse(readFileSync(file, "utf8"));
  const left: Record<string, { dependabot: Record<string, string> }> = {};
  for (const [repo, s] of Object.entries(all)) for (const [url, task] of Object.entries(s.dependabot ?? {})) {
    const pr = await gh("GET", `/repos/${repo}/pulls/${url.split("/").at(-1)}`).catch(() => undefined);
    const gone = pr && (pr.status === 404 || (pr.status < 300 && pr.body?.state !== "open"));
    if (gone) await kernel("POST", `/v1/tasks/${task}/close`, { status: "done", body: `${url} is merged or closed: nothing left to do.` }).then(() => true, () => false).then((ok) => { if (!ok) (left[repo] ??= { dependabot: {} }).dependabot[url] = task; });
    else (left[repo] ??= { dependabot: {} }).dependabot[url] = task;
  }
  if (Object.keys(left).length) writeFileSync(file, JSON.stringify(left));
  else rmSync(file);
}
