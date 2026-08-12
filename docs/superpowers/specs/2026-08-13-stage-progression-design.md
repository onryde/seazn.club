# Stage progression & TBD fixtures — design (D4)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required. Origin: bench spec §14 item 4.
Sessions: P5 (engine/server), P6 (UI/flow) in the portfolio index.

## Purpose

Tournaments are multi-stage (groups → Super 8 → knockout). Today nothing
carries qualifiers from stage N to stage N+1 — organizers hand-build the
next stage — and next-stage fixtures cannot exist (or be scheduled) until
entrants are known. Two owner rulings (2026-08-13) define v1:

1. **Propose + confirm**, never fully automatic: on stage completion the
   system computes qualifiers per declared seeding rules and shows a
   proposal; the organizer edits/confirms.
2. **TBD placeholder fixtures** (owner's addition): ALL stages' fixtures
   are generated at setup time with placeholder slots ("Winner Group A",
   "3rd best of A/B/C", "Winner SF1"). Placeholders are real, schedulable
   fixtures — the final's court/time can be pinned on day one, like real
   cups. Confirm FILLS entrants into existing fixtures; it never
   regenerates, so an applied schedule survives seeding.

## Design

### Seeding rules (declared on the target stage)

`stages.seeding jsonb`, zod `StageSeeding`:

```ts
{ source: { stageId | "previous" },
  take: Array<
    | { kind: "rankRange", from: number, to: number }          // league/swiss
    | { kind: "topNPerGroup", n: number }                       // groups
    | { kind: "bestNth", nth: number, count: number }           // best 3rds
  >,
  placement: "seeded_map" | "snake" | "rank_order",
  map?: Array<{ slot: string, source: string }> }               // "A1"→"QF1.home"
```

v1 rule set is deliberately this small (covers WC/Euro/T20/league+playoff).
`bestNth` ranking uses the cross-group comparison cascade (points → diff →
for → seed) with the division's tiebreaker vocabulary; unresolved ties are
flagged, never silently ordered.

### TBD slot model

- `fixtures.home_entrant_id` / `away_entrant_id` become nullable for
  not-yet-filled slots; sibling label columns `home_slot_label` /
  `away_slot_label` (text, i18n-pattern keys + params, e.g.
  `{k:"slot.winner_group",g:"A"}` stored as jsonb).
- This EXTENDS the existing intra-bracket mechanism (`winner_to_fixture`,
  `fillSlot`) across stages — one fill pathway, not two: cross-stage fill
  routes through the same slot-filling code path as bracket advancement.
- Generation: `generateStageFixtures` runs for every stage at division
  start; stages with `seeding` produce fully-TBD fixtures whose count/shape
  derive from the rules (e.g. topNPerGroup(2) over 4 groups → 8 slots).
- Scheduling: TBD fixtures schedule exactly like normal fixtures (auto,
  pins, joint plan). Person-level constraints (`crossPersonClash`) skip
  TBD slots until filled — recorded limitation, re-validate on fill.

### Proposal & confirm flow

- `completeStage` (existing) → if any dependent stage declares seeding →
  create `stage_seed_proposals(id, stage_id, computed jsonb, status
  'draft'|'confirmed'|'stale', created_at)`.
- `computed`: ordered qualifier list + slot mapping + tie flags + the
  standings snapshot hash it was derived from.
- `overrideStandings` (existing) marks dependent draft proposals `stale`
  and recomputes.
- `POST /api/v1/stages/{id}/seed-proposal` (recompute), `POST
  /api/v1/stages/{id}/seed-proposal/confirm` (body may carry organizer
  edits; server validates every entrant belongs to the division and each
  slot filled exactly once). Confirm fills slots, emits pino
  `stage_seeded` (stage, proposal id, edits count), and re-runs schedule
  validation so newly-real person clashes surface as warnings.
- Late structure edits (stage size/rules change after generation) remain
  destructive regen — explicit confirm dialog names the fixtures and any
  applied schedule being discarded (the one destructive path left).

### UI (P6)

Stage page panel: proposal table (rank, entrant, source, destination
slot), tie flags requiring a pick, edit-in-place, confirm CTA; TBD
fixtures render their localized labels everywhere fixtures appear (public
pages included). Full polish bar; mobile 320/768/1280.

## Testing (all four)

- Unit: each `take` kind incl. bestNth cross-group cascade (UEFA
  third-place table reproduced), snake vs seeded_map placement, tie
  flagging; fill validation (double-assignment, foreign entrant).
- Regression: confirm does NOT touch `scheduled_at/court/pins` of TBD
  fixtures (the non-destructive guarantee — the reason this design
  exists); stale-proposal on standings override.
- E2E: groups → confirm → knockout filled → schedule intact; edited
  proposal path.
- Smoke: seed → complete → propose → confirm → next stage playable.

## i18n

Slot-label pattern keys ("Winner {group}", "Runner-up {group}",
"{nth} best 3rd", "Winner {match}") + all panel copy, ×4 locales.

## Dependencies & sequencing

P5 before P6. D1 multi-stage templates (P7) encode `StageSeeding` — this
schema is that contract. No dependency on D5/D2/D3. Touches `stages.ts`,
fixtures DDL, schedule validation call — release-2 C-chain owns
`schedule.ts`/proto; overlap is peripheral (one validation call), but
re-pin at plan time. OpenAPI regen owed.

## Risks / re-pin

`fillSlot`/`completeStage`/`getStandings` line numbers from 2026-08-13
scout; re-pin. Nullable entrant columns ripple into every fixture reader —
the plan's scout enumerates readers (public pages, stats, scoring guards:
scoring an unfilled fixture must 422).

## Non-goals

No fully-automatic seeding, no re-draw ceremonies/randomization, no
promotion/relegation across competitions, no best-of-N series.
