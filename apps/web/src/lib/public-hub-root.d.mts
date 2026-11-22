// Types for public-hub-root.mjs. The app's tsconfig reads the .mjs through allowJs, but tsconfig.scripts.json (nodenext,
// no allowJs) also checks api-v1/capture-schemas.ts, which imports it by relative path for the bare-node OpenAPI
// generator — without this file that check fails TS7016. Typed as plain strings: the values are spelled in the .mjs only.
export declare const PUBLIC_HUB_ROOT: string;
export declare const LEGACY_PUBLIC_HUB_ROOT: string;
