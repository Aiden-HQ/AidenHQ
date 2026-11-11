import { describe, expect, it } from "vitest";
import { openQuestions } from "../web/src/questions.js";

type M = { id: string; kind: string; questions?: unknown[] };
const msg = (id: string, kind: string, questions?: unknown[]): M => ({ id, kind, ...(questions ? { questions } : {}) });

describe("openQuestions", () => {
  it("is the newest asking message, even after later agent updates, until the owner replies", () => {
    const q = [{ question: "Which channel?", options: ["a", "b"] }];
    expect(openQuestions([msg("1", "reply", q), msg("2", "reply"), msg("3", "reply")])?.id).toBe("1");
    expect(openQuestions([msg("1", "reply", q), msg("2", "owner"), msg("3", "reply")])).toBeUndefined();
    expect(openQuestions([msg("1", "reply")])).toBeUndefined();
  });
});
