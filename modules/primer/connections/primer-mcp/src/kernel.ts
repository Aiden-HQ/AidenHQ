// The kernel routes the comment wake loop uses, with the module's own token (roles kernel.wake and kernel.tasks).
import type { Kernel } from "./subscriber.js";

export function kernelClient(url: string, key: () => string | undefined): Kernel {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key() ?? ""}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`the kernel answered ${res.status} on ${path}: ${String(json?.error?.message ?? json?.message ?? "").slice(0, 200)}`);
    return json;
  };
  return {
    wake: (task, text) => call("/v1/wakes", { task, text }),
    file: (b) => call("/v1/tasks", b),
  };
}
