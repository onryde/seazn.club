# C5 — z3 stage B: AI repair rounds on CP-SAT

Spec of record: `../2026-08-12-z3-retirement-design.md` (stage B).
Depends on C4.

## Goal

The AI generate → refine → repair loop's z3 repair step becomes a placement
service call: pin what stands, re-solve the violators. End-state repair
engine value: `"optimized"` (enum itself narrows in C7 — here the new value
is added/written, z3 accepted but no longer produced).

## Context that saves you a dead end

z3's own LNS repair was proven to never fire on the prod board even
gate-bypassed — you are replacing the call, not porting LNS. The repair
bench omits hard rules (#455) and identical `k` is the tell — gate on
verifier conflict counts, never on the bench alone.

## File set

The repair-round call site in the AI schedule pipeline (generate/refine/
repair, default on) + the repair-engine recording. Leave the z3 path
compiling until C8.

## Do NOT touch

Reflow (done in C4), public schemas (C7), LLM repair path (`"llm"` stays),
credit/billing accounting around AI rounds.

## Acceptance

- Repair invocation asserts placement client called, no z3 load — fails
  before the switch.
- AI demo (#364) generate → refine → repair e2e loop green.
- Verifier conflict count on repaired boards never worse than the z3 path on
  the same seeds, N ≥ 6.

## Verify

Suites + e2e AI loop + raw conflict counts in PR body.
