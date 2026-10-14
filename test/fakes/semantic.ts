import type { SemanticController } from "../../src/semantic/controller";

/** The semantic controller surface the settings pages read; overrides replace individual members. */
export function fakeSemantic(overrides: Record<string, unknown> = {}): SemanticController {
  return {
    builtinModelCached: async () => true,
    builtinEmbedder: () => ({ backend: () => "wasm", download: async () => {} }),
    clearBuiltinModel: async () => 0,
    indexer: () => undefined,
    invalidateIndexer: () => {},
    rebuildSemanticIndex: async () => {},
    buildProgress: () => null,
    subscribeBuildProgress: () => () => {},
    ...overrides,
  } as unknown as SemanticController;
}
