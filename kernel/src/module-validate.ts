// A module's own check of a value before it is saved (module.yaml `validate:`, compiled into config/kernel/checks.json as
// `<module>.validate`, at: validate): the board asks here before it files a settings change for the module, and the
// kernel asks it before writing a pasted secret to the module's vault. The module answers { ok: true } or
// { ok: false, errors: [{ field, message }] }. A module that doesn't answer within 10 s (or answers nonsense) doesn't
// block: the value goes ahead and the answer says it couldn't be checked. A hook in observe mode (gates.ts) is asked the
// same, but its refusal only becomes a `gate.would_block` fact and the value goes ahead. The secret's value goes to its own
// module alone, in the `value` field, and is never logged or recorded. One exception to "no answer doesn't block": a **clear**
// of one key of a map secret (`key` present, no value) is refused when the hook can't be asked, because a cleared key cannot be
// read back. A module with no hook still clears, since that returns before any call.
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { Facts } from "./facts.ts";
import { noteFact } from "./facts.ts";
import { gateMode } from "./gates.ts";
import type { Resolver } from "./net.ts";
import type { Check } from "./checks.ts";

export type FieldError = { field: string; message: string };
export type Validation = { ok: true; unchecked?: string } | { ok: false; errors: FieldError[] };
export type ValidateInput = {
  settings?: Record<string, unknown>;
  /** The secret's name and value; a clear of one key of a map secret sends no value. */
  secret?: { name: string; value?: string };
  /** On a clear of one key of a map secret: the key, with no value. */
  key?: string;
};

export function createModuleValidate({ registry, services, secret, resolver, facts, log = () => {} }: { registry: () => Record<string, Check>; /** The module's compose services (config/kernel/modules.json): its hook must be one of them. */ services: (module: string) => string[] | undefined; secret: (n: string) => string; resolver: Resolver; facts: Facts; log?: (msg: string, f?: Record<string, unknown>) => void }) {
  function ask(c: Check, body: unknown): Promise<unknown> {
    const key = secret(c.auth_secret);
    if (!key) return Promise.reject(new Error("its key is missing"));
    return resolver.resolve(c.url).then((to) => new Promise<unknown>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10_000, headers: { host: new URL(c.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 100_000) text += d; }).on("end", () => {
          if ((res.statusCode ?? 500) >= 300) return reject(new Error(`answered ${res.statusCode}`));
          try { resolve(JSON.parse(text)); } catch { reject(new Error("answered with no JSON")); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("didn't answer in 10 s")));
      req.on("error", (e) => { resolver.forget(c.url); reject(e); });
      req.end(data);
    }));
  }

  return async function validate(module: string, input: ValidateInput): Promise<Validation> {
    const id = `${module}.validate`;
    const c = registry()[id];
    if (!c || c.at !== "validate") return { ok: true };
    const mode = gateMode(id, c.mode);
    // A clear of one key of a map secret, rather than a written value: it can't be read back, so a hook that can't be asked
    // refuses it (fail closed) instead of letting it through unchecked.
    const clearing = input.key !== undefined && input.secret?.value === undefined;
    const unchecked = (why: string): Validation => clearing
      ? { ok: false, errors: [{ field: "", message: `${module} couldn't check whether this is still in use (${why}); nothing was cleared` }] }
      : { ok: true, unchecked: `${module} couldn't check this (${why}); it was saved without that check` };
    // Pasted secrets go only to the module's own service, whatever the file says (compile checks it too).
    const host = new URL(c.url).hostname;
    if (!(services(module) ?? []).some((k) => k === host || k === `${module}-${host}`)) {
      log("a module's validate hook isn't its own service", { module, host });
      return unchecked("its check isn't one of its own services");
    }
    let answer: { ok?: unknown; errors?: unknown };
    try {
      // The hook's own shape, unchanged: the value at the top level, beside `secret: { name }`; a clear sends the `key` and no value.
      answer = (await ask(c, { ...(input.settings ? { settings: input.settings } : {}), ...(input.secret ? { secret: { name: input.secret.name }, ...(input.secret.value !== undefined ? { value: input.secret.value } : {}) } : {}), ...(input.key !== undefined ? { key: input.key } : {}) })) as typeof answer;
      if (typeof answer?.ok !== "boolean") throw new Error("answered without ok");
    } catch (e) {
      log("a module's validation couldn't be asked", { module, err: String((e as Error).message).slice(0, 200), cleared: clearing });
      return unchecked(String((e as Error).message).slice(0, 100));
    }
    if (answer.ok) return { ok: true };
    const errors: FieldError[] = (Array.isArray(answer.errors) ? answer.errors : []).slice(0, 20).map((x: { field?: unknown; message?: unknown }) => ({ field: String(x?.field ?? "").slice(0, 100), message: String(x?.message ?? "").slice(0, 300) }));
    if (mode !== "observe") return { ok: false, errors: errors.length ? errors : [{ field: "", message: `${module} refused this` }] };
    const entry = { gate: id, module, verdict: "deny", errors };
    noteFact(facts, { type: "gate.would_block", subject: `module:${module}`, version: `e-${randomBytes(8).toString("hex")}`, at: new Date().toISOString(), actor: "kernel", data: entry });
    log("gate would block", { gate: id, module, fields: errors.map((x) => x.field) });
    return { ok: true };
  };
}
export type ModuleValidate = ReturnType<typeof createModuleValidate>;
