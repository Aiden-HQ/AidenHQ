// OpenRouter's text models for the model picker, fetched once per page load and kept (the kernel's gateway holds the list; a failed
// read is tried again on the next use, at most once a minute). null while it loads; [] when it can't be read: the picker then
// offers its recommended models only.
import { useEffect, useState } from "react";
import { api } from "./api";
import type { CatalogModel } from "../../src/model-catalog";

let kept: CatalogModel[] | undefined;
let loading: Promise<CatalogModel[]> | undefined;
let failedAt = 0;

function load(): Promise<CatalogModel[]> {
  if (kept) return Promise.resolve(kept);
  if (Date.now() - failedAt < 60_000) return Promise.resolve([]);
  return (loading ??= api.modelCatalog().then(
    (r) => (kept = r.models),
    () => ((failedAt = Date.now()), []),
  ).finally(() => (loading = undefined)));
}

export function useModelCatalog(): CatalogModel[] | null {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(kept ?? null);
  useEffect(() => {
    let live = true;
    void load().then((m) => live && setCatalog(m));
    return () => { live = false; };
  }, []);
  return catalog;
}
