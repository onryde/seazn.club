# W1-driving rebases — the commit map for recorded harness SHAs

W1-driving was rebased onto `main` twice on 2026-10-01. A rebase rewrites every branch commit, so the harness
SHAs that runs RECORDED (`results.json` `harnessCommit`, the generated `MATRIX.md` headers, and the run-time
`@ <harness>` citations in `w1drv-l3/TRIAGE.md`, `_INDEX.md` and the READMEs) name pre-rebase commits. They are
left as recorded: rewriting them would claim a run happened at a commit it did not run on. This file maps each
recorded SHA to the commit that now carries the same change.

**Harness equivalence.** Across each rebase the only `scripts/matrix` difference is a test file `main` changed,
and `packages/engine` is unchanged, so a recorded run reproduces at the mapped commit:

- Rebase 1 (onto `58e8103e3`, pre-rebase tip `4aa2e0db2` → `1b861f2ac`): `scripts/matrix/__tests__/page-objects.test.ts` only (main `bd66216d4`); `packages/engine` diff: 0 lines.
- Rebase 2 (onto `13c167a3e`, pre-rebase tip `8531282fb` → `d94ad587c`): `scripts/matrix/__tests__/workspace-wiring.test.ts` only (main `6bcad76e3`); `packages/engine` diff: 0 lines.

To map a rebase-1 SHA to HEAD's history, apply table 1, then table 2.

## Table 1 — rebase 1 (old → new)

| recorded | rebased (rebase 1) | subject |
|---|---|---|
| `4aa2e0db21b861f2acfeat(matrix): model team rosters, Swiss-biased commands, family-routed refusals (W1-driving T14, ruling 49, D6)` | `` |  |
| `af654f95e2baecaccatest(matrix): the model fake runs a single swiss stage (W1-driving T14, FP-T14-1)` | `` |  |
| `acea1d252064839963fix(matrix): template guards refuse by name — overrides, field size, answered key; degrade read as the product reads it (T13-R1 m-1 m-2 m-3 m-7)` | `` |  |
| `6a2f039809ccba673dtest(matrix): livePlan reads --set w1-driving-l1 and --set w1-driving; freeze the w1drv-l1 runs (T13-R1 I-1)` | `` |  |
| `7498e2b96669bbd259docs(matrix): W1-driving L1 truth runs — capability cells and the two template cards at 1280 (W1-driving T13 Step 7)` | `` |  |
| `3ef0ab26eeca0f0307feat(matrix): browser uses the setup filler; template-only cells driven through their cards; last W1-driving routes retired (W1-driving T13, ruling 47, D11)` | `` |  |
| `a28a51097b091e4741test(matrix): the template cards, D11 field size and the last W1-driving routes, failing first (W1-driving T13 RED)` | `` |  |
| `32e94271131f28e048fix(matrix): the turn tests run on no wall time; no lane takes an item after the trip (W1-driving T11+T12 fix round 4, I-1, T12-R5)` | `` |  |
| `7b2a769678d68944c3fix(matrix): cases that finish during an abort are listed for a re-run, never evidence (W1-driving T11+T12 fix round 3, T12-R4)` | `` |  |
| `dc36ae391a0e58d3f6fix(matrix): a timed-out shared turn aborts the run, naming its holder (W1-driving T11+T12 fix round 2, T12-R3)` | `` |  |
| `08c70dc819b085a6befix(matrix): entrants-only probe saves the kinds in use; workers header, turn deadline and lock sweep (W1-driving T11+T12 fix round 1)` | `` |  |
| `2a3af0b7d3a556ee77feat(matrix): the w1-driving set and --only on any catalogue cell (W1-driving T12)` | `` |  |
| `1a6371410eff68a737fix(matrix): the workers' sign-ins take turns (W1-driving T11 Step 7, found live)` | `` |  |
| `f2991b430240ed64acfix(matrix): workers take turns at the owner's staff window (W1-driving T11 Step 7, found live)` | `` |  |
| `13a62d22f4c4d7723cfeat(matrix): in-process workers, one session each, results in plan order (W1-driving T11, ruling 46, D10)` | `` |  |
| `4f479fecc53b9c0902test(matrix): drop the named-409 not-complete case the recorder never emits (W1-driving T9, T9-R5)` | `` |  |
| `dd5cdad1e7425a8407fix(matrix): I10 names its not-complete rank skip (W1-driving T9 fix round 2, T9-R4)` | `` |  |
| `8527813a5b409a9287fix(matrix): I9 judges active entrants' order; I10 reds a completed stage with no ranks (W1-driving T9 fix round 1, T9-R1..R3)` | `` |  |
| `608876dcb4fc9fddb8feat(matrix): I2 structural champion on DE/stepladder/page playoff; I9 ladder; I10 americano (W1-driving T9, ruling 45)` | `` |  |
| `dc4856440832c4289etest(matrix): pin SELF_PAIR_CAUSE to V213 and the v1 catch-all (T8-R5, I-R1)` | `` |  |
| `ad3d74739af6877f6dfix(matrix): americano/mexicano loop review fixes (T8-R1..R3, m-2, m-3, m-5)` | `` |  |
| `a3268b8248dfddb0e5feat(matrix): americano and mexicano round loops on linked persons; M1/R4 on the pair entrants per ruling 51; pair-entrant duplicate signature (W1-driving T8, D9, D14)` | `` |  |
| `49167f909c1982bd6ffix(matrix): F1 on a ladder judges the challenge sweep; T7 review minors (W1-driving T7 fix round 1, T7-R1, T7-R2)` | `` |  |
| `29bba05cff3689feb7feat(matrix): ladder driving through challenges; R4 on the ladder per rulings 51 and 53; kind-aware cascade (W1-driving T7, D8, D14)` | `` |  |
| `88b233484d6a8debedfix(matrix): T6 fix round 1 — per-stage draws, FP-2 bounded by withdrawn qualifiers, 409 seeding-failed recorded complete (T6-R3, T6-R4)` | `` |  |
| `9a49c1384184bc326ftest(matrix): the two T6 checks on their own — refused confirm, foreign seat, lineup-less side (mutation gaps)` | `` |  |
| `64579c7549b0f92d3dfeat(matrix): multi-stage driving — seed-proposal confirm, per-stage observation (W1-driving T6, D1, D12)` | `` |  |
| `69f40d857247b186ebfeat(matrix): refuse a run whose plan caps stages below a planned row (W1-driving T6 Step 3a)` | `` |  |
| `fcda449d5d338b0214feat(matrix): americano/mexicano individuals carry a linked person (W1-driving T5)` | `` |  |
| `6f47378e6336af8a8bfeat(matrix): team rosters and per-fixture lineups; the team-roster deferral goes (W1-driving T4, D3)` | `` |  |
| `0e118a4e06bece2570fix(matrix): putLineup returns the product's lineup check; fake mirrors the PUT (W1-driving T3 fix round 1, T3-R1, T3-R2)` | `` |  |
| `3889aa122a0f6814adfeat(matrix): roster seam — members on addEntrants, putLineup, entrantMembers; browser seeds them as filler (W1-driving T3, D2, ruling 47)` | `` |  |
| `8621df7f2fe41d525afeat(matrix): cricket tie and two-innings test streams; M5 gap and KNOWN_UNSUPPORTED emptied (W1-driving T10, ruling 44, D4, D5)` | `` |  |
| `85b0d0272cccc35d06feat(matrix): per-format field size — page playoff seeds 4, F1 unfit there (W1-driving T2)` | `` |  |
| `f7af41771cfe9d11d4test(matrix): the Status-row checks hold for a row in any state (W1-driving T1 fix round 2: I-3)` | `` |  |
| `5bd56975240a30c107fix(matrix): the Q-A guard floors its module scan and refuses any wave in prose (W1-driving T1 fix round 1: I-1, I-2, m-5)` | `` |  |
| `00c2d8199f40bb7700refactor(matrix): one routing construct the Q-A guard reads; OVERRIDE route → W2 (W1-driving T1, D7, ruling 47)` | `` |  |
| `ce1357d11fcd0a5c81docs(matrix): owner ruling 54, W1-driving plan approved, subagent-driven` | `` |  |
| `dc85a77417abc84723docs(matrix): W1-driving plan review 4 carries, status row awaiting owner` | `` |  |
| `aa62c92b261776a071docs(matrix): W1-driving plan fix round 3 (review 3)` | `` |  |
| `1268d59c9763b76995docs(matrix): W1-driving plan fix round 2 (review 2)` | `` |  |
| `8a5d647c4f76eb6acbdocs(matrix): owner ruling 53, ladder R4 expectation` | `` |  |
| `1c1ff8ad041b755bafdocs(matrix): W1-driving plan and wave prompt` | `` |  |
| `c9e18e39a2e2ed6165docs(matrix): owner rulings 50-52, W1-driving plan review 1` | `` |  |
| `7e21e2707d77b02c51docs(matrix): W1-driving plan and wave prompt` | `` |  |
| `98fc6d530643bb48fadocs(matrix): owner rulings 44-49, W1-driving scope` | `` |  |

## Table 2 — rebase 2 (old → new; these new SHAs are ancestors of the PR head)

| recorded | rebased (rebase 2) | subject |
|---|---|---|
| `8531282fbd94ad587cdocs(matrix): T16 re-review minors — W1d item 26 (shared-match fence blindness), quote provenance, stale MB count` | `` |  |
| `e0ef15d298e710167cdocs(matrix): owner words for rulings 55, 56 and 58 (controller, from the 2026-10-01 conversation)` | `` |  |
| `ed8afada2d5a1703a4docs(matrix): W1-driving fix round 1 — MB-010, rulings 55–59, the design's Order line, the seven minors` | `` |  |
| `5d3264a809d2c6f8f8fix(matrix): findings-table's refusal names no wave in a string (route guard)` | `` |  |
| `163078054fd5226c93feat(matrix): findings-table, the committed generator of _INDEX's product-red table (T16-R4 m-6)` | `` |  |
| `31792a06d8819d014ftest(matrix): T15-R5 holds every model run, save named W1b pre-fix history (T16-R4 m-7)` | `` |  |
| `215fd7ed503f15c773test(matrix): double elim ok 20/20 with both generate branches fenced (T16 fix round 1)` | `` |  |
| `548f3825debfc4c098test(matrix): --regressions replays all 9 committed cases known, MB-010 as itself (T16 fix round 1)` | `` |  |
| `8bad7555e7dd12bb04test(matrix): MB-010, double elim Generate after a withdrawal 500s (T16-R3 live re-run)` | `` |  |
| `5950801a3ea25dbc15fix(matrix): a replay is known as its own case when two cases share cell, check and match (T16 fix round 1)` | `` |  |
| `22c8aa1416a0d2f47afix(matrix): the double-elim generate fence guards the added-entrant branch only (T16-R3, I-1)` | `` |  |
| `2f79c5f07aea6f4bc9docs(matrix): W1-driving index — status, findings, R1, W1d/W2 prerequisites` | `` |  |
| `e5abe105ebb463fed4test(matrix): the T1-R1 floor test reads synthetic open rows, not the live W1-driving row (W1-driving T16)` | `` |  |
| `8198452ae8a8c8635btest(matrix): every committed case owes a committed live replay; MB-001..009 replayed 8/8, G-1 cells ok (T15-R5, G-1)` | `` |  |
| `95eb5203ccac0af3a7fix(matrix): MB-009 — the withdraw-on-TBD fence covers double elim too (G-1 live proof)` | `` |  |
| `ca3fcd08128804b04cfix(matrix): MB-007/MB-008 committed; the bracket fences widen to the kinds they witness (T15-R5, G-1)` | `` |  |
| `e2db86c9662a97ce02docs(matrix): americano/mexicano R4 re-run with r4-not-seated-later, re-triaged (T15-R9)` | `` |  |
| `817bf53d6fa4d0afd9fix(matrix): r4-not-seated-later, a withdrawn person seated again reds (T15-R9)` | `` |  |
| `f32f534db5eba9f664docs(matrix): fix-round live runs and the re-triage (T15-R6, T15-R7, T15-R8 m-1, m-2)` | `` |  |
| `1c50b26c9266617da6feat(matrix): per-case drawn-fixture counts from the env's own DB (T15-R8 m-2)` | `` |  |
| `666099834fc442fbfdfix(matrix): one bracket generator table, a named refusal, a DE F1 test (T15-R8 m-3, m-4, m-7)` | `` |  |
| `a8ba12f0bfe73feea1fix(matrix): the duplicate signature needs an earlier pair entrant (T15-R8 G-4, G-5, m-5)` | `` |  |
| `7cbfb9308070c34fbefix(matrix): derive the americano R4 policy from what the player had pending (T15-R6)` | `` |  |
| `bc1cf7e08a447878d4docs(matrix): W1-driving truth runs — slice, ruling-48 L3 on workers, L1 proof, triage` | `` |  |
| `63bda33e4775b8bd2cdocs(matrix): the model live on the T15 env — swiss at 40 runs, the m-6 rows (T14 Step 7)` | `` |  |
| `e26eda8899870207cbdocs(matrix): triage every red of the ruling-48 L3 run (T15 Step 3)` | `` |  |
| `93b47732dacad8a8eedocs(matrix): re-run the cells the three harness fixes touch (T15 triage)` | `` |  |
| `b1325f72165c4aef0ffix(matrix): M1 on a stepladder judges the title, since the walkover is the final (T15 triage)` | `` |  |
| `e51bf3699d30f18b54fix(matrix): the mexicano duplicate signature names every repeated person (T15 triage)` | `` |  |
| `9a64ec4cd6cbd634bafix(matrix): F1 judges a bracket's first round at the size the engine opens with (T15 triage)` | `` |  |
| `5ecbe18d604cfbfd19docs(matrix): the ruling-48 L3 run, 937 cases on 4 workers (T15 Step 2)` | `` |  |
| `15ed623653a8aabc0ddocs(matrix): W1-driving HTTP slice on 4 workers, no drift from W1c (T15 Step 1)` | `` |  |
| `49754e44abe69be892test(matrix): the by-product label is set where the cascade writes; the team cell's vacuous list asserted; the model header (W1-driving T14 fix round 1, m-3, m-5, m-7)` | `` |  |
| `749e08462304751125refactor(matrix): one lineup planner for the harness and the model (W1-driving T14 fix round 1, T14-R3, m-1, m-2, m-4, m-8)` | `` |  |
| `cde29a754f46171284fix(matrix): --regressions replays every committed case's cell; a skip is said aloud (W1-driving T14 fix round 1, T14-R2)` | `` |  |
| `1b861f2acac4de0b34feat(matrix): model team rosters, Swiss-biased commands, family-routed refusals (W1-driving T14, ruling 49, D6)` | `` |  |
| `2baecacca7b38605cetest(matrix): the model fake runs a single swiss stage (W1-driving T14, FP-T14-1)` | `` |  |
| `06483996353a40877cfix(matrix): template guards refuse by name — overrides, field size, answered key; degrade read as the product reads it (T13-R1 m-1 m-2 m-3 m-7)` | `` |  |
| `9ccba673d177d6c67ftest(matrix): livePlan reads --set w1-driving-l1 and --set w1-driving; freeze the w1drv-l1 runs (T13-R1 I-1)` | `` |  |
| `669bbd259175df4a92docs(matrix): W1-driving L1 truth runs — capability cells and the two template cards at 1280 (W1-driving T13 Step 7)` | `` |  |
| `eca0f03074a01d4020feat(matrix): browser uses the setup filler; template-only cells driven through their cards; last W1-driving routes retired (W1-driving T13, ruling 47, D11)` | `` |  |
| `b091e4741ef866f730test(matrix): the template cards, D11 field size and the last W1-driving routes, failing first (W1-driving T13 RED)` | `` |  |
| `31f28e0481fb616ceefix(matrix): the turn tests run on no wall time; no lane takes an item after the trip (W1-driving T11+T12 fix round 4, I-1, T12-R5)` | `` |  |
| `8d68944c3fa8e34114fix(matrix): cases that finish during an abort are listed for a re-run, never evidence (W1-driving T11+T12 fix round 3, T12-R4)` | `` |  |
| `a0e58d3f68d9978032fix(matrix): a timed-out shared turn aborts the run, naming its holder (W1-driving T11+T12 fix round 2, T12-R3)` | `` |  |
| `9b085a6be4384f9255fix(matrix): entrants-only probe saves the kinds in use; workers header, turn deadline and lock sweep (W1-driving T11+T12 fix round 1)` | `` |  |
| `3a556ee77084630d61feat(matrix): the w1-driving set and --only on any catalogue cell (W1-driving T12)` | `` |  |
| `eff68a7379bd0cc88dfix(matrix): the workers' sign-ins take turns (W1-driving T11 Step 7, found live)` | `` |  |
| `240ed64ac42d06674cfix(matrix): workers take turns at the owner's staff window (W1-driving T11 Step 7, found live)` | `` |  |
| `4c4d7723c711c4033ffeat(matrix): in-process workers, one session each, results in plan order (W1-driving T11, ruling 46, D10)` | `` |  |
| `53b9c0902cc6559ba8test(matrix): drop the named-409 not-complete case the recorder never emits (W1-driving T9, T9-R5)` | `` |  |
| `7425a8407a8cb38e1afix(matrix): I10 names its not-complete rank skip (W1-driving T9 fix round 2, T9-R4)` | `` |  |
| `b409a9287e75c303f3fix(matrix): I9 judges active entrants' order; I10 reds a completed stage with no ranks (W1-driving T9 fix round 1, T9-R1..R3)` | `` |  |
| `4fc9fddb844b7f9fd3feat(matrix): I2 structural champion on DE/stepladder/page playoff; I9 ladder; I10 americano (W1-driving T9, ruling 45)` | `` |  |
| `832c4289e09e3c22c0test(matrix): pin SELF_PAIR_CAUSE to V213 and the v1 catch-all (T8-R5, I-R1)` | `` |  |
| `af6877f6d3edaef968fix(matrix): americano/mexicano loop review fixes (T8-R1..R3, m-2, m-3, m-5)` | `` |  |
| `8dfddb0e5b7df2645efeat(matrix): americano and mexicano round loops on linked persons; M1/R4 on the pair entrants per ruling 51; pair-entrant duplicate signature (W1-driving T8, D9, D14)` | `` |  |
| `c1982bd6ff665b78a6fix(matrix): F1 on a ladder judges the challenge sweep; T7 review minors (W1-driving T7 fix round 1, T7-R1, T7-R2)` | `` |  |
| `f3689feb73f06af204feat(matrix): ladder driving through challenges; R4 on the ladder per rulings 51 and 53; kind-aware cascade (W1-driving T7, D8, D14)` | `` |  |
| `d6a8debed15b2f0663fix(matrix): T6 fix round 1 — per-stage draws, FP-2 bounded by withdrawn qualifiers, 409 seeding-failed recorded complete (T6-R3, T6-R4)` | `` |  |
| `184bc326f908550e91test(matrix): the two T6 checks on their own — refused confirm, foreign seat, lineup-less side (mutation gaps)` | `` |  |
| `9b0f92d3d0ce9ab52ffeat(matrix): multi-stage driving — seed-proposal confirm, per-stage observation (W1-driving T6, D1, D12)` | `` |  |
| `247b186eb7dbf30f67feat(matrix): refuse a run whose plan caps stages below a planned row (W1-driving T6 Step 3a)` | `` |  |
| `d338b0214f5e724e0efeat(matrix): americano/mexicano individuals carry a linked person (W1-driving T5)` | `` |  |
| `336af8a8bd082f02d9feat(matrix): team rosters and per-fixture lineups; the team-roster deferral goes (W1-driving T4, D3)` | `` |  |
| `6bece257044ff3f9d2fix(matrix): putLineup returns the product's lineup check; fake mirrors the PUT (W1-driving T3 fix round 1, T3-R1, T3-R2)` | `` |  |
| `a0f6814adaee302fbafeat(matrix): roster seam — members on addEntrants, putLineup, entrantMembers; browser seeds them as filler (W1-driving T3, D2, ruling 47)` | `` |  |
| `fe41d525a32a793424feat(matrix): cricket tie and two-innings test streams; M5 gap and KNOWN_UNSUPPORTED emptied (W1-driving T10, ruling 44, D4, D5)` | `` |  |
| `cccc35d0623a975461feat(matrix): per-format field size — page playoff seeds 4, F1 unfit there (W1-driving T2)` | `` |  |
| `cfe9d11d455e35792ftest(matrix): the Status-row checks hold for a row in any state (W1-driving T1 fix round 2: I-3)` | `` |  |
| `40a30c107f43ccd1cbfix(matrix): the Q-A guard floors its module scan and refuses any wave in prose (W1-driving T1 fix round 1: I-1, I-2, m-5)` | `` |  |
| `f40bb770048edefaa8refactor(matrix): one routing construct the Q-A guard reads; OVERRIDE route → W2 (W1-driving T1, D7, ruling 47)` | `` |  |
| `fcd0a5c810d0c41063docs(matrix): owner ruling 54, W1-driving plan approved, subagent-driven` | `` |  |
| `7abc8472350da01a48docs(matrix): W1-driving plan review 4 carries, status row awaiting owner` | `` |  |
| `61776a07104f2b22b0docs(matrix): W1-driving plan fix round 3 (review 3)` | `` |  |
| `763b76995cf19730bcdocs(matrix): W1-driving plan fix round 2 (review 2)` | `` |  |
| `f76eb6acbc4bfd5403docs(matrix): owner ruling 53, ladder R4 expectation` | `` |  |
| `41b755baf99cf9e3cedocs(matrix): W1-driving plan and wave prompt` | `` |  |
| `2e2ed616572b5398b9docs(matrix): owner rulings 50-52, W1-driving plan review 1` | `` |  |
| `d77b02c51918f39fabdocs(matrix): W1-driving plan and wave prompt` | `` |  |
| `643bb48facdd060902docs(matrix): owner rulings 44-49, W1-driving scope` | `` |  |
