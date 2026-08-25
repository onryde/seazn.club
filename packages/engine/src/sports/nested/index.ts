// Barrel for the nested (tennis / padel-later, kernel.ts's own header) sport
// family — R4-3 (owner ruling, `docs/superpowers/specs/2026-08-15-scoringpad-
// v3-prompts/_INDEX.md`) restored.
//
// THE GAP THIS CLOSES. R4-3 put the ITF doubles serve rotation in the
// engine, not the pad, specifically because a pad-side copy of it forks from
// the fold the moment either one drifts. `serveContext` (kernel.ts:511) was
// built for exactly that reason, but shipped with no subpath this package's
// own `package.json` "exports" map could reach: `"./sports/*"` resolves to
// `"./src/sports/*/index.ts"`, and `nested/` never had one — `sports/tennis/
// index.ts` re-exports only the `tennis` VALUE. The R4 tennis skin was built
// against that gap and mirrored the rotation instead (nine functions, each
// citing the kernel.ts range it restated); this file is the fix, and it is
// what let that skin delete five of the nine in one step — `serveContext`'s
// own composition already covers `nestedGamesOf`/`serviceTurnsPerSide`/
// `pairOrderOf`/`expectedPairServer`, so importing the composed answer needs
// no separate re-export of the pieces (`apps/web/.../skins/tennis.tsx`'s own
// header has the full account).
//
// DELIBERATELY NARROWER than `../setbased/index.ts`'s own barrel. That one
// exports a whole preset-factory family for a kernel several sports share;
// this one exports exactly what its one known consumer needs and no more —
// every name added here is public surface forever. Left OUT on purpose:
// - every mutator (`applyPoint` and the rest of the `apply*` family) — a pad
//   has no business calling a fold function directly;
// - `expectedDoublesServer`, `NestedCfg`, `Side`, and every other kernel-
//   private helper `serveContext` itself composes over (`isDecidingSet`,
//   `rulesFor`, `setInProgress`, `nestedGamesOf`, `serviceTurnsPerSide`,
//   `gamesFieldBound`, `tbFieldBound` — none of the seven carries an
//   `export` keyword in kernel.ts, so none of them could be re-exported here
//   without editing kernel.ts itself, which this fix does not do).
// Widening this barrel for a later consumer (a padel skin, or a reader that
// genuinely needs one of the above) is a decision for whoever needs it next,
// not a default to reach for now.
export { serveContext, type NestedState } from "./kernel.ts";
