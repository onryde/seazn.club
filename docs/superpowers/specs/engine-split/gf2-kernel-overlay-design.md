# GF-2 — record the kernel overlay in the golden corpora (design, phase A)

Status: for owner review, 2026-10-15, off `d601f9da5` (main with #961-#963). Follows `reviews/1e.md` M2, `reviews/golden-floor.md` #1
and `reviews/1e-minor.md`. Rules in force: D32b, D34, GOLDEN-POLICY.md, TEST-STRATEGY.md.

**Implementation status (2026-10-15, branch `feat/engine-gf2-kernel-overlay`): T1 and T2 done; T3 and T4 open.** See §7 for what landed and
what it changed in the plan.

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

## Owner rulings (2026-10-15)

The owner answered §6 on 2026-10-15. These bind T1-T4.

- **Q1 yes, with a condition.** A stream gaining the new fields for the first time owes no bump ONLY if the PR changes no
  fold-affecting code: nothing in the engine's `src/` outside `src/testkit/**`, `*.test.ts`, `*.golden.json`, `*.schema.json` and
  `*.md`; not the engine's `package.json`; not the root lockfile. Any other change in the PR makes every newly recorded stream
  count as CHANGED, and a major is owed.
- **Q2 player stats = MINOR** (T4): the final `aggregatePlayerStats` rows are a recorded field that owes a minor, never a major.
- **Q3 yes.** `outcome`, `summary` and `deltas` record the EFFECTIVE values (`outcomeOf`, `summaryOf`, `standingsDelta` of
  `outcomeOf`).
- **Q4 yes.** Notes need no manual bump (the `note` claim stays as an inertness pin, reason rewritten).
- **Q5 yes.** Live (mid-match) summaries are recorded as digests, one per step.
- **Q6.** D34's "a harness-only rewrite of EXISTING fields is a MAJOR" is unchanged.

## 7. Implementation status

- **T1 done** (recorder, format 2, `REFORMAT_GOLDEN`; reviewed, fixes below). **T2 done** (guard + the reformat commit). **T3 done** (below;
  awaiting review). **T4 open** (Q2 player stats).
- **Guard (T2).** As §3/§4, plus: the changed-path list comes from `git diff --name-only --no-renames` and untracked files, prefix-aware;
  a guard not told what changed fails closed (fold source touched); `src/sport/fold-epoch.ts` IS fold source, so paying ONE sport's bump in
  the PR that reformats leaves every other sport's newly recorded streams owing (the reformat lands alone, or every sport is bumped);
  a pre-existing field that moves during a reformat is a major whatever the source did (Q6); the format never falls (exit 1, no bump
  settles it), judged on the CORPUS (baseline format 2, current format 1) and not on the streams that happen to match, so a format-1
  rewrite with every stream re-recorded is red too; malformed formats and hybrids exit 2. Guard mutants: the 40 of the first pass all
  killed (the one first called equivalent, dropping `typeof s.overlay !== "string"`, is NOT: `JSON.parse` coerces its argument, so an
  array holding the text of an object, `["{}"]`, passes without the check; the `overlay: ["{}"]` row in the CLI malformed list kills
  it), plus the review's survivors (the path classifier through `includes` instead of `startsWith`/`endsWith` for `src/`, the
  `src/testkit/` slash, `.test.ts`, `.schema.json` and `.md`; the matched-streams-only format fall) each killed by a named row.
- **The reformat commit** (data only): 11 sports, 381 streams, 4,973 steps, 2,722,041 -> 2,866,061 bytes (+144,020, +5.3%); every one of the
  2,687 pre-existing stream fields byte-identical; `fold-epoch:check --against <parent>`: `changed 0`, `recorded 381`, 0 violations.
- **Teeth, measured (real kernel mutant, throwaway branch):** dropping `reason` from the open stoppage in `foldMatchWithStoppage`, then
  `REBASELINE_GOLDEN=1`: every module's state, outcome and summary stay byte for byte (the reason lives beside module state), the guard
  names all 11 sports (1-2 streams each) as major owed, exit 1; raising each FOLD_EPOCH settles it, exit 0. Before GF-2 the same
  re-baseline changed no recorded byte and the guard saw nothing.
- **Review fixes to T1** (test-only): the decider column pinned against the module's `awaitingDecider`; the recorded lineups pinned by an
  independent `initSquads` initial (20 streams across the 11 sports carry non-default sheets); `recomputeStream`'s `format` is a REQUIRED
  parameter and a wrong-format replay throws; the write gate is the pure `writeRefusal`; a reformat is all sports or none (`reformatAll`).
- **Deviation from §4 for T3, settled:** the floor's settle exemption and overlay-unpinned probes ran on `moduleRecorder` (format 1) until T3.
  T3 moves them onto `kernelRecorder` (format 2) and retires what that flips (below); `moduleRecorder` stays only as the CONTROL that shows
  each retired claim was true before.
- **Found while doing this:** the guard CLI fixtures held the table's current values as literals (boardgame epoch 1) and would have reddened
  at the first real bump; they now read the live table (proven with boardgame: 2, football: 3 and a raised minor).


### T3 — the floor requires the kernel overlay (done; awaiting review)

- **Floor tokens.** `overlay:<fact>:set|cleared` is required for every kernel overlay fact a fold computes (`stoppage`, `squads`, `settlement`,
  `expunged`, `levelWithdrawal`), read off the recorded streams' change points alone (`overlayTransitions`, golden-overlay.ts: no fold, so
  the floor can read a corpus it cannot fold). The set of facts is typed by `FOLD_OVERLAY_KEYS` (a new fold key without a rule row is a
  compile error). `levelWithdrawal` is required only where the sport can end level (football, cricket, boardgame, generic, icehockey,
  hockey); a squads `cleared` is never required (its default is a digest only a fold can compute). `undo:core.settle` joins
  `UNDOABLE_KERNEL`.
- **Two stories, appended** (`SCENARIOS` indices 9 and 10; the order is the reproduction contract): *settle* (the level route where the
  floor still wants a withdrawal over a level result: walk to a level result, withdrew, void, settle by the organiser, void, settle by
  lot; the abandon route elsewhere: a live match abandoned, settle, void, settle) and *expunge* (the withdrawal cascade's expunging
  abandon spliced into a walk, struck at once, play carrying on to the result it always had). Every step is read back from the kernel's own
  fold (`readsAs`, exported and tested) before a ledger is kept. The stoppage story now serves the stoppage overlay tokens and the
  withdrew story the squads token (`wantsLineup` includes it).
- **Batches.** A floor that grows is reproduced one BATCH at a time (`floorBatches`: a maximal run of floor streams; `corpusBefore`: the
  streams before it and only the configs they reference; `reproduceFloorBatch`). A batch is the FIRST thing today's rules append to its
  base, because a later batch exists exactly because the floor grew. Zero batches is a failure; per-batch counts are reported. The
  synthetic that proves the rule: a carrom corpus whose draw-capable config arrived after the first batch reds the old all-configs rule
  and reproduces under the new one.
- **Corpora.** `EXTEND_GOLDEN` appended 2 streams per sport (settle `9 * FLOOR_SEED_STRIDE + n`, expunge `10 * FLOOR_SEED_STRIDE + n`): 381
  to 403 streams, 2,866,061 to 3,069,649 bytes (+203,588, +7.1%). Every pre-existing stream byte-identical (script-checked: key order and
  every field); `fold-epoch:check --against origin/main`: 0 violations, the new streams are "newly recorded".
- **Retirements** (flip proven in both directions, per sport, counted): `FLOOR_EXEMPTIONS` is now empty (the settle row is a test fixture,
  `RETIRED_SETTLE_ROW`; `settleProbe` under `moduleRecorder` reads recorded != effective in all 11, under `kernelRecorder` equal);
  `OVERLAY_CLAIMS` holds only `note` ("nothing computes from a note") and `award` (player stats, T4); the `stoppage` row (11 sports) and the
  `lineup` row (boardgame, carrom, generic every type; football's position change) are fixtures that read "unpinned" under the module-only
  recorder and "pinned" under the real one. The probes default to `kernelRecorder` (the deviation T2 left for T3 is settled).
- **The probe is wider under format 2.** `ablationProbe` compares the dense overlay columns and the summary digests at every retained step and
  at the ablated event's own step (the event must be neutral where it sits). Three things the format-1 probe never needed: a void that
  struck a removed event goes with it (`ablateEvents` drops it and returns `origin`, the original index of each kept event); a recorded
  `eventId: "e-N"` in an overlay value is renumbered through the near-to-far map before comparing, or a note in front of a pause would
  read as a difference; the voids sweep reads ids in the ORIGINAL numbering. A format-1 recorder cannot hold a settle stream (the module
  alone never sees it), so the format-1 rebaseline test sets that stream aside by property, not by name.
- **apps/web readers.** `outcome-readers.test.ts` (the corpus scan is now "every settle stream is in a format-2 corpus and ends on a settled
  win", the methods taken from the engine's `SETTLE_METHODS`) and `timeline.test.ts` (the kernel types a corpus records are now all of them)
  were the only readers that moved; the other corpus readers (public-player-matches, player-matches, forfeit-vocabulary-scan, the skin tests) re-ran green.
- **Teeth, measured (real kernel mutants on a throwaway branch, `REBASELINE_GOLDEN=1`, guard `--against` the pre-mutation commit; every red
  is MAJOR owed, and bumping the sports named settles it):**

  | mutant | sports the guard names |
  |---|---|
  | `core.suspend` drops its `reason` | 11 (1-2 streams each) |
  | `outcomeOf` ignores the expunge | **1 (cricket)** |
  | the fold never sets `expunged` | 11 |
  | `outcomeOf` ignores a settlement | 11 |
  | `outcomeOf` ignores a level withdrawal | 6 (boardgame, cricket, football, generic, hockey, icehockey) |
  | `summaryOf` drops the overlay | 5 (boardgame, football, generic, hockey, icehockey) |
  | the position reducer is a no-op | 11 (incl. the four sports the old floor left unpinned) |
  | `awaitingDecider` also true when live | 1 (boardgame, 84 streams) |
  | football headline suffix only in phase H1 | 1 (football; the final `summary` moved in 0 of 37 streams, the digests in 37 streams / 163 steps) |

  Two premises of the plan did not survive the measurement. (1) "An expunge reaches every sport": `outcomeOf` ignoring `expunged` is seen in
  cricket alone, because only cricket's module answers an outcome after an abandon; football would, but only under
  `abandonPolicy: "award"`, and no corpus config carries it. That is owed coverage, named in GOLDEN-POLICY's cannot-see section (a config
  the corpora do not exercise), not a defect. The `expunged` column pins the fact in all 11 sports regardless. (2) `summaryOf` dropping the
  overlay is not seen in cricket: its summary is the scorecard, which does not read the award, so that mutant is inert there. Making
  `awaitingDecider` constantly false is caught earlier than the guard: the re-baseline REFUSES (boardgame's recorded tiebreak no longer folds,
  `TIEBREAK_NOT_APPLICABLE`), which is why the table's decider row is the "also true when live" variant.
- **Mutation sweep of the new floor code** (a driver of 68 mutants over `overlayTransitions`, the floor tokens and probe, the streams file and
  the voids sweep; one at a time, restored from a backup): 57 killed on the first pass; the 11 survivors were each either killed by a new
  test or removed. Overlay shape check: two copies of one validation made 6 mutants ambiguous and let two clauses hide behind each other, so
  there is one (`overlayPairs`) and a table test asks every malformed shape of both readers (`null` among them: it was a TypeError out of
  `Object.keys`, not a refusal). `ablationProbe`: a state that differs alone, a void that went with its target, and the default recorder
  each got a witness. The settle story's readback became `settleStoryHolds` with each fact asked ONCE and a test that defeats every
  kernel step alone (replaced by a note) on both routes; the reads the kernel's own refusals already make (a void that did not happen
  leaves its target standing and the next settle is refused, pinned) and the win-token check (a settle that stands is a win, X-ST-1, asserted
  per sport by the story test) were removed rather than left as guards nothing could kill. The expunge tail check likewise: the story test
  now compares every committed expunge stream's result with the kernel's fold of its bare walk.
  Final tally: 69 mutants in the driver, 69 killed, 0 survivors, 0 argued equivalent (the 5 mutants of removed code left the table, 6 for
  the new `settleStoryHolds` joined it). A second mutation pass found three more reads that only covered for a neighbour (a void's read and
  the next settle's refusal) and one guard (the expunge tail check) whose helper was tested but whose call site nothing killed; both went the
  same way.
