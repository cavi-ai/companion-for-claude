// The built-in embedding model catalog (spec 2026-07-09, extended 2026-07-28
// to a user-selectable set). The default stays xs: one default on every
// platform means one index format — a desktop-built index syncs to mobile.
// Switching models changes the index key, which invalidates and rebuilds the
// stored index; rebuilding follows the platform's indexing/start policy.

export interface BuiltinModel {
  /** Stable settings selection; the persisted index uses builtinIndexKey(). */
  id: string;
  /** HuggingFace repo the weights download from (explicit user consent only). */
  hfRepo: string;
  /** Immutable publisher commit; never fetch floating main weights. */
  revision: string;
  dtype: "q8";
  assets: ReadonlyArray<{ path: string; bytes: number }>;
  /** Per-chunk token ceiling shared across platforms. */
  maxTokens: number;
  documentPrefix: string;
  /** Pooling per the model card. */
  pooling: "cls" | "mean";
  /** Search-only instruction; document embeddings keep their original identity. */
  queryPrefix: string;
  /** Expected vector dimension. */
  dim: number;
  /** Shown in the download button/disclosure copy. */
  approxDownloadMB: number;
}

export const BUILTIN_EMBEDDING_MODELS: readonly BuiltinModel[] = [
  {
    id: "builtin:snowflake-arctic-embed-xs",
    hfRepo: "Snowflake/snowflake-arctic-embed-xs",
    revision: "d8c86521100d3556476a063fc2342036d45c106f",
    dtype: "q8",
    maxTokens: 512,
    documentPrefix: "",
    assets: [
      { path: "config.json", bytes: 737 },
      { path: "tokenizer.json", bytes: 711649 },
      { path: "tokenizer_config.json", bytes: 1433 },
      { path: "onnx/model_quantized.onnx", bytes: 22972992 },
    ],
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dim: 384,
    approxDownloadMB: 24,
  },
  {
    id: "builtin:snowflake-arctic-embed-s",
    hfRepo: "Snowflake/snowflake-arctic-embed-s",
    revision: "e596f507467533e48a2e17c007f0e1dacc837b33",
    dtype: "q8",
    maxTokens: 512,
    documentPrefix: "",
    assets: [
      { path: "config.json", bytes: 703 },
      { path: "tokenizer.json", bytes: 711649 },
      { path: "tokenizer_config.json", bytes: 1433 },
      { path: "onnx/model_quantized.onnx", bytes: 34015111 },
    ],
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dim: 384,
    approxDownloadMB: 35,
  },
  {
    id: "builtin:snowflake-arctic-embed-m",
    hfRepo: "Snowflake/snowflake-arctic-embed-m-long",
    revision: "92d97331f1f4b6a366c1f161354b9f3390cc219f",
    dtype: "q8",
    maxTokens: 512,
    documentPrefix: "",
    assets: [
      { path: "config.json", bytes: 1599 },
      { path: "tokenizer.json", bytes: 711649 },
      { path: "tokenizer_config.json", bytes: 1417 },
      { path: "onnx/model_quantized.onnx", bytes: 138359814 },
    ],
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
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

/** Exact document/query encoding contract; changing it requires a rebuilt index. */
export function builtinIndexKey(model: BuiltinModel): string {
  return model.id + ":" + JSON.stringify({
    repo: model.hfRepo, revision: model.revision, dtype: model.dtype, pooling: model.pooling,
    dim: model.dim, maxTokens: model.maxTokens,
    queryPrefix: model.queryPrefix, documentPrefix: model.documentPrefix,
  });
}
