// Shared by the fake binaries the flow test puts on the runner's PATH: each logs what it was asked
// to $FAKE_LOG, then does the least it can.
import { appendFileSync } from "node:fs";

export const log = (kind, data) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind, data }) + "\n");
