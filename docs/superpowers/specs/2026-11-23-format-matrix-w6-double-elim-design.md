# W6 — double elimination: design

- **Date:** 2026-11-23 · **Programme:** format matrix (`2026-09-27-format-matrix-prompts/_INDEX.md`), wave W6
- **Row:** `double_elim` × 11 sports = 11 cells
- **Inputs:** wave brief `W6-double-elim.md` (with its two W4 carries); draft rulebook `rulebook-W6-double-elim.md`
  (amended in the same round as this doc; its items S1 to S9 are signed, rulings 300–305; its REC rows still wait
  for the batch sign-off); `_INDEX.md` rulings 263, 264, 266, 267, 271 and 293–305, and the block
  "W6 — premise re-pin (2026-11-23)"; design reviews 1 and 2; `_RULES.md`;
  `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`, `apps/web/src/server/MODULARIZATION.md`.
- **Code read for this doc:** app `276fff25d7` (engine pin `@seazn/engine` = `npm:@seazn-club/seazn-engine@^10.0.3`,
  `apps/web/package.json:25`) and engine `release/10.0.3` at `d1f07f8`. Every file:line below was opened in this
  session. **Everything here is read, not driven** (R5, R20). No test was run and no screen was opened.
- **Status:** DRAFT, not yet approved as a whole. Decisions marked **OWNER** restate a signed ruling: 293–299
  (owner "Ok go", 2026-11-23), **300–305** (owner "approved", 2026-11-23: the rulebook's items S1 to S9 and the
  review-1 calls, §8), or an older one. Decisions marked **(designer's call)** are this doc's own and are listed in
  §10 for checking. **REC** marks a rulebook row still waiting for the batch sign-off.
- **Amended 2026-11-23 after design review 1** (0 Critical, 18 Important, 15 Minor;
  `.superpowers/sdd/2026-11-23-w6-double-elim/design-review-1.md` in the main checkout). The review confirmed the
  crossover rule exactly and every code citation it sampled. It changed the PR split, the dead-seat mechanism
  (§5.3, redesigned), the reset's life after Generate (§4.1, §4.2), the top places under double walkovers (§5.1)
  and the test design (§6.6). §10 lists what was taken, and what was not, with reasons. The rulebook was amended
  in the same round.
- **Amended again 2026-11-23 after design review 2** (32 of review 1's 33 fixed, the joint-winners one fixed
  wrongly; 6 new Important, 11 Minor; `design-review-2.md` beside review 1). The review confirmed the dead-seat
  rule against a play simulation at n = 3…32, with no unschedulable line left unmarked. **This round changes no
  rule.** It settles the reset's stored state end to end (§4.2), the fed draw path (§5.3), Rebuild over void lines
  (§5.4), and what PR A may hold on engine 10.0.3 (§6.2, §6.4).
- **Amended a third time 2026-11-23 after design review 3** (all 18 of round 2 fixed; 2 new Important, 7 Minor;
  `design-review-3.md`). No rule changed. `settleReset` moves into the seat resolver's own pass, the public
  champion reader and the Complete guard join the readers held to the stored reset, and the open count's change
  is stated at its full reach (§4.2, §10 call 32).
- **Prod census (2026-11-23, read-only, reported by the coordinating session; not re-run here):**
  `seazn_club.stages` holds 23 stages: knockout 12, swiss 9, league 2. **Zero `double_elim` stages**, so zero stored
  `bracketReset` values and no started double elimination anywhere in prod.

---

## 1. Intent

Nobody runs a double elimination on Seazn today. The prod census found none. So W6 is not a repair for live
organisers. It makes the format trustworthy before the first one runs it.

Four things are wrong or missing today (read):

1. **The losers' bracket replays the match a player just lost.** Drops are straight: the loser of WB round m+1 game
   i lands on LB game i (engine `src/scheduling/bracket.ts:475-489`). With the better seed winning every match that
   gives 1, 3 and 7 losers'-bracket rematches at 4, 8 and 16 entrants (rulebook §4; audit FX-G4).
2. **The grand-final reset is reachable through the public API only.** `server/api-v1/schemas/stages.ts:263`
   accepts `bracketReset` and `server/usecases/stages/generators.ts:532` passes it to the generator. The template is
   `config: {}` (`lib/format-templates.ts:252-256`). No screen sets it, so every double elimination built in the
   product is a single-match final where an unbeaten champion can lose the title on one match.
3. **A no-show ends a player's whole event.** A forfeit loser never drops (X-DE-1; `server/engine-db/fed-seats.ts:121-124`,
   `:146-165`). The format's promise is two losses. Ruling 294 overturns the rule for a forfeit.
4. **The format is half built around the edges.** Late entry answers the start lock
   (`lib/open-entry-stages.ts:53-56`). Rebuild carries slots by position
   (`server/usecases/stages/generate-tx.ts:948`, pinned as a defect at
   `server/usecases/__tests__/rebuild-one-transaction.test.ts:546-575`). A losers'-bracket line that can never be a
   match can be given a court (brief, carried 1). Places below 2nd are split by seed (engine
   `src/competition/stage.ts:942-1085`). There are three rule rows for the whole format (`rules/cross-sport.md:14`,
   `:30`, `:56`).

**Success:**
- A new double elimination opens with "reset if needed", on a screen, and the reset exists only when the
  losers'-bracket champion wins the first grand final.
- No two players can meet again in the losers' bracket before the round the rulebook names for that size (RB6-X6).
- A player who misses one match drops like any loser. A withdrawn or disqualified player is out at once.
- Places below 4th are shared by losers'-bracket round, the same on every surface.
- A late player is placed in winners'-bracket round 1 or gets a named reason.
- Every rule W6 relies on is a signed row in the engine's `rules/cross-sport.md`.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1 **The reset is a stage setting, on by default for a new stage**, editable until GF1 has a result
  (OWNER 293; OWNER 305(a), §4.1).
- G2 **An earned reset cannot be voided** (OWNER 298, §4.2).
- G3 **Losers'-bracket drops cross**, by one published pattern (OWNER 295; pattern OWNER 300, §4.3). Engine change.
- G4 **A forfeit, a no-show, an organiser's award or a retirement is one loss** (OWNER 294; retirement OWNER 302, §4.4).
- G5 **Places below 4th are shared by losers'-bracket round** (OWNER 297; withdrawn entrants OWNER 303; places a
  double walkover leaves unplayed OWNER 305(d), §5.1). Engine change.
- G6 **Late entry into winners'-bracket round 1 only**, on the organiser's tap (OWNER 296, 271; the losers'-bracket
  side OWNER 304, §5.2).
- G7 **A line with a dead seat is never scheduled** (OWNER 299; brief carried 1; mechanism OWNER 305(c), §5.3).
- G8 **Rebuild carries a double elimination's slots by role** (OWNER 299; brief carried 2, §5.4).
- G9 **Fields of 2 and 3 stay offered; 0 and 1 are refused by name** (OWNER 304; RB6-E1 to E5, §5.5).
- G10 **Close every gap in §9** to ruling 19's bar on the `double_elim` row: zero ❌ attributable to W6, others ⏳
  with their owner, nothing previously ✅/⛔ turned red.
- G11 **Rule rows:** every W6 behaviour gets a signed row in the engine's `rules/cross-sport.md` (§12).
- G12 **The matrix can see the format:** a reset variant row, a full-order ranks oracle and a field sweep that counts
  losers'-bracket rematches (OWNER 299, §6.4, §6.6).

**Non-goals**
- **Printing the reset on sheets (SH-G17).** W8 owns sheet code. W6 states the rule it follows (RB6-G6) and tells
  the W8 lane what changed (§6.5).
- **`page_playoff`.** It shares the `formats.double_elim` key but belongs to W4. The gate is unchanged (OWNER 299;
  RB6-N2).
- **A refused format change that loses the division's stages (RB6-N3).** Routed to W9 by ruling 35.
- **Club separation.** Deferred by ruling 272 to a clubs follow-up.
- **Americano, mexicano, ladder.** W7.
- **A losers'-bracket seeding of its own** (RB6-D5), **a third-place setting on this format** (RB6-M4), and
  **a boardgame rule of its own** (OWNER 299; RB6-M3).
- **A `drops` option on the generator, or a "bracket version" in stage config** (designer's call, §6.1).
- **A double walkover in the winners' bracket that drops a side.** OWNER 301 keeps X-DW-2: both are out.
- **Compatibility for stored brackets.** Prod has none; staging data is test-only and is cleaned up (§7).

**Anti-goals: things that would make W6 a failure even if every test is green**
- A rematch sweep that passes on zero losers'-bracket matches, or that only runs the favourite-wins case at n=4,
  where right and wrong give the same count (brief trap 3; R25).
- A ranks test whose expected order comes from `bracketRanks` itself (R9).
- A reset setting that is stored, typed and unit-green but that no screen writes and no Generate reads (the inert
  seam, `AGENTS.md` class 1).
- A reset control that opens at "single match" on a new stage (class 19: pin what it opens at).
- A forfeit that drops the player on the bracket but ranks them out at the forfeit, or the reverse. Seats and ranks
  must agree (X-FR-3).
- A started bracket whose lines move because the engine was bumped under it.
- A dead line that keeps a court on one predicate and loses it on its SQL twin.

## 3. Constraints

- **Two repos.**
  - Bracket generation (`src/scheduling/bracket.ts`) and final ranks (`src/competition/stage.ts`) live in the engine
    repo, published as `@seazn-club/seazn-engine` and installed here as `@seazn/engine`.
  - Seating, the loser edge, late entry, Rebuild, scheduling predicates, every screen and the matrix harness live in
    seazn.club.
  - Order: engine PR (code + tests + rule rows + a real changeset + `Matrix rows: double_elim|…` in the body) →
    engine release (`engine-release` skill) → seazn.club bump PR.
  - **The release is a major: 11.0.0** (designer's call, §6.1). `generateDoubleElim` returns different lines for the
    same input, a double elimination's `finalRanks` may repeat a rank below 2nd and hold more than two at one rank
    (the type does not change), and `completeBracketStage` refuses a state it accepted.
- **Three PRs** (OWNER 299): engine, app PR A (no engine change), app PR B (after the release). A fourth,
  docs-only step follows PR B: the engine's rule rows get their `proved by` filled (§12). It changes no code.
- **The ruling ledger stays in seazn.club.** The last owner ruling read is 305. Re-check before claiming 306.
- **No live double elimination anywhere** (§7). No compatibility code and no data migration for existing brackets.
- **House test rules** (`TEST-STRATEGY.md`, `_RULES.md`): four test types per task; anti-vacuity counts on every
  sweep (R25); expected values from the rulebook and the engine's declarations, never the product's output (R9);
  mutate every new guard once (R17); test the sequence (R27).
- **The reference model is written by a different agent from the engine fixer** (R8), and never value-imports the
  engine or the app (R7).
- **Server work follows `apps/web/src/server/MODULARIZATION.md`.** `usecases/stages/` is a split folder: grep its
  `index.ts`, read the one module, no behaviour change rides on a move.
- **UI bar:** mobile-first; verified at 1280, 768 and 320 with no horizontal page scroll; every new string in all 4
  locale dictionaries (`apps/web/src/dictionaries/{en,es,fr,nl}`) plus `pnpm i18n:gen-keys`
  (`package.json:61`; R23); ≥2 layout options shown to the owner before any new control is built (R24).
- **E2E runs by CI dispatch only.** Locally, run only the scoped tests for changed files. Never the full suite.
- **This doc's facts are a read** (R5). Each "today" below is a hypothesis for W6's truth run. A false one goes to
  "False premises found (W6)".

## 4. The grand final, the drops and the forfeit (OWNER, 2026-11-23)

Words as in the rulebook: WB = winners' bracket, LB = losers' bracket, GF1 = the first grand final, reset = the
second. Rulebook rounds and games count from 1. The engine counts from 0: rulebook LB round t is the engine's
`L = t − 1`, and WB round r is `wb.gameIds[r − 1]`.

### 4.1 The reset is a stage setting, on by default (OWNER 293; RB6-G1 to G6, G8)

**Rule.**
- One setting on every double-elimination stage: **"Grand final: reset if needed (default) / single match"**.
- **Reset if needed:** if the WB champion wins GF1 the stage is decided. If the LB champion wins GF1, both have one
  loss and the reset is played; its winner is champion (RB6-G4).
- **Single match:** GF1 decides the title whoever wins (RB6-G5).
- When the WB champion wins GF1, the reset does not exist for anyone: not a match to play, not counted open, not
  called (RB6-G6). Before GF1 is decided it reads "if needed" and may hold a time and a court (RB6-G8).
- Editable until GF1 has a result, then read-only with a named reason (OWNER 305(a); RB6-G3).
- A stored stage keeps its stored value; a stored stage with no value stays a single match (RB6-G2).

**Today (read).**
- The engine honours the option: `generateDoubleElim` adds `gf-reset` with `conditional: true` when
  `bracketReset === true` (engine `src/scheduling/bracket.ts:524-533`).
- The app passes `cfg.bracketReset === true` (`server/usecases/stages/generators.ts:532`), and the public API schema
  accepts the key (`server/api-v1/schemas/stages.ts:263`).
- The template writes `config: {}` (`lib/format-templates.ts:252-256`). No screen reads or writes the key: a grep
  for `bracketReset` under `components/` finds only tests.
- An untriggered reset already reads as void (`server/engine-db/competition/bracket-stage.ts:258-268`) and is
  skipped in the open count (`server/usecases/scoring.ts:1385-1392`). FX-G3 as the audit wrote it is false since W4
  (premise re-pin 1).

**What changes.**
- **The default is written when the stage is created, never applied when it is read** (designer's call). The
  template's config becomes `{ bracketReset: true }`, and a double-elimination stage created over the API with no
  `bracketReset` key is stored with `true`. Every reader keeps `=== true`. So a stage stored before the release with
  no value stays a single match with no migration (RB6-G2).
- **The control** sits where the third-place control sits: in the format picker of the division builder
  (`components/v2/format-picker.tsx:305-310` is the third-place precedent) and in the stage's settings on the
  division page (`components/v2/stages-panel.tsx:2298`). One component, both mounts.
- **Layout options for the owner (R24; not a decision):**
  - (A) a two-segment control "Reset if needed | Single match" with one helper line under it;
  - (B) a single switch "Play a second final if the losers' bracket champion wins the first", on by default.
- **Copy in plain words** (draft, the builder finalises in 4 locales):
  - label: "Grand final";
  - reset if needed: "The winners' bracket champion has not lost yet. If they lose the grand final, the two play
    once more to decide it.";
  - single match: "One match decides the title, whoever wins it.";
  - locked: "The grand final has been played. This cannot change now."
- **A change after Generate is new code, not Generate** (review 1). Generate cannot remove a row: it inserts only
  rows whose `ext_key` is not already drawn (`server/usecases/stages/generate-tx.ts:681`) and fills only null
  edges (`:803-807`). So the setting's own usecase does it, in one transaction:
  - **on → off:** delete the unplayed `gf-reset` row and null the grand final's two edges to it. A time or court
    the reset held is released and counted in the answer.
  - **off → on:** insert `gf-reset` (unplayed, unscheduled) and wire the grand final's winner and loser edges.
  - **before Generate:** only the config changes.
  - **once GF1 has a result:** refused by name, in 4 locales ("The grand final has been played. This cannot change
    now."). "Has a result" is any settled state of GF1, joint winners and a vacant title included.
  - The change is a ledger step with an inverse, so Undo restores the row and its slot. **The inverse checks the
    same lock** (review 2): once GF1 has a result, an Undo of the flip is refused with the same reason. A flip to
    the value already stored writes nothing and adds no ledger step.
- **The API default is documented.** A client that omits `bracketReset` on create now gets a reset. The key's
  description in the schema (`server/api-v1/schemas/stages.ts:263`) says so, which the CI OpenAPI drift check
  carries, and the API changelog names it.
- **The estimate follows the setting.** `lib/format-max-entrants.ts:100` already reads `shape.bracketReset`; the
  builder's fixture estimate must pass the stage's value, or it under-counts by one.
- **The bracket views show the reset as "if needed"** before GF1 and hide it once the WB champion wins. The console
  bracket (`components/v2/bracket-panel.tsx:419-421`) and the public bracket
  (`components/public-site/bracket.tsx:433`) both draw the two-lane geometry today; how each draws an unneeded reset
  is not read and is settled by screenshot.
- **Lists that show void rows** (review 2). The run sheet strikes a void row through and labels its status
  (`components/v2/desk/run-sheet-row.tsx:428-432`). An unneeded reset is stored void (§4.2), so it appears there.
  Expected answer (designer's call): the row is listed struck through and labelled "Not needed", in 4 locales,
  never as a match to play, call or score. The division page's fixture list gives the same answer. The truth run
  and the screenshots check against this, not against whatever is seen.
- **Lands in app PR B** (designer's call): a default that makes resets common ships together with §4.2's refusal,
  not ahead of it.

**Smallest test that fails today.** Create a division from the `double_elim` template through the real usecase,
Generate at n=4, and assert a `gf-reset` row exists and the stage config reads `bracketReset: true`. Today: no such
row. The paired case: a stage row written with `config: {}` and then Generated has no reset (RB6-G2), so the test
can tell "default on create" from "default on read". **Sequence (review 1):** after Generate, on → off → on. After
each step assert the stage's row set (the `gf-reset` key present or absent, the grand final's two edges set or
null) and that the reset's slot was released on removal. Then a Rebuild after a flip draws what the setting says.
Then GF1 is decided and the next flip is refused, with nothing written. Two more (review 2): a flip to the value
already stored writes nothing; an Undo of an earlier flip, tried after GF1 has a result, is refused.

### 4.2 When the reset is owed, and an earned reset cannot be voided (OWNER 298; RB6-G7, G9 to G11)

**Rule.**
- **The reset is owed** exactly when the setting is "reset if needed", GF1 is settled with a winner, that winner is
  the LB champion, and GF1 has a loser, the WB champion, who is still in the stage (RB6-G11).
- In every other settled state of GF1 it is not owed and does not exist: the WB champion won; joint winners
  (RB6-C5); a vacant title (RB6-C4); a walkover over a finalist who is out of the stage (RB6-C2); **GF1 settled as
  a bye**, because a double walkover in the WB final left no WB champion (RB6-F7; review 2).
- **A reset row is seated if and only if it is owed.** This is the one invariant every reader and writer below is
  held to.
- Once owed, the stage is not complete until the reset is decided, walked over, or settled by the title rules
  (RB6-G7, G10). Once the reset has started, a correction that changes GF1's winner is refused by name. A score fix
  that keeps the winner is allowed: it changes nothing the reset depends on (RB6-G9; review 2).

**Today (read).**
- `decidingFinal` takes the latest settled final that decided something, and a void final decides nothing, so a void
  reset falls back to GF1 whoever won GF1 (engine `src/competition/stage.ts:825-834`).
- `bracketCompletionRefusal` counts a void fixture as settled (`:271-296`), so `completeBracketStage` (`:671-694`)
  completes over a void reset and crowns GF1's winner.
- **Three places decide whether the reset is owed, and they do not agree:**
  1. the completion read voids the reset when GF1's winner is its home entrant
     (`server/engine-db/competition/bracket-stage.ts:258-268`);
  2. the open-count SQL repeats that test (`server/usecases/scoring.ts:1385-1392`);
  3. `unsettledCount` (`server/engine-db/stage-finals.ts:34-36`) has no reset logic at all. It feeds the desk's
     "Final decided — complete the stage" row and the Complete-competition warning, so (read) a finished double
     elimination whose reset was not needed never raises that row.
- After the WB champion wins GF1 the reset row stays `scheduled`, and GF1's edges seat it. Every generic reader
  (run sheet, Match Day call, scorer pad, notifications) then sees a seated match to play, against RB6-G6. None of
  those readers was opened.
- Neither derivation covers a joint or vacant GF1, or a walkover over an out finalist. In those states the reset
  would stay `scheduled` and completion would wait on it for ever (review 1).
- The app's open count treats a `cancelled` fixture as not owed (`scoring.ts:1385`), with no check that the
  cancelled row is an owed reset. Which organiser actions can leave `gf-reset` settled without a result is not read.
- **The open count and the completion readers already disagree about a void line** (review 2; read, not driven).
  `maybeAutoAdvance` counts every row that is not decided, forfeited, finalized or cancelled as open, unless an
  expunge abandon is active (`scoring.ts:1376-1384`). So a stored void (`abandoned`, no event) is open to it.
  The completion readers map the same row to `void`, which is settled (`completionEngineStatus`,
  `server/engine-db/recorded-abandon.ts:110-115`; `stage-finals.ts:34-36`). A line the resolver voided because
  both feeders were dead is such a row today, n=5's `LB 1.2` among them. So (read) a double elimination that is
  not a power of two never auto-advances.
- **Deciding GF1 seats both finalists into the reset, whoever won.** The fill runs in `onDecided`'s own
  transaction, after the score's commit (`scoring.ts:1072-1079`): the winner edge and the loser edge each call
  `fillSlot` (`:1157-1176`), whose only guard is an empty seat. It does not look at the target's status
  (`server/usecases/stages/bracket-seats.ts:33-37`).
- **The un-fill has its own idea of a void line.** `isCascadeVoid` is "abandoned, no outcome, no seat, no event"
  (`server/engine-db/fed-seats.ts:188-190`), and the release plan revives such a line when a dead feeder is taken
  back (`:455-457`). It leaves an unseated line with nothing stamped alone (`:449`).
- **"Declare joint winners" is refused on every double-elimination final today, three times over.** The server
  usecase refuses any `conditional` fixture itself, before it asks the predicate
  (`server/usecases/joint-winners.ts:88`; its comment at `:84-86` says the predicate owns the rule). The shared
  predicate refuses a reset (`conditional !== true`, `lib/joint-winners.ts:34`) and refuses the whole kind
  (`stage_kind !== "double_elim"`, `:35`). `server/usecases/__tests__/joint-winners-double-elim.test.ts:35-56`
  pins `JOINT_WINNERS_NOT_A_FINAL` on a seated, unplayed grand final; its header says a joint grand final "would
  leave [the reset] owed for good (C32, parked)". The predicate is client-safe (`:9`): the desk reads it too.

**What changes.**
- **One predicate: the engine's `resetOwed(fixtures)`**, exported and pure. It is true when:
  - the stage has a reset line (`conditional`), fed by GF1;
  - GF1 is settled and names a winner **and a loser**, is not a joint final, and carries no `walkedOver` (its
    loser is still in the stage, §4.4). A GF1 settled as a bye names no loser, so it owes nothing (review 2): after
    a WB-final double walkover GF1's WB seat is dead and the LB champion takes the title by bye;
  - GF1's winner is the entrant GF1's **LB feed** delivered, and its loser the entrant the WB feed delivered. The side is read from GF1's feeds (`homeFrom` /
    `awayFrom`, which the app already attaches, `bracket-stage.ts:243-247`), never from which seat is home:
    RB6-D6 leaves seat order unruled, so a seat-order change must not flip the answer. At n=2 both feeds come from
    the WB final, and the LB champion is the one its `loser` feed names.
- **`BracketFixture` gains `conditional`.** The app sets it in one place, `toBracketFixture`
  (`bracket-stage.ts:126`), from `ext_key === "gf-reset"`: the comment at `:258-260` says a row written before the
  column existed holds `conditional = false`, so the key is the durable fact.
- **The engine's refusal.** `bracketCompletionRefusal` gains a third reason, `reset_owed`: the reset is owed and its
  row is void. `bracketTitle` answers undefined in that state. This is ruling 298 inside the engine.
- **The app writes the answer once; nothing else derives it** (designer's call, replacing the first draft's "three
  readers call one reading"). One function, `settleReset`, is the only app code that calls `resetOwed` and the
  only code that decides the reset row's seats and its void state. The three stored forms:

  | GF1 | Reset row | Seats | Slot |
  |---|---|---|---|
  | unsettled | `scheduled` ("if needed") | both empty | may hold one (RB6-G8) |
  | settled, reset **owed** | `scheduled`, then whatever play makes it | both finalists | keeps it |
  | settled, reset **not owed** | void: `abandoned`, no outcome, no event (the column's void, `generate-tx.ts:707-708`) | both empty | released and reported |

- **Where `settleReset` runs** (reviews 2 and 3). **Inside the seat resolver, in every pass, right after
  `advanceSettledByes`** (`server/usecases/stages/bracket-seats.ts:573-575`). So every caller of
  `resolveBracketSeats` gets it: `onDecided` (`scoring.ts:1192-1196`), the withdrawal's own transaction
  (`bracket-seats.ts:392`), Generate (`generate-tx.ts:887`) and the seed confirm
  (`server/usecases/stages/seed-proposal.ts:850`).
  - **Why the resolver and not `onDecided` alone** (review 3). GF1 is not always settled by a decision on GF1.
    The resolver settles it itself in two shapes the rulebook requires: **GF1 with a dead WB seat** after a
    double walkover in the WB final (RB6-F7, R10), and **GF1 as a walkover** when a finalist leaves while the
    other GF1 seat is still open (RB6-C2; the "tbd" stamp, `bracket-seats.ts:332-334`). Both happen in someone
    else's transaction: the LB final's `onDecided`, or the withdrawal's. With `settleReset` in `onDecided` only,
    nothing would call it. The resolver's next pass would then seat GF1's winner into the reset, stamp the
    reset's other seat dead and award **the reset** as a credited win, which RB6-G6 forbids.
  - **The order inside a pass:** stamps, `awardSeededByes`, `advanceSettledByes`, then `settleReset`. So in the
    pass that settles GF1 the reset is judged before any later pass can stamp or award it, and a void row is
    skipped by the next pass (`:495`).
  - **A decision on GF1 itself:** `onDecided` fills both finalists first (`scoring.ts:1157-1176`), then runs the
    resolver, because GF1 feeds the reset. `settleReset` in its first pass leaves the seats (owed) or clears them
    and writes the row void (not owed). It therefore still runs after the fill. Running it before the fill would
    leave a void row with two seated finalists, the one shape the invariant forbids.
  - **A stage with no reset row** (the setting is "single match"): `settleReset` finds no row and does nothing.
  - **GF1 taken back, voided or undone:** after the release plan, in its transaction. The row returns to
    `scheduled` with both seats empty.
  - **A GF1 correction:** it is a take-back and a new decision, so both of the above run. From "WB champion won"
    to "LB champion won" the fill seats the finalists into the void row (`fillSlot` has no status guard) and
    `settleReset` then writes it `scheduled`. The other direction clears it.
  - **Joint winners declared or undone on GF1, and a vacant title written or reversed:** in that usecase's
    transaction.
  - **A second call writes nothing.** On a row already in the right form it changes no column, releases no slot
    and reports none.
  - **If `onDecided` fails** (review 3). It runs after the score's commit, so GF1 can be decided while the reset
    still reads "if needed", and completion no longer works the reset out for itself. The repair is named:
    Complete's guard calls `settleReset` before it reads (`beforeBracketComplete`,
    `server/usecases/stages/completion.ts:144-147`). The call is idempotent, so on a healthy stage it writes
    nothing.
- **Why not a status guard in `fillSlot` instead** (the other route review 2 offered). `fillSlot` serves every
  bracket kind and is correct for them as it is. A guard there would change a shared writer for one row, and a
  correction from "not owed" to "owed" needs the fill to seat a void row. So the order carries the invariant, and
  one test mutates the order.
- **Two writers can touch the row; `settleReset` is last and decides** (review 2). A void, unseated reset has the
  same shape as the un-fill's "cascade void" (`fed-seats.ts:188-190`), so the release plan can revive it when a
  GF1 walkover over an out finalist is reversed (`:455-457`). That is harmless only because `settleReset` runs
  after the release plan and reads nothing but the stored GF1. The sequence test below covers that path.
- **Every reader and writer that must agree:**

  | Reader or writer | Today | After W6 |
  |---|---|---|
  | the completion read (`bracket-stage.ts:258-268`) | derives "void" when GF1's winner is its home entrant | the derivation is deleted; the stored status is read. `toBracketFixture` sets `conditional` |
  | the engine's `bracketCompletionRefusal` | counts a void fixture as settled | refuses `reset_owed` when `resetOwed` is true and the row is void |
  | the open count (`scoring.ts:1376-1392`) | counts every `abandoned` row as open; skips the reset by the GF1-home test | reads `abandoned` as the completion readers do (below); the reset clause is deleted |
  | `unsettledCount` (`stage-finals.ts:34-36`) | no reset logic | no change: a void row is settled |
  | the fill (`fillSlot`, through `onDecided`) | seats both finalists | no change; `settleReset` follows it |
  | the un-fill (release plan) | leaves or revives the row | no change; `settleReset` follows it |
  | the departed-seat stamp (`bracket-seats.ts:46-55`) | stamps only a `scheduled` row | no change: a finalist who leaves before an owed reset walks it over (RB6-C3); a void reset takes no stamp |
  | joint winners: `lib/joint-winners.ts:34-35` and `server/usecases/joint-winners.ts:88` | three refusals | one predicate (below) |
  | **Complete's guard** (`undecidedBracketFixtures`, `completion.ts:74-80`) | its own "reset owed": GF1's winner is not its home entrant | the derivation is deleted in PR B; a void reset is already filtered by status. It calls `settleReset` first (above) |
  | **the public champion** (`bracketTitleOf`, `server/public-site/champion.ts:150-184`) | derives "owed" from GF1's winner and seat order (`:177`); its comment says nothing in production writes the void (`:145-146`); `abandoned` is not a settled status to it (`:102`) | reads the stored reset: a later conditional final withholds the title unless it is the stored not-owed form (void and unseated). The seat-order test and its comment are deleted |
  | the seat resolver's stamp and award branches | would award a reset whose one seat is dead | never reach it: `settleReset` judges the row in the pass that settles GF1 |
  | lists that show void rows (run sheet, division page) | a void row with a status label | "Not needed" (§4.1) |
  | the setting's change usecase (§4.1) | — | adds or removes the row only while GF1 has no result |
  | Generate and Rebuild | insert the row `scheduled`, unseated | no change |

- **The public champion is a reader too, and the first two drafts missed it** (review 3). Once the unneeded
  reset is stored void, `bracketTitleOf` as written today would withhold the title for good in four not-owed
  shapes: joint winners on GF1, a vacant GF1, GF1 with no loser after a WB-final double walkover, and a GF1
  walkover over an out WB champion. **The last one crowns correctly today**, because the reset is walked over
  and then decides. So it is W6's regression guard. The public hub, the live page and the other champion
  consumers all read this function (review 3's read; those call sites were not opened here).
  - The new reading uses the invariant, not the status alone: an owed reset that was abandoned mid-play keeps its
    seats, and still withholds the title.
- **The open count reads a void line as the completion readers do** (review 2; designer's call, all bracket and
  table kinds). An `abandoned` row counts as open only when it awaits the organiser's settle, the same reading
  `completionEngineStatus` gives through `rowAwaitsSettle` (`recorded-abandon.ts:84-99`, `:110-115`). A stored
  void, with no abandon event, is settled. Then the reset clause (`scoring.ts:1388-1392`) is deleted outright: it
  is the GF1-home derivation, the seat-order reading this section rejects.
  - **The authority is the engine's settle rule, read through `completionEngineStatus` in TypeScript. There is no
    SQL twin** (review 3). The count selects each row with its three abandon facts, as Complete's guard already
    does (`completion.ts:63-70`), and folds them through that one function. Nothing re-spells the engine's rule
    in SQL, so nothing can drift from it.
  - **What this changes outside double elimination** (review 3 enumerated every writer of `abandoned`; its line
    reads were not repeated here):
    - a line the resolver voided for two dead seats (`bracket-seats.ts:531-536`: a knockout's third-place line
      with both semi-final losers gone, any bracket), a void written by Generate's insert, and a void written by
      the seed confirm: open today, settled after. Auto-progress stops needing a manual Complete;
    - a recorded abandon that decided nobody, and a level abandon in a bracket: open today, open after. A held
      line still holds;
    - a withdrawal's expunge (table kinds only): settled today, settled after;
    - **an organiser's online No result in a league, a group stage or a Swiss round: open today, settled after.**
      Those formats now auto-advance over a No result. That agrees with the completion read, which already
      settles it ("the No result is the settle").
  - **One assumption becomes a guard:** a bracket stage never holds an expunge abandon. The engine's bracket arm
    ignores `expunged`, so today's explicit exclusion stops protecting brackets once the count folds through it.
    An assertion on the count's rows, and a test that reaches it.
  - **The void reading lands in PR A**, because §5.3 writes void lines at the draw and they would otherwise stop
    every non-power-of-two double elimination from auto-advancing. The truth run drives that case on main first
    (n=5, auto-progress on): the claim is a read. **The reset clause is deleted in PR B**, with `settleReset`.
- **One table of shapes holds them together.** For each GF1 state (WB champion won, LB champion won, joint,
  vacant, walkover over an out finalist, **a bye after a WB-final double walkover**, unsettled) and each setting,
  after `settleReset`: the completion read, the open count, `unsettledCount`, auto-advance, **Complete's guard
  and the public champion** each answer what `resetOwed` answers, and the reset row is seated exactly when it is
  owed. That is six readers. Two more rows carry no reset: n=5's
  void `LB 1.2`, settled to every reader that counts lines. The table counts its rows; zero is a failure.
- **Organiser actions on an owed reset.** Each action that would settle it without a result (the builder lists
  them: cancel, void, abandon) answers a named refusal in 4 locales. Walkover, joint winners and the vacant title
  are the allowed ways out.
- **Joint winners (RB6-C5): three refusals go, and one predicate owns the rule** (review 2 found the third).
  - The rule, in one clause of the shared predicate (`jointWinnersOffered`, `lib/joint-winners.ts`): **this final
    may take joint winners when it is not a reset, or when it is a reset that is owed.**
  - `:35` is removed, so a seated, unplayed grand final is offered.
  - `:34` becomes that clause. "Owed" is read from the stored row: by the invariant a reset is seated exactly when
    it is owed, and the predicate already requires both seats (`:38-39`). So the client-safe predicate takes no new
    input. This holds only because `settleReset` follows the fill; a void reset with seats would be offered, since
    `abandoned` is one of the open statuses (`:12`).
  - **The server's own refusal goes too:** the `f.conditional` term at `server/usecases/joint-winners.ts:88`. The
    rest of that pre-check stays (a final, not third place, both seats), so an unseated reset still answers
    `JOINT_WINNERS_NOT_A_FINAL`. Its comment already names the predicate as the owner.
  - Declared on GF1, the reset is written void. Undone on GF1, the reset is "if needed" again. Declared on an owed
    reset, it settles the reset and the stage.
- **One finalist out** before GF1: GF1 is a walkover and no reset exists, whichever side is out (RB6-C2). Between
  GF1 and an owed reset: the reset is a walkover (RB6-C3). **Both out:** vacant title (RB6-C4). W4 built the
  walkover and the vacant title for a final; neither is driven on a grand final here.
- **Lands in:** the predicate, the flag and the refusal in the engine PR; the open count's void reading in PR A;
  everything else in app PR B.

**Smallest test that fails today (engine).** n=4, reset on, the LB champion wins GF1, the reset row `void`.
`completeBracketStage` must throw `STAGE_NOT_READY` with `reason: "reset_owed"`. Today (read) it returns ranks with
GF1's winner 1st. The pair that keeps it honest: the same rows with the WB champion winning GF1 complete as today.
A second pair pins the feed reading: the same bracket with GF1's seats swapped gives the same answer. A third
pins the loser requirement (review 2): GF1 settled as a bye for the LB champion, reset on, is not owed, and the
stage completes with the LB champion 1st.

**Named cases for the open count, in PR A** (review 3: the change lands in PR A, so its failing tests do too).
Auto-progress on, through the real usecases, each asserting a non-zero count of the rows it is about:
- an n=5 double elimination with its void line advances;
- a knockout whose third-place line is a cascade void advances;
- a league whose last line is an organiser's No result advances, and a Swiss round with a No-result board
  advances (the change in another format);
- a scorer's recorded abandon still holds the stage, in a bracket and in a table;
- mutant: drop the stage-kind split in the fold, and the table cases must go red.

**Named cases (review 1), each through the real usecases in PR B:**
- a vacant GF1 with the reset on: the reset is void and the stage completes;
- joint winners on GF1 with the reset on: the reset is void; undone: "if needed" again; declared and undone twice;
- joint winners on an owed reset: accepted, and it settles the stage; on an unseated reset: refused;
- a GF1 correction before the reset starts, in both directions, with the reset's slot followed;
- an Undo of GF1 entirely: the reset is "if needed";
- a forfeit in GF1 by each side, with the reset on and off, and a forfeit in the reset (RB6-F9, F10);
- n=2: the WB final's loser goes straight to GF1; a forfeit in that WB final still leaves a GF1 to play;
- the desk's "Final decided" row appears on a finished double elimination whose reset was not needed;
- **GF1 a bye** (a double walkover in the WB final, reset on): the reset is void and unseated, nothing is owed, and
  the stage completes;
- joint winners on an owed reset **through the server usecase**, not the predicate alone: accepted. Today it
  answers `JOINT_WINNERS_NOT_A_FINAL` from the usecase's own check;
- auto-advance, auto-progress on: a finished bracket whose reset was not needed advances;
- **GF1 settled by the resolver, two routes (review 3).** In both the reset must end void and unseated, never
  decided and never a credited win:
  - n=8, a double walkover in the WB final, reset on, then the LB final is decided (RB6-F7, R10);
  - the WB champion withdraws while the LB final is unplayed, then the LB final is decided (RB6-C2). And the
    same with the withdrawal as the last write, so the withdrawal's own transaction is the one that settles GF1;
- **the public title, on the hub and on the live page**, reset on: joint winners on GF1 (both named), a vacant GF1
  (vacant), GF1 with no loser after a WB-final double walkover (the LB champion), and a GF1 walkover over an out
  WB champion (the LB champion). The last is the regression guard: it crowns today. The cases report how many
  titles they read; zero is a failure;
- `onDecided` made to fail after a GF1 decision, then Complete: the reset is settled by Complete's guard.

**The reset's sequence test (review 2), through the real usecases, reset on, auto-progress off.** After every step
it asserts the reset row's status, both seats, its slot, what each of the four readers answers, and whether joint
winners is offered on it:
1. GF1 decided for the WB champion → the reset is void, both seats empty, its slot released, not offered, nothing
   open.
2. GF1 taken back → `scheduled`, both seats empty: "if needed".
3. GF1 decided for the LB champion → `scheduled`, both finalists seated, owed: one line open, completion refused,
   joint winners offered.
4. GF1 taken back again → "if needed" again, both seats empty.
5. Step 1 once more, then a same-winner score fix on GF1: nothing changes and no slot is released twice.
6. A GF1 walkover over an out finalist, then reversed: the row ends "if needed", whatever the release plan did.

The run reports the steps checked. Mutants: run `settleReset` before the fill (step 1 must go red on the seats);
skip it on the take-back path (step 2 must go red); move it out of the resolver's pass into `onDecided` (both
resolver-route cases above must go red).

### 4.3 Losers'-bracket drops cross (OWNER 295; pattern OWNER 300; RB6-X1 to X8)

**Rule.** LB round 1 pairs adjacent WB round-1 losers in order (RB6-X1). The loser of WB round r game i (r ≥ 2)
lands in LB round 2(r−1) at a game chosen by a four-step cycle on c = (r−2) mod 4: reversed, reversed then switched,
switched, regular (RB6-X2). Survivor rounds pair neighbours (RB6-X3). The pattern is defined on the frame; byes
change which seats are live, never where a loser lands (RB6-X5). It applies to a new or rebuilt bracket. A bracket
with a result keeps its lines.

**Today (read).** Straight drops: `awayFrom: loserOf(wbLosers[i])` on `lb-r${L}-i${i}`, the same index
(engine `src/scheduling/bracket.ts:475-489`). No test counts LB rematches: a grep for "rematch" in
`src/scheduling/bracket.test.ts` finds nothing.

**What changes (engine).** In the drop round `L` (odd, 0-based), with `m = (L − 1) / 2`, `G = prev.length`,
`c = m mod 4` and i, j 0-based, LB game j takes the loser of WB game i where:

| c | name | j |
|---|---|---|
| 0 | reversed | `G − 1 − i` |
| 1 | reversed then switched | `G/2 − 1 − i` if `i < G/2`, else `3G/2 − 1 − i` |
| 2 | switched | `i + G/2` if `i < G/2`, else `i − G/2` |
| 3 | regular | `i` |

When `G = 1`, `j = 0`. Fixture ids do not change (`lb-r{L}-i{j}`); only `awayFrom` does. The mapping is one small
pure function with the rulebook row in its name, so the reference agent and the reviewer can read it against RB6-X2
directly. **The generator's loop runs over LB games j and needs i from j.** The table gives j from i. The two are
the same only because each of the four maps is its own inverse (review 1 checked all four). The function's comment
says so, and one test asserts `map(map(i)) = i` for every c and G, so a later cycle step that is not its own
inverse is caught.

Review 1 rebuilt the bracket from RB6-X1 to X3 in a script and found: a bijection in every round for frames 4 to
256 (every LB seat fed exactly once), the three worked tables reproduced with no mismatch, and E = 2, 3, 4, 5, 7, 8
at frames 4 to 128. The rule is not changed by this round.

**How a stored bracket is told apart from a new one: it is not, and it need not be** (designer's call).
- The app stores a bracket's lines as rows. The loser edge is `fixtures.loser_to_fixture` / `loser_to_slot`, written
  at Generate and only where it is still null (`server/usecases/stages/generate-tx.ts:803-807`, `:1231-1232`).
- Seating reads those stored edges. The ranks read them too (`bracket-stage.ts:243-247`).
- The only non-test callers of `generateDoubleElim` in the app are Generate itself (`generators.ts:532`) and a
  fixture count (`lib/format-max-entrants.ts:100`).
- So a stored bracket keeps the lines it was drawn with across the bump, with no version flag in stage config and no
  `drops` option on the generator. A flag nothing sets would be an inert seam.
- A Rebuild deletes and regenerates, so it draws the crossed order. That is ruling 295 as written.
- **One place does re-derive the bracket:** the matrix harness compares the stored rows with a fresh
  `generateDoubleElim` (`tools/matrix/lib/scenarios/terminal-finals.ts:36`, `lib/reference-bracket.ts:283-287`). It
  always runs on a fresh database (R14), so it never sees an old bracket.

**Smallest test that fails today.**
- **Property, any results (RB6-X6):** over n = 2…32, with seeded random winners, no two entrants meet again in the
  LB before round E(frame): 2, 3, 4, 5 at frames of 4, 8, 16, 32. The sweep reports LB matches checked and pairs
  checked; zero is a failure, and n=2 is excluded by name (RB6-E7).
- **A named case where right and wrong differ:** n=8, the loser of `WB 2.1` wins LB round 2. Under the rule they sit
  in `LB 2.2` against a loser of `WB 1.3` or `WB 1.4`, whom they cannot have met. Under straight drops they sit in
  `LB 2.1` against a loser of `WB 1.1` or `WB 1.2`, one of whom they beat. The test builds the result set that makes
  that rematch and asserts round 2 holds none.
- **Reachability:** a constructed result set gives a rematch exactly in round E(n), so the bound is tight and the
  test is not passing on "never".
- **Favourite wins every match (RB6-X7), on a fully seeded field only:** every entrant seeded and on the fold. Then
  there is exactly one LB rematch, the LB final, seed 3 v seed 2, for n ≥ 3. Straight drops give 1, 3 and 7 at 4, 8
  and 16, so n=8 and n=16 tell right from wrong and **n=4 cannot** (brief trap 3).
- **RB6-X7 is not claimed for a partly seeded or random draw** (review 1; the rulebook row is restated). The
  product draws the unseeded at random (ruling 268), and with the top 4 on the fold and the rest random the
  favourite-wins script gave 2 or 3 rematches in about 28% of draws at 16. So the engine test seeds all n for X7
  and asserts X6 on every draw. A test that expected "exactly one" on an unseeded stage would be red for a correct
  bracket, and the tempting repair would be to loosen the constant.

### 4.4 A forfeit is one loss (OWNER 294; retirement OWNER 302; double walkover OWNER 301; RB6-F1 to F12)

**Rule.**
- A forfeit or no-show on one match, an organiser's award against one side, and (OWNER 302) a retirement mid-match are
  **one loss**. In the WB the side drops to the LB seat that match's loser takes. The opponent advances with a
  walkover win (RB6-F1, F2, F11).
- A forfeit by a side already in the LB is its second loss: out, ranked at that LB round (RB6-F3).
- **Withdraw and disqualify are unchanged:** out of the whole stage at once, every later seat walks over, never a
  drop (RB6-F4).
- **Double walkover:** in the LB both are out (RB6-F5). In the WB, OWNER 301 keeps X-DW-2: both are out, the LB seat and
  the next WB seat each walk over (RB6-F7). On GF1 or the reset it is refused and the match stays open (RB6-F8).
- A forfeit in GF1 by the WB champion earns the reset when it is on; by the LB champion it ends the stage. A forfeit
  in the reset is the forfeiter's second loss (RB6-F9, F10).

**Today (read).**
- Every `award` names no loser to send on: `advancingSides` returns `loser: undefined` for `award`
  (`server/engine-db/fed-seats.ts:146-165`) and `killsLoserEdge` is true for any `award` (`:121-124`).
- `loserFeederIsDead` reads the same predicate (`server/usecases/stages/bracket-seats.ts:222-236`).
- The engine pins a `walkedOver: "loser"` entrant out at that fixture for ranking
  (`src/competition/stage.ts:77-81`, `:969-977`).
- An `award` already carries its reason. The closed vocabulary is `walkover`, `retired`, `disqualified`, `withdrew`
  (engine `src/core/types.ts:136`), plus the system-only `bye`.
- The behaviour is pinned as correct by
  `server/engine-db/__tests__/double-walkover-seating.test.ts:189` ("X-DE-1: a winners'-bracket walkover loser is
  never seated in the losers' bracket…").

**What changes.**
- **The reason decides, and only in a double elimination** (designer's call). `walkover` and `retired` are one loss:
  the award names its loser down the loser edge like a win. `withdrew` and `disqualified` stay as today. A knockout's
  third-place seat keeps X-DE-1's reading unchanged, because ruling 294 names double elimination only.
- **The legacy chess forfeit is one loss too** (review 1). A stream stored before W2b folds a forfeit to a `win`
  with `method: "forfeit"` or `"walkover"` and no reason (`isLegacyForfeitWin`, `fed-seats.ts:113-115`). It is a
  match forfeit, not a withdrawal, so in a double elimination it drops like a `walkover` award. The rewritten
  seating test keeps its two-shape table (`award` and the legacy win).
- **One authority, not a second copy.** `advancingSides` and `killsLoserEdge` take the stage kind, and
  `loserFeederIsDead` keeps reading them. The un-fill path (`takenBack`, `fed-seats.ts:133-135`) reads the same two,
  so a taken-back forfeit releases the seat it filled.
- **Ranks agree with seats.** The app sets `walkedOver: "loser"` on the engine's `BracketFixture` only for an
  entrant who is out of the stage. A one-loss forfeit is passed as a plain loss, so `bracketRanks` ranks the entrant
  by their second loss (RB6-R6). The engine's doc comment on `walkedOver` and rule X-DE-1 change to say so.
- **The code is app-side; it lands in app PR B all the same** (designer's call). Three things tie it to the release:
  the amended X-DE-1 row ships in the engine, the reference family cites X-DE-1 by id
  (`packages/reference/src/families/bracket-finish.ts:350`), and a dropped forfeiter's place needs §5.1's ranks.
- **The pinned test flips.** `double-walkover-seating.test.ts:189` asserts the old rule in its title and its body.
  It is rewritten to the new rule, and its `withdrew` and `disqualified` halves stay as they are.
- **What an organiser's award (M9b) stores** is not read. The truth run establishes its outcome shape before the
  plan assigns it a reason.

**Smallest test that fails today.** n=4, badminton, through the real usecases: record a walkover on `WB 1.1`. The
absent side must be seated in `LB 1.1`. Today it is not. Then the sequence (R27): the same entrant forfeits `LB 1.1`
and is out, ranked with that round; a `withdrew` award in the same seat still never drops; a boardgame bracket gives
the same seats (another sport); a double walkover on `WB 1.1` seats nobody in the LB (OWNER 301).

## 5. Places, late entry, the two carries, small fields (OWNER, 2026-11-23)

### 5.1 Places below 4th are shared by losers'-bracket round (OWNER 297; OWNER 303; RB6-R1 to R9)

**Rule.**
- Ranks cover every entrant of the stage exactly once, withdrawn and disqualified included (RB6-R1).
- 1st and 2nd are the deciding match's winner and loser. 3rd is the loser of the LB final. 4th is the loser of the
  one game in the LB round before it. **They are unique when the matches that decide them are played** (RB6-R2).
  The reset setting changes only who is 1st and 2nd (RB6-R4).
- Entrants who went out in the same LB round share a place: 1 plus the number who went out later. Seed does not
  order them and neither does id (RB6-R3). With every match played this shares from 5th down. A round with one
  real loser gives an unshared place; a round with no match gives none (RB6-R5).
- **A double walkover can leave a top place unplayed (OWNER 305(d); RB6-R10).** The entrants out in that round share by
  the same formula and the next place is skipped. The stage always completes. n=4, a double walkover in `LB 1.1`:
  two at 3=, nobody 4th. n=8, a double walkover in `LB 2.1`: three at 4=, nobody 5th or 6th. n=8, a double walkover
  in `WB 2.1`: the loser of `LB 3.1` is 3rd and three share 4=.
- A withdrawn or disqualified entrant takes the place of the LB round of the seat they vacate (OWNER 303; RB6-R7). A
  finalist who is out at the deciding match is its loser, 2nd.
- A vacant title is two 2nds and no 1st; joint winners are two 1sts and no 2nd (RB6-R8).

**Today (read).**
- `bracketRanks` orders everyone below the title by round of last loss, then seed, then id (`rankRest`,
  engine `src/competition/stage.ts:1010-1017`), and places each strictly (`placeNext`, `:1030`).
- `FinalPlace` is `{ entrantId, rank }` and can already tie (`:199-202`), since W4.
- The completed-stage guard allows a shared rank only at 1, 2, 3 or 4 (`BRACKET_SHARED_RANKS`, `:208`), never more
  than two holders (`:777-779`), and only where `declaredPlaces` says so (`:747-761`). `declaredPlaces` has a branch
  for `knockout` and none for `double_elim`.
- The matrix invariant I2 checks rank 1 and that the ranks are a permutation, nothing below
  (`tools/matrix/lib/invariants.ts:138-141`).

**What changes (engine).**
- **`bracketRanks` gains a double-elimination branch.** Each entrant below the title gets an **exit round**: the
  round of the LB fixture of their second loss, or, for an entrant a walkover put out of the stage, the round of the
  LB fixture the vacated seat belongs to (their own LB fixture, or the LB fixture their WB fixture's loser edge
  feeds, read from `homeFrom` / `awayFrom`). Entrants are grouped by exit round, later first, and every member of a
  group gets `1 + (entrants placed above)`.
- **The shape of `finalRanks` does not change.** It is still `FinalPlace[]` in non-decreasing rank order. What
  changes is which ranks may repeat and how many may hold one.
- **The guards.** `assertBracketPlaces` (`:707`) is structural and stays as it is. `assertCompletedBracketPlaces`
  (`:767`) gains a double-elimination branch. **It checks coverage and the title, never "four distinct top
  places"** (review 1; OWNER 305(d)):
  - the "at most two" and `BRACKET_SHARED_RANKS` checks apply to the other three kinds only;
  - every declared entrant is ranked exactly once (the structural check);
  - there is one champion, or the title shape the deciding match declares: joint winners (two 1sts, no 2nd) or a
    vacant title (two 2nds, no 1st);
  - below the title, the order follows exit rounds: a later exit round always ranks better, entrants with the same
    exit round hold the same rank, no rank is shared across exit rounds, and every rank is competition ranking
    (`rank = 1 + entrants placed above`).
  The exceptions are not a list of rounds. A double walkover in any round changes who exits where, and the same
  four relations still hold. So no double walkover can make the guard refuse a stage.
- **No vacant 2nd in a double elimination** (designer's call). W4's B3-6 leaves 2nd vacant in a knockout when the
  champion won the final by walkover over a dead seat. Here the formula ranks whoever went out last 2nd, so the
  only place with no holder at the top is a vacant title's 1st.
- `BRACKET_SHARED_RANKS` keeps its name and value for knockout, stepladder and page playoff. Its doc comment says it
  no longer bounds a double elimination.
- **Mid-bracket reads stay provisional** and never refuse for shape, as today.

**What changes (app, PR B).** Every reader of a bracket's ranks must show "5=" for a shared 5th, on a field of any
size. W4 taught the readers a shared 3rd; whether any of them assumes "at most two share" or "only 1 to 4 share" is
not read. The builder enumerates the readers by behaviour (grep `finalRanks` and the placement snapshot), not by
filename: the placement snapshot, `champion.ts`, the public standings API, the bracket views, the hub, the embed,
`/present`, the OG card and exports.

**Smallest test that fails today (engine).** n=8, every match played, the two LB round-2 losers must both rank 5 and
the two LB round-1 losers both 7. Today (read) they rank 5, 6, 7, 8 by seed. Named odd cases from the rulebook's
table: n=7 has one 7th, n=6 has no 7th, n=5 has one 5th. **n=4 cannot tell right from wrong** (every place is
single), so it is never the only case. **Expected places are computed in the test from the reference's formula**
(RB6-R3: exit round, then `1 + entrants out later`), never read from `bracketRanks` and never typed in as a table
(R9). The rulebook's place tables are a cross-check on the reference, not the test's source.

**Named double-walkover cases (review 1; OWNER 305(d)), each must complete and rank as RB6-R10 says:** n=4 `LB 1.1`;
n=8 `LB 2.1` (the round before the 4th-place game, three at 4=); n=8 `WB 2.1` and n=8 the WB final (OWNER 301: both
out, LB-final seats vacated); n=8 the LB final itself (two at 3=). Today (read) the guard would refuse three
holders of one rank (`stage.ts:777-779`).

### 5.2 Late entry into winners'-bracket round 1 (OWNER 296, 271; OWNER 304; RB6-L1 to L8, B6)

**Rule.** Only where the double elimination is the division's entry stage. The late entrant joins WB round 1 only,
never round 2, never the LB. The server tries, on the organiser's tap:

| Case | Condition | What happens |
|---|---|---|
| **(1) Take a bye** | A WB round-1 bye whose holder has not started their WB round-2 match, **and** (OWNER 304) no entrant who advanced by bye through an LB line the reopened bye changes has started their next LB match | A new WB round-1 match against the bye holder. The bye is reversed. The LB seat that line feeds becomes live again (RB6-B6), and LB byes that no longer hold are taken back. With several open byes, the lowest-seeded holder's. |
| **(2) Take a withdrawn slot** | A withdrawn entrant's WB round-1 slot before its first match (W4's rule, walkover reversal included) | The late entrant takes the slot. |
| **(3) Refuse** | Otherwise | A named refusal. With no result and no called match anywhere in the stage it offers Rebuild, with W4's 2026-11-09 amendment and the frozen-schedule answer. |

An automatic arrival (payment confirmation, waitlist promotion, import, Reinstate) is never auto-placed and never
refused: it waits on the entrant list with a desk flag, and one tap runs the cases (OWNER 271; RB6-L7).

**Today (read).** `ROOT_KNOCKOUT_KINDS` is `["knockout", "stepladder", "page_playoff"]`, and its comment says
double elimination is left out as W4 scope (`lib/open-entry-stages.ts:53-56`). So no entry-stage predicate answers,
and the start lock throws its 422 (`server/usecases/entrants.ts:448-463`). The organiser's add tries the Swiss
admitter, then the knockout one, then the table one (`:579-591`).

**What changes (app PR A; no engine change).**
- **Reuse W4's cases; do not write an engine helper** (designer's call). W4's decision is app-side
  (`lib/knockout-late-entry.ts`, applied by `server/usecases/knockout-late-entry.ts`). The engine's
  `lateEntryFixtures` is a round-robin catch-up (`src/scheduling/catch-up.ts:69`) and does not fit a bracket.
- `double_elim` joins the entry kinds. The admitter reads a double elimination's **WB round-1 lines only** (ext_key
  prefix `wb-`) and hands them to the same decision function. A fed double elimination still never takes one.
- Case (1) gains the LB condition (OWNER 304), using the one "started" predicate (X-LE-9).
- **Reversing the bye re-works the dead seats from the new draw** (review 1). The admitter computes the draw's dead
  seats for the field with the newcomer (§5.3's one pure function) and applies the difference to the LB:
  - a seat that is no longer dead loses its mark and waits for a real loser;
  - a dead line that is now a bye, or a bye that is now a match, is reopened;
  - **an LB bye that was already settled is taken back.** The entrant who advanced is un-seated from the next LB
    line by the existing release plan (`server/engine-db/fed-seats.ts`; `takenBack`, `:133-135`, is the reading
    it uses), and the line returns to `scheduled`. The release plan already refuses with `NEXT_MATCH_STARTED` when
    the next line has started (`:458-460`), which is OWNER 304's condition, and revives a void line (`:455-457`).
  - **Two writers, two jobs** (review 2). The release plan un-seats and reopens. The `drawDeadSeats` difference
    then writes the draw marks and the void state of draw-dead lines, and it is the only writer of those. It runs
    last. The test compares the LB's labels and statuses with a fresh Generate at the new size, so a disagreement
    between the two is seen.
  - The changed line is not always the one the bye fed. At n=5 → 6 the bye's own LB line (`LB 1.2`) was dead and
    becomes a bye, and `LB 2.2` was a bye and becomes a match. The entrant to pull back is whoever advanced
    through `LB 2.2`'s bye, **read from the stored rows**. Which WB game they lost depends on the drop pattern
    (straight on engine 10.0.3, crossed after the bump), so neither the code nor the test names the WB game
    (review 2).
- The new WB round-1 match must have a loser edge to its LB seat. Generate wires a loser edge wherever the source
  row exists and the edge is still null (`generate-tx.ts:803-807`), and review 2 read that this includes bye rows.
  The test asserts the edge on the reopened line.
- Reused as is: the `knockout_late_entry` undo barrier, the four automatic-arrival doors, the waiting strip
  (`knockoutWaiting`), `LateEntryResult` and its case names, the client mirror and its drift test, the Start
  dialog's copy.

**Smallest test that fails today.** n=7, started, one WB round-1 bye whose holder has not started round 2. The
organiser's add must answer `late_entry` with case `bye`, a new `wb-` round-1 match, and a live seat on `LB 1.1`.
Today it answers the start lock's 422. Sequence: a second late player (n=6 has two byes); after a withdrawal
(case 2); after the bye holder's LB neighbour has played on (OWNER 304, the next case is tried); a fed double
elimination (refused); an automatic arrival (waits, then the tap places it). **And the take-back (review 1):** n=7,
`LB 1.1`'s bye already settled and its entrant seated in LB round 2 but not started, then a late entry: the entrant
is back on `LB 1.1`, LB round 2's seat is open, and nothing is settled on `LB 1.1`. n=5 → 6: `LB 2.2` is a match
again.

### 5.3 A line with a dead seat is never scheduled (OWNER 299; brief carried 1; mechanism OWNER 305(c); RB6-B1 to B5, E6)

**The first draft's mechanism is withdrawn** (review 1). It stamped a seat "whose loser feeder is a bye line" from
inside the seat resolver. That missed dead seats that come down a winner edge, fired after a withdrawal too, and
could write a dead line as a double walkover. This section replaces it.

**Rule.**
- A WB round-1 bye has no loser, so the LB seat its loser would take is dead from the draw, known at Generate
  (RB6-B1).
- An LB line with one dead seat is not a match: the entrant on the live seat advances by bye the moment they
  arrive, with no win credited and no loss (RB6-B2).
- A line with two dead seats is dead. It is void, never a double walkover, and the seat its **winner** feeds is
  dead from the draw too (RB6-B3, E6). So deadness runs down both edges until nothing changes: at n=5 `LB 1.2` is
  dead and therefore `LB 2.2` has a dead seat. The same shape appears at n = 9 to 11 and 17 to 23.
- A line with a dead seat holds no time and no court at any moment (RB6-B4).
- A seat vacated during play is different: a walkover, which is a credited win (RB6-B5; ruling 264).

**Today (read).**
- A bye award's loser edge already reads as dead (`server/usecases/stages/bracket-seats.ts:222-236`), and the seat
  is stamped with the bye label once the other seat holds an entrant (`:547-563`).
- While **both** seats are open the resolver leaves the line alone unless both are dead (`:507-512`). In that
  window the line carries no bye label, so `isByeLine`'s pre-award arm (`lib/bye-line.ts:53-66`) is false, its SQL
  twin `byeLineSql` (`server/engine-db/system-bye-sql.ts:47-54`) is false, and `isMovable`
  (`server/usecases/schedule/board.ts:40-42`) is true. Auto-schedule can place it.
- In the resolver a bye label on an open seat means **departure**: `seatDeparted` returns true for it (`:266`), and
  a line whose two seats are both departed is written `forfeited` with `{kind: "double_walkover"}` (`:513-528`).
  Any other pair of dead seats is written void, `status = 'abandoned'` (`:531-536`). The engine throws on a
  "both" row that is missing a side (engine `src/competition/stage.ts:843-845`).
- The insert already labels a seat from two generator facts: a bye row (`g.award`) and a departed seat
  (`g.departedSeat`) (`server/usecases/stages/generate-tx.ts:696-705`).
- The pre-award arm's own comment lists "a withdrawal's dead seat waiting on the side that walks over it" among
  the shapes it covers (`lib/bye-line.ts:50-52`). So "is a bye line" is not the same as "is dead from the draw".
- The all-format placement sweep excludes `double_elim` by key and names W6
  (`server/usecases/__tests__/template-placement-sweep.test.ts:93-101`); its engine oracle draws no double
  elimination (`:207-213`).

**What changes (app PR A).**

1. **The dead seats are computed from the draw, by one pure function.** `drawDeadSeats(bracket)` (client-safe, in
   `lib/`) reads only the generator's output: the fixtures and their `homeFrom` / `awayFrom` feeds. It never reads
   a status, an outcome or an entrant's state.
   - Base: a WB round-1 line the generator drew as a bye has no loser.
   - Step: a seat fed by the **loser** of a line that has no loser is dead. A seat fed by the **winner** of a
     line with two dead seats is dead.
   - Repeat until nothing changes. A line then has 0 dead seats (a match), 1 (a draw bye) or 2 (draw-dead).
   - It returns the set and its size; an empty set on a field that is not a power of two is a failure.
2. **Generate writes the result on the rows, in its first-pass insert**, where the labels are already chosen
   (`generate-tx.ts:696-705`):
   - a dead seat gets the bye slot label **with a parameter that says it came from the draw**
     (`{ key: "bracket.slot.bye", params: { from: "draw" } }`);
   - a line with two dead seats is also written void in the same pass, as the insert already can
     (`:707-708`: "`abandoned` is what a VOID line is in this column").
   **The fed draw path writes them too** (review 2). A double elimination fed by an earlier stage
   (`timing: "setup"`) is not drawn by that insert. `writeProgressionSetupFixtures` takes the generator's output
   (`server/usecases/stages/setup-fixtures.ts:158`) and writes labels in its own pass (`:326-376`), with the bye
   label on `g.award` rows only (`:370-376`). So today a fed double elimination with a field that is not a power
   of two keeps its schedulable dead lines.
   - The same `drawDeadSeats` runs on that output, and that pass writes the draw mark and the void line. Its two
     guards on the bye key (`:341-350`) already keep a later re-Generate from overwriting a mark.
   - **A draw mark is not "awaits the seed draw".** `fixtureAwaitsSeedDraw` reads any labelled empty seat with no
     outcome as owed (`lib/division-phase.ts:192-196`), and `stageOwesDraw` keeps the desk's red draw row while
     any line says so (`:762-768`). A draw-dead seat is never filled and a void line never gets an outcome, so the
     row would stay red after the confirm. So `fixtureAwaitsSeedDraw` reads the label's parameter: a seat marked
     `from: "draw"` is not owed. A WB round-1 bye's plain label keeps counting until the confirm, as that
     function's comment says (`:165-169`).
   - This is the second and last reader of the parameter; the resolver (item 4) is the first. Both ask one small
     client-safe helper in `lib/`, so the parameter is spelled in one place.
   - Three renderers show a sibling-fed seat from its feed edge when it has no stored label
     (`server/public-site/data.ts:356-360`, `server/usecases/fixtures.ts:370-374`,
     `components/v2/desk/run-sheet-row.tsx:253-257`). A draw-marked seat has a label, so they show "Bye".
   - Whether a fed double elimination can be built today is not driven. Review 2 read that the create schema
     takes a progression on any kind; the truth run builds one.
3. **The existing single authority then answers, unchanged.** `isByeLine`'s pre-award arm asks "scheduled, no
   outcome, an empty side whose label key is the bye key" (`lib/bye-line.ts:44-58`), and `byeLineSql` asks the same
   (`system-bye-sql.ts:47-54`). Both compare the label's **key** only, so a draw-dead seat is a bye line to both,
   from the moment of Generate, while its other seat still waits on a feeder. No arm is added, no second predicate
   exists, and V493's SQL-equivalence test holds untouched. One row is added to the shared shapes table
   (`lib/__tests__/bye-line-shapes.ts`): "both seats open, one carrying the draw label".
4. **The resolver learns one thing: a draw label is not a departure.** `seatDeparted` reads the label's parameter
   and answers false for a seat dead from the draw. So a line with a draw-dead seat whose other seat later dies
   (a withdrawal, a double walkover upstream) takes the **void** branch (`:531-536`), never the double-walkover
   branch (`:513-528`), and the engine never receives a "both" row with a missing side.
5. **When the live entrant arrives** the existing award path settles the line off its label, as a bye:
   `forfeited`, an `award` with reason `bye`, no loser, no event (RB6-B2). The builder pins the reason written.
6. **A withdrawal after the draw does not take this path, by construction.** `drawDeadSeats` reads the draw, and a
   withdrawal does not change the draw. The withdrawn entrant's seat keeps today's cascade: the plain bye label
   (departure), and ruling 264's walkover to the opponent, written as an `award` with reason `withdrew` naming the
   loser (`server/engine-db/fed-seats.ts:806-814`). That is a credited win (RB6-B5). Reinstate and Undo reverse
   that path as today and never touch a draw mark.
7. **The marks are re-worked whenever the draw changes:** a second Generate after the roster changed, a Rebuild,
   a late entry that reopens a bye (§5.2), and **the Generate-before-Start reconcile if double elimination joins
   it** (review 2; call 18). The reconcile turns a WB round-1 line into a bye and reopens one
   (`server/usecases/bracket-reconcile.ts:116`, `:124`), and each of those changes which LB seats are dead. One
   function applies the difference between the stored marks and `drawDeadSeats` of the new draw. A second call
   with no roster change writes nothing.
8. The sweep's `double_elim` key goes, `EXCLUDED_COUNT` becomes 3, and `engineBracket` learns `generateDoubleElim`.

**How this departs from the brief, and how it still meets ruling 299** (OWNER 305(c), §8). The brief says "fix at the ONE
authority (`isByeLine` / `byeLineSql` / `system-bye-sql.ts`), never a second copy". This design does not edit
those files. A dead seat that arrives down a winner edge cannot be seen from one row, so an arm in the predicate
would need to walk the bracket, twice (TypeScript and recursive SQL), which is the second copy the brief forbids.
Instead the fact is written on the row, and the same two readings stay the only code that answers "is this line
never scheduled". The authority is still one. What moved is where the fact is established: at the draw.

**Smallest test that fails today.** `double_elim`, through the real usecases: Generate, `autoSchedule` BUILD,
`applySchedule`.
- **The expected lines come from the reference's dead-seat table** (§6.4), not from the product and not from a
  count typed in. On a frame of 8: n=5 → `LB 1.1`, `LB 1.2`, `LB 2.2`; n=6 → `LB 1.1`, `LB 1.2`; n=7 → `LB 1.1`.
- **Assert the set, not "more than zero":** exactly those lines hold neither `scheduled_at` nor `court_id`, and
  every other unplayed line is placed (so the test cannot pass by placing nothing). The count checked is reported.
- The brief's own predicate, "a seat fed by a bye line's loser", matches 2 lines at n=5 and never looks at
  `LB 2.2`. It is not used.
- **n=9** (frame 16): the set includes lines reached only through a winner edge.
- **A power of two:** the expected set is empty, stated as a named case.
- **Sequence (R27; review 1):** a WB withdrawal after Start and then Reinstate (no draw mark changes; the walkover
  is written and reversed); both feeders of a draw-dead line still pre-award (void, not a double walkover; in PR A the
  assertion is that no "both" row missing a side reaches the engine, `stage.ts:843-845`, and the rank half of the
  case moves to PR B, since PR A reads no rank); the entrant heading for a draw bye withdraws (the line is void); a late entry that
  reopens the bye (the seat is live and placeable again); Generate twice.
- **The fed path (review 2):** groups → double elimination taking 5, through the real usecases. Before the
  confirm the stage owes its draw. After it: `stageOwesDraw` is false, over a counted, non-zero set of the
  stage's fixtures; the marked set is the reference's for n=5 (`LB 1.1`, `LB 1.2`, `LB 2.2`, count 3); `LB 1.2` is
  void; none of the three holds a slot after auto-schedule. Mutant: drop the parameter read in
  `fixtureAwaitsSeedDraw`, and the draw row must stay red.

### 5.4 Rebuild carries a double elimination by role (OWNER 299; brief carried 2; RB6-P1 to P4)

**Rule.** Rebuild keeps times and courts with each match's role: the lane (WB, LB, GF1, reset), the number of rounds
before that lane's own final, and the game number in the round. A role with no match in the old bracket starts
unscheduled and is flagged. A role with no match in the new bracket releases its slot. A bye or dead line holds
none.

**Today (read).** `ROLE_CARRY_KINDS` is knockout, stepladder and page playoff, and its comment says a double
elimination still carries by position (`server/usecases/stages/generate-tx.ts:944-948`, used at `:1165-1169`).
`bracketRoleKey` counts back from one final per pool (`lib/bracket-role.ts:44-48`). `carrySlots` documents the gap
(`lib/rebuild-slots.ts:148-164`). The defect is pinned: "a double-elimination Rebuild still carries by position"
(`server/usecases/__tests__/rebuild-one-transaction.test.ts:546-575`).

**What changes (app PR A; no engine change).**
- **The role key is app-side, beside the knockout one** (designer's call). `lib/bracket-role.ts` gains a
  double-elimination key: `<pool>:<lane>:<rounds before that lane's final>:<seq>`, with GF1 and the reset as two
  fixed keys. The lane comes from the stored `ext_key`, which the app already parses (`parseExtKey`,
  `bracket-stage.ts:228`). Each lane's final round is the highest `round_no` in that lane.
- The engine's `roundRole` answers per round and for display (`src/competition/round-role.ts:55-98`). It is not
  extended: a display role has no game number, and Rebuild already reads the app's key for three kinds.
- `ROLE_CARRY_KINDS` gains `double_elim` with that keyer.
- The pinned test flips to the rule: on 4 → 5 the new grand final inherits the old grand final's slot, and the LB
  final the LB final's.
- The Rebuild confirm's sentence "Times and courts stay with each match's place in the draw" becomes true for this
  format; no copy change is owed.
- **A draw-dead line never takes a carried slot and is never flagged** (review 1; RB6-P3). The order was read:
  Rebuild deletes, calls Generate (`generate-tx.ts:1126`), and maps the new rows with `bye: isByeLine(...)` over
  the rows Generate returns (`:1141-1147`). Generate reads those rows (`:895`) after its insert and after the
  resolver (`:887`). So a line with **one** dead seat carries its draw label by then and reads as a bye. A line
  with **two** is void by then, and `isByeLine` is false for a void line.
- **`carrySlots` must be told a row is void** (review 2, read). Its rows carry no status, only `bye`
  (`CarryRow`, `lib/rebuild-slots.ts:111`, read at `:123`), so a void draw-dead line is an ordinary line to it and
  takes a carried slot wherever its role held a real match before. So the mapping at `generate-tx.ts:1141-1147`
  passes `bye: true` for a new row that is void as well as for a bye line. The row it maps is the one
  `isByeLine` already reads a status from. A `bye` row never gives or takes a slot and is never flagged, and a
  line that becomes one frees the slot its position held (`rebuild-slots.ts:141-146`).

**Smallest test that fails today.** The pinned case, inverted: 4 → 5 Rebuild, expected = each old slot keyed by
role. It counts lines checked, and it asserts the premise that position and role disagree on the rig, as the
pinned test already does. On 4 → 5 the three new draw-dead lines (`LB 1.1`, `LB 1.2`, `LB 2.2`) hold no slot and
are not in the `unscheduled` count. Sequence: a second Rebuild with no roster change keeps every slot; 5 → 4 (roles
disappear, slots released and counted); 8 → 9 with the reset on (the reset keeps the reset's slot).

**The case 4 → 5 cannot see (review 2).** On 4 → 5 every dead line's role is new, so only the flag is tested. A
void line that takes a slot needs a role that held a real match:
- **8 → 5**, every old LB line on a court. Old `LB 1.2` was a match; new `LB 1.2` is void. It must hold no time
  and no court, its old slot must be in the freed count, and it must not be in `unscheduled`. The bye lines
  (`LB 1.1`, `LB 2.2`) hold none either.
- **16 → 9**: the same, with the void lines reached through a winner edge.
- The expected void lines come from the reference's dead-seat table, and **their count is asserted above zero**
  (1 at n=5), so the case cannot pass on a bracket with no dead line. Mutant: pass `bye: false` for a void row.

### 5.5 Small fields, the match layer, the gate (OWNER 304; OWNER 299; RB6-E1 to E7, M1 to M5, N1 to N3)

- **n=2 and n=3 stay offered** (OWNER 304). n=2: one WB match, no LB match, GF1 is the same pair. n=3: seed 1 has the
  bye, `LB 1.1` has a dead seat, places are 1st to 3rd (RB6-E3, E4). Today the generator builds both
  (`bracket.ts:507-511` for the n=2 feed).
- **0 and 1 entrants are refused by name** (RB6-E1, E2). Today the generator returns the WB's fixtures and no grand
  final when the WB has no final (`bracket.ts:447`). What the app answers is not read. The engine throws
  `CONFIG_INVALID` with a named reason for fewer than 2; the app refuses Generate before it calls the engine, with
  copy in 4 locales. **The throw reaches every caller** (review 1): `linesOfShape` passes a field of 0 or 1
  straight to the generator (`lib/format-max-entrants.ts:89-100`; `field = n > 0 ? n : 0` at `:90`). So in PR B
  `linesOfShape` answers 0 for a double elimination below 2, as the knockout arm does by returning no fixtures,
  and a test asks the count at 0 and at 1.
- **Every match needs a winner** (RB6-M2). X-DV-1 already names double elimination (`rules/cross-sport.md:56`).
- **Boardgame takes no rule of its own** (OWNER 299; RB6-M3). The truth run drives a drawn boardgame game on this
  row and records what it sees. No build is planned for it.
- **"Third place" is not offered on this format** (RB6-M4). The builder shows the control only where the template
  draws a stage of kind `knockout` (`lib/division-builder/format-choice.ts:60`, `:65-67`), so it is already hidden
  for the `double_elim` template there. The stage-settings mount is behind `stage.kind === "knockout"`
  (`components/v2/stages-panel.tsx:2297-2298`), so it is hidden there too. Closed as a read; the truth run looks
  at the screen.
- **The gate is unchanged** (OWNER 299; RB6-N1, N2). `stageNeedsDoubleElimGate` gates `double_elim` and
  `page_playoff` on one key (`server/usecases/format-gates.ts:40-43`), pinned by
  `server/usecases/__tests__/format-gates.test.ts:34`. The denied-state case is observed on the truth run as ⛔ with
  guidance. Nothing here edits the gate.

## 6. Where everything lands

### 6.1 Engine PR (seazn.club.engine) → release 11.0.0

**Why a major** (designer's call). The engine is a separately published package. Three public behaviours change for
the same input: `generateDoubleElim` returns different `awayFrom` feeds, a double elimination's `finalRanks` can
repeat a rank below 2nd and hold more than two at one rank, and `completeBracketStage` throws where it returned.
Any of the three is a breaking change, so the release is **11.0.0** from 10.0.3. No match-fold change is planned, so
no fold-epoch raise is expected; the builder confirms it from the release's own report.

| Item | Gaps | Rule |
|---|---|---|
| Crossed drops in `generateDoubleElim`: the four-step cycle as one named pure function, with its self-inverse test; ids unchanged; no `drops` option | FX-G4 | OWNER 295, 300; RB6-X1 to X5 |
| Rematch property tests over n = 2…32, odd fields included. RB6-X6 (the bound E(frame), its reachability case, the n=8 differential case) on every draw, seeded and random. RB6-X7 (exactly one) on fully seeded fields only. Each reports LB matches and pairs checked | FX-G4 (test half) | OWNER 300; RB6-X6, X7, E7; R25 |
| `bracketRanks`: double-elimination branch, places by exit round; a walked-out entrant's exit round read through the loser feed; an out finalist is the deciding match's loser | ST-G33 | OWNER 297, 303, 305(d); RB6-R1 to R10 |
| `assertCompletedBracketPlaces`: double-elimination branch that checks coverage, the title and the exit-round relations, never four distinct top places; `BRACKET_SHARED_RANKS` scoped to the other kinds | ST-G33 | OWNER 305(d); RB6-R1, R10 |
| `resetOwed(fixtures)` exported, read from GF1's feeds; `BracketFixture.conditional`; `bracketCompletionRefusal` reason `reset_owed`; `bracketTitle` undefined while owed | void-reset, joint-GF | OWNER 298, 305(b); RB6-G7, G10, G11 |
| `walkedOver: "loser"` documented as "out of the stage" for a double elimination; a one-loss forfeit is a plain loss | FX-G24 (engine half) | OWNER 294, 302; RB6-F1, F11, R6 |
| `generateDoubleElim` refuses fewer than 2 entrants with a named `CONFIG_INVALID` | small fields | RB6-E1, E2 |
| Ranks and structure tests at n=2 and n=3 by name | small fields | OWNER 304; RB6-E3 to E5 |
| Rule rows in `rules/cross-sport.md`; X-DE-1, X-FR-1, X-FR-2, X-FR-3 amended (§12) | rule rows | G11 |
| A real changeset (major), and `Matrix rows: double_elim|<sport>` in the PR body (R27) | — | R27 |

Every engine test under `src/scheduling` and `src/competition` sweeps the sport registry or carries a one-line
reason for pinning one sport (R26). The generator and the ranks take no sport, so their tests carry that reason; the
sport sweep is the app's (§6.6).

### 6.2 App: work that needs no engine change (PR A, can run before the release)

**The test for this list** (OWNER 305(e); review 1): every item here passes on engine 10.0.3, with straight drops
and strict ranks. Anything that can only pass on 11.0.0 is in §6.3. Review 2 checked each item against that test;
the last column is the result.

| Item | Gaps | Rule | On 10.0.3 |
|---|---|---|---|
| Truth run on the row first: the 11 cells, the denied state, n=2 and n=3, MB-007/009/010, a drawn boardgame game, what an organiser's award stores, which actions settle `gf-reset` without a result, auto-advance on an n=5 bracket, a fed double elimination | all of §9 | R5, R20 | clean: it observes main |
| **The reference's dead-seat table only** (`packages/reference`, §6.4): a new module, not registered as a family, citing no rule id | — | R7, R8, R9 | clean: the set is the same under straight and crossed drops, and it adds no id the installed table lacks |
| Draw-dead seats: `drawDeadSeats`, the labels in Generate's insert **and in the fed draw pass**, the resolver's draw-versus-departure reading, `fixtureAwaitsSeedDraw`'s reading of the draw mark, the re-work when the draw changes (§5.3) | carried 1 | OWNER 299, 305(c); RB6-B1 to B4 | clean: nothing here reads a drop or a rank |
| **The open count reads a stored void line as settled** (§4.2), folded through `completionEngineStatus`, with its named cases (n=5, a knockout third-place void, a league and a Swiss No result, a recorded abandon that still holds). The reset clause stays in PR A | void lines and auto-advance | RB6-B3, B4 | clean: no engine symbol; needed here because this PR writes void lines at the draw |
| The placement sweep takes `double_elim` (`EXCLUDED_COUNT` 4 → 3; `engineBracket` learns `generateDoubleElim`) | carried 1 (T6-g) | OWNER 299 | clean: the installed generator is on both sides |
| Rebuild carries by lane role; the pinned defect test flips; a void or bye line takes no slot and is not flagged (4 → 5, 8 → 5, 16 → 9) | carried 2 | OWNER 299; RB6-P1 to P3 | clean: lane, rounds before the lane's final and game number do not depend on the drops |
| Late entry into WB round 1: entry kinds, admitter, the LB condition, the dead seats re-worked and settled LB byes taken back, client mirror and Start copy | S3-late-entry | OWNER 296, 271, 304; RB6-L1 to L8, B6 | clean **once the test reads the pulled-back entrant from the stored rows** (§5.2); as first written it named a WB game that is right only under crossed drops |
| Generate refuses 0 and 1 entrants by name, in 4 locales (the app's own refusal, before it calls the engine) | small fields | RB6-E1, E2 | clean |
| Generate after a roster change or a withdrawal, and a withdrawal while waiting on a TBD opponent: fixed if the truth run reproduces them; fences lifted with the fix | MB-007, MB-009, MB-010 | R5 | clean |
| Catalogue debt: stale audit evidence, the three regressions given a wave (§6.6) | T6-e, T6-f | R5 | clean: FX-G24 is recorded as "overturned by ruling 294, built in PR B", not as fixed |

**What left PR A in this round** (review 2). The rest of the reference family: the drop table, "reset owed", the
places, the forfeit seating, the new rule ids and the amended X-DE-1 answer. On 10.0.3 it would be red twice. The
family's test requires every id it cites to be a signed row of the installed table
(`packages/reference/src/families/bracket-finish.test.ts:242-243`), and the new rows do not exist there. And the
family encodes today's X-DE-1, "a forfeit's loser is never seated on a loser edge"
(`packages/reference/src/families/bracket-finish.ts:322-326`), which the product keeps until PR B. It all moves
to PR B (§6.3, §6.4).

**PR A's tests cite no W6 rule id in their titles** (designer's call). The ids are not rows of the installed
table until the bump. Whether the app's checker reds on an unknown id in a title is not read, so PR A does not
depend on it: PR B adds the ids to those titles in the bump commit.

**Why the dead-seat work can use the reference's table on 10.0.3.** Which LB lines have a dead seat depends on the WB
round-1 byes, LB round 1 (the same order in both patterns) and the LB's winner edges. It does not depend on where a
WB round-2 loser lands. So the reference's dead-seat table is the same set under straight and crossed drops, and
PR A's test is green before the bump and stays green after it. Review 2's script found the set identical under
both patterns for n = 2…64.

PR A changes no drop and no rank, so it can merge while the engine PR is in review.

### 6.3 App: after the engine release (PR B, bump to 11.0.0)

| Item | Gaps |
|---|---|
| Engine bump. No app code change for the drop order: Generate draws what the engine returns. `linesOfShape` answers 0 below 2 entrants for a double elimination (§5.5). The W6 rule ids are added to PR A's test titles. The app's awaiting-proof pins are updated to the installed table (§12) | FX-G4 (close) |
| **The reference family, first task after the bump commit** (§6.4): the drop table, "reset owed", the places, the forfeit seating by reason; the new rule ids on the family's list; today's X-DE-1 answer changed for a double elimination. Written by the reference agent from the rulebook, before any matrix comparison task | — |
| Every reader of bracket ranks shows shared places, including three at one place (§5.1), enumerated by behaviour | ST-G33 (close) |
| A forfeit is one loss: `advancingSides` / `killsLoserEdge` take the stage kind and read the award's reason; the legacy forfeit win reads as one loss; `walkedOver` set only for an entrant out of the stage; the X-DE-1 pinned test rewritten | FX-G24 |
| `settleReset`: the reset row seated exactly when owed, run in every seat-resolver pass and after the release plan; Complete's guard calls it and loses its own derivation; the public champion reads the stored reset; the completion read's derivation and the open count's reset clause deleted; the shapes table over the four readers; the sequence test; named refusals for settling an owed reset without a result; a GF1 correction that changes the winner after the reset started is refused; "Not needed" on the lists (§4.1, §4.2) | void-reset |
| "Declare joint winners" on the deciding match: the kind refusal removed, the reset refusal replaced by one clause in the shared predicate, **and the server usecase's own `conditional` refusal removed**; the pinned test rewritten | joint-GF |
| The reset setting: default written on create; the change usecase that adds or removes the reset row; locked once GF1 has a result; the owner's chosen layout (R24); 4 locales + `pnpm i18n:gen-keys`; the estimate; the API schema description and changelog (§4.1) | reset API-only |
| Bracket views: the reset reads "if needed" before GF1 and is absent once not needed; screenshots at 1280, 768, 320 | reset API-only |
| **The matrix cases that compare the product with the reference:** the reset variant row (T6-a), I2's full order (T6-b), the field sweep (T6-c), the loser-seat check routed through the reference (T6-h), the sequence model (T6-i); L3 re-baselined in the same change as each fix (T6-d) | §6.6 |
| Full e2e on the row by CI dispatch: reset earned and played, reset not needed, a forfeit that drops, a late entry in each case, an odd field, a Rebuild across a size change, the setting changed after Generate | T6-c |
| Staging clean-up (§7) | — |

### 6.4 Reference family (`packages/reference`, seazn.club)

A double-elimination oracle, exact, written from the signed rulebook by **a different agent from the engine fixer**
(R8). It never value-imports the engine or the app (R7).

**PR A's table rests on rows that are still REC** (review 3). RB6-B1 and B2 wait for the batch sign-off (§8);
RB6-B3 is signed (305(c)). So the dead-seat table is drafted from REC rows and re-checked when they are signed. A
change to B1 or B2 at sign-off reopens the table and §5.3's expected sets. Signing B1 and B2 before PR A's
reference task removes the question (put to the owner, §8).

**Where it lands (OWNER 305(e); reviews 1 and 2).** Only what is true on engine 10.0.3 lands in PR A.
- **PR A: the dead-seat table, alone.** A new module with its own tests. It is exported from the package but not
  held in `FAMILIES`, the shape `packages/reference/src/index.ts:8` already describes for another module, and it
  cites no rule id. The registered list stays exactly `["bracket-finish"]`
  (`packages/reference/src/index.test.ts:18-19`).
- **PR B: everything else**, extending `bracket-progression.ts` and `bracket-finish.ts`: the drop table, the
  rematch properties, "reset owed", the places, the forfeit seating, the new ids on the family's list, and
  today's X-DE-1 answer changed for a double elimination. The matrix cases that compare the product with it are
  PR B too.

**When the reference agent works (R8).** Twice, and it is never the agent that wrote the engine PR:
- **in PR A, as the task before `drawDeadSeats` is built.** It writes the dead-seat table from RB6-B1 to B3. The
  implementer of `drawDeadSeats` is a different agent again, and does not read the table's source.
- **in PR B, as the first task after the bump commit and before any matrix comparison task.** It writes the rest
  from the signed rulebook and the released rule rows. It does not read the engine PR's diff. The model may be
  drafted while the engine PR is in review, since it depends on the rulebook alone; it merges only with the bump.

It covers:
- **the drop table** for any frame, from RB6-X1 to X3, and from it who can meet whom;
- **the rematch properties.** RB6-X6 for any draw. RB6-X7 for a fully seeded field only; for a partly seeded or
  random draw the oracle computes the expected rematch count for that stored draw, and never assumes one. It
  re-derives E(n) from the rule by enumeration and compares it with the rulebook's numbers (4→2, 8→3, 16→4, 32→5,
  64→7, 128→8). Review 1's script already reproduced them; a disagreement would be a rulebook finding, not a test
  to bend;
- **dead seats from the draw** at every n, down both edges, and which lines are matches, byes or dead
  (RB6-B1 to B3). This is the table §5.3's test reads;
- **whether the reset is owed**, for every settled state of GF1 and both settings (RB6-G11), including a GF1
  correction, an Undo, joint winners declared and undone, a forfeit by each side, and GF1 as a bye;
- **the full order of places** for a finished bracket, by the formula of RB6-R3: title, exit rounds, shared groups
  of any size, withdrawn and disqualified entrants, a finalist out, vacant title, joint winners, and the
  double-walkover cases of RB6-R10. Full order, not rank 1 only;
- **forfeit seating**: who drops and who is out, by reason, the legacy forfeit win included (RB6-F1 to F11).

Every check reports how many items it examined, and zero is a failure (R25). **In PR B** the family's rule-id
list (`bracket-finish.ts:350` holds X-DE-1 and X-DW-2 today) gains the new ids, so an unsigned or uncited row reds
it.
It is not a second generator: it states who plays whom from the rulebook's formulas, and is compared with the
engine's output in the matrix, never built from it.

**The seam it replaces (review 1).** The matrix's loser-seat check for a double elimination takes its expectation
from the engine's own generator: `loserSeatOf` (`tools/matrix/lib/reference-bracket.ts:286`) reads `layoutOf`,
which runs `BRACKET_OF`, which is `generateDoubleElim` (`tools/matrix/lib/scenarios/terminal-finals.ts:36`). That
is the code W6 changes, so the check would agree with any drop order the engine produced. R9 forbids it. In PR B
the double-elimination arm of `loserSeatOf` reads the reference's drop table. The other kinds are not touched.

### 6.5 The shared seams

- **Stored lines are the compatibility mechanism.** A bracket is its stored rows and their feed edges. Nothing
  re-derives a stored bracket from the generator in production (§4.3). Any new reader that calls
  `generateDoubleElim` to interpret stored rows breaks this, so the plan forbids it by name.
- **One bye-line authority.** `isByeLine` and `byeLineSql` stay the only two readings, held to one table of shapes.
  W6 changes what is written on the row at the draw, not what the predicate asks (§5.3; OWNER 305(c)).
- **One source of draw-dead seats.** `drawDeadSeats` is the only code that works them out. Generate, Rebuild and
  the late-entry admitter all apply its answer; none of them re-derives it from row state.
- **One loser-edge authority.** `advancingSides` and `killsLoserEdge` are the only readings of "who goes down the
  loser edge". Fill, dead-seat cascade and un-fill all read them, so a stage-kind argument reaches all three at
  once (§4.4).
- **One "reset owed" predicate: the engine's `resetOwed`.** The app calls it in one place, `settleReset`, which
  writes the answer on the reset row, in every seat-resolver pass and after every release plan. **A reset row is
  seated if and only if it is owed.** The completion read, the open count, `unsettledCount`, auto-advance,
  Complete's guard and the public champion read the stored row and derive nothing (§4.2). A table of GF1 shapes
  holds all six to the predicate.
- **One settle rule for the open count.** The engine's, through `completionEngineStatus`. No SQL copy (§4.2).
- **One reading of a void line.** The open count and the completion readers both treat a stored void as settled
  (§4.2). Rebuild is told a void line holds no slot (§5.4).
- **One spelling of the draw mark.** Two readers ask whether a label is a draw mark: the resolver and
  `fixtureAwaitsSeedDraw`. Both ask one helper (§5.3).
- **One role key per format.** `lib/bracket-role.ts` owns it. Rebuild reads it today; if the truth run reproduces
  MB-007 or MB-010, the Generate-before-Start reconcile (`lib/bracket-reconcile.ts:55-58`, knockout identity today)
  reads the same double-elimination key. No second identity.
- **W8 hand-off (brief trap 5).** W6 adds `conditional` to the engine's `BracketFixture` and changes when a reset
  reads as void. Sheet code is W8's. When the engine PR merges, the decision log tells the W8 lane: the rule is
  RB6-G6, the predicate is `resetOwed`, and no sheet file was edited.
- **R27's four questions, answered in writing at each review:** a second call (a second Generate, a second Rebuild,
  a second late player); an empty input (0 and 1 entrants, an LB round with no match); after a withdrawal or void
  (a withdrawn finalist, a voided reset, a taken-back forfeit); another sport (the R26 sweep).

### 6.6 Matrix and test debt (labels are this doc's)

| Label | Debt | What W6 does | PR |
|---|---|---|---|
| T6-a | The matrix has one `double_elim|<sport>` row built from the template, and no row sets the reset | The template row becomes "reset if needed" with the default. A **variant row** drives "single match" (OWNER 299). Regenerating the variant list is a reviewed change (R11). | B |
| T6-b | I2 checks rank 1 and a permutation only (`tools/matrix/lib/invariants.ts:138-141`) | I2 compares the product's full order with the reference oracle for `double_elim`, and counts entrants ranked; zero fails (RB6-R9). | B |
| T6-c | No field sweep: ranks and structure are not driven across sizes | A counted usecase sweep, specified below. | B |
| T6-d | L3 reds on the row sit in `baseline.json` | Re-baseline in the change that greens each. | B |
| T6-e | `gap-routing.json` routes FX-G3, FX-G4, FX-G24 and ST-G33 to W6 (`:52`, `:53`, `:73`, `:106`); `audit-verdicts.json` holds stale evidence for FX-G3 (`:16`) and FX-G24 (`:139`), citing code that has moved | Evidence rewritten from the truth run; FX-G3 recorded as closed by W4 with the void-reset concern in its place; FX-G24 recorded as a ruling overturned by 294. | A |
| T6-f | MB-007, MB-009 and MB-010 are "open" with no wave (`catalogue/regressions.json:95`, `:132`, `:150`), behind two fences | Given wave W6, re-run on the truth run, fixed or recorded as closed with the run id; fences lifted with the fix. | A |
| T6-g | The placement sweep excludes `double_elim` (`template-placement-sweep.test.ts:93-101`) | Key removed, count lowered, oracle extended (§5.3). | A |
| T6-h | The matrix's double-elimination loser-seat check uses the engine's generator as its oracle (`reference-bracket.ts:286`) | Routed through the reference's drop table (§6.4). | B |
| T6-i | No sequence model for the format | A fast-check model, specified below. | B |

**The T6-c sweep** (`double-elim-field-sweep.test.ts`, real usecases end to end, modelled on W4's
`knockout-late-entry-matrix.test.ts`):
- **Axes:** n = 2…32 (every size, odd fields included); the reset on and off; three result scripts (favourite wins,
  underdog wins, seeded random); **two draws** (every entrant seeded; top 4 seeded and the rest drawn at random with
  the stored draw seed); sports read from the registry through `forEachSport` (R26), with cricket and boardgame
  always in.
- **Checks per run:** who played whom in every LB match against the reference's drop table; LB rematches counted;
  dead and bye lines hold no slot; the full order of places against the oracle; exactly one champion.
- **What the rematch count is compared with** (OWNER 300; review 1):
  - RB6-X6 (no rematch before round E(frame)) on **every** run;
  - RB6-X7 (exactly one, the LB final) on the **fully seeded** draw with the favourite winning, and nowhere else;
  - on every other run the expected count is what the reference computes for that stored draw and those results.
- **Counts:** LB matches checked, pairs checked, entrants ranked, runs. The last `it` asserts the run count equals
  the product of the axes, so a `-t` slice goes red. Zero LB matches is a failure except at n=2, which is named.
- **Expected values** come from the rulebook and the reference, never from the engine or the stored rows (R9).
- It is one file with a derived time budget (`AGENTS.md` class 20). If the full product of axes is too slow for a
  scoped local run, the plan cuts sports per size, never sizes, cricket and boardgame never, and states the cut in
  the count.

**The T6-i sequence model** (TEST-STRATEGY rule 10; review 1). The format is ordered organiser actions, and
scripted sequences only cover the orders someone thought of. A fast-check model joins the matrix's existing model
layer (`tools/matrix/lib/model/`), for a `double_elim` cell:
- **Actions:** record a result, record a walkover, withdraw, reinstate, correct a result, take a result back,
  declare joint winners, undo it, change the reset setting, Rebuild, add a late player, complete the stage.
- **Invariants checked after every step:** seats agree with ranks (an entrant ranked out is seated nowhere later);
  each LB seat is fed at most once; a line with a draw-dead seat holds no slot; the stored reset row agrees with
  `resetOwed` of the stored GF1, and is seated exactly when it is owed; there is exactly one champion or a declared title once the stage is complete;
  ranks cover every entrant once.
- It reports the number of sequences and steps run; zero is a failure.
- A shrunk failure becomes a named regression in the scenario catalogue, with its seed, before its fix lands (R29).

**Four test types for every task** (`RULES.md`):

| Type | What it is here |
|---|---|
| Unit | the engine's pure functions (drop index, exit round, `resetOwed`); the app's `drawDeadSeats`, role key, loser-edge readings, late-entry decision |
| E2E | the row's Playwright walkthrough by CI dispatch; the reset control opens at "reset if needed" and locks once GF1 has a result |
| Smoke | create from the template → Generate → play to a title, reset earned and not earned |
| Regression | the flipped pinned tests (X-DE-1 seating, the Rebuild carry, joint winners), the named differential cases, MB-007/009/010 |

**Mutate each new guard once** (R17), one at a time, and paste the red. **Guards that could cover for each other
are mutated separately** (review 1):

| Guard | Mutation |
|---|---|
| the drop index | make every round regular |
| `resetOwed` (engine) | return false; then return true |
| `resetOwed`'s loser requirement | drop it (the GF1-bye case must go red) |
| the stored reset state (`settleReset`) | skip the write, with `resetOwed` intact |
| `settleReset`'s place after the fill | run it before the fill (a void reset with seats must go red) |
| `settleReset`'s place in the resolver's pass | call it from `onDecided` only (the WB-final double walkover and the withdrawn-finalist cases must go red) |
| the public champion's reading of the stored reset | put the seat-order test back (the walkover-over-an-out-champion title must go red) |
| the open count's stage-kind split | drop it (the league and Swiss No-result cases must go red) |
| the guard "a bracket holds no expunge abandon" | remove it |
| `settleReset` on the take-back path | skip it there |
| the open count's void reading | count every `abandoned` row as open again (the n=5 void line and the unneeded reset must both stop auto-advance) |
| the server usecase's `conditional` refusal | put it back (joint winners on an owed reset must go red through the usecase) |
| `fixtureAwaitsSeedDraw`'s draw-mark reading | drop it (the fed stage's draw row must stay red) |
| the void row in Rebuild's mapping | pass `bye: false` (8 → 5 must go red) |
| the completed-places guard's double-elimination branch | feed it a wrong order (two exit rounds swapped) and see it refuse; then delete one relation at a time |
| the reason test in the loser edge | treat `withdrew` as one loss; then treat `walkover` as out |
| the places grouping | fall back to seed order |
| `drawDeadSeats` | drop the winner-edge step (n=5 `LB 2.2` must go red); then drop the loser-edge base |
| the resolver's draw-versus-departure reading | read a draw label as a departure. The case that sees it: a draw-dead seat whose partner seat was stamped by `stampDepartedSeat` (a departed entrant named as the loser of the feeding line, X-WD-5); the line must be void, not a double walkover. A case built on a withdrawn feeder takes another branch and stays green under this mutant, so it is not the case |
| the dead-seat re-work on a reversed bye | skip it |
| the lane in the role key | drop it |
| the late entry's LB condition | drop it |
| the 0/1 refusal, engine | remove it, with the app's intact |
| the 0/1 refusal, app | remove it, with the engine's intact |
| the GF1-correction refusal (RB6-G9) | remove it |
| each owed-reset settle refusal | remove them one at a time |
| the setting's lock once GF1 has a result | remove it |
| joint winners: the seat requirement on a reset | remove it (an unseated reset must not be offered) |

A mutant that stays green means the test is decoration.

**Sequence cases** (R27; TEST-STRATEGY), scripted and named, beside the model:
- a second call: Generate twice, Rebuild twice, two late players, the setting flipped on → off → on, a second GF1
  correction, joint winners declared and undone twice;
- empty: 0 and 1 entrants, an LB round with no match at n=6, a power of two with no dead line;
- after a withdrawal or void: a finalist withdraws before GF1 and between GF1 and the reset; a forfeit is taken
  back; a reset is voided when not owed and when owed; a vacant GF1 and a joint GF1 with the reset on; a WB
  withdrawal and then Reinstate; a settled LB bye taken back by a late entry;
- the grand final's own list in §4.2, and the double-walkover list in §5.1;
- another sport: the sweep's registry axis, with cricket's held level result (`needs_decision`) reaching GF1.

### 6.7 Reusable mechanisms from W3–W5

**As is:**
- Rebuild in one transaction (ruling 253) and `carrySlots` with per-kind keys (`lib/rebuild-slots.ts`);
- `isByeLine` / `byeLineSql` and their shared shapes table;
- the knockout late-entry decision (`lib/knockout-late-entry.ts`), its admitter, the `knockout_late_entry` undo
  barrier and the four automatic-arrival doors;
- the one "started" predicate (X-LE-9);
- `open-entry-stages` and its drift test;
- the engine's tied `FinalPlace` shape, joint winners and the vacant title (W4);
- the third-place control's two mounts, as the pattern for the reset control;
- the `AWAITING_PROOF` list for rule rows recorded ahead of their code (engine `test/rules-reference.ts:55`).

**Adapt:**
- `bracketRoleKey` → a lane-aware key (§5.4);
- Generate's first-pass insert → the draw-dead label and the void line; `seatDeparted` → a draw label is not a
  departure (§5.3);
- `advancingSides` / `killsLoserEdge` → stage kind and reason (§4.4);
- the placement sweep's `engineBracket` → `generateDoubleElim`;
- W4's counted matrix test → the field sweep (§6.6).

**Not reused:** the engine's `lateEntryFixtures` (round-robin only), and W5's catch-up placement.

**Bench gates:** none lines up after W6 (brief, "Prerequisites").

## 7. Live divisions

- **There are none.** The prod census of 2026-11-23 (read-only, reported by the coordinating session) found 23
  stages in `seazn_club.stages`: knockout 12, swiss 9, league 2, and **zero `double_elim`**. So there is no stored
  `bracketReset` value and no started double elimination in prod.
- **Consequence.** No live-division compatibility and no data migration for existing brackets. The crossed drops,
  the shared places, the one-loss forfeit and the reset default apply from the release with nothing to carry.
- **Re-count at the prod deploy.** The template is offered on prod today, so a double elimination can be created
  between this census and the deploy. The same read-only count runs again then: `double_elim` stages, how many have
  a result, their stored `bracketReset` values, and any decided `award` with reason `walkover` or `retired` in one.
  The design holds for the first three without a migration (below). A decided forfeit in a started bracket would
  need the owner's call, because its loser was not seated under the old rule.
- **Staging data is test-only.** It is cleaned up, not made compatible. The clean-up in PR B lists staging's
  double-elimination stages (staging reads are a standing OK) and removes them or resets them.
- **How a bracket that already has a result behaves across the deploy** (on staging, and on prod if one appears):
  - **Its lines stay.** The drops it was drawn with are stored rows and edges, and nothing regenerates them
    (ruling 295; §4.3). It finishes on straight drops.
  - **Its reset setting stays.** A stored `true` stays a reset; a stored config with no value stays a single match
    (RB6-G2). The default is written only on create.
  - **Its places follow the current rule.** Ranks are computed from the rows on read, and there is no frozen
    "old rules" rank (X-FR-4, ruling 270). So a finished bracket shows shared places below 4th after the bump.
    Whether a stored placement snapshot also needs rewriting is the builder's check; with no prod rows, on staging
    it is cleaned up.
  - **A later forfeit follows the new rule.** A forfeit recorded after the deploy drops the absent side along the
    stored edge.
- **A bracket drawn before the deploy with no result** keeps its straight lines until it is rebuilt. Generate adds
  only missing rows and fills only null edges (`generate-tx.ts:803-807`). Rebuild draws the crossed order. That is
  ruling 295's "new or rebuilt".
- **The prod deploy itself is not scheduled by this design.**

## 8. Owner sign-off (the rulebook): S1–S6 SIGNED 2026-11-23, rulings 300–304; review-1 calls, ruling 305

Rulings 293–299 are the owner's (2026-11-23, "Ok go"). The rulebook's §15 put six items to the owner, and design
review 1 added calls that change a rule. **The owner approved all of them on 2026-11-23.** Nothing below awaits
sign-off.

| Item | Answer | Ruling | Designed in |
|---|---|---|---|
| S1 — which drop pattern (RB6-X1, X2) | Smoothcomp's NCAA-type table as a four-step cycle. "Exactly one rematch" is claimed only for a fully seeded field with the better seed winning | **300** | §4.3 |
| S2 — a double walkover in the winners' bracket (RB6-F7) | Both out; X-DW-2 kept | **301** (amends 294) | §4.4 |
| S3 — a retirement mid-match (RB6-F11) | One loss; the entrant drops. One who cannot continue is withdrawn by the organiser | **302** | §4.4 |
| S4 — where a withdrawn or disqualified entrant is placed (RB6-R7) | The LB round of the seat they vacate | **303** | §5.1 |
| S5 — late entry into a bye whose LB line has moved on (RB6-L4) | Case (1) closes once the entrant who advanced from that bye's LB line has started their next LB match | **304** | §5.2 |
| S6 — fields of 2 and 3 (RB6-E3, E4) | Both stay offered | **304** | §5.5 |
| S8 — how long the reset setting can change (RB6-G3) | Until the grand final has a result; a change adds or removes the unplayed reset row; then locked with a named reason | **305(a)** | §4.1 |
| Joint winners on an earned reset (RB6-C5) | Allowed | **305(b)** | §4.2 |
| S9 — where the dead-seat fix sits (RB6-B1 to B4) | Worked out fully at the draw, over both edges, and recognised by the existing bye-line authority with no second copy. Departs from the brief's wording; keeps ruling 299's one authority | **305(c)** | §5.3 |
| S7 — top places under a double walkover (RB6-R1, R2, R10) | 1st to 4th are unique when the matches that decide them are played; a double walkover's sides share the place and the next is skipped; completion never refuses for an empty 3rd or 4th | **305(d)** (amends 297) | §5.1 |
| The PR split | Everything that needs engine 11.0.0 is in app PR B | **305(e)** | §6.2, §6.3 |

**Two readings that go slightly past a ruling's words.** They stay designer's calls (§10, calls 25 and 26):
- Ruling 304 says "the entrant who advanced from that bye's LB line". The design closes case (1) on **any** LB line
  the reopened bye changes, because at n=5 the bye's own LB line is dead and the line that changes is `LB 2.2`.
- Ruling 305(d) speaks of a double walkover's "two sides sharing the place". By the same formula three entrants
  can share (the two sides and that round's other loser), and a winners'-bracket double walkover (ruling 301)
  shares in the round of the seat it vacates.

**Asked of the owner before PR A's first task:** sign RB6-B1 and B2 ahead of the batch, because PR A's
reference table is written from them (§6.4).

**REC rows still waiting for the batch sign-off** (the rulebook's own list): RB6-E1, E2, E5, E6; D1, D3, D5, D6; X3 to
X6, X8; B1, B2, B6; G2 (second sentence), G8, G9, G11; C2 (reset clause); R5; R8 (ruling 297 read beside ruling
267); P3; M4. This design builds on each as written.

**Citation still owed** (rulebook §15): sources A1, A3 and A4 were read as extracted text. Review 1 confirmed the
rule by an independent script, but nobody has opened A1 itself and checked the 32 and 64 lists against RB6-X2.

## 9. Gap status on 2026-11-23

**Read, not driven.** No row below was observed in the product in this session. Each "today" is the premise re-pin's
read or this doc's own, with its file:line in §4–§5. **A row marked "prove first" enters the backlog only after the
truth run reproduces it** (R5); one that does not hold goes to "False premises found (W6)".

| id | what | status today | piece | note |
|---|---|---|---|---|
| FX-G3 | an unneeded reset blocks completion; the champion can rank last | **closed by W4** for completion (read); stale audit evidence | PR A (catalogue only, T6-e) | false premise 1; the truth run confirms it by setting the reset over the API |
| void-reset | an earned reset can be voided and the stage completes | OPEN (read; engine and app) | Engine PR + PR B | OWNER 298; §4.2 |
| reset readers | three readers decide "owed" differently; the desk's "Final decided" row never shows for an unneeded reset; an unneeded reset stays a seated, scheduled match for every generic reader; a joint or vacant GF1 leaves it scheduled for ever; a GF1 bye would owe a reset against nobody; the public champion and Complete's guard each derive "owed" from GF1's seats; a GF1 the resolver settles would leave the reset awarded | OPEN (read); found by reviews 1, 2 and 3 | PR B (`settleReset`) | RB6-G6, G11; §4.2 |
| void lines and auto-advance | the open count reads a stored void line as open, so a double elimination that is not a power of two never auto-advances; the completion readers read the same row as settled. The fix reaches every format: a table stage then advances over an organiser's No result | LIKELY — prove first (n=5, auto-progress on) | PR A | review 2; §4.2 |
| reset after Generate | changing the setting after Generate cannot remove the reset row | OPEN (read: Generate only inserts); found by review 1 | PR B | OWNER 305(a); §4.1 |
| joint-GF | "Declare joint winners" is refused on a grand final and on every reset | OPEN by design (three refusals, one of them in the server usecase; a pinned refusal; C32 parked) | Engine PR (`resetOwed`) + PR B | OWNER 267, 305(b); RB6-C5; §4.2 |
| reset API-only | no screen or template sets the reset | OPEN (read) | PR B | OWNER 293; §4.1; R24 layouts first |
| FX-G4 | straight drops; LB rematches | OPEN (read; audit ran the generator) | Engine PR; PR B closes by the bump | OWNER 295; OWNER 300; §4.3 |
| FX-G24 | a forfeit loser is out | a **ruling overturned**, not a gap; pinned as correct today | Engine PR (rule, doc) + PR B (code) | OWNER 294; OWNER 301, S3; §4.4; stale audit evidence (T6-e) |
| ST-G33 | ranks tested at one size; no shared places; the guard would refuse three at one place | OPEN (read) | Engine PR + PR B (readers, I2, sweep) | OWNER 297, 303, 305(d); §5.1 |
| S3-late-entry | late entry answers the start lock | OPEN (read); no double-elimination branch exists | PR A | OWNER 296, 271; OWNER 304; §5.2 |
| carried 1 | a line with a draw-dead seat can be given a court, on the plain draw path and on the fed one | LIKELY — prove first (§5.3's set test at n=5 and n=9; the fed case at 5) | PR A | OWNER 299, 305(c); §5.3; narrower than the brief on the loser edge (false premise 4), wider on the winner edge (review 1) and on the fed path (review 2) |
| carried 2 | Rebuild carries by position | OPEN, pinned as a known defect | PR A | OWNER 299; §5.4 |
| small fields | 0 and 1 entrants: no named refusal read | UNVERIFIED — prove first | Engine PR + PR A | RB6-E1, E2; n=2 and n=3 stay (OWNER 304) |
| MB-007 | Generate after a roster change answers 500 | open in the catalogue, no wave; UNVERIFIED on main — prove first | PR A if reproduced | W4 fixed the knockout twin through the reconcile, which is knockout-only (read) |
| MB-009 | withdrawing an entrant who waits on a TBD opponent answers 422 | open in the catalogue, no wave; UNVERIFIED — prove first | PR A if reproduced | W4's X-WD-3 removed the knockout twin; predicted closed |
| MB-010 | Generate after a withdrawal answers 500 | open in the catalogue, no wave; UNVERIFIED — prove first | PR A if reproduced | as MB-007 |
| boardgame draw | a drawn boardgame game on this row | predicted to follow the knockout rule; not driven | truth run only; no build planned | OWNER 299; RB6-M3; a red here is a finding for the owner, not a W6 task |
| third place offered | "Third place" on a double-elimination stage | hidden in the builder and in stage settings (read) | truth run only | RB6-M4 |
| matrix oracle | the matrix checks a double elimination's loser seats against the engine's own generator | OPEN (read); R9 | PR B (the reference family and T6-h) | review 1; §6.4 |
| DENIED | no `formats.double_elim` | predicted ⛔ with guidance; not driven | truth run only; gate unchanged | OWNER 299; RB6-N1, N2 |
| stage loss on refusal | a refused format change deletes the stages | ⏳ W9 (ruling 35) | W9 | RB6-N3; a test title on main suggests it is closed (§10) |
| rule rows | three rows for the whole format | OPEN (read) | Engine PR | false premise 7; §12 |
| SH-G17 | the reset prints like any match | ⏳ W8 | W8 | hand-off note in §6.5 |
| T6-a … T6-i | matrix and test debt | — | PR A: T6-e, f, g; PR B: T6-a, b, c, d, h, i | §6.6; OWNER 305(e) |

- **25 rows.** By piece (a row can name two): Engine PR 7, PR A 10, PR B 10, truth run only 3, W8 1, W9 1.

**False or stale premises found while writing this doc** (go to `_INDEX.md` "False premises found (W6)" when the
plan starts; the eight already recorded there are not repeated):
- **Joint winners on a grand final are refused today, by a pinned test.** The rulebook's §14 says "not read for GF1
  or the reset" for Q4a. It is a build, not a check (§4.2).
- **The rulebook cites `placement-snapshots.test.ts:322` for "double-elimination ranks are tested with 2 entrants
  only".** That line is inside a knockout third-place case
  (`server/engine-db/__tests__/placement-snapshots.test.ts:318-326`). The double-elimination test it means was not
  found at that pin. ST-G33's claim is not re-pinned.
- **"Odd double-elimination fields appear only in the engine's `src/testkit/simulation.test.ts`"** was not
  confirmed: a grep of that file for "double" and "DoubleElim" found nothing. `generateDoubleElim` is used by
  `src/testkit/simulation.ts`.
- **The engine's `AWAITING_PROOF` list is at `test/rules-reference.ts:55`.** No `src/testkit/rules-reference.ts`
  was looked for.
- **The gate refuses nothing a live organisation can reach.** `format-gates.ts:40-41` says every plan has
  `formats.double_elim` since V393. The denied-state case is reachable only by turning the feature off for the test
  organisation, as `replace-stages-gates.test.ts:112-114` does with `denyFeature`.
- **An `award` already carries its reason** (engine `src/core/types.ts:136`), so ruling 294 needs no new outcome
  shape. The premise re-pin did not say either way.

## 10. Calls made by the designer (check these)

**Signed by the owner since the first draft** (2026-11-23; listed so nobody re-checks them as open):
- A. The drop pattern is the four-step cycle; RB6-X7 holds for fully seeded fields only (ruling 300).
- B. A double walkover in the winners' bracket puts both out (ruling 301, amending 294).
- C. A retirement is one loss (ruling 302).
- D. A withdrawn or disqualified entrant takes the place of the LB round of the seat they vacate (ruling 303).
- E. Late-entry case (1) closes once the LB has moved on past the bye; fields of 2 and 3 stay offered (ruling 304).
- F. The reset setting is editable until GF1 has a result, and a change adds or removes the reset row (305(a)).
- G. "Declare joint winners" is allowed on an earned reset (305(b)).
- H. Dead seats are worked out at the draw over both edges and recognised by the existing bye-line authority; this
  departs from the brief's wording and keeps ruling 299's one authority (305(c)).
- I. 1st to 4th are unique when their matches are played; a double walkover shares the place and skips the next;
  completion never refuses for an empty 3rd or 4th (305(d), amending 297).
- J. Everything that needs engine 11.0.0 is in app PR B (305(e)).

**The designer's, still to check:**
1. The engine release is a **major, 11.0.0** (§6.1).
2. **No version flag and no `drops` option.** A stored bracket is its stored rows and edges; nothing in production
   re-derives it from the generator (§4.3). This rests on a read of two call sites and one grep, not a run.
3. **The reset default is written on create, never applied on read.** A stage created over the API with no
   `bracketReset` key is stored with `true`; the schema description and the API changelog say so (§4.1).
4. **The reset setting and its default land in PR B**, with the void refusal, not in PR A (§4.1).
5. **`resetOwed`'s definition:** GF1 names a winner and a loser, is not joint, carries no `walkedOver`, and its
   winner is the entrant GF1's LB feed delivered. A GF1 settled as a bye owes nothing. The side is read from the feeds, not from which seat is home.
   `BracketFixture.conditional` is set from the `gf-reset` key in one place (§4.2).
6. **The app writes the reset's state once (`settleReset`) and every reader reads the stored row.** The two
   read-time derivations are deleted. This replaces the first draft's "three readers call one reading" (§4.2).
   The invariant is "a reset row is seated if and only if it is owed".
7. **Joint winners: the three refusals are removed, one clause in the shared predicate owns the rule, and no new
   input is added to it.** Under call 6 a reset is seated only when it is owed, and the predicate already requires
   both seats (§4.2).
8. **The award's reason decides the forfeit, in a double elimination only:** `walkover` and `retired` are one loss,
   `withdrew` and `disqualified` are out, and the legacy forfeit win is one loss. A knockout's third-place seat
   keeps X-DE-1's reading (§4.4).
9. **The forfeit code is app-side but lands in PR B**, tied to the amended rule rows, the reference family and the
   new ranks (§4.4).
10. **Ranks:** group by exit round; a walked-out entrant's exit round is read through the loser feed;
    `FinalPlace[]` keeps its type; `BRACKET_SHARED_RANKS` keeps its value for the other kinds (§5.1).
11. **The completed-places guard checks relations, not a list of rounds:** coverage, the title, and that rank
    follows exit round by competition ranking. This is how 305(d)'s "never refuses" is met (§5.1).
12. **No vacant 2nd in a double elimination.** The formula ranks whoever went out last 2nd. W4's B3-6 (a vacant
    2nd behind a walkover champion) stays a knockout rule (§5.1).
13. **Late entry reuses W4's app-side cases on WB round-1 lines.** No engine helper. It lands in PR A (§5.2).
14. **A late entry re-works the dead seats from the new draw and takes back settled LB byes** through the existing
    un-fill (§5.2).
15. **The dead-seat mechanism in detail** (the principle is ruled, 305(c); these parts are mine): the function
    reads the generator's output only; the mark is the bye slot label with a `from: "draw"` parameter; a two-dead
    line is written void in the insert; the resolver reads a draw label as not a departure; the marks are re-worked
    on every change of the draw (§5.3).
16. **The role key is app-side** in `lib/bracket-role.ts`, keyed by lane. The engine's `roundRole` is not extended
    (§5.4).
17. **Rebuild treats a void line as holding no slot**, by passing `bye: true` for it in the row mapping;
    `carrySlots` itself is not changed (§5.4).
18. **If MB-007 or MB-010 reproduce, double elimination joins the Generate reconcile with the same lane key**
    (§6.5). Otherwise nothing is built for them.
19. **0 and 1 entrants:** the engine throws a named `CONFIG_INVALID`, the app refuses first with its own copy, and
    `linesOfShape` answers 0 below 2 (§5.5).
20. **Only the reference's dead-seat table lands in PR A**, as an unregistered module citing no rule id. The rest
    of the family, its ids and the matrix cases land in PR B. The reference agent works at two named task
    boundaries. The matrix's double-elimination loser-seat check is routed through the reference (§6.4).
21. **Rule-row ids** continue the existing areas (`X-DE-`, `X-FR-`, `X-LE-`, `X-RB-`, `X-CH-`, `X-TP-`); no new
    prefix. X-FR-1, X-FR-2 and X-FR-3 are amended (§12).
22. **Rows are recorded in the engine PR; a row whose proof is an app PR B test goes on `AWAITING_PROOF`**, and a
    docs-only engine close-out after PR B fills `proved by`. This is a fourth, code-free step beside ruling 299's
    three PRs (§12).
23. **The matrix's template row is "reset if needed"; "single match" is the variant row.** No entrant-kind axis
    (§6.6).
24. **The field sweep's axes** (two draws, registry sports with cricket and boardgame always in), **its cut rule,
    and the fast-check sequence model's action list and invariants** (§6.6).
25. **Case (1) closes on any LB line the reopened bye changes**, not only the bye's own LB line. This is wider
    than ruling 304's words; at n=5 the narrower reading has no line to test (§5.2, §8).
26. **Three entrants can share a place** (a double walkover's two sides and the round's other loser), and a
    winners'-bracket double walkover shares in the round of the seat it vacates. Ruling 305(d) speaks of two
    sides; the formula is the same (§5.1, §8).
27. **Layout candidates A and B and the draft copy** for the reset control. These are for the R24 options page, not
    a decision (§4.1).
28. **Staging is cleaned up, not migrated.** The prod count is re-run at the deploy. A decided forfeit inside a
    started prod bracket, if one ever appears, is the owner's call (§7).
29. **A finished bracket's places follow the current rule after the bump** (X-FR-4), so an old staging bracket
    shows shared places (§7).
30. **No build is planned for the boardgame cell or the gate.** Both are observed on the truth run only (§5.5).

*New in the review-2 round (none changes a rule):*

31. **`settleReset` runs inside every seat-resolver pass, after `advanceSettledByes`, and after the release plan.**
    Not in `onDecided` alone (review 3: the resolver settles GF1 itself on two routes), and not as a status guard
    in `fillSlot`. Complete's guard calls it too, as the repair for a failed `onDecided` (§4.2).
32. **The open count reads `abandoned` through the engine's settle rule, for every stage kind**, as the completion
    readers do, with no SQL copy. It lands in PR A; the reset clause is deleted in PR B (§4.2).
    **This is a behaviour change visible outside double elimination:**
    - any bracket holding a void line (a knockout's dead third-place line, a draw-time void) auto-advances where
      today it waits for a manual Complete;
    - **a league, a group stage and a Swiss round auto-advance over an organiser's online No result**, where
      today they wait. The completion read already treats that No result as the settle.
    - A recorded abandon and a level abandon still hold. Review 3 found no writer for which auto-advance would
      fire wrongly.
    - Its tests are in other formats: a league and a Swiss No result, a knockout third-place void, and a
      recorded abandon that still holds (§4.2, PR A).
33. **The fed draw pass writes the draw marks, and `fixtureAwaitsSeedDraw` reads a draw mark as not owed.** One
    helper spells the mark for its two readers (§5.3).
34. **An unneeded reset is listed struck through and labelled "Not needed"** where void rows are listed. It is
    not hidden (§4.1).
35. **Once the reset has started, only a correction that changes GF1's winner is refused.** A same-winner score
    fix is allowed (§4.2; RB6-G9 reworded to match, still REC).
36. **An Undo of a setting flip checks the same lock; a same-value flip writes nothing** (§4.1).
37. **PR A's tests cite no W6 rule id in their titles; PR B adds them in the bump commit.** So every app-proved W6
    row waits on "W6 app PR B" (§6.2, §12).
38. **The late entry's LB re-work has two writers with separate jobs:** the release plan un-seats and reopens, the
    `drawDeadSeats` difference writes the marks last (§5.2).
39. **The public champion reads the stored reset by the invariant** (void and unseated = not owed), and
    Complete's guard loses its own derivation (§4.2).
40. **PR A's dead-seat table is drafted from RB6-B1 and B2 while they are REC**, and re-checked at sign-off (§6.4).

**Review 1 — how its findings were handled.** 18 Important and 15 Minor. All 33 are addressed in this round. None
was rejected as wrong. Four were fixed by a different route from the one the finding suggested first:

*Review 1 — not taken:*
- **"Give the joint-winners predicate an explicit `reset_owed` input"** (the joint-winners finding). Not taken.
  Both exclusions are lifted as the finding asks, but with the reset's state written on the row (call 6) "seated"
  already means "owed", and the predicate requires both seats. A second input would be a second statement of the
  same fact. The three states are pinned by named tests, and the seat requirement is in the mutation list.
- **"Or enumerate every reader by behaviour"** (the reset-readers finding). The finding offered two routes. The
  write was taken (call 6); the enumeration was not, because a list of readers goes stale. **The reason first
  given here was false** (review 3): it said a stored void line "is already 'not a match' to every one of them".
  Three readers proved otherwise: the open count read it as open, and the public champion and Complete's guard
  work "owed" out from GF1's seats. All are now in §4.2's table. The table is the readers found so far, not a
  proof that there are no more; the truth run still looks at the run sheet, Match Day, the pad and notifications,
  and at the public title in each not-owed shape.
- **"Either keep the engine returning empty and refuse in the app"** (the 0/1 finding). The other route was taken:
  the engine throws, and `linesOfShape` answers 0 below 2. An engine that returns a bracket with no grand final
  for one entrant is an empty result stated as a success (R13).
- **"Extend the stamp predicate…" and "key the early stamp on the draw"** (two dead-seat findings). Their aim is
  met, but not by amending the stamp: the stamp is withdrawn and replaced (§5.3).

**Review 2 — how its findings were handled.** The one review-1 finding fixed wrongly (joint winners), the 6 new
Important and the 11 new Minor are all addressed in this round: 18 of 18. None was rejected as wrong, and no rule
changed. Where a finding offered two routes, the one taken is:
- **The reset and the fill (N3):** `settleReset` runs after the fill. The `fillSlot` guard was not taken (call 31).
- **The fed path (N1):** the mark is written there and `fixtureAwaitsSeedDraw` learns it. "A fed double
  elimination cannot be built" was not claimed, because nothing read says so.
- **The reset's second writer (M8):** the revive is not routed through `settleReset`; `settleReset` runs last.
- **Rebuild (N6):** `bye: true` in the mapping, not a status on `CarryRow`.
- **M10's owner question** (three at 4= at n=8) is not answered here. It stays call 26 for the batch sign-off.

**Review 3 — how its findings were handled.** 2 Important and 7 Minor: 9 of 9 addressed, none rejected, no rule
changed. I-A and I-B are fixed in §4.2. M-B, M-C and M-G are fixed in §4.2 and call 32; M-D in the readers
table; M-E in §6.4 and §8; M-F in §5.3; M-H by the named repair in §4.2.

**Not verified in this session** (said plainly, so nobody builds on them as facts):
- Nothing was driven. No test, no server, no screen. Review 1 ran scripts that model the rule; it ran no product
  test either.
- The prod census was reported to this session; it was not run here.
- `components/v2/slideshow.tsx` and `server/doc-bracket-geometry.ts` were not opened. How `/present`, the slideshow
  and print draw a reset or a shared place is unknown. The run sheet, Match Day call, scorer pad and notification
  readers were not opened either.
- Which organiser actions can settle `gf-reset` without a result; what an organiser's award stores; what the
  award path writes when a live entrant reaches a draw-marked LB line; what the app answers for 0 or 1 entrants.
- **Review 2's reads that this session did not repeat.** They are used above as that review's word, without a
  line of their own: every other reader of the bye label key and what a draw mark does to it (the public hub,
  the player's matches, scorer sheets, the release plan's stamp check); that no reader compares a label by more
  than its key; that the create schema takes a progression on any kind; that a WB round-1 bye row stores its
  loser edge; the release plan's later branches and `reopenByeLine`.
- **Review 3's reads that this session did not repeat:** the engine's `settleOffered` and its two arms; the
  line of each writer of `abandoned` other than the resolver's void; `awardSeededByes`; the hub and live-page
  call sites of the public title; that no bracket writes an expunge abandon.
- Whether a fed double elimination can be built and confirmed today; whether a non-power-of-two double
  elimination auto-advances today (read: no); whether `is_final` is true on the `gf` and `gf-reset` rows, which
  the server's joint-winners pre-check needs; what the confirm-time bye award does with a draw-marked line whose
  live seat is still empty (expected: nothing).
- Whether any reader of bracket ranks assumes at most two holders of a rank.
- `server/usecases/__tests__/replace-stages-gates.test.ts:112` is titled "a formats.double_elim 402 leaves the
  original stages untouched". That suggests RB6-N3 is closed on main. Its body was not read past line 116, and it
  is W9's to confirm.
- The rulebook's E(n) numbers and the one-rematch count were reproduced by review 1's script. Its exhaustive
  search matched at 8 and 16 and was not repeated at 32, and the brackets-manager comparison row was not
  reproduced.
- Sources A1, A3 and A4 were not opened here.

## 11. Left to the builder

- Refusal codes, i18n keys and final copy for every new message (all 4 locales, `pnpm i18n:gen-keys`).
- The exact engine signatures: the drop-index function, `resetOwed`, the exit-round reading, the refusal reasons.
- Whether 11.0.0 raises a fold epoch (expected not), from the release's own report.
- The R24 options page for the reset control, the "if needed" tile on the bracket views, and any new desk notice;
  the owner picks before build. Screenshots at 1280, 768 and 320, no horizontal page scroll.
- The list of rank readers, by behaviour (§5.1), and whether a placement snapshot is stored for this format.
- The list of organiser actions that must refuse on an owed reset (§4.2).
- Where the default is written on create: the template, the builder and the API create path, and the one test that
  pins all three open at "reset if needed".
- The staging clean-up step, and the re-count query at the prod deploy (§7).
- The sweep's sports per size if the full product is too slow (§6.6), with the cut stated in its count.
- The truth run's write-up: each §9 row moved to observed, or to "False premises found (W6)".
- Task breakdown, batching and the walkthrough each batch owns, within the PR order of §3, in the plan
  (`superpowers:writing-plans`). Server tasks restate `MODULARIZATION.md`; UI tasks use the `frontend-design`
  skill.

**From review 1, details left open on purpose** (the finding is fixed in the design; these are its unread parts).
Review 2 closed four of them by read: the open-count clause, the label comparison, `carrySlots` and the bye row's
loser edge. What is left:
- *Reset readers:* one look, on the truth run, at how the Match Day call, the scorer pad and notifications treat a
  stored void reset (§4.2).
- *Dead seats, the award:* pin what the award path writes when the live entrant reaches a draw-marked line
  (expected: reason `bye`, no loser, no event) (§5.3).

**From review 2, details left to the builder** (each finding is fixed in the design; its id is review 2's):
- *N1:* drive a fed double elimination on the truth run before building; check what the confirm-time bye award
  does with a draw-marked line; name the helper that spells the draw mark.
- *N3 / I-A (review 3):* the take-back paths `settleReset` follows; and whether the joint-winners and
  vacant-title usecases already run the resolver, or need their own call.
- *I-B (review 3):* the hub's rail still showing a void reset round, and each champion consumer's own test.
- *M-C (review 3):* where the "no expunge in a bracket" assertion sits.
- *I3:* whether `is_final` is true on `gf` and `gf-reset`. If it is not, the server pre-check and the predicate
  both need the deciding match named another way, in one place.
- *M7:* read the release plan's later branches and `reopenByeLine` before wiring the LB re-work, so the two
  writers of §5.2 do not both write a label.
- *M8:* the walkover-over-an-out-finalist reversal, step 6 of the reset's sequence test.
- *M10:* the WB-final double walkover with the reset on: confirm the engine's title reading when GF1 is a bye.
- *M11:* the new awaiting-proof numbers, counted from the installed table at the bump (§12).
- *M12:* the "Not needed" label, its key in 4 locales, and where the division page's list takes its status label.
- *Rule rows:* check X-CH-5 and X-CH-8's wording ("the final", "whose final is decided") against "the deciding
  match" when X-CH-9 is written; amend them in the same commit if a reader could take "the final" to mean GF1 only
  (§12).
- *Sequence model:* the generator weights, so that a reset is reached often enough to be tested; state the number
  of sequences that reached GF1 (§6.6).

## 12. Every rule gets a rule row

Every signed W6 rule becomes a row in the engine repo's `rules/cross-sport.md`. The file's grammar applies: the
header is `| id | rule | citation | status | enforced at | proved by |`, the status is `signed N date` or
`deviation N date`, and the id appears in a test title. Double elimination has three rows today: X-DW-2 (`:14`),
X-DE-1 (`:30`) and X-DV-1 (`:56`).

**Ids** (designer's call): continue the existing areas. Today's highest are X-DE-1, X-FR-5, X-LE-14, X-RB-1,
X-CH-8 and X-TP-7. Every proposed id matches the checker's pattern and none contains `-KO-`. The builder re-checks
the next free number in each area before writing a row.

**When a row is recorded, and the close-out** (review 1 asked for this to be defined):
1. **The engine PR records every signed W6 row.** A row the engine's own tests prove carries its `proved by`.
   Every row an app test proves goes on `AWAITING_PROOF` (engine `test/rules-reference.ts:55`) naming
   "W6 app PR B". That includes the rows PR A's tests prove: those tests exist from PR A but gain the row's id in
   their title only at the bump (§6.2), so their proof is complete in PR B. A row whose code is PR B's says "not
   yet implemented" in its citation, as W4's rows did.
2. **Release 11.0.0 carries all of them**, so PR B's bump runs the app's rules checker against the full set.
   **That bump reds one app test by design** (review 2). The app pins the awaiting list for the installed
   engine: 37 rows, and the one PR name "W4 app PR A" (`scripts/__tests__/rules-reference.test.ts:206-213`). PR B
   changes both pins to the new values, counted from the installed table and stated in the test's own message.
   The pin is updated, never loosened to a range.
3. **The close-out is a docs-only engine PR after PR B merges.** It fills `proved by` for every row waiting on
   "W6 app PR B", PR A's tests included, and deletes their `AWAITING_PROOF` entries. It changes no code, so it needs no app bump; it ships with whatever engine
   release comes next. The engine's history has this shape already ("docs(rules): W5 app PR B rows proved").
4. So the order is: PR A → engine PR → release 11.0.0 → PR B → close-out. That is ruling 299's three PRs plus one
   code-free step.

A row is recorded only for a signed rule. The REC rows of §8 that are still waiting for the batch sign-off are
recorded when they are signed.

| Proposed id | Rule | Source | Proved in |
|---|---|---|---|
| X-DE-1 (**amended**) | A withdrawn or disqualified entrant is out of the whole stage and never drops; every later seat walks over. The words "walkover" and "retired" leave this row. | 294 (RB6-F4) | Engine PR |
| X-DE-2 | Structure: the frame is the smallest 2^k; the WB is a single elimination of k rounds; the LB has 2(k−1) rounds; an entrant is out at the second loss. | 294; REC (RB6-D1, D3, D4) | Engine PR |
| X-DE-3 | LB round 1 pairs adjacent WB round-1 losers in order. | 295, 300 (RB6-X1) | Engine PR |
| X-DE-4 | The loser of WB round r game i lands in LB round 2(r−1) by the four-step cycle. | 295, 300 (RB6-X2) | Engine PR |
| X-DE-5 | Survivor rounds pair neighbours; the LB final's winner meets the WB champion in GF1; the LB is not seeded. | REC (RB6-X3, X4, D5) | Engine PR |
| X-DE-6 | The pattern is defined on the frame. No pair can meet again in the LB before round E(frame), on any draw. On a fully seeded field with the better seed winning there is exactly one LB rematch, the LB final; this is not claimed for a partly seeded or random draw. GF1 and the reset are outside both properties. | 300; REC (RB6-X5 to X8) | Engine PR |
| X-DE-7 | A WB round-1 bye has no loser; the LB seat it feeds is dead from the draw. One dead seat: the other side advances by bye, with no win credited. Two: the line is void and the seat its winner feeds is dead too. A seat vacated during play is not this: it is a walkover, a credited win (X-WD rows, ruling 264). | 305(c); REC (RB6-B1 to B3, B5, E6) | PR A |
| X-DE-8 | A line with a dead seat holds no time and no court at any moment. | 299 (RB6-B4) | PR A |
| X-DE-9 | The reset setting: "reset if needed" by default on a new stage; a stored value is kept; no value means a single match; editable until GF1 has a result, a change adding or removing the unplayed reset. | 293, 305(a) (RB6-G1 to G3) | PR B |
| X-DE-10 | Reset if needed: the LB champion must win twice. Single match: GF1 decides. | 293 (RB6-G4, G5) | Engine PR |
| X-DE-11 | The reset is owed exactly when the setting is on, GF1 has a winner who is the LB champion, and GF1 has a loser, the WB champion, who is still in the stage. Otherwise it does not exist: not open, not called. A GF1 settled as a bye owes none. Before GF1 it reads "if needed". | 293, 298; REC (RB6-G6, G8, G11) | Engine PR (the predicate) + PR B |
| X-DE-12 | An earned reset cannot be voided; the stage completes only when it is decided, walked over or settled; a GF1 correction that changes its winner after the reset started is refused. | 298 (RB6-G7, G9, G10) | Engine PR + PR B (the app refusals) |
| X-DE-13 | A forfeit, a no-show or an organiser's award is one loss: in the WB the side drops; in the LB it is out and ranked at that round. | 294 (RB6-F1 to F3, R6) | PR B |
| X-DE-14 | A retirement mid-match is one loss. | 302 (RB6-F11) | PR B |
| X-DE-15 | A forfeit in GF1 by the WB champion earns the reset; by the LB champion it ends the stage; a forfeit in the reset is the second loss. | 293, 294, 298 (RB6-F9, F10) | PR B |
| X-DE-16 | Fewer than 2 entrants is refused by name; 2 and 3 are offered, with their own shapes. | 304; REC (RB6-E1 to E5) | Engine PR |
| X-DW-2 (**kept**) | Its double-elimination clause stands: neither side of a WB double walkover drops. An LB double walkover puts both out. | 84, 301 (RB6-F5, F7) | no text change; a test title gains the id on the LB case (PR B) |
| X-DW-3 (text unchanged) | A double walkover on GF1 or the reset is refused and the match stays open. | 84 (RB6-F8) | PR B: the reset case gets its test |
| X-FR-1 (**amended**) | The list of declared shared places gains "a double elimination's places by exit round (X-FR-7, X-FR-9)". | 297, 305(d) (RB6-R1) | Engine PR |
| X-FR-2 (**amended**) | "Below the semi-finals a bracket's ranks stay strict" names knockout, stepladder and page playoff; it no longer covers double elimination. | 273, 297 | Engine PR |
| X-FR-3 (**amended**) | From "a walkover loser is eliminated at that fixture for ranking" to "an entrant a walkover put **out of the stage** is eliminated at that fixture for ranking, so ranks and seats agree". Clause: in a double elimination a forfeit or retirement loser is not out there; they are ranked by their second loss. | 274, 294, 302 (RB6-R6) | Engine PR |
| X-FR-6 | Double elimination: when the matches that decide them are played, 1st to 4th are single: the deciding match's winner and loser, the LB final's loser, the loser of the LB round before it. The reset changes only 1st and 2nd. | 297, 305(d) (RB6-R2, R4) | Engine PR |
| X-FR-7 | Entrants out in the same LB round share the place 1 + (entrants out later); a round with one loser gives a single place. | 297 (RB6-R3, R5) | Engine PR |
| X-FR-8 | A withdrawn or disqualified entrant takes the place of the LB round of the seat they vacate; a finalist out at the deciding match is its loser. | 303 (RB6-R7) | Engine PR |
| X-FR-9 | A double walkover that leaves a top place unplayed: the entrants out in that round share by X-FR-7 and the next place is skipped. Completion is never refused for a place with no holder. | 305(d) (RB6-R10) | Engine PR |
| X-CH-9 | One finalist out before GF1: a walkover, and no reset whichever side is out. Between GF1 and an earned reset: the reset is a walkover. Both out: vacant title (X-CH-3). In a double elimination X-CH-5 and X-CH-8 read "the final" as the deciding match. | 267, 298 (RB6-C2 to C4, C6, C7) | Engine PR + PR B |
| X-CH-10 | "Declare joint winners" is offered on the deciding match: GF1 (then no reset exists; undone, it is "if needed" again) or an earned reset (then it is settled). | 267, 305(b) (RB6-C5) | PR B |
| X-LE-15 | A late entrant into a started double elimination joins WB round 1 only, where the stage is the entry stage, by cases (1), (2), (3) of X-LE-3, X-LE-5, X-LE-6; never the LB. X-LE-10 covers automatic arrivals here too. | 296, 271 (RB6-L1 to L3, L5 to L8) | PR A |
| X-LE-16 | Case (1) is open only while no entrant who advanced by bye through an LB line the reopened bye changes has started their next LB match; those byes are taken back. | 304 (RB6-L4) | PR A |
| X-LE-17 | A late entry that reopens a bye makes the LB seat it feeds live again. | REC (RB6-B6) | PR A |
| X-RB-2 | A double elimination's Rebuild keeps each slot with its role: lane, rounds before that lane's final, game number; GF1 and the reset keep their own. A role that is new starts unscheduled; one that is gone frees its slot; a bye or dead line holds none. | 299 (RB6-P1 to P3) | PR A |
| X-TP-8 | The third-place setting is not offered on a double-elimination stage. | REC (RB6-M4) | PR A (a test on the two mounts) |

"Proved in: PR A" above names where the proving test is written. Its row still waits on "W6 app PR B", where
the test's title gains the id (step 1).

No new row is owed for the match layer (RB6-M1 to M3: W2's rows and X-DV-1 already hold), for the gate (RB6-N1,
N2: unchanged) or for RB6-N3 (W9's).

X-LE-1's text names "a root knockout, ko_plate's main bracket, or qualifying_main's qualifying bracket"
(`rules/cross-sport.md:102`). X-LE-15 extends it rather than editing a signed row; if the reviewer prefers one
list, X-LE-1 is amended in the same commit.
