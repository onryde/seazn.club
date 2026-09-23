# Swiss round 1 pairs top-vs-bottom, with a round-1-only mode pick

Date: 2026-09-22. Status: design approved in chat by the owner, section by
section (C + A; Q1 = round 1 only; Q2 = every Swiss stage; Q3 = audit only;
UI = option A, split button, read-only after round 1).

## Why

Prod division `southend-sports-community / badminton-2026 / men-s-single`
(Swiss Knockout template, 10 seeded entrants) published round 1 as 1v2, 3v4,
5v6, 7v8, 9v10. Verified against prod: the Swiss stage carries
`config.pairing = "rank_adjacent"` (the Hammes preset, stamped by the
`swiss_playoff` / `swiss_knockout` templates, `format-templates.ts:205,230`).

Hammes pairs neighbours by *standings*. In round 1 there are no standings, so
`swissGen` falls back to seed as the rank (`stages.ts:1081`) and neighbours
become seed neighbours: the two top seeds knock each other out first. That
defeats the seeding the organiser entered. Nothing in the UI shows the mode, and
no organiser surface can change it (the generate route reads no body; the only
writes to `stages.config` are rules, rank overrides and ladder order).

## Rulings

1. **C — round 1 is top-vs-bottom by default, on every Swiss stage.** "Round 1"
   means *the round being paired is `round_no = 1`* (`nextUnseatedSwissRound`
   returns 1). Unpair of round 1 therefore re-opens it. From round 2 on, the
   stage's stored `config.pairing` applies exactly as today.
   (Amended 2026-09-22 after the swiss-fix session's overlap review. The first
   draft used "no seated, decided board exists", which is false on every odd
   field the instant round 1 is paired — the bye is minted `forfeited` with an
   award at seat time — so a partly-seated round 1 rescued by Unpair (#831)
   would have fallen back to the stored mode and refused the pick. An ad-hoc
   fixture at `maxRound + 1` cannot move the round number either.)
2. **A — an organiser may pick the mode for round 1 only**, on every Swiss
   stage (plain and Hammes). The pick applies to that one press; it is never
   written to `stages.config`.
3. **Rounds 2+ — no pick.** The server refuses an override (422); the UI shows
   the mode read-only with a hint.
4. **Audit only.** The existing `fixtures_generated` ledger row records the
   round, the effective mode and whether it was an override. No new stored
   setting, no round-header label.

Later rounds follow the stage's stored mode regardless of what round 1 used
(owner confirmed: a round-1 pick never changes the stage's mode).

## Server

### Effective mode — one pure function beside `swissGen`

```
effectivePairing({ override, stored, round }):
  if override !== undefined: return override            // only reachable when round === 1
  if round === 1:            return "fold"              // C
  return stored                                         // unchanged behaviour (absent ⇒ fold)
```

- `rankAdjacent` in `swissGen` becomes `effective === "rank_adjacent"`. The
  `cascadeRank` fill condition (`rankAdjacent && a seated decided board exists`)
  is otherwise unchanged.
- A round-1 override of `rank_adjacent` reproduces today's 1v2 behaviour by
  seed — available on request, no longer the default.
- The engine (`packages/engine/src/scheduling/swiss.ts`, `pairRound`) is
  unchanged.

### API — `POST /api/v1/stages/{id}/generate`

- New optional JSON body `{ pairing?: "fold" | "rank_adjacent" }`, zod request
  schema in `apps/web/src/server/api-v1/schemas.ts`, registered in
  `api-v1/openapi.ts`; `openapi/v1.json` and `v1.public.json` regenerated (CI
  drift check).
- Absent/empty body ⇒ identical to today apart from ruling C. The desk's
  existing `json {}` keeps working.
- `pairing` on a non-Swiss stage ⇒ **422**.
- `pairing` when the target round is not round 1 ⇒
  **422**, message "pairing mode can only be chosen for round 1".
- `pairing` on the very first Generate of a Swiss stage (which mints empty
  shells and seats nobody, `stages.ts:983-995`) ⇒ **422**. An override that
  cannot take effect is refused, not silently swallowed.

### One authority, shared by server and desk

The desk already derives Swiss state client-side from the shared pure module
`lib/swiss-shell.ts` (`nextUnseatedSwissRound`, `latestSeatedSwissRound`), which
`stages.ts` imports too. The pairing rule follows that pattern instead of a new
payload field: a pure `lib/swiss-pairing.ts` holds `effectiveSwissPairing` and the hint builder;
`swissGen` and `stages-panel.tsx` both call it with the round from
`nextUnseatedSwissRound`, so neither re-derives "is this round 1". (First draft proposed
a server-computed `swissPairing` payload; changed while planning, 2026-09-22,
to match the existing pattern and avoid a loader change.)

### Audit

`fixtures_generated` (`stages.ts:2498-2508`) gains
`{ round, pairing: <effective>, override: <boolean>, seated_fixture_ids }` on a
Swiss seat. `override` is true only when the body carried a `pairing` that
differs from the default — picking the default sends no body.

**`fixture_ids` is NOT touched.** It is the Undo contract, not an audit list:
undo turns a `fixtures_generated` into a `fixtures_cleared` whose `fixture_ids`
are DELETEd (`server/usecases/history.ts:203-215, 340-352`). Seating is an
UPDATE of shells that already existed, so listing seated shells there would
make Undo of a Pair next delete the round's fixtures outright. (The spec's first
draft proposed exactly that; caught while planning, 2026-09-22.) The seated ids
go in the new `seated_fixture_ids` key, which no undo path reads — a test pins
that Undo of a Pair next leaves the shells in place.

## UI — option A, split button

`components/v2/desk/stage-rail.tsx` Pair-next control (L421-479), handler in
`stages-panel.tsx` `act()` (L558-625).

```
Phone 320                            Desktop 1280
[ Pair next round │ ▾ ]              [ Pair next round │▾ ]  [Unpair]
[ Unpair ]
```

- **Round 1 (`choosable`)**: ▾ opens a menu of two radio items, the default
  pre-selected, each with its seed hint computed from the active field:
  `Top vs bottom — 1v6, 2v7, 3v8…` / `Neighbours — 1v2, 3v4, 5v6…`. Choosing
  one and pressing Pair sends `{ pairing }` only if it differs from the default.
  Selection resets after every press.
- **Round 2+ (`!choosable`)**: ▾ stays tappable (a disabled control cannot show
  a hint on a phone — no hover). The menu opens read-only: the stage's mode
  with a check, options `aria-disabled`, and visible hint text "Mode is chosen
  in round 1 only." Mode lines: Hammes = "Neighbours on the table (1st v 2nd,
  3rd v 4th…)"; plain = "Top vs bottom within each score group".
- Only rendered while the Swiss stage has an unseated round (`pairingIsNext`).
- Tap targets ≥ 44px; menu is a `radiogroup` with an accessible name; keyboard
  operable.
- Every new string in all 4 locale dictionaries (`dictionaries/{en,fr,es,nl}/
  ui.json`), then `gen-keys` regen of `lib/i18n-keys.ts`.
- One DOM for all widths (`max-md:*` branching), no horizontal page scroll at
  320 / 768 / 1280.

## Tests (each fails without the change)

Unit / integration (`apps/web`, JSON reporter, `.testResults[].name` checked):
- Rewrite the three round-1 cases in
  `server/usecases/__tests__/swiss-playoff-pairing.test.ts` (L193-212,
  L305-328; 8 and 7 entrants) to expect fold. The expected pairing is computed
  by calling the engine's `pairRound` with fold, never a hand-typed table, and
  at least one case must differ between fold and adjacent (8 entrants does).
- New: round-1 override `rank_adjacent` ⇒ 1v2 adjacency.
- New: round-2 override on Hammes and on plain ⇒ 422, and nothing seated.
- New: override on a non-Swiss stage ⇒ 422; on first-Generate shells ⇒ 422.
- New: round 2 on a Hammes stage whose round 1 was fold still pairs by the
  standings cascade (rulings 1 + "later rounds follow the stored mode").
- New: `stages.config` byte-identical before and after an override press.
- New: `fixtures_generated` payload carries `round`, `pairing`, `override` and
  `seated_fixture_ids` on Pair next, with `fixture_ids` still `[]`; and Undo of
  that Pair next deletes no fixture (shell count unchanged).
- New: `effectivePairing` truth table, empty case first (no override, round 1,
  no stored mode ⇒ fold).
- New: ODD field (7): default round 1 is fold with the bottom seed on the bye;
  Unpair then a Neighbours pick still works (the bye's `forfeited` status must
  not close round 1).
- Tighten `packages/engine/src/scheduling/formats-ext.test.ts:127-152` only if
  it is affected (it drives the engine directly, so ruling C should not touch
  it — confirm, do not assume).

Mutation (each must go red): delete the `round === 1` branch; ignore the
override; drop the round-2 422; key `cascadeRank` off `cfg.pairing` again.

E2E (full spec files, never `-g` slices):
- Swiss Knockout, 8 entrants: default Pair ⇒ DB shows 1v5, 2v6, 3v7, 4v8.
- Same field, Unpair, pick Neighbours ⇒ DB shows 1v2, 3v4….
- Round 2: menu opens read-only with the hint; no radio is checkable.
- `mobile.spec.ts` width matrix covers the new control (no clipping, 44px,
  axe clean).

Smoke: extend the existing rank_adjacent smoke (`scripts/smoke.ts:8199,8281`)
to assert round-1 fold pairing, not just seating.

Visual: screenshots at 320, 768, 1280 of the closed button, the round-1 menu,
the round-2 read-only menu — per-screen verdicts.

## Out of scope

- Changing `stages.config.pairing` from the UI (a stage-level mode setting).
- A per-round label on the round header.
- Changing already-paired rounds anywhere: existing divisions keep their
  pairings until an organiser Unpairs and re-pairs round 1.

## Rollout note

For the prod division above: after this ships, the organiser presses Unpair
then Pair next and gets 1v6, 2v7, 3v8, 4v9, 5v10 — no data fix.
