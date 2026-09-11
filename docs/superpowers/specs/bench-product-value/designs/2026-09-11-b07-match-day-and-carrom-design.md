# B07 — match day played by hand, then the carrom pack

Design of record for B07, owner-approved 2026-09-11. Supersedes
`bench-prompts/B07-pack-carrom.md` where the two disagree — the prompt was authored
2026-08-13 and three of its premises are false against the tree.

Programme: `bench-prompts/_INDEX.md` (session rows, status log) →
`bench-prompts/_RULES.md` (standing rules) → `_PACK-PLAYBOOK.md`. Spec of record:
`2026-08-12-scheduler-bench-design.md`. Prior waves' designs:
`2026-09-05-b04-scheduling-layer-design.md`, `2026-09-07-b05-simulation-layer-design.md`,
`2026-09-09-b06-pack-pilot-design.md`.

Every `file:line` below was re-pinned against `main` on 2026-09-11 (worktree base
`5e5ced885`, which includes #773).

## 1. What B07 closes, and why it is two waves

The prompt sheet treats B07 as a pack session: research carrom's thinnest tournament,
encode it, run it. Two owner rulings during the brainstorm changed what the wave is.

**Ruling 1 — the bench proves the product, not history.** Verbatim: *"this bench only
for proving that product works, not trying to create a real world result"*, and *"I don't
want to backtrack or do something where real customer can't do. we don't need to
reproduce exact result"*. Carrom's published record cannot support the prompt's "medalists
exact" oracle without engineering board sequences backwards from known winners — which is
the one thing no customer ever does (§3).

**Ruling 2 — match day is played by tapping the real pad.** Verbatim: *"I want to
simulate like a end user, create match start the match tap, finish first innings, second
inning, then finish"*, then *"doing through the API is waste but it works but never catch
real user exp"*, then *"browser taps must"*.

Ruling 2 is not carrom work. It is missing from every suite: today the bench posts a
pack's events blind (`lib/simulate.ts:254-265` takes `expected_seq` from the array
index), never reads fixture state, never tosses, and **has never finalized a fixture in
the programme's history** — `SETTLED_STATUSES` counts `decided` as settled
(`lib/oracle.ts:1273`), so no run has ever exercised the organiser's sign-off.

So B07 splits, the way B06 did:

- **B07a — match day, played by hand.** A sport-agnostic tap driver, advancement for
  every division, group tables in stage 0, and the B06 leftovers. Proved on `_tiny` and
  by re-running suite 11. No new tournament data.
- **B07b — the carrom pack (suite 10).** Authored against a framework that already plays
  matches like a person.

`PackSchema` is FROZEN (it froze at B06b's merge, #770). Neither wave changes it; §4.4
and §5.6 show how each need is met without a schema change.

## 2. The premises that moved

Recording them is the point (`_RULES.md` §1, AGENTS.md failure class 5).

### 2.1 The prompt's suite sheet asks for a team event the product cannot express

`B07-pack-carrom.md:11` asks for the "ICF Carrom World Cup men's team/singles event". A
carrom team tie is two singles plus one doubles rubber under one result (2024 prospectus,
§3). The product has no such structure: carrom entrants are `individual` or `pair`
(`packages/engine/src/sports/carrom/carrom.ts:816`), and the sub-match column
`fixtures.parent_fixture_id` is reserved and written by nothing
(`packages/engine/src/sports/setbased/tabletennis.ts:5-9`;
`apps/web/src/server/usecases/stages.ts:1808-1812` — zero rows). Both divisions are
therefore singles. The team, doubles and Swiss events are §7A drops, and "team ties are
unmodelled" is a product finding.

### 2.2 Carrom's board limit cannot vary by round

ICF Law 56(b) caps a game at 8 boards **through the pre-quarter-finals** and removes the
limit from the quarter-finals on. `maxBoards` lives only in the division cfg
(`carrom.ts:54`, `z.number().int().positive().default(8)`; no 0/null/"unlimited"), and a
stage overlay can only carry `shootout`/`extraTime`
(`apps/web/src/server/engine-db/stage-cfg.ts:9`); `StageConfig` is a strict object with
no `maxBoards` key (`apps/web/src/server/api-v1/schemas.ts:1009-1041`), so a stray key is
refused outright. The pack runs 8 boards in every round and records the adaptation; the
gap is a product finding.

### 2.3 The published record cannot support "medalists exact" without invention

Research (2026-09-11, full findings and per-claim CONFIRMED/UNCERTAIN tags to be committed
with B07b under `packs/build-packs/data/`):

- **Board-by-board scores are published nowhere, for any ICF edition.** The engine's
  scoring unit is the board (`carrom.board.summary`, `carrom.ts:93-111`), so *every*
  carrom stream is generated whatever the source.
- Across the three candidate editions, **one** singles match has published game scores:
  the 2025 men's final, More beat Srinivas 5-25, 25-11, 25-18.
- The 7th Carrom World Cup (Malé, 2–6 Dec 2025) has the most named, round-labelled
  pairings — about 17 men's and 13 women's — but group composition, the R16 draw and the
  field size are all unknown, and no timetable exists.

A pack that asserted the real podium would need boards engineered to reach known winners
(ruling 1's "backtrack"), and pairings invented for the matches nobody published. Under
ruling 1 the pack instead simulates forward and reports the historical podium beside the
simulated one, ungated.

### 2.4 The bench's own end-user gaps

| step a person takes | product | bench today |
|---|---|---|
| start the division | `POST /api/v1/divisions/{id}/start` (`apps/web/src/app/api/v1/divisions/[id]/start/route.ts:28`); scoring 409s `WRONG_PHASE` before it (`usecases/scoring.ts:224`) | done (`lib/schedule.ts:1385`) |
| read the fixture before scoring | console reads state + events (`components/v2/fixture-console.tsx:418-419`) | never — index is the seq |
| toss | `carrom.toss` tile, phase `pre` (`components/v2/scorepad/v3/skins/carrom.tsx:426`) | no pack has one |
| start the match | `core.start` (`fixture-console.tsx:859`, `components/v2/device-score-pad.tsx:305`) → `in_play` (`server/engine-db/append-event.ts:128`) | in the stream |
| score | `POST /api/v1/fixtures/{id}/events` (`app/api/v1/fixtures/[id]/events/route.ts:11` → `usecases/scoring.ts:83`), pad via `scorepad/transport.ts:223` | blind POSTs |
| game ends | automatic (`carrom.ts:320-355`); the pad sends nothing | n/a |
| finalize | `core.finalize` / `POST /fixtures/{id}/finalize` (`app/api/v1/fixtures/[id]/finalize/route.ts:11` → `scoring.ts:495`); device links refused (`scoring.ts:232-236`) | **never done** |

Also missing framework-side, all found at re-pin:

- **Advancement runs for the first division only** (`lib/suites/run-suite.ts:1676-1678`,
  `:3231`, `:3280`); every other division is batch-imported with no stage step
  (`:3117-3149`).
- **`compareMatches` never compares the loser, and ignores `method` on an award**
  (`lib/oracle.ts:1318-1358`). With unknown opponents this matters: a wrong pairing that
  keeps the same winner passes.
- **Stage 0 cannot check group tables.** A table with a `poolKey` is skipped with
  `standings.pool_unbindable` (`lib/validate-pack.ts:1656-1664`) and `deriveStandings`
  returns only the first pool's rows (`:2032-2166`).
- **The qualifier expectation cannot express group ranks.** It takes every row of a
  no-`poolKey` table, sorted by rank (`run-suite.ts:3249-3258`), and `compareQualifiers`
  requires the same ids in the same order (`lib/advance.ts:148-156`).
- **B06's D4 "the bench asserts its own draw" was never built** — nothing in `scripts/bench`
  reads round-0 pairings back; the claim survives only as a comment
  (`lib/pack-schema.ts:482`).
- **News publishes every fixture of the first division's last stage**
  (`run-suite.ts:4700-4713`), not B06's D6 subset (semis + final published, the rest
  asserted draft).
- **The report's `adaptations` field has no writer** (`lib/report.ts:674`; `provenancePct`
  is written at `run-suite.ts:4849` and is the natural sibling).

## 3. Decisions (owner, 2026-09-11 — do not re-open)

- **D1 — edition: the 7th Carrom World Cup 2025, Malé.** Most recent completed ICF event
  and the largest body of named pairings for both singles events. Rejected: 2022 Langkawi
  (authoritative ICF placings 1–16, but ~3 named matches per division) and 2024 Milpitas.
- **D2 — the bench proves the product, not history.** Real format and real named field;
  results **simulated forward** by a seeded board generator with the ENGINE deciding every
  game; the historical podium is a report-only comparison, never a gate.
- **D3 — no back-fitting, and no new provenance value.** Every stream is `synthetic`
  (`lib/pack-schema.ts:225`: "models no real event at all"). A proposed fourth value
  (`outcome-only`, for "real winner, invented score") was REJECTED: PackSchema is frozen.
- **D4 — real names carry synthetic results.** Accepted knowingly: flagged `synthetic` in
  pack and report, and resident only in a local bench DB.
- **D5 — B07 splits into B07a (framework) and B07b (pack).**
- **D6 — match day is tapped in a browser.** Setup (org, competition, 32 players, stages,
  schedule settings) stays on the API; from match day on, a scorer taps the device pad and
  an organiser taps Finalize and the advancement controls. This overrides the 2026-08-27
  "suites 1–12 are API-first" ruling for this suite only.
- **D7 — registration stays B16's.** B16's only gate (B06b) has merged, so it can run in
  parallel; it now depends on B07a for the tap driver instead of writing its own.
- **D8 — B09 football sets up squads and per-match team sheets through the UI.** Recorded
  in `_INDEX.md`'s B09 row by this wave. Cricket's tap scope (B08 is ~60–80k events) is
  decided with the owner at B08 start.

## 4. B07a — match day, played by hand

### 4.1 App test hooks (attributes only)

Start match, Finalize, Send now, sheet Confirm, the coins field and cookie Accept can be
found only by localised text today, and the generic scorebug halves carry no side marker
(`components/v2/scorepad/v3/guided-sheet.tsx:524`, `:549`; `scorebug.tsx:337`;
`fixture-console.tsx:1090-1095`; `detail-dock.tsx:459-460`). B07a adds `data-testid`s and
`data-side`, plus a testid on the console's device-link control. No copy, no layout, no
locale work; the existing `apps/web/e2e/carrom-pad.spec.ts` switches to them, which is
what proves they are live.

### 4.2 The tap driver (`lib/drivers/scorer.ts`)

Plain `playwright` with its own `assert()`, following B03r's driver
(`lib/drivers/browser.ts:46`, `:67-103`). Per match:

1. **The organiser mints the device link by tapping** it in the console — a real
   match-day action. (`POST /api/v1/fixtures/{id}/device-links`,
   `usecases/device-links.ts:121`, is what the button calls; the bench never calls it
   directly. If the console has no such control, that is a product finding, not a reason
   to fall back to the API.)
2. **The scorer** opens `/score/{secret}` in a fresh context with consent pre-answered
   (`apps/web/e2e/scorepad-a11y-kit.ts:346`), at a **phone viewport (390)**.
3. A per-sport **adapter** turns each pack event into taps. B07a ships `generic`; B07b
   ships `carrom`. Tiles are `[data-tile-id]` (`tile-grid.tsx:293`), sheets
   `[data-role="v3-sheet"]`, choices `[data-choice-option-id]`.
4. **The hold window is used the way a person uses it:** each tap is flushed by the next
   one (`scorepad/queue.ts:353`), and the last is flushed with "Send now" (`:287`). Taps
   are paced at or above the product's own repeat guard, imported from source rather than
   typed. Correctness therefore never depends on the build-time `HOLD_MS`
   (`queue.ts:176-184`).
5. **After each commit:** the newest server event must equal the pack event exactly (type
   and payload, entrant ids resolved), and the status must follow `scheduled` → `in_play`
   at `core.start`, staying `in_play` until the final event and turning `decided`
   **exactly** there. Decided early or late reds.
6. **The organiser taps Finalize** in the console; the status must become `finalized` and
   the pad must no longer mount.
7. Matches in one round run in parallel, one context each, capped at the division's court
   count.

### 4.3 Runner

- Each suite-registry entry declares a play mode per division: `tap | api | import`. The
  default reproduces today's positional behaviour, so suite 11 and `_tiny`'s badminton
  division are untouched and both write paths keep their coverage (`_RULES.md` §3).
- **Advancement runs for every division.** In `tap` mode the organiser does it on the
  division page: complete stage → confirm proposal → generate.
- A `tap`-played fixture must end `finalized`; `decided` alone reds. `SETTLED_STATUSES`
  keeps `decided` for the API paths.
- **News is corrected to D6:** semis and final published, the rest asserted still draft.

### 4.4 Stage 0 and the qualifier order (no schema change)

Group membership is recoverable from the fixture ext key — a pooled round robin emits
`p{key}-rr-r{round}-c{court}` (`usecases/stages.ts:797`;
`packages/engine/src/scheduling/roundrobin.ts:140`) — so stage 0 derives a table per pool
and compares it to `expected.tables[].poolKey` (`lib/pack-schema.ts:1146-1152`), using the
division's tiebreakers or carrom's default cascade (`carrom.ts:516-524`).

The qualifier expectation is computed from those per-pool tables through the documented
progression rule: `topNPerGroup` orders qualifiers rank-before-group — A1, B1, C1, D1, A2,
B2, C2, D2 (`packages/engine/src/competition/progression.ts:124-134`), and `rank_order`
uses that list as-is (`:239-298`). The bench re-implements the rule rather than importing
the product's copy, so the two are independent; a disagreement is a finding either way.

### 4.5 Oracles and report

- `compareMatches` also compares the **loser** and an award's `method`.
- The report gains an adaptations count (writer beside `provenancePct`,
  `run-suite.ts:4849`), a test that renders the certificate-absent row
  (`SKIPPED_NO_HISTORY`, `lib/board.ts:394-405`, `lib/certificate.ts:166-173`,
  rendered `lib/report.ts:1197-1224` — today only the section heading is asserted), and a
  tap-stats section (taps and wall per match, report-only).

### 4.6 Entitlement, proven rather than recorded

Device links are gated on `scoring.device_links`
(`usecases/device-links.ts:128`, 402 for Community). A tap suite therefore provokes the
refusal on a plan that lacks the key — derived from the live catalog through
`lib/dls-gate.ts`'s `PROVOCABLE_GATED_FEATURES` walk, never typed — and then provisions a
plan that grants it. This is the first time the playbook's entitlement item has a real
gate outside cricket's DLS.

### 4.7 Proof

`_tiny`'s generic division tapped, finalized and advanced through the UI
(`d-tiny`: `s-league` → `s-playoff`), on both placement legs; suite 11 re-run on both legs
under the stricter loser check.

## 5. B07b — the carrom pack (suite 10)

### 5.1 Structure

Org "ICF World Cup" → competition "7th Carrom World Cup 2025" → **Men's Singles** and
**Women's Singles**, both carrom, `icf` variant (`carrom.ts:817-823`): 25 points, 8
boards, best of 3, queen 3 capped at 22, `tieBoard: "extra"` — so no draws, matching Laws
56(b) and 57.

16 real named players per division; seeds artificial (2025 finish, then round reached,
then name). Each division: a `group` stage of 4 pools × 4, snake-dealt by seed
(`stages.ts:729-739`), then `topNPerGroup` 2 with `rank_order` into an 8-player
`knockout` with `thirdPlace: true` (`schemas.ts:1016`; `bracket.ts:219-227`, ext key
`se-3p`). 24 + 8 = 32 matches per division, **64 total**.

### 5.2 The board generator (`lib/carrom-sim.ts`)

Seeded per fixture from the pack seed and the ext key; emits `carrom.toss`, `core.start`,
then boards (winner, `opponentCoinsLeft` 0–9, `queenTo`), with a mild per-board edge to
the higher seed. Every board is applied through the engine module (`module.init/apply`,
`outcome() !== null` decides — `packages/engine/src/sport/module.ts:718-724`), so the
engine owns game end at 25 or 8 boards, the extra board, and the queen cap. Generation
stops when the engine says the match is decided.

The builder then derives each pool's table, applies the progression and bracket rules
offline (`bracket.ts:52-64` `seedPositions`), and plays the knockout the same way.

### 5.3 Expected values

All from the pack's own offline fold, never a typed table: every match (both sides plus
game lines), per-pool tables with tie order, the qualifier order, final ranks
(`packages/engine/src/competition/stage.ts:284-350` — a strict total order, QF losers 5–8
by seed), and champions. Specials are declared only where the generated streams actually
produced one (a game decided at the 8-board limit, an extra board); otherwise NO SUBJECT.

### 5.4 Constraints

Barceló Nasandhura, Malé (UTC+5); four boards named "Board 1"–"Board 4" (distinct from
every entrant and official name — the sigil namespace is shared,
`_PACK-PLAYBOOK.md`); 2–6 Dec 2025; ~45-minute slots; **the women's division is
afternoon-only** via per-division `sessionWindows` (`schemas.ts:1594`).

### 5.5 Subjects, honestly named

| oracle | subject |
|---|---|
| champion, tables, final ranks, per-match | both divisions, from the offline fold |
| certificate | **absent** — no timetable exists, so both divisions certify `SKIPPED_NO_HISTORY` and the report row is asserted |
| officials | none published → NO SUBJECT |
| careers | nobody plays both divisions → NO SUBJECT |
| suspensions | carrom has none → NO SUBJECT |
| claims | More, Srinivas, Keerthana accept through the real invitee flow |
| news | men's semis + final published, the rest draft |
| entitlement | the device-link 402, then provisioned (§4.6) |

### 5.6 Report

`0% real (0/64 streams; 64 synthetic)`, the adaptations count, and a **real vs simulated
podium** table per division — report-only. The historical podium rides on the suite entry
(`lib/suites/suite10.ts`) with its sources, not in the pack, so no schema change is needed.

### 5.7 Adaptations (about 12, all recorded in `meta.adaptations[]`)

Team, doubles and Swiss events dropped (§2.1); field scaled to 16; format scaled (the real
event ran groups → last 16); 8 boards in every round (§2.2); artificial seeds; results
synthetic (D2/D3); names as published, some partial; no timetable, so dates and venue are
real and session times invented; officials unknown; the one real scored match unused.

## 6. Gates

Per wave, raw counts pasted from the JSON reporter (never an rtk summary): vitest green,
`typecheck:scripts` 0, eslint 0 via `rtk proxy`, OpenAPI drift empty, and live runs on
**both** placement legs with `--wipe` (`_RULES.md` §2). Unit, e2e, smoke and regression
tests per task, or a named deferral.

A mutation sweep on B07a's new guards, one mutant per surface with the **killer list**
recorded: decided-early, finalized-required, ledger-equals-pack, loser, per-pool table
derivation, qualifier order (with an ordering-differential case, A1,B1 vs A1,A2), news
selection (empty set first), the play-mode default, and the 402 probe.

Screenshots of each match-day step under `--keep`, reviewed before anything is called
done; scorer contexts at 390, organiser at 1280.

Timings are recorded and never asserted (`_RULES.md` §1). If a run reports
`solver_unavailable`, read the placement service's own refusal message first — #773 made
both sides of that wire log the fault.

## 7. Explicitly out of scope

No PackSchema change; no engine or scheduler change; no CI wiring for the bench; no change
to `.github/workflows/e2e.yml`; no registration path (B16); no take-back or correction
flows (B17); no browser-driven setup (B16, and B09 for team sheets); no carrom
reconstruction generator for real scores — there are none to reconstruct.

## 8. Named unknowns, carried rather than assumed

1. Whether the fixture console exposes a device-link control a person can tap. If not,
   that is a product finding and B07a says so rather than calling the API.
2. How the bench signs an organiser in against a production build — B03r's magic-link
   helper reads `login_url`, which a production build does not expose
   (`lib/drivers/browser.ts:81-84`). Re-pin at plan time.
3. Whether the product exposes a carrom player-stat leaderboard; if not, the leaderboard
   oracle is a recorded drop rather than a subject.
4. What one tapped match actually costs in wall time. Nothing in the repo measures it;
   the first live run is the measurement, and it gates nothing.
