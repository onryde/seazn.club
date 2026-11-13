# Quick Match 5: League + Knockout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest picks **League**, **League → Final** (top 2) or **League → Semi-finals → Final** (top 4) on `/[lang]/play`. They play the league on the home they already know, and the knockout fills itself the moment the league is done. A tie at the cut becomes a question on the home (Pick who goes through / Toss a coin) that anyone with the link answers once. The champion is the final's winner.

**Architecture:** A League + Knockout quick match is ONE division with TWO stages, built from the `league_ko` template's knockout stage (`lib/format-templates.ts:78-87`, `timing: "setup"`, `rankRange 1..q`, `placement: "rank_order"`). The knockout's placeholder lines are written in the create's last transaction (`writeProgressionSetupFixtures`), so the bracket shows from the start. A QM-owned, idempotent `advanceQuickMatch` moves the night on. It reads the league's live stored table. When there is no tie straddling the cut, or once the guests' decision is stored, it completes the league stage, computes the seed proposal and confirms it as the system user (`systemAuth`), passing `tiePicks`. It runs after every QM scoring write (one QM-gated hook in `scoring.ts` `onDecided`), after a skip, after a decision, and on every home load (the retry). `divisions.auto_progress` stays **false**. The guests' cut decision is stored on `quick_matches.cut_decision` (first write wins). Who went through stays the confirmed proposal's (the fixtures), so there is one authority per fact.

**Tech Stack:** Next.js 16 route handlers (303 form posts, the `match-action-post.ts` pattern), server components + small client islands, `postgres` tagged SQL under `withTenant(QUICK_MATCH_SYSTEM_ORG_ID)`, `@seazn/engine` 9.0.0 standings/progression, vitest (`environment: "node"`), Playwright (`apps/web/e2e`), smoke (`scripts/smoke/suites/quickMatch.ts`).

**Spec:** `docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md` (APPROVED; read §11 and §12, which supersede §4). Mockup: `/Users/ashokhein/seazn-artifacts/2026-11-13_quick-match-next-designs_qmd13a01/index.html` sections 6–12. It is **layout only**: build in the house night theme of `components/quick-match/*`. Decision log: `/Users/ashokhein/github/seazn.club/.superpowers/sdd/quick-match-decision-log.md` (all 2026-11-12/13 rows). House patterns: `docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md` and its ledger `.superpowers/sdd/2026-11-13-quick-match-4-skip/`.

**Branch / worktree:** `feat/quick-match-league-knockout` at `/Users/ashokhein/github/seazn.club-worktrees/quick-match-lk`, off `origin/main` `da5672071c` (includes #1210 skip). **Every Bash call starts with `cd /Users/ashokhein/github/seazn.club-worktrees/quick-match-lk &&`; use `grep -a`.** TypeScript paths below are relative to `apps/web/` unless they start with `scripts/`, `db/` or `docs/`.

**Migration:** YES, `db/migration/deltas/V517__quick_match_league_knockout.sql`. **V517 is a WORKING number** (main tops at `V516__match_day_code_can_call.sql`). The owner renumbers at merge if needed: rename the file and update every test that names it.

---

## Re-pin log (2026-11-13, HEAD da5672071c)

Every §7 building block, plus the brief's premises, re-read in the tree. **F** marks a false or misleading premise.

| # | Premise (spec §7 / brief) | Found in the tree | Verdict |
|---|---|---|---|
| P1 | `league_ko` template exists at `format-templates.ts:80` | `lib/format-templates.ts:78-87`: league `{legs:1}` + knockout "Finals", `progression {sources:[{stage:"previous", take:[{kind:"rankRange",from:1,to:q}]}], placement:"rank_order", timing:"setup"}`. Its league is hard-coded `legs: 1`. | TRUE, but QM needs `legs = plays`, so it reuses the template's KNOCKOUT draft only (T3). |
| P2 | Create is one stage (`quick-match-create.ts:177,192`) | `:176` `createStages(auth, division.id, {seq:1, ...quickMatchStageInput(...)})`, `:191` `generateStageFixturesTx`, `:195` `startDivisionInTx(..., stage.id)`. `CreatedQuickMatch.stageId` is singular (`:63`). | TRUE (lines moved by 1). |
| P3 | `generateProgressionSetupFixtures` (`setup-fixtures.ts:59`) for the KO placeholders | `:59` opens its OWN `withTenant`; the create's last tx cannot call it (`withTenant` never nests). The tx-taking twin is `writeProgressionSetupFixtures(tx, stageId, {checkSeats?})` (`:65`, exported from `stages/index.ts:108`). Seats: `home/away_entrant_id null`, slot labels = `descriptorLabel` + internal `seed` (`:253-261, :319-326`). | **F (wrong function).** T3 calls `writeProgressionSetupFixtures(tx, …)`. |
| P4 | Format value: API enum `league|knockout` (`schemas/quick-match.ts:35`); DB check `V506:59` | Both TRUE. The DB check is an inline, unnamed column check (Postgres names it `quick_matches_format_check`). No delta after V506 touches it. `CreateQuickMatch` is NOT in OpenAPI (`openapi.ts` has 0 `QuickMatch` hits), so there is no drift check to regenerate. | TRUE. Migration owed (T1). |
| P5 | Auto-advance = set `auto_progress` + auto-confirm like `plate-field.ts:252` | `maybeAutoAdvance` (`scoring.ts:1222-1264`) runs AFTER the score commit, in its own transactions, under the scorer's auth. It returns early without `auto_progress` (`:1225`), and its bare `catch {}` (`:1263`) swallows every failure, `STAGE_COMPLETED_SEEDING_FAILED` included. `completeStage` (`stages/completion.ts:119`) only DRAFTS a setup proposal (`:198-227`). The plate's auto-confirm (`plate-field.ts:236-253`) calls `confirmSeedProposal` with NO tiePicks, so any tie lands in `plate_auto_confirm_failed`. | **F (insufficient).** QM owns its own advance (D2). `auto_progress` stays false. |
| P6 | "advance in the same transaction as the finishing score" (decision log, spec §11) | `onDecided` (`scoring.ts:1019`) commits first. `completeStage`, `computeSeedProposal` (`seed-proposal.ts:89`) and `confirmSeedProposal` (`:336`) each open their own `withTenant`, and `withTenant` never nests. | **F.** The advance runs in the SAME REQUEST, right after the commit, plus a home retry on every load (D2). The "Setting up the knockout" state covers the gap. |
| P7 | Engine: residual ties drawn by lot, still flagged `tieUnbroken` (`tiebreakers.js:864`); `progression.js:587` flags any tied qualifier | TRUE. `StandingsRow.tieBreak = {key, with[], drawnAt?}` (`standings.d.ts:14-20`). The lot is `shuffle(lotSeed(rngSeed, sortedIds))`, deterministic per `stage.config.rngSeed` (minted on every stage create, `stage-defaults.ts:49`). At completion the draw ORDER is stored in `stage_lots_draws` (`engine-db/competition.ts:846-866`). A tie group's `entrantIds` is the FULL residual class (outsiders included); its slots are only the qualifying seats (`seed-proposal.ts:244-271`). There is no explicit straddle flag. | TRUE. The app tells a straddle from "all go through" itself (T2, `cutTies`). |
| P8 | Each sport's default list ends in `lots`, so "still level" = level before `lots` | Volleyball, badminton, table tennis, hockey, carrom, boardgame and football end `…, lots`. **Tennis** (`tennis.js:67`) and **ice hockey** (`icehockey.js:255`) put **`seed` before `lots`**. In a quick match the seed is the typing order, so a level pair at the cut is separated by who was typed first, silently. | **F for 2 of 9 sports.** Built per spec (default list unchanged). T2 pins the list per sport. **Owner question Q1.** |
| P9 | Confirm refuses unresolved ties (`seed-proposal.ts:401`) | `:394-404` `SEEDING_TIE_UNRESOLVED`: every tie must be covered by `edits` on all its slots, or by a `tiePick` whose sorted slots equal the tie's. `tiePick.order[i]` → `slots[i]` (`:406-410`). Picks are stored nowhere except the filled fixtures + `seed_confirmed.payload.entrants`. | TRUE. Case 2 and the guests' decision both confirm with `tiePicks` (T4). |
| P10 | Home throws on `stages.length !== 1` (`quick-match-home.ts:343`) | Now `:417-418` (plus `:411` >1 division, `:422-425` kind). `resultMovedOn` reads the ONE stage's status (`:497`). Standings/table rules/metrics only `stage.kind === "league"` (`:504-516`). | TRUE (lines moved). T6. |
| P11 | Preview is single stage | `quickMatchPreview` (`quick-match-preview.ts:65`) previews one stage input; `QuickMatchPreviewTable` is keyed `league:<sides>:<plays>` only (`:134,181`); `quickMatchKnockoutDraws` (`:193`) has no caller. | TRUE. T3. |
| P12 | Delete/sweep need no change | `quick-match-delete.ts:99-153` and `quick-match-sweep.ts` are competition-wide. **But** `quick-match-owner.ts:51-57` (a saver's rename) updates every stage and THROWS unless `stages.count === 1`. | **F (missed consumer).** T3 fixes the rename. |
| P13 | Admin: "finished = final decided"; played/finished SQL OK for two stages | `quick-match-admin.ts:143-153,184-185,252`: `playedOf` over ALL the division's fixtures. KO placeholders are non-bye (q is 2 or 4, so no bye lines), so `isQuickMatchFinished` is true only once the final is settled. `playedSql` (`:130-137`) is competition-wide. | TRUE, no SQL change. T3 adds a two-stage admin test, T8 the format label. |
| P14 | Skip code (T3 review m4): `row.format !== "league"` and a division-wide "finished" | `quick-match-skip.ts:88` refuses any non-`league` row format; `leagueFinishedFor` (`:70-74`) reads EVERY fixture of the division. With two stages, Put back would stay open until the FINAL, and every LK skip would be refused. | TRUE (a real defect for LK). T4 makes both stage-aware. |
| P15 | Add a match `quick-match-add.ts:64` | `home.row.format !== "league"` → `LEAGUE_ONLY`; `addFixture` on `home.stageId`. | TRUE. T4: league stage, refused once the league is complete. |
| P16 | Edit result after the knockout filled is refused "with plain copy" | Already enforced: `resultMovedOn` → no Edit result in the menu (`quick-match-home.ts:490-498`), and the pad refuses `RESULT_CARRIED_FORWARD` once `stages.status = 'complete'` (`carried-forward.ts:32-33`, `scoring.ts:726-740`), showing `device.quickMatch.resultLocked` "This result can't change: the next round has already started." (`scan-screen.ts:22`). The league stage completes exactly when the knockout fills (D2). | TRUE, with no new server guard. T6/T7 pin it. |
| P17 | Pad unchanged, works per fixture | `ensureGuestDeviceLink` has no format or stage restriction (`device-links.ts:~307`). | TRUE. |
| P18 | Every offered sport may play a knockout | `lib/quick-match-offer.generated.json`: 27 offered variants over 9 sports, ALL `knockoutAllowed: true` (C23, `quick-match-sports.ts:88`). `sport.variants[].knockoutAllowed` already reaches the offer, but the setup form does not read it. | TRUE. The negative branch is reachable only by a synthetic offer (T8 pure test). |

---

## Decisions this plan makes (controller, PO rec; log each in the decision log at execution)

- **D1, format spelling and where q lives.** The stored and API format value is **`league_knockout`**. The qualifier count lives in **the stage graph only**: the knockout stage's `progression.sources[0].take[0].to` (2 or 4). That is the engine's own authority, so a second column would be a second fact. The API takes `qualifiers: 2 | 4`, required with `league_knockout` and refused otherwise. The setup form posts one radio, `shape = league | final | semis`. The route's `formInput` maps it, so the no-JS form needs no paired fields. `knockout` stays in the enum and the DB check (legacy rows; create still refuses it, 422 `FORMAT_NOT_OFFERED`).
- **D2, the advance.** `advanceQuickMatch(row)` is QM-owned and idempotent, under `systemAuth()`. Each call asks "what is the next step?" and takes it:
  1. not `league_knockout` → `{state:"plain"}`;
  2. the knockout stage has a confirmed proposal → `{state:"filled"}`;
  3. the league is not done (some non-bye league line neither settled nor `cancelled`) → `{state:"league"}`;
  4. read the league's live stored table (`getStandings`) and run `cutTies` (T2). If a tie straddles the cut and no stored decision matches it, return `{state:"tie", tie}`. A stored decision that no longer matches the tie (an edit changed the table) is cleared, so the question is asked again (§11);
  5. otherwise: `completeStage(systemAuth(), leagueStageId, {publish:true})` when the league stage is not complete. Then take the draft proposal (`getSeedProposal`; compute one when none, or when it is stale). Then `confirmSeedProposal` with `tiePicks`: a straddling tie takes the decision's entrants, placed into its slots in seed order; every all-through tie (case 2) takes its default occupants, the stored-lot order. `SEEDING_ALREADY_CONFIRMED` / `SEEDING_PROPOSAL_STALE` from a racing advance are race losses → re-read, `{state:"filled"}` or retry once.

  Callers, each best-effort (log `quick_match_advance_failed`, never fail the caller's write): (a) `scoring.ts` `onDecided`, after `maybeAutoAdvance`, only when `auth.orgId === QUICK_MATCH_SYSTEM_ORG_ID` (dynamic import, so the organiser graph is untouched); (b) the skip route, after a skip; (c) the decision routes; (d) `app/q/[token]/page.tsx` before `readQuickMatchHome` (the retry). P6 is why it is not literally in the scoring transaction.
- **D3, when the league freezes.** The league stage completes only when the knockout is about to fill (step 5), so while a tie question is open the league is still active. Edit result, Not played and Put back keep their league rules, and an edit recomputes the question on the next read (§11). Once the knockout fills, the existing carried-forward guard refuses every league edit (P16). Add a match is refused once the league is done (`LEAGUE_COMPLETE`, §6 call 7). Put back is refused once the league is done (`LEAGUE_FINISHED`, OWNER 2026-11-13).
- **D4, case 1 vs case 2 (`cutTies`).** A tie class = a row with `tieUnbroken` plus its `tieBreak.with`. Its *seats* = the members ranked ≤ q. `0 < seats < size` → **straddles** (case 1: ask). `seats === size` → **all through** (case 2: the lot orders them, marked "decided by lot"). `seats === 0` → ignored. More than one straddling class at one cut is impossible (one cut line): asserted, thrown as a fault. The tie's place = the class's lowest rank. "Pick N of M": N = seats, M = size.
- **D5, the decision.** `quick_matches.cut_decision jsonb` = `{ how: "pick" | "toss", through: string[] /* entrant ids, N */, tie: string[] /* the class's ids, sorted */, at: iso }`. It is written by `update … set cut_decision = $1 where id = $2 and cut_decision is null returning id`: the first decision wins. A second one gets 422 `ALREADY_DECIDED` (§5 abuse note). **Toss reveals the stored lot (§11):** `through` = the N members the live table already ranks highest within the class (the deterministic lot, P7). No second draw. Pick: `through` = the guest's N picks, validated ⊂ class, exactly N distinct. After the decision commits, the route runs `advanceQuickMatch`.
- **D6, what a tie looks like after it is settled.** The home marks "decided by lot" on every member of an all-through class, and on every member of a straddling class settled by **toss**. A **pick** marks the picked side(s) "picked" instead (the order among them still follows the lot, §11).
- **D7, labels.** A placeholder seat reads "1st in the league" … "4th in the league" (keys per rank, no ordinal arithmetic). A seat waiting on a straddling tie reads "2nd in the league — to decide". A filled seat shows the name plus "1st" / "2nd · by lot". Knockout cards keep `fixtureLabel` naming ("Semi-final 1", "Final").
- **D8, the counts.** "N of M played" stays division-wide (`playedOf`): M = league + knockout, KO placeholders included (P13, spec §12). The hero's "match n of m" counts LEAGUE lines only while the league is on (mockup frame 7). `finished` stays division-wide (the final decided). `leagueDone` is new and league-stage-only.
- **D9, standings during an open tie.** The straddling class's rows show "=" in place of a rank, and "level — to decide" (mockup frame 8), never lot order.
- **D10, stage names.** Both stages are named after the match (as today's single stage). The rename (P12) expects 1 stage for `league` and 2 for `league_knockout`.

## Global Constraints

- Formats: **League** | **League → Final** (top 2) | **League → Semi-finals → Final** (top 4), a stacked list, no "Then" control (§12). 2 sides: no knockout row. 3 sides: the semis row is disabled with "Needs 4 or more sides". Each pair plays: Once | Twice (`QUICK_MATCH_MAX_PLAYS = 2`), the league part only.
- Seeding: semis 1st v 4th, 2nd v 3rd; final 1st v 2nd (or the semi winners). No 3rd-place match.
- Start count = league + knockout: 6 sides Once + semis = 15 + 3 = **18**; Twice = 30 + 3 = **33**; 3 sides Once + final = 3 + 1 = **4** (mockup §6, the expected values for T3/T8).
- Copy: every new guest string in all 4 locales (`dictionaries/{en,fr,es,nl}/ui.json`), then `npm run i18n:gen-keys` and `npm run i18n:check` (root `package.json:60,62`). Plurals take `{count}`. Names are joined by `Intl.ListFormat` (house). Sentences are neutral about who did what, so doubles names agree (decision log 11-08). `/admin` stays English inline. es/fr/nl native read is OWED TO OWNER.
- UI: mobile-first. Verify at 320, 768 and 1280 with no horizontal page scroll (`scrollWidth <= innerWidth`). Tap targets are at least 44px (hit-test with `elementFromPoint`). `/admin` is checked at 1280 only.
- Credential hygiene: every element whose `action`/`href` holds `/q/<token>/…` carries `ph-no-capture`. New route builders join the scrub registries.
- Tests (`docs/superpowers/TEST-STRATEGY.md`): anti-vacuity (every sweep reports its count, and 0 is a failure). Expected values come from the rulebook, the engine's declarations or the mockup's numbers, never from the code under test. Mutate every new guard once. Test SEQUENCES.
- Verify ONLY the files changed: `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=<scratch>/r.json; echo EXIT=$?`. Read `numPassedTests`/`numTotalTests` and confirm `.testResults[].name` is in THIS worktree. tsc runs on the changed files only (the throwaway `tsconfig.changed.json` recipe, skip ledger). Never the full suite, never full e2e locally. E2E runs by `gh workflow run e2e.yml --ref feat/quick-match-league-knockout`.
- DB tests need a fresh schema with V517 applied (`seazn-local-env` skill: `db:apply` + `sync:sports`; confirm `show data_directory` is yours).
- Every UI task invokes the `frontend-design` skill and serves 320/768/1280 screenshots of each changed state on local :8765 (never artifacts, never PNGs in the repo).
- PostHog: `quick_match_created` gains `qualifiers` (null for a league). No new event.

## Review Focus

1. **A tie decided while someone corrects a league result.** Guest A taps Toss while guest B's Edit result reopens a league match. The decision must not fill a knockout from a table that has moved. T4 case 9: decide, then void a league result before advancing, then advance → `{state:"league"}`, the decision cleared, the knockout empty.
2. **Two phones finishing the league at once** (the last league match and a skip, or two advances from two home loads) must fill the knockout exactly once, with no 500. T4 case 10: two concurrent `advanceQuickMatch` → one confirmed proposal, one `seed_confirmed` event.
3. **A three-way tie under Once** (A>B, B>C, C>A, identical scores) with top 2 is "pick 2 of 3", never a crash or two questions. T2 (pure) and T4 case 4 (DB, boardgame).
4. **Put back or Add a match on an old tab after the knockout filled.** Refused with copy, and nothing in the knockout moves. T4 cases 7-8.
5. **A pad left open on a league match after the knockout filled.** The next tap is refused `RESULT_CARRIED_FORWARD` with the QM locked line (P16). T4 case 11.

---

## Batches (parallel only where the file sets are provably disjoint)

- **B1: T1 ∥ T2.** T1 owns `db/migration/deltas/V517__…sql`, `src/server/api-v1/schemas/quick-match.ts`, `src/lib/quick-match-constants.ts`, `src/lib/routes.ts`, the 4 `ui.json`, `src/lib/i18n-keys.ts` (generated), and the scrub registry tests + their migration/schema/routes tests. T2 owns the NEW `src/server/usecases/quick-match-cut.ts` and its tests only.
- **B2: T3.** It owns create, preview, the owner rename and their tests. Sequential, because T4 needs its two-stage create.
- **B3: T4.** It owns the advance + decision usecases, `scoring.ts` (the hook only), `quick-match-skip.ts`, `quick-match-add.ts`, the new routes, `app/q/[token]/match-action-post.ts`, and their tests.
- **B4: T5 ∥ T6.** T5 owns `quick-match-home.ts` (the read model) and its test. T6 owns `components/quick-match/setup-form.tsx`, `app/[lang]/(marketing)/play/page.tsx`, `app/api/quick-match/route.ts` (`formInput` only), `components/quick-match/my-list.tsx`, `app/admin/quick-matches/page.tsx`, and their tests. Disjoint: T6 reads no home type that T5 changes (my-list reads `MyQuickMatch`, which T5 does not touch).
- **B5: T7.** It owns the home UI (`home.tsx`, `draw.tsx`, `standings.tsx`, `match-list.tsx`, the NEW `cut-prompt.tsx`, `app/q/[token]/page.tsx`) and its tests.
- **B6: T8 ∥ T9 ∥ T10.** T8 owns `e2e/quick-match.spec.ts`, `e2e/quick-match-home.spec.ts` and `e2e/mobile.spec.ts`. T9 owns `e2e/walkthrough/quick-match.spec.ts`. T10 owns `scripts/smoke/suites/quickMatch.ts`. Then push and dispatch CI e2e.
- **No dictionary edits after B1.** A missing key goes to the controller, who adds it in one commit between batches (skip plan rule).
- After each batch: the per-task review closes, and the controller re-runs the scoped gate (the union of the batch's test paths). After B6: the whole-branch review, the sign-off screens on :8765, then ONE PR.

---

### Task 1: The contract: migration, API shape, codes, routes, every string

**Files:**
- Create: `db/migration/deltas/V517__quick_match_league_knockout.sql`
- Modify: `src/server/api-v1/schemas/quick-match.ts:35` (format, + `qualifiers`)
- Modify: `src/lib/quick-match-constants.ts` (`QUICK_MATCH_ERRORS`, `:57+`; + `QUICK_MATCH_QUALIFIERS = [2, 4] as const`, `QUICK_MATCH_SEMIS_MIN_SIDES = 4`)
- Modify: `src/lib/routes.ts` (beside `quickMatchSkip`/`quickMatchPutBack`)
- Modify: `src/dictionaries/{en,fr,es,nl}/ui.json`; regenerate `src/lib/i18n-keys.ts`
- Test: `src/server/usecases/__tests__/quick-match-migration.test.ts` (extend), a schema test beside the existing CreateQuickMatch tests (find it with `grep -arl "CreateQuickMatch" src/**/__tests__`), `src/lib/__tests__/{routes,scrub-route-root,scrub-path-secrets,scrub-secret-painters}.test.ts` (builder lists only)

**Interfaces (Produces):**
- SQL: `alter table quick_matches drop constraint quick_matches_format_check, add constraint quick_matches_format_check check (format in ('league','knockout','league_knockout'));` and `alter table quick_matches add column cut_decision jsonb null constraint quick_matches_cut_decision_object check (cut_decision is null or jsonb_typeof(cut_decision) = 'object');`. The header comment names spec §5/§11 and D1/D5.
- `CreateQuickMatch.format: z.enum(["league","knockout","league_knockout"])`; `qualifiers: z.union([z.literal(2), z.literal(4)]).nullable().default(null)`; a `superRefine`: `league_knockout` ⇔ `qualifiers !== null` (issue path `["qualifiers"]`).
- `QUICK_MATCH_ERRORS`: `ALREADY_DECIDED = "QUICK_MATCH_ALREADY_DECIDED"`, `TIE_NOT_OPEN = "QUICK_MATCH_TIE_NOT_OPEN"` (no open question, or it changed), `PICK_INVALID = "QUICK_MATCH_PICK_INVALID"`, `LEAGUE_COMPLETE = "QUICK_MATCH_LEAGUE_COMPLETE"` (Add a match after the league is done), `SEMIS_TOO_FEW_SIDES = "QUICK_MATCH_SEMIS_TOO_FEW_SIDES"`. Each gets a doc comment in the file's style.
- `routes.quickMatchCutToss(token) => \`/q/${token}/cut/toss\``, `routes.quickMatchCutPick(token) => \`/q/${token}/cut/pick\``.
- Keys (en shown; fr/es/nl with real agreement, never English):

| key | en |
|---|---|
| `quickMatch.format.leagueKnockout` | `League + Knockout` |
| `quickMatch.setup.format` | `Format` (reuse if it already exists) |
| `quickMatch.setup.shape.league` / `.leagueHint` | `League` / `Everyone plays everyone.` |
| `quickMatch.setup.shape.final` / `.finalHint` | `League → Final` / `Everyone plays everyone, then the top 2 play a final.` |
| `quickMatch.setup.shape.semis` / `.semisHint` | `League → Semi-finals → Final` / `Everyone plays everyone, then the top 4 play semi-finals and a final.` |
| `quickMatch.setup.shape.semisNeeds` | `Needs 4 or more sides` |
| `quickMatch.errors.semisTooFewSides` | `Semi-finals need 4 or more sides.` |
| `quickMatch.home.stagePart.split` | `{league} league, {knockout} knockout` |
| `quickMatch.home.stagePart.knockoutOn` | `league finished, knockout on` |
| `quickMatch.home.goThrough` / `.wentThrough` | `Top {count} go through` / `Top {count} went through` |
| `quickMatch.home.knockout` / `.knockoutFills` / `.knockoutWaiting` | `Knockout` / `Fills itself when the league ends` / `Waiting for the tie` |
| `quickMatch.home.leagueRank.1`…`.4` | `1st in the league` … `4th in the league` |
| `quickMatch.home.rankShort.1`…`.4` | `1st` … `4th` |
| `quickMatch.home.toDecide` | `{seat} — to decide` |
| `quickMatch.home.byLotShort` / `.byLot` / `.picked` | `by lot` / `decided by lot` / `picked` |
| `quickMatch.home.levelToDecide` | `level — to decide` |
| `quickMatch.home.leagueMatches` / `.finalLeagueTable` | `League matches` / `Final league table` |
| `quickMatch.home.settingUp` / `.settingUpHint` / `.refresh` | `Setting up the knockout` / `Refresh in a moment to see who plays the knockout.` / `Refresh` |
| `quickMatch.home.champion` / `.championBeat` / `.championTopToo` | `Champion` / `Beat {loser} in the final, {score}.` / `Top of the league too.` |
| `quickMatch.cut.kicker.one/.other` | `League finished · one place left in the knockout` / `League finished · {count} places left in the knockout` |
| `quickMatch.cut.title` | `Tie for {place}: {names}` |
| `quickMatch.cut.titleMany.one/.other` | `Tie for {place}: {sides} sides, 1 place` / `Tie for {place}: {sides} sides, {count} places` |
| `quickMatch.cut.body` | `They are level on every tiebreaker. Anyone with the link can decide.` |
| `quickMatch.cut.pick` / `.toss` / `.back` | `Pick who goes through` / `Toss a coin` / `Back` |
| `quickMatch.cut.pickQuestion.one/.other` | `Who goes through?` / `Choose {count} to go through` |
| `quickMatch.cut.send` | `Send {names} through` |
| `quickMatch.cut.tossResult` / `.tossBody` | `The coin toss sent {names} through.` / `They were level on everything. Everyone with the link sees this same result.` |
| `quickMatch.cut.pickResult` | `Picked to go through: {names}.` |
| `quickMatch.flash.alreadyDecided` | `Someone already decided. Here is who goes through.` |
| `quickMatch.flash.tieChanged` | `The table changed, so the question changed. Decide again.` |
| `quickMatch.flash.pickInvalid` | `Choose exactly the number of sides that go through.` |
| `quickMatch.flash.leagueComplete` | `The league is complete, so no match can be added.` |

- [ ] **Step 1: Write the failing tests.**
  - Migration (`quick-match-migration.test.ts`): `insert … format 'league_knockout'` succeeds; `'swiss'` fails `23514` naming `quick_matches_format_check`; `cut_decision = '[]'::jsonb` fails naming `quick_matches_cut_decision_object`; `'{}'` and null succeed.
  - Schema: `league_knockout` + `qualifiers: 2` parses; `league_knockout` with no `qualifiers` fails on path `qualifiers`; `league` + `qualifiers: 4` fails; `qualifiers: 3` fails; `league` alone parses with `qualifiers: null`.
  - Routes: both builders start with `routes.quickMatch(t)` and end `/cut/toss` and `/cut/pick`. Add both to `SECRET_BUILDERS`, `secretBuilderNames()` and the scrub-path list.
- [ ] **Step 2: Run them.** They fail for the right reasons.
- [ ] **Step 3: Implement.** Then `npm run i18n:gen-keys`.
- [ ] **Step 4: Verify.** The tests pass, `npm run i18n:check` exits 0, and scoped tsc is 0. **Mutate once:** drop `league_knockout` from the check → the migration case goes red. Delete `quickMatch.cut.toss` from `es` → `i18n:check` goes red. Restore both.
- [ ] **Step 5: Commit** `feat(quick-match): league_knockout format, cut decision column (V517), codes, routes and copy in four locales`.

---

### Task 2: `cutTies`: who a tie at the cut affects (pure)

**Files:**
- Create: `src/server/usecases/quick-match-cut.ts` (pure, no DB import; `import "server-only"` not needed, so T7's view can import its types)
- Test: `src/server/usecases/__tests__/quick-match-cut.test.ts`

**Interfaces (Produces):**
- `export interface CutRow { entrantId: string; rank: number; tieUnbroken: boolean; tieWith: readonly string[]; tieKey: string | null }`, built from a stored standings row by `export function cutRowOf(row: StandingsRow): CutRow` (`rank` required: a row without one throws).
- `export interface CutTie { entrantIds: string[] /* sorted */; ranked: string[] /* the class in live table order */; place: number /* the class's lowest rank */; seats: number; straddles: boolean }`
- `export function cutTies(rows: readonly CutRow[], qualifiers: 2 | 4): CutTie[]`: D4. One entry per class (deduped by sorted ids). Classes with `seats === 0` are left out. Throws `Error("quick match cut: two ties straddle one cut")` on more than one straddling class.
- `export function openTie(ties: readonly CutTie[]): CutTie | null`: the straddling one or null.
- `export function tossThrough(tie: CutTie): string[]` = `tie.ranked.slice(0, tie.seats)` (D5: the stored/deterministic lot).

- [ ] **Step 1: Write the failing pure tests.** Rows are hand-built. Each expected value is derived in the test from the rows' ranks, never from `cutTies`:
  - the empty table → `[]` (**state the empty case first**);
  - no tie → `[]`;
  - a 2-way tie at ranks 2-3, q=2 → one tie, `seats 1`, `straddles true`, `place 2`;
  - the same at ranks 1-2, q=2 → `straddles false`, `seats 2` (case 2);
  - a 3-way tie at ranks 1-3, q=2 → pick 2 of 3 (`seats 2`, `size 3`); `tossThrough` = the first 2 of `ranked`;
  - a 2-way tie at ranks 3-4, q=2 → `[]` (below the cut);
  - q=4 with ranks 1-4, two separate 2-way classes → two case-2 ties, none straddling;
  - two straddling classes (a constructed impossible table) → throws;
  - a row with `tieUnbroken` whose `tieWith` names an id with no row → throws (assumption as guard);
  - anti-vacuity: assert the case table's length.
- [ ] **Step 2: The engine premise, DB (Review Focus 3 + D3's base).** In the same file, a `describe` using the DB: a boardgame league of 3, Once, circular results (A beats B, B beats C, C beats A) through the real `scoreEvent` path (chess resign, the skip suite's pattern; extract it to `__tests__/_quick-match-results.ts` as `playWin(fixtureId, winnerEntrantId)`). Assert:
  1. `getStandings(...)` on the ACTIVE league stage gives all three rows `tieUnbroken === true` and `tieBreak.key === "lots"`, with `with` naming the other two;
  2. the row order before `completeStage` equals the order after it, and equals `stage_lots_draws.drawn_order`. This is the premise D3 and D5 stand on. **If it fails, STOP and report: the plan falls back to complete-then-ask.**
- [ ] **Step 3: The per-sport list, pure (P8, Q1).** Enumerate every `sport_key` in `quick-match-offer.generated.json` `offered` (dedup, assert 9). For each, read the default tiebreaker list from the engine module (`resolveModule(...)`, the declaration, not a typed table). Assert the last key is `"lots"`. Record which have `"seed"` before it, and assert that set equals `{tennis, icehockey}`, so a change in the engine moves this test. Report the count.
- [ ] **Step 4: Implement.** **Run** → green.
- [ ] **Step 5: Verify + mutate:** `seats < size` → `<=` (case-2 lines go red); drop the two-straddles throw (its case goes red); `tossThrough` uses `entrantIds` (sorted) instead of `ranked` (the 3-way case goes red).
- [ ] **Step 6: Commit** `feat(quick-match): tell a tie at the cut from a tie among qualifiers`.

---

### Task 3: Create and preview two stages; the Start count; rename

**Files:**
- Modify: `src/server/usecases/quick-match-preview.ts` (`QuickMatchFormat`, `quickMatchStageInput` → `quickMatchStageInputs`, `quickMatchPreview`, the table)
- Modify: `src/server/usecases/quick-match-create.ts` (`:147-256` the tree, `:283-352` the guard, `CreatedQuickMatch`)
- Modify: `src/server/usecases/quick-match-owner.ts:51-57` (D10)
- Test: `src/server/usecases/__tests__/{quick-match-preview,quick-match-preview-table,quick-match-create,quick-match-save,quick-match-admin,quick-match-sweep}.test.ts`, `__tests__/_quick-match-knockout.ts` (`createQuickMatchAnyFormat` learns `league_knockout`)

**Interfaces:**
- Consumes: T1's schema (`format`, `qualifiers`), `QUICK_MATCH_ERRORS.SEMIS_TOO_FEW_SIDES/FORMAT_NOT_OFFERED`, `QUICK_MATCH_SEMIS_MIN_SIDES`; `STAGE_TEMPLATES` (`lib/format-templates.ts`) key `league_ko`; `writeProgressionSetupFixtures` (`stages/index.ts:108`).
- Produces: `type QuickMatchFormat = "league" | "knockout" | "league_knockout"`.
- Produces: `quickMatchStageInputs(input: { format; plays; name; qualifiers: 2 | 4 | null }): QuickMatchStageInput[]`, one entry for league/knockout (today's shape) and two for `league_knockout`: `[league {legs: plays}, the league_ko template's stage[1] built with {qualified: q}, renamed to the match name]`. `QuickMatchStageInput.progression` widens to the template's type. Every caller of the singular name moves.
- Produces: `quickMatchPreview({ format, sides, plays, qualifiers })`: `matchCount` = the sum over the stage inputs (the KO stage previewed at `q` sides); `rounds` = the league's rounds. Produces: `quickMatchPreviewTable()` also holds `` `league_knockout:${sides}:${plays}:${q}` `` cells for every valid combination (q=2 for sides ≥ 3, q=4 for sides ≥ 4).
- Produces: `CreatedQuickMatch.stageId` stays the FIRST stage; adds `knockoutStageId: string | null`.
- Create guard order (after the kind check): `knockout` → 422 `FORMAT_NOT_OFFERED` (unchanged). `league_knockout`: `!offer.knockoutAllowed` → 422 `FORMAT_NOT_OFFERED`; sides < 3 → 422 `FORMAT_NOT_OFFERED` (§3: not offered at 2); q=4 and sides < 4 → 422 `SEMIS_TOO_FEW_SIDES`.
- The tree: `createStages(auth, division.id, inputs.map((s, i) => ({ seq: i + 1, ...s })))`. In the last tx: `generateStageFixturesTx` for the league, then `writeProgressionSetupFixtures(tx, koStage.id)`, then `startDivisionInTx(tx, auth, division.id, leagueStage.id, {})`. Analytics adds `qualifiers`.

- [ ] **Step 1: Failing tests.**
  - Preview (pure): `(league_knockout, 6, 1, 4)` → 18; `(…, 6, 2, 4)` → 33; `(…, 3, 1, 2)` → 4 (the mockup's numbers). Sweep sides 3..6 × plays 1..2 × q: each cell = the league cell + (q − 1), where the expected KO count comes from `quickMatchKnockoutDraws()[\`knockout:${q}:1\`].matchCount`, the generator's own draw, never typed. Assert the swept cell count (12 at q=2 plus 6 at q=4, so 18) and that no `league_knockout:2:*` or `:3:*:4` key exists.
  - Create (DB): `league_knockout`, 4 sides, q=4 → 2 stages (`league` seq 1 with `rngSeed` in config, `knockout` seq 2 with the progression `to: 4`), 6 league + 3 KO fixtures, every KO seat null, slot labels carrying the rank descriptor, no bye line (`isBye` false on all 3), the division `auto_progress` false, `quick_matches.format = 'league_knockout'`, `matchCount` 9. q=2 with 3 sides → 3 + 1.
  - Create refusals: semis with 3 sides → `SEMIS_TOO_FEW_SIDES`; final with 2 sides → `FORMAT_NOT_OFFERED`; plain `knockout` → `FORMAT_NOT_OFFERED` (unchanged); a mocked offer with `knockoutAllowed:false` → `FORMAT_NOT_OFFERED`. Nothing is written (row count unchanged).
  - **Every offered sport (C23):** for each `offered` entry with `knockoutAllowed` (assert 27 > 0, report the count), create `league_knockout` q=2 with 3 sides through `createQuickMatch` → succeeds with 4 fixtures. Each is deleted after (`hardDeleteQuickMatchCompetition`).
  - Rename (`quick-match-save.test.ts` or the owner test): a saved two-stage match renames its competition, division and both stages; a league renames 1 stage. Mutate: the expected count forced to 1 → the two-stage case red.
  - Delete + sweep (`quick-match-sweep.test.ts`): an expired two-stage match is swept. Assert 0 rows left in `stages`, `fixtures`, `stage_seed_proposals` and `stage_lots_draws` for its division (the delete of a two-stage match, brief).
  - Admin (`quick-match-admin.test.ts`): a two-stage match with the league all played and the KO unfilled → `finished` false, `total` = league + q−1.
- [ ] **Step 2: Run** → red. **Step 3: Implement.** **Step 4: Verify** (all files above; scoped tsc). **Mutate:** drop the KO placeholder write → the create case red; drop the semis guard → its refusal case red.
- [ ] **Step 5: Commit** `feat(quick-match): create a League + Knockout as two stages with the bracket drawn from the start`.

---

### Task 4: The advance, the decision, and the stage-aware league rules (server)

**Files:**
- Create: `src/server/usecases/quick-match-advance.ts`
- Create: `src/app/q/[token]/cut/toss/route.ts`, `src/app/q/[token]/cut/pick/route.ts`
- Modify: `src/server/usecases/scoring.ts` (`onDecided`, right after the `maybeAutoAdvance` call, `:1213-1216`): the QM hook ONLY
- Modify: `src/server/usecases/quick-match-skip.ts` (`:70-74` `leagueFinishedFor` → by stage; `:88` the format check)
- Modify: `src/server/usecases/quick-match-add.ts` (`:62-75`)
- Modify: `src/app/q/[token]/match-action-post.ts` (REFUSALS + an optional `after` hook so the skip route advances)
- Modify: `src/app/q/[token]/skip/[fixtureId]/route.ts` (pass `after: advanceQuickMatch`)
- Test: `src/server/usecases/__tests__/quick-match-advance.test.ts` (DB, new), `quick-match-skip.test.ts`, `src/app/q/[token]/__tests__/{cut-route,skip-route,add-match-route}.test.ts`

**Interfaces:**
- Consumes: T1 (`cut_decision`, codes); T2 (`cutRowOf`, `cutTies`, `openTie`, `tossThrough`, `CutTie`); T3 (two-stage create, `QuickMatchFormat`); `completeStage`, `getSeedProposal`, `computeSeedProposal`, `confirmSeedProposal`, `getStandings` (`stages/index.ts`); `systemAuth`; `isQuickMatchFinished`, `playedOf`.
- Produces:
  - `export type CutDecision = { how: "pick" | "toss"; through: string[]; tie: string[]; at: string }`
  - `export type AdvanceState = { state: "plain" } | { state: "league" } | { state: "tie"; tie: CutTie } | { state: "filled" }`
  - `export async function loadLeagueCut(row: QuickMatchRow): Promise<{ leagueStageId: string; koStageId: string; qualifiers: 2 | 4; leagueDone: boolean; ties: CutTie[]; decision: CutDecision | null; filled: boolean } | null>` (null for a non-LK row). One read as the system org. Used by the advance, the decision and T5.
  - `export async function advanceQuickMatch(row: QuickMatchRow): Promise<AdvanceState>`: D2 steps 1-5, under the division advisory lock for its reads (`division:<id>`, the key completion takes, so it serialises with confirm). It clears a stale decision with `update … set cut_decision = null where id = $1 and cut_decision = $2` (compare-and-clear).
  - `export async function decideQuickMatchCut(row: QuickMatchRow, input: { how: "toss" } | { how: "pick"; entrantIds: string[] }): Promise<{ through: string[] }>`. Order: rate limit `qm-cut:<id>` (MUTATION_LIMIT) → `loadLeagueCut` → `filled` or `decision !== null` → 422 `ALREADY_DECIDED` → no open tie → 422 `TIE_NOT_OPEN` → pick: not exactly `seats` distinct ids ⊂ the class → 422 `PICK_INVALID` → the conditional write (zero rows → `ALREADY_DECIDED`). Then the route runs `advanceQuickMatch`.
  - `export async function afterQuickMatchScore(divisionId: string): Promise<void>`: resolves the row by competition (`findQuickMatchByCompetition`) and advances. The scoring hook calls only this.
- Skip changes: `lockedMatch` refuses when `f.stage_kind !== "league"` only (any row format). `leagueFinishedFor(tx, fixtureId)` reads `where stage_id = (select stage_id from fixtures where id = $1)`, the same for a plain league (one stage) and stage-aware for LK (P14). `withQuickMatchFinished` inherits it.
- Add changes: `home.row.format` ∈ {`league`, `league_knockout`}, else `LEAGUE_ONLY`. LK: `addFixture` on the LEAGUE stage id. Refused 422 `LEAGUE_COMPLETE` when `isQuickMatchFinished(playedOf(league rows))`. A plain league keeps today's behaviour.
- Routes: `cut/toss` and `cut/pick` POST, shaped like `match-action-post.ts` (token → usecase → advance (best-effort) → touch → 303 bare home). Pick reads `entrant` form fields (repeated). REFUSALS adds 422 `ALREADY_DECIDED`, `TIE_NOT_OPEN`, `PICK_INVALID`, `LEAGUE_COMPLETE` (add route), 429 → `ACTION_FAILED`.

- [ ] **Step 1: Failing DB sequence tests** (`quick-match-advance.test.ts`). Build through `createQuickMatchAnyFormat`, play through `playToDecided` / `playWin` (T2's helper), skip through the real `skipQuickMatchFixture`. Every expected entrant comes from the results the test made:
  1. **no tie → filled:** 4 sides, Once, q=4, decisive results. After the last league result through `scoreEvent` (the hook, not a direct advance call), the semis hold 1v4 and 2v3 by the stored table's ranks, the league stage is `complete`, and the proposal is `confirmed`.
  2. **final, q=2, 3 sides:** the final holds 1st and 2nd.
  3. **tie → pick → advance (§12, Twice):** 3 sides, Twice, results leaving 2nd/3rd level on every key → `advanceQuickMatch` = `{state:"tie"}`, nothing filled, the league stage still `active`. `decideQuickMatchCut(pick [3rd's id])` → the final holds 1st and the picked side; `cut_decision.how = "pick"`.
  4. **3-way under Once, pick 2 of 3** (Review Focus 3): the circular boardgame table, q=2 → `seats 2`. Toss → the final holds `tossThrough(tie)`, which equals the first two of `stage_lots_draws.drawn_order` after completion.
  5. **tie → toss → reload:** toss, then `loadLeagueCut` twice and `readQuickMatchHome` → the same `through`; `cut_decision.how = "toss"`.
  6. **second decision refused:** after 3, a toss → `ALREADY_DECIDED`, and `cut_decision` is byte-equal to before.
  7. **edit after advance refused (P16):** after 1, a `core.void` of a league fixture's deciding event through the device-link path → 403 `RESULT_CARRIED_FORWARD`, and the event count is unchanged.
  8. **Put back refused after fill:** a league with one match skipped, the rest played → the knockout fills (the skip route's `after`) → `putBackQuickMatchFixture` → 422 `LEAGUE_FINISHED`. **Skip all league → advance:** 3 sides, q=2, every league match skipped → nothing played, all 3 level, so `{state:"tie"}` (3 level sides straddle q=2, pick 2 of 3). Toss → `{state:"filled"}`, and Put back → `LEAGUE_FINISHED`. 4 sides, q=4, all skipped → `{state:"filled"}` at once (case 2, every seat by lot).
  9. **decision then edit (Review Focus 1, §11):** reach a tie (case 3). Write the decision by direct SQL (stand-in for a decision that landed before the advance ran). Then void a league result → `advanceQuickMatch` = `{state:"league"}`, `cut_decision` null, the knockout empty.
  10. **concurrent advances (Review Focus 2):** `Promise.all([advanceQuickMatch(row), advanceQuickMatch(row)])` → both resolve `filled`, one confirmed proposal, one `seed_confirmed` event.
  11. **pad after fill (Review Focus 5):** after 1, append to a settled league fixture through the device link → `RESULT_CARRIED_FORWARD`.
  12. **Add a match:** LK league running → added to the LEAGUE stage. League done (tie pending) → `LEAGUE_COMPLETE`. Plain league done → still allowed (unchanged).
  13. **skip stage-aware (P14):** a knockout fixture → `NOT_SKIPPABLE`; a league fixture of an LK match → skippable; put back while the league is not done → allowed even though the KO is unplayed (division-wide would have said "not finished" for the wrong reason: assert via a league whose other stage is complete).
  14. **plain league unchanged:** `advanceQuickMatch` on a `league` row → `{state:"plain"}` and no write (proposal count 0).
- [ ] **Step 2: Failing route tests** (`cut-route.test.ts`, the usecases mocked as in `skip-route.test.ts`): success → 303 bare home, one advance, one touch; every REFUSALS row → `?e=<code>`; an unknown error → `ACTION_FAILED` + Sentry once; an unknown token → bare home, no usecase. Pick posts `entrant=a&entrant=b` → the usecase receives `["a","b"]`. Run both routes over one case table (assert non-empty and equal lengths). `skip-route.test.ts`: a successful skip calls the advance once, and an advance that throws still lands 303 home.
- [ ] **Step 3: Run** → red. **Step 4: Implement.** The `scoring.ts` hook is `if (auth.orgId === QUICK_MATCH_SYSTEM_ORG_ID) { try { await (await import("./quick-match-advance")).afterQuickMatchScore(context.division_id) } catch (err) { log.error(...) } }`, and nothing else in that file changes.
- [ ] **Step 5: Verify** every test above plus `quick-match-skip.test.ts`, `add-match-route.test.ts`, `skip-route.test.ts`, and the pad suites the skip touched (`device-score-pad-not-played-recheck`, `scan-screen`). Scoped tsc. **Mutate once each:** (a) drop `cut_decision is null` from the write → case 6 red; (b) case 2 confirmed without `tiePicks` → case 1 or 4 red (`SEEDING_TIE_UNRESOLVED`); (c) `leagueFinishedFor` back to division-wide → case 8/13 red; (d) the scoring hook removed → case 1 red (the test drives `scoreEvent`, not the advance); (e) the stale-decision clear removed → case 9 red; (f) the race-loss catch removed → case 10 red.
- [ ] **Step 6: Commit** `feat(quick-match): fill the knockout when the league ends; ask about a tie at the cut once`.

---

### Task 5: The home read model: two stages, league counts, the cut

**Files:**
- Modify: `src/server/usecases/quick-match-home.ts` (`:404-540` `readQuickMatchHome`, `QuickMatchHome` `:318-353`, `QuickMatchFixture`)
- Test: `src/server/usecases/__tests__/quick-match-home.test.ts`, `src/app/q/[token]/__tests__/page.test.tsx` (literal shapes only: add the new fields with their null/plain values)

**Interfaces:**
- Consumes: T4's `loadLeagueCut`, `CutDecision`; T2's `CutTie`.
- Produces on `QuickMatchHome`:
  - `stageId` stays the LEAGUE stage (the add form and the full table read it); `knockoutStageId: string | null`;
  - `QuickMatchFixture.stage: "league" | "knockout"`;
  - `league: { played: number; notPlayed: number; total: number; done: boolean }` (league stage lines only; `done` = `isQuickMatchFinished` of those);
  - `knockout: null | { qualifiers: 2 | 4; filled: boolean; started: boolean /* any KO line live or settled */; tie: CutTie | null /* open, straddling */; decision: CutDecision | null; byLot: string[] /* D6 */; picked: string[]; seatLabels: Record<string, { rank: number } > /* fixtureId:side → the rank descriptor */ }`;
  - `champion: null | { entrantId: string; finalFixtureId: string }` (the final's winner, D8).
- The head read accepts exactly 1 stage for `league`/`knockout` rows and exactly 2 (`league` seq 1, `knockout` seq 2) for `league_knockout`; anything else throws as today. `resultMovedOn` reads each line's OWN stage status. Standings, table rules and metrics come from the league stage. `next` = the first live/ready line among the league's while `!league.done`, else among the knockout's.

- [ ] **Step 1: Failing tests (DB):** (a) LK mid-league: `league.total` 6, `total` 9, every KO line `phase "waiting"`, `knockout.filled` false, `tie` null, `next` a league line. (b) open tie (T4 case 3's setup) → `knockout.tie` set, `filled` false, `league.done` true, `next` null. (c) after fill by toss: `byLot` = the class, `picked` [], `next` = Semi-final 1 / the Final. (d) after fill by pick: `picked` = the pick, `byLot` excludes that class. (e) final decided → `champion` = its winner, `finished` true. (f) the league leader ≠ the champion case: drive the final so the 2nd seed wins → `champion` is 2nd (asserting the winner comes from the final, not the table). (g) a plain league → `knockout` null, `league` equals the top-level counts. (h) a 3-stage competition built by SQL → throws.
- [ ] **Step 2-4:** red → implement → green; scoped tsc. **Mutate:** champion from `standings[0]` → (f) red; `league.total` division-wide → (a) red.
- [ ] **Step 5: Commit** `feat(quick-match): the home reads a league and its knockout`.

---

### Task 6: Setup: the three-choice format list, the count, and the format labels

**Files:**
- Modify: `src/components/quick-match/setup-form.tsx` (`:8`, `:77-78` `matchCountOf`, `:119-138` the post body, `:453-454` the hidden format input)
- Modify: `src/app/[lang]/(marketing)/play/page.tsx` (props: the offer's `knockoutAllowed` per variant)
- Modify: `src/app/api/quick-match/route.ts` (`formInput`, `:84-95`): `shape` → `{format, qualifiers}`
- Modify: `src/components/quick-match/my-list.tsx` (format label), `src/app/admin/quick-matches/page.tsx:165` (format cell, English)
- Test: `src/components/quick-match/__tests__/setup-form.test.tsx`, `src/app/[lang]/(marketing)/play/__tests__/play-page.test.tsx` (find the path with `grep -arl "play-page\|PlayPage" src`), `src/app/api/quick-match/__tests__/create-route.test.ts`, `my-list.test.ts`, `src/app/admin/quick-matches/__tests__/quick-matches-page.test.tsx`

**Interfaces:**
- Produces: `export type SetupShape = "league" | "final" | "semis"`; `export function shapeToFormat(shape: SetupShape): { format: QuickMatchFormat; qualifiers: 2 | 4 | null }`; `export function shapesOffered(sides: number, knockoutAllowed: boolean): { shape: SetupShape; enabled: boolean; reason: MessageKey | null }[]` (2 sides or `!knockoutAllowed` → `[league]` only; 3 sides → semis disabled with `quickMatch.setup.shape.semisNeeds`).
- `matchCountOf(table, sides, plays, shape)` reads the `league_knockout` cells.
- UI (mockup §6): a stacked radio list (`role="radiogroup"`, `name="shape"`), each row full width with title + one-line hint, 44px+. The disabled row keeps its reason visible. "Each pair plays" stays below. When the sides drop below a chosen shape's minimum, the choice falls back to `league` (or `final`), and the count follows. With no JS, the native radios post `shape`.

- [ ] **Step 1: frontend-design skill.** Read mockup §6.
- [ ] **Step 2: Failing tests:** `shapesOffered` over sides 2..6 × `knockoutAllowed` true/false (assert 10 cases checked); the rendered list per state (2 sides: 1 radio; 3 sides: 3 radios, semis `disabled` + the reason; 6 sides: 3 enabled); the Start count from the table equals 18 / 33 / 4 (mockup); `formInput` maps each shape, and an unknown shape fails the parse (422 path); my-list/admin show "League + Knockout".
- [ ] **Step 3-4:** implement → green; scoped tsc. **Mutate:** let semis through at 3 sides → red; drop the fallback on side removal → red.
- [ ] **Step 5: Screens** (local prod build, :8765): the list at 2, 3 and 6 sides × 320/768/1280, with no horizontal scroll and 44px targets.
- [ ] **Step 6: Commit** `feat(quick-match): choose League, League then Final, or League then Semi-finals and Final`.

---

### Task 7: The home: bracket, tie prompt, setting up, champion

**Files:**
- Create: `src/components/quick-match/cut-prompt.tsx` (`"use client"`: the Pick panel; Toss is a plain form)
- Modify: `src/components/quick-match/home.tsx` (`FORMAT_KEY` `:95`, `FLASH` `:121`, `buildHomeView` `:253-500`, the body `:515+`), `draw.tsx` (seat labels, `toDecide`, `rankShort`, `byLotShort`), `standings.tsx` (the "=" rows, the go-through caption, row markers), `match-list.tsx` (league lines only under "League matches")
- Modify: `src/app/q/[token]/page.tsx` (call `advanceQuickMatch(row)` best-effort before the read; fill the cut slots)
- Modify: `src/lib/__tests__/scrub-secret-painters.test.ts` (painter lists for the cut forms)
- Test: `src/app/q/[token]/__tests__/page.test.tsx`, `src/components/quick-match/__tests__/cut-prompt.test.tsx` (new), `draw` / `standings` tests if they exist

**Interfaces:**
- Consumes: T5's `QuickMatchHome` fields, T1's keys and routes, T4's `advanceQuickMatch`.
- Produces (behaviour, mockup §7-12):
  - The eyebrow format reads `quickMatch.format.leagueKnockout`. The played line keeps `playedOf` M (D8), plus ` · ` and `stagePart.split` while the league is on, or `stagePart.knockoutOn` once the knockout has started.
  - Order: hero → share → (league on: standings, then knockout, then league matches) / (knockout started: knockout, then the final league table, then league matches) (§12).
  - The hero: league → today's `upNext` with `{n, total}` = the league's; open tie → the cut prompt (`data-testid="qm-cut"`: kicker plural on seats, title or titleMany, body, `qm-cut-pick` toggles the Pick panel, `qm-cut-toss` posts `routes.quickMatchCutToss`); league done with no tie and not filled → `qm-setting-up` (title, hint, a Refresh link to the same URL); filled, not finished → `upNextRound` with the round's `fixtureLabel`, above it the toss/pick result line when a decision exists (`qm-cut-result`); finished → the champion card (`qm-champion`: `champion`, `championBeat` with the final's settled score, plus `championTopToo` when the champion is rank 1 in the table).
  - The Pick panel (`qm-cut-pick-panel`): one radio (N = 1) or checkboxes (N > 1) per class member, `name="entrant"`, Send (`qm-cut-send`, the label `cut.send` with the chosen names) disabled until exactly N are chosen, and Back. With no JS the panel is a `<details>` and the server validates N.
  - The standings: caption `goThrough`/`wentThrough` {count: q}. During an open tie the class's rows show `=` and `levelToDecide`. After fill: `byLot` rows show `byLot`, `picked` rows show `picked`.
  - The draw: a placeholder seat shows `leagueRank.<n>`; a seat of the open tie shows `toDecide` with that seat; a filled seat shows the name + `rankShort.<n>` (+ ` · byLotShort`); the title shows `knockoutFills` before fill and `knockoutWaiting` during a tie.
  - Add a match is not rendered when `league.done`. The row menus of knockout lines never offer Not played (unchanged rule).
  - `FLASH` gains `ALREADY_DECIDED`, `TIE_NOT_OPEN`, `PICK_INVALID`, `LEAGUE_COMPLETE` (refusal tone).
- [ ] **Step 1: frontend-design skill**; mockup §7-12, layout only.
- [ ] **Step 2: Failing tests** (`page.test.tsx`, server render over `QuickMatchHome` literals; anchor `action="` / `="` per AGENTS.md):
  (a) mid-league LK: the knockout section after the standings, three placeholder seats reading `leagueRank.1`/`.4` etc., `upNext` with the league total, the played line + `stagePart.split` built from the literal's counts;
  (b) open tie: `qm-cut` with the toss form action `="/q/<t>/cut/toss"`, the pick panel posting `/cut/pick` with one input per class member, no `qm-hero`, standings rows `=`, the draw seat `toDecide`, no Add a match;
  (c) setting up: `qm-setting-up`, no hero;
  (d) filled by toss: `qm-cut-result` = `tossResult` with the names, the knockout BEFORE the standings, rows marked `byLot`, the hero = Semi-final 1 / Final;
  (e) filled by pick: `pickResult`, `picked` markers, no `byLot` on that class;
  (f) finished: `qm-champion` from `home.champion`, `championTopToo` only when the champion ranks 1 (both polarities);
  (g) a plain league renders exactly as before (snapshot of the testid set, membership and order, against `main`'s).
  `cut-prompt.test.tsx` (the `renderIsland` harness): Send disabled at 0 and at N+1 chosen, enabled at N; the label names the chosen; a double submit is locked; `pageshow` persisted unlocks.
- [ ] **Step 3-4:** implement → green; scoped tsc. **Mutate:** the knockout never moves above the table → (d) red; Add a match shown when `league.done` → (b) red; the champion from the table → (f) red.
- [ ] **Step 5: Screens** (:8765, matching mockup frames 7-12; states via the real routes on a local prod build): mid-league, tie (question), the Pick panel open, after toss, semis on, champion, setting up (capture it from a test DB state: the league done, no tie, and the KO stage's progression made unresolvable by SQL so the advance fails; never add a product switch for it). Each at 320, 768 and 1280, with `scrollWidth <= innerWidth` and 44px targets.
- [ ] **Step 6: Commit** `feat(quick-match): the home shows the knockout from the start, asks about a tie at the cut, and names the champion`.

---

### Task 8: E2E: setup, home, seven widths

**Files:** `e2e/quick-match.spec.ts` (setup), `e2e/quick-match-home.spec.ts`, `e2e/mobile.spec.ts` (the QM block from `:8374`)

- [ ] **Step 1: `quick-match.spec.ts`:** at 320, 768 and 1280: 2 sides show League only; 3 sides show semis disabled with its reason and League → Final enabled, Start "4 matches"; 6 sides with semis show Start "18", Twice "33"; picking semis then removing sides to 3 falls back and the count follows; Start lands on a home whose eyebrow says League + Knockout. Run with no JS too (one case: `javaScriptEnabled: false`, the radios post).
- [ ] **Step 2: `quick-match-home.spec.ts`:** (1) "League → Semi-finals: play the 6 league matches through the pad → the semis fill (1v4, 2v3 from the table read on screen), the bracket moves above the table, the hero says Semi-final 1; play both semis and the final → Champion". (2) "Tie at the cut, Twice, 3 sides: the question shows; Toss → the result line, reload → the same names; a second phone (new context) posting Toss → the alreadyDecided flash". (3) "Pick: open the panel, Send disabled until one is chosen, Send → the picked side is in the final". (4) "Skip every league match → the knockout fills; a stale Put back post → leagueFinished flash". (5) "Edit result after the fill: the league rows have no Edit result in the ⋯ menu; a stale Score on a league match opens the pad View-only with the locked line". Hit-test with `elementFromPoint`.
- [ ] **Step 3: `mobile.spec.ts`:** one test at the project's width: an LK home in the tie state, then filled. The cut prompt, the Pick panel and the bracket are not clipped (`qmNotClipped`), there is no horizontal scroll, every button is at least 44px and hit-tests true, and axe is clean. Count the elements scanned (anti-vacuity).
- [ ] **Step 4: Run the WHOLE three files in CI:** push, then `gh workflow run e2e.yml --ref feat/quick-match-league-knockout`. A serial-file red is a floor; re-run after each fix.
- [ ] **Step 5: Commit** `test(quick-match): e2e for League + Knockout setup, advance, tie and champion at every width`.

### Task 9: Walkthrough (F): a club night with a knockout

**Files:** `e2e/walkthrough/quick-match.spec.ts` (a new test after (E), `:1447+`)

- [ ] **Step 1:** "(F) four friends pick League → Semi-finals → Final, play the league by taps at 390, see the bracket fill itself, play the semis and the final, and the champion is the final's winner". Read the final state from the DB (`stages.status`, the confirmed proposal, the final's outcome) as well as the screen. A second leg: 3 sides, Twice, steered to a tie at 2nd → Toss → the same result after a reload and on a second context. Derive every expected name from the taps the walkthrough made. Express the budget from the constants (`budgetFor`, AGENTS.md class 20).
- [ ] **Step 2:** Run the whole file in CI (the dispatch above). **Step 3: Commit** `test(quick-match): walkthrough F, a league that ends in a knockout`.

### Task 10: Smoke: a League + Knockout fills on a real server

**Files:** `scripts/smoke/suites/quickMatch.ts` (a new `leagueKnockoutLeg` after `notPlayedLeg`, `:149+`; `createMatch` `:93` learns `shape`)

- [ ] **Step 1:** Create a tagged `league_knockout` q=2 with 3 sides. Before: the home has `qm-knockout` with two `leagueRank` seats and no `qm-cut`. Skip all 3 league matches through their real skip posts. After: `qm-cut` is present (nothing played, so 3 level sides straddle the cut) → POST toss → 303 bare home → the final seats both named in `qm-cut-result`; a second toss → `?e=QUICK_MATCH_ALREADY_DECIDED`; DB `stage_seed_proposals.status = 'confirmed'` for the KO stage. Each `check(...)` names what it got. Teardown goes through `made`. The target guard stays local/CI only.
- [ ] **Step 2:** Run `SMOKE_ONLY=quickMatch` against a local prod build (the `seazn-local-env` recipe), red-mutate once (replace the toss post with a no-op → the checks after it go red), and record the counts. **Step 3: Commit** `test(smoke): a quick match knockout fills itself and a tie is decided once`.

---

## After B6

- The whole-branch review (`reviewer`), with the three standing lenses. The sign-off page on :8765: per-screen verdicts for §6-12 at 320/768/1280.
- Rebase onto `origin/main` at the batch boundary. Renumber V517 if main moved past it. Regenerate `i18n-keys`.
- ONE PR, then CI e2e by dispatch. The merge is the owner's.

## Self-review notes

- **Spec coverage:** §2 formats → T1/T3/T6. §3 offer table → T3 guard + T6 `shapesOffered`. Seeding → T3 (template `rank_order`) + T4 case 1. §4/§12 setup → T6. §5 case 1/2, first decision wins, toss stored → T2/T4/T7. §6 home, hero, add hidden, edit refused → T5/T7, P16. §7 blocks → re-pin log. §8 tests → T2-T10. §11 toss = stored lot, pick N of M, edit recomputes an open tie, setting-up retry → D2-D5, T4 cases 4/5/9, T7 (c). §12 → T6/T7. Admin → T3 (counts), T6 (label). Delete of a two-stage match → T3.
- **Type consistency:** `CutTie`, `cutTies`, `openTie`, `tossThrough` (T2) → T4/T5/T7. `CutDecision`, `AdvanceState`, `advanceQuickMatch`, `decideQuickMatchCut`, `loadLeagueCut`, `afterQuickMatchScore` (T4) → T5/T7. `QuickMatchFormat` incl. `league_knockout` (T3) → T5/T6. `shapeToFormat`, `SetupShape` (T6). The error codes (T1) → T3/T4/T7.

## Open questions for the owner (the plan proceeds on the PO rec; each changes what is built)

1. **Q1 (P8), tennis and ice hockey: `seed` before `lots`.** In a quick match the seed is the order the names were typed. So in these two sports, two sides level on everything at the cut are separated by who was typed first, silently, and the guests are never asked. **Rec:** for League + Knockout quick matches only, store the league stage's tiebreakers as the sport default with `seed` removed. A tie then reaches the lot and the question. The plan as written follows the approved spec ("default list unchanged") and pins the two sports in T2 Step 3, so the change is one line plus that test if you say yes.

Note (not a question): D3 keeps the league editable while a tie question is open, as §11 says. Once the knockout fills, the existing carried-forward rule locks league results (P16).
