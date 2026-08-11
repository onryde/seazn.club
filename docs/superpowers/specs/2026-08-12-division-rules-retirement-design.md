# Retiring `division_rules` (proto field 10) — release 2, final

**Date:** 2026-08-12 · **Programme:** #21 contract (C1/C4/C6) · **Status:** approved design, not implemented

## Context

`SolveBuildRequest.division_rules` (field 10, `proto/scheduler.proto:248`) carried
per-division `min_rest_minutes` / `max_fixtures_per_day`. The `rule_groups` field
(field 13, C1) replaced it:

- **Day caps:** the model prefers rule-group caps and reads `day_cap_by_division`
  only in the else branch when no rule group carries a cap (`model.py:882-889`).
- **Rest:** release 1 (#533/#534) made a movable fixture's rest fold in the rule
  groups that cover it; pins were already covered by C4/C6.
- An **empty** `division_rules` is already legal: `_validated_division_rules`
  returns two empty dicts, no error.
- The prod placement service runs the rule_groups contract (owner-confirmed
  2026-08-12), so nothing deployed depends on field 10 being populated.

Stale pointer found during design: `model.py:283-286` says the field's own proto
comment holds the three-release retirement plan. No such comment exists — the
plan prose lives on the `rule_groups` field comment (`proto/scheduler.proto:251-262`).
This spec collapses the remaining two releases into one; both deploy orders are
safe (below), so the extra release buys nothing.

## Decision — one PR, full kill

1. **`packages/engine/src/scheduling/build.ts`** — stop emitting
   `division_rules`; update the doc-comments that describe the dual-emission
   window (around lines 1131-1144 and 1700).
2. **`proto/scheduler.proto`** — delete field 10 and the `DivisionRule` message
   (lines 159-174); add `reserved 10;` and `reserved "division_rules";` inside
   `SolveBuildRequest`; rewrite the `rule_groups` C1 comment to past tense.
3. **Codegen** — regenerate TS and Python stubs.
4. **`services/placement/src/placement/schema.py`** — delete
   `_validated_division_rules` (426-473) and its call site (577-579);
   `_validated_constraints` loses the two dict parameters.
5. **`services/placement/src/placement/model.py`** — delete the
   `day_cap_by_division` else branch (around 889-932) and the movable-rest
   fallback; fix the stale 283-286 pointer; update docstrings that describe
   `rest_by_division` / `day_cap_by_division` as live inputs.

**Behavior change: none.** The rule-group path is already authoritative in prod.

**Verifier: untouched.** The TS verify path reads org config, not the wire, so
this change cannot fork placer and verifier.

## Deploy-order safety (one PR, two separately deployed apps)

- **Web first:** the new build.ts sends no field 10; the deployed Python still
  reads it, gets an empty repeated field, returns empty dicts, and the
  rule-group path governs — today's behavior.
- **Placement first:** the old build.ts still sends field 10; the new Python has
  no such field, so proto3 parses it as an unknown field and ignores it.

Either order is safe; no coordination step needed.

## Tests

- **Wire-compat (protects the deploy window):** a serialized request containing
  field 10 bytes still parses and solves after the field is reserved.
- **Failing-without-the-change:** proto descriptor test asserts field 10 is
  reserved; build.ts output test asserts the request carries no
  `division_rules`.
- **Parity evidence (implementation-time, one-off):** run the golden corpus
  before/after — identical boards; audit that every division rule build.ts
  emitted was mirrored by a rule group carrying the same numbers.

## Out of scope

- Any change to rest/day-cap semantics.
- The `round` field on `Fixture` (separate spec) — it claims field 3 on
  `Fixture`, unrelated to `SolveBuildRequest` field 10.
- z3 removal, #512 objective work (separate specs).
