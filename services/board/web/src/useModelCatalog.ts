// OpenRouter's text models for the model picker (the kernel's gateway holds the list). Kept for ten minutes; a picker asks again
// when it opens (`refresh`), which re-reads a stale list, or retries a failed one at most once a minute. null while the first read
// is under way; [] when it can't be read (the picker then offers its recommended models only); a failed refresh keeps the last list.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { CatalogModel } from "../../src/model-catalog";

const FRESH_MS = 600_000, RETRY_MS = 60_000;
let kept: { models: CatalogModel[]; at: number } | undefined;
let loading: Promise<CatalogModel[]> | undefined;
let failedAt = 0;

function load(): Promise<CatalogModel[]> {
  if (kept && Date.now() - kept.at < FRESH_MS) return Promise.resolve(kept.models);
  if (Date.now() - failedAt < RETRY_MS) return Promise.resolve(kept?.models ?? []);
  return (loading ??= api.modelCatalog().then((r) => {
    // An empty list is a gateway still loading: asked again.
    if (!r.models.length) throw new Error("empty");
    kept = { models: r.models, at: Date.now() };
    return r.models;
  }).catch(() => ((failedAt = Date.now()), kept?.models ?? [])).finally(() => (loading = undefined)));
}

export function useModelCatalog(): [CatalogModel[] | null, () => void] {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(kept?.models ?? null);
  const refresh = useCallback(() => void load().then(setCatalog), []);
  useEffect(() => {
    let live = true;
    void load().then((m) => live && setCatalog(m));
    return () => { live = false; };
  }, []);
  return [catalog, refresh];
}
