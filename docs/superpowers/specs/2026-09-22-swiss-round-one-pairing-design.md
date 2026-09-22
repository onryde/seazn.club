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
   means *no seated, decided Swiss fixture exists yet* — the same test that
   gates `cascadeRank` today (`stages.ts:1074`). Unpair of round 1 therefore
   re-opens it. From the first decided round on, the stage's stored
   `config.pairing` applies exactly as today.
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
effectivePairing({ override, stored, hasDecidedRound }):
  if override !== undefined: return override            // only reachable when !hasDecidedRound
  if !hasDecidedRound:       return "fold"              // C
  return stored ?? "fold"                               // unchanged behaviour
```

- `rankAdjacent` in `swissGen` becomes `effective === "rank_adjacent"`, so the
  `cascadeRank` fill keys off the effective mode, not the raw config.
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
- `pairing` when the target round is not round 1 (a decided round exists) ⇒
  **422**, message "pairing mode can only be chosen for round 1".
- `pairing` on the very first Generate of a Swiss stage (which mints empty
  shells and seats nobody, `stages.ts:983-995`) ⇒ **422**. An override that
  cannot take effect is refused, not silently swallowed.

### Stage payload for the desk

Each Swiss stage the desk receives gains
`swissPairing: { next: "fold" | "rank_adjacent", round: number, choosable: boolean }`
computed server-side by the same `effectivePairing` (no override) — one
authority; the client never re-derives "has a decided round".

### Audit

`fixtures_generated` (`stages.ts:2498-2508`) gains
`{ round, pairing: <effective>, override: <boolean> }` on a Swiss seat, and its
`fixture_ids` lists the fixtures seated by the press (today it is `[]` on Pair
next, because seating is an UPDATE and `createdIds` only reads `newRows`,
`stages.ts:2331`). `override` is true only when the body carried a `pairing`
that differs from the default — picking the default sends no body.

Before filling `fixture_ids`, grep every reader of `fixtures_generated`
(`division_events` consumers, activity feed, analytics) by the event name — a
reader that treated the empty list as "nothing new" would change behaviour.

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
- New: `fixtures_generated` payload carries `round`, `pairing`, `override`, and
  non-empty `fixture_ids` on Pair next.
- New: `effectivePairing` truth table, empty case first (no override, no
  decided round, no stored mode ⇒ fold).
- Tighten `packages/engine/src/scheduling/formats-ext.test.ts:127-152` only if
  it is affected (it drives the engine directly, so ruling C should not touch
  it — confirm, do not assume).

Mutation (each must go red): delete the `!hasDecidedRound` branch; ignore the
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
