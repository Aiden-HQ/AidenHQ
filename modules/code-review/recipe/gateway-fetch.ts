// Loaded into codegenie's node (--import): codegenie has no base-URL option, so its OpenRouter calls go to the run's model gateway
// (CODEGENIE_GATEWAY: the gateway's /api/v1), the only address the box reaches. Anything else is left as it is (and fails: no network).
const to = String(process.env.CODEGENIE_GATEWAY ?? "").replace(/\/$/, ""), from = "https://openrouter.ai/api/v1/", real = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!to || !url.startsWith(from)) return real(input, init);
  const dest = `${to}/${url.slice(from.length)}`;
  return real(input instanceof Request ? new Request(dest, input) : dest, init);
};
