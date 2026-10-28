# v1 public API — breaking changes

Newest first. Each entry names what changed, what replaces it, and what a
consumer sees if it sends the old value.

This file starts at the first breaking change the v1 contract has taken. It
is not a full changelog: additive fields do not appear here, because a reader
that ignores an unknown field is unaffected by one.

## 2026-10-28 — the standings export refuses a table with no results

The standings export used to print the newest stage's stored table, even one
with no rows or one where no result had counted yet. That printed the seed
list as a ranking, with seed 1 shown first. The export now refuses such a
table with its own error code.

**What changed.** `GET /api/v1/divisions/{id}/exports/standings` (PDF and
XLSX):

| Case | Before | Now |
|---|---|---|
| No stored table | 404, `error.code` `"NOT_FOUND"` | 404, `error.code` `"STANDINGS_NOT_AVAILABLE"` |
| Every stored table is empty, or no result has counted in it yet (every row level) | 200, a document with no rows, or with the seed order printed as ranks | 404, `error.code` `"STANDINGS_NOT_AVAILABLE"` |
| The newest stage's table is empty or has no counted result, and an earlier stage's table has results | 200, the newest stage's table | 200, the newest stage table that has results |

The other export kinds are unchanged.

The same date also fixes the standings export for chess and other
half-point tables. The `Pts` cell now prints what the public table prints
(`"1½"`), not the stored half-point count (`3`). In the XLSX it is a text
cell. Whole-point sports keep a numeric `Pts` cell.

**What replaces it.** Key on the 404 status, or on `error.code`
`"STANDINGS_NOT_AVAILABLE"`. Do not key on `"NOT_FOUND"`.

**What a consumer sees.** A division with no standings to print returns:

```json
{ "ok": false, "error": { "code": "STANDINGS_NOT_AVAILABLE", "message": "no standings yet" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** The export reads the stored tables as
they are.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2d (tables and tie-breaks), anti-goal 3 (no row is marked
first on a table with no results) and RB2B-17 (points print in the table's
unit on every surface). The pinning tests are in
`apps/web/src/server/usecases/__tests__/generate-level-table.test.ts`.

## 2026-10-28 — an imported hockey goal must record its type

This extends the 2026-10-27 change below to the bulk import route.

**What changed.** `POST /api/v1/divisions/{id}/events/import` judges every
event in a stream as a new write. A stream that carries a `hockey.goal`
(FIH hockey, every variant) with no `payload.kind` was imported and is now
rejected. Ice hockey and every other sport are unchanged.

**What replaces it.** Send each goal's `kind`, as for
`POST /api/v1/fixtures/{id}/events`. A client that has no way to know the
goal's type should send `"fg"`.

**What a consumer sees.** The call still returns 200, because each stream's
outcome is data. The stream's result is rejected and nothing is written for
that fixture:

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "GOAL_KIND_REQUIRED" } }
```

This refusal carries no `eventIndex`. The other streams in the same call are
judged on their own.

**No data migration was required.** An import only writes to fixtures with no
events yet.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2d (tables and tie-breaks), rule HK-TB-2. The pinning test is
`apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts`.

## 2026-10-27 — a hockey goal must record its type

FIH ranks level teams on field goals (GTR Appendix 3), so a hockey table can
only break that tie if every goal says what kind it was. The scoring endpoint
now refuses a `hockey.goal` that does not.

**What changed.** `POST /api/v1/fixtures/{id}/events` with `type:
"hockey.goal"` (FIH hockey, every variant) and no `payload.kind` was accepted
and is now refused. Ice hockey's `icehockey.goal` and every other sport's goal
are unchanged: their type stays optional.

| Field | Before | Now |
|---|---|---|
| `payload.kind` on `hockey.goal` — `POST /api/v1/fixtures/{id}/events` | optional | required: one of the division's `goalKinds`, by default `"fg"` (field goal), `"pc"` (penalty corner), `"stroke"` (penalty stroke), `"og"` (own goal, credited to the other side) |

**What replaces it.** Send the goal's `kind`. A client that has no way to know
the goal's type should send `"fg"`, which is what an untyped goal was always
counted as.

**What a consumer sees.** An untyped hockey goal now fails with a 422 and
nothing is written:

```json
{ "ok": false, "error": { "code": "GOAL_KIND_REQUIRED", "message": "a goal in this sport must record its type" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. Untyped goals
already in a match's ledger still replay, and count as field goals, so a match
in progress at the change stays readable. A void of such a goal is accepted.
The pinning test is
`apps/web/src/server/engine-db/__tests__/legacy-untyped-hockey-goal.test.ts`.

**Why in place.** This lands in v1 rather than under a new version path
because no client outside the web app uses the API yet (owner, 2026-10-27).

**Background.** W2d (tables and tie-breaks), rule HK-TB-2;
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/`.

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
