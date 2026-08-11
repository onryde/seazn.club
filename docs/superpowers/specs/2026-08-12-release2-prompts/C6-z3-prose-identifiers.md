# C6 — z3 stage C: prose, docs, internal identifiers

Spec of record: `../2026-08-12-z3-retirement-design.md` (stage C).
No dependencies — safe to run whenever, including first.

## Goal

Comments, docs, and internal function/module names stop saying z3 where the
code no longer means z3. Zero behavior change.

## The one rule that matters

**Never touch a persisted or public enum VALUE.** `"z3"` / `"z3+lns"` in
`schemas.ts:1016`, `:2190`, `openapi/v1.public.json`, stored board rows, and
the demo fixture belong to C7. An identifier that is also a stored value is
C7's, full stop. If renaming something would change a wire byte, a DB row, or
an API response, put it back.

## File set

`git grep -a -i z3` across docs/, comments, internal symbol names. Judgement
call per hit: historical docs (shipped-wave records, this programme's specs)
stay; live prose that misleads gets fixed.

## Do NOT touch

Anything in C4/C5/C7/C8's file sets; help content (`content/help/**` is one
English tree — edit only if a page actively lies about z3 today).

## Acceptance

- Suites green, zero snapshot churn, `git grep` diff of remaining z3 hits
  pasted in the PR body grouped as: stays-for-history / owned-by-C7 /
  owned-by-C8.

## Verify

Full suites (JSON numbers); no drift-gate output changes.
