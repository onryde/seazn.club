# Batch score-event import — design (D6)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required; **build after ScoringPad S13
cutover** (scoring-ingest adjacency). Origin: bench spec §14 item 6.
Session: P11 in the portfolio index.

## Purpose

Two customer cases (owner ratified keeping this, 2026-08-13): a club
joining with history — S9 career pages are empty until seasons
accumulate; import fills careers day one — and paper-scoring catch-up
(scored at the venue offline, entered later). Owner rulings: **JSON only**
(no CSV mapping UI), **finished matches only** (no bulk into live
fixtures).

## Design

### API (P11)

`POST /api/v1/divisions/{id}/events/import`

```ts
{ import_id: string,                    // idempotency scope for the whole call
  streams: Array<{
    fixture: { id } | { ext_key },
    events: Array<{ type, payload, at? }> } > }   // envelope vocabulary,
                                                  // seq assigned server-side 0..n
```

Response per stream: `{fixture, status: imported|skipped_duplicate|
rejected, error?, events_appended, outcome?}`.

Semantics:
1. Fixture must be **unstarted** (no existing score_events, not live) —
   else `rejected` with typed code.
2. **Dry-run fold first**: the full stream is folded in-process with the
   division's pinned module before ANY write; fold rejection (or a stream
   not reaching a decided outcome when `core.finalize` present) rejects
   that stream wholesale. All-or-nothing per fixture; other streams in
   the call proceed independently.
3. Append transactionally through the SAME code path as
   `scoreEvent` (hash chain, `match_states` upsert, decided-fixture side
   effects: outcome, standings, stats recompute, auto-draft news) — the
   parallel-ingest-path trap is the named enemy: the import MUST NOT
   reimplement append. One writer, called in a loop, in one transaction
   per fixture.
4. Entitlement gates (`requiredFeatureForEvent`) apply per event type
   unchanged — a free org cannot import ball-by-ball.
5. Idempotency: `(division, import_id, fixture)` unique — replay returns
   `skipped_duplicate` per already-imported stream, appends nothing.
6. Size cap per call (declared constant, e.g. 50 streams / 50k events)
   with a typed 413; callers chunk.

### UI (P11, admin bar only)

`/admin`-grade page under the division: JSON file upload/paste →
per-stream result table (status, error, link to fixture). Functional bar
(staff-only surface per standing rules) — no polish debt owed.

### Format documentation

`content/help` page documenting the JSON shape with a per-sport example —
English-only tree (standing rule: `content/help/**` is exempt from i18n).

## Testing (all four)

- Unit: dry-run gate (invalid mid-stream event → whole stream rejected,
  zero writes), idempotency key semantics, unstarted-fixture guard,
  entitlement rejection.
- Regression: hash chain intact after import (verify chain over imported
  fixture equals a sequentially-scored twin); import → `recomputePlayerStats`
  + `personCareerStats` reflect imported history (the career-page-day-one
  claim, proven); replay import_id = byte-identical DB state.
- E2E: upload page happy path + one rejected stream rendering.
- Smoke: import one finished match into the smoke org; outcome + stats
  + auto-draft news appear.

## i18n

Admin page copy + typed error codes ×4 (admin surface still gets keys —
the exemption is help content, not admin UI).

## Dependencies & sequencing

**After S13** (cutover changes the scoring integration surface this
wraps). Independent of D1–D5, D7. Shares its dry-run-fold contract with
the bench's stage-0 pack validator (same "fold before trust" shape — the
bench plan cites this spec). OpenAPI regen owed. Structured logging: pino
`events_imported` (division, import_id, streams, appended, rejected).

## Risks / re-pin

`scoreEvent` internals (`scoring.ts:81`, `AppendEventRequest`,
`expected_seq` model) re-pinned post-S13. Throughput measurement from the
bench (single-POST loop) may later justify raising/lowering the size cap
— report-driven, not guessed.

## Non-goals

No CSV/spreadsheet mapping UI, no live-fixture bulk append, no
cross-division imports in one call, no import of persons/entrants (that
is seeding, owned by existing flows), no export (exists elsewhere).
