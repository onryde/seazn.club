// Lint config for the repo-root `scripts/` tree — the bench (`scripts/bench`),
// smoke, and the seed/sync/openapi generators.
//
// It exists because nothing linted these at all. Root `lint` chained the two
// WORKSPACES (`apps/web`, `packages/engine`) and `scripts/` is not a workspace,
// so ~7k lines of the scheduler bench had no lint gate while B03's own
// acceptance list said "lint clean". Found by asking what that line was
// actually checking.
//
// Deliberately NOT apps/web's config (eslint-config-next: React, JSX, hooks,
// Next-router rules — none of which apply here) and not packages/engine's
// either, since that one is scoped to its own package root. This is the same
// @eslint/js + typescript-eslint shape the engine uses, pointed at scripts/.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "apps/**",
    "packages/**",
    "services/**",
    // Generated: a committed artefact rewritten by `bench:build-packs` and
    // `openapi:gen`. Linting output is linting the generator twice.
    "openapi/**",
    "bench-report/**",
    // The top-level tools and the pack generators are still not linted, and
    // this is a scope line rather than an oversight. Measured 2026-09-06 with
    // `eslint scripts --no-ignore`: 498 errors, 269 of them auto-fixable, and
    // 476 of them in four files — smoke.ts (255), repro-ai-bracket-frozen-
    // feeder.ts (81), seed-demo.ts (77), seed-fifa2026.ts (63). Mostly
    // `no-unnecessary-type-assertion`. Worth fixing; not this change's to fix.
    //
    // Everything NOT ignored here IS now gated. `lint:scripts` was widened
    // 2026-09-06 from `scripts/bench` to `eslint scripts` — which surfaced 4
    // errors in `scripts/i18n`, since fixed — and ci.yml runs it as a blocking
    // step next to the turbo `eslint` one. Before that it was chained only
    // into root `npm run lint`, which CI never invokes, so it ran for nobody.
    // This ignore list is therefore the WHOLE of the remaining gap: 56 of the
    // tree's 81 TS files are gated, these 25 plus build-packs are not.
    //
    // Closing it is a small, separate change: drop these two entries, run
    // `eslint scripts --fix`, and read the remainder. Left undone
    // deliberately, not forgotten.
    "scripts/*.ts",
    "scripts/build-packs/**",
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // `tsconfig.scripts.json` is the same project `typecheck:scripts` uses,
        // so lint and typecheck agree on what these files ARE — node module
        // semantics with explicit .ts specifiers, not the Next bundler's.
        project: "./tsconfig.scripts.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A suppression that stopped being needed is one nobody will remove.
      reportUnusedDisableDirectives: "error",
    },
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
      // These scripts ARE command-line tools; printing is their output. The
      // bench itself logs through pino, but the CLI wrapper prints.
      "no-console": "off",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
    },
  },

  {
    // Test files are EXCLUDED from tsconfig.scripts.json (its own comment
    // explains why: they run under vitest, not `node --experimental-strip-types`,
    // and cannot resolve `vitest` from a root-level project that has no vitest
    // install). A type-aware rule set cannot parse a file outside its project,
    // so these get the untyped ruleset rather than a fabricated second project.
    //
    // This is a real gap and worth naming: it is the same exclusion that makes
    // these files invisible to `typecheck:scripts`, and it already let a
    // renamed field ship as `sport_key: undefined` with the suite green. Lint
    // narrows that gap (unused vars, undefined identifiers) but does not close
    // it — asserting request bodies in the tests themselves is what closes it.
    files: ["scripts/**/*.test.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
      "no-undef": "off",
    },
  },
]);
