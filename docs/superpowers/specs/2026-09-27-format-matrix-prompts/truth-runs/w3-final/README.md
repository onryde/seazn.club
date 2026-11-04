# W3 truth run (W3 Swiss App B, Task 12)

The run of the tree W3 ships, and the L3 baseline that retires owner ruling 70. Branch `feat/w3-swiss-app-b` (PR #1121),
harness commit `bc6b645608` (`bc6b645608787458617f1d530888b62c8d5f5009`, engine `^3.0.2`, placement image `251624db9e`).
Brief: `.superpowers/sdd/2026-10-31-w3-swiss-app-b-plans/task-12-brief.md`.

**Verdict.** **L3 judges EXIT 0 with 0 regressions** against the current baseline (`w2e-final/ci/L3`, run 40874582041, ruling-70
block applied), and **no case in any layer reads "paired nobody"**. All three ruling-70 cells and `swiss_knockout|hockey|fih-outdoor|R4`
are `works`; every Swiss-row L3 case is `works` (135 of 135). **L1 and L2 are not complete**: 221 browser cases hit a harness fault,
every one of them a product change on `main` that the browser driver has not caught up with (F1, F2). No W3 cell is red for a W3 reason.

## The run

| run | what | harness commit | result |
|---|---|---|---|
| CI **41818942253** (`ci/`) | `matrix-truth.yml` `scope=full`, `workflow_dispatch` on `feat/w3-swiss-app-b` | `bc6b645608` | 12/12 shard jobs success; "Merge, judge, summarise" failed on `--require-complete` (L1 165 and L2 56 harness faults). L3 930 cases, 0 faults |

| layer | cases | driven | ✅ works | ⛔ refused | ❌ red | 🚫 no path | ░ planned | harness faults |
|---|---|---|---|---|---|---|---|---|
| L1 | 229 | 166 | 1 | 0 | 165 | 63 | 0 | 165 |
| L2 | 1729 | 56 | 0 | 0 | 56 | 279 | 1394 | 56 |
| L3 | 930 | 930 | 835 | 0 | 95 | 0 | 0 | 0 |

The baseline run (W2e CI 40874582041) for comparison: L1 166 ✅ / 10 ❌ / 53 🚫; L2 43 ✅ / 19 ❌ / 145 🚫 / 1522 ░; L3 831 ✅ / 99 ❌;
no harness fault in any layer. Every layer holds the same case ids as the baseline (229 / 1729 / 930, none added, none dropped), so no
`--expected-skips` list is needed.

## The judges (`pnpm matrix:judge regression`, baseline = `../w2e-final/ci/<L>/results.json`)

| file | layer | EXIT | compared | skipped | regressions |
|---|---|---|---|---|---|
| `judge-L1.json` | L1 | 1 | 229 | 0 | 165: 159 F1, 1 F2, 5 W7 routing |
| `judge-L2.json` | L2 | 1 | 1729 | 0 | 43: 41 F1, 2 W7 routing |
| `judge-L3.json` | L3 | **0** | 930 | 0 | **0** (`baseline overrides: 3 case(s) held red (cause P6, SW-H1, W3) — owner ruling 70`) |

`expect-<L>.json` is each run's own case ids. `ci/<L>/judge.json` is the CI merge job's `faults` verdict (L1 EXIT 1, 165 faults;
L2 EXIT 1, 56; L3 EXIT 0, 0).

### L3: what moved

| move | cases | which |
|---|---|---|
| ❌ → ✅ | 4 | `swiss_knockout\|carrom\|club-29\|R4` (a ruling-70 cell), `swiss_knockout\|hockey\|fih-outdoor\|R4`, `swiss_playoff\|football\|11-a-side\|R4`, `swiss_playoff\|hockey\|fih-outdoor\|R4`. Each was red in the baseline on `I4-nothing-ends-stuck: stage 1: round 5 paired nobody (SW-H1)` |
| ❌ → ❌, failing set changed | 5 | `mexicano\|{cricket,volleyball,tabletennis,tennis,icehockey}\|R4`: the intermittent mexicano 500 / re-seat family (carry `mexicano-generate-500`, FX-G11 / NEW-W1d-1, W7). Not a Swiss or boardgame row |
| unchanged | 921 | 831 ✅ → ✅, 90 ❌ → ❌ with the same failing checks |

Ruling 70's three cells in this run: `swiss_knockout|football|11-a-side|R4` works (16 checks, 181 items), `swiss_knockout|carrom|club-29|R4`
works (15, 149), `swiss_knockout|generic|score|R4` works (15, 149). Against the baseline with the block applied all three read red → works,
an improvement. Every boardgame red in L3 (4: `ko_plate` F1, `group_group_ko` F1, `page_playoff_only` R4, `stepladder_only` R4) is red in
the baseline too, for the same checks; none is a Swiss row.

## Findings

### F1: the browser driver waits for a page the New competition form no longer opens (main, not W3): 164 L1 + 56 L2 faults

Every one of them reads `error: ScreenNeverShowed: browser: the new competition's page /o/<org>/c/<slug> never showed within 15000 ms
(page.waitForURL: Timeout 15000ms exceeded.)`. `tools/matrix/lib/browser/pages/competition.ts:46` (`createCompetitionUi`) waits for the
browser to land on the competition after the wizard's POST, because the wizard used to `router.push` there. Since `133b6f4890`
(2026-11-02, "feat(new-competition): one column, Who will find it, first-division screen", on `main`) a successful create renders
`FirstDivisionPrompt` in place (`apps/web/src/components/v2/competition-wizard.tsx`, `setCreated(...)` then `if (created) return
<FirstDivisionPrompt …/>`) and the URL stays `/c/new`. The POST itself answered (the driver read the slug from it). The branch does not
change `competition-wizard.tsx` (no diff against the merge base `1a78319638`), and the last complete scheduled run on `main`
(41184503925, 2026-10-31) predates the change, so `main`'s next truth run reds the same cells. The only L1 case that works,
`group_group_ko|cricket|t20|LIFECYCLE@1280`, creates through the template gallery (`createFromTemplateUi`), which still navigates.

### F2: the driver clicks Generate on a started stage, which the stage card no longer offers (main, not W3): 1 L1 fault

`group_only|badminton|short|LIFECYCLE@1280` (template path) times out on
`locator('[id="stage-rail-sheet-<id>"]').getByTestId('stage-generate')`. Its own `05-generated-before` shot shows stage 1 `Active` with all
24 fixtures already drawn. Since the stage-card work on `main` (`9e01e23e6a`, 2026-11-01, `apps/web/src/lib/stage-card/summaries.ts`
`stageActions`) Generate leads only a stage that has not started, and `stage-rail.tsx` draws `stage-generate` only when it leads
(`showGenerate`). The branch changes neither file. Once F1 is fixed, other browser cells may reach this step and show the same fault.

### W7 routing (main `e7dfdf6d3a`): left alone

10 L1 cells (5 americano works → 🚫, 5 mexicano ❌ → 🚫) and 6 L2 cells (2 works → 🚫, 4 ❌ → 🚫), plus 128 L2 ░ → 🚫, read
`W7: no organiser path: the division builder does not offer americano or mexicano to a sport whose engine entrant model holds no
individual …`. That is `main`'s routing of the americano/mexicano cells to W7; this run records it and does not touch it.

### What "not complete" means

`summary --require-complete` (the merge job's last step) exits 1 when any layer holds a harness fault. Here that is F1 and F2 only: 221
browser cases never reached the product behaviour they test. It is a harness reason (the driver's model of two `main` screens is stale),
not a product defect and not a W3 one. L3 is complete: 930 cases, 0 faults.

## The re-baseline (owner ruling 70 retired)

The SW-H1 fix is W3's: the engine's `pairRound` (2.0.0 and later, with look-ahead) finds a legal round where 1.x dead-ended, and
`swissGen` (`apps/web/src/server/usecases/stages.ts`) refuses a round it cannot pair with `SWISS_NO_LEGAL_PAIRING` instead of reporting
an empty round as success. With it, no case reads "paired nobody" and the cells ruling 70 held red work. `tools/matrix/catalogue/baseline.json`
now names `w3-final/ci/L3/results.json` and carries no `ruling70` block; the next re-baseline cannot carry one (the loader refuses it by
name). The W1d record keeps its own block (`../w1d-baseline/baseline.json`), byte for byte, as the history the ruling was made on.

## Reproduce

```
pnpm matrix:judge regression --baseline truth-runs/w2e-final/ci/<L>/results.json --now truth-runs/w3-final/ci/<L>/results.json \
  --expect truth-runs/w3-final/expect-<L>.json --json-out judge-<L>.json
pnpm matrix:render truth-runs/w3-final/ci/<L>/results.json --out MATRIX.md      # byte-identical to ci/<L>/MATRIX.md
pnpm matrix:lock-check --against HEAD
```

The L3 judge above was run with the ruling-70 block still in `catalogue/baseline.json` (it says so in its output); the block was retired
in the commit after this one.
