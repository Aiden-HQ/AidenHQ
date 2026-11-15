// Shared by the fake binaries the flow test puts on the runner's PATH: each logs what it was asked
// to $FAKE_LOG, then does the least it can.
import { appendFileSync, readFileSync } from "node:fs";

export const log = (kind, data) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind, data }) + "\n");

// The records in a fake log so far, from the whole lines only: the fakes append multi-KB lines while the tests poll,
// and a poll can land mid-line, so a trailing fragment with no newline is a record still being written and is left
// for the next poll instead of being parsed.
export const readLog = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  return whole ? whole.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
