// Lint config for @seazn/reference — packages/engine/eslint.config.mjs with
// its engine-path blocks (the z3 bridge, the reflective walkers, the golden
// corpora, the benchmarks) removed: the generic type-aware base, no-console
// and ban-ts-comment, plus two import rules for src. Ruling 27 is enforced by
// scripts/reference-boundary.ts; lint is the second layer for one shape only:
//   * no-import-type-side-effects makes an import whose every specifier is an
//     inline `{ type X }` an error (strip-types keeps it as a runtime import of
//     the module; `import type { X }` is erased). Pinned by
//     test/eslint-inline-type.test.ts, which runs this config.
//   * consistent-type-imports (separate-type-imports) flags a type-only name
//     imported as a value. It does NOT refuse the inline form on its own —
//     the rule above does.
// Value imports of the engine, other subpaths and dynamic loads are the
// gate's alone; lint does not try to judge them.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { toolsImportRules } from "../../scripts/lib/tools-import-guard.mjs";

export default defineConfig([
  globalIgnores(["node_modules/**", "coverage/**", ".vite/**", ".vite-temp/**"]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    // Ruling 56: nothing here may import a dev-only harness under tools/ (not
    // in the image). One source for the rule: scripts/lib/tools-import-guard.mjs;
    // scripts/__tests__/tools-import-guard.test.ts resolves every import exactly.
    rules: toolsImportRules,
  },

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

  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "separate-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
]);
