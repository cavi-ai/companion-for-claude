// The built-in embedding model catalog (spec 2026-07-09, extended 2026-07-28
// to a user-selectable set). The default stays xs: one default on every
// platform means one index format — a desktop-built index syncs to mobile.
// Switching models changes the index key, which invalidates and rebuilds the
// stored index automatically.

export interface BuiltinModel {
  /** Index key ("builtin:"-prefixed so it can never collide with an Ollama model name). */
  id: string;
  /** HuggingFace repo the weights download from (explicit user consent only). */
  hfRepo: string;
  /** Pooling per the model card. */
  pooling: "cls" | "mean";
  /** Expected vector dimension. */
  dim: number;
  /** Shown in the download button/disclosure copy. */
  approxDownloadMB: number;
}

export const BUILTIN_EMBEDDING_MODELS: readonly BuiltinModel[] = [
  {
    id: "builtin:snowflake-arctic-embed-xs",
    hfRepo: "Snowflake/snowflake-arctic-embed-xs",
    pooling: "cls",
    dim: 384,
    approxDownloadMB: 45,
  },
  {
    id: "builtin:snowflake-arctic-embed-s",
    hfRepo: "Snowflake/snowflake-arctic-embed-s",
    pooling: "cls",
    dim: 384,
    approxDownloadMB: 60,
  },
  {
    id: "builtin:snowflake-arctic-embed-m",
    hfRepo: "Snowflake/snowflake-arctic-embed-m-long",
    pooling: "cls",
    dim: 768,
    approxDownloadMB: 140,
  },
];

/** The default (and original) built-in model — kept as the first-class constant. */
export const BUILTIN_EMBEDDING_MODEL: BuiltinModel = BUILTIN_EMBEDDING_MODELS[0]!;

/** Resolve a stored selection to a catalog entry; unknown/absent → default. */
export function builtinModelById(id: string | null | undefined): BuiltinModel {
  return BUILTIN_EMBEDDING_MODELS.find((m) => m.id === id) ?? BUILTIN_EMBEDDING_MODEL;
}
