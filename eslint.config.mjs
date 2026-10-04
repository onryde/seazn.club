// Lint config for the repo-root `scripts/` tree — the bench (`scripts/bench`),
// smoke, and the seed/sync/openapi generators — and for `tools/`, the dev-only
// harnesses (`tools/matrix`, @seazn/matrix; ruling 56). The harness is a
// workspace but has no lint script of its own: it was linted here under
// scripts/ before the move and keeps exactly the same rules.
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
    // `scripts/*.ts` and `scripts/build-packs/**` were ignored here until
    // 2026-09-06, on the reasoning that pointing the config at them reported
    // ~500 errors that were not that wave's to fix. They are now linted: the
    // measured 498 came down to 0, and what could not be fixed honestly is
    // relaxed by NAME below rather than hidden behind a path glob. A glob
    // silently absorbs new files; a named list does not.
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ["scripts/**/*.ts", "tools/**/*.ts"],
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
    // The three scripts that predate this gate and read untyped JSON straight
    // off `fetch`. Each has exactly ONE helper whose return type is `any` —
    // `seed-demo.ts`'s `call()`, `seed-fifa2026.ts`'s `call<T = any>()`, and
    // `repro-ai-bracket-frozen-feeder.ts`'s `call()` — and every downstream
    // member access inherits it. That accounts for 205 of the 498 errors this
    // tree carried when the gate was switched on (2026-09-06). The other 293
    // are FIXED, not suppressed: 271 by `eslint --fix`, 20 by hand, and two
    // pinned to named lines in `smoke.ts`, which has the same `call()` shape
    // but keeps all six rules on everywhere else.
    //
    // Relaxed rather than typed BECAUSE typing them means writing ~200
    // response shapes inferred from call sites, for APIs these scripts can
    // only be exercised against with a live server and a seeded database.
    // A wrong shape compiles and then reads as fact, which is worse than an
    // honest `any`. Closing this is per-file work with a clear finish line:
    // give that file's `call()` a real return type, fix what reds, delete its
    // entry here.
    //
    // Every OTHER rule still applies to these files, and no new file joins
    // this list without editing it.
    files: [
      "scripts/seed-demo.ts",
      "scripts/seed-fifa2026.ts",
      "scripts/repro-ai-bracket-frozen-feeder.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
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
    files: ["scripts/**/*.test.ts", "tools/**/*.test.ts"],
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

  {
    // Plain `.mjs`/`.js` under scripts/ are also outside tsconfig.scripts.json
    // (only `scripts/**/*.ts` is included). `recommendedTypeChecked` still
    // matches them via `eslint scripts`, and typed rules then crash without
    // parserOptions.project — same failure mode as the test-file block above.
    files: ["scripts/**/*.{mjs,cjs,js}", "tools/**/*.{mjs,cjs,js}"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-console": "off",
      "no-undef": "off",
    },
  },
]);
