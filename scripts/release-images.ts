// Prebuilt release images. A release file may carry `images: { <name>: <registry>/<repo>@sha256:<digest> }`, the images CI
// built from exactly that release's kernel and modules. <name> is the locally built image's name without `aidenhq/` and
// `:local`: `board`, `<module>-<service>` for a module's built service, `computer-<image>` for a computer image.
//   buildable(kernelDir, modulesDir)   every image this checkout builds, grouped in chains (a computer image builds FROM its parent)
//   useReleaseImages(...)              compile: a built service whose image the release names runs that digest and no longer builds
//   node scripts/release-images.ts list [kernelDir] [modulesDir]   the chains as JSON (the distro's release workflow builds them)
// A release without `images`, or a service it doesn't name, builds locally as before (dev, forks).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { COMPUTER_IMAGES } from "./computers.ts";

const LOCAL = /^aidenhq\/([a-z0-9][a-z0-9._-]*):local$/;
interface Service { build?: unknown; image?: string }
interface Compose { services?: Record<string, Service>; [k: string]: unknown }
interface Build { name: string; context: string; base?: string }

const read = (f: string) => YAML.parse(readFileSync(f, "utf8")) ?? {};

/** Every image this checkout builds, as chains in build order: `[{ name, context, base? }]` (base: the name it builds FROM). */
export function buildable(kernelDir: string, modulesDir = join(kernelDir, "modules")) {
  const one = (name: string, context: string): Build[] => [{ name, context }];
  const chains: Build[][] = [];
  for (const s of Object.values<Service>(read(join(kernelDir, "compose.yaml")).services ?? {})) {
    const m = typeof s.build === "string" && LOCAL.exec(s.image ?? "");
    if (m) chains.push(one(m[1]!, resolve(kernelDir, s.build as string)));
  }
  for (const mod of existsSync(modulesDir) ? readdirSync(modulesDir).sort() : []) {
    const f = join(modulesDir, mod, "module.yaml");
    if (!existsSync(f)) continue;
    for (const [svc, s] of Object.entries<Service | undefined>(read(f).services?.run ?? {})) {
      if (typeof s?.build === "string") chains.push(one(svc.startsWith(`${mod}-`) ? svc : `${mod}-${svc}`, resolve(modulesDir, mod, s.build as string)));
    }
  }
  const chain = (name: string): Build => ({ name: `computer-${name}`, context: join(kernelDir, "services/computer/images", name), ...(COMPUTER_IMAGES[name as keyof typeof COMPUTER_IMAGES] ? { base: `computer-${COMPUTER_IMAGES[name as keyof typeof COMPUTER_IMAGES]}` } : {}) });
  chains.push(Object.keys(COMPUTER_IMAGES).map(chain));
  return chains;
}

const RESET = Object.assign(new YAML.Scalar(null), { tag: "!reset" });

/**
 * compose.modules.yaml's services after the release's images: each built service (a module's in `generated`, a root one in
 * `root`, the parsed compose.yaml) whose image the release names gets `image: <digest>` and no build.
 */
export function useReleaseImages(generated: Compose, root: Compose, images: Record<string, string> = {}) {
  const ref = (image?: string) => images[LOCAL.exec(image ?? "")?.[1]!];
  const services = { ...generated.services };
  for (const [name, s] of Object.entries(root.services ?? {})) {
    if (s.build != null && ref(s.image)) services[name] = { ...services[name], image: ref(s.image), build: RESET };
  }
  for (const [name, s] of Object.entries(services)) {
    if (s.build != null && s.build !== RESET && ref(s.image)) services[name] = { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "build")), image: ref(s.image) };
  }
  return { ...generated, services };
}

/** config/computers.json `pull`: computer image tag → the release's digest for it (those the release names). */
export const computerPulls = (tags: Record<string, string>, images: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(tags).filter(([n]) => images[`computer-${n}`]).map(([n, tag]) => [tag, images[`computer-${n}`]]));

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "list") {
  const kernel = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(JSON.stringify(buildable(kernel, process.argv[4] ? resolve(process.argv[4]) : undefined)));
}
