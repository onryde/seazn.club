// Lint config for @seazn/reference — packages/engine/eslint.config.mjs with
// its engine-path blocks (the z3 bridge, the reflective walkers, the golden
// corpora, the benchmarks) removed: the generic type-aware base, no-console
// and ban-ts-comment, plus one rule that makes ruling 27's statement form a
// lint error as well as a gate violation (scripts/reference-boundary.ts):
// a type-only engine import must be a separate `import type { … }` statement,
// never an inline `{ type X }`, which strip-types keeps as a runtime import.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["node_modules/**", "coverage/**", ".vite/**", ".vite-temp/**"]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Only this config file is outside tsconfig.json.
          allowDefaultProject: ["*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A suppression that stopped being needed is a suppression nobody will
      // ever remove. Fail on it rather than warn.
      reportUnusedDisableDirectives: "error",
    },
  },

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The reference is a pure library: it returns values, it does not print.
      "no-console": "error",
      // A suppression must announce itself (`@ts-expect-error` with a reason).
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
    },
  },

  { files: ["src/**/*.ts"], rules: { "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "separate-type-imports" }] } },
]);
