import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidian from "eslint-plugin-obsidianmd";

const baseRules = {
  "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description", minimumDescriptionLength: 8 }],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
};

/**
 * Retarget obsidian's TypeScript-scoped blocks at `src`. Only src is in the
 * tsconfig project, so leaving those blocks matching test/ makes their
 * type-aware rules crash on files without parser services. Blocks that don't
 * mention TypeScript (js, package.json) pass through untouched.
 */
function obsidianForSrc(configs) {
  const mentionsTs = (f) =>
    Array.isArray(f) ? f.some(mentionsTs) : typeof f === "string" && /ts|tsx/.test(f);
  return configs.map((c) => (c.files && mentionsTs(c.files) ? { ...c, files: ["src/**/*.ts"] } : c));
}

export default tseslint.config(
  {
    ignores: ["main.js", "node_modules/**", "*.config.mjs", "*.config.ts"],
  },
  js.configs.recommended,

  // ---- src: the shipped plugin, type-aware + store-reviewed ----
  // Base TS rules, then the type-checked layer (no-floating-promises,
  // no-misused-promises, await-thenable, …), then the store-review ruleset,
  // which deliberately tones a few of them down to match what the Obsidian
  // community-store reviewer actually flags.
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianForSrc(obsidian.configs.recommended),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...baseRules,
      // The store reviewer's pinned plugin version does not enforce
      // sentence-case, and the auto-suggestions mangle proper nouns
      // (OAuth→OAUTH). Off to match the reviewer.
      "obsidianmd/ui/sentence-case": "off",
    },
  },

  // ---- test: linted for correctness, not type-aware ----
  // Tests aren't in the tsconfig project and lean on loose fakes, so the
  // type-checked rules can't run. `disableTypeChecked` is expanded first; the
  // explicit rules below re-assert the correctness checks after it.
  {
    files: ["test/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...baseRules,
      // Use the TS-aware version, not the core rule (which flags type-only usage).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Test doubles legitimately reach for `any` when scripting fake Obsidian
      // surfaces; keep the rule strict in src, relaxed here.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
