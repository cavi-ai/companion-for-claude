// The pinned built-in embedding model (spec 2026-07-09). One default on every
// platform means one index format — a desktop-built index syncs to mobile.

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

export const BUILTIN_EMBEDDING_MODEL: BuiltinModel = {
  id: "builtin:snowflake-arctic-embed-xs",
  hfRepo: "Snowflake/snowflake-arctic-embed-xs",
  pooling: "cls",
  dim: 384,
  approxDownloadMB: 45,
};
