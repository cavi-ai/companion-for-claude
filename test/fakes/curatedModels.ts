import { CLAUDE_MODELS } from "../../src/claude/models";

/** A plugin `claudeModels()` accessor that always returns the curated list. */
export const curatedModels = () => ({ models: () => CLAUDE_MODELS, refresh: async () => false });
