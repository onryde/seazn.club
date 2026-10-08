# Format matrix W2a — brackets always finish (design)

- **Date:** 2026-10-08 · **Programme:** format × sport matrix, wave W2 (sport scoring fidelity), sub-wave **W2a**
- **Status:** design approved section by section in chat (2026-10-08); this written spec awaits owner review.
- **Worktree / branch:** `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a`, `feat/format-matrix-w2a`
  (from `origin/main` `7dd45eeab`).
- **Read with:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`,
  `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` and `_INDEX.md`, design
  `2026-09-27-format-matrix-design.md` §8 and §10, rulebooks `rulebook-W2-goals-boards.md` (RB2B-n) and
  `rulebook-W2-sets-cricket.md` (RB2A-n).

## 1. Why, and what done means

The W1d truth run (baseline `47f210e`) left **77 red cases in two gaps, both one root cause: a level result is
accepted as final in a bracket stage and the bracket stalls.**

- **SC-O1**: 65 cases, boardgame `blitz` across 19 bracket formats.
- **SC-O2**: 12 cases, generic, where `supportsDraws` is a deny-list that misses `page_playoff`, `ladder` and
  `americano`.

Code read at `7dd45eeab` (scout, 2026-10-08) widened the root cause:

- The knockout guard (`apps/web/src/server/engine-db/append-event.ts:335-346`) checks only `kind === "draw"`.
  `tie` and `no_result` commit on a bracket fixture and seat nobody (`engine-db/competition.ts:144-163`, whose comment
  says they "never reach a bracket" — false, R28).
- When the guard does fire, it refuses the write. Match config freezes at the first event (V347), so a football
  knockout that reaches full time level with no shoot-out configured cannot record full time at all.
- No event exists to settle a level or abandoned bracket fixture (`packages/engine/src/core/events.ts:100-108`).

**Owner value:** no cup match can ever end as "TBD". The scorer can always record the end of play, and the organiser
always has one obvious action to finish a stuck bracket match, with an honest public record of how it was decided.

**Done when:**

1. The 77 cases are ✅.
2. `matrix:judge regression` against the committed W1d baseline shows **no new red anywhere**. That includes the
   W3–W7 rows, because this wave changes their input.
3. NEW-H1 is reproduced and fixed, or recorded as a false premise.
4. Every rule in §3 has a signed row in `packages/engine/rules/` and a test that names it.
5. The gates in §9 pass.

## 2. Scope

### 2.1 W2 decomposition (owner, 2026-10-08)

W2 is split into five sub-waves. They run strictly in sequence; each has its own spec, plan and PR, and its rulings
are signed at its own start:

| Sub-wave | Content |
|---|---|
| **W2a** | Brackets always finish (this spec). |
| **W2b** | Walkover, retirement and double-walkover credit. |
| **W2c** | Stage-level rules with a screen, the fixture override, and O8. |
| **W2d** | Tables and tie-breaks. |
| **W2e** | Sport-specific fidelity and the rest of the W2 checklist. |

RB2A-1 (BWF 3×15, effective 2027-01-04) sits in W2e. If W2e has not merged by **2026-12-01**, it ships as a small
standalone PR then.

### 2.2 In W2a

- SC-O1, SC-O2, SC-X1 (bracket tie/no-result stall) and SC-X3 (no event to settle an abandoned knockout).
- SC-O5 (generic draw advice) as far as the refusal copy goes.
- NEW-H1 (RB2A-29).
- The W2 checklist items W2a touches:
  - §4 generator reach for deciders, abandon at a real score, and settle;
  - §7: `outcomesFor` gains abandon, and the carrom/boardgame value-constant cases.
- The rules reference `packages/engine/rules/` (seeded).
- The reference model's first family, `bracket-finish`.

### 2.3 Deferred, each with its owner

| Item | Owner | Why |
|---|---|---|
| RB2B-1: refuse creating a bracket stage with no decider; football/hockey/ice-hockey default deciders | W2c | No screen to set a stage decider exists until W2c. |
| Chess "games per match" (2 classical) and per-stage tie-break rung configuration | W2c | Stage-level match format. |
| RB2A-31's refusal of a walkover after an abandon | W2b | Walkover credit is fixed there; refusing now removes a path before settle is known. |
| RB2A-30: joint winners in a cricket final | W4 | Two champions break the single-champion model (`finalRanks`). |
| Chess `double_forfeit` as a loss for both (RB2B-15) | W2b | Until then it folds to `no_result` and lands in `needs_decision` (§5.4). |
| Tennis tie-break guard reads cfg only (checklist §7) | W2e | Tennis. |
| Auto-walkover of a held (`needs_decision`) bracket fixture when one side withdraws | W2b | Preflight ruling C17 (controller, 2026-10-08): in W2a a withdrawal leaves the held fixture `needs_decision` (the bracket withdrawal cascade skips it), a settle naming the withdrawn entrant is refused, and the organiser settles for the remaining entrant. Walkover credit is W2b's. |
| Recording armageddon colours on the tie-break (`black: EntrantId`) and enforcing BG-KO-2 in the engine | W2c | Ruling 82: W2a drops the "Drawn — Black advances" choice. The scorer always taps the winner, and the armageddon step shows a hint that a draw means Black advances. |

## 3. Rulings this spec implements

All of these were signed by the owner in chat on 2026-10-08, and are recorded in `_INDEX.md` "Owner rulings" as
71–79. Rule ids refer to §6.

| # | Ruling | Rule ids |
|---|---|---|
| 71 | W2 decomposition into W2a–W2e (§2.1); BWF 3×15 in W2e with the 2026-12-01 fallback. | — |
| 72 | **A bracket match never ends level.** In a bracket stage, `draw`, `tie` and `no_result` are never a decided result; only a decider or a settle completes the fixture. One core **settle** event for every sport: organiser-only, records who advances and why (`lot`, `higher_seed` — higher seed or higher group finisher — or `organiser`), never invents a score, and also closes an abandoned bracket fixture. Draws are allowed only in league, group, swiss and americano (ruling 78). The pad hides Draw in brackets. RB2A-31's walkover refusal is deferred to W2b. | X-BR-1, X-ST-1, X-DR-1 |
| 73 | **Chess knockout = RB2B-16 option A, narrow, with a scorer-recorded tie-break.** The drawn bracket game leaves the fixture open (tie-break phase); the scorer records `boardgame.tiebreak` with rung `rapid`, `blitz` or `armageddon`, the winner, and an optional score. **Lots is not a rung**: drawing lots is the organiser's settle (`lot`). Rung configuration and games per match go to W2c. | BG-KO-1, BG-KO-2 |
| 74 | Other sports in brackets: carrom always plays the ICF extra board (RB2B-23); generic refuses a draw and the scorer enters the winner, with no shoot-out advice (RB2B-28); a cricket knockout tie or no-result is closed by settle (RB2A-17); RB2B-1's refusal goes to W2c and RB2A-30 to W4; NEW-H1 is reproduced before it is fixed. | CA-KO-1, GN-KO-1, CK-KO-1 |
| 75 | **A rules reference lives in the engine:** `packages/engine/rules/`, with a checker test (§6). | — |
| 76 | **Approach A** (§4): deciders are match-config phases declared per sport and applied by stage kind; settle is owned by the kernel and produces a `win` with a method. | — |
| 77 | **One server-side organiser check** for `core.settle`, `core.forfeit` and `core.abandon`. Scorers and remote-scoring devices are refused. | X-ST-2 |
| 78 | The draw allow-list includes **americano**: the rule is "no level result where someone must advance". | X-DR-1 |
| 79 | **Hold, don't refuse.** A play-produced level result in a bracket is saved with the new fixture status `needs_decision`: not decided, nobody seated. Refusal remains only for a generic draw. | X-BR-1, X-BR-2 |

Interface decisions (owner, 2026-10-08; the mockups are wireframes for flow only, and the build applies house
UI/UX):

- **UI-1:** settle is reached through a "Needs a decision" block on the fixture console (option A).
- **UI-2:** the chess tie-break is entered in three steps on the pad (option B, revised).

Rulings recorded after this spec was written (`_INDEX.md`, 2026-10-08):

- **80:** the execution model for W2a: per-dispatch Opus/Sonnet choices, as tabled in the plan.
- **81:** the plan's tooling, batching and CI additions:
  - the hand-mutant runner and changed-lines Stryker;
  - local truth runs on the W2a cells only;
  - batched loops and parallel lanes;
  - heavy checks once, on CI.
- **82:** plan approval, with three answers:
  - (a) V431 backfills legacy bracket rows stored `decided`/`finalized` with a level outcome to `needs_decision`;
  - (b) the armageddon "Drawn — Black advances" choice is dropped from W2a (BG-KO-2 is enforced by a pad hint; colours go to W2c, §2.3);
  - (c) the console and pad layouts are the ones chosen here (UI-1 option A, UI-2 option B), and the owner gives a per-screen verdict on the built screens before merge.

## 4. Architecture (approach A)

Three rejected alternatives, recorded so nobody re-derives them:

- **(B) commit the level result as decided, then overwrite it.** Commits a level result in a bracket and fires
  seating twice.
- **(C) a new `settled` outcome kind.** Every consumer would have to learn it, for no user-visible gain. Hold it
  unless the review finds "win + method" ambiguous somewhere.
- **Refuse the level-producing write** (the first draft of section 2). It stops the scorer recording the end of play.

```
scorer/pad ──append──▶ append-event.ts ──resolveFixtureCfg(+bracketDeciders by stage kind)──▶ engine fold
                              │                                                   │
                              │◀── outcome: win | (level in bracket) ─────────────┘
                              ▼
     status = decided ──▶ onDecided ──▶ seat winner/loser (unchanged)
     status = needs_decision ──▶ console "Needs a decision" ──▶ organiser core.settle ──▶ win{method} ──▶ decided
```

## 5. Components

### 5.1 Engine: core layer (`packages/engine/src/core/`)

- **`core.settle`** `{ winner: SideId, method: "lot" | "higher_seed" | "organiser", note?: string }`:
  - It is added to `CORE_EVENT_SCHEMAS` and `CoreEv`.
  - The **kernel** owns it, like `void`, `suspend`, `resume` and `lineup` (`events.ts:742`), not the 8 sport
    handlers.
  - It is in `POST_DECISION_CORE`, so it is accepted after a result.
- **Precondition** (otherwise a named refusal, `SETTLE_NOT_APPLICABLE`) — ONE engine predicate,
  `settleApplies(module, { outcome, abandoned, state })`, which both the kernel and the console (§5.5) call
  (preflight ruling C12, controller, 2026-10-08). It is true when the fold's effective outcome (`outcomeOf`) is
  `draw`, `tie` or `no_result`; **or** the outcome is `null` and either the stream holds an active `core.abandon`
  or the sport module declares a decider pending (`awaitingDecider(state)`: boardgame phase `tiebreak`, where lots
  is the organiser's settle, ruling 73). The fixture's status stays `in_play` during the tie-break phase.
  - A settle naming a **withdrawn** entrant is refused `SETTLE_NOT_APPLICABLE` (reason `withdrawn`); the organiser
    settles for the remaining entrant (preflight ruling C17). The engine does not know entrant status, so the
    server's write guard checks it (§5.4).
  - A second settle is refused: after the first one the outcome is `win`.
  - A settle on a fixture that already has a winner is refused.
  - A `void` of the settle restores the prior state (the existing void semantics; tested).
- **Result:** `win{ winner, method: "settled_lot" | "settled_higher_seed" | "settled_organiser" }`. The score is left
  untouched. It is a `win`, not an `award`, so `bracketWinnerLoser` and `advancingSides` seat **both** winner and
  loser: the double-elim losers' bracket and the third-place match need the loser.
- **Not stage-aware:** the stage-kind restriction lives on the server (§5.4). The engine checks only the outcome
  shape, the active abandon, and the module's pending-decider hook.

### 5.2 Engine: sport modules

- **`bracketDeciders(cfg): Partial<Cfg>`** is added to the module interface (`sport/module.ts`).
  - It returns the config changes a bracket stage applies on top of the resolved cfg.
  - The empty object is a legal declaration and is tested as one (R13).
  - Declarations in W2a:

    | Sport | `bracketDeciders` |
    |---|---|
    | boardgame | `{ tiebreak: true }` |
    | carrom | `{ tieBoard: "extra" }` |
    | generic, badminton, table tennis, volleyball, tennis | `{}` |
    | football, hockey, ice hockey, cricket | `{}` (organiser-configured deciders stay as they are until W2c) |
- **Boardgame:**
  - cfg gains `tiebreak: boolean` (default `false`).
  - When it is true, a `boardgame.result` with `winner: null` moves the match to phase `tiebreak` instead of folding
    an outcome.
  - New event `boardgame.tiebreak`
    `{ rung: "rapid" | "blitz" | "armageddon", winner: SideId, score?: string }`:
    - It is accepted only in phase `tiebreak`, and folds to `win{ winner, method: "tiebreak_<rung>" }`.
    - The scorer always records the winner, including after a drawn armageddon game. BG-KO-2 ("a drawn armageddon
      game is won by Black") is enforced in W2a by the pad's hint on the armageddon step, not by the engine
      (ruling 82). Recording armageddon colours goes to W2c (§2.3).
    - `score` is optional and validated as a chess score (digits and `½` either side of an en dash).
  - Pad spec: a tie-break panel in phase `tiebreak` only.
  - Fidelity band: unchanged.
- **`supportsDraws` becomes an allow-list** in generic and boardgame: `league | group | swiss | americano` (ruling 78).
  - Boardgame keeps true for those kinds; generic additionally requires `cfg.allowDraws`.
  - Carrom's existing allow-list gains `americano`, and is checked by the same sweep.
  - Football, cricket and the period kernel already use allow-lists (league, group, swiss). Each gains `americano`
    only if the offered matrix (`audit-2026-09-27/offered-matrix.md`) offers that sport in americano; otherwise it
    is unchanged. The plan records which, with the citation.
- **Tests that pin the stall** are rewritten. Their expected values come from the rule rows, not from the code:
  - `boardgame.test.ts:159-163` (draws true in knockout and double elim);
  - `generic.test.ts:142-146`;
  - the carrom `tieBoard` cases at `carrom.test.ts:157-170`.

### 5.3 Engine: rules reference (`packages/engine/rules/`)

See §6.

### 5.4 Server (`apps/web/src/server/`)

1. **Bracket deciders applied by stage kind.**
   - `BRACKET_KINDS = knockout | double_elim | stepladder | page_playoff | ladder`. It is a single exported constant
     in the engine's core types, and its empty and full cases are tested.
   - `resolveFixtureCfg` (`engine-db/fixture-cfg.ts` / `stage-cfg.ts`) merges `bracketDeciders(cfg)` when the
     fixture's stage kind is in `BRACKET_KINDS`.
   - **Every caller is enumerated** with `grep -a "resolveFixtureCfg"` across `apps/web/src`. At least: append-event,
     fold, competition, event-import, player-stats and replay. Each gets a test that the bracket decider reaches it
     (trap 1, the inert seam).
   - The V347 freeze still applies: the deciders are part of the frozen cfg from the first event.
2. **Status rule.** `fixtureStatusFromFold` takes the stage kind. The order of checks:
   1. An active `core.settle` → `decided`.
   2. An active `core.abandon` → `abandoned`. This is unchanged, and keeps the 2026-09-21 "stuck and visible"
      ruling for unsettled abandons.
   3. A level outcome (`draw | tie | no_result`) in a bracket kind → **`needs_decision`**.
   4. Otherwise as today.

   `nextStatus` and `replay.ts` share the rule (one rule, two callers).
3. **Write guard** (`append-event.ts:335`):
   - A generic `draw` in a bracket kind is refused with `LEVEL_RESULT_IN_BRACKET`. The message carries "enter the
     winner" guidance and no shoot-out advice.
   - `DRAW_NOT_ALLOWED` remains for non-bracket stages whose sport refuses draws.
   - Every other level result in a bracket is **accepted** and held as `needs_decision` (ruling 79).
   - `core.finalize` on a held fixture (status `needs_decision`, or a level outcome in a bracket kind) is refused
     with `LEVEL_RESULT_IN_BRACKET`. The fixture is settled first. The console hides Finalize while the fixture is
     held (§5.5; plan finding 27).
   - A `core.settle` whose `winner` is an entrant with status `withdrawn` is refused `SETTLE_NOT_APPLICABLE`
     (reason `withdrawn`), and nothing is written (preflight ruling C17; the auto-walkover is W2b's, §2.3).
4. **Seating guard.** The comment at `engine-db/competition.ts:144-150` becomes an assertion.
   - A `draw`, `tie` or `no_result` reaching `bracketWinnerLoser` or `advancingSides` throws `LEVEL_RESULT_SEATED`.
     It is reached only through a bug, so it is tested by forcing the case.
   - `onDecided` is not called for `needs_decision`. A test proves that nobody is seated, and that settle then seats
     both sides.
5. **Organiser check** (`usecases/scoring.ts:501-562`):
   - `core.settle`, `core.forfeit` and `core.abandon` are added to the set refused for scorer and device-link
     authority, next to `core.finalize` and `core.void`.
   - It is one shared constant, and the pad's client-side `AUTHORITY_ONLY_EVENT_TYPES` (`pad-host.tsx:727`) imports
     the same constant, so the two cannot drift.
6. **`needs_decision` everywhere a status set is listed.**
   - It is a new value in the `fixtures.status` check constraint (`db/migration/v2-engine/tables/V214__fixtures.sql:22`),
     added through a new delta migration.
   - Every status set in SQL and TS is enumerated with `grep -a` and classified, among them `LOCKED_FIXTURE_STATUSES`,
     the V354 slot consumption, the V355 results views, the V367 courts history, the desk's attention and phase
     rules, the public status lines and the bracket view.
   - The classification is: played, not finished, needs attention.
   - **Backfill (ruling 82).** The same delta migration moves legacy bracket rows stored `decided` or `finalized`
     with a level outcome (`draw`, `tie`, `no_result`) to `needs_decision`. Nobody was seated from them, and they
     can then be settled.
   - **A list the sweep found but did not classify is a failure** (anti-vacuity: the sweep reports its count).
7. **NEW-H1** (`usecases/stages.ts:3657` `feederIsDead`): `status === "abandoned" && outcome === null` treats a
   scorer's abandon in the set sports and tennis as a dead feeder, which walks the opponent through.
   - It is reproduced first (§8).
   - If it reproduces, the fix is to tell a scorer's abandon from a generator void, by the presence of an active
     `core.abandon` event versus a `cancelled` status. The exact predicate is decided in the plan from the
     reproduction.
   - If it does not reproduce, it goes to "False premises found".
8. **API.** `AppendEventRequest.type` is already `z.string`, so settle passes through. Run `openapi:gen` to confirm
   no drift. The `PublicFixtureOutcome.method` string gains the new method values in documentation only.

### 5.5 App UI (`apps/web/src/components/`)

The UI follows the wireframes, built in the house design: v2 components, `btn` classes and tokens, the existing
dialog pattern (`TextPromptDialog`), the pad's v3 skins and the phone-composition spec (`AGENTS.md`). It is checked
with the frontend-design skill.

- **Fixture console** (`components/v2/fixture-console.tsx`):
  - A **"Needs a decision"** block shows above the action row iff the stage is a bracket kind **and** the engine's
    `settleApplies` (§5.1) is true for the fixture — the same predicate the kernel's settle precondition calls, fed
    the effective outcome, whether an abandon is active in the ledger, and the module's pending-decider hook
    (preflight ruling C12; it supersedes plan finding 19's status-based condition). So it shows for
    `needs_decision`, for an active scorer abandon with no outcome or a level one, and for a chess game in phase
    `tiebreak` (status `in_play`); never for a generator's event-less void. Its copy reads "A knockout match can't end level. Choose who advances." and it
    has a **Settle the match** button.
  - The dialog asks:
    - who advances: two entrant buttons;
    - why: radio buttons for drawn by lot, higher seed / higher group finisher, and organiser decision;
    - a note: optional.
  - Confirming sends `core.settle`. The block shows for organisers only.
  - While the block shows, Finalize is hidden, and the server refuses it with `LEVEL_RESULT_IN_BRACKET` (§5.4 item 3).
- **Pad** (`components/v2/scorepad/v3/`):
  - The pad receives the stage kind. Today it is stage-blind (`skins/boardgame.tsx:381`, `skins/generic.tsx:176`).
  - Generic and boardgame hide Draw in bracket kinds.
  - The boardgame skin shows the **three-step tie-break** in phase `tiebreak`, with Back on each step:
    1. "Which tie-break decided it?" — Rapid, Blitz or Armageddon. The step also says "Decided by lot? Ask the
       organiser to settle the match."
    2. "Who won the <rung> tie-break?" — two entrants, always; the scorer taps the winner. On the Armageddon rung,
       the step shows the hint "In Armageddon a draw means Black advances." It does not show on Rapid or Blitz
       (ruling 82; BG-KO-2).
    3. An optional score, then Record.
- **Public surfaces** (`lib/scoring-vocab.ts` `renderDecidedOutcome`, `server/public-site/match-centre.ts`
  `resultMsg`, `competition-hub.ts` status line, `components/public-site/bracket.tsx`):
  - "<name> advanced on lot", "<name> advanced as higher seed", "<name> advanced by organiser decision",
    "<name> won on rapid tie-break (1½–½)" (and the blitz and armageddon equivalents), and the status
    "Needs a decision".
  - No score is ever invented: the result line keeps the level score.
- **Strings:** all four locales (`dictionaries/{en,fr,es,nl}/`), then `pnpm i18n:gen-keys`.
- **Verification:** each changed screen is checked at 1280, 768 and 320 with a written verdict per screen and no
  horizontal page scroll. The phone pad change is also checked by a control-set diff at 320 against 1280.

### 5.6 Harness (`tools/matrix/`) and reference model (`packages/reference/`)

1. **Generator breadth, before any truth run** (checklist §4, the W2a part):
   - `streams/boardgame.ts`: a drawn bracket game followed by each rung, with each side winning.
   - `streams/generic.ts`: winner-only results in bracket kinds.
   - `streams/carrom.ts`: a level bracket match reaching the extra board. This removes the "deferred to W2" refusal.
   - `streams/cricket.ts`: a knockout tie with super over off, then settle; and a no-result, then settle.
   - Every sport: a bracket abandon at a real score (not 0–0), then settle.
   - Football, hockey and ice hockey: a level knockout result with no decider → `needs_decision` → settle.
   - `streams/index.ts`: `OutcomeUnreachable` uses the new allow-list and `BRACKET_KINDS`.
2. **Model** (`model/state.ts`): `COMMAND_KINDS` gains **Settle**, an organiser command. A rule-10 fast-check
   sequence checks the invariants after every step:
   - no bracket fixture is decided with a level result;
   - a `needs_decision` fixture seats nobody;
   - a settle seats both sides.

   A shrunk failure is committed as a named regression case with its seed **before** its fix (R29).
3. **Pad adapters and page objects:**
   - `pads/boardgame.ts` drives the three-step tie-break.
   - A console page object drives the "Needs a decision" block and its dialog.
   - `outcomesFor` gains abandon as organiser-only (checklist §7).
   - One route case per adapter with a value the generator never emits: carrom `coins` ≠ 9, and a boardgame method
     outside checkmate/agreement (checklist §7).
4. **Reference model — first family, `bracket-finish`.** It is written from the signed rule rows by **a different
   agent than the engine fixer** (R8), and imports nothing from `apps/web` (R7). For each bracket fixture's event
   stream, it gives:
   - the expected fixture status (`decided`, `needs_decision` or `abandoned`);
   - who advances and by which method;
   - which writes are refused.

   Its first case is the empty one: a bracket with zero fixtures.

## 6. The rules reference (`packages/engine/rules/`)

- `README.md` defines a rule row: a stable **id**, the **rule**, its **citation** (federation article or "product
  rule"), its **status**, **enforced at** (engine and app paths) and **proved by** (test path(s) or matrix case
  ids). A status is one of:
  - `signed <ruling> <date>`;
  - `deviation <ruling> <date>`;
  - `⬜ open`.
- One file per sport, plus `cross-sport.md`. W2a seeds only:
  - `cross-sport.md`: X-BR-1, X-BR-2, X-ST-1, X-ST-2, X-DR-1;
  - `boardgame.md`: BG-KO-1, BG-KO-2;
  - `carrom.md`: CA-KO-1;
  - `generic.md`: GN-KO-1;
  - `cricket.md`: CK-KO-1.
- **Checker test** (`packages/engine/test/rules-reference.test.ts`). It parses every row, asserts that it parsed at
  least one (zero is a failure), and asserts:
  - every id is unique;
  - every `signed` or `deviation` row names at least one proving test;
  - each named test file exists and contains the id string.
  - It is mutated once per check.
- **The wave rulebooks are frozen** as research drafts. `_INDEX.md` rulings get one-line pointers to rule ids. The
  engine-split session must learn that `rules/` moves with the engine: the owner tells it, or this session sends it
  as a recommendation, never as "the owner decided" (class 17).

Rule texts (seeded rows):

| id | rule |
|---|---|
| X-BR-1 | In a bracket kind, a fixture is decided only by a win (from play, a decider, a forfeit or settle). `draw`, `tie` and `no_result` are never a decided result. |
| X-BR-2 | A play-produced level result in a bracket kind is held as `needs_decision`: not decided, nobody seated. |
| X-ST-1 | `core.settle` applies only to a level outcome, an abandon with no outcome, or a chess bracket game awaiting its tie-break (lots is the organiser's settle), and never names a withdrawn entrant (preflight rulings C12, C17). It records the winner and the method (lot, higher seed, organiser), invents no score, and seats winner and loser. |
| X-ST-2 | `core.settle`, `core.forfeit` and `core.abandon` are organiser-only on the server. |
| X-DR-1 | Draws are allowed only in league, group, swiss and americano, and only where the sport allows them. |
| BG-KO-1 | In a bracket, a drawn chess game goes to a tie-break (rapid, blitz, armageddon), recorded by the scorer; lots is the organiser's settle. Status `signed 73 2026-10-08`; citation "product rule following FIDE knockout practice (World Cup regulations, secondary source — re-read before citing it as federation text)". |
| BG-KO-2 | A drawn armageddon game is won by Black. |
| CA-KO-1 | A bracket match always plays the ICF extra board (Law 56), whatever the division's `tieBoard`. |
| GN-KO-1 | A generic bracket fixture refuses a draw; the scorer enters the winner. |
| CK-KO-1 | A cricket knockout tie with no super over, or a no-result, is held and closed by settle (higher group finisher or lot, ICC 16.10.5–16.10.6). Joint winners: W4. |

## 7. Error handling

| Code | When | Surface |
|---|---|---|
| `LEVEL_RESULT_IN_BRACKET` (409) | A generic draw in a bracket kind; or `core.finalize` on a held fixture (plan finding 27) | Pad: "Enter the winner — a knockout match can't end level." |
| `SETTLE_NOT_APPLICABLE` (409) | Settle where `settleApplies` is false (not level, not an active abandon with no outcome, no pending tie-break), on an already settled fixture, or naming a withdrawn entrant (ruling C17) | Console dialog closes and shows the reason. |
| The code `scoring.ts` already returns for finalize/void (no new code; the plan names it) | Scorer or device sends settle, forfeit or abandon | No pad path reaches it; API callers get the code. |
| `TIEBREAK_NOT_APPLICABLE` (409) | `boardgame.tiebreak` outside phase `tiebreak` | Pad never offers it. |
| `LEVEL_RESULT_SEATED` (500, assertion) | A level result reaches seating | Sentry; only reachable through a bug. |

All refusal strings are in all four locales.

## 8. Truth run and proof

1. **Generator breadth lands first** (§5.6.1). A truth run without it proves only what the generators already reach.
2. **Reproduce before fixing** (R5). On the W2a branch, before any product change:
   - SC-O1 (65) and SC-O2 (12) must still be red;
   - NEW-H1 is driven: a set sport or tennis knockout abandoned from the pad, then the next round is read.

   A case that does not reproduce is recorded in "False premises found".
3. **After the fixes:**
   - The 77 are ✅.
   - The new decider, settle and `needs_decision` cases are ✅.
   - `pnpm run matrix:judge regression --baseline <w1d-baseline L3> --now <run> --expect <ids.json>` shows no new red.
   - The swiss_playoff R4 cells are read against the SW-H1 flip note in `_INDEX.md` before any movement counts as a
     fix or a regression.
4. **Evidence:** run outputs are committed under `truth-runs/w2a-*`, and `MATRIX.md` is regenerated (R10).

## 9. Testing and gates

- **All four test types** per task (RULES.md):
  - **Unit**, in the engine and the app.
  - **E2E**, whole spec files:
    - settle on the console;
    - the chess tie-break on the pad;
    - generic brackets without Draw;
    - the `mobile.spec.ts` width projects for the pad change.
  - **Smoke** (`scripts/smoke.ts`): a level knockout match goes to `needs_decision`, is settled, and the bracket
    advances.
  - **Regression**: the 77 matrix cases and every committed fast-check seed.
- **House rules** (TEST-STRATEGY.md):
  - Expected values come from the rule rows and the engine's declarations.
  - Every sweep reports its count, and zero checked is a failure.
  - The `supportsDraws` × stage-kind sweep covers 11 sports × 9 kinds through `forEachSport`.
  - `bracketDeciders` is checked per sport, with the empty case stated first.
  - Each guard is mutated once, **per member**:
    - the status rule per outcome kind and stage kind;
    - the organiser check per event × authority;
    - the settle precondition per outcome kind;
    - the tie-break phase guard per rung.
  - At least one case where the right answer differs from the wrong one's constant: settle seats the loser where an
    `award` would not.
  - The reviewer answers the four questions in writing: second call, empty input, after a withdrawal or void,
    another sport.
- **Stryker:**
  - Locally: the per-PR probe (`cd packages/engine && STRYKER_GROUP=probe pnpm mutation`), and changed-lines
    Stryker (`STRYKER_MUTATE`) on the changed engine lines instead of whole legs (ruling 81). Never a full run, and
    family legs only on CI.
  - Before merge: a dispatched `mutation.yml` run on the branch for the touched families (core, modules,
    sports-other, competition if touched). No family may fall below `stryker-floor.json`.
  - Floors are raised only as a deliberate `--set-floor` step.
  - Engine tests doing real work carry budgets derived from their work (CI runs with coverage, about 5× slower).
- **Scoped runs only:** never the full vitest, e2e or gate locally. Use `cd apps/web && vitest` with
  `--reporter=json --outputFile`, and confirm `.testResults[].name` (R19).
- **E2E in CI:** `workflow_dispatch` of `e2e.yml` with `--ref feat/format-matrix-w2a` before merge.
- **Before every commit:** the OpenAPI drift check. The CI single-sport ratchet must stay green.

## 10. Delivery

- **One PR** from `feat/format-matrix-w2a`. The 77 reds turn green only with engine, server and pad together, and
  each fix ships its proof.
- **Merge commit**, not a squash.
- The PR body declares its matrix rows (R27).
- **Execution:**
  - per task: implementer → reviewer, until the review is clean and the tests are green;
  - the reference family by a separate agent;
  - **Opus for the whole-branch review**;
  - the owner merges. Agent models are set per dispatch by ruling 80 (W2a only); outside it, `.claude/agents/*.md` decides.
- **Docs on the branch, written as they happen:**
  - `_INDEX.md`: the W2 row, rulings 71–79, the decision log, and "False premises found" (W2 brainstorm).
  - This spec, and the plan.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The inert seam: a bracket decider reaches append but not a read path. | Per-caller tests (§5.4.1) plus the truth run through the real pad. |
| A missed status set treats `needs_decision` as finished or as idle. | An enumerated, counted sweep (§5.4.6). |
| Changing the draw allow-list changes W3–W7 inputs. | Judge regression across every row; americano is kept allowed (ruling 78). |
| Stryker families drop under their floors from new untested mutants. | Leg runs locally, plus a dispatched family run before merge. |
| The cfg freeze means bracket deciders apply only to fixtures with no events yet. | Intended (V347). Already-started fixtures keep their cfg and finish through `needs_decision` and settle. |
