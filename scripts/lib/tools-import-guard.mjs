// Ruling 56 (2026-10-04): tools/ holds the dev-only harnesses — tools/matrix
// (@seazn/matrix) today, the scheduler bench later. They CONSUME the product;
// nothing the product builds (apps/, packages/) or the Fly image type-checks
// (scripts/, through apps/web's `typecheck`) may import them. tools/ is not in
// the image at all (.dockerignore), so such an import is a build failure there
// and a dependency the wrong way round everywhere else.
//
// Two layers hold it, and this module is the one source both read:
//   * lint — `toolsImportRules`, spread into apps/web, packages/engine,
//     packages/reference and the root (scripts/) eslint configs. Lint sees
//     specifiers, not files, so it is the coarse layer: any import of a
//     tools/* package, or any relative specifier that climbs (`../`) into a
//     directory named `tools`.
//   * scripts/__tests__/tools-import-guard.test.ts — resolves every import in
//     those trees to a real path, checks package.json dependencies, and pins
//     that TOOLS_PACKAGES below names every tools/* workspace, so a new
//     harness cannot join tools/ without joining this guard.

/** The package names of the tools/* workspaces. The guard test reds when a
 *  tools/* package.json names a package this list does not. */
export const TOOLS_PACKAGES = ["@seazn/matrix"];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** One regex for both shapes: a tools/* package (or a subpath of it), or a
 *  relative specifier that climbs into a `tools` directory. */
export const TOOLS_IMPORT_REGEX = `^(?:${TOOLS_PACKAGES.map(escape).join("|")})(?:/|$)|^(?:\\.\\./)+tools(?:/|$)`;

export const TOOLS_IMPORT_MESSAGE =
  "tools/ is dev-only (ruling 56): nothing in apps/, packages/ or scripts/ may import a harness under tools/ — it is not in the image. Move the shared code into the product, or into scripts/lib, and import it from there.";

/** The rule entry each eslint config spreads into a `rules` block. The
 *  typescript-eslint variant is used so it never collides with a config's own
 *  core `no-restricted-imports` blocks (apps/web has three, and in flat config
 *  a later block's value for the same rule REPLACES an earlier one's). */
export const toolsImportRules = {
  "@typescript-eslint/no-restricted-imports": [
    "error",
    { patterns: [{ regex: TOOLS_IMPORT_REGEX, message: TOOLS_IMPORT_MESSAGE }] },
  ],
};
