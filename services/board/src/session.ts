import type { IncomingMessage } from "node:http";
import type { AccountSession } from "./kernel-auth.js";

/**
 * Who a board request comes from. Every admin writes as the owner (through the kernel); the account is
 * recorded on what it writes (`authored`) and on the approvals it decides (`account:<id>`).
 * - `accountId`: the account (Better Auth user id).
 * - `role`: "admin" on the board (users never get a board session).
 */
export interface BoardSession {
  accountId: string;
  role: "admin" | "user";
}

/** null: no session (the request is refused). */
export type SessionOf = (req: IncomingMessage) => BoardSession | null | Promise<BoardSession | null>;

/** A Better Auth session counts only when it is a ready admin's (TOTP enrolled, not disabled or locked). */
export function accountSession(who: AccountSession | null): BoardSession | null {
  if (!who?.ready || who.account.role !== "admin") return null;
  return { accountId: who.account.id, role: "admin" };
}
