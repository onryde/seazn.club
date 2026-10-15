# GF-2 — record the kernel overlay in the golden corpora (design, phase A)

Status: for owner review, 2026-10-15, off `d601f9da5` (main with #961-#963). Follows `reviews/1e.md` M2, `reviews/golden-floor.md` #1
and `reviews/1e-minor.md`. Rules in force: D32b, D34, GOLDEN-POLICY.md, TEST-STRATEGY.md.

## 0. Premises checked against the tree (each is a finding)

- **P1 true.** The pad recomputes `summaryOf` on every live fold (`use-pad-pipeline.ts:1261-1263`, via `foldClientFacts`), passing
  the fold's `levelWithdrawal` (`settlement: null`; summaryOf ignores it).
- **P2 the reference consumer reads less of the kernel than the brief assumes.** No production reader of the fold's `stoppage`,
  `settlement` or `expunged` exists in `apps/web`. `view.squads` is `state.squads`, else `initSquads(lineups)` (`pad-host.tsx:135-138`):
  boardgame, carrom and generic skins read it, which ignores lineup events (read, not driven; football reads its own state). Chess
  computes `deciderPending` from a settlement it re-derives from events (`boardgame.tsx:254-277`). What capture S2 reads is unknown, so
  §1 records everything the kernel returns, not only what the web pad reads. (The ignored lineup events: route as a pad finding.)
- **P3 no corpus exercises three of the overlay paths.** Measured over all 381 streams / 4,973 steps: 0 streams reach a `settlement`
  (exempt), 0 an `expunge` abandon, 0 a withdrawal over a held level result. Recording alone therefore pins none of `outcomeOf` /
  `summaryOf`'s overlay branches; the floor must add those streams (Task 3 is required, not optional).
- **P4 two claims cannot flip by recording the overlay.** `core.note` feeds no fold, overlay or stats. `core.award` feeds only the
  player-stats fold (`stats.ts:730`), and only for a key the sport declares; the floor's award uses `"motm"` everywhere
  (`golden-floor-streams.ts:333`), which only football declares (ice hockey `mvp`, hockey `potm`; the other eight declare none).
- **P5 `deltas` disagree with the server on a kernel overlay.** `recomputeStream` feeds `module.outcome(final)` to `standingsDelta`
  (`golden.ts:213-221`); the server feeds the stored effective outcome (`competition.ts:380`, written by `outcomeOf`, `fold.ts:175-183`).
  Identical on 381/381 streams today, divergent on the first settle or withdrawal stream. (The brief's `outputsDiffer` is
  `phoneOutputsDiffer`, `fold-epoch-guard.ts:134`.)

## 1. What a phone computes from the kernel

| kernel output (`core/events.ts`) | who reads it today | deterministic | record |
|---|---|---|---|
| `summaryOf` per step (`:213`) | pad headline, every fold; server `fold.ts`, `append-event.ts` | yes | digest per step |
| `outcomeOf` per step (`:189`) | server stores it; S2 decides "match over" from it | yes | change points, full JSON |
| `stoppage` (`:749`, fold result) | no web reader; S2 "play suspended" | yes (`eventId` = `e-<i>`) | change points, full JSON |
| `squads` (fold result) | refusals of later lineup events; S2 | yes | change points, digest |
| `settlement`, `expunged`, `levelWithdrawal` | inputs of outcomeOf/summaryOf; kernel refusals | yes | change points, full JSON |
| `deciderPending` (`:228`) | chess skin tie-break panel | yes | change points |

Not recorded: `settleApplies`, `forfeitAdmission` (organiser console, not a phone path); REFUSALS (recorded streams are accepted, so
only "still accepted" is pinned; acceptance widening stays "unexercised branches"); player stats (Q2). Every row is pure in (module, cfg,
lineups, ledger prefix), from the prefix folds the recorder already runs (`foldMatch` → `foldMatchWithStoppage`, same state).

## 2. Corpus shape: format 2

- `GoldenCorpus.format: 2` (absent = 1), written before `streams` (still the LAST key: EXTEND's byte-prefix check holds). Two
  REQUIRED stream fields under format 2 — never omitted, so absence can only mean "format 1":
  - `summaries: string[]` — per step, `#` + 16 hex of SHA-256 of `JSON.stringify(summaryOf(fold of events[0..i]))`. Length = `events`.
  - `overlay: string` — JSON of `{outcome?, stoppage?, settlement?, expunged?, levelWithdrawal?, decider?, squads?}`, each an ARRAY of
    `[step, value]` pairs holding only the steps where the value differs from the step before (step -1 = the kernel default: null, false,
    `initSquads(lineups)`). Squads values are digests. A key with no change is omitted. Arrays of pairs, not `{ "17": … }` objects:
    GOLDEN-POLICY's integer-like-key trap. Lossless: the dense per-step value is recoverable by carrying forward.
- `outcome`, `summary`, `deltas` become the EFFECTIVE values (`outcomeOf`, `summaryOf`, `standingsDelta` of `outcomeOf`; Q3). Measured
  byte-identical on 381/381 streams (effective final outcome = module outcome, `summaryOf` = `module.summary` at 4,973/4,973 steps).

**Measured size** (scratch prototype over the committed corpora, nothing written; 381 streams, 4,973 steps, 9.6 s wall for every prefix):

| variant | bytes added | on 2,722,041 |
|---|---|---|
| **recommended**: summary digests per step (104,794) + overlay full JSON (50,460) + squads digests (2,829) + keys | **+156,713** | **+5.8%** |
| squads in full JSON instead (171,804 for 11 streams) | +325,688 | +12.0% |
| full summary at every step | +2,490,757 | +91.6% |
| full summary where the state is an anchor, digest elsewhere | +1,006,927 | +37.0% |

Per sport +2.9% (ice hockey) to +14.5% (generic). Non-default overlay today: stoppage 16 streams (11/11 sports), squads 11 (11/11),
decider 2 (boardgame), 369 outcome change points. Task 3's new floor streams (~2 per sport) add an estimated ~150 KB more (unmeasured).

## 3. Migration: existing streams gain fields, so their bytes change

- (a) **Format bump, new fields absent at baseline owe nothing.** Alone it launders: a kernel rule changed in the same PR is invisible
  in every PRE-EXISTING field (that is the whole class), so "pre-existing fields identical" proves nothing about the new ones.
- (b) **New fields only on appended streams.** Weak: the 381 streams (all mid-match summaries, every stoppage) stay unpinned forever.
- (c) **Replay at the base ref.** Materialise the base engine, run the new recorder against it, compare. Strongest, but the guard
  executes base code on every run (or a special mode), and the recorder's imports must exist at base.
- **Recommended: (a) + a fold-source freeze (call it a').** A baseline stream (same identity and input) that lacks `summaries` /
  `overlay` while the current one has them is **newly recorded** and owes nothing **only if the change touches no fold source**:
  nothing under the engine's `src/` outside `src/testkit/**`, `*.test.ts`, `*.golden.json`, `*.schema.json`, `*.md`; not the engine's
  `package.json`; not the root lockfile (zod and the toolchain fold too). With the source frozen the recorder runs the base engine's
  code, so a newly recorded value IS what the base computes: (c)'s guarantee without executing base code. Otherwise every newly recorded
  stream counts as CHANGED (major owed; reason: "land the format bump alone, or raise FOLD_EPOCH").
- Laundering, each closed: field added + rule changed in one PR → source not frozen → major. Field dropped / format 2 → 1 → exit 2
  (format 2 requires both fields) / exit 1 (format fell). Recorder changed later → both sides recorded → major (D34 unchanged; Q6).
  Re-recorded → removed + added; appended → added, owes nothing. A rule changed on main BEFORE GF-2 stays the status-quo manual major.
- Write mode: `REFORMAT_GOLDEN=1` adds the format-2 fields to every stream and asserts every pre-existing field, events and configs
  byte-identical (it is never a re-baseline), under the same dirty-tree refusal as REBASELINE (`corpusWriteVerdict`). Idempotent.

## 4. Guard, floor, claims, apps/web readers

- **Guard** (`fold-epoch-guard.ts`): `phoneOutputsDiffer` also compares `summaries` (length and every entry) and `overlay` when both
  sides record them — all MAJOR (a phone computes them). New report column `recorded N`. Pure `epochViolations` takes the changed-path
  list as input (testable without git); the CLI derives it with `git diff --name-only <commit>` plus untracked files, prefix-aware like
  `commitSnapshot` (works at `packages/engine` and at an engine-repo root after 2b). `parseCorpus`: `format` is 1 or 2; format 2 requires
  both fields on every stream, `summaries` as long as `events`, `overlay` valid JSON.
- **Recorder** (`golden.ts`): `recomputeStream` returns the effective `outcome`/`summary`/`deltas`, `summaries` and compact `overlay`,
  plus the DENSE per-step overlay for the ablation probe. `verifyStream`, `corpusStateDiff` (moved summary steps, moved overlay keys),
  `rebaselineCorpus`, `extendCorpus` and `extendFloor` write and compare the new fields; `summaries` are never slimmed (all digests).
- **Floor** (`golden-floor.ts`): new tokens `overlay:<key>:set` / `overlay:<key>:cleared`, keys DERIVED from the fold result's own keys
  (`Object.keys(foldMatchWithStoppage(...))` minus `state`), read off the recorded `overlay`. Required: stoppage set+cleared, squads set,
  settlement set+cleared, expunged set+cleared everywhere; levelWithdrawal set+cleared where the floor requires `draw`, `tie` or
  `no_result`. `UNDOABLE_KERNEL` gains `core.settle`. `extendFloor` gains the stories (level result → withdrew → void → settle → void →
  settle; abandon{expunge} → void → play on). Empty case first: an emptied corpus names every new token.
- **Retirements, each proven by its own probe flipping under the real recorder:** `FLOOR_EXEMPTIONS` `core.settle` (its `settleProbe`
  reads `record(...).outcome`, effective under Q3, else the overlay: stale → deleted, settle required); `OVERLAY_CLAIMS` `stoppage` (all
  11) and `lineup` (boardgame, carrom, generic, football position) go stale once `ablationProbe` compares dense overlay and summaries at
  retained steps with own-step neutrality → deleted. `note` stays, reason rewritten to "nothing computes from a note" (no manual bump;
  Q4). `award`: Q2. GOLDEN-POLICY "What the guard cannot see": kernel overlays, overlay-unpinned, kernel side of an undo, `core.settle`
  and mid-match summaries are retired; unexercised branches stay; player stats per Q2. `capture-s2-handoff.md` §4 rewritten to match.
- **apps/web** (re-run each; a red is a finding, never a weakened assertion): `outcome-readers.test.ts` — `golden.ts` leaves `ALLOWED`
  if its bare `.outcome(` count reaches 0 (`:26`, and `:150` reds a stale entry), joins the `outcomeOf` readers (`:96-114`), and the
  "no stream carries core.settle" scan (`:153-169`) becomes "every settle stream's `outcome` is a settled win". `timeline.test.ts:924`
  expects `[]` unrecorded kernel types. `public-player-matches.test.ts:2114-2164`, `player-matches.test.tsx` and the timeline sweep read
  states/summary only; re-run over the new streams. `fold-epoch-guard.test.ts:423` `FIELDS` gains `summaries`, `overlay`.

## 5. Tasks, tests, size, risks

1. **T1 recorder + format 2 + REFORMAT mode** (testkit only, no corpus rewritten). Tests: change-point round trip (default omitted, a
   value returning to default recorded, a void reopening recorded); effective `outcome`/`summary`/`deltas` byte-identical on all
   existing streams (count > 0) and different from the module's on a hand-built settle, expunge and withdrawal ledger in >= 2 sports;
   REFORMAT refuses a would-be re-baseline; second run is a no-op. Size M.
2. **T2 guard + the reformat commit.** Pure tests: `FIELDS` sweep with both new fields (MAJOR, every sport); newly recorded + frozen
   source → owes nothing; + any fold-source path → major; format falls → violation; format-2 stream missing a field → exit 2. CLI on real
   git history: the reformat commit vs its parent → exit 0, `recorded 381`, `changed 0`; the same commit plus a one-line kernel change
   (e.g. `settled_${m}` renamed) → exit 1 naming every sport. The corpora rewrite in its OWN commit. Size M, +157 KB.
3. **T3 floor + retirements + apps/web lists** (EXTEND appends; added streams owe nothing). Teeth, each a kernel mutant → REBASELINE →
   guard names exactly the sports reached, MAJOR, in >= 2 sports: suspend drops `reason` (11); expunge ignored by `outcomeOf` (11);
   `summaryOf` overlay dropped (level sports only, not badminton/tennis); position reducer no-op (incl. the four formerly unpinned);
   `awaitingDecider` mutant (boardgame only); a mid-match-only summary change (one sport, final `summary` unmoved: 1e-minor). Size L.
4. **T4 (Q2) player-stats field** (final `aggregatePlayerStats` rows), floor award with the sport's declared key. Size S.

Every sweep reports its counts (streams, steps, change points, tokens per sport); zero is a failure. Each new guard clause (newly
recorded, source freeze, both field comparisons, format monotonic, required fields) is mutated once. Tasks run sequentially (T2 and T3
rewrite the same corpora and `golden.ts`); one PR or two, CI compares the net diff.

**Risks.** Recorder fidelity is circular (the replay reruns the same recorder): the T3 teeth tests are the only proof. The freeze
over-approximates (a comment fix in `core/` forces a major): the reformat ships alone. Digest summaries are unreadable in a diff (as
digest states; `corpusStateDiff` names steps). Replay adds a `summaryOf` + SHA-256 per step: budget CI-way runs. Hot files: a concurrent
EXTEND/REBASELINE on main means re-running REFORMAT after rebase. After 2b the path list is engine-repo-relative.

## 6. Open questions for the owner

- **Q1 the migration rule (§3 a').** Recommend yes. Value: GF-2 lands with no phone locked out, and the one PR that could hide a rule
  change is mechanically barred from containing one.
- **Q2 player stats and awards.** Record the final player-stats rows per stream as a MINOR field (only the server computes them; the S2
  contract gains "a phone must not compute or render player stats"), or MAJOR, or leave stats out and keep the award and stats manual
  bumps. Recommend MINOR in T4. Value: a stat-rule fix (MOTM counting) is tracked without forcing every scorer to update.
- **Q3 effective values in `outcome` / `summary` / `deltas`.** Recommend yes (free today, measured). Value: the corpus pins what the
  server stores and the phone shows; a settled or withdrawn match is recordable without a parallel field.
- **Q4 notes.** Retire the notes manual bump ("nothing computes from a note"; the claim stays as an inertness pin). Recommend yes.
  Value: the policy stops listing a bump that no change could ever owe.
- **Q5 mid-match summaries as digests only** (+105 KB) rather than full at anchors (+~1 MB). Recommend digests. Value: corpus stays
  about 3 MB; a moved summary is located by step and read by re-running the fold.
- **Q6 harness-only rewrites of EXISTING fields** under the same source freeze (would relax D34's "still a major"). Recommend not in
  GF-2. Value: no scope creep; revisit if a recorder fix ever has to lock out phones for nothing.
