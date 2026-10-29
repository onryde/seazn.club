# Format matrix W2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close W2 by making every sport record only what its federation allows: disqualifying sanctions end matches, impossible scores are refused, BWF 3×15 is the badminton default, every visible setting works, and a truth run proves the cup-final paths. Prod ships after this.

**Architecture:** Two PRs, as W2d did. PR A (engine, rules, harness, plus the server and locale lines the engine's exhaustive maps force) lands first, with each sport's lane run in sequence because the lanes share the append-only error-code, HTTP, vocabulary and dictionary files. PR B (the web: editor, pad, API, sign-off, truth run, fold) is cut from main after PR A merges. Every new refusal sits on the write path only (the strict flag or a write-door validator); replay stays lenient, so no finished match moves. Stored data moves only through one pre-deploy migration, listed loudly (D18).

**Tech Stack:** TypeScript (TS7, Node 26), zod, vitest (JSON reporter), Next.js (the repo's non-standard version: read `node_modules/next/dist/docs/` before touching a route), Playwright by CI dispatch only, Stryker, the `tools/matrix` harness.

**Spec:** `docs/superpowers/specs/2026-10-28-format-matrix-w2e-design.md` (approved 2026-10-28, amended f932741628 with D13–D17 and E14–E26, then 1317e07c9c with D18, which reverses D14). Executors read the spec section a task cites before starting it. Inputs: `.superpowers/handoff/2026-10-28-w2e/` (main checkout): `decisions.md`, `inventory.md`, `code-facts-{1..5}-*.md`. Line pins below were read at main `0ad2c765a3`; A0 re-pins them.

## Global Constraints

- Worktrees only. PR A: `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2e`, branch `feat/format-matrix-w2e`, from fresh `origin/main`. PR B: `…/format-matrix-w2e-b`, branch `feat/format-matrix-w2e-b`, from `origin/main` after PR A merges. Never check out in the main repo dir. Never `git stash`.
- `$WT` = the task's worktree. `$S` = the executor's own scratchpad subdirectory (`<scratchpad>/w2e-<task>/`); never `rm` outside it.
- **Scoped tests only.** Never the full vitest suite, the full e2e suite or the gate locally. The verify macros, used by every task:
  - `VERIFY-ENGINE <files>` = `cd $WT/packages/engine && npx vitest run <files> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`, then `node -e 'const r=require(process.argv[1]);console.log(r.numPassedTests+"/"+r.numTotalTests);for(const t of r.testResults)console.log(t.status,t.name)' $S/<name>.json`. Green means EXIT=0, passed = total, total > 0, and every listed file appears in `.testResults[].name` under `$WT`.
  - `VERIFY-WEB <files>` = the same from `cd $WT/apps/web && npx vitest run …`.
  - `VERIFY-MATRIX <files>` = from `$WT`: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=$S/<name>.json --testTimeout=30000 <files>; echo EXIT=$?`, judged the same way.
  - Positionals are literal filename filters: name whole files.
  - When a task edits a status literal, add `apps/web/src/server/__tests__/status-set-sweep.test.ts` to its run.
- tsc is scoped too: `cd $WT/packages/engine && npx tsc --noEmit -p .` and/or `cd $WT/apps/web && npx tsc --noEmit -p .` (never through `rtk`).
- **E2E only by CI dispatch:** `gh workflow run e2e.yml --ref <branch> -f pr=<N>`. A push to the branch cancels a running dispatch. Only `mobile.spec.ts` runs the seven widths. Every other spec runs desktop.
- **Smoke:** new suites go in `scripts/smoke/suites/w2e<Name>.ts`, with a `suite("w2e<Name>", …)` call in `scripts/smoke/main.ts` after the last call (`:1232` at pin), the owner email in `scripts/smoke/harness.ts`'s cleanup list (`:1576-1586`), and a `SELECTABLE_SUITES` entry in `scripts/smoke/index.ts`. `scripts/smoke.ts` no longer exists. Never recreate it.
- **Locale:** any new user-facing string goes into all four of `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `npm run i18n:gen-keys` and `npm run i18n:check`. Never hand-edit `lib/i18n-keys.ts`.
- **Error codes** are appended LAST to `packages/engine/src/core/errors.ts`, in the order the tasks below land: `ENDING_SANCTION_PENDING`, `SET_SCORE_UNREACHABLE`, `CHASE_OVERSHOOT`, `RESULT_METHOD_CONTRADICTS_WINNER`, `ADJUST_OUT_OF_RANGE`. Each code also needs:
  - `core/errors.test.ts`'s ordered list;
  - `apps/web/src/server/api-v1/http.ts` `ENGINE_HTTP` (all 422);
  - `apps/web/src/lib/scoring-vocab.ts` `ENGINE_ERROR_KEY` → `engineError.<CODE>`, plus its copy;
  - `http.test.ts`;
  - an entry in `docs/api-v1-breaking-changes.md` (newest first), naming both strict write paths (`POST /fixtures/{id}/events` and event import), and in `apps/web/src/app/developers/changelog/page.tsx`.
- **Config refusals** are write-door validators that throw `CONFIG_INVALID` with an engine-exported sentence, mapped in `apps/web/src/lib/config-issue-copy.ts` `LOCALIZED_CONFIG_ISSUES`. Never a `configSchema` refine (E15).
- **FOLD_EPOCH:** a sport's MAJOR bump lands in the same commit as its golden re-record (the guard runs `--against HEAD^1`). Each raise appends one line to the comment block in `packages/engine/src/sport/fold-epoch.ts`. Gate: `cd $WT && pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1`.
- **Goldens:**
  - `REBASELINE_GOLDEN=1` for an intended fold change on recorded events.
  - `EXTEND_GOLDEN=1` for a new config.
  - A recorded event that must change gets the one-off floor-batch script of `testkit/GOLDEN-POLICY.md:721-770`.
  - Each run happens in a commit of its own, alongside its bump.
- **Rule rows:**
  - The header is exactly `| id | rule | citation | status | enforced at | proved by |`.
  - A row is signed at plan start with an empty `proved by`, plus an `AWAITING_PROOF` entry `id → task` in `packages/engine/test/rules-reference.ts:48`. The proving commit fills `proved by` and deletes the entry.
  - The proving test's `it`/`describe` TITLE carries the id as a whole token.
- **Test house rules (TEST-STRATEGY.md):**
  - Expected values come from the rulebook or the engine's own declarations, never from the code under test.
  - Every sweep reports its count and fails on zero.
  - Mutate each new guard once (delete the predicate, or `return true`) and see a test go red before calling it green; record the mutation in the commit body.
  - Test the sequence (a second call, after a void, another sport).
  - Every new refusal gets a lenient-replay test (a pre-W2e ledger that breaks it still folds to its recorded result).
- **UI tasks** invoke the `frontend-design` skill first and use the house theme. Screenshots at 1280, 320 and 768 go to an Artifact page with per-screen verdicts, never into the repo. `/admin` is untouched.
- **R27:** PR A's body carries `Matrix rows: <csv>` (or `all`). So does PR B if it touches `packages/engine/**` or `apps/web/src/server/usecases/stages.ts`.
- **D18:** a change that moves stored data ships in Task 13b's migration (runs before deploy: `prod.yml:123-124` migrates, `:132-133` syncs sports, `:206-207` deploys) and is listed in PR A's "Data changes" section and the release notes. No legacy parse default keeps old rows on old behaviour. Schema strips stay only for incoming writes from older clients.
- **Never touch** `stryker-measured.json`, `stryker-timeouts.json` or `scripts/smoke.ts`.
- **Checkpoint 2026-11-15:** if the plan's progress shows W2e cannot merge by 2026-12-01, split the 3×15 work out as the standalone PR (W2a-R4) and tell the owner. Concretely, Task 3's variant/default part, Task 29's picker part and their locale keys.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with the Claude Code line.

## Review Focus

1. **A match already in progress at deploy, with an unended black card or `default` in its ledger.** Its next rally is refused (`ENDING_SANCTION_PENDING`). The pad must open on the ending prompt, not a wedged queue or a dead pad.
   Pinned by Task 30's test `pad opens on the ending prompt for a ledger whose last sanction ends the match` and Task 2's route test with a raw-SQL legacy ledger.
2. **A scorer `core.forfeit` that does NOT follow its own sanction:**
   - after the sanction was voided;
   - against the other side;
   - with another event in between;
   - with the wrong reason (`retired` after a black card, `disqualified` after a volleyball expulsion).
   Every one must still be 403.
   Pinned by Task 2's table test `D13 scorer forfeit is refused unless it is the ending of the side's own ending sanction`.
3. **Switching an existing division between `bwf` and `bwf-3x15` in Settings.** It must apply the target variant's 21/21/30 or 15/15/21. A Settings save that does not touch the variant must leave an existing `bwf` division at 21/21/30.
   Pinned by Task 29's tests `variant switch applies the target variant's fields` and `a format save without a variant change keeps 21/21/30`.
4. **Undo sequences around an ending:**
   - void the forfeit, and the ending is pending again;
   - void the sanction while the forfeit stands, and the match stays ended;
   - void the forfeit then the sanction, and play resumes;
   - a failed second append, and on reload the pad offers the ending.
   Pinned by Task 1's `X-SE-1 void sequences` and Task 30's reload test.
5. **The migration over real stored shapes, run twice:**
   - a hockey division and a fixture frozen with `shootout.suddenDeath`, mid-shoot-out;
   - a generic division and a stage overlay holding `progressScore`;
   - a `fast4` division, a custom tennis division using the Fast4 set shape, and a fixture override whose `set` is Fast4-shaped.
   After the migration the keys are gone and every Fast4 `set` carries `tiebreakWinBy: 2`. Refolding each fixture's ledger gives the same outcome and summary as before, and a second run changes no row.
   Pinned by Task 13b's `D18 migration` tests.

---

# PR A — engine, rules, harness

## Task 0 (A0): Setup, re-pin and the facts the plan could not settle

**Files:**
- Create: `.superpowers/sdd/2026-10-28-format-matrix-w2e/a0-findings.md` (gitignored; main checkout)
- Modify: `packages/engine/rules/*.md` (signed rows); `packages/engine/test/rules-reference.ts` (`AWAITING_PROOF`)
- Modify: spec §4 (new false premises, if any)

**Interfaces:**
- Produces: `a0-findings.md` sections A0.1–A0.9, which later tasks read (A0.7 = the config columns, for Task 13b); the signed row ids listed in each task below; the MD-1 per-file survivor counts (Task 25 reads them).

- [ ] **Step 1: Worktree.**
  - `git fetch origin && git worktree add -b feat/format-matrix-w2e /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2e origin/main`.
  - Install per the `seazn-local-env` skill. A fresh worktree has no `node_modules`.
- [ ] **Step 2: Re-pin.** Re-read every `path:line` in spec §4–§9 and in this plan's tasks on the fresh tree.
  - Write each moved pin as `old → new` in A0.1.
  - Record any claim that no longer holds as a new E-row in spec §4.
- [ ] **Step 3: Rulebook quotes.**
  - Fetch the ITF Rules of Tennis 2026 Appendix VI (`https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf`) and quote §1 and §2 verbatim in A0.2.
    - Confirm the short-set tie-break is first to 5 with a deciding point at 4–4.
    - Confirm whether a short set requires No-Ad.
    - **Stop and ask the owner** if App VI makes short sets No-Ad. Otherwise the 4-all form plays ad games (author's call, spec §5.5).
  - Fetch ICC Playing Conditions 16.10.7 (`https://images.icc-cricket.com/image/upload/prd/igqt8cceiusrtat0ru5u.pdf`) and quote it in A0.3. Name the four NRR operands for (a) a DLS result at abandonment and (b) DLS or revised overs applied earlier.
  - Quote IIHF Rule 84.4 and FIH GTR Appendix 12 §20c/§21b in A0.4. Write down which side starts each series after the first five for each federation.
- [ ] **Step 4: Live checks (drive, don't infer).** Record each in A0.5:
  - (a) RB2B-10: on a local server, drive a hockey and an ice-hockey shoot-out to 5–5 taken, then post the A0.4-legal next attempt via `POST /api/v1/fixtures/{id}/events`. Record the status and code. Expected (code facts 3 §6): refused.
  - (b) The Settings variant switch: create a badminton `bwf` division and switch its variant to `short` in Settings. Read `divisions.config` and record whether `setTo` became 11. If it stays 21, Task 29 owns the fix.
  - (c) The D13 seam: read `apps/web/src/server/usecases/scoring.ts` around the organiser-only check (`:570-587` at pin). Record whether the ledger's last live event is loaded before that check, or how to read it (one query by `fixture_id` order by `seq desc` excluding voided).
  - (d) D18 deploy order: re-read `.github/workflows/prod.yml` and confirm that the Flyway migrate step (`:123-124` at pin) and `npm run sync:sports` (`:132-133`) both run before `flyctl deploy` (`:206-207`), in the same job. **Stop and ask** if the order differs.
    - The migration runs while the old app still serves (`prod.yml:14`, expand/contract). Confirm the old app reads a migrated config without error: the deleted keys have zod defaults, and `set` is a stripping `z.object`.
  - (e) D18 columns: list every column that stores a sport config or a copy of one. Candidates are `divisions.config`, the stage `rules` overlay, `fixtures.rules_override`, `fixtures.config_snapshot`, the `cfg` inside `match_states.state`, `sport_variants.config` (rewritten by `sync:sports`) and any org preset or template table: `git grep -a -n "config_snapshot\|rules_override\|jsonb" db/migration/deltas`. Record them in A0.7 with their partial-or-full shape and the merge rule for a partial (deep or leaf).
    - Count the stored Fast4-shaped `set` objects whose `tiebreak.winBy` is not 2, on stg (standing read permission). **Stop and ask** if the count is above 0: §9 writes 2, which would move those configs.
  - (g) Locate W2d's `data-audit.sql` (`_INDEX.md:4274` says "in the SDD directory": `seazn.club-worktrees/format-matrix-w2d-build/.superpowers/sdd/2026-10-20-format-matrix-w2d/`). Record its path for Task 36.
- [ ] **Step 5: MD-1 sizing.** From `$WT`:
  - `git push -u origin feat/format-matrix-w2e && gh workflow run mutation.yml --ref feat/format-matrix-w2e -f group=all; echo EXIT=$?`
  - Then `gh run list --workflow mutation.yml --branch feat/format-matrix-w2e --limit 1 --json databaseId,headSha,status` (confirm headSha = HEAD).
  - Hand back while it runs. When it finishes, download each in-scope leg's artifact (`mutation-<leg>`) into `$S/md1/`.
  - With a scratch node script, count Survived and NoCoverage per file from `files[path].mutants[].status`, over the sport modules, `core/*`, `stats/stats.ts` and `sport/module.ts`.
  - Write the per-file table, plus the functions of spec §11(b) with their survivor counts, into A0.6.
  - **Put the §11(b) total to the owner before Task 25 starts** (spec §14).
- [ ] **Step 6: Sign the rows.**
  - Add every row id this plan names (Tasks 1–17) to its rules file with status `signed W2e-D<n> 2026-10-28` (or `deviation …`), its rule and citation, and an empty `proved by`.
  - Add `id → "Task N"` to `AWAITING_PROOF`. The ids are listed in each task's Interfaces.
  - Run `VERIFY-ENGINE test/rules-reference.test.ts` and `VERIFY-WEB ../../scripts/__tests__/rules-reference.test.ts` (from `apps/web`, or the CI form at `ci.yml:386-391`). Both green, with the awaiting rows accepted.
- [ ] **Step 7: Commit.** `docs(w2e): sign W2e rule rows; A0 re-pins` (rows plus `AWAITING_PROOF`; spec §4 if changed).

## Task 1 (A1f-engine): The ending-sanction declaration and the pending-ending refusal

**Files:**
- Create: `packages/engine/src/core/sanction-ending.ts`
- Modify: `packages/engine/src/sport/module.ts` (SportModule field), `packages/engine/src/core/events.ts` (refusal in `foldMatchWithStoppage`, beside `:994-1008`), `packages/engine/src/core/errors.ts`, `core/errors.test.ts`
- Modify: `packages/engine/src/sports/setbased/kernel.ts` (`arbitraryEvent` sanction branch `:2748`), `packages/engine/src/sports/nested/kernel.ts` (generator `:2411-2422`)
- Modify (forced by exhaustive maps): `apps/web/src/server/api-v1/http.ts`, `apps/web/src/lib/scoring-vocab.ts`, 4 × `ui.json`, `apps/web/src/server/api-v1/__tests__/http.test.ts`
- Test: `packages/engine/src/core/sanction-ending.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sport/module.ts
  export interface SanctionEndingDecl {
    readonly eventType: string;          // e.g. "badminton.sanction"
    readonly endLevels: readonly string[];    // a sanction at one of these ends the match (D3 (1))
    readonly promptLevels: readonly string[]; // the pad asks "can <team> still field six?" (D12); never auto-ends
  }
  // SportModule gains:  readonly sanctionEnding?: SanctionEndingDecl;
  // core/sanction-ending.ts
  export function pendingEndingSanction(module: SportModule, events: readonly LedgerEvent[]): { by: EntrantId; level: string } | null;
  export function scorerMayForfeit(module: SportModule, lastLive: LedgerEvent | null, forfeit: { by: string; reason: ForfeitReason }): boolean;
  ```
  - `pendingEndingSanction` returns the latest live end-level sanction with no later `core.forfeit`.
  - `scorerMayForfeit` is true only when `lastLive` is that module's `eventType`, with `payload.by === forfeit.by`, and either:
    - `level ∈ endLevels` and `reason === "disqualified"`; or
    - `level ∈ promptLevels` and `reason === "retired"`.
  - Error code `ENDING_SANCTION_PENDING` (422, copy key `engineError.ENDING_SANCTION_PENDING`; en: "This sanction ends the match. Record the ending, or void the sanction, before scoring again.").
  - Rows signed in Task 0 and proved here: `X-SE-1` (no scoring while an ending is pending; void sequences), `X-SE-2` (a sanction alone moves no score: anti-goal 4).
- Consumes: `FoldContext.strict` / `strictFromSeq` (`core/events.ts:548-612,994`); `LINEUP_NOT_SUPPORTED`'s placement (`:996-1008`) as the model.

- [ ] **Step 1: Write the failing tests** in `core/sanction-ending.test.ts`, using a stub module with `sanctionEnding = { eventType: "stub.sanction", endLevels: ["dq"], promptLevels: ["exp"] }` plus every real module that declares one (enumerated, count > 0 asserted). Tests:
  - `X-SE-1 a strict scoring event after an end-level sanction is refused ENDING_SANCTION_PENDING`;
  - `X-SE-1 core.forfeit and core.abandon are still admitted while an ending is pending`;
  - `X-SE-1 replay (no strictFromSeq) folds a pre-W2e ledger with rallies after a black card to its recorded outcome`, using a recorded ledger literal;
  - `X-SE-1 void sequences`, with three cases:
    - void the forfeit → `pendingEndingSanction` non-null and the next rally refused;
    - void the sanction with the forfeit standing → phase `done`;
    - void the forfeit then the sanction → the rally is admitted;
  - `X-SE-1 a prompt-level sanction never makes an ending pending`;
  - `X-SE-2 a sanction at every declared level of every module moves no score` (enumerate the modules × `sanctionLevels`, assert the score is unchanged and count > 0);
  - `scorerMayForfeit truth table`: every combination of {last event is / is not the sanction} × {same / other side} × {endLevel / promptLevel / other level} × {disqualified / retired / walkover}, with the expected value derived from the declaration.
- [ ] **Step 2: Run to verify it fails.** `VERIFY-ENGINE src/core/sanction-ending.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - Add `SanctionEndingDecl` and the field.
  - Write `pendingEndingSanction` and `scorerMayForfeit` (pure; no fold state).
  - In `foldMatchWithStoppage`, keep a running `pending: EntrantId | null` over the resolved events. When `strict` and `pending` and the event type is not `core.forfeit` or `core.abandon`, throw `EngineError("ENDING_SANCTION_PENDING", …, { by, level })`.
  - Append the code, and wire `ENGINE_HTTP` (422), `ENGINE_ERROR_KEY` and the 4 dictionaries, then run `npm run i18n:gen-keys`.
- [ ] **Step 4: Generators.** In the set and nested `arbitraryEvent`, when the drawn sanction level is in the module's `endLevels`, the next emitted event is `core.forfeit { by, reason: "disqualified" }`. Add `X-SE-1 seeded arbitrary streams never build a ledger the write path refuses`: 200 seeds per declaring module, strict fold, count asserted.
- [ ] **Step 5: Run to verify it passes.**
  - `VERIFY-ENGINE src/core/sanction-ending.test.ts src/core/errors.test.ts src/sports/cfg-replay.conformance.test.ts`
  - `VERIFY-WEB src/server/api-v1/__tests__/http.test.ts src/lib/__tests__/scoring-vocab.test.ts`
  - Both tsc runs.
- [ ] **Step 6: Mutate once.** Replace the `pending` check with `false` and confirm the refusal test reds. Then `return true` in `scorerMayForfeit` and confirm the truth table reds.
- [ ] **Step 7: Commit** `feat(engine): ending-sanction declaration and ENDING_SANCTION_PENDING (X-SE-1, X-SE-2)`. Fill `proved by` for X-SE-1/2 and drop them from `AWAITING_PROOF`.

## Task 2 (A1f-server): D13 scorer exception and both strict write paths

**Files:**
- Modify: `apps/web/src/server/usecases/scoring.ts` (organiser-only check, `:577` at pin); `apps/web/src/lib/organiser-only-events.ts` (doc comment naming the exception)
- Test: `apps/web/src/server/engine-db/__tests__/w2e-ending-sanction.test.ts` (`HAS_DB`); extend `apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts`

**Interfaces:**
- Consumes: `scorerMayForfeit`, `pendingEndingSanction` (Task 1); the last-live-event read that A0.5(c) settled.
- Produces: the behaviour Task 30 relies on:
  - a device link or official scorer posting `core.forfeit` right after its own end- or prompt-level sanction gets 201;
  - any other scorer forfeit gets 403;
  - scoring with an ending pending gets 422 `ENDING_SANCTION_PENDING` on `/fixtures/{id}/events` and `import.fold_rejected` with `engineCode: "ENDING_SANCTION_PENDING"` on event import.

- [ ] **Step 1: Write the failing tests** (model: `legacy-untyped-hockey-goal.test.ts`). Tests:
  - `D13 scorer forfeit is refused unless it is the ending of the side's own ending sanction`: a table over device link and official scorer × the Review Focus 2 cases (voided sanction, other side, an event between, wrong reason). Every row 403; the positive rows 201.
  - `D13 organiser forfeit is unchanged` (201 with no sanction).
  - `X-SE-1 a rally after a black card is 422 ENDING_SANCTION_PENDING through the route`.
  - `X-SE-1 a legacy ledger (raw SQL insert of black card then rallies) still reads its recorded outcome and refuses its next rally`.
  - `X-SE-1 event import refuses scoring after an ending sanction` (in `event-import-dryrun.test.ts`).
- [ ] **Step 2: Run, verify FAIL.** `VERIFY-WEB src/server/engine-db/__tests__/w2e-ending-sanction.test.ts src/server/usecases/__tests__/event-import-dryrun.test.ts` (with a test DB per `seazn-local-env`). Expected: the D13 positive rows get 403.
- [ ] **Step 3: Implement.** Before throwing the 403, admit the request when `input.type === "core.forfeit" && scorerMayForfeit(module, lastLive, input.payload)`. Name the exception in the comment block above it (D13, spec §5.2). Event import needs no change if its strict fold already throws (assert it in the test).
- [ ] **Step 4: Run, verify PASS** (same command, plus `src/server/usecases/__tests__/scoring*.test.ts` files that cover the organiser-only branch: `git grep -a -l "Only an organiser" apps/web/src/server`).
- [ ] **Step 5: Mutate once.** Drop the `scorerMayForfeit` condition (admit any scorer forfeit) and confirm the table reds.
- [ ] **Step 6: Commit** `feat(scoring): D13 scorer may record the ending of its own ending sanction`.

## Task 3 (A1a): Badminton 3×15 variant, explicit `bwf`, black-card ending; volleyball prompt levels

**Files:**
- Modify: `packages/engine/src/sports/setbased/badminton.ts` (`variants` `:39-43`, `sanctionEnding`), `packages/engine/src/sports/setbased/volleyball.ts` (`sanctionEnding`), `packages/engine/src/sport/fold-epoch.ts`, `packages/engine/src/sports/setbased/badminton.golden.json`
- Modify: `apps/web/src/lib/variant-label-keys.ts` (`:10`), 4 × `ui.json`, `apps/web/src/lib/match-length.ts` (`:45-46`)
- Test: `packages/engine/src/sports/setbased/w2e-badminton.test.ts`

**Interfaces:**
- Produces:
  - variant `"bwf-3x15": { bestOf: 3, setTo: 15, finalSetTo: 15, winBy: 2, cap: 21 }`;
  - `bwf` becomes `{ setTo: 21, finalSetTo: 21, cap: 30 }` (defaults unchanged);
  - `badminton.sanctionEnding = { eventType: "badminton.sanction", endLevels: ["disqualification"], promptLevels: [] }`;
  - `volleyball.sanctionEnding = { eventType: "volleyball.sanction", endLevels: [], promptLevels: ["expulsion", "disqualification"] }`;
  - `FOLD_EPOCH.badminton` 1 → 2;
  - label keys `variant.badminton.bwf-3x15` (en "BWF 3×15 (15 points)"; `bwf` relabelled "BWF 3×21 (21 points)");
  - `match-length` `"badminton:bwf-3x15": 30` (author's call: between `short` 25 and `bwf` 40).
- Rows: `BD-VR-1` (3×15 variant, RB2A-1), `BD-SE-1` (black card ends the match, X-RT-1 credit), `VB-SE-1` (DQ or expulsion never ends; the field-six question, D12).

- [ ] **Step 1: Failing tests** in `w2e-badminton.test.ts`:
  - `BD-VR-1 bwf-3x15 plays 15, win by 2, cap 21 (RB2A-1)`:
    - fold 15–13 and 21–20 sets; refuse a 22–20 summary;
    - the values are asserted against RBS RB2A-1's text, not the variant object.
  - `BD-VR-1 bwf stays 21/21/30 and equals the module defaults` (parse both and deep-equal).
  - `BD-VR-1 anti-goal 2: a recorded pre-W2e bwf division config parses to 21/21/30` (literal from `server/engine-db/__tests__/fixtures/w2d-pin-before.json` or a hand literal).
  - `BD-SE-1 a black card followed by core.forfeit{disqualified} ends the match for the other side with the retirement credit`: assert the outcome `award` and the credit from `setBasedForfeitCredit`'s declaration.
  - `VB-SE-1 a volleyball disqualification alone leaves the match live; forfeit{retired} after it ends it`.
- [ ] **Step 2: Run, verify FAIL.** `VERIFY-ENGINE src/sports/setbased/w2e-badminton.test.ts`.
- [ ] **Step 3: Implement** the variant and declaration changes. Raise `FOLD_EPOCH.badminton` to 2, with its comment line.
- [ ] **Step 4: Goldens.**
  - Re-record the one badminton stream holding a `disqualification` then scoring (seam check: event 12 then 30 events), using the floor-batch script if its events must change.
  - Then `EXTEND_GOLDEN=1` for the new `bwf-3x15` config.
  - `VERIFY-ENGINE src/testkit/golden.test.ts src/testkit/golden-floor-streams.test.ts`.
- [ ] **Step 5: Web labels.** Add the label keys in 4 locales and run `i18n:gen-keys`. Then `VERIFY-WEB src/server/public-site/__tests__/variant-label.test.ts src/components/v2/__tests__/match-rules-block.test.tsx` (the second pins a module×variant count; update it to the new count, derived from `Object.keys(module.variants)`).
- [ ] **Step 6: Run all PASS,** including `src/sports/setbased/setbased.test.ts src/sport/fold-epoch.test.ts`, the fold-epoch guard and `pnpm sync:sports` against the local DB.
- [ ] **Step 7: Mutate once.** Set `endLevels: []` for badminton and confirm BD-SE-1 reds.
- [ ] **Step 8: Commit** (golden re-record plus bump in one commit) `feat(badminton): bwf-3x15 variant, explicit bwf, black card ends the match (BD-VR-1, BD-SE-1, VB-SE-1)`.

## Task 4 (A1b-1): Tennis `default` ending and SC-S1 reachable set scores

**Files:**
- Modify: `packages/engine/src/sports/tennis/tennis.ts` (`sanctionEnding`), `packages/engine/src/sports/nested/kernel.ts` (`applySetSummary` `:1357-1376`), `core/errors.ts` (+`SET_SCORE_UNREACHABLE`), `fold-epoch.ts`, `tennis.golden.json`, the web code maps and 4 dictionaries
- Test: `packages/engine/src/sports/nested/w2e-tennis.test.ts`

**Interfaces:**
- Produces:
  - `tennis.sanctionEnding = { eventType: "tennis.sanction", endLevels: ["default"], promptLevels: [] }`;
  - `export function reachableLiveGames(h: number, a: number, rules: SetRules): boolean` in `nested/kernel.ts`: true iff a path from 0–0 to h–a exists that never passes a finished score or `tiebreakAt`–`tiebreakAt`; memoised; bounded by `gamesFieldBound`;
  - `SET_SCORE_UNREACHABLE` (422) replaces the strict branch's `invalid` for unreachable plain-games summaries;
  - `FOLD_EPOCH.tennis` 1 → 2, `FOLD_MINOR.tennis` → 0.
- Rows: `TN-SE-1` (`default` ends the match), `TN-SS-1` (a set summary must be reachable, SC-S1).

- [ ] **Step 1: Failing tests:**
  - `TN-SS-1 tour: 8–6, 9–7 and 10–8 are refused; 6–4 and 7–5 are accepted`;
  - `TN-SS-1 fast4: 5–3 and 6–4 refused; 4–2 accepted`;
  - `TN-SS-1 a custom set {gamesTo 6, winBy 2, tiebreakAt 3} accepts 8–6` (the walk-back, not the closed form; code facts 2 §1.3).
  - Expected values come from RBS `:343-350`'s table, transcribed with its line cited. Each refusal asserts code `SET_SCORE_UNREACHABLE`.
  - `TN-SS-1 replay folds a pre-W2e 8–6 summary leniently`.
  - `TN-SE-1 a default followed by forfeit{disqualified} ends the match; a rally in between is refused ENDING_SANCTION_PENDING`.
- [ ] **Step 2: Run, verify FAIL.** `VERIFY-ENGINE src/sports/nested/w2e-tennis.test.ts`.
- [ ] **Step 3: Implement** `reachableLiveGames`, used in place of the one-step `wasLive`; the declaration; the code plus its web maps and copy (en: "That set score cannot happen under this set's tie-break.").
- [ ] **Step 4: Goldens.** Re-record streams 23 and 29 (a `default` followed by scoring) and raise the epoch in the same commit. `VERIFY-ENGINE src/testkit/golden.test.ts src/testkit/golden-floor-streams.test.ts src/sports/nested/nested.test.ts src/sports/cfg-replay.conformance.test.ts`.
- [ ] **Step 5: Mutate once.** Return to the one-step check and confirm the 8–6 test reds.
- [ ] **Step 6: Commit** `feat(tennis): default ends the match; refuse unreachable set scores (TN-SE-1, TN-SS-1)`.

## Task 5 (A1b-2): RB2A-12 short sets and a per-tie-break margin

**Files:**
- Modify: `packages/engine/src/sports/nested/kernel.ts` (`NestedSetCfg` `:77-82`, schema `:172-208`, `applyTbPoint` `:1032`, TB summary `:1339`, `tbFieldBound` `:1576-1583`), `packages/engine/src/sports/tennis/tennis.ts` (variants `:27-44`), `packages/engine/src/testkit/golden.ts` (`MAX_CONFIGS` `:98,250`), `tennis.golden.json`, `tennis.schema.json` (regenerated)
- Modify: `apps/web/src/lib/variant-label-keys.ts` (tennis `:41-46`), 4 × `ui.json`
- Test: `w2e-tennis.test.ts` (extend)

**Interfaces:**
- Produces:
  - `NestedSetCfg.tiebreakWinBy?: number`. Absent means `cfg.tiebreak.winBy`, today's behaviour for every non-Fast4 set. Existing Fast4 configs get an explicit 2 from Task 13b's migration (D18), not from a legacy default.
  - The set tie-break reads `set.tiebreakWinBy ?? tiebreak.winBy`. The MTB keeps `tiebreak.winBy`.
  - Variant `"short-sets": { set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5, tiebreakWinBy: 1 } }` (ad games unless A0.2 says otherwise).
  - `fast4.set` gains `tiebreakWinBy: 1`.
  - `MAX_CONFIGS` 4 → 5.
  - Labels: `variant.tennis.short-sets` (en "Short sets (TB at 4–4)"), `variant.tennis.fast4` relabelled "Short sets, TB at 3–3 (Fast4)".
- Row: `TN-SS-2` (RB2A-12).

- [ ] **Step 1: Failing tests:**
  - `TN-SS-2 short-sets: 4–2 and 5–3 accepted, 5–4 needs a tie-break, 6–4 refused`;
  - `TN-SS-2 the short-set tie-break closes at 5–4 (deciding point at 4–4, App VI §2)`;
  - `TN-SS-2 fast4: 5–3 refused, a 5–4 tie-break closes`;
  - `TN-SS-2 the match tie-break keeps its own margin: a 10–9 MTB plays on`;
  - `TN-SS-2 a fast4 division created now plays margin 1`, with the variant parsed through `configSchema`. Existing Fast4 configs are covered by Task 13b.
  - Values from A0.2's quote and RBS `:345-347`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Regenerate the schema snapshot. Raise `MAX_CONFIGS`, then `EXTEND_GOLDEN=1` (the `fast4` golden config is a recorded literal and does not move).
- [ ] **Step 4: Run PASS:** `VERIFY-ENGINE src/sports/nested/w2e-tennis.test.ts src/testkit/golden.test.ts src/testkit/schema-snapshot.test.ts src/sports/nested/padspec.test.ts` and `VERIFY-WEB src/server/public-site/__tests__/variant-label.test.ts src/lib/match-rules/__tests__/tennis.contract.test.ts`.
- [ ] **Step 5: Mutate once.** Read `tiebreak.winBy` for the set TB and confirm the 5–4 test reds.
- [ ] **Step 6: Commit** `feat(tennis): short sets with a deciding-point tie-break (TN-SS-2)`.

## Task 6 (A1c-1): Cricket chase overshoot (SC-C4)

**Files:**
- Modify: `packages/engine/src/sports/cricket/cricket.ts` (`applySummary` after `:1713`; generator coarse branch `:4155-4190`), `core/errors.ts` (+`CHASE_OVERSHOOT`), web code maps and copy, `fold-epoch.ts`, `cricket.golden.json`
- Test: `packages/engine/src/sports/cricket/w2e-cricket.test.ts`

**Interfaces:**
- Produces: a strict-only refusal `CHASE_OVERSHOOT` when `isChaseIndex(next, index) && payload.runs > chaseTarget(next) - 1 + 7` (en copy from RB2A-22: "A chase ends at the winning run — check the total."). `FOLD_EPOCH.cricket` 1 → 2.
- Row: `CK-CH-1` (RB2A-22; Laws 16.5).

- [ ] **Step 1: Failing tests:**
  - `CK-CH-1 a coarse chase total of target−1+8 is refused CHASE_OVERSHOOT; target−1+7 is accepted`, with targets 18, 100 and a DLS `revisedTarget`;
  - `CK-CH-1 first innings totals are unbounded`;
  - `CK-CH-1 replay folds golden stream 29's pre-W2e overshoot leniently`;
  - `CK-CH-1 the generator's coarse chase never exceeds the bound` (500 seeds, count asserted).
- [ ] **Step 2: Run, verify FAIL.** `VERIFY-ENGINE src/sports/cricket/w2e-cricket.test.ts`.
- [ ] **Step 3: Implement** the check, the generator clamp and the code.
- [ ] **Step 4: Golden.** Re-record stream 29 with the bump in one commit. `VERIFY-ENGINE src/testkit/golden.test.ts src/sports/cricket/cricket.test.ts` and `VERIFY-MATRIX tools/matrix/__tests__/streams.test.ts`.
- [ ] **Step 5: Mutate once** (drop the `+ 7`) and confirm a red.
- [ ] **Step 6: Commit** `feat(cricket): refuse a chase total past the winning run (CK-CH-1)`.

## Task 7 (A1c-2): `superOverStillTied` held by the super over

**Files:**
- Modify: `packages/engine/src/sports/cricket/cricket.ts` (`ruleKeys` `:3623`)
- Test: `packages/engine/src/sport/rule-keys.test.ts`

**Interfaces:**
- Produces: `superOverStillTied: { scope: "stage", detailOf: "superOver" }`. Task 28's field is then disabled while the super over is off (`detailIsInert`), so it is never an inert control (anti-goal 3).

- [ ] **Step 1: Failing test** `cricket superOverStillTied is a detail of superOver` in `rule-keys.test.ts`.
- [ ] **Step 2: Run FAIL, implement, run PASS:** `VERIFY-ENGINE src/sport/rule-keys.test.ts src/sport/stage-defaults.test.ts` and `VERIFY-WEB src/components/v2/stage-rules/__tests__/stage-row-model.test.ts`.
- [ ] **Step 3: Mutate once** (remove `detailOf`) and confirm a red.
- [ ] **Step 4: Commit** `feat(cricket): superOverStillTied is a super-over detail`.

## Task 8 (A1c-3): DLS NRR under ICC 16.10.7 for every cricket match (RB2A-20, SC-C5, D18)

**Files:**
- Modify: `packages/engine/src/sports/cricket/cricket.ts` (`standingsDelta` `:3917-4024`), `fold-epoch.ts` (`FOLD_MINOR.cricket` 0 → 1), `cricket.golden.json` (deltas of stream 25, the only `method: "dls"` stream)
- Test: `w2e-cricket.test.ts` (extend)

**Interfaces:**
- Produces: `standingsDelta` credits the four NRR operands per ICC 16.10.7 (A0.3's quote) for a match decided by DLS or with revised overs, for every cricket config. There is no method key, no creation stamp and no freeze (D18 reverses D14). No cricket exists in prod, and the change is listed in PR A's "Data changes".
- Row: `CK-NRR-1` (ICC 16.10.7).

- [ ] **Step 1: Failing tests.** Operands come from A0.3's quote, with the arithmetic shown in the test comment:
  - `CK-NRR-1 DLS applied earlier: Team 1 is credited target−1 off Team 2's allocated overs`;
  - `CK-NRR-1 DLS at abandonment: Team 1 is credited Team 2's par off Team 2's overs faced` (par from the exported `dlsPar`);
  - `CK-NRR-1 a non-DLS match's ledger is unchanged` (positive pair);
  - `CK-NRR-1 a table with a DLS match orders by the ICC NRR` (through `competition/tiebreakers.ts` `nrr`).
- [ ] **Step 2: Run, verify FAIL.** `VERIFY-ENGINE src/sports/cricket/w2e-cricket.test.ts`.
- [ ] **Step 3: Implement** the `standingsDelta` branch. Then run `REBASELINE_GOLDEN=1` for stream 25's deltas and raise `FOLD_MINOR.cricket` in the same commit (deltas only; the guard decides MINOR versus MAJOR, follow it).
- [ ] **Step 4: Run PASS:** `VERIFY-ENGINE src/sports/cricket/w2e-cricket.test.ts src/sports/cricket/cricket.test.ts src/testkit/golden.test.ts src/competition/table-points-parity.test.ts`, plus the fold-epoch guard.
- [ ] **Step 5: Mutate once.** Restore the old credit for the DLS-earlier case and confirm a red.
- [ ] **Step 6: Commit** `feat(cricket): DLS NRR per ICC 16.10.7 (CK-NRR-1)`.

## Task 9 (A1d): Period kernel: delete `suddenDeath`; shoot-out series order (RB2B-10)

**Files:**
- Modify: `packages/engine/src/sports/period/kernel.ts` (`:100`, schema `:218-225`; `applyShootoutAttempt` `:1380-1385`; generator `:2962`), `packages/engine/src/sports/period/shootout.ts` (`expectedKicker` `:80-85`), `packages/engine/src/sports/hockey/hockey.ts` (`:145`), `packages/engine/src/sports/icehockey/icehockey.ts` (`:166`), `packages/engine/src/testkit/golden.ts` (`:1123`), `hockey/icehockey .schema.json`, `hockey/icehockey .golden.json`, `DOMAIN.md` rows, `fold-epoch.ts`
- Modify: `apps/web/src/lib/match-rules/hockey.ts` (`:30`), `apps/web/src/lib/match-rules/icehockey.ts` (`:68`), plus the tests that assert the key: `components/v2/__tests__/match-rules.test.ts:39`, `lib/__tests__/rule-scope.test.ts:27,207,214`, `server/usecases/__tests__/fixture-override-guards.test.ts:238-239`; engine `sport/stage-defaults.test.ts:223`, `competition/decided-in.test.ts:59`, `sport/can-end-level.test.ts:72`, `sport/rule-keys.test.ts:626`, `sports/period/padspec.test.ts:42`, `sports/time-kernel.conformance.test.ts:578`
- Modify: `tools/matrix/catalogue/*` (regenerated in Task 24, not here)
- Test: `packages/engine/src/sports/period/w2e-period.test.ts`

**Interfaces:**
- Produces:
  - The `shootout` schema strips `suddenDeath` before its strict parse, for incoming writes from older clients: `z.preprocess(dropKeys(["suddenDeath"]), z.strictObject({...}))`. Stored copies are removed by Task 13b (D18).
  - `type ShootoutOrder = "ifab" | "fih-series" | "iihf-tiebreak"` on `PeriodPreset.shootoutOrder` (football `"ifab"`, hockey `"fih-series"`, icehockey `"iihf-tiebreak"`), with the exact series rules from A0.4.
  - `expectedKicker(kicks, order: ShootoutOrder): Side | null`.
  - The alternation refusal becomes strict-only (lenient replay keeps old-order streams folding).
  - `FOLD_EPOCH.hockey` 4 → 5, `FOLD_EPOCH.icehockey` 2 → 3.
  - Pad: `summary.shootoutNext` follows the new order, so the tile the pad enables (`period-shared.ts:929-946`) follows it with no web change.
- Rows: `HK-SO-1`, `IH-SO-1` (series order, RB2B-10); `HK-SO-2`, `IH-SO-2` (`deviation`: repeat sudden-death overtime not offered, D4, RB2B-38).

- [ ] **Step 1: Failing tests:**
  - `HK-SO-1 after 5–5 the team that started the first series defends first in the second (FIH App 12 §20c/21b)`;
  - `IH-SO-1 tie-break shots: the team that shot second in the first five starts (IIHF 84.4)`;
  - `football keeps IFAB order` (positive pair);
  - `HK-SO-1 replay folds a pre-W2e shoot-out recorded in the old order`;
  - `HK-SO-2 an old config carrying shootout.suddenDeath parses and the key is gone` (from `server/engine-db/__tests__/fixtures/w2d-pin-before.json`'s hockey and icehockey configs; count of configs read > 0);
  - `HK-SO-2 no module declares suddenDeath` (schema shape check).
- [ ] **Step 2: Run, verify FAIL.** `VERIFY-ENGINE src/sports/period/w2e-period.test.ts`.
- [ ] **Step 3: Implement** the deletion with its strip, the order type and the strict-only alternation. If A0.5(a) showed the legal order is ACCEPTED today, keep only the rows and tests and record the false premise.
- [ ] **Step 4: Goldens and bumps in one commit.** `REBASELINE_GOLDEN=1` for hockey and icehockey (8 + 25 streams carry the key; streams hockey 17, 21 and icehockey 3, 4, 12 move `shootoutNext`). Then `VERIFY-ENGINE src/testkit/golden.test.ts` plus every engine test file listed under Files.
- [ ] **Step 5: Web.** Remove `suddenDeath` from the two match-rules builders and update the four web tests. `VERIFY-WEB src/components/v2/__tests__/match-rules.test.ts src/lib/__tests__/rule-scope.test.ts src/server/usecases/__tests__/fixture-override-guards.test.ts src/lib/match-rules/__tests__/hockey.contract.test.ts src/lib/match-rules/__tests__/icehockey.contract.test.ts`. Keep `pad.pp.suddenDeath` and the tennis `suddenDeathTiebreaks` keys (code facts 3 §5a).
- [ ] **Step 5b: D11 (a).** `VERIFY-WEB src/components/v2/stage-rules/__tests__/stage-points-model.test.ts`. If any hockey `reachableOutcomes` or `presetOffered` answer moved, add `D11a the hockey 3/2/1/0 (shoot-out) chip stays hidden where it equals the stage default` there. Otherwise record "unmoved" in the commit body.
- [ ] **Step 6: Mutate once** (`expectedKicker` back to `kicks[0].side`) and confirm HK-SO-1 reds.
- [ ] **Step 7: Commit** `feat(period): federation shoot-out order; delete inert suddenDeath (HK/IH-SO-1/2)`.

## Task 10 (A1e-1): Chess result method must agree with its winner (RB2B-20)

**Files:**
- Modify: `packages/engine/src/sports/boardgame/boardgame.ts` (`apply` `:910-920`; export `DECISIVE_METHODS`, `DRAWN_METHODS` `:595-608`), `core/errors.ts` (+`RESULT_METHOD_CONTRADICTS_WINNER`), web maps and copy, `fold-epoch.ts` (boardgame 3 → 4)
- Test: `packages/engine/src/sports/boardgame/w2e-boardgame.test.ts`

**Interfaces:**
- Produces:
  - Under `isStrictFold(ctx)`, a method in `DRAWN_METHODS` only (not in `DECISIVE_METHODS`) with a winner, or in `DECISIVE_METHODS` only with `winner: null`, is refused `RESULT_METHOD_CONTRADICTS_WINNER`.
  - `adjudication` (in both) and an absent method are free.
  - The web pad's restated lists (`skins/boardgame.tsx:160-175`) import the engine's exports instead of restating them.
- Row: `BG-RS-1` (FIDE Arts 5.1, 5.2, 9.2–9.6, rulebook `goals-boards.md:427`).

- [ ] **Step 1: Failing tests:**
  - `BG-RS-1 every method × winner shape` (enumerate the engine lists; count = methods × 3 shapes; expected from the lists);
  - `BG-RS-1 replay folds a stored {winner, "stalemate"}`.
- [ ] **Step 2: FAIL → implement (bump; no golden re-record, 0 of 76 contradict) → PASS:**
  - `VERIFY-ENGINE src/sports/boardgame/w2e-boardgame.test.ts src/sports/boardgame/boardgame.test.ts src/testkit/golden.test.ts`;
  - `VERIFY-WEB src/components/v2/scorepad/v3/skins/__tests__/boardgame.test.ts`.
- [ ] **Step 3: Mutate once** (drop the strict gate condition) and confirm a red.
- [ ] **Step 4: Commit** `feat(boardgame): a result's method must agree with its winner (BG-RS-1)`.

## Task 11 (A1e-2): Carrom adjust bound in the engine (SC-O9)

**Files:**
- Modify: `packages/engine/src/sports/carrom/carrom.ts` (`applyAdjust` `:438-466`), `core/errors.ts` (+`ADJUST_OUT_OF_RANGE`), web maps and copy, `fold-epoch.ts` (carrom 3 → 4)
- Test: `packages/engine/src/sports/carrom/w2e-carrom.test.ts`

**Interfaces:**
- Produces: a strict-only refusal `ADJUST_OUT_OF_RANGE` unless `1 ≤ |delta| ≤ cfg.gameTo`. The bound is the pad's (`:741,754`), read from cfg, never typed.
- Row: `CA-AD-1`.

- [ ] **Step 1: Failing tests** `CA-AD-1 delta ±gameTo accepted, ±(gameTo+1) refused, for gameTo 25 and club-29's 29` (from the variant declarations), plus a lenient replay case.
- [ ] **Step 2: FAIL → implement → PASS:** `VERIFY-ENGINE src/sports/carrom/w2e-carrom.test.ts src/sports/carrom/carrom.test.ts src/testkit/golden.test.ts`.
- [ ] **Step 3: Mutate once** and confirm a red. **Commit** `feat(carrom): bound game.adjust by gameTo (CA-AD-1)`.

## Task 12 (A1e-3): Delete generic `progressScore` (D6)

**Files:**
- Modify: `packages/engine/src/sports/generic/generic.ts` (`:51-53`, variants `:611,617`), `generic.schema.json`, `generic.golden.json` (re-record), `generic/DOMAIN.md:56`, `testkit/golden.ts:1010`, `testkit/simulation.ts:100`, `fold-epoch.ts` (generic 3 → 4)
- Modify (tsc/test forced): `apps/web/src/components/v2/scorepad/__tests__/module-client.test.ts:75`, `apps/web/src/components/v2/__tests__/division-format-patch.test.ts:96-127` (rewrite on a key generic still declares), `apps/web/src/components/v2/division-format-patch.ts:28-31` (comment), `apps/web/src/lib/__tests__/funnel.test.ts:44,129`, `packages/engine/src/competition/division.test.ts` (typed cfg)
- Test: `packages/engine/src/sports/generic/w2e-generic.test.ts`

**Interfaces:**
- Produces: `GenericCfg` without `progressScore`. Incoming writes from older clients strip on parse (zod strip mode); stored copies are removed by Task 13b's migration (D18). `v1-map.ts` and the Advanced placeholder are Task 33's.

- [ ] **Step 1: Failing tests:**
  - `D6 a recorded generic config with progressScore parses without it and folds a ledger raw`;
  - `D6 generic declares no progressScore`.
- [ ] **Step 2: FAIL → implement → `REBASELINE_GOLDEN=1` (106 states in 64 streams) with the bump in one commit → PASS:**
  - `VERIFY-ENGINE src/sports/generic/w2e-generic.test.ts src/sports/generic/generic.test.ts src/testkit/golden.test.ts src/testkit/schema-snapshot.test.ts src/competition/division.test.ts`;
  - `VERIFY-WEB src/components/v2/scorepad/__tests__/module-client.test.ts src/components/v2/__tests__/division-format-patch.test.ts src/lib/__tests__/funnel.test.ts`.
- [ ] **Step 3: Commit** `feat(generic): delete inert progressScore (D6)`.

## Task 13 (A1g): Write-door config validators: ruling 31 floor and Bo1 + MTB

**Files:**
- Modify: `packages/engine/src/sport/module.ts` (`configWriteIssues`), `packages/engine/src/sports/setbased/kernel.ts` (`SetBasedPreset.minSetTo?`), `volleyball.ts` / `tabletennis.ts` (`minSetTo: 5`), `packages/engine/src/sports/tennis/tennis.ts` (Bo1+MTB)
- Modify: `apps/web/src/server/usecases/divisions.ts` (`:313`, `:1082`, `:1161`), `templates.ts:252`, `stage-rules-merge.ts:112`, `fixture-rules.ts:159-181`, `apps/web/src/lib/config-issue-copy.ts` (`:34-37`), 4 × `ui.json` (`rules.err.*`)
- Test: `packages/engine/src/sport/config-write-issues.test.ts`; `apps/web/src/server/usecases/__tests__/w2e-config-write.test.ts` (`HAS_DB`)

**Interfaces:**
- Produces:
  - `SportModule.configWriteIssues?: (cfg: Cfg) => readonly string[]`;
  - `export function writeConfigIssues(module: SportModule, cfg: unknown): readonly string[]` (empty when the module declares none);
  - the exported sentences `SET_TARGET_BELOW_FLOOR = "A set must be played to at least 5 points."` and `BO1_MATCH_TIEBREAK = "A match tie-break replaces a deciding set; best of 1 has none."` (RB2A-13 copy);
  - every write door throws `CONFIG_INVALID { issues }` when the list is non-empty;
  - `configSchema` is unchanged, so stored configs still load (E15).
- Rows: `VB-CF-1`, `TT-CF-1` (ruling 31), `TN-CF-1` (RB2A-13).

- [ ] **Step 1: Failing engine tests:**
  - `VB-CF-1/TT-CF-1 setTo or finalSetTo below 5 yields SET_TARGET_BELOW_FLOOR; 5 is clean; badminton declares no floor (its editor min is 11)`;
  - `TN-CF-1 bestOf 1 with finalSet {matchTiebreakTo} yields BO1_MATCH_TIEBREAK; bestOf 3 with it is clean`;
  - `E15 configSchema still parses a volleyball setTo 3 config` (so the ~20 existing `setTo: 3` tests stay valid).
- [ ] **Step 2: Failing server tests:** `VB-CF-1 each write door (create, patch, template, stage rules, fixture override) refuses 422 CONFIG_INVALID with the sentence`, and `an existing setTo 3 volleyball division still loads its pad bootstrap` (`fidelity.ts:57` returns non-null).
- [ ] **Step 3: FAIL → implement → PASS:** `VERIFY-ENGINE src/sport/config-write-issues.test.ts` and `VERIFY-WEB src/server/usecases/__tests__/w2e-config-write.test.ts src/lib/__tests__/config-issue-copy.test.ts`.
- [ ] **Step 4: Mutate once** (`configWriteIssues` returns `[]`) and confirm a red. **Commit** `feat(config): write-door floor and Bo1+MTB refusals (VB-CF-1, TT-CF-1, TN-CF-1)`.

## Task 13b (A1h): The stored-config migration (D18)

**Files:**
- Create: `db/migration/deltas/V480__w2e_stored_config_cleanup.sql`. The number is main's max + 1 at rebase (V479 at pin); whoever lands second renumbers. While PR A is unmerged, AMEND this file, never correct forward. Check with `git log origin/main --oneline -- db/migration/deltas/V*__w2e_stored_config_cleanup.sql`.
- Test: `apps/web/src/server/__tests__/w2e-migration.test.ts`. Model it on `w2b-migration.test.ts`:
  - read the delta by GLOB `^V\d+__w2e_stored_config_cleanup\.sql$`, never by number;
  - run its statements inside always-rolled-back transactions on a dedicated client;
  - gate on `HAS_DB`.

**Interfaces:**
- Consumes: A0.7's column list. Tasks 5, 9 and 12 run first, so the code no longer declares or writes the keys.
- Produces: over every column in A0.7, for configs of the matching sport only:
  - remove `shootout.suddenDeath` (hockey, icehockey) and `progressScore` (generic);
  - for every tennis `set` object of the Fast4 shape (`gamesTo 4`, `tiebreakAt 3`) without `tiebreakWinBy`, write `tiebreakWinBy: 2` (spec §9).
  The statements are idempotent `jsonb` updates (`#-` and `jsonb_set` under a `where … ?` guard). The header line is `-- V480 — W2e: …`, so `migration-header-truth.test.ts` holds.

- [ ] **Step 1: Failing tests:**
  - `D18 migration removes suddenDeath and progressScore from every listed column`: seed one row per column per sport (Review Focus 5's shapes) and count the rows checked, which must be > 0 per column;
  - `D18 migration pins every Fast4-shaped set to tiebreakWinBy 2 and leaves tour and short-sets sets untouched`;
  - `D18 migration touches no other key` (deep-equal each row minus the targeted keys before and after);
  - `D18 a fixture's ledger refolds to the same outcome and summary after the migration`, through `scoreEvent` or the fold, for a hockey shoot-out fixture and a Fast4 fixture with a tie-break;
  - `D18 a second run changes no row`.
- [ ] **Step 2: Run, verify FAIL** (no delta found). `VERIFY-WEB src/server/__tests__/w2e-migration.test.ts src/lib/__tests__/migration-header-truth.test.ts`, with a test DB per `seazn-local-env` that has had `db:apply` and `sync:sports`.
- [ ] **Step 3: Write the delta.** Run PASS.
- [ ] **Step 4: Mutate once.** Drop the `where` guard on the Fast4 update so it writes every tennis set, and confirm the "untouched" test reds.
- [ ] **Step 5: Commit** `feat(db): W2e stored-config cleanup migration (D18)`.

## Tasks 14–17 (A2): Rule rows and their proving tests, one task per rules file

Same shape for each task. Do not alter engine behaviour. If a proving test shows the engine does NOT do what a row says, stop, record the finding in `a0-findings.md` §A0.9, and ask: never change the engine silently.

- **Rows:** each row's text cites its federation article and the engine path (from `inventory.md` §2–§4, re-pinned in A0).
- **Tests:** each test file is named `packages/engine/src/sports/<sport>/w2e-rows.test.ts`, or `src/core/w2e-rows.test.ts` for cross-sport.
- **Record-only mechanics** get the status `deviation W2e-D7 2026-10-28` with the rule text "record-only: no effect on the result, owned by the scoring-pad programme", and no test (D7). The `proved by` checker requires a test for a deviation row, so where it does, cite the existing test that shows the record has no score effect.
- **Steps:** (1) write the failing tests, named with the ids; (2) `VERIFY-ENGINE` them and see them FAIL only because the ids are unproved or the test is new; (3) fill `proved by` and clear `AWAITING_PROOF`; (4) run `VERIFY-ENGINE <file> test/rules-reference.test.ts` and get PASS; (5) commit `docs(rules): <sport> W2e rows`.

**Task 14: `cricket.md`.**
- Proved: `CK-IV-1` (A7, innings victory), `CK-FO-1` (A8, follow-on), `CK-IF-1` (A9, innings forfeiture), `CK-NRR-2` (A10, timeless innings: assert the engine's NRR for a played timeless innings against ICC; a disagreement is the stop-and-ask case), `CK-PR-1` (A11, penalty runs), `CK-MO-1` (P1, ODI 20-over minimum), `CK-SO-2` (P2, abandon in a super over is a tie), `CK-RT-2` (P3, manual revised target), `CK-AB-3` (P4, two-innings abandon is a draw), `CK-RH-1` (M5), `CK-BO-1` (M7), `CK-FH-1` (M8, free hit only), `CK-WK-1` (M9), `CK-CR-1` (M10).
- Deviation: `CK-RO-1` (M6 DRS; M8 powerplay, new ball and toss).
- Dispositions: `CK-DV-1` (5-ball overs not built, D8), `CK-DV-2` (coarse super over not built), `CK-DV-3` (the M12b retirement does not lower the all-out count: not built, D15/§2.2).
- File: `packages/engine/rules/cricket.md`.

**Task 15: `football.md`, `hockey.md`, `icehockey.md`.**
- Football: `FB-OG-1` (A12, own goal), `FB-YT-1` (P5, youth), `FB-SB-1` (M11, sin bin), `FB-SU-1` (M13, subs), and `deviation` `FB-RO-1` (M12, M14).
- Hockey: `HK-YT-1` (P6), `HK-SU-1` (M15), `HK-GK-1` (M16), `HK-ST-1` (D15: `strength.min` is a penalty floor; the organiser's abandon or award ends a match a team cannot continue).
- Ice hockey: `IH-SU-1` (M17, `releaseForGoal`), `IH-ST-1` (M18 plus D15).
- Cross-cutting: `X-SU-1` in `cross-sport.md` (X6a, `core.suspend`/`resume` on the goal sports), proved here.

**Task 16: the set sports and tennis.**
- `BD-SV-1` (M1, serve; `deviation`).
- `TT-SE-1` (A2: an ITTF penalty is entered as a rally; a test that the sanction alone moves no score).
- `TT-TO-1` and `VB-RO-1` (M2, M3; `deviation`).
- `TN-SE-2` (A4/A5: point and game penalties stay entered as a point or a `tennis.game.award`).
- `TN-RO-1` (M4; `deviation`).
- `BD-DV-1` (badminton team ties: refuse by design, RB2A-32).

**Task 17: `carrom.md`, `boardgame.md`, `generic.md`, `cross-sport.md`.**
- `CA-VR-1` (P8, club-29), `CA-DG-1` (P9, drawn games), `CA-RO-1` (M19; `deviation`), `BG-AB-3` (P7, abandon → `replayFlagged`).
- `GN-DV-1` (the M12b retirement is refused: `LINEUP_NOT_SUPPORTED`; disposition).
- `X-DV-1` (ladder draws: refuse by design, SC-P13).

## Task 18 (A3-0): The judge counts and refuses unexpected skips (D16)

**Files:**
- Modify: `tools/matrix/lib/judge.ts` (`regressions()` `:124-138`), `tools/matrix/judge.ts` (flags `:8-14,46-50`)
- Test: `tools/matrix/__tests__/judge.test.ts` (extend)

**Interfaces:**
- Produces:
  - `judge regression` prints and writes to `--json-out` the fields `compared: number`, `skipped: number`, `skippedIds: string[]`.
  - The new flag `--expected-skips <ids.json>` takes an array of case ids allowed to be skipped.
  - Any skipped id not in that list is reported as `unexpected_skip` and the run exits 1.
  - Without the flag, every skip is unexpected.

- [ ] **Step 1: Failing tests:**
  - `judge counts compared and skipped cases`;
  - `a baseline case missing from --expect and not in --expected-skips fails the run`;
  - `a listed skip passes`.
- [ ] **Step 2: FAIL → implement → PASS:** `VERIFY-MATRIX tools/matrix/__tests__/judge.test.ts`.
- [ ] **Step 3: Mutate once** (ignore the flag) and confirm a red. **Commit** `feat(matrix): judge reports compared/skipped and fails on unexpected skips`.

## Tasks 19–24 (A3): Generator breadth, one stream at a time

Run these strictly in sequence. They share `tools/matrix/lib/streams/types.ts`, `streams/index.ts` (`matchesRequest`), the pad adapters and `streams.test.ts`.

**Shared interface, added by Task 19 and used by Tasks 20–24:**
```ts
// streams/types.ts
export type DecidingPath =
  | "extraTime" | "shootout" | "overtime" | "gws" | "superOver" | "dls"
  | "decidingSet" | "cap" | "tiebreakSet" | "shortSetTb";
// RequestedOutcome's `win` member gains:  path?: DecidingPath
// RequestedOutcome gains:  { kind: "sanctionEnd"; by: Side; level: string; at: "early" | "late" }
```
- `outcomeLabel` appends `-${path}`, or yields `sanction-<by>-<level>`.
- `matchesRequest` gets an arm for each: a `path` matches when the folded outcome's `decidedIn` (or the sport's equivalent, read in `competition/decided-in.ts`) equals it; `sanctionEnd` matches an award to the other side with reason `disqualified` (badminton, tennis) or `retired` (volleyball, after the "no" answer).
- **`ALL_OUTCOMES` stays frozen** (`w2a-streams.test.ts:460`). New shapes run in their own sweeps.
- Every new event type a stream emits goes into that sport's pad adapter `emits`, routed to a tap or declared `noControl` (`pad-adapters.test.ts:188,200-223`).
- Each sweep asserts its per-sport count > 0, and `KNOWN_UNSUPPORTED` stays `[]`.
- **Scenario keys** for the local truth run, one per task, in `tools/matrix/lib/scenarios/types.ts`, in the W2a/W2b key shape (`:12,18`): `W2E_ET`, `W2E_SO`, `W2E_OT`, `W2E_SUPER_OVER`, `W2E_DLS`, `W2E_DECIDER`, `W2E_CAP`, `W2E_TB_SET`, `W2E_SHORT_SETS`, `W2E_SANCTION_END`. Each is opt-in through `--scenario` (`lib/w2b-cells.ts:8`).
- Steps per task:
  1. a failing sweep test in `tools/matrix/__tests__/w2e-streams.test.ts`, titled with the G-id;
  2. run it with `VERIFY-MATRIX tools/matrix/__tests__/w2e-streams.test.ts tools/matrix/__tests__/pad-adapters.test.ts tools/matrix/__tests__/streams.test.ts` and see it FAIL;
  3. implement in the named generator and adapter;
  4. run PASS;
  5. commit `feat(matrix): <G-id> streams`.

| Task | G | Generator / adapter | Sweep asserts |
|---|---|---|---|
| 19 | G1, G2 football | `streams/football.ts` (`ET_HT`/`ET_FT` markers, `football.shootout.kick`); `pads/football.ts` | every football variant with `extraTime` or `shootout` produces a win `path: "extraTime"` and `"shootout"`, strict fold, count > 0 per variant |
| 20 | G2, G3 period | `streams/period.ts` (OT period; `hockey/icehockey.shootout.attempt` in the order `ShootoutOrder` gives, Task 9; GWS); `pads/period.ts` | hockey and icehockey wins by `overtime`, `shootout`, `gws` where the cfg declares them; the shoot-out order equals `expectedKicker` |
| 21 | G4, G5 cricket | `streams/cricket.ts` (`cricket.superover.ball`; `cricket.interruption` + `cricket.revise`, chases within Task 6's bound); `pads/cricket.ts` | super over wins, still-tied under each `superOverStillTied`, DLS wins; `ALL_OUTCOMES` unchanged |
| 22 | G6, G7 set sports | `streams/setbased.ts` (`SetCfg` gains `cap`; deciding set; loser at deuce up to the cap, for `bwf` 3×21 and `bwf-3x15`) | `decidingSet` and `cap` wins per set-sport variant; a 21–20 set under `bwf-3x15` and a 30–29 set under `bwf` |
| 23 | G8 tennis, CL7-3 | `streams/tennis.ts` (TB-shaped sets `tiebreakAt+1 : tiebreakAt`; short sets); `pads/tennis.ts:22-39` (the guard follows the product's `rulesFor`: MTB in the deciding set, `tiebreakAt` default 6, via per-replay closure state) | `tiebreakSet` and `shortSetTb` wins for every tennis variant; `CL7-3 the adapter accepts an MTB-decided summary and refuses a 7–6 without tb where tiebreakAt is absent` |
| 24 | G12 sanctions | `streams/index.ts` (`sanctionEnd`: START, partial play, `<sport>.sanction`, then `core.forfeit`); per-sport sanction tokens for every module that declares `sanctionLevels` or a card/suspension event | the sport list is derived from the module declarations (printed with its count). Every `endLevels` sport yields a `sanctionEnd` award; volleyball's `promptLevels` yield an award only with the retired forfeit; a non-ending sanction never ends a stream |

Task 24 ends with `pnpm matrix:catalogue --write`, then `pnpm matrix:catalogue --check` (the 3×15 variant and the `suddenDeath` deletion move `variants.json`), and `VERIFY-MATRIX tools/matrix/__tests__/committed-catalogue.test.ts`. Commit `chore(matrix): regenerate the catalogue`.

## Task 25 (A4): MD-1 close on the result-deciding paths

**Files:**
- Modify: the tests beside each surviving mutant's file; `packages/engine/stryker-equivalent.json` (line-keyed rows only)

**Interfaces:**
- Consumes: A0.6's per-file table and the §11(b) function list.

- [ ] **Step 1: Changed lines.** `cd $WT/packages/engine && R="$(node scripts/stryker-changed.mjs --base origin/main)" && STRYKER_MUTATE="$R" pnpm mutation; echo EXIT=$?`, then `node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$R"; echo EXIT=$?`. Every Survived or NoCoverage mutant is killed by a new test, or classified with a ≥10-character reason that names why it is equivalent.
- [ ] **Step 2: The §11(b) paths W2e did not change:** match end and the outcome fold per kernel, OT/SO (period, football), super over/DLS (cricket), set end and the cap (set, nested), the abandon and award credit. Use `STRYKER_MUTATE="src/<file>:<a>-<b>,…"` over the function ranges from A0.6, then kill or classify.
- [ ] **Step 3:** `VERIFY-ENGINE test/stryker-floor.test.ts` plus each test file changed in this task.
- [ ] **Step 4: Commit** `test(engine): MD-1 W2e scope killed or classified`. The commit body carries the before/after survivor counts per file.

## Task 26 (A5): Whole-branch review and PR A

- [ ] **Step 1:** Rebase onto `origin/main` (never stash). Re-run each task's VERIFY set over the files that main's newly merged commits touch.
- [ ] **Step 2:** Run `fold-epoch:check --against origin/main` and confirm the bumps: badminton 2, tennis 2 (minor 0), cricket 2 (minor 1), hockey 5, icehockey 3, boardgame 4, carrom 4, generic 4. Renumber Task 13b's delta to main's max + 1 if main moved, and update its header line. Confirm `AWAITING_PROOF` is empty for every Task 1–17 id.
- [ ] **Step 3:** Dispatch a fresh `reviewer` over `git diff origin/main...HEAD` with spec §2.3, §5, §7, this plan's Review Focus and AGENTS.md classes 1, 3, 5, 19. Write its findings to `.superpowers/sdd/2026-10-28-format-matrix-w2e/review-pr-a.md`. Fix each finding, re-verify, and repeat until there are no new findings.
- [ ] **Step 4:** Open PR A. The body states:
  - what changed per spec section;
  - the epochs;
  - `Matrix rows: all` (engine-wide change);
  - the breaking-change entries;
  - the PR #1061 relation (D17: not owned here);
  - a **"Data changes"** section (D18), each item one line with its count or "none in prod":
    - the migration: which keys leave which columns, and Fast4 sets pinned to margin 2;
    - DLS NRR now follows ICC 16.10.7 for every cricket match (no cricket in prod);
    - the new write refusals (`ENDING_SANCTION_PENDING`, `SET_SCORE_UNREACHABLE`, `CHASE_OVERSHOOT`, `RESULT_METHOD_CONTRADICTS_WINNER`, `ADJUST_OUT_OF_RANGE`, the two `CONFIG_INVALID` sentences): no stored row changes;
    - PR B's `rank: null` API shape on level tables (announced here, shipped in PR B).
- [ ] **Step 5:** Dispatch e2e `gh workflow run e2e.yml --ref feat/format-matrix-w2e -f pr=<N>` (PR A changes the pad's engine), then hand back. The main thread watches CI and smoke. Merge only on the owner's explicit go.

---

# PR B — web, then the truth run

Branch `feat/format-matrix-w2e-b` from `origin/main` after PR A merges. Tasks 27–29 share the locale dictionaries and `i18n-keys.ts`, so they run in the order 27, 28, 29, one at a time. Tasks 30–33 follow in order (they share `pad-host.tsx` and the dictionaries).

## Task 27 (B3-1): `rank: null` on level tables at both endpoints (D11 b)

**Files:**
- Modify:
  - `apps/web/src/app/api/v1/stages/[id]/standings/route.ts:8-14`
  - `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/standings/route.ts`
  - `apps/web/src/server/api-v1/schemas.ts:1469` (`rank: z.number().nullable().optional()`)
  - `apps/web/src/server/api-v1/openapi.ts:154,285` (text)
  - `openapi/v1.json`, `openapi/v1.public.json` (`npm run openapi:gen`)
  - `apps/web/src/server/public-site/division-doc-cache-keys.ts:20-22` (`standings-v2`)
  - `docs/api-v1-breaking-changes.md`, `apps/web/src/app/developers/changelog/page.tsx`
- Modify: `apps/web/src/server/engine-db/__tests__/tables-producer-consumer.test.ts:145-151`
- Create: `apps/web/src/server/api-v1/level-rank.ts`
- Test: extend `apps/web/src/server/api-v1/__tests__/w2d-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function serialiseLevelRanks<R extends { rank?: number; level?: boolean }>(rows: readonly R[]): (Omit<R, "rank"> & { rank: number | null | undefined })[]
  ```
  This sets `rank: null` on every row when `isLevelTable(rows)`; otherwise it returns the rows unchanged. Both route handlers call it; `getStandings` and `publicStandings` are untouched (E24).

- [ ] **Step 1: Failing tests:**
  - `D11b both endpoints serve rank null on a level table` and its positive pair `a decided table keeps rank 1..n`;
  - `D11b the public route serves the new shape through the cache` (read twice; the key is `standings-v2`);
  - `D11b getStandings still returns rank 1..n for a level table` (so `rankText` consumers are unchanged);
  - the producer-consumer test accepts `rank === null` exactly when `level`.
- [ ] **Step 2: FAIL → implement → PASS:** `VERIFY-WEB src/server/api-v1/__tests__/w2d-api.test.ts src/server/engine-db/__tests__/tables-producer-consumer.test.ts src/server/public-site/__tests__/division-doc-cache-keys.test.ts`, then `npm run openapi:gen && git diff --exit-code openapi/` (only the intended change).
- [ ] **Step 3: Breaking-change entry** in the W2d model's sections (`:10-53`): note the ~330 s stale-while-revalidate window and "no external client" (owner fact). Add the changelog entry too.
- [ ] **Step 4: Mutate once** (always return the rows unchanged) and confirm a red. **Commit** `feat(api): rank null while a table is level (D11 b)`.

## Task 28 (B1-1): The five ruling-157 fields (D5)

**Files:**
- Modify: `apps/web/src/lib/match-rules/carrom.ts`, `cricket.ts`, `football.ts`; `apps/web/src/lib/match-rules/types.ts` (`labelKey?`, `helpKey?`); `apps/web/src/components/v2/stage-rules/rule-field-control.tsx` (resolve the keys, fall back to `label`); 4 × `ui.json`
- Modify: `apps/web/src/components/v2/stage-rules/__tests__/stage-row-model.test.ts:91-105` (the list goes to `[]`); `lib/match-rules/__tests__/{carrom,cricket,football}.contract.test.ts` (delete the `noWebFieldYet` rows; `noEngineMax` for `pointsPerCoin` and `concussionSubs`)
- Test: `apps/web/src/lib/match-rules/__tests__/w2e-fields.test.ts`; e2e `apps/web/e2e/stage-rules-w2e.spec.ts`

**Interfaces:**
- Produces these `RuleField`s:
  - `pointsPerCoin` (number, min 1);
  - `minOversForResult` (number, min 0; the engine's cross-refine is the `crossField` pin);
  - `superOverStillTied` (select `repeat | boundary_count | shared`; help says `boundary_count` counts ball-by-ball boundaries only, a coarse innings counts 0; held while the super over is off, Task 7);
  - `rollingSubs` (bool);
  - `concussionSubs` (number, min 0: a COUNT).
- Labels and help come through `labelKey`/`helpKey` in 4 locales (D5). **Owner check:** `rule-field-control.tsx:8-9` documents field labels as deliberately English. D5 asked for 4 locales, so this task follows D5 and the final report flags the inconsistency with the other fields.

- [ ] **Step 0:** Invoke `frontend-design`.
- [ ] **Step 1: Failing tests:**
  - `R157 no declared stage key lacks a field` (the ratchet `toEqual([])`, with the count of keys checked > 300);
  - `R157 each field's build() parses over every variant of its sport`;
  - `R157 superOverStillTied is disabled while the super over is off`.
- [ ] **Step 2: FAIL → implement → PASS:** `VERIFY-WEB src/lib/match-rules/__tests__/w2e-fields.test.ts src/components/v2/stage-rules/__tests__/stage-row-model.test.ts src/lib/match-rules/__tests__/carrom.contract.test.ts src/lib/match-rules/__tests__/cricket.contract.test.ts src/lib/match-rules/__tests__/football.contract.test.ts src/components/v2/stage-rules/__tests__/stage-rule-fields.test.tsx`, plus `i18n:gen-keys` and `i18n:check`.
- [ ] **Step 3: E2E** `stage-rules-w2e.spec.ts` (model `stage-rules-w2c.spec.ts:122,340`), one test per field:
  - set the value, save, reload, and assert it is read back from `GET /stages/{id}` (the value it OPENS AT is the engine default, class 19);
  - the W2c lock disables it.
- [ ] **Step 4: Commit** `feat(editor): ruling-157 fields (D5)`.

## Task 29 (B1-2): Variant pickers, 3×15 default, the date hint and the Settings switch

**Files:**
- Create: `apps/web/src/lib/preferred-variant.ts` (`PREFERRED_VARIANT` moved out of `division-builder.tsx:58-63`, plus `badminton: "bwf-3x15"`)
- Modify: `components/v2/division-builder.tsx` (`:58-69`, picker `:652-669`: label via `variantWord` with the raw name as fallback; the hint), `components/v2/division-settings.tsx` (`:1212-1227` the same; the variant switch through `division-format-patch.ts`), `lib/funnel.ts:84-90` (preferred variant first), `lib/match-rules/tennis.ts` (`TENNIS_SET_SHAPES` gains `short4`; `fast4` gains `tiebreakWinBy: 1`; Bo1 + MTB refused beside the tennis fields from `BO1_MATCH_TIEBREAK`), `division-builder.tsx:482-500` (show `settingsSaveErrorText`, not raw `err.message`), 4 × `ui.json` (`variant.badminton.hint3x15`: "BWF adopts 3×15 from 4 January 2027. 3×21 applies until then.")
- Test: `apps/web/src/components/v2/__tests__/w2e-variants.test.ts`; `apps/web/src/lib/__tests__/funnel.test.ts`; e2e `apps/web/e2e/division-variant-w2e.spec.ts`

**Interfaces:**
- Consumes: Task 3's variants and labels; Task 5's tennis variants; Task 13's sentences.
- Produces:
  - `pickVariant(sport, variants)` reads `PREFERRED_VARIANT`;
  - `resolveSport(sport)` (funnel) picks the preferred variant, else the first by key;
  - a variant switch rebuilds the format from the target variant: the keys the variant declares come from the variant, never from the stored config.

- [ ] **Step 0:** Invoke `frontend-design`.
- [ ] **Step 1: Failing tests:**
  - `D2 a new badminton division defaults to bwf-3x15 in the builder and the funnel`;
  - `variant switch applies the target variant's fields` (bwf → bwf-3x15 gives 15/15/21; back gives 21/21/30);
  - `a format save without a variant change keeps 21/21/30` (Review Focus 3);
  - `pickers print the localised variant label, with the raw name as fallback`;
  - `TN-CF-1 the tennis fields refuse best of 1 with a match tie-break in the editor`.
- [ ] **Step 2: FAIL → implement → PASS:** `VERIFY-WEB src/components/v2/__tests__/w2e-variants.test.ts src/lib/__tests__/funnel.test.ts src/lib/match-rules/__tests__/tennis.contract.test.ts src/components/v2/__tests__/division-format-patch.test.ts`, plus `i18n:gen-keys` and `i18n:check`.
- [ ] **Step 3: E2E** `division-variant-w2e.spec.ts`:
  - create a badminton division with defaults and assert `config.setTo === 15` via the API;
  - switch to `bwf` in Settings and assert 21;
  - the hint is visible;
  - a tennis Bo1 + MTB save shows the localised refusal.
- [ ] **Step 4: Mutate once** (drop the variant-keys override on switch) and confirm a red. **Commit** `feat(web): 3×15 default, labelled variant pickers, Settings variant switch (D1, D2)`.

## Task 30 (B2-1): Ending sanctions on the badminton and tennis pads

**Files:**
- Modify:
  - `apps/web/src/components/v2/scorepad/v3/skins/badminton.tsx` (sheet `:1082-1119`)
  - `skins/tennis.tsx` (sheet `:926-956`)
  - `v3/pad-host.tsx` (the ending append, bound like `runAmend` `:1587-1594` with a durable `dropWith` pair; the pending-ending blocker using T18's modal `admitsTap` shape, `:1365-1393`)
  - `v3/types.ts` (a `SheetConfirmStep` with `when` on the end level)
  - 4 × `ui.json`
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/w2e-ending-sanction.test.ts`; e2e `apps/web/e2e/scorepad-v3-ending-sanction.spec.ts`; a block in `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `module.sanctionEnding`, `pendingEndingSanction` (Task 1); the D13 server behaviour (Task 2).
- Produces:
  - The sheet adds a confirm step when `level ∈ endLevels`, reading "This ends the match: <side> loses" (`pad.sanction.endsMatch`).
  - On confirm, the pad sends the sanction, then `core.forfeit { by, reason: "disqualified" }`, bypassing `createSkinDispatch` the way `runAmend`'s re-append does.
  - While `pendingEndingSanction(ledger)` is non-null, the pad shows a blocking prompt (`pad-ending-pending`) with "Record the ending" (sends the forfeit) and "Void the sanction". Scoring taps are not admitted.

- [ ] **Step 0:** Invoke `frontend-design`.
- [ ] **Step 1: Failing tests:**
  - `a disqualification confirm sends sanction then forfeit with the same side` (driven through the real host and the module's own sheet; assert the two payloads);
  - `pad opens on the ending prompt for a ledger whose last sanction ends the match` (Review Focus 1);
  - `a failed second append leaves the prompt on reload` (Review Focus 4);
  - `take back during the hold drops both events`;
  - `a warning-level sanction sends one event and no prompt` (positive pair).
- [ ] **Step 2: FAIL → implement → PASS:** `VERIFY-WEB src/components/v2/scorepad/v3/__tests__/w2e-ending-sanction.test.ts src/components/v2/scorepad/v3/__tests__/partial-amend.test.ts src/components/v2/scorepad/v3/__tests__/use-pad-pipeline.test.tsx src/components/v2/scorepad/v3/skins/__tests__/badminton.test.ts src/components/v2/scorepad/v3/skins/__tests__/tennis.test.ts`.
- [ ] **Step 3: E2E** `scorepad-v3-ending-sanction.spec.ts`, as an official scorer, for badminton and tennis:
  - sanction → confirm, then assert the ledger via `GET /fixtures/{id}/events` holds the sanction then `core.forfeit{disqualified}`, and the fixture is decided for the other side;
  - void the forfeit from the activity row and assert the prompt is back.
  Add one block to `mobile.spec.ts` (prompt visible at phone widths, opened per AGENTS.md trap 22).
- [ ] **Step 4: Mutate once** (skip the second append) and confirm a red. **Commit** `feat(pad): a disqualifying sanction ends the match from the pad (D3, D13)`.

## Task 31 (B2-2): Volleyball "Can <team> still field six players?"

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/volleyball.tsx` (sheet `:1250`), 4 × `ui.json`
- Test: extend `w2e-ending-sanction.test.ts`; extend `scorepad-v3-ending-sanction.spec.ts`

**Interfaces:**
- Produces: a choice step `fieldSix` (`when: level ∈ promptLevels`), asked BEFORE the write.
  - "No": send the sanction, then `core.forfeit { by, reason: "retired" }`, through Task 30's paired append.
  - "Yes": send the sanction only.

- [ ] **Step 1: Failing tests:**
  - `VB-SE-1 No sends sanction then forfeit retired`;
  - `VB-SE-1 Yes sends only the sanction and play continues`;
  - `a warning asks nothing`.
- [ ] **Step 2: FAIL → implement → PASS** (VERIFY-WEB with the files above plus `skins/__tests__/volleyball.test.ts`). E2E: both answers, ledger asserted.
- [ ] **Step 3: Commit** `feat(pad): volleyball field-six question (D12)`.

## Task 32 (B2-3): M12b "player injured, no replacement" control

**Files:**
- Create: `apps/web/src/components/v2/scorepad/v3/retirement-slot.ts` (an off-picker built from `buildSwap`, `period-shared.ts:1464-1500`)
- Modify: `skins/football.tsx`, `skins/volleyball.tsx`, `skins/period-shared.ts` (hockey, icehockey), 4 × `ui.json`; `tools/matrix/lib/scenario-catalogue.ts:154-160` (drop the M12b no-path route for these four sports; cricket and generic keep a route naming their disposition rows); the four sports' pad adapters (`tools/matrix/lib/pads/*`)
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/w2e-retirement.test.ts`; e2e `apps/web/e2e/scorepad-v3-retirement.spec.ts`; a `mobile.spec.ts` block

**Interfaces:**
- Produces: `buildRetirement(view, side): PadSlot | null`, which sends `core.lineup.retirement { side, personId, reason: "injured" }`. Gated as the swap slot is (`view.band >= SWAP_BAND`, play phase); offered only for an on-field person.

- [ ] **Step 0:** Invoke `frontend-design`.
- [ ] **Step 1: Failing tests:**
  - `M12b the four sports offer the control and its payload folds through the real engine` (squad on-field count drops by one);
  - `M12b cricket and generic offer none` (with the reason from the rows);
  - `VERIFY-MATRIX tools/matrix/__tests__/pad-adapters.test.ts` for the new route.
- [ ] **Step 2: FAIL → implement → PASS.** E2E: football and hockey; assert the ledger event.
- [ ] **Step 3: Commit** `feat(pad): team plays short control (M12b)`.

## Task 33 (B3-2): Cleanup, copy and the smoke suite

**Files:**
- Modify: `apps/web/src/server/migration/v1-map.ts` (`:84,108`; stop writing `progressScore`); `server/migration/__tests__/v1-map.test.ts:88`; `components/v2/division-settings.tsx:513,1365` (drop the type field; the placeholder shows a key the division's own module declares, read from `module.ruleKeys`, so it always works)
- Create: `scripts/smoke/suites/w2eRefusals.ts` (model `suites/w2dTables.ts`: own owner `delivered+w2e_${tag}@resend.dev`, `EXPECTED_CHECKS`, a counted check, zero checked fails)
- Modify: `scripts/smoke/main.ts` (one `suite("w2eRefusals", …)` after the last), `scripts/smoke/harness.ts` (cleanup owner), `scripts/smoke/index.ts` (`SELECTABLE_SUITES`)

**Interfaces:**
- Produces smoke checks:
  - one per new code through the live route: `ENDING_SANCTION_PENDING`, `SET_SCORE_UNREACHABLE`, `CHASE_OVERSHOOT`, `RESULT_METHOD_CONTRADICTS_WINNER`, `ADJUST_OUT_OF_RANGE`;
  - `CONFIG_INVALID` for the two sentences;
  - D13's scorer 201 and 403;
  - `rank: null` on a level public table.

- [ ] **Step 1: Failing tests:** `D6 v1 import writes no progressScore`; `the Advanced placeholder names a key the module declares, for every sport` (a count of sports checked equal to the registry size). Run `VERIFY-WEB src/server/migration/__tests__/v1-map.test.ts <the placeholder test>` and see FAIL.
- [ ] **Step 2: Implement → PASS.** Run the smoke guard tests `scripts/__tests__/smoke-{paths,select,manifest}.test.ts`, then `SMOKE_ONLY=w2eRefusals npm run test:smoke` against a live local server (per `seazn-local-env`); the check count equals `EXPECTED_CHECKS`.
- [ ] **Step 3: Commit** `chore(w2e): drop progressScore writes; smoke for W2e refusals`.

## Task 34 (B4): Visual sign-off and the e2e dispatch

- [ ] **Step 1:** Capture each changed screen at 1280, 768 and 320:
  - the stage editor with the five fields;
  - the builder and Settings variant pickers with the hint;
  - the badminton and tennis pads at the confirm step and the pending prompt;
  - the volleyball question;
  - the M12b control on football and hockey.
  Use a scratch Playwright script in `$S` (W2d's form) against a prod build. Confirm every image exists, that the images differ, and that each was taken after its state opened (AGENTS.md class 10). Check no horizontal page scroll at 320.
- [ ] **Step 2:** Publish one Artifact page with a verdict line per screen. The owner gives per-screen sign-off. Fix and re-capture until every screen is signed.
- [ ] **Step 3:** Push and dispatch `gh workflow run e2e.yml --ref feat/format-matrix-w2e-b -f pr=<N>`, then hand back. If `mobile.spec.ts` goes red, treat its count as a floor and re-dispatch after each fix (trap 21).

## Task 35 (B5-1): The W2 truth run (D16)

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2e-final/` in `w2b-final`'s shape (README, `ci/L{1,2,3}/`, `local/L3/<run-id>/`, judges); append to `truth-runs/plans.lock.json`

- [ ] **Step 1: CI base.**
  - `git push origin feat/format-matrix-w2e-b && gh workflow run matrix-truth.yml --ref feat/format-matrix-w2e-b -f scope=full; echo EXIT=$?`
  - `gh run list --workflow matrix-truth.yml --branch feat/format-matrix-w2e-b --limit 1 --json databaseId,status,headSha,event` (headSha = HEAD, event `workflow_dispatch`), then hand back.
  - When it finishes: `gh run download <id> --name merged --dir ci` and `pnpm matrix:render ci/<L>/results.json --out ci/<L>/MATRIX.md`.
- [ ] **Step 2: Local scenarios.** Run every `W2E_*` key from Tasks 19–24 with `pnpm matrix:l3 --scenario <KEY> …` (the W2b form) on a local server.
- [ ] **Step 3: Judge.** For each layer, `pnpm matrix:judge regression --baseline truth-runs/w2b-final/ci/<L>/results.json --now ci/<L>/results.json --expect expect-<L>.json --expected-skips skips-<L>.json --json-out judge-<L>.json; echo EXIT=$?`.
  - `skips-<L>.json` lists only the badminton ids renamed by the 3×15 default. Derive it by diffing case ids, and judge `bwf` explicitly so its cells stay compared.
  - Exit must be 0, with `compared` printed per layer.
- [ ] **Step 4: Triage.** Fix each red in W2e (a commit per cause, re-run that cell), or list it for the owner as "not built, because…". Write the README. Run `pnpm matrix:lock-check --against HEAD`.
- [ ] **Step 5: Commit** `docs(matrix): W2 truth run (w2e-final)`.

## Task 36 (B5-2): Data audit, `_INDEX` fold, final review

- [ ] **Step 1:** Append W2e's counts to a copy of W2d's `data-audit.sql` (path from A0.5(g)) at `.superpowers/sdd/2026-10-28-format-matrix-w2e/data-audit.sql`. Counts:
  - volleyball and table-tennis configs (division, stage `rules`, `rules_override`) with a set target below 5;
  - tennis Bo1 + MTB configs;
  - ledgers whose last live sanction ends the match with no later forfeit (reported, never repaired).
  The owner runs it at release.
- [ ] **Step 1b: Release notes.** Repeat PR A's "Data changes" section, plus PR B's `rank: null` entry, in the release notes the owner publishes with the prod tag (D18).
- [ ] **Step 2:** Fold `_INDEX.md`:
  - D1–D17 become rulings;
  - E1–E26 plus any A0 premises are recorded;
  - the MD-1 table is amended per D10;
  - PR #1061's five rows are checked: each closed or carrying an owner verdict (D17; if still open, tell the owner, never close them here);
  - the W2 status row reads closed.
- [ ] **Step 3:** Run a whole-branch `reviewer` pass (findings to `review-pr-b.md`, fix until no new findings), then open PR B.
- [ ] **Step 4:** Hand back. Merge on the owner's explicit go after their staging steps. Prod deploy follows the W2 one-off (`post-deploy-pin.ts --check`, owner-run).
