// Types for scripts/lib/tools-import-guard.mjs, so scripts/__tests__/tools-import-guard.test.ts
// type-checks under tsconfig.tools-tests.json (W1d item 7, D9) instead of reading its imports as
// TS7016 `any`. Declares exactly the .mjs's four exports; the eslint configs that spread
// `toolsImportRules` are plain JS and read the .mjs itself.

/** The package names of the tools/* workspaces. */
export const TOOLS_PACKAGES: string[];

/** One regex source for both shapes: a tools/* package (or a subpath of it), or a relative specifier that climbs into a `tools` directory. */
export const TOOLS_IMPORT_REGEX: string;

export const TOOLS_IMPORT_MESSAGE: string;

/** The rule entry each eslint config spreads into a `rules` block. */
export const toolsImportRules: {
  "@typescript-eslint/no-restricted-imports": ["error", { patterns: { regex: string; message: string }[] }];
};
