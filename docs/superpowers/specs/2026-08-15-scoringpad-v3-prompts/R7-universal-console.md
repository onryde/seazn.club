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

## Inherited from R2 — do not re-derive

All of R3–R6's inherited block applies to your three skins as well (read it in
`R3-football.md`: `phase?(view)`, `when`/`candidates`, `sheets` as a method,
the `(t) => SkinDefV3` factory, `contextOverrides`, `fidelityEntitlements`,
ribbon keys in `PAD_LABEL_KEYS`, and the e2e/gallery grep). Additionally:

- **D-4 is still fully open — R2 did NOT close it.** The R2 brief listed it as
  owed, but the duplicate Activity ledger is console-level and R2 was barred
  from console chrome; spec §8 already assigns the row R1/R7. R2 closed D-5
  only (the pad's ribbon renders words, not payload dumps), so what remains is
  exactly the page-level duplication: consolidate to ONE audit ledger, with the
  pad's ribbon as the in-pad history.
- **Enforce the tile-hierarchy convention.** "Forfeit/Abandon are not
  representable in the tile grid" is STILL only a comment, with no type or
  runtime block (R1's item; R2 changed nothing here — cricket simply declares
  no such tile). Console chrome is where the enforcement belongs, and it is the
  other half of D-12.
- **The 44px floor on 40px minor tiles rides on a 2px `::before` bleed**, which
  any ancestor with `overflow: hidden` silently clips back to 40. Console chrome
  wraps the pad — do not introduce one.
