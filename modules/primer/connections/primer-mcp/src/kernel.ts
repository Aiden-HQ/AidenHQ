// The kernel routes the comment wake loop uses, with the module's own token (roles kernel.wake and kernel.tasks).
import type { Kernel } from "./subscriber.js";

export type KernelCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<any>;

export function kernelClient(url: string, key: () => string | undefined): Kernel & { call: KernelCall } {
  const call: KernelCall = async (method, path, body) => {
    const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${key() ?? ""}`, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw Object.assign(new Error(`the kernel answered ${res.status} on ${path}: ${String(json?.error?.message ?? json?.message ?? "").slice(0, 200)}`), { status: res.status });
    return json;
  };
  return {
    call,
    wake: (task, text) => call("POST", "/v1/wakes", { task, text }),
    file: (b) => call("POST", "/v1/tasks", b),
  };
}
