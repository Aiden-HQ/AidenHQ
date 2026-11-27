// Lane C fills this in (the `telegram.send` executor). Lane B's main.ts imports this exact signature.
import type { Executor } from "./aidenhq-sdk/executor.js";
import type { TdClient } from "./td.js";
import type { Store } from "./store.js";

export function sender(_d: {
  td: () => TdClient | undefined;
  store: Store;
  onAgentSend: (chatId: number, tempId: number, writeId: string) => void;
  now?: () => number;
}): Executor {
  throw new Error("telegram.send executor: not implemented (Lane C)");
}
