// The board's one model picker: a button showing the model, a searchable list under it (SearchPicker). The list is OpenRouter's
// catalog (useModelCatalog), grouped Recommended / Latest aliases / by provider, newest first, with older versions of a model behind
// a toggle (model-catalog.ts `listing`). Only a listed id can be picked. With no catalog (loading, or it failed) it offers the
// recommended models alone.
import { useMemo, useState } from "react";
import { contextText, listing, priceText, shortId, type Accepts, type CatalogModel } from "../../../src/model-catalog";
import { SearchPicker } from "./SearchPicker";

export function ModelPicker({ value, onChange, catalog, recommended, accepts, label, placeholder, disabled, onOpen }: {
  value: string;
  onChange: (id: string) => void;
  /** null while it loads, [] when it couldn't be read. */
  catalog: CatalogModel[] | null;
  /** The short list (the engine's, or the agents' own), shown first. */
  recommended: readonly string[];
  /** What the engine can run (its module's `accepts`). */
  accepts?: Accepts;
  label: string;
  /** What the button says while no model is set. */
  placeholder?: string;
  disabled?: boolean;
  /** The picker opened: the place to ask the catalog again. */
  onOpen?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const list = useMemo(() => listing({ catalog: catalog ?? [], recommended, accepts, query, showOlder: older, current: value || undefined }), [catalog, recommended, accepts, query, older, value]);
  const sections = useMemo(() => list.sections.map((s) => ({
    title: s.title,
    items: s.rows.map((r) => {
      const m = r.model;
      return {
        id: r.id,
        title: m ? `${m.name}${m.reasoning ? " · reasoning" : ""}${m.tools ? " · tools" : ""}` : undefined,
        node: (
          <>
            <span className="ui-mp-id">{shortId(r.id)}</span>
            {m && <span className="ui-mp-name">{m.name.replace(/^[^:]+:\s*/, "")}</span>}
            {m && <span className="ui-mp-meta">{m.context ? `${contextText(m.context)} · ` : ""}{priceText(m)}</span>}
          </>
        ),
      };
    }),
  })), [list]);
  const count = list.sections.reduce((n, s) => n + s.rows.length, 0);
  const unavailable = catalog !== null && !catalog.length;
  const shown = value ? shortId(value) : placeholder ?? "Choose a model";
  return (
    <SearchPicker
      label={`${label}: ${shown}`}
      value={value}
      display={<span className={value ? "" : "ui-mp-none"} title={shown}>{shown}</span>}
      sections={sections}
      query={query}
      onQuery={setQuery}
      searchPlaceholder="Search by name, id or provider"
      onPick={onChange}
      onOpen={() => (setOlder(false), onOpen?.())}
      disabled={disabled}
      empty={unavailable ? "OpenRouter's model list isn't available." : query ? `No model matches "${query}".` : "No models to show."}
      footer={
        <>
          <span>{unavailable ? "Showing the recommended models" : catalog === null ? "Loading the model list…" : `${count} model${count === 1 ? "" : "s"}`}</span>
          {!query && (older || list.older > 0) && (
            <button type="button" className="ui-mp-older" aria-pressed={older} onClick={() => setOlder(!older)}>
              {older ? "Hide older versions" : `Show older versions (${list.older})`}
            </button>
          )}
        </>
      }
    />
  );
}
