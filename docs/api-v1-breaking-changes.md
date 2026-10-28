# v1 public API — breaking changes

Newest first. Each entry names what changed, what replaces it, and what a
consumer sees if it sends the old value.

This file starts at the first breaking change the v1 contract has taken. It
is not a full changelog: additive fields do not appear here, because a reader
that ignores an unknown field is unaffected by one.

## 2026-10-28 — a generic division's config no longer carries `progressScore`

The generic sport (the fallback for a sport Seazn does not model) had a
`progressScore` key in its division `config`, a flag carried over from the v1
stepladder import. Nothing ever read it: it changed no score, no standing and
no screen. It is removed.

**What changed.** `config.progressScore` is no longer part of a generic
division's config. A request that still sends it is not refused: the key is
dropped, and the rest of the config is read as before.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/competitions/{id}/divisions` and `PATCH /api/v1/divisions/{id}`, a generic division's `config` | `progressScore` was accepted (a boolean, default `false`) and stored | accepted and dropped: 200 as before, and the stored `config` has no `progressScore` |
| `GET /api/v1/divisions/{id}`, `config` | `progressScore: false` (or `true`) present | absent once the stored copy is removed (see below) |

**What replaces it.** Nothing: the key did nothing. Stop sending it, and stop
reading it.

**What a consumer sees.** No error. A client that sends the old default
(`"progressScore": false`) keeps working unchanged. A client that reads
`config.progressScore` gets `undefined` where it used to get a boolean.

**Data.** Existing stored copies are removed by W2e's data migration (Task
13b), which runs before the deploy. Until it has run, a stored copy is still
there and still ignored. The generic sport's fold epoch is raised from 3 to 4
(every recorded match state embeds its config), so the server's epoch gate
refuses a native scoring client that still sends epoch 3 for a generic fixture
until it updates.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, decision D6. The pinning test is
`packages/engine/src/sports/generic/w2e-generic.test.ts`.

## 2026-10-28 — a carrom adjustment may not exceed the game target

A carrom umpire adjustment (Laws 51 and 55: a penalty, or points due) moves one
side's score in the open game by a few points. The scorer's app already offers
1 up to the game target (25 in the ICF Laws, Law 56a, and 29 in the club-29
variant) in either direction; the API did not check. Both scoring write paths
now do.

**What changed.** A `carrom.game.adjust` was accepted with any non-zero integer
`delta`. It is now refused when `delta` is more than `gameTo` points either
way (`gameTo` is the match's game target: 25 by default, 29 for club-29, or the
match's own setting). A `delta` of `0` or a fraction was already refused as
`INVALID_EVENT` and still is. A deduction that would take the score below zero
was already refused as `INVALID_EVENT` and still is; the range is judged
first.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events` | accepted, and the open game's score moved by the whole delta | 422, `error.code` `"ADJUST_OUT_OF_RANGE"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import` | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"ADJUST_OUT_OF_RANGE"`, and nothing is written for its fixture |

**What replaces it.** Send a `delta` between `-gameTo` and `gameTo`, not zero.
To move a score further than that, send more than one adjustment, each one
inside the range.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "ADJUST_OUT_OF_RANGE", "message": "an adjustment moves a score by at most the points needed to win the game" }, "requestId": "…" }
```

On the import route, the stream's result (this refusal carries no
`eventIndex`; the other streams in the call are judged on their own):

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "ADJUST_OUT_OF_RANGE" } }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. No recorded
adjustment in the golden corpus (13 across 23 streams) is above 1 point, and an
adjustment already in a match's ledger still replays to the score it recorded.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, rule CA-AD-1 (audit row SC-O9). The pinning test is
`packages/engine/src/sports/carrom/w2e-carrom.test.ts`.

## 2026-10-28 — a board-game result's method must agree with its winner

A chess game is won by checkmate, resignation, time or a second illegal move,
and drawn by agreement, stalemate, insufficient material, repetition, the
fifty-move rule or a dead position (FIDE Laws of Chess Articles 5.1, 5.2 and
9.2 to 9.6). A result that says "won by stalemate" or "drawn by checkmate" cannot
have happened. Both scoring write paths now refuse one.

**What changed.** A `boardgame.result` was accepted with any `method` beside
any `winner`. It is now refused when its `method` is one only a decisive game
ends by (`checkmate`, `resign`, `time`, `illegal_move`) and `winner` is `null`
or left out, or one only a drawn game ends by (`agreement`, `stalemate`,
`insufficient`, `repetition`, `fifty_move`, `dead_position`) and `winner` names
an entrant. `adjudication` can go either way and is accepted in both shapes, and
a result with no `method` has nothing to contradict. `forfeit` and
`double_forfeit` were already refused on write (a chess forfeit is a
`core.forfeit` with a reason, W2b).

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events` | accepted, and the game recorded the winner or the draw as sent | 422, `error.code` `"RESULT_METHOD_CONTRADICTS_WINNER"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import` | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"RESULT_METHOD_CONTRADICTS_WINNER"`, and nothing is written for its fixture |

**What replaces it.** Send a `method` that fits the result: a decisive one with
the winner's entrant id, a drawing one with `winner` `null` (or left out), or
no `method` at all.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "RESULT_METHOD_CONTRADICTS_WINNER", "message": "the method does not fit the result: a win needs checkmate, resignation, time, illegal move or adjudication, and a draw needs a drawing method" }, "requestId": "…" }
```

On the import route, the stream's result (this refusal carries no
`eventIndex`; the other streams in the call are judged on their own):

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "RESULT_METHOD_CONTRADICTS_WINNER" } }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. No recorded
result in the golden corpus (76 across 85 streams) contradicts, and a result
already in a match's ledger still replays to the outcome it recorded.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, rule BG-RS-1 (rulebook RB2B-20). The pinning test is
`packages/engine/src/sports/boardgame/w2e-boardgame.test.ts`.

## 2026-10-28 — a cricket chase total may not pass the winning run

A chase ends at the winning run, and a boundary counts in full (ICC Playing
Conditions 16.5.1 and 16.5.3, MCC Law 16.5). From one run short, the last
delivery can add at most 7 runs: a no-ball hit for six. So a chase total above
the target minus 1 plus 7 cannot have happened. Both scoring write paths now
refuse one.

**What changed.** A `cricket.innings.summary` for the chasing innings was
accepted with any `payload.runs` and is now refused when `runs` is above
target − 1 + 7. The chasing innings is the second innings of a one-innings
match and the fourth of a two-innings match. The target is the other side's
total plus 1, or the revised target once a `cricket.revise` (DLS or a
confirmed target) has set one. In a two-innings match it is the other side's
aggregate lead plus 1. Earlier innings have no bound, and ball-by-ball
scoring (`cricket.ball`) is unchanged.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events` | accepted, and the chase recorded the total | 422, `error.code` `"CHASE_OVERSHOOT"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import` | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"CHASE_OVERSHOOT"`, and nothing is written for its fixture |

**What replaces it.** Send the total the chase ended on. It is at most the
target minus 1 plus 7.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "CHASE_OVERSHOOT", "message": "a chase ends at the winning run — check the total" }, "requestId": "…" }
```

On the import route, the stream's result (this refusal carries no
`eventIndex`; the other streams in the call are judged on their own):

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "CHASE_OVERSHOOT" } }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. A chase total
already in a match's ledger still replays to the result it recorded, and a
void of it is accepted.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, rule CK-CH-1 (rulebook RB2A-22, SC-C4). The pinning
test is `packages/engine/src/sports/cricket/w2e-cricket.test.ts`.

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
