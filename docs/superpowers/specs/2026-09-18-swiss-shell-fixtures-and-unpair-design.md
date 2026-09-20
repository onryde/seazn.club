# Swiss shell fixtures, Pair next, and Unpair

Owner-approved in chat brainstorm 2026-09-18 (this session). Greenfield —
no migration of in-flight Swiss fixtures.

## Problem

Swiss today mints **one round at a time** via `swissGen`
(`apps/web/src/server/usecases/stages.ts`). Pair next / Generate refuses
while any fixture on the stage is non-decided
(`STAGE_NOT_READY`: "current swiss round has undecided fixtures").
Organisers cannot schedule courts and times for later rounds until those
rounds exist, which is only after the previous round finishes.

We need:

1. **Generate once** → real fixture shells for all `N` rounds so the run
   sheet can schedule ahead.
2. **Pair next** → seat the next empty round from standings / `pairRound`.
3. **Unpair** → clear the latest seated Swiss round when it has no results
   (new control; Swiss / table stage only — not knockout, page playoff, or
   finals).

## Locked decisions

| Topic | Decision |
| --- | --- |
| Scope | Every `swiss` stage — plain Swiss, Swiss Playoff’s Swiss half, Swiss Knockout’s Swiss half |
| Round budget | Organiser **must** set `config.rounds = N` before Generate (no silent forever-pairing; Playoff/Knockout auto-derive is no longer the authority) |
| First Generate | Mint empty shells for rounds `1…N`; does **not** seat Round 1 |
| Pair next | Fills the lowest unseated round; Round 1 also needs an explicit Pair click |
| Shell count | Locked at Generate from active field: `⌊entrants/2⌋` boards per round + one bye shell if odd |
| Roster | No adds after tournament start; shells are not recomputed |
| Unpair | Swiss-only; latest seated round only; refused if any **played** result exists (Pair bye awards do not block) |
| Existing data | Greenfield — ignore mid-event Swiss; one behaviour for everyone |
| Approach | Shell fixtures **in place** (real `fixtures` rows with null entrants), not a separate schedule entity |

## Current behaviour (traced)

- `POST /stages/{id}/generate` → `generateStageFixtures` → for `kind === "swiss"` calls `swissGen`.
- `swissGen` pairs **one** round (`maxRound + 1`), throws if any existing fixture is not in `DECIDED` (`decided` / `finalized` / `forfeited`).
- Swiss Playoff (`pairing: "rank_adjacent"`) may derive and persist `config.rounds` via `swissRoundsForFieldSize` on first generate; plain fold Swiss leaves `rounds` null.
- Stage rail (`stage-rail.tsx`): Swiss always labels the generate button `schedule.pairNext` even when there are zero fixtures.
- No unpair / clear-sides API exists for any format.

## Design

### Lifecycle (Swiss stage only)

**Preconditions**

- `config.rounds = N` with `N ≥ 1`. Generate returns **422** if missing.
- Active field fixed at Generate time.

**Generate fixtures** (first successful mint)

- Insert fixture rows for rounds `1…N`.
- Per round: `⌊entrants/2⌋` boards (`home`/`away` null) + bye shell if odd.
- `ext_key` pattern unchanged in spirit: `sw-r{R}-b{B}`, `sw-r{R}-bye`.
- Status `scheduled`. Court / `scheduled_at` allowed while sides are null.
- Does not run `pairRound`. Idempotent: a second Generate with shells already
  present does not duplicate rows; it becomes the Pair-next path (below).

**Pair next**

- Target = lowest `round_no` that still has any unseated board.
- Readiness: ignore **unseated** fixtures. Block only if the previous
  **seated** round still has a non-decided seated fixture.
- Run existing standings + `pairRound` (including `rank_adjacent` when set);
  write sides onto that round’s shells; resolve bye shell to the existing
  forfeited award pattern.
- If every round is already seated, return an empty/no-op create set (or a
  clear “already paired” outcome — implementer picks the existing generate
  diff shape).

**Unpair** (new)

- `POST /stages/{id}/unpair`.
- Allowed only when `stage.kind === "swiss"`. Otherwise **422**.
- Target = highest seated round.
- Refused if any **non-bye** fixture in that round is decided / finalized,
  or has score events. A Pair-minted bye award (`forfeited` + `outcome.kind
  award`) does **not** block Unpair — it is seating, not a played result —
  and Unpair clears it back to an empty bye shell. Pin the “has a played
  result” predicate to one shared helper.
- Clears home/away on boards; bye award → empty bye shell again.
- Keeps `round_no`, `seq_in_round`, `ext_key`, court, `scheduled_at`.
- Knockout, page playoff, and any finals stage: **no** Unpair control and
  **no** successful API.

### Data rules

**Seated**

- Board seated: both sides set, or bye shell has an award winner.
- Round seated: every board in that round is seated.

**Completion**

- Stage complete only when rounds `1…N` are all seated **and** every seated
  fixture is decided.
- Unseated shells ⇒ not complete.

**Desk / public**

- Unseated shells render as TBD on the run sheet (scheduling works).
- They do not count as live / in-play until seated.
- Pair-next readiness and “current round undecided” must not treat future
  empty shells as blockers (this is the behavioural break from today).

### API / UI

| Surface | Behaviour |
| --- | --- |
| `POST /stages/{id}/generate` | No shells → mint `1…N`. Shells exist → Pair next |
| `POST /stages/{id}/unpair` | New; Swiss-only; latest seated round; no results |
| Stage rail — Swiss, `fixtureCount === 0` | **Generate fixtures** |
| Stage rail — Swiss, unseated round remains | **Pair next** |
| Stage rail — Swiss, latest seated round has no results | **Unpair** |
| Knockout / page playoff / finals | Unchanged; no Unpair |

i18n: every new user-facing string in all four locale dictionaries.

**Round budget authority:** organiser-set `config.rounds` for every Swiss
stage. Gallery / wizard may still *suggest* a default from
`swissRoundsForFieldSize` into the settings field before Generate; the
generator must not invent or overwrite `rounds` as today’s Playoff path
does. Remove (or no-op) the auto-persist of derived rounds in `swissGen`
so Settings remains the single source of truth.

### Out of scope

- Unpair for knockout, page playoff, double elim, or any finals stage.
- Recomputing shell counts after roster changes.
- Separate schedule-slot entities.
- Migrating or grandfathering live mid-Swiss competitions.
- Auto-pairing Round 1 on Generate.

## Testing (required — all four)

**Unit**

- Shell mint: N rounds × boards (+ bye) from field size; refuses without `rounds`.
- Readiness ignores unseated future shells; blocks on undecided previous seated round.
- Pair seats exactly one round; Round 1 requires Pair.
- Unpair clears latest seated round; refuses with results; refuses non-Swiss.

**Regression**

- Old “any `scheduled` fixture blocks Pair” must not return with future shells present.
- Completion still waits until all N rounds are seated and decided.
- Swiss Playoff / Knockout Swiss half use the same Generate / Pair / Unpair rules.

**E2E**

- Generate → assign court/time on a TBD shell → Pair R1 → score R1 → Pair R2 → Unpair R2 → Pair R2 again.

**Smoke**

- Plain Swiss (and one of Playoff or Knockout): Generate mints `N × boards`; Pair seats R1 while later shells remain unseated and do not 422.

## Primary code touchpoints (expected)

- `apps/web/src/server/usecases/stages.ts` — `swissGen` / generate write path; new unpair use-case
- `apps/web/src/app/api/v1/stages/[id]/generate/route.ts` — behaviour split documented above
- New `apps/web/src/app/api/v1/stages/[id]/unpair/route.ts` (+ OpenAPI)
- `apps/web/src/components/v2/desk/stage-rail.tsx` — Generate vs Pair vs Unpair labels/actions
- Locale dictionaries + `i18n-keys.ts`
- Tests beside existing `swiss-playoff-pairing.test.ts` / `swiss-knockout-shape.test.ts` / `swiss-rounds.test.ts`
- `scripts/smoke.ts` Swiss Knockout suite extended or sibling Swiss shell suite

Exact line numbers will move; treat paths as ownership, not citations to freeze.
