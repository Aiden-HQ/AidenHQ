import { afterEach, expect, test, vi } from "vitest";
import { startCertWatch } from "../src/front-door.js";

afterEach(() => vi.useRealTimers());

test("the owner hears once when the front door's certificate has under 48 hours left or fails to verify, then not for 12 hours", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  let expiry: Date | Error = new Date(Date.now() + 100 * 3_600_000);
  const run = startCertWatch("203.0.113.7", (l) => lines.push(l), async () => { if (expiry instanceof Error) throw expiry; return expiry; });
  await run();
  expect(lines).toEqual([]);
  expiry = new Date(Date.now() + 40 * 3_600_000);
  await run();
  await run();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("expires in 40 hours");
  vi.setSystemTime(Date.now() + 12 * 3_600_000);
  expiry = new Error("self-signed certificate");
  await run();
  expect(lines[1]).toContain("can't be verified");
});
