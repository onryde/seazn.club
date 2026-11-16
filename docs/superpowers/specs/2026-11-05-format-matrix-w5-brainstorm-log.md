# Format matrix W5 (round-robin family) — brainstorm log

The record of how `2026-11-05-format-matrix-w5-round-robin-design.md` came to say what it says: the questions asked, the answers given in the owner's own words, the options shown and set aside, each recommendation and why it was made, the builder check's questions and how each was settled. The design and rulebook carry only decisions and current truth; this file carries the path. One conversation, 2026-11-05 to 2026-11-06. Local file only, no git.

## Files

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-11-05-format-matrix-w5-round-robin-design.md` | The W5 design, twelve sections in the W3/W4 form. Approved 2026-11-06, ruling 285. |
| `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W5-round-robin.md` | The W5 rulebook, RB5 rows. Fully signed 2026-11-06. |
| `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX-w5-additions.md` | The two `_INDEX.md` edits (the W5 status row; rulings 276–285), paste-ready for the real repo. They were applied to the Downloads snapshot's `_INDEX.md` on 2026-11-06. |
| `docs/superpowers/plans/2026-11-06-w5-round-robin-engine.md` | The engine PR plan, 15 tasks (B0 rows PR to B8 open the PR). |
| `docs/superpowers/plans/2026-11-06-w5-round-robin-app-a.md` | App PR A, no engine change, 27 tasks. |
| `docs/superpowers/plans/2026-11-06-w5-round-robin-app-b.md` | App PR B, after the engine release, 10 tasks. |
| `docs/superpowers/specs/2026-11-05-format-matrix-w5-brainstorm-log.md` | This file. |

## 2026-11-05: the opening

Owner: "do we have format matrix w4 design already?" Found: yes, `2026-11-04-format-matrix-w4-knockout-design.md`, approved under ruling 274, with the engine and app plans approved 2026-11-05 and not yet started.

Owner: "Let's Do W5 Brainstorming?" then, mid-turn: "no remote repo, no commit". Read as: the Downloads tree is a snapshot of the real repo on another machine; everything stays as files on disk.

## 2026-11-05: the method first

Owner: "I am looking more how W3 and W4 findout the gaps, rules, working pattern and adding value to customr."

Surveyed W3's and W4's designs, rulebooks, plans and the program index. Reported back the pattern: gaps from five sources (the routed audit ids, the latest truth run's backlog, a read-only recon on pinned commits with a verdict per finding, the owner's prod census and anomaly drill-down, carries and memory notes); rules from a draft rulebook beside the brief, then only the questions that change what gets built become Q1 to Qn with options and a recommendation, each answer a numbered ruling, then a builder check, then one batch signature at approval; the lifecycle brief → recon → brainstorm → design → builder check → sign-off → three plans → subagent-driven execution; customer value framed by the census and separated into "pain live organizers feel" versus "trust before anyone runs it".

Where W5 stood against that: the brief, the routed ids and the W3-final truth run existed; the census, a recon on current main and the draft rulebook did not. The brief said seven rows; the index routes the two-tier groups row to W5 too, so eight rows and 88 cells.

## 2026-11-05: the frame

Asked: "What does prod hold today for league and group divisions, with the ones you ran yourself counted separately?"

Owner: "we are yet in prod except one tournment, so I want to make sure that our product in all edge cases including rules, format work and handle edge cases".

Read as: not in production except one tournament; W5 is about trust before anyone runs a league or groups standalone, the same frame W4 used. Later, on the live event: "swiss + knockout, tournment finished", so no history re-rank is owed.

Owner: "Ask questions with rec". Nine questions were listed with options and a recommendation each. Owner: "ask one by one". From here each question was a dialog with the recommended option first.

## Q1 — late entry into a started league or groups

Options: catch-up fixtures; missed rounds scored as losses; refuse after the first result. Recommendation: catch-up, because a round robin's promise is that everyone plays everyone, the pair-once-per-leg invariant stays exact, and W4's reconcile seam already carries the identity needed; it also closes #879.

Owner: "so what will happen if 2 rounds finished and then when late join, will create the fixture in round 1?"

Answer: no. Finished rounds are never touched and round numbers never rewritten. A fixture against a future round's bye holder lands in that round; every other owed fixture is appended as a catch-up round at the end, one match each; in an even field every fixture is appended. The question was restated with that baked in. Owner: "Catch-up fixtures (Recommended)". Ruling 276.

## Q2 — withdrawal from a table

Options: keep the 50 percent rule with a total expunge; the same with an organizer-settable threshold; a per-sport federation rule. Recommendation: keep 50 percent with a total expunge, because one rule gives one case set across 88 cells and the half-expunge bug (signed-off results surviving) is the real defect.

Owner: "example ? for 1". Shown: a six-team league, F withdraws after round 2, with a table of what happens to A (lost to F) and B (beat F, signed off) under the rule versus today's bug.

Owner: "I remember that if withdrawn, we mark in the standing table and we will not remove ?" Clarified: the row is kept and marked in every option; the question is only about the results. A fourth option, "never remove results, walkover the rest", was added.

Owner: "are you talking about leaving middle of the gme or entire season?" Clarified: leaving the whole stage. A mid-match retirement and a single no-show are W2's rules and stay as they are.

Owner, interrupting the dialog: "why re removing the result of opponent?" Answered: fairness between the teams still playing. If results stand, a team that lost a real match to the quitter is worse off than one that never played them and gets a free walkover; removing every result puts everyone back on the same footing, which is why federations remove results for an early quitter. The cost, a team losing a win it earned, was stated plainly. Both rules were offered as defensible.

Owner: "show me an example". Shown: the same league as a points-per-team table under both rules, plus the half-or-more case where the two rules coincide.

Owner: "keep 50% and explogue?" Read as the ruling: keep the 50 percent rule with a total expunge. Ruling 277. Correction recorded later in chat and in the rulebook: the FA Standard Code's line is 75 percent, not 50; the product keeps 50 as a product rule and the FA figure is a deviation row.

## Q3 — the cut after a withdrawal

Options: adopt the Swiss rule (the departed leave the cut, the next eligible backfills); the departed keeps the seat. Recommendation: the Swiss rule, because W4 already built the destination half and nobody should qualify into an empty seat. Owner: "Adopt the Swiss rule (Recommended)". Ruling 278.

## Q4 — a pool of one

Options: refuse at generate under two per pool; allow a pool of one; silently reduce the pool count. Recommendation: refuse, plus the membership fix in every case (a pool table lists every seated member from day one), because reducing silently is an anti-goal and a pool of one crowns a winner who never played. Owner: "Refuse at generate, under two per pool (Recommended)". Ruling 279.

## Q5 — best runners-up across unequal pools

Owner first: "is it possible to run uneven pool?" Answered: yes, whenever the entrant count does not divide by the pool count (9 in 2 pools is 5 and 4); nothing refuses it, and the template's normalize flag never receives the data it needs.

Options: drop results against the bottom team (UEFA qualifying convention); per-match averages; refuse best-Nth on unequal pools. Recommendation: drop results against the bottom team, because it is deterministic, has a federation precedent, runs through the cross-pool cascade W2d built, and the basis can be shown on the table. Owner: "Drop results against the bottom team (Recommended)". Ruling 280.

## Q6 — the groups-to-knockout draw

Owner first: "for knock, is it ok to met from the same pool based on ranking ??" Answered: meeting later is fine and normal; the convention is round one only, where a group winner should face a runner-up from a different group because the group already decided those two.

Options: cross the pools in round one (one general rule); fixed bracket tables per pool count; keep today's fold. Recommendation: one general rule, because it covers every pool count the builder offers and reuses W4's stored draw seed for ties. Owner: "Cross the pools in round one (Recommended)". Ruling 281.

## Q7 — a pair that loses a partner

Options: the pair is the entrant and withdraws; a substitute partner with results standing. Recommendation: the pair withdraws, because it matches BWF practice, keeps one entrant rule across every format, and leaves substitution to the deferred lineup work. Owner: "The pair is the entrant: it withdraws (Recommended)". Ruling 282.

## Q8 — a finished table

Options: freeze the cut line and markers at completion; keep today, where they vanish. Recommendation: freeze, because the finished group table is where spectators look for who went through and W4's "the same on every surface" principle applies. Owner: "Freeze the cut line at completion (Recommended)". Ruling 283.

## Q9 — points deduction

Options: build "Adjust points" on the desk; refuse it for W5. Recommendation: build, because football and hockey leagues rely on it, the engine already carries opening deltas, and it is small.

Owner: "1 for all format?" Answered: it applies to every stage with a points table, so league, group and Swiss with one action; hidden on brackets; Swiss pairing on the adjusted score marked as a designer's call. Confirmed: "Build it, every table stage (Recommended)". Ruling 284.

In the same dialog: the live event is "swiss + knockout, tournment finished", and the write-up was approved: "Yes, write it (Recommended)".

## 2026-11-05/06: the design and rulebook

Written in the twelve-section W4 form with the rulebook rows as REC, then sent to a fresh builder-check reader (the brainstorming skill's prompt, Read-only).

## 2026-11-06: the builder check

Eight questions and six contradictions came back. None needed the owner; each was settled as a designer's call (design §10, calls 24 to 31) with the reason:

- W4's reconcile driver is not built yet, so the seam's third part (a structural-change predicate) was recorded now as W5's requirement on it, rather than discovered later.
- Before Start a group stage re-snakes every pool on Generate, because seeding into pools by snake is the product rule; the pool picker exists only after Start.
- The round-one rotation swaps within rank tiers, deterministic, and refuses only when no ordering separates every pair; the reference checks legality and existence, as W3's Swiss oracle does.
- "Adjust points" moves the sport's points metric (a match's worth where points are matches won) and is a ledger row, not stage config, so Undo is the ledger's and no migration is owed.
- Frozen markers read who actually went through (the confirmed proposal or the qualified set, else the cut) and update on read after a settled tie, a correction or a backfill.
- k for unequal pools is measured against the smallest pool that supplies a candidate, after expunges.
- Two late entrants in one pool owe each other a fixture.
- The contradictions (Reinstate's two paths, "freeze" versus "recompute on read", how long "Joined round N" shows, the enroll door, the order of the late-entry cases, where the withdrawal row lands) were each resolved by one sentence in both files.

## 2026-11-06: S1 to S7, one at a time

S1, the two rows with no builder control. Owner: "show me that 2 first". Shown as two diagrams: groups-only (pools, no bracket) and two-tier groups (pools, super-pools, knockout, the T20 World Cup shape). One fact changed the question: two-tier groups already has an organizer path through the template gallery as "T20 Super 8", cricket only, 16 teams; the one browser case that worked in the W3-final run used it. Options: picker control for groups-only and the gallery template opened to any sport; picker controls for both; groups-only only. Recommendation: the first, because every cell is then driven through a real organizer path and nothing is dropped. Owner: "Picker control for groups-only; gallery template for two-tier, any sport (Recommended)".

S2 Swiss pairs on the adjusted score: per rec. S3 the frozen markers reach the live finished Swiss table: per rec. S4 the boardgame cells on the groups-plus-bracket rows work, confirmed by the W3-final run: per rec. S5 a departure or correction inside a completed table source stales the proposal, draft and confirmed, as W3 and W4 ruled for their sources: per rec. S6 late entry runs until the stage completes: per rec. S7 the pool floor stays two: per rec.

## 2026-11-06: approval

Owner: "approve and record all rules". Ruling 285. Recorded: the design's status and the rulebook's banner; every REC row now reads OWNER 285; rulings 276 to 285 and the W5 status row in the snapshot's `_INDEX.md` (and in `_INDEX-w5-additions.md` for the real repo). The engine rows are recorded at plan start, because the engine checkout is not in this tree.

## 2026-11-06: the plans

Owner: "how do we you engine pr? plan". Explained the engine plan's anatomy from W4's and the W5 batches B0 to B8. Owner: "Ok". The three plans were written with the writing-plans skill. Calls the plans make, each flagged in its PR body section: a fresh `X-CU` rule-row area rather than continuing W4's unmerged `X-LE` numbering; app PR A computes the catch-up set app-side until the engine release and app PR B swaps the engine's in behind a parity test; export-every-pool was already fixed on 2026-10-28 and W4's app plan already widens the cut set to league and group, so both became verify-and-pin tasks; the format bounds cap legs at two, so the triple round robin template is driven before anything is fixed.

Owner: "move all newly created files to /Users/asubramanian-mac2/Documents/s-new-u and also create a new file for records of askign questions and answer and rec why". Done; this file is the record.

## Still owed

The owner's review of the three plans and the execution method; the article numbers for the six federation citations; the R24 layout rounds; bench packs (none exist for the six W5 gates); reading issue #850; the first W5 recon on current main; execution gated on W4 merged and the engine rows PR landing first.
