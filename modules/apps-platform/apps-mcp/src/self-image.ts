// The image apps-mcp itself runs from. Helper containers (health probe, app_api transport, identity probe) run in it with
// `--pull never`, so they must name an image this host has: a release install runs a pulled digest, a dev build a local tag,
// so it is read from the running container instead of assumed. By its content-addressed id, never a tag an app's build or
// pull could move (policy.ts keeps apps off the platform's names too). An id alone dangles once an apply rebuilds the tag
// without recreating apps-mcp, and the containerd image store then drops it (2026-11-18: every helper `docker run` failed,
// so every health probe and deploy did), so the id is held by a tag of the platform's own: HELPER_REPO:<id>.
import { readFileSync } from "node:fs";

/** The platform-owned tag repository that keeps apps-mcp's own image id present while apps-mcp runs. */
export const HELPER_REPO = "aidenhq/apps-mcp-helper";

/** This container's id: the one in /proc/self/mountinfo (/docker/containers/<id>/), else its hostname (Docker's default). */
export function ownContainerId(read: (path: string) => string = (p) => readFileSync(p, "utf8")): string {
  const fromMounts = /\/docker\/containers\/([0-9a-f]{64})\//.exec(read("/proc/self/mountinfo"))?.[1];
  return fromMounts ?? read("/etc/hostname").trim();
}

/**
 * The image id of this container, tagged HELPER_REPO:<id> so it outlives a rebuild of apps-mcp's tag; older holder tags
 * (earlier apps-mcp containers) are untagged. Throws when the id can't be read or held.
 */
export async function resolveOwnImage(docker: (args: string[]) => Promise<string>, containerId: () => string = ownContainerId): Promise<string> {
  try {
    const image = (await docker(["inspect", "--format", "{{.Image}}", containerId()])).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`not an image id: ${image.slice(0, 80)}`);
    const tag = image.slice("sha256:".length);
    await docker(["tag", image, `${HELPER_REPO}:${tag}`]);
    const old = (await docker(["image", "ls", HELPER_REPO, "--format", "{{.Tag}}"])).split("\n").map((t) => t.trim()).filter((t) => t && t !== tag);
    for (const t of old) await docker(["rmi", `${HELPER_REPO}:${t}`]).catch(() => undefined); // in use by a running helper: next start
    return image;
  } catch (err) {
    throw new Error(`cannot resolve apps-mcp's own image for helper containers (is /var/run/docker.sock mounted and the hostname the container id?): ${String(err)}`);
  }
}
