// The only door to TDLib. The real client wraps tdl; tests use test/fake-td.ts (CI installs with --ignore-scripts,
// so nothing here loads tdl or libtdjson until openTd runs).
import { createRequire } from "node:module";

export type TdUpdate = { _: string; [k: string]: unknown };

export interface TdClient {
  /** Throws TdError. Refuses every READ_STATE_METHODS method. */
  invoke<T = any>(req: { _: string; [k: string]: unknown }): Promise<T>;
  onUpdate(fn: (u: TdUpdate) => void): void;
  /** Sends `close`; resolves on authorizationStateClosed. */
  close(): Promise<void>;
}

/** `retryAfterS` is parsed from a 429 "Too Many Requests: retry after N". */
export class TdError extends Error {
  code: number;
  retryAfterS?: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "TdError";
    this.code = code;
    const m = code === 429 ? /retry after (\d+)/i.exec(message) : null;
    if (m) this.retryAfterS = Number(m[1]);
  }
}

/** Calls that mark chats or messages read (or open them) on the user's account: refused in code, never sent. */
export const READ_STATE_METHODS: ReadonlySet<string> = new Set([
  "viewMessages",
  "openChat",
  "closeChat",
  "readAllChatMentions",
  "readAllChatReactions",
  "readAllMessageThreadMentions",
  "readAllMessageThreadReactions",
  "toggleChatIsMarkedAsUnread",
  "readChatList",
  "clickChatSponsoredMessage",
  "openMessageContent",
]);

export function refuseReadState(method: string): void {
  if (READ_STATE_METHODS.has(method)) throw new TdError(400, `refused: ${method} would change the account's read state`);
}

/** The signed-in account (getMe). */
export type Me = { user_id: number; usernames: string[]; name: string };

let configured = false;

export function openTd(o: { apiId: number; apiHash: string; dir: string; key: string; version: string }): TdClient {
  const require = createRequire(import.meta.url);
  const tdl = require("tdl") as typeof import("tdl");
  if (!configured) {
    const { getTdjson } = require("prebuilt-tdlib") as typeof import("prebuilt-tdlib");
    tdl.configure({ tdjson: getTdjson() });
    configured = true;
  }
  const client = tdl.createClient({
    apiId: o.apiId,
    apiHash: o.apiHash,
    databaseDirectory: o.dir,
    filesDirectory: `${o.dir}/files`,
    databaseEncryptionKey: o.key,
    tdlibParameters: {
      use_message_database: true,
      use_chat_info_database: true,
      use_file_database: false,
      use_secret_chats: false,
      device_model: "AidenHQ",
      system_language_code: "en",
      application_version: o.version,
    },
  });
  const listeners: ((u: TdUpdate) => void)[] = [];
  client.on("update", (u) => {
    for (const fn of listeners) fn(u as TdUpdate);
  });
  // An error tdl can't tie to a request arrives on "error" (an unhandled one kills the process): listeners get it as an update.
  client.on("error", (e) => {
    const x = e as { code?: number; message?: string };
    for (const fn of listeners) fn({ _: "error", code: typeof x.code === "number" ? x.code : 500, message: x.message ?? String(e) });
  });
  return {
    async invoke(req) {
      refuseReadState(req._);
      try {
        return (await client.invoke(req as never)) as never;
      } catch (e) {
        const x = e as { code?: number; message?: string };
        if (typeof x.code === "number") throw new TdError(x.code, x.message ?? String(e));
        throw e;
      }
    },
    onUpdate: (fn) => void listeners.push(fn),
    close: () => client.close(),
  };
}

