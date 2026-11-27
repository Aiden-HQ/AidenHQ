// A scripted TdClient for tests: nothing here loads tdl or libtdjson.
import { READ_STATE_METHODS, TdError, type TdClient, type TdUpdate } from "../src/td.js";

type Req = { _: string; [k: string]: unknown };
type Handler = ((req: Req) => unknown | Promise<unknown>) | unknown;

export class FakeTd implements TdClient {
  /** Every invoke, in order (refused read-state calls are not recorded: they never leave). */
  calls: Req[] = [];
  closed = false;
  private handlers = new Map<string, Handler>();
  private listeners: ((u: TdUpdate) => void)[] = [];
  private invokes = 0;
  private updates = 0;
  private crashInvoke?: number;
  private crashUpdate?: number;

  /** Script a method's response: a function (req) => result, or a plain value. An unscripted method throws TdError(500). */
  on(method: string, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }

  /** Throw `Error("crash")` at the Nth invoke (1-based, counting from now). */
  crashAtInvoke(n: number): this {
    this.crashInvoke = this.invokes + n;
    return this;
  }

  /** Throw `Error("crash")` at the Nth emitted update (1-based, counting from now), before any listener sees it. */
  crashAtUpdate(n: number): this {
    this.crashUpdate = this.updates + n;
    return this;
  }

  async invoke<T = any>(req: Req): Promise<T> {
    if (READ_STATE_METHODS.has(req._)) throw new TdError(400, `refused: ${req._} would change the account's read state`);
    this.invokes++;
    if (this.invokes === this.crashInvoke) throw new Error("crash");
    this.calls.push(req);
    if (!this.handlers.has(req._)) throw new TdError(500, `FakeTd: no handler for ${req._}`);
    const h = this.handlers.get(req._);
    return (typeof h === "function" ? await (h as (r: Req) => unknown)(req) : h) as T;
  }

  onUpdate(fn: (u: TdUpdate) => void): void {
    this.listeners.push(fn);
  }

  /** Deliver an update to every listener, synchronously. */
  emit(u: TdUpdate): void {
    this.updates++;
    if (this.updates === this.crashUpdate) throw new Error("crash");
    for (const fn of this.listeners) fn(u);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
