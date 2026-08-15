# R6 — Period pair: hockey, ice hockey

Read `_RULES.md`, `_INDEX.md`, spec §3 rows, §8, §11 (clock). Scout re-pins;
v2 shared skin `skins/period-skin.tsx` (857 lines). Each sport gets its OWN
file; a `period-shared.ts` helper lib is allowed.

**Task:** Two `SkinDefV3`s (tapModel **T**). The LCD identity STAYS (owner's
one KEEP from v2 — ICE-03 verdict) and generalises: scorebug halves = side
scores; strip = period · clock · PP countdown (suspension countdown kept —
it was one of S13's five recovered behaviours).

**Kill the always-open goal form (D-8):** Goal is a tile; person/kind land
via the dock; nothing renders a resting validation error. Person chips wrap,
never clip (D-9). **Clock (D-10, spec §11):** decide in-session between
elapsed-derived display and scorer-controlled clock — W4a's time model is
the input; record the ruling in `_INDEX.md`. Discipline: hockey Card tile
(green/yellow/red — FIH cards REDUCE the offender, nobody gains) vs
icehockey Penalty tile (mins + person via dock); the escalation hint and its
translations exist since S13 — reuse, don't remint. Rolling subs recordable
via Swap-sheet (optional at club level — presence, not enforcement).

**Owner-call item (HOC-04b):** card-flow presentation gets an explicit
walkthrough verdict.

**Register rows owed:** D-8, D-9, D-10.

**Acceptance:** registry flips both (mutation-proved); period-skin deleted,
`git grep -a` zero refs; e2e — goal+scorer, penalty with countdown visible,
hockey card escalation, both sports; unit incl. clock-ruling regression;
smoke deferred to R8; screenshots ×3; axe (this family carried the worst v2
contrast fails); **gallery + walkthrough sign-off recorded before merge**.
