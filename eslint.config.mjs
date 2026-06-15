import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidian from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    // Type-aware obsidian rules run against src (the shipped plugin). Tests are
    // covered by `tsc --noEmit` + vitest, and aren't part of the tsconfig project.
    ignores: ["main.js", "node_modules/**", "*.config.mjs", "*.config.ts", "test/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Obsidian community-store review ruleset — the exact checks the store reviewer
  // runs (eslint-plugin-obsidianmd), so CI catches store-review regressions before release.
  ...obsidian.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description", minimumDescriptionLength: 8 }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The store reviewer's pinned plugin version does not enforce sentence-case,
      // and 0.3.0's auto-suggestions mangle proper nouns (OAuth→OAUTH). Off to match.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
);
