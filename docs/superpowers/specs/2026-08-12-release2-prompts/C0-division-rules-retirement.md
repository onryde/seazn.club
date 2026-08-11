# C0 — retire `division_rules` (proto field 10), one PR

Spec of record: `../2026-08-12-division-rules-retirement-design.md`. Read it
fully; this prompt is the dispatch brief, the spec is the design.

## Goal

Field 10 stops being sent, stops being declared, becomes `reserved`, and the
Python reader dies — zero behavior change (rule_groups path is already
authoritative in prod).

## File set

- `proto/scheduler.proto` — delete field 10 (~:248) + `DivisionRule` message
  (~:159-174); add `reserved 10;` + `reserved "division_rules";` in
  `SolveBuildRequest`; rewrite the rule_groups C1 comment (~:251-262) to past
  tense. Re-pin all line numbers first.
- Regenerated codegen (find the gen task; commit its output; porcelain clean).
- `packages/engine/src/scheduling/build.ts` — remove emission; fix
  doc-comments (~:1131-1144, ~:1700). Also the wire type/encoding in
  `placement-client.ts` if it names the field.
- `services/placement/src/placement/schema.py` — delete
  `_validated_division_rules` (~:426-473) + call (~:577-579);
  `_validated_constraints` loses the two dict params.
- `services/placement/src/placement/model.py` — delete the
  `day_cap_by_division` else-branch (~:889-932) and movable-rest fallback;
  fix the stale ~:283-286 pointer ("that field's own comment" does not
  exist); update docstrings.

## Do NOT touch

Tier names, `BuildConstraints`, the TS verifier, rule-group semantics,
`Fixture` (C1 owns its field 3).

## Acceptance

- Proto descriptor test: field 10 reserved (fails on today's proto).
- Wire-compat test: request bytes containing field 10 parse + solve.
- Build test: emitted request carries no `division_rules`.
- Golden/conformance corpus byte-identical before/after (paste counts).
- Full engine + placement + apps/web suites green — JSON-reporter numbers in
  the PR body, not "tests pass".

## Verify

Engine: workspace vitest with `--reporter=json --outputFile`. Placement:
the service's own test runner (see its README/pyproject). Both suites' totals
pasted raw.
