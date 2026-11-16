# W5 — round-robin family: design

- **Date:** 2026-11-05 · **Programme:** format matrix (`2026-09-27-format-matrix-prompts/_INDEX.md`), wave W5
- **Rows:** `league`, `triple_rr`, `league_ko`, `groups_ko`, `group_stepladder`, `group_playoffs`, `group_only`,
  `group_group_ko` × 11 sports = **88 cells** (*2026-11-16: ruling 287 deletes `triple_rr`; seven rows, 77 cells*). The brief lists seven rows and names `group` for `group_only`;
  `group_group_ko` reaches W5 by design §8's clause that an unlisted gap goes to the wave owning its format
  (NEW-W1d-5, `_INDEX.md` W5 backlog).
- **Inputs:** wave brief `W5-round-robin.md`; draft rulebook `rulebook-W5-round-robin.md` (unsigned, written 2026-11-05
  beside the brief); audits `audit-2026-09-27/FX-fixtures.md` and `ST-standings.md` (app 782628af5); the committed
  routing `tools/matrix/catalogue/gap-routing.json`; the W3-final truth run (`truth-runs/w3-final/ci/L3`, CI run
  41818942253, harness bc6b645, 2026-11-04) and the generated W5 backlog in `_INDEX.md`; W3's design, rulebook and app
  plans (carries); W4's design and rulebook (the reconcile seam, ruling 271, the cut backfill, the stored draw seed);
  the owner's census (2026-11-05): one live tournament, Swiss → knockout, finished. **A read-only recon ran on
  2026-11-16** against seazn.club `origin/main` 97b184e2d9 and engine `origin/main` 2cd842a (9.0.0): three audits
  (engine plan, app plans, leftovers) in the session scratchpad `w5-audit/`, applied here per its
  `revision-decisions.md`. It found the engine at 9.0.0, not the version this doc assumed (W4 shipped as 5.0.0);
  `usecases/stages.ts` split into the `usecases/stages/` folder; the migration numbers the first plans named taken (next free V525); CUT-1,
  CUT-2 and ST-G24 already fixed on main; C38 already refusing a first group draw that strands a pool of one; the
  engine already emitting leg and bye, a cross-pool seed order, per-pool rank locks, opening deltas and a total
  expunge of every played fixture it is handed; and W4's reconcile planner unable to answer a round-robin roster
  change in place. Every correction is listed in §13. **Pins:** every file:line in this doc not marked otherwise was
  re-pinned on 2026-11-16 @97b184e2d9 (app) / 2cd842a (engine); a pin that could not be re-verified is marked
  `(unverified)`. The recon was a read, not a run: LIKELY rows in §9 still need a driving test (R5).
- **Status:** **APPROVED by the owner 2026-11-06 (ruling 285: "approve and record all rules")** — every designer's
  call below and every REC rulebook row is signed by 285. Q1–Q9 were put to the owner in session on 2026-11-05 and
  are recorded as **OWNER** with ruling numbers **276–284**
  (W4's close-out left 275 as the last ruling; re-check `origin/main` before recording, because parallel sessions add
  rulings). Q1–Q9 were the owner accepting the designer's recommendation: Q2 after two clarifications (the row is kept
  and marked; the rule is for leaving the whole stage, not a mid-match retirement), Q9 widened by the owner's own
  question to every table stage. **The builder check (2026-11-06) raised eight questions and six contradictions;**
  all were settled as designer's calls 24–31 (§10) and wording fixes, none needed the owner. **S1–S7 were SIGNED by the
  owner on 2026-11-06**, each per the recommendation (§8). Decisions marked **(designer's call)** are listed in §10
  for checking. Every rulebook row that was REC reads OWNER 285. Rulings 276–285 are recorded in `_INDEX.md` in this
  tree; re-check `origin/main` before merging the ledger.
- **Revised 2026-11-16 against engine 9.0.0 (2cd842a) and app 97b184e2d9.** Rulings 276–285 are NOT yet on main
  (`origin/main`'s `_INDEX.md` ends at ruling 275); recording them, with ruling **286** (owner 2026-11-16: unequal-pool
  normalisation always on, §5.2), is the plan's B0, a docs-only push. The designer's recommendations REC-1..REC-10
  (§10) are **not** owner rulings and wait for the owner. Corrections are in §13.

---

## 1. Intent

Census (owner, 2026-11-05): **not in production except one tournament**, a finished Swiss → knockout. There is **no
live league or group table**, no customer has run a round robin, and the 2026-09-27 census's one league division (3
fixtures) was the owner's own test. So W5 is not about a pain live organizers feel. It is the owner's aim for the
whole programme applied to its largest family: **every round-robin cell works in every edge case, under rules a
federation would recognize, or refuses with plain guidance**, before anyone runs a league or groups standalone.

What the truth run says today (W3-final L3, 2026-11-04): every W5 row is ✅ on the four driven scenarios (F1,
LIFECYCLE, M1, R4) at default config, except `group_group_ko` F1, red on all eleven sports because seven entrants
snaked into four pools leave seed 1 alone (ST-G5, PO-1). Thirteen routed audit ids have never been driven, and 33
browser cases have no builder path (NEW-W1d-5). The audits read five things the four driven scenarios never reach:

1. **Roster after Start.** A late player plus Generate duplicates pairs and never creates others, with no warning
   (FX-G1, #879). Add match, the documented workaround, lands each match in its own new round (FX-G15). Automatic
   arrivals bypass the Start lock for every format, so a league gains an un-fixtured entrant (W3 app-A finding). Late
   entry is owed for league and groups (W3 carry; W4 RB4-L2).
2. **Withdrawal and the cut.** The expunge skips signed-off fixtures, so a table ends half-expunged (ST-G15). A
   departed qualifier keeps a dead seat, a bye is stamped, and the public page still names them (W3 T15 finding;
   fixed since by W4 T13, verify-only per §9).
3. **Pools.** A pool table lists only members with a result (ST-G5). A pool of one is accepted, then fails at
   Complete. A single pool writes no pool id (FX-G22). Board cards carry no pool letter (FX-G19). Rank override cannot
   pin a rank per pool, and one bad override freezes every later recompute (ST-G14). The unequal-pool normalization is
   an inert seam (ST-G3). Who sits out is never recorded (FX-G21).
4. **The draw into the knockout.** Three pools top two puts C1 v C2 in round one; five pools top three puts A2 v A3
   (FX-G5). A correction inside a completed league or group source stales only draft proposals (FX-G16's table half;
   W3 and W4 covered Swiss and knockout sources).
5. **Table truth on every surface.** The cut line vanishes at completion (ST-G17). Points deduction has no path (C5,
   🚫). The hub has no withdrawn chip (ST-G20). Export writes one pool (ST-G24; fixed since in 06537ffea9, verify-only).
   Digests skip pooled divisions (ST-G6).
   The standings API declares no shape and lists no pools (ST-G23, ST-G28).

**Success:**
- An organizer adding a late player to a running league or groups sees catch-up fixtures appear: never a duplicate
  pair, never a silent gap, and by the end everyone has the same played count.
- A quitter's effect on the table is one rule every opponent can predict, and nobody qualifies into an empty seat.
- Every pool table lists every seated member from day one, and an impossible pool split is refused before anyone
  plays.
- Best runners-up across unequal pools are compared on a stated basis, and no group opponents replay in round one.
- A finished table still says who went through. A points penalty appears on the table with its reason. The hub, the
  export, the digest and the API read the same table.
- Every rule W5 relies on is a signed row in the engine's rules files.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1 **Late entry after Start into a league or group entry stage: catch-up fixtures** (OWNER Q1, §4.1).
- G2 **Withdrawal from a table: the 50 percent rule with a total expunge** (OWNER Q2, §4.2).
- G3 **A departed qualifier leaves the cut; the next eligible entrant backfills** (OWNER Q3, §4.3).
- G4 **No pool under two; every pool table lists every seated member** (OWNER Q4, §5.1).
- G5 **Unequal pools: best-Nth compared with results against the bottom team dropped** (OWNER Q5, §5.2), always on
  (ruling 286).
- G6 **Groups → knockout: no same-pool match in round one** (OWNER Q6, §5.3).
- G7 **A pair that loses a partner withdraws as the entrant** (OWNER Q7, §4.4).
- G8 **A finished table keeps its cut line, frozen** (OWNER Q8, §6.1).
- G9 **"Adjust points" on every table stage** (OWNER Q9, §6.2).
- G10 **The round-robin half of the shared reconcile** (FX-G1): a round-robin (pair, leg) planner beside W4's
  knockout one (§6.6; revised 2026-11-16 — W4's planner cannot answer a round-robin roster change in place).
- G11 **Close every gap in §9** to ruling 19's bar: zero ❌ on the eight rows attributable to W5, others ⏳ with their
  owner, and nothing previously ✅/⛔ turned red (Swiss and knockout rows included, because the reconcile is shared).
- G12 **Rule rows:** every W5 behaviour gets a signed row in the engine repo's `rules/cross-sport.md` (and a sport
  file where a sport-specific consequence exists), plus a numbered ruling in `_INDEX.md` (§12).

**Non-goals**
- **Missed rounds scored as losses**, and any organizer setting that chooses between catch-up and losses (Q1). One
  rule.
- **An organizer-settable expunge threshold**, and a per-sport threshold (Q2). BWF and ITTF practice (always expunge
  in a round robin) and the FA's 75 percent line are recorded as deviation rows.
- **Per-match averages, or a refusal of best-Nth on unequal pools** (Q5).
- **Fixed FIFA/UEFA bracket tables per pool count** (Q6). One general rule.
- **Same-pool separation beyond round one** (Q6).
- **A substitute partner on a pair entrant** (Q7, R12a). Lineup substitution stays with the deferred lineup work and
  is refused with a named reason.
- **Club separation in pool draws** (D4): ⏳ deferred to the clubs follow-up by ruling 272; W5's groups consume it then.
- **A format-picker control for `group_group_ko`** (OWNER S1): it stays a gallery template, generalized to every
  sport.
- **Division-level merge, split and move** (D1, D2, R13): W9's.
- **A late entrant into a knockout fed from a table**: refused there (RB4-L2); the entrant joins the table stage under
  this doc.

**Anti-goals: things that would make W5 a failure even if every test is green**
- A finished round rewritten or renumbered by a late entry.
- A late entrant seated twice against one opponent, or never against one.
- A withdrawn entrant's row removed from the table, or an expunge that removes some of their results and keeps others.
- A pool table that lists fewer entrants than are seated in the pool, or a pool count changed by Generate without an
  organizer action.
- A best-runners-up comparison whose basis the table does not state.
- A sweep that passes on zero cases (R25): a catch-up sweep that never adds a fixture, a pool sweep over one pool, an
  unequal-pool sweep over equal pools.
- A cut line that reads differently on the hub, the embed, the export and the slideshow.
- A points adjustment shown anywhere without its reason.

## 3. Constraints

- **Two repos.**
  - Round-robin generation (`scheduling/roundrobin.ts`), pool membership and the table fold
    (`competition/stage.ts`), progression and best-Nth (`competition/progression.ts`), qualification status
    (`competition/qualification.ts`), points and rank locks (`competition/points.ts`) live in
    **onryde/seazn.club.engine**, published as `@onryde/seazn-engine`. Engine `origin/main` is **9.0.0** (2cd842a);
    W4 shipped as 5.0.0 (the v4 tag is a cricket release). W5's engine release is **the next engine major at release
    time (10.0.0 today; the engine plan's T10 re-checks the CHANGELOG, and PR B bumps to whatever it released)**, a major: it
    changes public types (`QualStatus` gains a member, `PoolTable` gains fields, best-Nth on unequal pools stops
    refusing), and the 5.0.0 precedent treats a new union member as breaking. Gate 1 of the engine plan reads "engine
    main CHANGELOG top is 9.x and no W5 code is present".
  - The app pins `@seazn/engine` = `npm:@onryde/seazn-engine@^9.0.0` in `apps/web/package.json:25` and
    `packages/reference/package.json:14`; it has already taken the 7.0.0–9.0.0 sport-epoch majors, so PR B's bump to
    ^10.0.0 owes no epoch work. There is no `pnpm fold-epoch:check` script in seazn.club and no
    `proposal.engine_version` column; neither is used.
  - The orchestration (`apps/web/src/server/usecases/stages/` — a folder since the MODULARIZATION split:
    `generate-tx.ts`, `generators.ts`, `ad-hoc.ts`, `completion.ts`, `seed-proposal.ts`, `carry-over.ts`, `generate.ts`
    and others behind `index.ts`; read `apps/web/src/server/MODULARIZATION.md` first), `withdrawal.ts`,
    `stage-seeding.ts`, late entry, Rebuild, proposals, every public surface and every screen live in **seazn.club**.
  - Order (fix round 1, F1; fix round 2, G4/G6): the seazn.club docs push (rulings 276–290 and these docs to main) →
    **B0** = the engine rule-rows PR (engine plan Task 0) → engine **9.1.0**, rows only (Task 0b) → a standalone
    seazn.club **W5 rows bump** PR (bumps to `^9.1.0` and lands the app half of the rows: 74 `AWAITING_PROOF` entries
    and three `AMENDED_TEXT` edits; #1146's shape; app plan A Task R), merged before PR A starts → **app PR A** (consumes
    no new engine code and passes nothing new to the engine) → engine PR (code + tests + row proofs + a major changeset +
    `Matrix rows: …`) → the engine major (**10.0.0** today) → **app PR B** (bump to it, with pool `results` passed in
    both `SourceTables` builders in the same commit) → a close-out (the patch after it, 10.0.1 today, proving PR B's
    rows, and its bump).
  - **Migrations:** next free is **V525** on 2026-11-16 (the numbers the first plans named are taken by W4 and sponsor
    deals; §13 #5). Re-check at worktree creation; parallel sessions add migrations.
- **W4 merged first** (R1; brief "Prerequisites") — met: W4 app A #1152, app B #1167. FX-G1 sits beside W4's
  reconcile planner (§6.6), the cut backfill is already W4 T13's on both halves (§9), the pool draw reuses W4's stored
  draw seed, and automatic arrivals reuse ruling 271's desk flag.
- **The ruling ledger stays in seazn.club.** Rulings 276–290 (§8, §5.2, §10). `origin/main`'s `_INDEX.md` ends at 275 on
  2026-11-16; re-check before recording.
- **One live tournament, Swiss → knockout, finished** (§7). No W5 rule touches a live league or group table. Q8's
  frozen cut line is the only W5 change visible on that tournament's finished Swiss table (designer's call 14; §8 S3).
- **House test rules** (`docs/superpowers/TEST-STRATEGY.md`, `_RULES.md`): all four test types per task;
  anti-vacuity counts on every sweep (R25); expected values from the rulebook and the engine's declarations, never
  from `generate()`'s output (R9); mutate every new guard once (R17); sweep every sport (R26); the four R27 questions
  answered in writing at review.
- **A read-only recon ran on 2026-11-16 (97b184e2d9 / 2cd842a); the 2026-09-27 audits were 782628af5.** Every LIKELY
  row in §9 is still proved by a driving test before it is called a defect, and the plans re-pin at worktree creation
  (R5): parallel sessions keep moving lines.
- **UI bar:** mobile-first, verified at 1280, 768 and 320 with no horizontal scroll; every new string in all 4 locale
  dictionaries plus `pnpm i18n:gen-keys` (R23); ≥2 layout options shown to the owner before any new control is built
  (R24: the pool picker on the late-entry form, the catch-up round label, the "Joined round N" mark, "Adjust points",
  the frozen cut markers).
- **Shared files.** `org-posts.ts` (ST-G6) sits beside W10's ST-G22 (`:1070`/`:1077`, `:1256`/`:1263`). Check W10's
  file list before editing; overlap → sequence (R2). The `usecases/stages/` modules are shared with every wave; W5
  runs after W4 in its own worktree.
- **Quick match is a new producer** (#1216, merged after this doc was written): its `league_ko` shape and its deciders
  use `addFixture` with a new round at `max(round) + 1` (`usecases/quick-match-add.ts:4`). W5's cut, late-entry,
  withdrawal and Add-match changes carry a regression check that quick match behaves as before (REC-10).
- **E2E runs by CI dispatch only** (`--ref <branch>`). Locally, only the scoped tests for changed files.
- **Environment (not a W5 gap):** build in a worktree with a fresh install (`seazn-local-env` skill); the main
  checkout's `node_modules/@seazn/engine` does not resolve to the pinned engine (W4 §3).

## 4. Roster after Start (OWNER, 2026-11-05)

### 4.1 Late entry: catch-up fixtures (OWNER Q1, ruling 276)

Late entry applies where the league or group stage is the **entry stage**:

| Format | Takes a late player? |
|---|---|
| `league`, `group_only` | yes (`triple_rr` is deleted, ruling 287; it was a detected template, never stored, so a lone league with `legs` ≥ 3 now reads back as `league` with its leg count; `legs` 1–8 stays, 285 / RB5-G1) |
| `league_ko`, `groups_ko`, `group_stepladder`, `group_playoffs` | into the **table stage** only, while it is not complete; never into the bracket (RB4-L2) |
| `group_group_ko` | into the **first** group tier only; never into the second tier |
| a league or groups fed from another stage | never (no such template today; stated for the API) |

**One action, "Add late player"**, in the stage rail's More menu, opens the Entrants tab's existing add form (W3 App A
Task 10; never a second form). For a group stage the form carries a **pool picker**, defaulting to the smallest pool
(ties: the pool the seed snake would give the (n+1)th seed), which the organizer may change (R24 options). The server
tries the cases **in this order** and returns `late_entry` with the case taken:

| Case | Condition | What happens |
|---|---|---|
| **(1) Refuse** | The stage is complete | A named refusal: "Stage complete; add the player to the next stage, or reopen the stage". |
| **(2) Rebuild offered** | Nothing in the stage has **started** (K4 predicate: no score event, no live play, no decided result, no Match Day call) | `rebuild_offered`: the desk offers Rebuild as the clean path (one transaction, keeps times and courts, ruling 253; the roster regenerates as a fresh round robin and a group stage re-snakes its pools, which the notice says), with catch-up (case 3) as the alternative on the same notice. Reuses W3's `X-RB-1` league Rebuild. |
| **(3) Catch-up** | Otherwise | The newcomer is seated in the pool (or the league). For every other entrant in that pool, per leg, one fixture is owed. **A fixture whose opponent holds the bye in a future round lands in that round** (odd field; the bye becomes a real match). **Every other owed fixture is appended as a catch-up round after the last drawn round, one fixture per round**, labeled "Catch-up". Finished rounds are never changed, and round numbers are never rewritten. New fixtures are unscheduled and flagged to the desk. |

Before Start the ordinary path stays: enroll, then Generate reconciles (§6.6). For a group stage that re-snakes every
pool, because seeding into pools by snake is the product rule, regenerated in one transaction with times and courts
carried by surviving pair. The pool picker appears only after Start, once the pools are published.

**The newcomer's record** is honest, not leveled: fewer played until caught up, no walkover losses, and the same
played count as everyone else once the catch-up rounds are done. The row is marked "Joined round N" until the
catch-up rounds are done, then the mark drops (designer's call; R24 copy).

**Automatic arrivals (ruling 271 reused).** A payment confirmation, a waitlist promotion, an import or a Reinstate into
a started league or groups is **never auto-placed**. The entrant lands on the entrant list with the desk flag ("1 late
player waiting — add to league"), and one organizer tap runs the cases above. This also closes W3's app-A finding
that registrations and imports bypass the Start lock for every format: today a league can gain an un-fixtured entrant
after Start with no flag. Two distinctions (designer's calls): the **enroll door is the organizer's own add** ("Add
late player" opens it) and runs the cases directly, never the flag; and a **Reinstate of an entrant whose lines still
exist** in the stage (voided or walked over under §4.2) restores those lines under §4.2 and never waits. Only a
Reinstate of an entrant with no lines in a started stage is an automatic arrival here.

**Entrant kinds:** individual, pair, team alike. A late pair is the late entrant (RB4-L11).

**Plumbing reused from W3 and W4:**
- `LateEntryResult` gains round-robin case names `catch_up`, `rebuild_offered`, `refused` and `waiting` (an automatic
  arrival; the organiser's tap then returns `catch_up` with `source: "organiser"`). These are the wire names (app plan A's
  schema); the sweep's labels for the two automatic cases are `waiting` and `catch_up` via the tap, not separate wire
  cases (fix round 1). Its `format` discriminant (W4 LE-2) gains `league` and `group`. A late entry with nothing owed
  is a named refusal (`nothing_to_add`, RB5-E9), never an empty success.
- The client mirror `lib/open-entry-stages.ts` and the Start dialog copy change per format, so "Entrant list closes" is
  no longer false for a league entry stage (W4 LE-1's league half). The drift test stays.
- An undo barrier `roundrobin_late_entry` joins `UNDO_BARRIER_TYPES` (`usecases/history.ts:111`). "Add late player" has
  no Undo; Undo answers with a named refusal that points to Withdraw (RB4-L13). `undoRefusal` (`history.ts:125`) knows
  only the knockout and Swiss refusal families today, so a round-robin code needs a third family.
- The automatic-arrival doors gain a round-robin admitter beside the Swiss and knockout ones. Every registration
  arrival (confirm, approve, waive, webhook, promotion) now goes through one door,
  `usecases/registrations/materialise.ts:231-232` (registration redesign #1220); imports and reinstate keep their own
  calls in `imports.ts` and `entrants.ts` (re-pin at task time). The waiting count the desk reads is
  `usecases/competition-desk.ts:508` (it joins `entrants.knockout_waiting_stage_id`); the plan decides whether one
  waiting column is generalised or a second added, and every W4 reader learns it.
- `LateEntryResult` lives in `api-v1/schemas/entrants.ts:209` (a discriminated union on `format`).
- One desk notice per case, in 4 locales.

Designer's calls inside the case (§10):
- **Which future round takes a bye-holder fixture:** the round where that opponent holds the bye, so no round seats an
  entrant twice.
- **Catch-up round order:** opponents in the order of the rounds they already played (round 1's opponent first), so
  the newcomer's history reads in schedule order. Opponents whose earliest round is the same (in an even league every
  member plays round 1) follow the listed (seed) order (designer's call 2026-11-16, fix round 1).
- **Legs:** every leg owes its fixture; a two-leg league appends catch-up rounds for both legs, home and away
  alternating as `roundrobin.ts` does.
- **Rebuild under case (2)** keeps the stored entry order; a league Rebuild keeps slots by position (W3 X-RB-1); a
  group stage re-snakes its pools, and the notice says so.
- **Two late entrants in one pool** owe each other a fixture too (every pair once per leg), placed by the same policy:
  a future bye slot, else appended. By the time the second arrives, the first is an ordinary entrant.

### 4.2 Withdrawal from a table: the 50 percent rule, total expunge (OWNER Q2, ruling 277)

An entrant who **leaves the stage for good** (withdrawn, or disqualified: ruling 259). A mid-match retirement (M3) and a
single no-show (M1) are W2's and stay as they are: the entrant stays in the table.

- **The row stays**, marked Withdrawn (or Disqualified), ranked last, on every surface: division page, console,
  embed, hub (ST-G20), export, slideshow, API.
- **Under half of their scheduled matches played** (all legs counted; decided or finalized counts as played; voided
  does not): **every result they played is removed from the table, finalized ones included** (fixes ST-G15), and every
  unplayed fixture is **voided**, not a walkover. Every opponent ends with the same number of counting matches.
- **Half or more played:** every result stands, and every unplayed fixture is a **walkover** to the opponent at the
  sport's declared walkover score (W2 SC-S rows).
- **Deviations recorded:** BWF and ITTF round-robin practice removes a withdrawn player's results whenever they
  leave; the FA Standard Code of Rules expunges below 75 percent of fixtures. The product keeps one rule for every
  sport at 50 percent (owner, Q2). Each is a deviation row.
- **Reinstate** reverses the expunge or the walkovers, as W3 does for Swiss: voided fixtures and never-played
  walkovers return to scheduled, and nothing is reshaped, because the entrant's lines still exist. A Reinstate of an
  entrant with no lines in a started stage is an automatic arrival under §4.1.

Designer's calls (§10): the "half" test counts the entrant's scheduled fixtures in the stage at the moment of
withdrawal, catch-up fixtures (§4.1) included; a disqualification uses the same rule; the table footnote says which
rule applied ("Results removed: left after 2 of 5" or "Remaining fixtures walked over").

**Where the code stands (2026-11-16).** The engine already decides this rule: `withdrawTableEntrant`
(`competition/stage.ts:943`) expunges when `fraction < 0.5` (`:954`, strict "under half"), voids **every** played
fixture it is handed (`:957-960`), never expunges a Swiss stage (`:930-934`), and an empty stage expunges. The
half-expunge (ST-G15) is the app's: `usecases/withdrawal.ts:225-233` `applyUpdate` skips a `finalized` fixture and
counts it as `skipped_finalized`, although `lib/table-withdrawal.ts:16` feeds finalized fixtures in as played. The fix
is app PR A's, and it must take the expunge-abandon path that `usecases/stages/completion.ts:51-58` counts, so ruling
105 / M-10's auto-advance stall does not return once a finalized fixture is expunged.

**Ruling 111 (self-withdrawal after Start) joins this door (REC-4).** `usecases/registrations/withdraw.ts:113`
`withdrawCore`, called by the public status pages (`registrations/public-status.ts:136,287`), sets the registration and
entrant to withdrawn with no phase check and no cascade. Recommended: route it through the same table-withdrawal
usecase, so a player leaving a started table is §4.2's rule, one door.

**In-match disqualification (REC-7).** Engine row X-RT-1 still says "the cascade to other fixtures is W5". Recommended:
a DQ recorded on the pad withdraws the entrant from the stage under §4.2 (ruling 259 = withdraw), the organiser DQ
cascade (`usecases/withdrawal.ts:149-151`) is reused, and X-RT-1 is re-worded in B0.

**Per-sport rows (REC-8).** Badminton's BD-WO-2 and BD-RT-1 (engine `rules/badminton.md:6-7`) still say "until W5";
they are re-worded under 277 as permanent deviations. Tennis (RB2A-3: a withdrawn player is ineligible for the
knockout) gets its own deviation row if it keeps a different rule.

### 4.3 The cut after a withdrawal: the Swiss rule (OWNER Q3, ruling 278)

- **A withdrawn or disqualified entrant leaves the knockout cut on any completion.** Setup seeding excludes them
  (`stage-seeding.ts` `CUT_SKIPS_DEPARTED_KINDS` gains league and group), and on-complete `config.qualified` excludes
  them.
- **The next eligible entrant in the table takes the seat.** For a best-Nth cut the cross-pool comparison is
  recomputed without the departed entrant.
- **The public page stops naming them as a qualifier.** The table keeps their row, marked.
- **W4 built the destination half** (RB4-V6: a departed qualifier from a table source is replaced by the next-ranked
  eligible entrant). W5 owes the source half above, and the two halves are proved together by one driving test per
  row.
- **Revised 2026-11-16: W4 T13 also built the source half.** `lib/table-withdrawal.ts:61` already reads
  `CUT_SKIPS_DEPARTED_KINDS = {swiss, league, group}`; `usecases/stage-seeding.ts:96` `cutEligiblePools` is used on
  the setup path (`stage-seeding.ts:474`) and on completion (`usecases/stages/carry-over.ts:282`);
  `stage-seeding.ts:137` `departedLoseBestNth` recomputes best-Nth (`carry-over.ts:354`, `stages/seed-proposal.ts:146`);
  the public cut stops counting her (`public-site/qualification-view.ts:574`). W5's work here is **verify-only**: one
  driving test per row and path (setup, on_complete), fixing only on red.

Designer's calls (§10): "eligible" excludes withdrawn and disqualified; a departure after the knockout's first match
has started is RB4-V3's walkover, not a backfill; a departure after a confirmed proposal and before the knockout starts
stales the proposal (RB3-19 by analogy; §8 S5).

### 4.4 A pair that loses a partner, and a duplicate entrant (OWNER Q7, ruling 282)

- **The pair is the entrant.** When one partner drops out, the pair **withdraws under §4.2**. The remaining player may
  enter again in a new pair as a late entrant under §4.1, with a fresh record.
- **No substitute partner on a pair entrant** (R12a): refused with a named reason, and routed ⏳ to the deferred lineup
  work. R12b (pair dissolved) is the rule above.
- **A duplicate entrant** (R11a the same person twice; R11b one person in two pairs in one division) is **refused at
  add** with a named reason (designer's call; W3's rulebook handed "the refusal belongs to the roster rulebook" to W5).
  **Revised 2026-11-16: already built** as `PERSON_ON_OTHER_TEAM` 409 (`usecases/entrants.ts:195`, also on reinstate
  and import; registration side in `api-v1/schemas/registration.ts` (unverified)). W5 pins it with a driving
  test per case and adds no `RR_DUPLICATE_ENTRANT` code. R12 (partner substitute, pair dissolved) is still unverified.

### 4.5 Roster before Start: #837 (REC-5)

Deleting a league entrant before Start leaves its fixtures half-filled (#837, open;
`usecases/__tests__/swiss-delete-entrant.test.ts:378` freezes today's behaviour as its expectation). Recommended: app
PR A's reconcile task owns it — the delete path drops the removed entrant's (pair, leg) lines as Generate does (§6.6)
— and the pinning test is moved to assert the fix, not deleted.

## 5. Pools and the draw (OWNER, 2026-11-05)

### 5.1 No pool under two; membership is seating (OWNER Q4, ruling 279)

- **Generate refuses any pool count that leaves a pool with fewer than two members**, with a named reason in 4 locales
  that names a pool count that would work. The builder's estimate (`lib/division-builder/format-estimate.ts`) and the
  server agree, so the organizer sees it before Start. **Revised 2026-11-16:** the server half exists as C38
  (96aae0f7e6, #1173): `usecases/stages/generate-tx.ts:423-445` refuses a first group draw that strands an entrant
  with `STAGE_NOT_READY` reason `group_too_few_entrants` (the setup path already had F2a). W5 **extends C38** — adds
  the named workable pool count (`suggested`) and the builder gate (`lib/division-builder/format-choice.ts:97`
  `formatBoundIssue` takes no entrant count today) — and adds no parallel `RR_POOL_TOO_SMALL` code. Engine-side, a
  `validatePoolSizes` check is optional.
- **A pool's membership is every seated entrant**, from day one, with zero played (fixes ST-G5: engine
  `competition/stage.ts:286-311` `entrantsOfPool` reads "entrants with a result or award", and pools come from the
  fixtures' `poolId`, `poolNames` at `:277-283`, so a stage with no fixtures yet folds as one table of everyone). League
  already uses the whole entrant set. The engine change seats membership from `completeTableStage`'s input
  (`TableStageFields.pools`); `PoolTable` lives in `competition/progression.ts:475-482`, not in `stage.ts`. An entrant
  not yet seated (a waiting late arrival) is not a row and is not refused; only a result naming an unseated entrant is
  (designer's call 2026-11-16, fix round 1).
- **The `group_group_ko` F1 cells** (7 entrants, 4 pools) become **⛔ refused**, not ❌ (R12: a refusal mandated by this
  ruling and observed).
- **A single pool** still writes its pool id (FX-G22), so pool-scoped reads behave. Today
  `usecases/stages/generators.ts:442` calls `roundRobinGen` with no pool id when the count is 1, and pool rows are
  only materialised when the count is above 1 (`stages/generate-tx.ts:301`), so the fix materialises pool A too.
- **Board cards** carry the pool letter (FX-G19: `BoardFixture` gains `pool_id`).
- **Who sits out** in an odd pool or league is recorded per round and shown on the board and the public page (FX-G21).
  A bye line never holds a court (`systemByeSql`, `engine-db/system-bye-sql.ts`, generalized as W4 did for knockout).
  The engine **already** emits the bye per round (`scheduling/roundrobin.ts:48-53`, `RoundRobinRound.bye`) and the leg
  per fixture (`:42`); the app's `roundRobinGen` (`stages/generators.ts:391`) drops the rounds and keeps only
  fixtures, so FX-G21 is app PR A work with no engine release. #850 ("League/Group bye is invisible") is the same
  defect as FX-G21 and closes with it.
- **Rank override works per pool** (ST-G14): a rank may be pinned once per pool, and an override above the pool's size
  is refused at write, never thrown at recompute. The engine already applies locks per pool
  (`competition/stage.ts:376-378`; the throw is `competition/points.ts:686-690`); what is owed is the app's write-time
  check — `usecases/stages/completion.ts:432` checks duplicate ranks over the whole body — and an optional engine
  `validateRankLocks`. No migration.
- **A rank override on a non-table stage (P7, REC-6)** is refused by name: `completion.ts:413` `overrideStandings`
  checks the stage, the entrants and duplicate ranks but not the stage kind, and the public `has_rank_overrides` flag
  then fires on an override that does nothing.

Designer's calls (§10): the minimum is 2, not 3 (a pool of two is one match, legitimate for a play-in); the refusal
names the largest pool count that keeps every pool at two.

### 5.2 Unequal pools: drop results against the bottom team (OWNER Q5, ruling 280)

- **When the cut compares Nth-placed entrants across pools of different sizes**, every candidate from a larger pool
  has their results against that pool's **bottom-placed** entrant left out, so every candidate is compared on the same
  number of matches (UEFA qualifying convention).
- **k per candidate** = that candidate's pool's effective size minus the smallest effective size among the pools that
  supply a candidate, where effective size is after §4.2 expunges (an expunged entrant is already out of everyone's
  results). Pools differing by more than one drop results against the bottom k entrants.
- **The comparison then runs the per-sport cross-pool cascade W2d built** (ST-G4) on the reduced result set.
- **The basis is shown** on the table and in the progression panel: "Best runners-up compared on 3 matches (results v
  5th in Pool B not counted)".
- **This repairs the inert seam** (ST-G3): either the template's `normaliseUnequalPools` flag
  (`lib/format-templates.ts:146` in this tree; the API schema carried it at `server/api-v1/schemas.ts:1062` in 782628af5, now `api-v1/schemas/stages.ts` line 64) finally
  receives `PoolTable.results`, or the flag goes and the rule is unconditional (builder's choice).
- **Settled by ruling 286 (owner 2026-11-16, "apply your rec unequal pool"): the rule is unconditional — always on.**
  The "builder's choice" above is closed. `normaliseUnequalPools` stays in the schemas so stored configs still parse
  (`lib/format-templates.ts:146`; API `api-v1/schemas/stages.ts` line 64; engine `TakeRule`, `competition/progression.ts:52`),
  is accepted and ignored, and is marked deprecated. The engine's `SEEDING_BESTNTH_UNEQUAL_POOLS` refusal
  (`progression.ts:826-835`, thrown today when the flag is absent) goes for this case.
- **What the engine does today (2026-11-16):** with the flag set, `normalisedRow` (`progression.ts:652-670`) drops
  results against the bottom **one** row, even for equal pools; `PoolTable.results` is already filled by
  `completeTableStage`. W5 generalises it to k = size − min per §5.2's rule and makes equal pools drop nothing (RB5-U6),
  consuming the existing carriers (`PoolTable.results`, `SourceTables.crossGroup`) rather than a parallel input. This is
  a behaviour change for stored progressions, one reason the release is 10.0.0.
- **Fix round 1 (2026-11-16): the app passes no `results` today.** Both app `SourceTables` builders
  (`usecases/stage-seeding.ts:414` `sourcesToTables`, `usecases/stages/carry-over.ts:251` `tablesForCompletedStage`)
  build pools from snapshot rows only, so every app comparison is raw today and the stamped flag is a no-op. Under
  10.0.0 a best-Nth over unequal pools without `results` refuses `pool_results_missing`, so the app passes pool
  `results` in both builders (closing ST-G3's inert seam from the producer side). **Fix round 2 (G4): app PR B does
  it, in the same commit as its bump to 10.0.0**, so results and the always-on engine land together and there is no
  9.x window: app PR A passes nothing new, and 9.x behaviour stays as it is until that commit.
  The effective size reads `PoolTable.expunged`, which **app PR B** writes in both builders from the withdrawal ledger's
  expunge mode, active (not voided) rows only, so a reinstated entrant is not expunged (9.1.0's `PoolTable` has no
  such field).

Designer's calls (§10): the bottom entrant is the one the pool's own cascade ranks last, stored lots included (W2d); a
withdrawn bottom entrant under §4.2's expunge is already out of everyone's results, so nothing more is dropped; equal
pools drop nothing, and the sweep asserts it saw at least one unequal case (R25).

### 5.3 Groups → knockout: cross the pools in round one (OWNER Q6, ruling 281)

- **No round-one match between entrants from the same pool.** Placement goes by rank, then pool rotation (A1 v B2,
  B1 v A2; with three pools top two: A1 v C2, B1 v A2, C1 v B2), on the fold.
- **Where ranks tie** (pool winners with equal records across pools, or best-Nth candidates), the order is drawn with
  the destination stage's **stored, shown, reproducible draw seed** (W4 RB4-D4). Fix round 1 (F3): ruling 281 governs;
  the engine's `crossPoolDraw(seeded, shape, drawSeed)` takes that seed and shuffles each run of tied seeds inside a
  tier with it (`core/rng.ts` `shuffle`, mulberry32) before the separation search; the caller marks which seeds are
  tied. **"Tied" (fix round 2, G3)** means equal on the cross-pool comparison: level on every key of the source's
  cross-group order, so only lots, seed or id ordered them. It is computed where the cross-pool ranking is built — for
  best-Nth candidates by the engine's own ranking (`ComparisonBasis.levelWith`), for a same-rank tier (pool winners,
  runners-up) by PR B ranking that tier with the engine's `crossGroupOrder` — and never read from the resolver's
  `tieUnbroken`, which marks a tie inside one pool. Designer's calls: rows with different match counts are never level;
  only seeds adjacent in the tier's order link. The engine plan's `PooledSeed.tied` contract is the exact text.
- **How the rotation is found** (designer's call): the fold places rank tiers as today (winners, then runners-up,
  then best-Nth). Where the fold seats two same-pool entrants in round one, the engine swaps entrants **within a rank
  tier** (runners-up among runners-up, best-Nth among best-Nth), searching the tier orderings in pool order with ties
  by the stored seed, so the result is deterministic and pool winners keep their fold positions.
- **Where separation is impossible, Generate refuses with a named reason** rather than seating a same-pool pair
  silently. Impossible means no ordering of the tiers separates every round-one pair (exhaustive over the tiers;
  qualifier fields are small). "One pool supplies more than half the draw" is one such case, not the only one. The
  reference checks legality (no same-pool round-one pair) and existence (a separating ordering exists, so the product
  must find one), as W3's Swiss oracle does (design §7.2).
- **Round two onward follows the fold**; same-pool entrants may meet.
- **Byes** go to the top-ranked qualifiers first (RB4-D2), and the rotation accounts for byes so a bye never forces a
  same-pool pair in round one.

Designer's calls (§10): the rotation is deterministic given ranks and pool letters, so Rebuild gives the same draw;
`rank_order` stays the API's name for the fold input; a stepladder or page playoff fed from groups takes the same
rotation for its first rung.

**Where the code stands (2026-11-16).** The engine already has a cross-pool seed order, `crossPoolSeedOrder`
(`scheduling/bracket.ts:257`, the wave interleave that is today's `rank_order`); W5 keeps it unchanged and adds
`crossPoolDraw` beside it (fix round 1, F7: the engine plan's name and signature win), returning `{ order, slotOrder }`
for `generateSingleElim`, or the first-rung order for a stepladder or page playoff. **`crossPoolDraw` serves only a source with two or more pools (fix round 3, N6):** the `group_stepladder` and `group_playoffs` templates are league-sourced (`lib/format-templates.ts:168-188`; no pools, and `crossPoolDraw` refuses one pool), so they keep today's placement through the existing single-source seeding path; the stepladder and page-playoff shapes serve API or gallery stages fed from group sources, and the harness separation check applies to pooled sources only. `generateSingleElim` refuses `slotOrder` together with `byeEntrants` (`bracket.ts:129-130`), so byes ride as
`null` slots in the slot order. `rank_order` today is `pots.flat()` and progression returns a seed list, not a bracket,
so the round-one check calls `generateSingleElim` itself and the plan states where the draw size comes from.
`competition/` imports `scheduling/` by type only today; the new ordering either stays inside `scheduling/` or the
plan records the new value-import direction and passes `pnpm boundary`. The tie draw uses `mulberry32`
(`core/rng.ts:8`). Two pools (A1 v B2, B1 v A2) already come out of the fold; that case is a pin, not a differential.

**Seeding ties (REC-2, narrowed in fix round 1).** The listed (seed) order applies only where ruling 281 does not
decide: a tie between teams in different pools that survives the best-Nth basis comparison is broken by the **sport's own
declared cross-group cascade** (ruling 291, which supersedes 288's "listed (seed) order" wording): a `seed` step gives
seed order; `lots` gives the engine's stored lots draw; neither gives seed then id (engine `tiebreakers.ts:1081-1125`;
no engine change). Inside the cross-pool draw, ruling 281's stored draw seed decides rank ties.
Recorded as rule row X-PD-8 (signed by ruling 288, re-worded by 291) and proved in app PR A by a constructed enumeration test over every
template row that has a best-Nth take (the row set derived from `STAGE_TEMPLATES` and the engine's `TakeRule`
declarations, its count asserted > 0). Fix round 2 (G1): no "21 cases" count — the harness's 21 W5 notes are re-judged by
row (§9).

### 5.4 Club separation in pool draws: ⏳ deferred (ruling 272)

Not built. The clubs follow-up gives persons and pairs a club; W5's groups consume it then, with Q6's shape (opt-in,
round one, hidden without club data).

## 6. The table on every surface, and where everything lands

### 6.1 A finished table keeps its cut line (OWNER Q8, ruling 283)

- **At completion the live Through / Needs help computation stops, and the markers freeze** as **"Qualified"** and
  **"Out"**. `qualificationStatus` returns final markers when `complete` instead of null (ST-G17; the 2026-09-22
  standings-qualification spec's §3.3 is amended by this ruling).
- **Source (designer's call):** the frozen markers read **who actually went through**: the confirmed proposal or
  `config.qualified` where one exists, else the final table's cut. A settled tie (Q1a/b), a correction after
  completion (C6a) or a backfill (§4.3) updates them on read, so the departed entrant reads Withdrawn and the
  backfilled one Qualified.
- **The same on every surface:** division page, hub, embed, `/present`, export, OG.
- **Applies to every table stage with a cut** (league, group, Swiss) (designer's call 14; §8 S3). Derived on read, no
  migration.
- **Engine shape (2026-11-16):** `competition/qualification.ts:95` returns null when `!anyPlayed || complete` — the
  real differential. `QualStatus` is an object union (`:10-14`, `{kind: "through" | "out" | "win_k" | "needs_help"}`),
  so the frozen marker is a new member `{kind: "qualified"}` (breaking for exhaustive switches, 5.0.0 precedent).
  `QualRow` carries no rank and the order is the caller's, so "who went through" is an explicit input when complete
  (the confirmed proposal / `config.qualified`, else the caller's ordered cut), never inferred from row order. A
  withdrawn (inactive) row reads Withdrawn, not a frozen marker.

### 6.2 "Adjust points" on every table stage (OWNER Q9, ruling 284)

- **A desk action on a league, group or Swiss entrant:** plus or minus N points, with a **required reason**. Undoable
  (a ledger row). Hidden on brackets.
- **N adjusts the sport's `points` metric**, whatever the sport counts as points: league points in football and
  hockey, a match's worth in badminton, tennis and table tennis where points are matches won. A sport whose table has
  no points metric refuses the action with a named reason (designer's call). *Fix round 1: every table folds `points`,
  so this clause has nothing to act on; ruling 288 (REC-11) dropped it.*
- **It is a ledger row** (entrant, delta, reason, date, actor) that the fold reads as an opening delta before the
  cascade. It is not written into stage config: `carry_deltas` and its `FORMAT_LOCKED` stay as they are, Undo is the
  ledger's undo, and no migration is needed (designer's call).
- **Every surface shows it as a footnote** under the table ("Team C: −3 points, fielded an ineligible player,
  2026-11-05"), in 4 locales.
- **Swiss:** the adjusted score drives the next pairing (designer's call 15; §8 S2).
- **R24:** ≥2 layout options before build.
- **Engine shape (2026-11-16):** the fold already takes an adjustment: `openingDeltas` (`competition/stage.ts:344-348`)
  are folded with the results, so `{played: 0, points: delta}` is an adjustment today. There is no `applyPointsRule`;
  points are `StandingsRow.points` (`competition/standings.ts:22`), paid by the stage's `PointsRule`. New in the engine:
  the reason/note on the table and the zero-delta refusal (RB5-E8), carried as a separate `TableStageFields.adjustments`
  list of `PointsAdjustment` (fix round 1, F7: `openingDeltas` stays carry-over's and is unchanged), with
  `validatePointsAdjustments` and `PoolTable.notes`. Every table row carries `points`, so the "no points metric" refusal
  has no engine case (REC-11). Caveat
  for the plan: `stage.ts:354` counts an opening with `points !== 0` as a counted result, so an adjustment alone makes
  an empty table read as started — the plan decides and pins it. The designer's call above (no migration) holds while
  the ledger row is an existing history event; if the plan stores the footnote, it takes V525+ (`standings_snapshots`
  has no notes column, and the first plan's migration number is taken).

### 6.3 Engine PR (seazn.club.engine)

Revised 2026-11-16: only genuinely new seams. Engine paths are engine-repo relative (`src/…`), pinned at 2cd842a.
Released as the next engine major at release time (**10.0.0** today). New source files need a slot in `stryker.groups.mjs`'s `draws-*` lists (`:122-129`) or
`test/stryker-groups.test.ts` reds.

| Item | Gaps | Rule |
|---|---|---|
| **`roundRobinLineKey`** — the order-free (pair, leg) identity, the one new symbol in `scheduling/roundrobin.ts`. **Leg and bye already exist** (`RoundRobinFixture.leg` `:42`, `RoundRobinRound.bye` `:48-53`; the schedule is `{rounds, fixtures}` `:55-58`); a flat byes helper only if a consumer needs one. n < 2 keeps returning an empty schedule (`:91`), never a throw — the app refuses by name (`usecases/stages/generate-tx.ts:292`). An engine `ROUND_ROBIN_MAX_LEGS` guard is optional (the cap of 8 is the app's) | FX-G1 (engine half), FX-G21 (none: already emitted) | OWNER Q1 |
| **`lateEntryFixtures`** in a new `scheduling/catch-up.ts`: (pair, leg, target round or append) per §4.1. Pinned counts corrected: a six-member even field (a..f) owes **6** catch-up fixtures (rounds 6–11), not 5; the odd-n late-entry sweep over n ∈ [2,24] × legs 1–3 has **33** cases, not 36 | FX-G1 | OWNER Q1 |
| **Pool membership = seating, pool floor:** `completeTableStage` seats every pool member from its input (`competition/stage.ts:286-311` reads results today; `PoolTable` is `competition/progression.ts:475-482`), with zero played; a pool under 2 is a named refusal (optional `validatePoolSizes`). The `module.ts:830` pin in the first draft was false — that line is the `SportModule` interface, not a draw decision. The differential is written with scheduled, unplayed pooled fixtures (with no fixtures the stage folds as one table, `stage.ts:277-283`) | ST-G5, PO-1 | OWNER Q4 |
| **`validateRankLocks`** (new, up-front, named refusal). Locks are **already** applied per pool (`stage.ts:376-378`); the throw it pre-empts is `competition/points.ts:686-690`. Lands after pool membership, because a lock on a no-result entrant is dropped today | ST-G14 (engine half) | OWNER 285 |
| **Withdrawal: test-only proofs.** `withdrawTableEntrant` (`stage.ts:943`) already voids every played fixture it is handed (`:957-960`), uses strict under-half (`:954`), never expunges Swiss (`:930-934`), and expunges an empty stage. No `finalized` concept exists in the engine; the finalized skip is the app's (§4.2, App A). The signature is kept; an additive count (played at departure, scheduled) on the `entrant_withdrawn` event only if a consumer needs it. The per-sport walkover score is the app adapter's, so the sport sweep is the app's | ST-G15 (proof only) | OWNER Q2 |
| **Unequal pools, always on (ruling 286):** generalise `normalisedRow` (`competition/progression.ts:652-670`) from k = 1 to k = size − min; equal pools drop nothing; `SEEDING_BESTNTH_UNEQUAL_POOLS` (`:826-835`) stops refusing; `normaliseUnequalPools` (`:52`) accepted and ignored, deprecated. Consume `PoolTable.results` and `SourceTables.crossGroup`; the basis rides on the resolved entry, not the descriptor label | ST-G3 | OWNER Q5, 286 |
| **Cross-pool draw:** a new `crossPoolDraw(seeded, shape, drawSeed)` beside the unchanged `crossPoolSeedOrder` (`scheduling/bracket.ts:257`): the stored-seed tie order (`core/rng.ts` `shuffle`, mulberry32), the within-tier rotation and a named refusal; byes as `null` slots (`bracket.ts:129-130`); no new value import competition → scheduling | FX-G5 | OWNER Q6 |
| **Frozen markers:** `qualification.ts:95` stops returning null when complete; `{kind: "qualified"}` joins `QualStatus` (`:10-14`); the order source is an explicit input (`QualRow` has no rank) | ST-G17 | OWNER Q8 |
| **Adjustments:** a separate `TableStageFields.adjustments` (`PointsAdjustment` with a reason), folded beside the existing openings (`stage.ts:344-348`, unchanged); zero-delta refusal; notes on the table. No `applyPointsRule`, no points-metric lookup | C5 | OWNER Q9 |
| Every property counts what it checked: "every pair once per leg" across every n and legs 1–3 (69 cases), "every member listed" across pools, "bottom results dropped" across unequal cases (R25). `roundrobin.test.ts` already proves completeness, per-leg uniqueness, home/away balance and one bye per round; only the counts and the late-entry sweep are new | SEED-R5 (test half) | R25 |
| Rule rows in `rules/cross-sport.md` (+ sport files for walkover scores), each id in a test title, plus the app's own `AWAITING_PROOF` map `scripts/lib/rules-reference.ts:41` in seazn.club for app-path rows. `X-BL-1` is taken (W2b-R13, signed 98), so the builder rows take a free area code. X-LE-2 ("league and groups: W5"), X-RT-1 ("the cascade to other fixtures is W5", REC-7) and badminton BD-WO-2 / BD-RT-1 ("until W5", REC-8) are re-worded; a tennis deviation row is added if tennis keeps RB2A-3's rule | SEED-R5 | G12 |

### 6.4 App: work that needs no engine change (PR A, can run before the release)

| Item | Gaps | Rule |
|---|---|---|
Revised 2026-11-16. App paths are `apps/web/src/` relative, pinned at 97b184e2d9. Every task that touches
`server/` reads `server/MODULARIZATION.md` and the `usecases/stages/index.ts` barrel first.

| Item | Gaps | Rule |
|---|---|---|
| "Add late player" for a league or group entry stage (§4.1): cases, pool picker, catch-up placement (computed app-side until 10.0.0 ships `lateEntryFixtures`), desk flag and tap for automatic arrivals, `LateEntryResult` cases (`api-v1/schemas/entrants.ts:209`), client mirror (`lib/open-entry-stages.ts`) and Start copy, undo barrier with a third `undoRefusal` family (`usecases/history.ts:111,125`), the round-robin admitter at the one registration door (`usecases/registrations/materialise.ts:231-232`) plus imports and reinstate, the waiting count (`usecases/competition-desk.ts:508`), notices in 4 locales. Leg and bye read from `generateRoundRobin` today (engine 9.0.0) | LE-3, LE-4, FX-G1 (app half), #879 | OWNER Q1, 271 |
| **Its own round-robin (pair, leg) planner**, not W4's: `lib/bracket-reconcile.ts:79` `planReconcile` answers `regenerate` whenever the key sets differ, and `in_place` means seat moves, so it can never insert and drop round-robin lines; the driver `usecases/bracket-reconcile.ts:51` `reconcileRootBracket` is knockout-only. The round-robin path today matches by position (`usecases/stages/generate-tx.ts:446-519`, `byKey` by `ext_key`). Generate before Start adds and removes lines by (pair, leg), never by position (§6.6). The delete path drops a removed entrant's lines too (#837, REC-5; move the pin at `usecases/__tests__/swiss-delete-entrant.test.ts:378`) | FX-G1, #879 parts 1–2, #837 | G10, 288 |
| Add match lands in the round the organizer picks, default the latest round where neither side plays (`usecases/stages/ad-hoc.ts:209` `addFixture`; default `:299` `input.round_no ?? maxRound + 1`). Quick-match deciders keep `max(round) + 1` (`usecases/quick-match-add.ts:4`): they pass an explicit round, or the change carries their tests | FX-G15 | (designer's call), REC-10 |
| Withdrawal: the app stops skipping finalized fixtures on expunge (`usecases/withdrawal.ts:225-233` `applyUpdate`; `skipped_finalized` at `:157` and in the API schema), taking the expunge-abandon path so auto-advance (`usecases/stages/completion.ts:51-58`, ruling 105 / M-10) does not stall; voided fixtures under the line; walkovers at the sport's score above it (the per-sport sweep lives here); Reinstate reverses; the footnote. **Moved from the engine PR:** the engine already voids every played fixture it is handed | ST-G15 | OWNER Q2 |
| Ruling 111: self-withdrawal after Start goes through the table-withdrawal usecase (`usecases/registrations/withdraw.ts:113` `withdrawCore`; public callers `registrations/public-status.ts:136,287`), with the phase check and cascade — one door | ruling 111 | 288 |
| In-match DQ: a DQ recorded on the pad withdraws the entrant from the stage under ruling 277, reusing the organiser DQ cascade (`usecases/withdrawal.ts:149-151`); the Disqualify action (pad and organiser) first shows the consequence copy, 4 locales, its numbers from the same decision the cascade applies | X-RT-1, X-WDT-10 | 289 |
| Cut source half: **verify-only**, already built by W4 T13 (`lib/table-withdrawal.ts:61`, `usecases/stage-seeding.ts:96,137`, `usecases/stages/carry-over.ts:282,354`, `public-site/qualification-view.ts:574`): one driving test per row on the setup and on_complete paths; fix only on red | CUT-1, CUT-2 | OWNER Q3 |
| Pair partner leaves: the pair withdraws; R12a refused (drive first). Duplicate entrant: **already refused** as `PERSON_ON_OTHER_TEAM` 409 (`usecases/entrants.ts:195`) — pin it, no new code | R12, R11 | OWNER Q7, (designer's call) |
| A single pool writes its pool id (also materialise pool A: `usecases/stages/generate-tx.ts:301` only writes pool rows for 2+ pools; `stages/generators.ts:442`); board cards carry the pool letter (`components/v2/board/types.ts:30`, `board/round-codes.ts`); who sits out is recorded from `rounds[].bye` (`stages/generators.ts:391` drops it today) and shown. #850 = FX-G21, closed with it | FX-G22, FX-G19, FX-G21, #850 | brief, (designer's call) |
| Rank override per pool: the write-time duplicate/size check (`usecases/stages/completion.ts:432` checks the whole body today); the engine already scopes locks per pool. No migration. A rank override on a non-table stage is refused by name (`completion.ts:413`), and the public `has_rank_overrides` stops firing on it | ST-G14 (app half), P7 | (designer's call), 288 |
| Builder: **extend C38** (`usecases/stages/generate-tx.ts:423-445`, `group_too_few_entrants`) with the named workable pool count, and make the builder agree (`lib/division-builder/format-choice.ts:97` `formatBoundIssue`, `lib/division-builder/format-estimate.ts`) — no parallel `RR_POOL_TOO_SMALL`; `group_only` gains a format-picker control; the "T20 Super 8" gallery template (`server/templates/catalog/t20-super8.json`: group ×4 → group ×2 snake → knockout 4, cricket, 16 teams) is generalized to any sport and any field that divides cleanly (`server/templates/schema.ts` `sportKey` is already a string; only `entrantKind` widens; tools/matrix maps by `TEMPLATE_ROW`, there is no `templateFor`), so `group_group_ko` has an organizer path on every sport. **`triple_rr` is deleted (ruling 287, owner: "in prod, no triple_rr, so blindly cleanup, delete it"; supersedes REC-1).** Scope (coordinator's reading of 287, designer's call): the template row (`lib/format-templates.ts:254-262`) and its detection branch (`:404`: a lone league with `legs` ≥ 3 then reads back as `league` with its leg count), picker/builder references, the matrix row and its RETIRED_ROW_ROUTES / noOrganiserPathCell entry, i18n keys, help copy and the tests pinning it go. `triple_rr` is **detected, never stored** (no column holds a `STAGE_TEMPLATES` key), so there is **no migration and no data cleanup** (fix round 2, G5). No create door accepts the key today: `createFromTemplate` looks keys up in the gallery's `TEMPLATE_CATALOG` (`server/templates/catalog.ts:47`), which has no `triple_rr`, and already answers 404 `unknown template` (`server/usecases/templates.ts:85-88`); a door that ever accepts it refuses it by name. `legs` 1–8 stays (285, RB5-G1): a `legs: 3` league is a league | PO-1, NEW-W1d-5, TR-1 | OWNER Q4, OWNER S1, 287 |
| A correction inside a completed league or group source stales proposals, draft and confirmed: **real work** — `usecases/scoring.ts:1180-1188` stales only drafts on the table path; `{includeConfirmed: true}` is passed only for a completed knockout source (`:1194-1197`). Model on `usecases/knockout-cut-drift.ts` (closer than `swiss-cut-drift.ts`). A departure needs its own trigger in `withdrawal.ts` | FX-G16 (table half) | §8 S5 |
| Hub tables carry the withdrawn/disqualified chip (`public-site/standings-view.ts:568` `TableViewInput` has no status) | ST-G20 | brief |
| Export writes every pool: **already done** (06537ffea9, owner 2026-10-28; `usecases/exports.ts:487`; `usecases/__tests__/export-every-pool.test.ts`) — verify only | ST-G24 | brief |
| Recap and digest include pooled standings (`usecases/org-posts.ts:1056,1136,1323` read `pool_id is null`; sequence with W10's ST-G22, R2) | ST-G6 | brief |
| The standings API declares its response (`api-v1/schemas/scoring.ts:298` `StandingsRowOut`); a pool listing endpoint; withdrawn rows named | ST-G23, ST-G28 | brief |
| A second `POST /stages/:id/complete` is a no-op that says so (`engine-db/competition.ts:1162` answers `completed: true` for a complete stage, then `usecases/stages/completion.ts:119-160` progresses again); the harness's repeat-call avoidance removed and the second call is a tested case | CS-1 | R27 |
| Rebuild on every round-robin row re-run (P4); a red is a W3 regression, recorded against W3 | RB-1 | brief trap 2 |
| Re-route ST-G4 / ST-G12 / ST-G13 from W5 to W2d in `tools/matrix/catalogue/gap-routing.json` (`:77,85,86`) and `audit-verdicts.json`, and regenerate the backlog (a tools/matrix data change, so it rides this PR, not the docs push) | ST-G4/12/13 | 288 |
| Quick match `league_ko` (#1216): a regression check that W5's cut, frozen markers, withdrawal, late-entry and Add-match changes leave quick match's two-stage flow as it was (or quick match is out by its own guard) | — | 288 |
| ~~Pool `results` passed to the engine in both `SourceTables` builders~~ — **moved to PR B's bump commit (fix round 2, G4)**: PR A passes nothing new to the engine, so 9.x behaviour is unchanged while PR A is live, and results land together with the always-on engine (§6.5). | ST-G3 (producer half) | 280, 286 |
| Before PR A, not in it (fix round 2, G6): the standalone **W5 rows bump** PR (app plan A Task R) bumps to `^9.1.0` (rows only) with the app half of the rule rows — `AWAITING_PROOF` entries for the 74 tagged W5 ids and the three `AMENDED_TEXT` edits 9.1.0 carries (X-RT-1, BD-WO-2, BD-RT-1; none for X-LE-2, a W4 row) — and merges to main before PR A starts | SEED-R5 | G12 |
| Test and matrix debt (§6.7) | T5-a … T5-g | R25, R13 |

### 6.5 App: after the engine release (PR B, bump)

Revised 2026-11-16: PR B bumps `@seazn/engine` to `npm:@onryde/seazn-engine@^10.0.0` (the major the engine plan's T10
released; 10.0.0 today) in both `apps/web/package.json` and `packages/reference/package.json` (and the lockfile), and
in the same commit passes pool `results` in both `SourceTables` builders (fix round 2, G4). The app already runs ^9.0.0, so the 7.0.0–9.0.0 sport-epoch
majors are behind it; there is no epoch work and no `fold-epoch:check`. Bye and leg moved to PR A (the engine already
ships them); the withdrawal parity shrinks to the footnote note. PR B keeps only `lateEntryFixtures` parity, pool
membership, unequal pools, the cross-pool draw, frozen markers and the adjustment reason.

| Item | Gaps |
|---|---|
| Engine bump; pool membership and the engine pool floor wired (the app gate already ships in PR A via C38); the app's catch-up placement swapped for `lateEntryFixtures` with a parity test; the withdrawal footnote note; every standings reader handles rows with zero played and the "rule applied" footnote (enumerate readers by behaviour, not filename) | ST-G5, PO-1, FX-G1, ST-G15 (note only) |
| Pool `results` passed in both `SourceTables` builders (`usecases/stage-seeding.ts:414`, `usecases/stages/carry-over.ts:251`) in the bump commit (G4); unequal-pool comparison wired, always on (ruling 286), with its basis on the table and the progression panel; `PoolTable.expunged` written in both builders from active expunge rows; stored configs carrying `normaliseUnequalPools` keep parsing | ST-G3 |
| Cross-pool round-one draw wired through `crossPoolDraw(seeded, shape, drawSeed)` with the destination's stored draw seed, which is shown on the destination stage; `tied` computed per the engine contract (§5.3; never `tieUnbroken`), proved by two pools whose same-rank rows are level across pools driven through the real tables | FX-G5 |
| Frozen cut markers ("Qualified" / "Out") on every surface | ST-G17 |
| "Adjust points" desk action (the owner's chosen layout, R24), passed as `TableStageFields.adjustments`; footnote on every surface; Swiss pairing on the adjusted score | C5 |
| Full e2e per row (late entry in each case, a withdrawal on each side of the line, a pool of one refused, unequal pools, a three-pool draw, a frozen cut, a points adjustment, a pair league) | T5-a, T5-c |
| Re-baseline L3 in the same change as each fix lands | T5-d |
| Bench gates (§6.8) | — |

### 6.6 The shared reconcile: the round-robin half (FX-G1; W4 §6.5)

FX-G1 today: Generate after roster growth reconciles by the position key `rr-r{round}-c{court}` and inserts only
missing keys, so pairings are duplicated and others never created, with no warning (engine `scheduling/roundrobin.ts:140`;
app `usecases/stages/generate-tx.ts:446-519`, `byKey` by `ext_key`; engine sim 3 → 4: 2 duplicates and 2 missing; 8 →
9: 6 and 6). #879 part 3's hidden wipe is W3's #840 fix.

**Revised 2026-11-16 — what W4 actually shipped.** A pure planner, `lib/bracket-reconcile.ts:20` `LineIdentity` and
`:79` `planReconcile`, and a knockout-only driver, `usecases/bracket-reconcile.ts:51` `reconcileRootBracket` (called
from `generate-tx.ts` for a root knockout only). `planReconcile` has no structural-change predicate: different key sets
always answer `regenerate`, and `in_place` means bye-seat surgery (`{place, vacate}`). Under a (pair, leg) identity
every roster change alters the key set, so the W4 planner would always regenerate. **W5 therefore builds its own
round-robin pair-key planner** (set difference by (pair, leg, pool): insert missing, drop removed, regenerate in one
transaction only on the structural change below), beside W4's and sharing `LineIdentity` where it fits; W4's driver
and planner are not changed, and the Swiss and knockout L3 rows are re-run anyway. The "W4 ships the driver; W5 adds a
function without touching it" text below is the 2026-11-05 expectation, kept for the record.

**Shape** (W4's seam; the round-robin side is the designer's call):
- **Identity:** a round-robin line's identity is the **unordered pair plus the leg**, scoped by pool, never its round
  or court.
- **Before Start:** Generate adds every missing (pair, leg) and drops a removed entrant's lines. Where the field's
  parity changes, the round structure is regenerated in one transaction with times and courts carried by pair (ruling
  253). Nothing is inserted twice; a second Generate with no roster change is a no-op that says so.
- **After Start:** Generate never reshapes. §4.1's cases are the only way in, and they reuse the same identity: a
  catch-up fixture is a new (pair, leg) with the placement policy of §4.1.
- **The seam takes three per-format parts:** an identity function, a placement policy for new lines, and a
  **structural-change predicate** that says when the structure regenerates in one transaction (knockout: crossing a
  power of two; round robin: the field's parity changes, or a pool's membership changes before Start). W4's plans had
  not started on 2026-11-05, so this is recorded now as W5's requirement on the seam, for W4's decision-log note
  (brief "Output and handoff").
- **W4 ships the driver and the knockout function. W5 adds the round-robin function without touching the driver.** If
  the merged driver lacks the predicate, W5's first task adds it with W4's reviewer, records why (brief trap 1), and
  re-runs the Swiss and knockout L3 rows before anything else.

**R27 four questions:** second call → a no-op that says so; empty input → a named refusal (RB5-E1); after a withdrawal or
void → the pair's lines are voided or walked over under §4.2, never regenerated; another sport → the R26 sweep.

### 6.7 Matrix and test debt (T5; labels are this doc's)

| Label | Debt | What W5 does |
|---|---|---|
| T5-a | No round-robin row fields **pairs** or **teams** beyond the sport's default kind | The counted usecase sweep (T5-e) covers individual, pair and team; PR B adds one badminton doubles league walkthrough. No kind axis (designer's call, as W4). |
| T5-b | **13 routed ids with no scenario** (FX-G5, FX-G15, FX-G19, ST-G3, ST-G6, ST-G14, ST-G15, ST-G17, ST-G20, ST-G23, ST-G24, ST-G28, and ST-G5's refusal form) | Each gets an atomic case: F4 (unequal pools), R4c (finalized under the line), R2 (late entry after Start) in each case, Q2/R6 (departed qualifier), P7 (rank override per pool), C5 (adjust points), C6a (correction in a completed table source), F1 pool-of-one ⛔, plus the surface assertions (export every pool, digest pooled, hub chip, API shape) under "surfaces asserted after every scenario". |
| T5-c | L2: the 33 🚫 cells on `group_only` and `group_group_ko` (NEW-W1d-5) | `group_only` gets a picker path and is driven. `group_group_ko` is driven through the generalized gallery template (`createFromTemplateUi`, the path the W3-final run's one working L1 case already used). No cell is dropped (OWNER S1). |
| T5-d | `baseline.json` holds the 11 `group_group_ko` F1 reds | Re-baseline in the change that turns them ⛔. |
| T5-e | No counted per-format × entrant kind × case usecase sweep for round-robin late entry | `roundrobin-late-entry-matrix.test.ts`, modeled on W3's `swiss-late-entry-matrix.test.ts` and W4's T8-e: every entry-stage template, every kind (sport from `sportFor`), every case (`catch_up`, `rebuild_offered`, `refused`, and the two automatic cases: `waiting`, then the tap's `catch_up`), a fed-tail block asserting the refusal for a bracket fed from a table, and a last `it` asserting `checked.size` equals the product exactly. Expected values from the rulebook and the rows before the add, never from the code under test. Revised 2026-11-16 (ruling 287): `triple_rr` is deleted, so the entry templates are five, not six, and the sweep is 5 × 3 kinds × 5 cases = **75** cells (90 once `group_only` joins), not 90/105. Quick match is not a sweep cell: its regression check is its own app PR A task (REC-10, ruling 288). |
| T5-f | `triple_rr` has no proof that three legs are built; `group_group_ko` has no e2e | Ruling 287: `triple_rr` is deleted, so the debt closes with the deletion (X-RR-6: a legs:3 league reads back as `league`, legs 3); the engine's generation proofs still cover legs 1..3 (`legs` is generic). All four test types for `group_group_ko`. |
| T5-g | Applicability drops on the eight rows (`tools/matrix/lib/applicability.ts`) may be stale after W2–W4 | Verify each drop's reason; lift stale drops. |

### 6.8 Reusable W3 and W4 mechanisms, and the bench gates

Revised 2026-11-16; app pins at 97b184e2d9, engine pins at 2cd842a.

**As is:** Rebuild in one transaction (253; `usecases/stages/generate.ts:280` `rebuildStageFixtures`,
`stages/generate-tx.ts:792` `regenerateStageInTx`); `systemByeSql` (`engine-db/system-bye-sql.ts`);
`UNDO_BARRIER_TYPES` (`usecases/history.ts:111`); `open-entry-stages` and its drift test; the stored draw seed
(`lib/swiss-draw.ts:33` `swissDrawSeed`; engine `core/rng.ts:8` `mulberry32`); the desk flag and tap (271); W2d's
cross-pool cascade and stored lots; **already shipped and only verified:** the cut backfill on both halves
(`CUT_SKIPS_DEPARTED_KINDS`, `lib/table-withdrawal.ts:61`, includes league and group since W4 T13), export of every
pool, the duplicate-entrant refusal (`PERSON_ON_OTHER_TEAM`), the engine's leg and bye (`roundrobin.ts:42,48-53`),
per-pool rank locks (`competition/stage.ts:376-378`), opening deltas (`stage.ts:344-348`), the total expunge of every
handed fixture (`stage.ts:957-960`) and `crossPoolSeedOrder` (`scheduling/bracket.ts:257`).

**Adapt:** C38's pool refusal (`usecases/stages/generate-tx.ts:423-445`) → the named workable count and the builder
gate; `knockout-cut-drift.ts` (closer than `swiss-cut-drift`) → table sources (S5); `LateEntryResult` → round-robin
cases; `admitSwissLateEntrant` (`usecases/swiss-late-entry.ts:262`) and `admitKnockoutLateEntrant`
(`usecases/knockout-late-entry.ts:322`) → a round-robin admitter at `registrations/materialise.ts:231`; W3's `X-RB-1`
league Rebuild → case (2); `normalisedRow` → k = size − min (286); `crossPoolSeedOrder` → the round-one rotation.

**Not reused (2026-11-16):** W4's reconcile planner and driver (§6.6 — a round-robin planner of its own).

**Bench gates (design §9): Candidates (double round robin), Euro 2024 / Women's Euro 2025, T20 World Cup, Paris
volleyball and hockey, IIHF 2025, carrom B07b.** A listing of `tools/bench/packs/` in this tree (2026-11-06) holds
only `_tiny.json`, `suite11.json` and `build-packs/`: no pack for any of the six. Each is recorded ⏳ deferred, not
blocking, and runs when its suite lands. The builder re-checks at the gate (the catalog's `euro24` and `t20-super8`
templates are templates, not packs).

## 7. Live divisions

- **One live tournament, Swiss → knockout, finished** (owner, 2026-11-05). No live league or group table exists. The
  2026-09-27 census's one league division (3 fixtures) was the owner's test.
- **No W5 rule re-ranks anything live.** Q2, Q3, Q5 and Q9 touch no live table; Q4 and Q6 touch no live draw.
- **Q8 is visible on the live tournament:** its finished Swiss table gains frozen "Qualified" / "Out" markers if that
  stage had a cut (designer's call 14; §8 S3). Derived on read; no migration.
- **Pre-flight (controller, read-only):** count league and group divisions on stg (standing OK) and prod (owner's OK)
  at plan start. Zero means "say so in the PR body"; more than zero means the owner decides per table.

## 8. Owner sign-off (the rulebook)

Q1–Q9 are owner rulings **276–284 (provisional)**, 2026-11-05, each the owner accepting the designer's recommendation.
The rulebook rows that restate them read OWNER 276–284. Every other row reads **REC** until the owner approves this doc;
the builder check may add amendments first, as W4's did (271–273).

These questions change what gets built and go to the owner together with the builder check's questions:

- **S1 — `group_only` and `group_group_ko` organizer paths (NEW-W1d-5). SIGNED 2026-11-06 (owner, per rec):**
  `group_only` joins the format picker (it is groups without a second stage). `group_group_ko` stays a gallery
  template: the "T20 Super 8" template (cricket, 16 teams) is generalized to any sport and any field that divides
  cleanly, so every cell is driven through a real organizer path and none is dropped. No format-picker control for
  two-tier groups.
- **S2 — Swiss under "Adjust points". SIGNED 2026-11-06 (owner, per rec):** the adjusted score drives the next
  pairing (score groups are the table).
- **S3 — Q8 on the live tournament's finished Swiss table. SIGNED 2026-11-06 (owner, per rec):** frozen markers
  appear there too, derived on read; no freeze date. The builder verifies on staging first and screenshots the public
  page before and after.
- **S4 — O6 per-cell rulings (brief). SIGNED 2026-11-06 (owner, per rec):** boardgame cells on `league_ko`,
  `groups_ko`, `group_stepladder`, `group_playoffs` and generic `group_playoffs` are recorded as **works**, citing the
  W3-final L3 run (✅ on F1, LIFECYCLE, M1 and R4 for every one) and W2a's SC-O1 closure as the root cause; W5's own
  truth run re-confirms before the row is signed. F1 (odd field) on every round-robin row works by bye, never unfit.
- **S5 — correction or departure inside a completed league or group source (FX-G16, table half). SIGNED 2026-11-06
  (owner, per rec):** RB3-19 by analogy, as W4 S3: before the destination starts, re-propose and re-confirm (a
  confirmed proposal goes stale too); after, the bracket stands and the desk warns. Built by adapting W3's
  `swiss-cut-drift`.
- **S6 — the late-entry window. SIGNED 2026-11-06 (owner, per rec):** offered until the table stage completes (§4.1
  case 3), including after the last drawn round has started; the refusal after Complete points to the next stage.
- **S7 — the minimum pool size. SIGNED 2026-11-06 (owner, per rec):** the floor stays 2; the rulebook records 3 as the
  federation norm for a mini-league and 2 as the product floor (a visible deviation).

No plan task starts on an unsigned row: S1–S7 are signed before the plan is written, and every remaining REC row is
signed at design approval, as W4's were by ruling 274.

Once signed, each becomes a numbered ruling. Its rule row lands in the engine PR or the app PR that implements it, never
ahead of it.

## 9. Gap status (2026-11-05, revised 2026-11-16)

Read, not driven, except where the W3-final L3 run (41818942253) or the W1d and W3 reports say so. The 2026-11-16 recon
re-read every row against 97b184e2d9 / 2cd842a; its pins are in §6.3–§6.5 and its corrections in §13. **LIKELY = prove
by a driving test first**; a non-reproduction goes to "False premises found (W5)". **DONE = already on main; W5 pins it
with a driving test and fixes only on red.**

| id | theme | verdict (2026-11-16) | piece | note |
|---|---|---|---|---|
| FX-G1 / #879 | T1 roster | OPEN (positional `byKey`, `stages/generate-tx.ts:446-519`; issue open) | Engine PR (`roundRobinLineKey`, `lateEntryFixtures`) + App A (own RR planner) | §6.6 |
| #837 | T1 league delete before Start half-fills | OPEN (issue; pinned by `swiss-delete-entrant.test.ts:378`) | App A (reconcile task) | REC-5 |
| LE-3 | T1 late entry absent for league and groups | OPEN | App A | Q1 |
| LE-4 | T1 automatic arrivals bypass the Start lock for every format | LIKELY (by read: `registrations/materialise.ts:231-232` admits Swiss then knockout only) — drive first | App A | ruling 271 reused |
| FX-G15 | T1 Add match round | OPEN (`stages/ad-hoc.ts:299`) | App A | designer's call; REC-10 |
| R11 | T1 duplicate entrant | DONE (`PERSON_ON_OTHER_TEAM`, `entrants.ts:195`) | App A pin | refused at add |
| R12 | T1 pair partner leaves | UNVERIFIED — prove by a driving test first | App A | Q7 |
| Ruling 111 | T2 self-withdrawal after Start: no phase check, no cascade | OPEN (`registrations/withdraw.ts:113`) | App A | REC-4 |
| ST-G15 | T2 half-expunge | OPEN, app-only (`withdrawal.ts:225-233`); engine already voids every handed fixture | App A (+ engine proofs) | Q2 |
| X-RT-1 | T2 in-match DQ cascade "is W5" | OPEN (row text) | App A + B0 row re-word | REC-7 |
| BD-WO-2 / BD-RT-1 / tennis RB2A-3 | T2 sport rows say "until W5" | OPEN (row text, engine `rules/badminton.md:6-7`) | B0 / engine PR rows | REC-8 |
| CUT-1 | T2 departed qualifier keeps a dead seat; public names them | DONE by W4 T13 (`lib/table-withdrawal.ts:61`, `stage-seeding.ts:96`, `carry-over.ts:282`) | verify only | Q3 |
| CUT-2 | T2 best-Nth after a departure | DONE by W4 T13 (`stage-seeding.ts:137`, `carry-over.ts:354`, `seed-proposal.ts:146`) | verify only | Q3 |
| ST-G5 | T3 pool membership | RED (`group_group_ko` F1 ×11); engine `stage.ts:286-311` | Engine PR + App B | Q4 |
| PO-1 | T3 pool of one | PARTIAL: C38 refuses the first draw (`stages/generate-tx.ts:423-445`); no named count, builder disagrees, baseline still expects the 409 | App A (extend C38, builder gate) + Engine PR (floor) | Q4; cells → ⛔ |
| FX-G22 | T3 single pool id null | OPEN (`stages/generators.ts:442`, `generate-tx.ts:301`) | App A | — |
| FX-G19 | T3 board pool letter | OPEN (`components/v2/board/types.ts:30`) | App A | — |
| FX-G21 / #850 | T3 bye not recorded (#850 is the same defect) | OPEN, app-only: engine emits `rounds[].bye`, `stages/generators.ts:391` drops it | App A | — |
| ST-G14 | T3 rank override per pool | OPEN, app write check only (`completion.ts:432`); engine scopes locks per pool | App A (+ optional engine `validateRankLocks`) | — |
| P7 | T3 rank override on a non-table stage | OPEN (`completion.ts:413`) | App A | REC-6 |
| ST-G3 | T3 unequal-pool normalization | OPEN (k = 1 behind a flag, `progression.ts:652-670`) | Engine PR + App B | Q5, 286 |
| FX-G5 | T4 same-pool round one | OPEN (engine sim) | Engine PR (`crossPoolDraw` beside `crossPoolSeedOrder`) + App B | Q6 |
| Seeding ties (harness notes, `_INDEX.md:4594-4601`) | T4 listed order picked by the harness | OPEN → X-PD-8 for best-Nth basis ties only (fix round 2, G1; note below) | App A (constructed enumeration over the best-Nth rows; harness notes re-judged by row in the matrix task) | 288 |
| FX-G16 (table half) | T4 stale proposal after a correction in a league or group source | OPEN, real work (`scoring.ts:1180-1197`: confirmed proposals stale only for a knockout source) | App A | §8 S5 |
| D4 | T4 club separation in pools | ⏳ deferred (ruling 272) | clubs follow-up | — |
| ST-G17 | T5 markers vanish at completion | OPEN (`qualification.ts:95`) | Engine PR + App B | Q8 |
| C5 | T5 points deduction | ABSENT (🚫); fold mechanism exists (`openingDeltas`) | Engine PR (`adjustments`, reason, zero refusal) + App B | Q9 |
| ST-G20 | T5 hub chip | OPEN (`standings-view.ts:568`) | App A | — |
| ST-G24 | T5 export one pool | DONE (06537ffea9; `export-every-pool.test.ts`) | verify only | — |
| ST-G6 | T5 digest skips pooled | OPEN (`org-posts.ts:1056,1136,1323`) | App A (sequence with W10) | — |
| ST-G23 / ST-G28 | T5 API shape; pool list | OPEN (`api-v1/schemas/scoring.ts:298`) | App A | — |
| TR-1 | T6 `triple_rr` built as a single round robin | CONFIRMED then RETIRED (owner 2026-11-01; `lib/format-templates.ts:254-262`); a legs:3 league builds three legs (`stages/generators.ts:438-440`); `triple_rr` is detected (`:404`), never stored | App A (delete the template and its detection branch, X-RR-6; no migration) | 287 |
| CS-1 | T6 repeat Complete re-progresses | PRESENT by read (`engine-db/competition.ts:1162`, `stages/completion.ts:119-160`) — drive first | App A | R27 |
| RB-1 | T6 Rebuild on round-robin rows | LIKELY fixed (W3 #840, FX-G13) | verify only | a red is W3's |
| ST-G4 / ST-G12 / ST-G13 | T6 still routed to W5 in `gap-routing.json:77,85,86` | OPEN (catalogue drift; W2d built them, ruling 183) | App A (data re-route) | REC-9 |
| Quick match `league_ko` (#1216) | T6 a new producer since the design | OPEN (regression check owed) | App A | REC-10 |
| Box league champion | T6 public page crowns one champion over parallel boxes | OPEN, owner question | OUT of W5 | REC-3 |
| NEW-W1d-5 | T6 no format-picker control for `group_only` / `group_group_ko`; the gallery's "T20 Super 8" is the only organizer path for two-tier groups, cricket-only | RED (🚫 ×33) | App A (`group_only` picker control; the template generalized) | OWNER S1 |
| SEED-R5 | T7 no rule rows | ABSENT (both `AWAITING_PROOF` maps hold W4 rows only) | B0 + Engine PR + close-out | §12 |
| T5-a … T5-g | T7 test + matrix debt | — | App A (+ App B e2e) | §6.7 |

- **40 table rows** (32 on 2026-11-05; #850 folded into FX-G21; +9 leftovers: #837, ruling 111, X-RT-1, the sport
  rows, P7, seeding ties, ST-G4/12/13, quick match, box league): OPEN 24, DONE 4 (R11, CUT-1, CUT-2, ST-G24), PARTIAL 1
  (PO-1), RED 2, LIKELY 2, PRESENT 1, ABSENT 2, UNVERIFIED 1, CONFIRMED-then-RETIRED 1 (TR-1), ⏳ deferred 1 (D4), and
  the T5 debt row.
- **Seeding ties the harness picked (fix round 2, G1).** `_INDEX.md:4594-4601` counts 21 W5 notes by row
  (`group_group_ko` 9, `groups_ko` 3, `league_ko` 3, `group_playoffs` 3, `group_stepladder` 3) and names no cases. The
  note (`seeding_tie_picked`) records a confirm refused on a flagged tie, a `ProgressionTieFlag` raised from a row's
  `tieUnbroken` (engine `progression.ts:871-884`) — mostly table ties, not best-Nth basis ties. So there is no "21"
  count. X-PD-8 (ruling 291: the sport's declared cross-group cascade breaks a best-Nth BASIS tie) is proved by a constructed enumeration over
  every template row that has a best-Nth take, derived from `STAGE_TEMPLATES`, count > 0. App PR A's matrix task
  re-judges the harness notes by row: notes on rows with no best-Nth (`league_ko` `lib/format-templates.ts:80`,
  `group_stepladder` `:168`, `group_playoffs` `:179`; pinned 2026-11-16 @97b184e2d9) are **confirm-time table ties under the existing
  tie-break ladder** (the organiser picks at confirm, as today) — no new rule; notes on `groups_ko` / `group_group_ko`
  are classed per case as a basis tie (X-PD-8) or a table tie.
- **GitHub hygiene at close-out:** #840 is fixed by W3 but still open — close it with W3's commit; close #879 and #850
  with App A. #1202 (groups_ko auto-schedule places 3 of 6 group matches) is a scheduling defect, not W5's, unless a
  pool-bye round structure turns out to cause it.

**False or stale premises found so far** (go to `_INDEX.md` "False premises found (W5)" when the plan starts):
- The brief's seven rows: `group_group_ko` is W5's by the §8 clause (NEW-W1d-5).
- The brief lists ST-G4, ST-G12 and ST-G13 under W5; W2d built them (ruling 183). A red on them is W2d's.
- The brief's rulebook row P4 says "W5 owns the fix" for Rebuild; W3 fixed #840 and FX-G13.
- FX-G17 (unseeded order by `created_at`) is routed to W4 and fixed there for knockout (K5); its league and pool-snake
  half is **not** in W4's register. W5 verifies whether league and pool seeding still read registration order and, if
  so, applies the stored draw seed (designer's call 21).
- W4's design §6.5 states the round-robin identity as "the unordered pair plus the leg"; this doc keeps that shape and
  adds the pool scope.
- (2026-11-16) Further false or stale premises of this doc itself are listed with evidence in §13: the engine version,
  the `stages.ts` pins, the migration numbers, the W4 reconcile seam, CUT-1/CUT-2/ST-G24/R11 already done, leg and bye
  and `crossPoolSeedOrder` and `openingDeltas` already in the engine, ST-G15's engine half, `module.ts:830`, the
  catch-up counts, `QualStatus`'s shape, `applyPointsRule` and the points metric, and TR-1.

## 10. Calls made by the designer (check these)

**Accepted by the owner with the recommendation** (part of rulings 276–284; listed for visibility):
- A. Catch-up fixtures go to a future bye slot first, else an appended catch-up round, one fixture each; finished
  rounds never change (Q1).
- B. Groups: the pool picker defaults to the smallest pool; automatic arrivals wait with a desk flag (Q1).
- C. The expunge is total, finalized included, and unplayed fixtures under the line are voided, not walked over (Q2).
- D. The minimum pool size is 2 (Q4).
- E. Results against the bottom k entrants are dropped, k = size difference (Q5).
- F. Separation is round one only; rank ties draw with the stored seed; impossible separation refuses (Q6). (Fix
  round 1: this governs over REC-2; the engine's draw takes the seed.)
- G. The remaining partner may re-enter in a new pair under Q1 (Q7).
- H. Frozen markers read "Qualified" / "Out" (Q8).
- I. "Adjust points" requires a reason, is undoable, and is hidden on brackets (Q9).

**New in this doc:**
1. Late entry is offered until the stage completes; the refusal names the next stage (§4.1 case 3; §8 S6).
2. Which future round takes a bye-holder fixture: the round where that opponent holds the bye (§4.1).
3. Catch-up round order follows the rounds the opponents already played; every leg owes its fixture (§4.1).
4. The newcomer's row is marked "Joined round N"; no leveled record (§4.1).
5. "Add late player" has no Undo; barrier `roundrobin_late_entry`; one notice per case (§4.1).
6. The "half" test counts scheduled fixtures at the moment of withdrawal; a disqualification uses the same rule; the
   footnote names the rule applied (§4.2).
7. Reinstate reverses the expunge or the walkovers (§4.2).
8. "Eligible" for the cut excludes withdrawn and disqualified; after the knockout's first match has started, RB4-V3
   applies (§4.3).
9. A duplicate entrant is refused at add; R12a is refused with a named reason and routed ⏳ to the lineup work (§4.4).
10. The pool-size refusal names a pool count that works; a single pool writes its id; board cards carry the pool
    letter; who sits out is shown; a bye never holds a court (§5.1).
11. Rank override is scoped per pool and validated at write (§5.1).
12. The bottom entrant is the pool cascade's last, lots included; equal pools drop nothing, and the sweep must see an
    unequal case (§5.2).
13. The round-one rotation is deterministic; Rebuild reproduces the draw; a stepladder or page playoff fed from groups
    takes the same rotation (§5.3).
14. Q8 applies to every table stage with a cut, Swiss included, and to the live tournament's finished table (§6.1; §8
    S3).
15. "Adjust points" is a ledger row read as an opening delta, not stage config; it adjusts the sport's `points`
    metric and refuses where a table has none (that clause is under REC-11); Swiss pairs on the adjusted score (§6.2;
    §8 S2).
16. FX-G16's table half: RB3-19 by analogy (§8 S5).
17. (Superseded by OWNER S1: `group_only` in the picker; `group_group_ko` as a sport-agnostic gallery template.)
18. The reconcile's round-robin identity is (unordered pair, leg), scoped by pool; placement is call 2 (§6.6).
19. `triple_rr`: a single-round-robin build is a defect fixed to three legs, not a decision (§6.4). *(2026-11-16: the
    template was retired from the offer by the owner on 2026-11-01, before this call was made; REC-1 below proposes
    dropping the builder fix. Superseded by ruling 287: `triple_rr` is deleted.)*
20. A second Complete is a no-op that says so; the harness's avoidance goes (§6.4).
21. League and pool seeding of unseeded entrants: verify FX-G17's round-robin half; if registration order survives,
    apply the stored draw seed (§9).
22. The matrix gains no entrant-kind axis; pairs and teams are covered by the usecase sweep and one walkthrough (§6.7).
23. Rule-row prefixes (final, fix round 1): X-RR (round robin), X-CU (late entry and catch-up), X-PO (pools), X-WDT
    (withdrawal from a table), X-UP (unequal pools), X-PD (pool draw), X-QS (qualification status), X-ADJ (points
    adjustment), X-CUT (cut), X-RP (roster), X-BD (builder), X-SF (surfaces); no tennis row (ruling 290). Late-entry rows
    are X-CU, never `X-LE-15+`. The canonical id table is the engine plan's Task 0. Never `-KO-`.

**Added after the builder check (2026-11-06):**
24. The late-entry cases are tried in order: complete → refuse; nothing started → Rebuild offered with catch-up as the
    alternative; otherwise catch-up (§4.1).
25. Before Start, Generate on a group stage re-snakes every pool in one transaction; the pool picker exists only after
    Start; Rebuild under case (2) re-snakes and says so (§4.1).
26. Two late entrants in one pool owe each other a fixture, placed by the same policy (§4.1).
27. The enroll door runs the cases directly; a Reinstate of an entrant whose lines still exist restores them under
    §4.2 and never waits; only a Reinstate with no lines is an automatic arrival (§4.1, §4.2).
28. k per candidate is measured against the smallest effective pool among the pools that supply a candidate, after
    expunges (§5.2).
29. The round-one rotation swaps within rank tiers, deterministic, and refuses only when no tier ordering separates
    every pair; the reference checks legality and existence (§5.3).
30. Frozen markers read who actually went through (confirmed proposal or `config.qualified`, else the final cut) and
    update on read after a settled tie, a correction or a backfill (§6.1).
31. The reconcile seam takes a structural-change predicate as its third per-format part, recorded as a requirement on
    W4's seam before W4 builds it (§6.6). *(2026-11-16: W4 shipped without it; the predicate lives in W5's own
    round-robin planner, §6.6.)*

**Owner ruling 2026-11-16:**
- **Ruling 286 (R-UP):** unequal-pool normalisation is always on; `normaliseUnequalPools` is accepted and ignored
  (deprecated, kept for stored configs); the `SEEDING_BESTNTH_UNEQUAL_POOLS` refusal goes for this case (§5.2). Owner:
  "apply your rec unequal pool". Recorded in `_INDEX-w5-additions.md`; re-check the number against `origin/main` at
  commit time.

**Owner rulings 2026-11-16 on these recommendations (recorded in `_INDEX-w5-additions.md`):** **287** `triple_rr` is
deleted (owner: "in prod, no triple_rr, so blindly cleanup, delete it"; supersedes REC-1; the coordinator's reading of
its scope — engine `legs` generic, the deletion the app's, `legs` 1–8 kept as 285 / RB5-G1 — is a designer's call, not
the owner's text); **288** confirms REC-2..REC-6, REC-9..REC-12 and the rows-only 9.1.0 release, and approves the storage calls provided the plan names who
writes, reads and cleans each field (rebuild, withdrawal, undo, delete) and tests the cleanup; **289** confirms REC-7
with a condition — the Disqualify action (pad and organiser) first shows plain copy naming the consequence (fixtures
withdrawn, results kept or expunged with this entrant's count, undoable or not), in 4 locales, its numbers taken from
the same decision the cascade applies; **290** confirms REC-8 option A — badminton and tennis follow ruling 277,
BD-WO-2 / BD-RT-1 become a permanent recorded deviation from BWF GCR 16.2.5, no tennis row, no sport-specific
withdrawal code. Nothing below is gated any more; the text is kept as the record of what was proposed.

**Recommendations of 2026-11-16 (as proposed; answered by rulings 287–290 above).** These are the designer's recommendations from the
recon. They are **not** owner rulings, they are not signed by 285 or 286, and no plan task treats them as signed until
the owner says so.
- **REC-1** (proposed 2026-11-16) `triple_rr` stays retired from the builder (owner 2026-11-01); a stored
  legs:3 league keeps playing as an API-only shape. Drop TR-1's "fix the builder to three legs" (call 19) and the app
  plan's TR-1 task; generation proofs cover legs 1..3 because the engine takes `legs` anyway; the late-entry sweep is 75
  cells (90 once `group_only` joins in app PR A), not 90/105. Answers `_INDEX.md`'s W5-row question "keep it API-only, or retire it from the catalogue" with "keep
  API-only".
- **REC-2** (proposed 2026-11-16; narrowed in fix round 1; *re-worded by ruling 291: the sport's declared cross-group cascade breaks the tie, superseding "listed (seed) order"*) The listed (seed) order applies only where
  ruling 281 does not decide: a seeding tie that survives the cascade into a best-Nth basis comparison is settled by the
  product's listed (seed) order, ending in W2d's stored lots. Inside the cross-pool draw, ruling 281's stored draw seed
  decides. A ⬜ rule row (X-PD-8) records it, and a counted test covers the 21 cases the harness picked in listed order
  (§5.3). *(Fix round 2, G1: no "21" count; a constructed enumeration over the best-Nth rows proves it, §9.)*
- **REC-3** (proposed 2026-11-16) A box league's public page crowning one champion over parallel boxes is
  **out of W5** and recorded as an open owner question in `_INDEX-w5-additions.md` (W4 added `championIds`,
  `public-site/standings-view.ts:589`; `group_only` is not addressed). Not built.
- **REC-4** (proposed 2026-11-16) Ruling 111's self-withdrawal after Start is IN app PR A: route
  `withdrawCore` (`registrations/withdraw.ts:113`; callers `registrations/public-status.ts:136,287`) through the same
  table-withdrawal usecase (phase check + cascade), one door (§4.2). The owner still pins what "started" means
  (X-LE-9's predicate is the obvious reuse).
- **REC-5** (proposed 2026-11-16) #837 (league half-fill after a pre-Start delete) is IN app PR A, owned by
  the reconcile/late-entry task; the pin at `usecases/__tests__/swiss-delete-entrant.test.ts:378`, which freezes the
  bug, is moved to assert the fix (§4.5).
- **REC-6** (proposed 2026-11-16) P7: a rank override on a non-table stage (`stages/completion.ts:413`) is
  IN app PR A — refused by name, and the public `has_rank_overrides` flag stops firing on it (§5.1).
- **REC-7** (proposed 2026-11-16) In-match DQ cascade is IN: engine row X-RT-1's "the cascade is W5" is
  re-worded in B0, and app PR A applies the ruling-277 withdrawal path to a DQ'd entrant's remaining fixtures (§4.2).
- **REC-8** (proposed 2026-11-16) Badminton BD-WO-2 / BD-RT-1 ("until W5") and tennis's RB2A-3 consequence
  are re-worded under ruling 277 in the B0 rows; tennis gets a deviation row if it keeps a different rule (§4.2).
- **REC-9** (proposed 2026-11-16) ST-G4 / ST-G12 / ST-G13, still routed to W5 in
  `tools/matrix/catalogue/gap-routing.json:77,85,86` and `audit-verdicts.json` though W2d built them, are re-routed to
  W2d. It is a tools/matrix data change, so it rides app PR A, not the docs push.
- **REC-10** (proposed 2026-11-16) Quick match `league_ko` (#1216) is a new producer: app PR A carries a
  regression check that W5's cut, late-entry, withdrawal and Add-match changes leave quick match's behaviour unchanged,
  or quick match is explicitly out of scope by its own guard.
- **REC-11** (proposed 2026-11-16 in fix round 1) Drop RB5-T15's second clause ("a table with no points
  metric refuses the action"): every table folds `points`, so nothing can trigger it. Ruling 284's text says "refuses
  where a table has none"; until confirmed it is a recorded finding, and no code or test enforces it (§6.2).
- **REC-12** (proposed 2026-11-16 in fix round 1) Two pools, the winners plus the best runner-up into a
  4-draw or a 3-stepladder (A1, B1, B2): keep it refused, because RB5-D10 fixes tier 1 and B1 v B2 is then forced. The
  alternative is to let pool winners swap positions for this case (§5.3).

**Designer's calls 2026-11-16 (fix round 1; process and consistency, not owner rulings — check these).**
- The rule rows ship as a rows-only engine **9.1.0** before app PR A (the W4 precedent, #1146; confirmed by ruling
  288); no app `AWAITING_PROOF` entry is deleted before the release that carries its proof (§3). Fix round 2 (G6): the
  app takes them in a standalone "W5 rows bump" PR merged before PR A, not inside PR A.
- One canonical rule-id table, the engine plan's Task 0; app plans A and B use its ids verbatim. Every REC-dependent
  row was ⬜ and every REC-dependent task gated until the owner answered; rulings 287–290 answered all of them.
- The engine names win (F7): `crossPoolDraw` beside `crossPoolSeedOrder`, a separate `adjustments` field (not
  `openingDeltas`); app PR B lists the engine's exact signatures.
- An empty late entry is refused by name (`nothing_to_add`), never a no-op (F8).
- Seating refuses only a result that names an unseated entrant; a waiting late arrival is not refused and is not listed
  until seated (F9).
- Catch-up: fixtures whose opponents share an earliest round follow the members' listed (seed) order (F5).
- App plan A's calls: byes stored in `stages.config.round_byes` (jsonb, no migration); a second waiting column
  `table_waiting_stage_id` beside W4's `knockout_waiting_stage_id`; the in-match DQ cascade fires automatically from the
  pad (best-effort hook; ruling 289, with the consequence copy first); the self-withdraw cascade runs as `systemAuth()` and the ledger names the
  player as the actor (ruling 288). Approved by ruling 288 on the condition that the plan names each field's writer,
  reader and cleanup and tests the cleanup.
- Engine plan's calls: the catch-up home side (the newcomer alternates per leg, first away; a pair's side flips between
  legs); an adjustment counts toward `countedFixtures` like a carried opening with points (a −3 team ranks last on an
  empty table); `matchesCounted` = the largest `played` among the refolded candidates.

**Designer's calls 2026-11-16 (fix round 2; check these).**
- Ruling 287's scope list (template row and detection branch, picker, matrix row, i18n, help, tests; engine `legs`
  generic; `legs` 1–8 kept per 285 / RB5-G1) is the coordinator's reading of the owner's "delete it", not the owner's
  words. `triple_rr` is never stored, so no migration.
- `PooledSeed.tied` (§5.3): equal on the cross-pool comparison; best-Nth ties from the engine's `basis.levelWith`, same-rank
  tiers ranked by PR B with `crossGroupOrder`; unequal `played` never level; only adjacent seeds in a tier link; a link
  on a tier's first seed is refused.
- Pool `results` move from PR A to PR B's bump commit (no 9.x window).
- The W5 rows bump is its own PR merged before PR A; W5's code release is the next engine major at release time.
- Harness seeding-tie notes on rows without best-Nth are confirm-time table ties under the existing ladder (§9).

## 11. Left to the builder

Revised 2026-11-16: the release level, #850 and the recon are no longer open (struck below with what settled them).

- Refusal codes, i18n keys and copy for every new message (4 locales, `pnpm i18n:gen-keys`).
- The engine API shape for `roundRobinLineKey`, `lateEntryFixtures`, the pool floor, the unequal-pool basis (on the
  resolved entry, not the label), the cross-pool rotation's tie order and refusal, the frozen-marker order input and
  the adjustment reason — extending the existing carriers (`RoundRobinSchedule`, `PoolTable`, `QualStatus`) rather
  than parallel shapes. *Settled in fix round 1: the engine plan's "Interfaces — exact signatures" block is final:
  `crossPoolDraw` sits beside the unchanged `crossPoolSeedOrder`, and adjustments are a separate
  `TableStageFields.adjustments` field (`openingDeltas` unchanged).*
- ~~Whether the engine release is a minor or a major~~ — settled: a major, **the next one at release time** (10.0.0
  today; public type changes; 5.0.0 precedent).
  FOLD_EPOCH: the engine plan still runs the epoch report; the app owes no epoch work for 7.0.0–9.0.0.
- The reader list for standings rows with zero played and for the footnotes (by behaviour, §6.5).
- The R24 options page for every new control (pool picker, catch-up round label, "Joined round N", "Adjust points",
  the frozen markers, the late-entry notices and the waiting flag).
- Re-pinning at worktree creation (R5): this doc's pins are 2026-11-16's, and parallel sessions keep moving lines.
  ~~The first W5 recon~~ — ran 2026-11-16 (read-only; §13).
- ~~Reading #850 and routing it~~ — read: #850 is FX-G21; it closes with FX-G21's fix in app PR A.
- Whether the round-robin waiting marker generalises W4's `entrants.knockout_waiting_stage_id` or adds a second column
  (V525+ either way), and the module each new usecase lands in under `usecases/stages/`.
- The stryker home for each new engine file (`stryker.groups.mjs` `draws-*`), and the free area code for the builder
  rule rows (`X-BL` is taken).
- Task breakdown, batching and PR count within the order in §3, in the plan (`superpowers:writing-plans`).

## 12. Every rule gets a rule row

Every signed W5 rule becomes a row in the engine repo's `rules/cross-sport.md` (and a sport file where a sport-specific
consequence exists, for example walkover scores under §4.2). The README grammar applies: id, rule, citation, `signed N
date` / `deviation N date`, code and tests, and the id appears in a test title.

A row lands with the code that makes it true, never ahead of it. As in W3 and W4, app-side rows ship in the engine PR
after app PR A has merged, so the release carries every W5 row and PR B's bump runs the app rules checker against them.

**Ruling 285 (owner: "approve and record all rules") follows 274's pattern:** the engine rows are recorded ahead of the
code, each marked not yet implemented and naming the PR that will enforce it, so no row claims behaviour the engine
lacks. The engine checkout is not in the tree this doc was written in, so that recording is the first task of the
engine plan.

**Revised 2026-11-16 (fix round 1).** Two `AWAITING_PROOF` maps exist: the engine's `test/rules-reference.ts` and
seazn.club's own `scripts/lib/rules-reference.ts:41`, which reads rows from the installed engine package. Both hold W4
rows only today. The sequence: the engine rows PR (B0) adds 74 engine entries; engine 9.1.0 ships the rows; the
standalone W5 rows bump PR's bump to `^9.1.0` adds the same 74 app entries (fix round 2, G6); app PR B's bump to the
major (10.0.0 today) deletes the 71 the release proves; the close-out bump deletes the last 3. No map loses an entry before the release carrying its proof. `X-BL-1` is taken
(W2b-R13, signed 98), so builder rows are X-BD; late-entry rows are X-CU (never `X-LE-15+` or `X-LE-table-N`), and
X-LE-2's "league and groups: W5" is re-worded to cite X-CU-1 to X-CU-13. Row citations say "seazn.club `_INDEX` ruling 277", because an earlier engine
CHANGELOG entry cites capture-repo rulings with the same numbers. "Engine PR" below means the row's code is engine
code; "App A" means app-path code whose row ships in the engine PR after app PR A merges.

| Rule | Source | Lands in |
|---|---|---|
| Late entry into a league or group entry stage: catch-up fixtures, bye slot first, then appended catch-up rounds; finished rounds never change; offered until the stage completes; Rebuild offered when nothing has started | 276 | Engine PR (`lateEntryFixtures`, `roundRobinLineKey`) + App A (action) |
| Automatic arrivals into a started table stage are never auto-placed; desk flag; one tap | 276, 271 | App A |
| Withdrawal from a table, the fold: under half played → every result of the entrant removed, finalized included; half or more → results stand and unplayed fixtures count as walkovers at the sport's score | 277 (deviation from BWF/ITTF always-expunge and the FA's 75 percent) | Engine PR — **proof only**: `withdrawTableEntrant` already decides it (`competition/stage.ts:943-960`); sport walkover scores are the app's |
| Withdrawal from a table, the writes: unplayed fixtures voided under the line or walked over above it, finalized included (`usecases/withdrawal.ts:225-233`); the row stays marked, ranked last; Reinstate restores; the footnote names the rule applied | 277 | App A |
| Self-withdrawal after Start goes through the table withdrawal (ruling 111) — X-WDT-9 | 111, 288 | App A |
| An in-match DQ withdraws the entrant from the stage, after the Disqualify action shows its consequence — X-WDT-10; X-RT-1 re-worded | 259, 277, 289 | B0 (row text) + App A |
| Badminton BD-WO-2 / BD-RT-1 re-worded as a permanent recorded deviation from BWF GCR 16.2.5; tennis follows 277 with no row | 86, 277, 290 | B0 (row text) |
| A departed qualifier leaves the cut; the next eligible entrant backfills; the public view stops naming them | 278 | **Already true** (W4 T13, RB4-V6 rows); App A adds the driving tests per row and path, then the row cites them |
| No pool under two, refused with a named reason that names a workable count; pool membership is every seated entrant | 279 | App A (C38 extended) + Engine PR (membership, floor) |
| Best-Nth across unequal pools drops results against the bottom k entrants, always on; basis shown | 280, **286** (UEFA qualifying convention) | Engine PR |
| Groups → knockout: no same-pool match in round one; rank then pool rotation; stored seed for ties; refusal when impossible — X-PD-1..7 | 281 | Engine PR (`crossPoolDraw` beside `crossPoolSeedOrder`) |
| A tie into a best-Nth basis comparison is broken by the sport's own declared cross-group cascade (seed step → seed order; lots → stored lots draw; neither → seed then id; never inside the cross-pool draw, where 281's seed decides) — X-PD-8 | 288, re-worded 291 | App A (constructed enumeration over the best-Nth rows; the row ships in the engine PR after App A) |
| A pair that loses a partner withdraws as the entrant; no substitute partner; duplicate entrant refused | 282 | App A (duplicate: already `PERSON_ON_OTHER_TEAM`, pinned) |
| A finished table keeps its cut line, frozen, "Qualified" / "Out", on every surface | 283 | Engine PR (+ App B for copy) |
| "Adjust points" on every table stage: reason required, undoable, footnote on every surface, hidden on brackets; Swiss pairs on the adjusted score | 284 (no-points clause: REC-11) | Engine PR (`adjustments`, reason, zero refusal) + App B (action; X-ADJ-4, X-ADJ-5) |
| Every round-robin pair meets exactly once per leg, except under a signed late-entry or withdrawal rule | OWNER 285 (design §7.3) | Engine PR (already proved by `roundrobin.test.ts`; counts added) |
| A second Generate or Complete with no change is a no-op that says so; an empty generate is a refusal | OWNER 285 (R13, R27) | App A (the engine returns an empty schedule for n < 2; the app refuses, `stages/generate-tx.ts:292`) |
| Rank override per pool; an invalid lock is refused at write; an override on a non-table stage is refused (X-PO-4) | OWNER 285; 288 for the stage kind | App A (+ engine `validateRankLocks`) |
| Who sits out is recorded per round; a bye never holds a court | OWNER 285 | App A (the engine already emits `rounds[].bye`) |
| `triple_rr` is deleted (template, detection branch, picker, matrix row, i18n, help); never stored, so no migration; a door that accepts the key refuses it by name (`legs` 1–8 stays, 285 / RB5-G1) — X-RR-6 | 287 (scope: designer's call) | App A |
| S1–S7 as signed | (§8) | per item |

## 13. Revision log 2026-11-16

Every correction made on 2026-11-16, as claim → truth → evidence. App paths are `apps/web/src/` relative at
97b184e2d9; engine paths are engine-repo relative at 2cd842a. Sources: the three recon audits and
`revision-decisions.md` (session scratchpad `w5-audit/`), each pin re-read on 2026-11-16.

| # | Claim (2026-11-05/06) | Truth (2026-11-16) | Evidence |
|---|---|---|---|
| 1 | "No recon on current main has been run for W5." | A read-only recon ran 2026-11-16. | scratchpad `w5-audit/*.md` |
| 2 | W4 releases engine 4.0.0; W5 targets the next release ("4.1.0 or 5.0.0" in the plans). | Engine main is 9.0.0; W4 shipped as 5.0.0 (tag v4.0.0 is cricket); W5 releases 10.0.0. | engine `package.json` "version"; `CHANGELOG.md` headings `## 9.0.0` (:3), `## 5.0.0` (:85) |
| 3 | App on the W4 engine. | App pins `^9.0.0` in two files; 7.0.0–9.0.0 epochs already taken. | `apps/web/package.json:25`; `packages/reference/package.json:14` |
| 4 | Server code in `usecases/stages.ts` (pins `stages.ts:2509`, `stages.ts:4140`, `stages.ts:4662-4671`). | `stages.ts` is the `usecases/stages/` folder. Re-pinned: positional reconcile `stages/generate-tx.ts:446-519`; Complete `engine-db/competition.ts:1162` + `stages/completion.ts:119-160`; override `stages/completion.ts:413,432`. | files as cited |
| 5 | Migrations V494/V495/V496 free. | Taken (W4 waiting, sponsor deals, W4 shared third); highest is V524; next V525. | `db/migration/deltas/V524__email_outbox_billing_lifecycle.sql` |
| 6 | Rulings 276–285 recorded in `_INDEX.md`. | Not on main; `_INDEX.md` ends at 275. | `origin/main:…/_INDEX.md:2158` (ruling 275) |
| 7 | W4 ships a reconcile driver with a seam W5 plugs into without touching it. | W4 shipped a pure planner (no structural predicate; differing key sets → regenerate; `in_place` = seat moves) and a knockout-only driver. W5 builds its own RR planner. | `lib/bracket-reconcile.ts:20,79`; `server/usecases/bracket-reconcile.ts:51` |
| 8 | CUT-1/CUT-2: cut source half owed by W5. | Done by W4 T13 on both paths; verify-only. | `lib/table-withdrawal.ts:61`; `server/usecases/stage-seeding.ts:96,137,474`; `stages/carry-over.ts:282,354`; `stages/seed-proposal.ts:146`; `server/public-site/qualification-view.ts:574` |
| 9 | ST-G24: export writes one pool. | Fixed 06537ffea9 (owner 2026-10-28); verify-only. | `server/usecases/exports.ts:487`; `usecases/__tests__/export-every-pool.test.ts` |
| 10 | R11: duplicate entrant unverified; new `RR_DUPLICATE_ENTRANT`. | Already refused as `PERSON_ON_OTHER_TEAM` 409; pin only. | `server/usecases/entrants.ts:195` |
| 11 | PO-1: a pool of one is accepted; build a new refusal. | C38 refuses a first group draw that strands an entrant; extend it (named count, builder), no parallel code. | `stages/generate-tx.ts:423-445` (commit 96aae0f7e6) |
| 12 | Engine pool membership pin `stage.ts:178-199`. | `entrantsOfPool` `competition/stage.ts:286-311`; pools from fixtures `:277-283`; `PoolTable` is in `progression.ts:475-482`. | engine files as cited |
| 13 | Minimum pool size decided at `module.ts:830`. | That line is the `SportModule` interface; no draw decision there. Pin dropped. | engine `src/sport/module.ts:825-835` |
| 14 | Engine emits byes and leg as new work (FX-G21 engine half). | Already emitted: `fixture.leg`, `RoundRobinRound.bye`; schedule `{rounds, fixtures}`. Only `roundRobinLineKey` is new; FX-G21 is app-only (`roundRobinGen` drops rounds). | `scheduling/roundrobin.ts:42,48-58`; app `stages/generators.ts:391-407` |
| 15 | n < 2 throws `CONFIG_INVALID` in the engine. | Engine returns an empty schedule; keep it. The app refuses by name. | `scheduling/roundrobin.ts:91`; app `stages/generate-tx.ts:292` |
| 16 | Expunge total is an engine fix (`stage.ts:421-423`). | Engine already voids every played fixture it is handed, strict < 0.5, Swiss never; the finalized skip is the app's. Moved to App A; engine is proof-only. | `competition/stage.ts:930-934,943,954,957-960`; app `server/usecases/withdrawal.ts:225-233`; `lib/table-withdrawal.ts:16` |
| 17 | Unequal pools: a new comparison; "today raw points"; flag kept or dropped at the builder's choice. | Today refused without the flag, k = 1 with it (even for equal pools). Generalise `normalisedRow`; always on (ruling 286). | `competition/progression.ts:52,652-670,826-835` |
| 18 | Unequal-pool pins `progression.ts:433-438, 550-556, 653-665`; API flag at `server/api-v1/schemas.ts:1062`. | `progression.ts:652-670,826-835`; API `server/api-v1/schemas/stages.ts:64`. | files as cited |
| 19 | Cross-pool fold is new (`progression.ts:124-131`, `bracket.ts:52-66`). | `crossPoolSeedOrder` exists; extend it. `slotOrder` and `byeEntrants` cannot combine, so byes are `null` slots. | `scheduling/bracket.ts:129-130,257` |
| 20 | `QualStatus` is a string union gaining `"qualified"`. | Object union `{kind}`; add `{kind: "qualified"}`; `QualRow` has no rank, so the order source is explicit. | `competition/qualification.ts:10-14,29-40,95` |
| 21 | Adjustments modify `applyPointsRule` and need a points-metric key. | No `applyPointsRule`; points are `StandingsRow.points`; the fold exists as `openingDeltas`. New = reason + zero refusal. | `competition/standings.ts:22`; `competition/stage.ts:344-348,354` |
| 22 | Rank locks need per-pool scoping (`points.ts:215-218`). | Already per pool; only an up-front `validateRankLocks` is new; throw at `points.ts:686-690`. | `competition/stage.ts:376-378`; `competition/points.ts:686-690` |
| 23 | Late-entry counts: a..f owes 5 catch-up rounds; 36 odd-n cases. | 6 owed (rounds 6–11); 33 odd-n cases (11 odd n in [2,24] × 3 legs). | arithmetic (engine plan audit T2/T3) |
| 24 | Rule rows only in the engine's `AWAITING_PROOF`; area `X-BL-` free. | seazn.club has its own map; `X-BL-1` taken. | `scripts/lib/rules-reference.ts:41`; engine `rules/cross-sport.md` row X-BL-1 |
| 25 | TR-1: `triple_rr` builds one leg — a defect to fix. | Retired from the offer 2026-11-01; a stored legs:3 builds three legs. REC-1: drop the fix. | `lib/format-templates.ts:254-262`; `server/usecases/stages/generators.ts:438-440` |
| 26 | #850 unread. | Same defect as FX-G21. | issue #850; `stages/generators.ts:391-407` |
| 27 | Registration arrivals through `registrations.ts`; waiting count in `division-phase.ts`. | One door `registrations/materialise.ts:231-232`; count in `competition-desk.ts:508`. | files as cited |
| 28 | Cut correction in a completed table stales confirmed proposals (W4 T14 covers it). | Only drafts are staled on the table path; `includeConfirmed` is knockout-only. Real work. | `server/usecases/scoring.ts:1180-1197` |
| 29 | `withdrawal.ts:102-105` is the finalized skip. | `withdrawal.ts:225-233` (`applyUpdate`). | file as cited |
| 30 | `format-templates.ts:341` holds the TR-1 hypothesis. | `format-templates.ts:254-262` (retired), `:404` (legs ≥ 3 → `triple_rr` detection). | file as cited |
| 31 | `normaliseUnequalPools`: builder's choice (§5.2). | Owner ruling 286: always on; flag accepted and ignored. | owner 2026-11-16 |
| 32 | Leftovers not in the design (ruling 111, #837, P7, X-RT-1 DQ cascade, BD-WO-2/BD-RT-1/tennis, ST-G4/12/13 routing, quick match `league_ko`, box league, seeding ties). | Placed in §4.2, §4.5, §5.1, §5.3, §6.4, §9 as REC-2..REC-10; box league out (REC-3). | `w5-audit/leftovers.md` A1–A13 |
| 33 | `swiss-cut-drift.ts` is the model for FX-G16's table half. | `knockout-cut-drift.ts` exists and is closer. | `server/usecases/knockout-cut-drift.ts` |

### Fix round 1 (2026-11-16)

From the two reviews of the revised docs (`w5-audit/review-consistency.md`, `review-verify.md`) and the decisions
sheet's F1–F17. Claim → truth → where fixed.

| # | Claim (revised docs, 2026-11-16 morning) | Truth | Fixed in |
|---|---|---|---|
| F1 | App-side rule rows land with PR B's bump; PR A gates on them. | Deadlock: A's gate can never hold. A rows-only 9.1.0 ships first; A bumps to it; no entry is deleted before its proof's release. | §3, §12; engine plan T0/T0b/T9/T10 |
| F2 | App plan A's X-CU / X-WDT ids. | They collided with the engine plan's ids (X-CU-10..13, X-WDT-6). One canonical table (engine plan T0): 74 rows after rulings 287–290, every row with an entry; X-WDT-9, X-PO-4, X-RR-6, X-WDT-10 added. | engine plan T0; §12 |
| F3 | REC-2: listed order decides ties in the cross-pool draw; the engine draw is seedless. | Owner ruling 281 (stored draw seed) wins over a REC. `crossPoolDraw` takes the seed; REC-2 is narrowed to best-Nth basis ties. | §5.3, §10 F and REC-2, §12; RB5-G9 |
| F4 | `PoolTable.results` is already filled; equal flagged pools' seats move at the bump. | The app passes no `results` in either builder; nothing moves for the app; unequal pools would refuse. App PR A passes them; PR B writes `expunged`. | §5.2, §6.4, §6.5; engine plan T5 |
| F7 | The draw extends `crossPoolSeedOrder`; adjustments ride `openingDeltas`. | The engine adds `crossPoolDraw` and a separate `adjustments` field. | §5.3, §6.2, §6.3, §6.5, §11 |
| F8/F9 | Empty late entry is a no-op; any unseated entrant is refused. | Empty is refused by name; only a result naming an unseated entrant is refused. | §4.1, §5.1, §10 |
| F10 | RB5-T15's "no points metric" refusal is a guard. | Nothing can trigger it. Dropped by ruling 288 (REC-11). | §6.2, §10 |
| F16 | Review Focus 1 refusal (A1, B1, B2 into 4 or a 3-stepladder) is a finding. | Kept refused; ruling 288 (REC-12). | §10; RB5-D10 |
| F17 | Plan-level calls not listed. | Listed in §10 "Designer's calls 2026-11-16". | §10 |
| #24 | `LateEntryResult` cases `automatic_waiting` / `automatic_tapped`. | Wire name is `waiting`; the tap returns `catch_up`. | §4.1, §6.7 |
| #28/#29 | Prefix list in call 23; sweep "75, not 90". | Final area list; 75 cells, 90 once `group_only` joins. | §10 call 23, §6.7 |
| 287–290 | RECs await the owner. | Owner answered the same day: 287 deletes `triple_rr`; 288 confirms REC-2..6, 9..12, F1 and the storage calls; 289 confirms REC-7 with the consequence copy; 290 confirms REC-8 option A. No row is ⬜ and nothing is gated. | §1 rows, §4.1, §6.4, §6.7, §10, §12; RB §3, §5, §7, §9, §10, §16; `_INDEX-w5-additions.md` §2 |

### Fix round 2 (2026-11-16)

From the whole-set re-review (`w5-audit/review-2.md`) and the decisions sheet's "CORRECTION to 287" and G1–G8. Claim →
truth → where fixed.

| # | Claim (docs after fix round 1) | Truth | Fixed in |
|---|---|---|---|
| 287 | Ruling 287's text includes "API create refuses legs:3 / the key" and "`legs` 1–8 stays". | The owner's words are only "in prod, no triple_rr, so blindly cleanup, delete it". The legs:3 refusal was a coordinator gloss, withdrawn. "`legs` 1–8 stays" is RB5-G1 (285); the scope list is the coordinator's reading (designer's call). | §4.1, §6.4, §10, §12; RB5-G6; `_INDEX-w5-additions.md` 287; engine plan X-RR-6 |
| G1 | X-PD-8 is proved by a counted test over "the 21 harness cases". | The 21 are per-row note counts with no case list, and most are table ties (rows without best-Nth). X-PD-8 is proved by a constructed enumeration over every best-Nth row (count > 0); the harness notes are re-judged by row in A's matrix task; non-best-Nth rows are confirm-time table ties under the existing ladder. | §5.3, §9 (row + note), §12; RB5-G9; engine plan X-PD-8 |
| G2 | Engine T9 appends A's DQ tests to X-RT-1. | No A test was titled X-RT-1, so the app checker would red at B's bump. A titles one `X-RT-1 …` and hands it over. | engine plan T9 Step 2 |
| G3 | B sets `tied` from `entry.tieUnbroken`. | `tieUnbroken` is a within-pool flag; no production path set `tied`, so the stored seed was never read (inert seam). `tied` = equal on the cross-pool comparison; best-Nth via the new `basis.levelWith`, same-rank tiers via B's own `crossGroupOrder`. | §5.3, §6.5, §10; engine plan Interfaces, T5, T6 |
| G4 | App PR A passes pool `results` on 9.x; "the window never opens". | On 9.x that applies k = 1 to every pool, wrong for 4/3 and 3/2 shapes. Results move to B's bump commit; no window because results and the always-on engine land together. | §5.2, §6.4, §6.5; engine plan Interfaces note, Review Focus 3–4, T5 |
| G5 | `triple_rr` divisions are stored; a LOUD V526 migration cleans staging. | `triple_rr` is detected (`lib/format-templates.ts:404`), never stored; no migration, no prod read. No create door accepts the key (`createFromTemplate` reads `TEMPLATE_CATALOG`, 404 already). | §4.1, §6.4, §6.7, §9, §12; RB5-G6; `_INDEX-w5-additions.md` 287 |
| G6 | The rows snapshot rides app PR A Task 0; W5 releases 10.0.0. | Another wave's bump inside PR A's life would red on 74 unlisted rows. A standalone W5 rows bump PR (#1146's shape) merges before PR A. W5's release is the next engine major at release time (10.0.0 today). | §3, §6.4, §10, §11, §12; engine plan header, Gate 2b, T0, T0b, T10 |
| G8 | Counts 69/66, "75 new rows", "rulings 276–286", stale §6.7 text, 9.1.0 as a designer's call. | 74 rows and entries, B deletes 71, close-out 3; rulings 276–290; §6.7 says `triple_rr` deleted and quick match is its own task; 9.1.0 confirmed by 288. | §6.4, §6.7, §10, §12; engine plan T0; `_INDEX-w5-additions.md` |

### Fix round 3 (2026-11-16)

From the final read-only check (`w5-audit/review-3.md`). Claim → truth → where fixed.

| # | Claim (docs after fix round 2) | Truth | Fixed in |
|---|---|---|---|
| N1 | A best-Nth basis tie across pools is settled by "listed (seed) order, ending in stored lots" on every sport. | False for every sport whose cross-group cascade ends in `lots` with no `seed` key (football and most others): the engine draws NEW lots there (`tiebreakers.ts:1081-1125`). Owner ruling 291 (answer A): the sport's own declared cross-group cascade breaks the tie (seed step → seed order; lots → stored lots draw; neither → seed then id); no engine change; supersedes 288's "listed seed order" wording for REC-2. | §5.3, §10 REC-2, §12; RB5-G9; engine plan X-PD-8; app plan Task 11c (sports named by cascade class, each expected value derived from the declared cascade); `_INDEX-w5-additions.md` 291 |
| N2 | The group_rank tie reads "only the residual classes (`tieBreak.with`)". | `markTieBreak` also fills `tieBreak.with` when a key SPLITS a group (`tiebreakers.ts:625-632`). Read `tieUnbroken: true` rows and their `tieBreak.with`; the split-pair test drives `crossGroupOrder`. | B Task 5 |
| N3 | The expected bump reds are scenes whose pool sizes differ by 2 or more. | On 9.x the app compared raw rows, so ANY unequal best-Nth scene (difference 1 included) can move to k = size − min. | B Task 0 Step 5 |
| N4 | The `triple_rr` door scan counts 1 input door. | The same scan also matches the output field `FromTemplateResult.templateKey` (`schemas/stages.ts:692`); scan input schemas, exclude it by name. | A Task 16 |
| N5 | Task R and Gate 2b hardcode 9.1. | Engine T0b allows the next free minor; both gates read the version T0b hands back. | A Task R Step 1 and Task 0 Step 1; engine plan T0b Gate 2b |
| N6 | `group_stepladder` / `group_playoffs` seed through `crossPoolDraw`. | They are league-sourced (no pools) and `crossPoolDraw` over one pool refuses. `crossPoolDraw` runs only for a source with two or more pools; league-sourced rows keep today's placement; a test pins that they still seed. | B Task 5; §5.3 |
| N7 | T10 Step 5 lists only some B ids for the proofs hand-over. | It now says every id on B's hand-over list (traceability only). | engine plan T10 Step 5 |
| N8 | The mutant "attach no results to the smaller pools" refuses. | k = 0 pools need no results; the mutant survives. Now "attach no results to the larger pools → `pool_results_missing`". | B Task 0 Step 6 |
