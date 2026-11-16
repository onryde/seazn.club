# `_INDEX.md` additions for W5 (paste-ready)

These two edits were applied to the `_INDEX.md` in the Downloads snapshot on 2026-11-06. The real repo's `_INDEX.md`
needs the same two edits. Re-check `origin/main` first: the numbers assume 275 is the last ruling.

**Revised 2026-11-16 against engine 9.0.0 (2cd842a) and app 97b184e2d9.** Re-checked: `git show
origin/main:docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` still ends at ruling **275** (line 2158),
so 276–285 below are not yet on main and **286–290** (owner, 2026-11-16) follow. Recording all of them, with the
status row, is the docs push that comes **before** the engine plan's B0 (a docs-only push to main per the house rule;
"B0" itself is the engine rows PR, engine plan Task 0). Re-check once more at commit time. Section 3
below holds the designer's recommendations of 2026-11-16: they go under "Recommendations (mine — not rulings)", never
in the rulings list.

## 1. Status table — replace the W5 row

```
| W5 | Round-robin family | **in progress** — design APPROVED 2026-11-06 (`docs/superpowers/specs/2026-11-05-format-matrix-w5-round-robin-design.md`; rulebook `rulebook-W5-round-robin.md` fully signed), rulings 276–290 (Q1–Q9 on 2026-11-05, builder check and S1–S7 on 2026-11-06, unequal pools always on and the REC answers on 2026-11-16); seven rows / 77 cells (`group_group_ko` joins by the §8 clause, NEW-W1d-5; `triple_rr` is deleted, ruling 287, so its row leaves the matrix); design and plans revised 2026-11-16 against engine 9.0.0 / app 97b184e2d9 (design §13, fix rounds 1 and 2; W5 engine release = the next engine major at release time, 10.0.0 today; next migration V525); REC-1..REC-12 answered by rulings 287–290 (REC-3's box-league champion stays an open question, out of W5); engine rule rows owed at B0 (engine plan T0), released rows-only as 9.1.0 and taken into the app by a standalone "W5 rows bump" PR merged before app PR A; plans `docs/superpowers/plans/2026-11-06-w5-round-robin-engine.md`, `…-app-a.md`, `…-app-b.md`; W4 merged (#1152, #1167), so R1 is met |
```

## 2. Owner rulings — append after ruling 275, before "## Recommendations (mine — not rulings)"

```
276. **Late entry into a started league or group entry stage adds catch-up fixtures** (2026-11-05, owner accepted the
     recommendation, Q1; W5 design §4.1). The newcomer plays everyone: a fixture against a future round's bye holder
     lands in that round; every other owed fixture is appended as a catch-up round, one fixture each. Finished rounds
     never change and round numbers are never rewritten; no missed round is scored as a loss; the played count levels
     out by the end. Offered until the stage completes (S6). Groups: a pool picker on the add form, default the
     smallest pool. Automatic arrivals (payment, waitlist, import, a Reinstate with no lines) are never auto-placed:
     desk flag, one organiser tap (271 reused). The cases are tried in order: complete → refuse; nothing started (K4)
     → Rebuild offered with catch-up as the alternative; otherwise catch-up (designer's call 24, signed by 285). Built
     on W4's reconcile seam with the (unordered pair, leg, pool) identity; closes #879. Rulebook RB5-L1–L17.
277. **Withdrawal from a table: the 50 percent rule with a total expunge** (2026-11-05, owner "keep 50% and
     explogue?" [sic] after two clarifications, Q2; W5 design §4.2). For an entrant who leaves the whole stage
     (withdrawn or disqualified, 259). The row stays, marked, ranked last, on every surface. Under half of their
     scheduled matches played: every result they played is removed, finalized ones included (ST-G15), and the rest
     are voided. Half or more: results stand and the rest are walkovers at the sport's declared score. Deviations
     recorded: BWF and ITTF always expunge; the FA Standard Code expunges below 75 percent. Reinstate restores the
     entrant's existing lines. RB5-W1–W9.
278. **A departed qualifier leaves the cut; the next eligible entrant backfills** (2026-11-05, owner accepted the
     recommendation, Q3; W5 design §4.3). The Swiss rule (W3 T15) for league and group sources: seeding and
     on-complete exclude withdrawn and disqualified entrants, the public page stops naming them, best-Nth is
     recomputed without them. W4's RB4-V6 is the destination half; one driving test per row proves both. RB5-K1–K7.
279. **No pool under two; pool membership is every seated entrant** (2026-11-05, owner accepted the recommendation,
     Q4; W5 design §5.1). Generate refuses a pool count that leaves a pool with fewer than two, with a named reason
     naming a count that works, and the builder's estimate agrees. A pool table lists every seated member from day
     one with zero played (ST-G5). The `group_group_ko` F1 cells (7 entrants, 4 pools) become ⛔. The floor stays 2
     (S7). RB5-E4, P1, P2.
280. **Best-Nth across unequal pools drops results against the bottom entrants** (2026-11-05, owner accepted the
     recommendation, Q5; W5 design §5.2). UEFA qualifying convention: k per candidate = the candidate's pool's
     effective size minus the smallest effective size among the pools that supply a candidate, after 277's
     expunges; then W2d's per-sport cross-pool cascade (183) on the reduced set; the basis is shown on the table
     and the progression panel. Repairs the inert `normaliseUnequalPools` seam (ST-G3). RB5-U1–U7.
281. **Groups → knockout: no same-pool match in round one** (2026-11-05, owner accepted the recommendation, Q6; W5
     design §5.3). Rank then pool rotation on the fold; rank ties drawn with the destination stage's stored seed
     (RB4-D4); the engine swaps within a rank tier, deterministic, and refuses with a named reason only when no
     ordering of the tiers separates every round-one pair. Round two onward follows the fold. The reference checks
     legality and existence (design §7.2). Closes FX-G5. Club separation stays DEFERRED (272). RB5-D1–D11.
282. **A pair that loses a partner withdraws as the entrant** (2026-11-05, owner accepted the recommendation, Q7; W5
     design §4.4). Under 277; the remaining player may re-enter in a new pair under 276 with a fresh record; a
     substitute partner (R12a) is refused and routed ⏳ to the lineup work; a duplicate entrant (R11a/b) is refused
     at add (designer's call). RB5-R1–R3.
283. **A finished table keeps its cut line, frozen** (2026-11-05, owner accepted the recommendation, Q8; W5 design
     §6.1). At completion the live Through / Needs help computation stops and the markers freeze as "Qualified" /
     "Out" on every surface (ST-G17; amends the 2026-09-22 qualification spec §3.3). The markers read who actually
     went through (the confirmed proposal or `config.qualified`, else the final cut) and update on read after a
     settled tie, a correction or a backfill (designer's call 30, signed by 285). Applies to every table stage with
     a cut, Swiss included, and to the live tournament's finished Swiss table (S3). RB5-T1–T4, T14.
284. **"Adjust points" on every table stage** (2026-11-05, owner "1 for all format?", accepting the recommendation
     widened to every table stage, Q9; W5 design §6.2). League, group and Swiss; plus or minus N with a required
     reason; an undoable ledger row read by the fold as an opening delta (never stage config); it adjusts the sport's
     `points` metric and refuses where a table has none; a footnote on every surface; hidden on brackets; Swiss pairs
     on the adjusted score (S2). Closes C5 (🚫 → built). RB5-T5–T9, T15.
285. **The W5 design doc is APPROVED and every rule is signed** (2026-11-06, owner: "approve and record all rules").
     - S1–S7 were signed one at a time the same day, each per the recommendation: S1 `group_only` joins the format
       picker and `group_group_ko` stays a gallery template, the "T20 Super 8" shape generalized to any sport, so no
       cell is dropped; S2 Swiss pairs on the adjusted score; S3 frozen markers reach the live finished Swiss table;
       S4 the boardgame cells on the four groups-plus-bracket rows and generic `group_playoffs` work (W3-final L3;
       SC-O1 closed by W2a), re-confirmed by W5's truth run; S5 a departure or correction inside a completed table
       source stales the proposal, draft and confirmed (RB3-19 by analogy); S6 late entry runs until the stage
       completes; S7 the pool floor stays 2.
     - The builder check (2026-11-06) raised eight questions and six contradictions; all settled as designer's calls
       24–31 (design §10), none needed the owner.
     - Every rulebook row that was REC (the designer's calls) now reads OWNER 285; design §10's calls are signed with
       it. Club separation in pools stays DEFERRED (272).
     - Rule rows: per 274's pattern they are recorded in the engine's rules files ahead of the code, each marked not
       yet implemented and naming its PR. The engine checkout is not in the tree this was written in, so that
       recording is the first task of the engine plan.
     - Still owed, not covered by the signature: article numbers for A1–A6; the R24 layouts (pool picker, catch-up
       label, "Joined round N", "Adjust points", the frozen markers); bench packs (`tools/bench/packs/` holds none
       for the six W5 gates); reading #850; the first W5 recon on current main (every pin is the audit's).
     - Written in a snapshot tree; re-check `origin/main` before merging this ledger.
     - Prerequisite: W4 merged (R1). Next: `superpowers:writing-plans` for engine PR, app PR A, app PR B.
286. **Best-Nth across unequal pools: the normalisation is always on** (2026-11-16, owner "apply your rec unequal
     pool", accepting the designer's recommendation after the 2026-11-16 recon; W5 design §5.2). Ruling 280's rule
     (drop results against the bottom k entrants, k = the candidate's pool's effective size minus the smallest) applies
     to every best-Nth comparison across unequal pools, never behind a per-stage flag. `normaliseUnequalPools` stays in
     the schemas so stored configs parse; it is accepted and ignored, and deprecated. The engine's
     `SEEDING_BESTNTH_UNEQUAL_POOLS` refusal goes for this case. Equal pools drop nothing. Closes the "builder's
     choice" left open in design §5.2 and ST-G3's inert seam. Engine release: the next major at release time, 10.0.0 today (a behaviour change for stored
     progressions). Rulebook RB5-U8 (U6, U7 amended).
287. **`triple_rr` is deleted** (2026-11-16, owner: "in prod, no triple_rr, so blindly cleanup, delete it";
     supersedes REC-1). Rulebook RB5-G6 (re-signed); engine row X-RR-6.
     - Scope, as the coordinator reads 287 (designer's call, 2026-11-16 — NOT the owner's words; put to the owner if
       any part is doubted): the template row and its detection branch (a lone league with `legs` ≥ 3 then reads back
       as `league` with its leg count), the picker and builder references, the matrix row and its RETIRED_ROW_ROUTES /
       noOrganiserPathCell entry, its i18n keys, help copy and the tests pinning it go; a door that accepts the key
       refuses it by name (none does today: the gallery's `createFromTemplate` answers 404 `unknown template`). The
       engine's `legs` input stays generic. `legs` 1–8 is not part of 287: it is RB5-G1 as signed under ruling 285, so
       a `legs: 3` league stays a league.
     - `triple_rr` is detected, never stored (app `lib/format-templates.ts:404`), so there is no migration, no staging
       cleanup and no prod read. An earlier coordinator gloss ("API create refuses legs:3") is withdrawn.
288. **The W5 recommendations are confirmed as recommended** (2026-11-16, owner, Q2–Q6 and Q9–Q13): REC-2 (listed
     seed order for a best-Nth basis tie only — re-worded by ruling 291; 281's stored seed decides inside the cross-pool draw), REC-3 (box league
     champion out of W5; the question stays open), REC-4 (self-withdrawal after Start through the table withdrawal),
     REC-5 (#837 in app PR A), REC-6 (rank override on a non-table stage refused by name), REC-9 (ST-G4/12/13 re-routed
     to W2d), REC-10 (quick-match regression check), REC-11 (RB5-T15's "no points metric" clause dropped; amends 284's
     "refuses where a table has none"), REC-12 (two pools, winners plus the best runner-up into a 4-draw or a
     3-stepladder stays refused), and the rows-only engine 9.1.0 release before app PR A (fix round 1, F1). The
     implementation calls are approved too ("you can use existing or new table if you maintain and manage"): the
     builder may use `stages.config.round_byes`, `table_waiting_stage_id` or another store, provided the plan names who
     writes, reads and cleans each field (rebuild, withdrawal, undo and delete paths) and tests the cleanup.
289. **An in-match disqualification withdraws the entrant from the stage, with a clear instruction first** (2026-11-16,
     owner Q7, REC-7 with a condition: "clear instruction when DQ"). A DQ recorded on the pad or by the organiser runs
     ruling 277's withdrawal. Before confirming, the Disqualify action shows plain copy naming the consequence: which
     remaining fixtures are withdrawn, whether played results stand or are expunged under the 50 percent rule (with this
     entrant's actual count), and whether it can be undone. All 4 locales. A test asserts the copy's numbers come from
     the same decision the cascade applies. Engine X-RT-1 is re-worded; rulebook RB5-W11; engine row X-WDT-10.
290. **Badminton and tennis follow ruling 277** (2026-11-16, owner Q8, REC-8 option A). Badminton BD-WO-2 and BD-RT-1
     drop "until W5" and are re-worded as a permanent recorded deviation from BWF GCR 16.2.5 (its delete-all is not
     applied). Tennis follows 277 as well, with no tennis row unless a rule differs (none does). No sport-specific
     withdrawal code. The app's W2b text pin for the two badminton rows moves with the 9.1.0 rows release. Rulebook
     RB5-W12.
291. **A best-Nth basis tie across pools is broken by the sport's own declared cross-group cascade** (2026-11-16, owner,
     answer "A" to the N1 question): a `seed` step gives seed order; `lots` gives the engine's stored lots draw; a
     cascade with neither gives seed then id. No engine change. **291 supersedes ruling 288's "listed seed order"
     wording for REC-2** (288's other confirmations stand). Rulebook RB5-G9 (re-worded); engine row X-PD-8; app PR A
     Task 11c.
```

## 3. Recommendations — append under "Recommendations (mine — not rulings)" (2026-11-16)

These are the designer's recommendations from the 2026-11-16 recon (design §10). They were not rulings when written;
the owner answered all of them the same day: REC-1 is superseded by ruling 287, REC-2..REC-6 and REC-9..REC-12 are
confirmed by 288, REC-7 by 289 (with a condition), REC-8 by 290. Keep them here as the record of what was proposed.

```
- REC-1 (W5, 2026-11-16) triple_rr stays retired from the builder; a stored legs:3 league keeps playing (API-only).
  Drop TR-1's builder fix and its app task; the late-entry sweep is 75 cells (90 once group_only joins). Answers the W5 row's "keep it API-only or
  retire it from the catalogue" with "API-only".
- REC-2 (W5; narrowed in fix round 1, 2026-11-16) The listed (seed) order applies only where ruling 281 does not
  decide: a seeding tie that survives the cascade into a best-Nth basis comparison is settled by the listed (seed)
  order, then stored lots. Inside the cross-pool draw, ruling 281's stored draw seed decides rank ties (RB5-D3), so
  REC-2 never overrides it. A rule row (RB5-G9, engine X-PD-8 ⬜) and a counted test over the 21 cases.
  [Ruling 291, after 288: "listed (seed) order" is superseded — the sport's own declared cross-group cascade breaks the
  tie (seed step → seed order; lots → the stored lots draw; neither → seed then id).]
  [Fix round 2: now app PR A, ruling 288; no "21" count — a constructed enumeration over every best-Nth row proves it,
  and the harness notes are re-judged by row (design §9).]
- REC-3 (W5) A box league crowning one champion over parallel boxes is OUT of W5 — see the open question below.
- REC-4 (W5) Ruling 111's self-withdrawal after Start routes through the table-withdrawal usecase (phase check +
  cascade), in app PR A (RB5-W10).
- REC-5 (W5) #837 (league half-fill after a pre-Start delete) in app PR A, owned by the reconcile task; move the pin
  in swiss-delete-entrant.test.ts that freezes the bug.
- REC-6 (W5) P7: refuse a rank override on a non-table stage by name; fix the public has_rank_overrides (RB5-P7).
- REC-7 (W5) In-match DQ cascade: re-word X-RT-1 in B0; app PR A applies ruling 277's withdrawal to the DQ'd entrant's
  remaining fixtures (RB5-W11).
- REC-8 (W5) Re-word badminton BD-WO-2 / BD-RT-1 under 277 in B0; a tennis deviation row if tennis keeps RB2A-3
  (RB5-W12).
- REC-9 (W5) Re-route ST-G4/12/13 from W5 to W2d in gap-routing.json and audit-verdicts.json, in app PR A.
- REC-10 (W5) Quick match league_ko (#1216): app PR A carries a regression check that W5's changes leave it as it was.
- REC-11 (W5, fix round 1) Drop RB5-T15's second clause ("a table with no points metric refuses the action"): every
  table folds `points` (engine `StandingsRow.points`), so the clause has nothing to act on. Ruling 284's text says
  "refuses where a table has none"; until confirmed, the clause is recorded as a finding and no code or test enforces it.
- REC-12 (W5, fix round 1) Two pools, the winners plus the best runner-up into a 4-draw or a 3-stepladder (A1, B1, B2):
  keep it refused (tier 1 is fixed under RB5-D10, so B1 v B2 is forced). The alternative is to let pool winners swap
  positions for this case.
```

Designer's calls of 2026-11-16 (process and consistency; listed in design §10, not rulings, not RECs): one canonical
rule-id table (engine plan T0); catch-up ties
on the earliest round break by listed (seed) order; a waiting late arrival is not refused by the engine's seating, only
a result naming an unseated entrant is; app PR A's calls (byes in `stages.config.round_byes`; a second waiting column
`table_waiting_stage_id`; the in-match DQ cascade fires automatically from the pad, best-effort; the self-withdraw
cascade runs as `systemAuth()` and the ledger names the player as the actor); the engine plan's calls (the catch-up home
side; an adjustment counts toward `countedFixtures` like a carried opening; `matchesCounted` = the largest `played`
among the candidates). (The rows-only engine 9.1.0 release before app PR A was proposed here and is now confirmed by
ruling 288.)

Designer's calls of 2026-11-16, fix round 2 (design §10): ruling 287's scope list as above; `triple_rr` needs no
migration; the W5 rows bump is a standalone app PR merged before app PR A, and W5's code release is the next engine
major at release time; pool `results` reach the engine in app PR B's bump commit, so there is no 9.x window; the
cross-pool draw's "tied" means equal on the cross-pool comparison (never the within-pool `tieUnbroken`), rows with
different match counts are never level, and only adjacent seeds link; harness seeding-tie notes on rows without best-Nth
are confirm-time table ties under the existing ladder.

## 4. Open owner question (W5, 2026-11-16) — append under the open questions

```
- Box league champion (REC-3): a `group_only` stage with parallel boxes — does the public page crown one champion
  over all boxes, one per box, or none? W4's championIds (public-site/standings-view.ts) does not address group_only.
  Recommended: out of W5; decide before any box-league marketing. Not built until answered.
```

Note for §2 (the ruling texts stay historical): ruling 276's "Built on W4's reconcile seam" is superseded by the
2026-11-16 recon — W5 builds its own round-robin pair-key planner (design §6.6, §13 #7). Ruling 284's "refuses where a
table has none" is dropped by ruling 288 (REC-11). Ruling 281's stored-seed tie rule governs the cross-pool draw (fix round 1, F3). The
late-entry sweep is 75 cells (five templates × 3 kinds × 5 cases; `triple_rr` deleted, ruling 287), and 90 once
`group_only` joins (app PR A) — `triple_rr` was never one of the counted templates, so deleting it moves neither number.
