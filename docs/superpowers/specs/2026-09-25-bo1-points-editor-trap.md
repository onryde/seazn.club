# Best-of-1 points editor trap — one "Points to win" field

Date: 2026-09-25. Branch `fix/bo1-points-editor`, worktree
`.claude/worktrees/bo1-points`, off `origin/main` `90786bb1d`.

## The defect

Sets-kernel sports (badminton, table tennis, volleyball). The engine plays
the last possible set to `finalSetTo` (`setTarget`,
`packages/engine/src/sports/setbased/kernel.ts:447-449`: `setIndex ===
bestOf-1` ⇒ `finalSetTo`). With `bestOf: 1` the only set IS the last, so
`setTo` is never read. The rules editor (`SPORT_RULES` in
`apps/web/src/lib/match-rules.ts`, rendered by `MatchRuleFields` in
`components/v2/match-rules.tsx`) still offers "Points to win a set" (`setTo`)
on best of 1 — the field an organiser naturally edits, and it does nothing.
The field that counts, "Points in the deciding set", looks like an extra.

Found in review of PR #872 (per-stage rules public format label).

## Owner ruling (2026-09-25): Option A

On best of 1 the editor shows ONE points field, "Points to win"; saving
writes the same number to BOTH `setTo` and `finalSetTo`; the deciding-set
field is hidden. Reopen shows `finalSetTo` (the value actually played), so
existing data with mismatched values reads truthfully and is repaired on the
next save. Cap validation unchanged. NO engine change.

Rejected: B (keep both, grey out the dead one) and C (engine plays Bo1 to
`setTo` — changes the meaning of every existing config and frozen snapshot).

Out of scope: tennis Bo1 + match tie-break (set shape ignored) — different
editor shape, not ruled.

## Constraints

- Three editors share the fields: Fixture Console stage format
  (`stages-panel.tsx`), division settings (`division-settings.tsx`), division
  builder (`division-builder.tsx`). All three must behave the same.
- Stage editor hydrates a rules FRAGMENT where absent keys mean "inherit the
  division" (`RuleField.read` doc). "Is this best of 1?" must use the
  EFFECTIVE bestOf (the fragment's value, else the inherited division value),
  and the single field must not pin keys the organiser never touched.
- Rule field labels are canonical English by ruling (per-stage rules D4); any
  new panel chrome string owes all 4 locales + gen-keys.
