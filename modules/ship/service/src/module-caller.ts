// Whether a bearer is the named module's own token, asked of the kernel (GET /v1/whoami): ship's adoption read is opened to the
// github module alone (its adopted-PR writes), so no secret is shared with it. undefined: the kernel couldn't answer now (a restart,
// a timeout, a 5xx), which a caller answers as 503 (try again), never as the 401 of a token the kernel refused.
export async function isModule(kernelUrl: string, authorization: string, module: string, fetcher: typeof fetch = fetch): Promise<boolean | undefined> {
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;
  try {
    const r = await fetcher(new URL("/v1/whoami", kernelUrl), { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return r.status === 401 || r.status === 403 ? false : undefined;
    const who = (await r.json()) as { kind?: string; module?: string };
    return who.kind === "module" && who.module === module;
  } catch {
    return undefined;
  }
}
