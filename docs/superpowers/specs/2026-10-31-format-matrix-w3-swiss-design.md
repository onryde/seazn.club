# W3 — Swiss: design

- **Date:** 2026-10-31 · **Programme:** format matrix (`2026-09-27-format-matrix-prompts/_INDEX.md`), wave W3
- **Rows:** `swiss`, `swiss_playoff`, `swiss_knockout` × 11 sports
- **Inputs:** wave brief `W3-swiss.md`; draft rulebook `rulebook-W3-swiss.md` (unsigned, written 2026-09-27); audit
  `audit-2026-09-27/SW-swiss.md`; two read-only re-verifications run 2026-10-31 against app `origin/main` 920d7a9a22
  and engine `main` c612f51 (§9).
- **Status:** DRAFT for owner approval. Decisions marked **OWNER** were made by the owner in session on 2026-10-31
  (rulings 250–252).
  Decisions marked **(my call)** are the designer's and are listed in §10 for checking. Everything marked **REC**
  is a rulebook recommendation that still needs the owner's signature (§8).

---

## 1. Intent

Badminton Swiss works today. The owner's words: "scoring with Badminton in Swiss worked well". All 9 live Swiss
divisions are badminton. No customer has hit the audited gaps.

W3 exists for two reasons:

1. **The one pain organisers do feel.** A player turns up after a round has been paired and its schedule
   published. Adding them today means a three-step Withdraw/Unpair/Pair dance. The new boards have no time or court.
   And the obvious button, Rebuild, wipes every time and court in the stage (#840).
2. **Swiss must be trustworthy before chess, board games and larger fields use it.** Several traps fire
   mid-event and report success:
   - pairing dead-ends silently (SW-H1);
   - Undo leaves players seated (SW-M2);
   - an ad-hoc match hands everyone else a phantom bye (#846);
   - chess colours never alternate (SW-H3);
   - non-chess Swiss has no Buchholz (SW-H4).

**Success:**
- An organiser can add a late player at any point with one action, and nobody already on court is disturbed.
- No Swiss action ever reports success while doing nothing or something wrong.
- Every sport's Swiss table breaks ties on strength of schedule (Buchholz) before head-to-head.
- Every rule W3 relies on is a signed row in the engine's rules files.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1 **Late entry after pairing, three cases** (OWNER, §4).
- G2 **Byes and missed rounds score per the owner's decisions** (OWNER, §5), in every sport.
- G3 **Rebuild never wipes times and courts**, and deletes and regenerates in one transaction (#840, FX-G13). Build it
  format-agnostic, because W5 consumes it for league rows and #879 part 3.
- G4 **Close every OPEN or PARTIAL gap in §9** (31 distinct; 1 already fixed), each to ruling 19's bar: zero ❌ on the
  Swiss rows and nothing previously ✅/⛔ turned red.
- G5 **Rule rows:** every W3 behaviour gets a signed row in the engine repo's `rules/cross-sport.md` (and
  `rules/<sport>.md` where a sport-specific consequence exists). Each also gets a numbered owner ruling in the
  format-matrix `_INDEX.md` (OWNER: "make sure that rules are noted in engine rules").

**Non-goals**
- A full FIDE (Dutch) pairing engine. The simplified score-group backtracking stays (REC RB3-1). The engine asserts
  legality (no rematch, bye eligibility, every active entrant seated once), not FIDE's quality criteria C5–C21.
- Half-point or zero-point **late-entry** credit, and any setting to choose it (OWNER: skipped as rare).
- Requested half- or zero-point byes (REC RB3-7(c): defer, ⛔ with guidance).
- The Grand Swiss bench gate, unless its pack has landed by W3's gates (brief §6: deferred ⏳, not blocking).
- Scorer-sheet content beyond "never print a bye shell" (W8 owns sheets, SH-G16/G18).
- Prod. Owner, 2026-10-31: "we are not going to prod for now". W3 ships to main and stg, and its merges do not wait
  on any prod tag.

**Anti-goals: things that would make W3 a failure even if every test is green**
- A late-entry action that moves any player who is already on court, or re-times a slot nobody asked to move.
- Re-pairing a published round in which **any** board has started (the OWNER's case (a) guard is "nothing in the
  round has started", not "no result yet").
- Live divisions' standings silently shifting when the bye-points rule changes (§7).
- A property or sweep that passes on zero items, the trap that let SW-H1 ship (brief trap 1; TEST-STRATEGY
  anti-vacuity).
- An Undo test that counts shells instead of asserting the seats cleared (brief trap 2).

## 3. Constraints

- **Two repos since 2026-10-31.**
  - Swiss pairing (`scheduling/swiss.ts`), tie-breaks (`competition/tiebreakers.ts`, `table-rules.ts`), points
    (`competition/points.ts`) and the sport presets live in **onryde/seazn.club.engine**, published as
    `@onryde/seazn-engine`.
  - The pairing orchestration (`apps/web/src/server/usecases/stages.ts` `swissGen`), Rebuild, Unpair, the late-entry
    refusal and every screen live in **seazn.club**.
  - Order: engine PR (code + tests + rule rows + a real changeset + `Matrix rows: …` in the body) → engine release
    (`engine-release` skill: manual `release/<V>` PR) → seazn.club bump PR.
  - A FOLD_EPOCH raise in the release's epoch report means app migration steps are owed first.
- **The ruling ledger stays in seazn.club** (`2026-09-27-format-matrix-prompts/_INDEX.md`). The next free number was
  250 on 2026-10-31; re-check origin/main before claiming one, because parallel sessions add rulings.
- **Nine live divisions.** A change to pairing or bye scoring reaches events mid-round (§7).
- **House test rules** (`docs/superpowers/TEST-STRATEGY.md`, `_RULES.md`):
  - all four test types per task;
  - anti-vacuity counts on every property;
  - expected values derived from the rulebook, never from `swissGen`'s constants (brief trap 4);
  - mutate every new guard once;
  - test the sequence: a second late player, late entry after a withdrawal, after an Undo, and in another sport.
- **UI bar:** mobile-first, verified at 1280, 320 and 768 with no horizontal scroll; every new string in all 4 locales.
- **E2E runs by CI dispatch only** (`--ref <branch>`), never locally.

## 4. Late entry after pairing (OWNER, 2026-10-31)

One action, **"Add late player"**, on a Swiss stage at any point after Start. It replaces today's refusal
(`entrants.ts:360-371`) and the Withdraw/Unpair/Pair sequence. The same rule applies in every sport.

The newcomer is registered. Then the **current round** is handled by the first case that applies. The current round is
the latest seated round that still has an undecided board. If every seated round is decided, which is the usual
between-rounds arrival, there is no current round: the newcomer simply joins the next Pair, and no finished round is
reopened (my call).

| Case | Condition | What happens |
|---|---|---|
| **(a) Re-pair** | No board in the current round has started (no score event, not live, not decided other than the bye) | The round is re-paired with the newcomer included. **Every slot keeps its time and court**; only the names on the boards change. An odd field moves the bye; an even field adds one board in the next free slot (unscheduled if there is none, flagged to the desk). Players whose opponent changed see "pairing updated". |
| **(b) Take the bye** | Some board has started, and the round has a pairing-allocated bye | The newcomer plays the bye holder on a new board. Nothing else moves. The bye holder's award is reversed and their bye eligibility restored (P-A4). This is legal only if the two have not met. If they have (impossible in round 1, rare later), fall through to (c). |
| **(c) Next round** | Otherwise | The current round is untouched. The newcomer is seated from the next round. |

**Scoring for the newcomer:** 0 points for each round missed, with no score recorded. Missed rounds are zero-point
unplayed rounds for tie-breaks (FIDE C.07 art. 16.2.3, evaluated as 0 for opponents). No half-point option.

**Deviation from FIDE.** Case (a) changes a published pairing, which FIDE C.04.2 4.4 forbids. The owner accepted
this knowingly on 2026-10-31. It needs a *deviation* rule row stating the guard. Case (b) changes no existing
pairing, so it is not a deviation.

**Doubles:** a late *pair* is the late entrant. A partner arriving late is a lineup matter, not an entry (my call).

**Automatic arrivals** (OWNER, ruling 250): an entrant created after Start without the organiser covers a payment
confirmation (`registrations.ts` `materialise`), a waitlist promotion and a CSV import. These never re-pair a round:
they always take case (c), and the desk shows "N late players join next round". Today `swissGen`'s implicit-bye loop
(`stages.ts` ~1401-1427) credits such an entrant +1 for each missed round; W3 fixes that to 0.

**No round left** (OWNER, ruling 250): if the last Swiss round has started, the refusal offers "Add a round" (RB3-5).
If the Swiss is finished or its knockout has started, the refusal says "This Swiss is over".

**Before Start** nothing changes. The existing pre-Start reshape stays, but it inherits G3: surplus boards no longer
take their pinned time and court with them (SW-L8).

## 5. Byes and missed rounds (OWNER, 2026-10-31)

- **Pairing-allocated bye = win points, no score recorded**, in every sport: no set, game, point, goal or run
  for/against, and no effect on any ratio. Basis: FIDE C.04.1 r.3. BWF has no Swiss rule.
  - Where the points rule pays by score (a `bySetScore`-style rule), "win points" means the clean-sweep win's points.
    This is the reading already signed in X-WO-1 ("a bye keeps the clean-sweep pair") (my call: it reconciles the
    signed wording with the decision).
  - Today a bye under a custom rule with a forfeit row is paid that row (engine `points.ts:376-394`). W3 changes it
    to win points (SW-M6 remainder).
- **Buchholz on a bye:** FIDE C.07 2026 art. 16. The bye-holder's own card uses a dummy at their own final score,
  capped. Opponents see the bye-holder's actual score (REC RB3-6). It replaces today's pre-2023 virtual opponent
  (SW-M1, SW-L1, SW-L2). It is scaled to the stage's table points, not half-points, because non-chess Swiss can
  already add Buchholz through the W2d editor (premise note SW-H4).
- **Walkover is unchanged:** X-WO-1 and, for badminton, BD-WO-1 (2–0, each game 21–0). A walkover is not a bye.
- **`byeScore`** (boardgame, declared, deliberately unread) is **removed** as a configurable value. "Win points,
  every sport" leaves nothing for it to choose (my call; it supersedes REC RB3-7(b)). An existing stored key is
  ignored, not rejected. Whether the removal is a schema MAJOR is the engine builder's to establish from the epoch
  report.
- **The bye's value is frozen at award** (SW-M7): the bye seat writes its `config_snapshot` like any fixture.
- **A bye never takes a court slot or prints a sheet** (SW-M13, REC RB3-23).
- **One number** (REC RB3-9): pairing score groups use the stage's table points, not `swissGen`'s hard-coded
  1 / 0.5 / 1 (SW-M11).

## 6. Where everything else lands

### 6.1 Engine PR (seazn.club.engine)

| Item | Gaps | Rule |
|---|---|---|
| `pairRound` returns a **named refusal** (`SWISS_NO_LEGAL_PAIRING` or similar) instead of an empty pairing; never an empty success | SW-H1 (engine half) | REC RB3-4 |
| Bye choice retried when matching fails with the first candidate; floater window not limited to the bottom of the group | SW-L3, SW-L4 | REC RB3-1 |
| Soft home/away alternation for non-chess | SW-L5 | REC RB3-11 |
| Every pairing property counts boards and byes; zero is a failure; a "fully paired" invariant per round | SW-L9 | R25 |
| Swiss default tie-break chains per sport family, Buchholz early and head-to-head late, for all 11 sports (football, carrom and generic currently ignore the stage kind) | SW-H4 | REC RB3-8 |
| FIDE C.07 2026 art. 16 for unplayed rounds: bye, forfeit win or loss, double walkover, withdrawal, late-entry missed rounds | SW-M1, SW-L1, SW-L2 | REC RB3-6 + OWNER §4/§5 |
| Bye pays win points (clean-sweep under a score-keyed rule), never the forfeit row | SW-M6 | OWNER §5 |
| `byeScore` removed | SW-M8 / SC-O7 | §5 (my call) |
| Rule rows in `rules/cross-sport.md` (+ sport files), each id in a test title | — | G5 |

### 6.2 App: work that needs no engine change (can run before the release)

| Item | Gaps | Rule |
|---|---|---|
| Rebuild keeps times and courts; delete and regenerate in ONE transaction; format-agnostic | SW-M12 / #840, FX-G13, SW-L8 | G3 |
| "Add late player" (§4) | SW-L7 | OWNER |
| Undo of Pair next clears the seats when no board has a result; otherwise a named refusal | SW-M2 / #835 | REC RB3-22 |
| Ad-hoc matches on a Swiss stage: no phantom byes, no broken shells, never cleared by Unpair | SW-M3 / #846, SW-M4, SW-M5 | REC RB3-15 (§8 Q1) |
| Bye: snapshot at award, never on a court, never printed | SW-M7, SW-M13 | §5, REC RB3-23 |
| Round count: guidance from the field size (`lib/swiss-rounds.ts` gets its production caller), warn above the safe maximum, refuse above the hard maximum | SW-H2 | REC RB3-3 |
| Round count editable per stage until the first fixture **starts**; then only "Finish now" or "Add a round" | SW-M10, #838 / O7 | REC RB3-5 |
| "Finish the Swiss now", offered by SW-H1's refusal ("Finish after N−1") | SW-H1 (app half), RB3-20 | REC RB3-4, RB3-20 |
| Chess colours on by default for boardgame Swiss; round-1 colour by lot | SW-H3 | REC RB3-10 |
| Seeded random draw for an unseeded round 1 (not registration order) | SW-L6 | REC RB3-16 |
| Two seated sides who did not play (double walkover) may meet again; a walkover winner stays bye-ineligible | (RB3-2; `stages.ts:1376`) | REC RB3-2 |
| Manual board swap in rounds 2+: blocked, with guidance | SW-L12 | REC RB3-25 |
| Disqualification cascades like a withdrawal from that moment | (RB3-17) | REC RB3-17 |
| Public "Round X of N" state | SW-L11 | brief |

### 6.3 App: after the engine release (bump PR)

| Item | Gaps |
|---|---|
| Engine bump; SW-H1's refusal surfaced on the desk with its recovery | SW-H1 |
| Score groups from table points (needs the engine's bye-points change to agree) | SW-M11 |
| Slideshow and public table show the Swiss tie-break columns (Buchholz) | ST-G21 |
| Full e2e: odd field, bye, a tie broken on Buchholz, a late player in each of cases (a)/(b)/(c), into the KO cut | SW-L10 |
| Retire owner ruling 70's override and re-baseline L3 **in the same change** as SW-H1 (brief "Output and handoff": the `ruling70` block in `tools/matrix/catalogue/baseline.json`, `RULING_70_IDS`, the backlog carry, `pnpm matrix:backlog`) | SW-H1 |

### 6.4 Reference family (`packages/reference`, seazn.club)

A Swiss checker for **legality and existence**, written by a different agent from the engine fixer. It is not a second
pairing engine. Bounds: blossom matching for n ≤ 128, brute force for n ≤ 12 (REC RB3-24).

## 7. Live divisions

Nine badminton Swiss divisions are live. The builder must establish, against stg and with one read-only prod query
(the stg read is a standing OK; the prod read was approved 2026-10-31 under "all per rec"), whether any existing bye was paid a custom forfeit row that
differs from win points.
- **If none:** state that in the PR body.
- **If any:** the owner's data-change rule applies (10-28): a LOUD note plus a pre-deploy migration, never a compat
  shim.

Rounds already paired keep their pairings. W3 changes how the *next* Pair works, not past rounds.

**Undo:** "Add late player" is not undoable. Undo answers with a named refusal that points to Withdraw (my call).

**Live tie-break orders are safe:** a stage pins its tie-break order when it goes active (`table-rules.ts`
`pinStageTableRules`, X-TB-2), so the new Swiss default chains do not reorder the nine live divisions. The builder
check verified this on 2026-10-31.

## 8. Owner sign-off (the rulebook): SIGNED 2026-10-31, ruling 252

Owner: "all per rec". Q1–Q5 below were answered as recommended. Before, none of the rulebook's 25 recommendations was signed. The owner decided RB3-7(a) and RB3-13 (amended) on 2026-10-31,
and this design supersedes RB3-7(b). The rest are recommendations this design builds on. They are signed as one batch,
except these questions, which change what gets built:

- **Q1 — Ad-hoc match on a Swiss stage (#846).** Either (A) refuse "Add match" on a Swiss stage, with guidance, or (B)
  allow it and fix the phantom byes and shell breakage (SW-M3/M4/M5). REC: **A**. Ad-hoc matches have no place in a
  pairing system, and A removes three gaps at once. It must be confirmed that no live Swiss division holds an ad-hoc
  fixture.
- **Q2 — Rounds editable until the first fixture starts** (RB3-5 / #838). REC: yes, per stage, then Finish/Add a round
  only.
- **Q3 — Unplayed pairs may meet again** (RB3-2, FIDE C.04.2 3.5): two players whose board was a double walkover can be
  paired later. REC: yes.
- **Q4 — Chess colours on by default for boardgame Swiss** (RB3-10). REC: yes.
- **Q5 — Requested half/zero-point byes** (RB3-7(c)). REC: defer (⛔ with guidance).

Once signed, each recommendation becomes a numbered ruling (from 250, re-checked). Its rule row lands in the engine
PR or the app PR that implements it, never ahead of the code.

## 9. Gap status on 2026-10-31

Read, not driven: two scouts opened every cited file. Full tables, with file:line for both repos:
`.superpowers/handoff/2026-10-31-w3/gaps.md` and `recs.md` (copied from the session scratchpad). Every `stages.ts`
line in the 09-27 audit has drifted; re-pin from those files, not the audit.

- **31 distinct gaps:** OPEN 25, PARTIAL 5 (SW-H4, SW-M6, SW-M7, SW-L10, ST-G21), FIXED 1 (SW-M9, the double walkover,
  by W2b/W2c).
- **By repo:** APP 18, ENGINE 9, BOTH 4 (SW-H1, SW-M2, SW-M8, SW-M9).
- **Engine `scheduling/swiss.ts` is unchanged since the audit** (one commit, the import).
- **False or stale premises found:**
  - SW-L10: a full Swiss into a KO cut was already driven in `formats.spec.ts:234-371` before the audit, but with 4
    entrants, no bye and no ties;
  - SW-H4: Buchholz is now addable by the editor, which exposes SW-L2;
  - RB3-14: the double walkover is no longer missing.

These go to `_INDEX.md` "False premises found".

## 10. Calls made by the designer (check these)

1. A bye under a score-keyed points rule pays the clean-sweep win's points (§5).
2. `byeScore` is removed; a stored key is ignored (§5).
3. A late *pair* in doubles is the late entrant; a late partner is a lineup matter (§4).
4. Case (b) falls through to (c) if the newcomer and the bye holder have met (§4).
5. Case (a) with an even resulting field: the extra board takes the next free slot, else is left unscheduled and
   flagged (§4).
6. "Current round" = the latest seated round with an undecided board. A late arrival between rounds joins the next
   Pair and never reopens a finished round or its bye (§4).
8. "Add late player" has no Undo. Undo returns a named refusal ("withdraw the player instead"). Restoring a re-paired
   round's original pairings is out of scope (§4).
7. The app work in §6.2 runs before the engine release; only §6.3 waits for it (§6).

9. Cases (a) and (b) are tried before the "no round left" refusal. The refusal applies only when case (c) would be
   needed and there is no next round.
10. An *automatic* arrival with no round left is not refused, because that would fail a payment. It is recorded as an
    entrant with no games and flagged on the desk.
11. Only an organiser's "Add late player" makes Undo refuse. An automatic arrival does not change Undo.
12. Freezing the bye's `config_snapshot` (SW-M7) must exempt system byes from the "played" readers
    (`fixture-results-sql.ts:64` `fixtureEvidenceSql`, `format-standing.ts:23` `playedSql`). Otherwise an odd-field Pair
    locks the stage rules and blocks Unpair, Rebuild and Undo (found by the app-A planner).

## 11. Left to the builder

- Refusal codes, i18n keys and copy for every new message (all 4 locales).
- How case (a)'s "pairing updated" notice reaches players (desk notice at minimum; any push channel the app already has).
- The engine API shape for the refusal and for art. 16 unplayed categories.
- Whether removing `byeScore` raises FOLD_EPOCH or FOLD_MINOR (the epoch report decides; migration first if so).
- Task breakdown, batching and PR count within the order in §3, in the plan (`superpowers:writing-plans`).

## 12. Every rule gets a rule row (OWNER, 2026-10-31: "make sure that all rules are written in the rule book")

Every signed W3 rule becomes a row in the engine repo's `rules/cross-sport.md` (and a sport file where a sport-specific
consequence exists). The README grammar applies: id, rule, citation, `signed N date` / `deviation N date`, code and
tests, and the id appears in a test title. Use the `X-SW-` prefix for cross-sport Swiss rows. Never put `-KO-` in an id:
`packages/reference` bracket-finish reds on any KO row that is not signed and cited.

A row lands with the code that makes it true, never ahead of it:

- **Engine PR:** rows whose code is in the engine.
- **Rules close-out PR** (engine repo, `pnpm changeset --empty`, after the app PRs merge): rows whose code is in the app.
  They cite the app's real code and test paths. This is W3's last task. W3 is not done until every line below has a row.

| Rule | Source | Lands in |
|---|---|---|
| Bye = win points (clean sweep under a score-keyed rule), no score, every sport | 251, RB3-7(a) | Engine PR |
| Late entrant: 0 per missed round, no score; missed rounds are zero-point unplayed rounds for tie-breaks | 251, RB3-6 | Engine PR |
| Late entry cases (a)/(b)/(c); (a) is a *deviation* from FIDE C.04.2 4.4 | 250 | Close-out |
| Automatic arrivals after Start always take case (c) | 250 | Close-out |
| No round left: "Add a round" while running, "This Swiss is over" after | 250 | Close-out |
| `byeScore` removed; a bye is not a setting | 251, design §5 | Engine PR |
| Pairing legality: no rematch, bye at most once, every active entrant seated once; simplified backtracking, not full Dutch | RB3-1 | Engine PR |
| No legal pairing → named refusal, never an empty success | RB3-4 | Engine PR (app surfacing cited at close-out) |
| Unplayed pairs (double walkover) may meet again; a walkover winner stays bye-ineligible | RB3-2, RB3-14 | Close-out |
| Round count guidance, warn above the safe max, refuse above the hard max | RB3-3 | Close-out |
| Rounds per stage, editable until the first fixture starts; then Finish / Add a round | RB3-5 (#838) | Close-out |
| FIDE C.07 2026 art. 16 for unplayed rounds | RB3-6 | Engine PR |
| Requested ½ / 0 byes deferred (⛔ with guidance) | RB3-7(c) | Close-out |
| Swiss default tie-break chain per sport family | RB3-8 | Engine PR (+ sport files) |
| Pairing score groups use table points | RB3-9 | Close-out (after app bump PR) |
| Chess colours on by default for boardgame Swiss; round-1 colour by lot | RB3-10 | Close-out (+ `rules/boardgame.md`) |
| Non-chess soft home/away alternation | RB3-11 | Engine PR |
| Rank-adjacent from round 2 in swiss_playoff / swiss_knockout (*deviation*) | RB3-12 | Close-out |
| Ad-hoc "Add match" refused on a Swiss stage | RB3-15 | Close-out |
| Seeded random draw for an unseeded round 1 | RB3-16 | Close-out |
| Disqualification = withdrawal from that moment; annulment separate | RB3-17 | Close-out |
| Cut-line ties: flag-and-pick / visible lots, no play-off game | RB3-18 | Close-out |
| A correction after the bracket started: bracket stands, desk warns | RB3-19 | Close-out |
| "Finish the Swiss now" | RB3-20 | Close-out |
| A correction after the next round is paired: the published pairing stands, standings recompute | RB3-21 | Close-out |
| Undo of Pair next clears seats if no result, else a named refusal; Add late player has no Undo | RB3-22, design §10.8 | Close-out |
| A bye shell is never on a court and never printed | RB3-23 | Close-out |
| Manual board swap in rounds ≥ 2 blocked with guidance | RB3-25 | Close-out |
| Rebuild keeps times and courts, in one transaction | design G3 (#840) | Close-out |

RB3-24 (the reference's n bounds) is a test-harness bound, not a product rule. It is recorded here and in the reference
family's own test, with no rule row.

The ledger side is already written: rulings 250–252 are in `_INDEX.md`, and the signed rulebook `rulebook-W3-swiss.md`
is amended to match rulings 250/251 (its §4 late-entry row, its §7 bye-value row, R2, RB3-7, RB3-13).
