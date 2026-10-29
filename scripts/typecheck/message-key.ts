// `tsconfig.scripts.json` maps `@/lib/messages` here (its `paths`), for the scripts program ONLY.
//
// `tools/matrix` imports `apps/web/src/lib/match-rules/**` by path, and those files name the dictionary-key type
// `MessageKey` from `@/lib/messages` (W2e Tasks 28 and 33a: every rule field names its copy). Under this program's
// `moduleResolution: "nodenext"` that import fails twice: `@/lib/messages` does not resolve without an extension (TS2307), and
// the real `lib/messages.ts` imports `ui.json` with no `with { type: "json" }` attribute (TS1543). `lib/messages.ts` is imported
// by hundreds of modules and is not a typecheck-config fix to change (the same reasoning as `StreamPackLabelKey`,
// `lib/stream-credit-packs.ts`).
//
// So the scripts program sees the key as a string. Nothing is lost: `apps/web`'s own program (`tsc --noEmit` there, the first half
// of its `typecheck` script) type-checks the very same files against the REAL `MessageKey`, so a key that is not in `en/ui.json`
// is still a build failure. A scripts-program file that imports a VALUE from `@/lib/messages` finds nothing here and fails loudly.
export type MessageKey = string;
