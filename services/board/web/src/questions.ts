/** The agent message whose questions still wait for the owner: the newest one asking, unless the owner has written since. */
export function openQuestions<M extends { kind: string; questions?: unknown[] }>(messages: M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "owner") return undefined;
    if (m.questions?.length) return m;
  }
  return undefined;
}
