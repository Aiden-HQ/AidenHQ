/** A network blip or a service restarting (not a refusal): worth another try a few seconds later. */
export function isTransient(err: any): boolean {
  const text = `${err?.message ?? err} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket hang up|aborted due to timeout|→ 5\d\d:/i.test(text);
}

/** The runner's end-of-job calls: three more tries over about 30 seconds, then the error. Anything but a transient error throws at once. */
export async function retryTransient<T>(fn: () => Promise<T>, delaysMs: number[] = [3_000, 9_000, 18_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= delaysMs.length || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}
