# W2 — sport scoring fidelity

**Goal.** When this wave is done every sport produces a result every format can
consume: a level knockout match always has an honest way to finish, walkovers
and retirements credit what the federation says, stage-level deciders and match
format are set on a screen for every sport, and an organiser can shorten a
final's match format before it starts — without any finished fixture changing.
It is the input layer every later wave stands on.

## Read first

- `_RULES.md` (R5–R9, R15–R17, R24, R28) and `_INDEX.md` (rulings 6, 10, 11, 12).
- Design §2, §4 (M3, M5, M6, M11, X3 "built in W2", E axis), §5 (customisation
  levels; the fixture override and its ~11 `resolveFixtureCfg` callers), §7.1,
  §7.2, §7.3 (V347 freeze invariant), §8 (W2 row), §10, §11 (O4, O5, O6, O8),
  §12 ("inert fixture override").
- Audits: `audit-2026-09-27/SC-scoring.md` (whole), `ST-standings.md` (G1, G2,
  G10, G16, G31), `FX-fixtures.md` (G23), `plan-facts-sports.md`.
- W1d's triaged ❌ list for W2 (in `_INDEX.md`).
- `w2-coverage-audit.md` (this directory, 2026-09-30): the controller's engine → rulebook → generator audit behind the binding
  checklist below. Every engine claim in it carries a file:line reference; it was read, not driven.

## Binding checklist (from W1c; ruling 42)

The owner's direction (ruling 42, 2026-09-30) is "don't miss any possibilities": every sport's rule-level
possibilities must be enumerated, and each must be owned by a wave. The rows below are the controller's audit, not
owner rulings (class 17). The authority for each row is `w2-coverage-audit.md` (this directory, 2026-09-30,
read-only, with file:line for every engine claim). `_INDEX.md` ("W2 checklist") carries the same
list; a row that changes changes in both.

The audit covers 11 sports and 183 result-level possibilities (all 11 sports have a rulebook section). It found 14
ABSENT from W2, 9 stated only in prose, and 19 in-match mechanics with no row.

**1. ABSENT from both W2 rulebooks.** Each gets a verdict row, or a named gap with its owning wave, before rulebook
sign-off:

- **Badminton.** The sanction ladder is record-only: a penalty awards no rally, and a DQ does not end the match.
- **Table tennis.** A sanction's penalty point is not awarded (record-only).
- **Volleyball.** Sanction penalty, expulsion and DQ are record-only: no point is awarded, and there is no
  incomplete-team ending.
- **Tennis.**
  - `sanction{level:"default"}` does not end the match, and point/game penalties are record-only.
  - The `tennis.game.award` (penalty game) seam.
- **Cricket.**
  - `points.draw` for two-innings draws.
  - Innings victory (`innings_and_runs`).
  - Follow-on.
  - Innings forfeiture.
  - Timeless innings (NRR quota, all-out charge).
  - Penalty runs.
- **Football.** An own goal credits the opponent.
- **Hockey.** A team reduced below `strength.min` has no ending rule (it shows only a display chip).
- **Generic.** `progressScore` is declared and stored, with no effect (an inert seam).

**2. Stated in prose only (PARTIAL): each needs a verdict row.**

- **Cricket.**
  - The ODI 20-over minimum.
  - Abandon during a super over → tie.
  - A manual (non-DLS) revised target.
  - A two-innings abandon → draw.
- **Football.** The `youth` variant.
- **Hockey.** The `youth` variant.
- **Boardgame.** Abandon → `replayFlagged`.
- **Carrom.**
  - The `club-29` variant.
  - Drawn games inside a won match.

**3. In-match mechanics with no row (19).** Each is either a W2 row or an explicit "not W2, owned by …":

- **Badminton.** Serve rules.
- **Table tennis.** Time-outs.
- **Volleyball.** Technical time-outs, substitutions and libero.
- **Tennis.** Interruptions.
- **Cricket.**
  - Batter retire (hurt / out).
  - The DRS allowance.
  - `maxOversPerBowler`.
  - Powerplay, free hit, new ball and toss.
  - The wicket modes.
  - Lineup changes and concussion replacements.
- **Football.**
  - Sin bin.
  - The in-play penalty-kick record.
  - Substitutions (rolling, max, concussion, windows).
  - `periodSeconds` / `addedMinutes`.
- **Hockey.**
  - Suspension classes (green / yellow / red).
  - Goalkeeper required or optional, and the PC / stroke set pieces.
- **Ice hockey.**
  - Suspensions (minor / major / misconduct), and `releaseOnGoal` for power plays.
  - Strength 5/3.
- **Carrom.** Toss and first break. This one is covered by text §5.1.

**4. Generator reach: W2's plan must include a generator-breadth task BEFORE its truth run.** Today, no generator in
`scripts/matrix/lib/streams/` emits any of these:

- any decider: extra time, shoot-out, overtime, GWS, super over, DLS;
- ~~a cricket tie;~~ struck by ruling 44 (W1-driving builds it: `streams/cricket.ts` `tied`);
- a deciding set, except at `bestOf: 1`;
- a set cap;
- a tie-break set;
- a partial-score retirement;
- a double walkover;
- an abandon under `abandonPolicy: "award"`;
- any sanction;
- ~~a two-innings cricket win or draw.~~ struck by ruling 44 (W1-driving builds it: `streams/cricket.ts` two innings a side).

Forfeit and abandon are only ever sent straight after `core.start`, at 0–0. A W2 truth run without that task proves
only what the generators already reach, and every row above would read as untested, not as passing.

**5. The same audit before W3–W7.** Ruling 42 applies to every family wave. Before each of W3–W7 writes its plan,
the same engine → rulebook → generator audit runs for its rows. Its ABSENT list becomes that wave's binding
checklist.

**6. Audit items outside the 14/9/19 count.** Ruling 42 still owes each one an owning wave:

- **Goals boards (football, hockey, ice hockey).** `core.suspend` / `core.resume` has no row (`core/events.ts:76-98`;
  the audit's cross-sport table). → **W2**: a verdict row, or a named gap with its wave.
- **Football two-leg aggregate / away goals.** Format-level, not a match rule (audit, the football section).
  → **W4** (recommended; the controller's audit, not an owner ruling).

**7. From the W1c final review (2026-09-30).** Each is routed to W2 by name:

- **`outcomesFor` omits `abandon`** (`pad-adapters.test.ts`, T7 minor 4; final review m-14). W2's generator-breadth
  task adds a non-0–0 abandon, and the pad must then treat `core.abandon` as organiser-only, as it does forfeit.
- **Two value-constant mutants survive the pad unit suite** (T9–11 M-1; final review m-15): `pads/carrom.ts`
  `value: coins` → `9`, and `pads/boardgame.ts`'s method chip → a constant. The generators emit only 9 coins and
  only checkmate/agreement, so add one route case per adapter with a value the generator does not emit.
- **The tennis tie-break guard reads the cfg only** (`pads/tennis.ts:23-25`, T9–11 M-7; final review m-15). The
  product's `isTbShape` also refuses under `mtbTo !== null` and reads per-set rules, so the adapter would over-refuse
  a 7-6 set in an mtb or final-set-rule variant, by name.

## Prerequisites

W1a–W1d and W1-driving merged, and W1d's W2 backlog written (design §8 order, R1; W1-driving's place: ruling 28).

## Scope

A sport-family wave: every sport row that consumes a result. Routed gaps,
copied from design §8:

SC-X1 (knockout tie/no-result stall), SC-X2 (stage deciders with a screen),
SC-X3 (no event to settle an abandoned knockout by lot), SC-X4 (auto-advance
blocked by `abandoned`), SC-P1, SC-P2 (level knockout without a decider), SC-P4
(hockey shoot-out points), SC-P11 (futsal preset), SC-S* (walkover/retirement
set and point credit, tennis impossible sets, tennis Bo1 match tie-break, double
walkover SC-S6) — **enumerate SC-S1…S9 from `SC-scoring.md` at start**, SC-C3
(DLS NRR), SC-O1/SC-O2 (boardgame/generic draws in brackets — the
`supportsDraws` root cause, owned here), ST-G1, ST-G2, ST-G16, ST-G10
(tiebreak validation against the sport + stage tiebreak UI); stage-level match
format for every sport (ruling 12, FX-G23, SC-O8); fixture-level format override
through every `resolveFixtureCfg` caller (§5); division-level lock of
points/tiebreakers per started stage (O8).

Unlisted SC-/ST- gaps on your sports go to you under the §8 preamble — list them
at start and record each assignment in the decision log.

## Lifecycle (design §10)

1. Rulebooks `rulebook-W2-sets-cricket.md` and `rulebook-W2-goals-boards.md`
   (drafts being written in parallel) → **owner sign-off** before step 2.
2. Reference families for the exact-oracle items (walkover credit, NRR,
   points), by a different agent than the engine fixer (R8).
3. Truth run on the sport rows; reproduce before fixing (R5).
4. Plan → implementer → reviewer; TDD; four test types; mutate every guard.
5. Gates (below). 6. No bench gate lines up after W2 (§9). 7. Drive the product,
   PR, e2e on `main` or `workflow_dispatch --ref`.

## Decisions owed (put to the owner as recommendations)

- **O4** fixture-override UI and **O5** stage deciders / match format / points
  / tiebreak UI — ≥2 options shown first (R24).
- **O6** per-case rulings, including build-or-refuse for SC-P11 (there is no
  futsal sport in the 11, §3 — a preset would be a football variant, not a row)
  and for any 🚫 action that arises on your rows.
- **O8** lock division-level points/tiebreakers per started stage — recommended
  in §5, **not yet a ruling**; confirm in the rulebook before building the lock.

## Done when

Ruling 19 on the sport rows: zero ❌ from the gaps above; every other red tagged
⏳ with its owner; nothing previously ✅/⛔ now red anywhere (W3–W7 rows
included — you change their input). Gates §10.5, plus: the fixture override
proven through the real pad and the real standings read, and M11 observed as ⛔.
Every row of the binding checklist is either a verdict row or an explicit "not W2, owned by …", and the generator-breadth
task landed before the truth run.

## Traps

1. **The inert seam** (class 1, §12): an override that reaches `append-event`
   but not `fold`, `competition`, `event-import` or `player-stats` ships green.
   Enumerate every `resolveFixtureCfg` caller by grep `-a`, then prove each.
2. **A collectable field can be worse than an absent one** (class 19): check
   `payload.x ?? cfg.x` precedence. SC-P4 is the model — the declared 3/0 loses
   to the FIH 2/1 the rulebook adopts (§7.1), so the case is ❌ until fixed.
3. **"Cannot happen" comments** (R28): `competition.ts:148` says draws never
   reach a bracket; SC-X1/SC-O5 show `tie` and `no_result` do. Make it a guard.
   A tighter engine guard also changes what the pad offers — re-drive the pad.
4. **Tests lie in their names** (class 4): SC-P6's knockout case folds a cfg
   with no split and proves nothing; SC-S8 pins no set/point credit either way.
5. **Stage decider keys arrive as `z.unknown()`** (SC-P8) and `extraTime` does
   nothing for period sports — validate against the sport schema at create.

## Output and handoff

Update the W2 row, decision log and "False premises found" in `_INDEX.md` as
they happen (R22). Rulebook sign-offs go into "Owner rulings" only when the
owner signs; your recommendations stay in their own section.
