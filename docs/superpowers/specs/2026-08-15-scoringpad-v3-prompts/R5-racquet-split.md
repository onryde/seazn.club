# R5 — Racquet split: badminton, table tennis, volleyball

Read `_RULES.md`, `_INDEX.md`, spec §3 rows, §8. Scout re-pins; v2 shared
skin `skins/racquet-skin.tsx` (530 lines) dies at the end of this wave.

**Task:** THREE `SkinDefV3`s (all tapModel **S**), one file each:

- **badminton**: halves = players + rally points; strip = games · server ·
  interval hint; serving NEVER renders "—" (D-17) — derive from the setbased
  kernel's server field; Sanctions minor row.
- **tabletennis**: halves + 2-serve rotation in the strip; bo5/bo7 via cfg.
  First-ever browser coverage (D-13) — its e2e is NEW, not adapted.
- **volleyball**: team halves, set points; rotation/server strip; Timeout +
  Sanction tiles; libero surfaced via the Swap-sheet (FIVB once + position
  lock comes from `lineupPolicy` — refusal copy worded).

Pair entrants (badminton/tabletennis doubles kinds) reuse R4's serve-dot
pattern. Ribbon keys per sport ×4 locales. Free-plan state: recording chip
words the lock (D-7's mechanism, this family was the worst offender BAD-03).

**Register rows owed:** D-7 (this surface), D-13 (tabletennis half), D-17.

**Acceptance:** registry flips all three (mutation-proved); racquet-skin
file DELETED with zero references (`git grep -a` proof); per-sport e2e —
badminton rally to interval, tabletennis rally + rotation, volleyball rally +
set close + libero swap refusal; unit; smoke deferred to R8; screenshots ×3
each; axe each; **gallery + walkthrough sign-off recorded before merge**.
