# R7 — boardgame, carrom, generic + lineup gating + console chrome

Read `_RULES.md`, `_INDEX.md`, spec §3 rows + §4 (all of it), §8. Scout
re-pins; `fixture-console.tsx` (the `{home && away}` gate was :546 at
capture), `lineup-editor.tsx` (:184), universal `pad-renderer.tsx` (412).

**Task A — three thin skins:** boardgame (tapModel **S**: player-name halves
tap = that player wins, ½–½ tile + Method dock; variant strip
classical/rapid/blitz; chess vocab kept — "recorded by the arbiter"), carrom
(**T**: board-summary tiles; strike-by-strike stays PARKED on the T-lane),
generic (**S**: win/loss or score entry per variant — the baseline for what
"no skin" means). Universal-renderer usage for real sports ends here; the
fallback branch is DELETED, and the totality gate proves it.

**Task B — lineup editor, declaration-driven (D-1, D-18):** hidden when
`lineup.size ≤ 1 && benchMax === 0`; position column only for non-trivial
position catalogs (`resolvePositions`, never `positions` directly — the
variant hook exists); role flags only where the module declares them;
pair-order column only for pair entrants whose kernel consumes it (tennis
after R4, setbased three). Fix D-3 here if R4 didn't.

**Task C — console chrome (spec §4):** authority actions visually distinct
from scoring (D-12's console half); ONE audit ledger (the page-level card —
the pad's ribbon is the in-pad history; D-4 closes fully); device handover
moves beside the pad header (D-19); person names for individual/pair
entrants everywhere (D-6 closes fully).

**Register rows owed:** D-1, D-3 (if open), D-4, D-6, D-12, D-18, D-19,
D-13's boardgame half (its first e2e ever).

**Acceptance:** registry flips the last three sports — the LEGACY set is
EMPTY and the gate proves totality on the v3 lane alone (mutation-proved);
chess e2e (result + method + NO lineup editor rendered — assert absence
anchored `="`); carrom device-link e2e kept green; console chrome e2e (undo,
forfeit distinct, handover placement); unit; smoke deferred to R8;
screenshots ×3 incl. 320px console audit density (spec §11); axe; **gallery +
walkthrough sign-off recorded before merge**.
