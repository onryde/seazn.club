# v1 public API — breaking changes

Newest first. Each entry names what changed, what replaces it, and what a
consumer sees if it sends the old value.

This file starts at the first breaking change the v1 contract has taken. It
is not a full changelog: additive fields do not appear here, because a reader
that ignores an unknown field is unaffected by one.

## 2026-08-17 — the z3 solver leaves the contract

The scheduling stack finished moving onto the CP-SAT placement service. The
solver identifiers that named the old engine are now removed from the wire.

**Removed values.** Three enum members are no longer accepted as input and are
no longer emitted in responses:

| Field | Removed | Replacement |
|---|---|---|
| `solver.engine` — `POST /api/v1/stages/{id}/schedule/auto` | `"z3"`, `"z3+lns"` | `"optimized"` |
| `solver.status` — same endpoint | `"z3_unavailable"` | `"solver_unavailable"` |
| `repair.engine` — `POST /api/v1/divisions/{id}/schedule/ai-plan` and the competition-level equivalent | `"z3"` | `"optimized"` |

**What a consumer sees.** Sending one of the removed values now fails schema
validation at the API boundary with a 422, rather than being accepted. Reading
is unaffected in practice: nothing has emitted any of the three since the
CP-SAT cutover, so no response a live consumer has actually received changes
shape.

**Why the replacements are drop-in.** `"optimized"` and `"solver_unavailable"`
already render through byte-identical user-facing copy in all four locales.
The labels were unified before this removal precisely so that retiring the
older names would be invisible to anyone reading the board rather than the
JSON. `"solver_unavailable"` was added as a distinct identifier rather than a
rename for the same reason — see `BuildStatus` in
`packages/engine/src/scheduling/build.ts`.

**No data migration was required.** These values are response-only telemetry;
no database column, constraint or stored document holds them. That was
verified rather than assumed — the evidence is recorded in the C7 entry of
`docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md`.

**Background.** `docs/superpowers/specs/2026-08-12-z3-retirement-design.md`,
stage D. The solver implementation itself is removed in stage E.
