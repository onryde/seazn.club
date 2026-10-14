// Lint config for @seazn/scheduler — packages/engine/eslint.config.mjs with its engine-path blocks (the z3 bridge, the
// reflective walkers, the golden corpora) removed: the generic type-aware base, no-console and ban-ts-comment, and the
// relaxed spec rules. The scheduler owns the gRPC client, so it logs through pino, never the console; only the codegen
// script under scripts/ prints.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { toolsImportRules } from "../../scripts/lib/tools-import-guard.mjs";

const ANY_BOUNDARY_RULES = {
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unsafe-return": "off",
  "@typescript-eslint/no-unsafe-call": "off",
};

export default defineConfig([
  globalIgnores(["node_modules/**", "coverage/**", ".vite/**", ".vite-temp/**"]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    // Ruling 56: nothing here may import a dev-only harness under tools/ (not in the image). One source for the rule:
    // scripts/lib/tools-import-guard.mjs; scripts/__tests__/tools-import-guard.test.ts resolves every import exactly.
    rules: toolsImportRules,
  },

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Only this config file is outside tsconfig.json. `scripts/**` and vitest.config.ts are in its `include`, and a
          // file listed in BOTH places is a hard parse error.
          allowDefaultProject: ["*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A suppression that stopped being needed is a suppression nobody will ever remove. Fail on it rather than warn.
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
      "no-console": "error",
      // A suppression must announce itself (`@ts-expect-error` with a reason).
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
    },
  },

  {
    // Specs: they reach into vitest matchers, and are routinely declared async for symmetry across a table of cases.
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      ...ANY_BOUNDARY_RULES,
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    // The codegen script: printing where the stubs landed IS its output.
    files: ["scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
]);
