# Standings Qualification Status (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every player, on every standings table with a forecastable cut-off, whether their place in the next stage is already won (Through), still open (Win and in / Win k and in / Needs help) or already lost (Out). Show it as a rank-cell marker, a cut line, a legend and a rank popover. Every status must be provably never wrong.

**Architecture:** The engine does the pure maths. `SportModule.matchPointsBounds` gives the points one side can take from a match. `qualification.ts` gives the independent-rival status and the "if you lose" status. `tie-what-if.ts` gives the tie-break target. One SQL function, `stage_qualification_meta(uuid)`, derives the cut-off from the destination stage's `progression`. The extended `public_stages_v` calls it for the public pages, and the console calls the same function. Nothing is derived twice. `server/public-site/qualification-view.ts` turns a snapshot, fixtures and stage meta into a resolved `QualificationView`. The hub's `buildTableView` and all three `StandingsTable` callers (division page, embed, console) call that one builder. The UI extends the shared rank popover from `feat/standings-popovers`.

**Tech Stack:** TypeScript 7 / Node 26, pnpm, `@seazn/engine` (vitest + fast-check), Next (see `node_modules/next/dist/docs/` before touching routes), Postgres/Flyway deltas, zod hub schema, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md` (owner-approved; rulings R1–R8 and R1a are binding). Read it with this plan. Where this plan departs from it, the reason is in "Premises checked" below.

---

## Premises checked (the brief is a hypothesis — re-verified against the tree, 2026-09-22, branch base `6f8a2593e`)

| # | Spec claim | Verdict | What the plan does |
|---|---|---|---|
| P1 | §3.1: `perMatch.max` = points for a win, `min` = points for a loss, "a draw's points lie between these", both "from the stage's `PointsRule` (a stage override, else the division/sport points)". | **FALSE, in two ways.** (a) A win is not one number. Ice hockey OT win 2 vs regulation 3 (`period/kernel.ts:201-207`), volleyball 3-2 win 2 vs 3-0 win 3 (`setbased/volleyball.ts:11`), football group shoot-out win (`football.ts:113-120`). One "win" value cannot be both the rivals' upper bound and the gain that "Win and in" promises. A scratch brute force using `max` for the win_k target produced wrong "Win and in" results on volleyball and ice-hockey scoring. (b) There is no uniform "sport points". Each module reads its own cfg shape (`points.win`, `points.w`, `pointsMap`, `scoring.win`), and `SportModule` exposes only `declaredPointsSets` (sums of the two sides, `sport/module.ts:772`). | Adds a required `SportModule.matchPointsBounds(cfg) → { max, min, winFloor, lossCeil }`, implemented in all 8 kernels and checked against real `standingsDelta` output by a new conformance property (Task 1). A stage `PointsRule` replaces it through `pointsRuleBounds` (Task 2). Its bonuses can lift a win above `base.win` and a loss above `base.loss`, which is why `winFloor`/`lossCeil` exist. |
| P2 | §3.1 Swiss `remaining` = rounds minus rounds "the entrant has been seated in". | **IMPRECISE, and unsafe as worded.** Swiss seats a round at pairing, before it is played (`swiss-legend.spec.ts:233-248`). `startDivision` also mints null-seat shells for later rounds (`swiss-legend.spec.ts:207-211`). Counting a seated but unplayed round as played undercounts `remaining`, which can print a false **Out**. | Counts rounds in which the entrant has a SETTLED fixture (`decided`/`walkover`/`void`; a bye is a settled one-seat fixture) (Task 5). |
| P3 | §4.1: "the one behind `standings-table.tsx`" builder. | **FALSE.** No such builder exists. `StandingsTable` is a server component that takes raw `StandingsRow[]` (`components/public-site/standings-table.tsx:94-103`) and is mounted by the division page, the embed and the console. | One shared `buildQualificationView` is called by all four surfaces (Tasks 5, 6, 7, 9). |
| P4 | §4.1: the view gains four columns: `qualify_count`, `qualify_per_group`, `next_stage_name`, `swiss_rounds`. | **INSUFFICIENT.** The public read path cannot see the stage's `PointsRule` (`stages.config.points`, private). Without it a custom-points stage (bonus points) would be forecast with the sport's points, which R3 forbids. | Adds a fifth column, `points_rule` (the organiser's points rule — not sensitive, since the table already prints the points it produces). The derivation lives in one SQL function that the view AND the console both call, which is how §4.2's "do not fork the calculation" is met (Task 4). **Owner-visible deviation — see Open questions.** |
| P5 | §3.4 signature `tieWhatIf(row, rival, cascade, ledger)`. | **REDUNDANT PARAM.** The ledger is on the row (`row.metrics`). The Swiss metrics are materialised into it by `rankStandings` (`display.ts:9-10`). | `tieWhatIf(row, rival, cascade)` (Task 3). |
| P6 | §3.4: a target fires when the first cascade key after `points` is a ratio, `diff` or `for`. | **TRUE as written, but rarely reached by the shipped defaults.** Badminton, volleyball and table tennis (`["points","wins",…]`), carrom and cricket all put `wins` second. Football's default `fifa2026` puts `h2h_points` second (`football.ts:1707`), and boardgame puts `buchholz_cut1` second. Only generic (`diff`), hockey (`diff`), tennis (`set_ratio`), football `classic` and custom cascades reach a target. `game_ratio` (tennis's third key) is an own-results key that R5's list does not name. | Implements R5 literally: `wins`, `game_ratio` and head-to-head get the rule plus current values. **Recorded as Open question 1.** |
| P7 | §3.3 lists the no-status cases. | **INCOMPLETE.** More inputs make the points-only bound unsafe: manual rank locks (`StandingsRow.rankLocked`, `standings.ts:26`), a cascade that does not start with `points`, unsettled TBD (null-seat) league fixtures, a `rankRange` cut on a POOLED stage, and a `bestNth`/`picks`/`roundLosers` rule on any destination of the same source. | Each of these returns `null` (Tasks 4, 5). Pinned in Review Focus. |
| P8 | §3.1 `min` from the sport. | **TRUE WITH A CAVEAT.** Every shipped sport cfg schema is `nonnegative()` (`football.ts:113`, `generic.ts:38`, `period/kernel.ts:201`, …), and no-result outcomes score 0. | Module `min` is `min(0, …values)`. It is safe, and cautious for configs where a loss scores above 0 (Task 1). |
| P9 | Pins: `progression.ts:33` TakeRule; `isTableStageComplete`; `data.ts:901`; `awardByeDelta`; `cascadeFor`; `table.tieBreak`; console `force-dynamic`. | **TRUE, re-pinned.** TakeRule `progression.ts:32-37`; `progressionSize` `:142-150`; `isTableStageComplete` `stage.ts:123-137`; stage select `data.ts:901-903` (embed `embed-data.ts:93-95`); `awardByeDelta` `engine-db/competition.ts:101-128` (a bye scores through the module's own `standingsDelta`, so module bounds cover it); `cascadeFor` `:405-407`; `toEngineStatus` `:73-88` (private); `table.tieBreak` is a flat key in `dictionaries/{en,es,fr,nl}/public.json`; console `page.tsx:1` is `force-dynamic` and reads stages via `listStages` (`usecases/stages.ts:258`) and snapshots via `getStandings` (`:4505`). `public_stages_v` is defined only in `v2-engine/views/V233__view_public_stages.sql` and granted in `V239__v2_grants.sql:13-15`. The delta tail is `V413` on this branch and on `origin/main`. | — |
| P10 | §7: popovers merge to `main` first, then Phase 1 branches from `main`. | **SUPERSEDED (owner, 2026-09-22, "One PR only").** | UI tasks rebase this branch onto `feat/standings-popovers`. One PR carries both. Spec §7 is updated in the same commit as this plan. |

## Global Constraints

- Status must never be wrong (R3): independent-rival bound only. Every `through`/`out`/`win_k` must hold over every real outcome. When in doubt, return `null` (no status). Never guess.
- A tie on points at the line is never Through or Out (R4): `≥` in the `through` and `win_k` rules. Test it with a case where `>` would print Through.
- Labels (R7), exact English: **Through**, **Win and in**, **Win {k} and in**, **Needs help**, **Out**. The legend groups the middle two as **Still open**. The cut line reads "Top {N} go through to {next stage} · {r} round(s) left".
- Layout Option B (R6): a marker in the rank cell plus a cut line. **No new column.** Status, tie note and what-if live in the one rank popover.
- What-if (R5): a target only when the first key after `points` is `point_ratio`, `set_ratio`, `board_ratio`, `diff` or `for`. It is always labelled "assumes the rival's figures stay the same". Head-to-head, Buchholz, SB and lots get the rule and the values, never a target.
- The organiser console shows the same markers, cut line, legend and popover (R1a).
- Covers league, group (pools, `topNPerGroup` → one line per pool) and swiss stages (R2). A `rankRange` that does not start at 1, `bestNth`, `picks` and `roundLosers` → no status.
- Every user-facing string goes in all 4 locales (`en`, `es`, `fr`, `nl`) in `apps/web/src/dictionaries/<locale>/public.json`, then `pnpm i18n:gen-keys` and `pnpm i18n:check`. Never hardcode English.
- Rank-cell tap target ≥ 40px on phones (hit-test with `elementFromPoint`, not `boundingBox`). No horizontal page scroll at 320, 768 or 1280.
- pnpm, not npm. Every shell command in a worktree starts `cd /Users/ashokhein/github/seazn.club-wt-qualstatus && …` (cwd resets between calls). Use `grep -a`.
- Vitest green is judged ONLY from `--reporter=json --outputFile=<scratch>/x.json`. Read `numPassedTests`/`numTotalTests`/`numFailedTests`, confirm `.testResults[].name` paths resolve inside this worktree, and check the file's mtime is fresh (a refused config returns the PREVIOUS run's JSON). Never trust the `rtk` summary.
- Playwright: cwd `apps/web`, `PLAYWRIGHT_BASE=http://localhost:<port>` (**localhost, never 127.0.0.1**). Run whole spec files, never a `-g` slice. In a serial file, treat a red count as a floor, not a total.
- Lint via `rtk proxy pnpm --filter web lint` and read `✖ N problems`.
- Before every commit: `pnpm openapi:gen && git status --porcelain` shows no drift (RULES.md "Pre-commit").
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Use `git commit -F <file>` (no heredocs in worktree sessions). Never `git stash` in this worktree.
- Every task ships unit, e2e, smoke and regression coverage (RULES.md). Engine-only tasks trace forward to Task 10's e2e. Each is named in the task's acceptance line.

## Review Focus

The inputs the spec implies but no happy-path test meets. Each has a pinned test in the task named.

1. **A stage whose standings carry manual rank locks** (`rank_overrides` → `rankLocked` rows). Ranks no longer follow points, so any points-based status can be wrong. Expected: no markers, no cut line. Test: Task 5, `"a rank-locked table shows no status"`.
2. **A custom `PointsRule` with bonus points** (for example win +1 for a big margin, loss +1 for a close one). Expected: bounds include the bonus, so "Win and in" and "Out" stay true. Test: Task 2, `pointsRuleBounds` checked against `applyPointsRule` over every outcome. Task 5, `"a stage points rule overrides the sport's bounds"`.
3. **A league whose fixtures still hold TBD seats** (a `timing: "setup"` progression source). Remaining matches cannot be counted per entrant. Expected: no status. Test: Task 5, `"an unsettled null-seat league fixture suppresses status"`, paired with a settled null-seat bye that does NOT suppress it.
4. **A cascade that does not start with `points`** (an organiser override that ranks by wins first). Expected: no status. Test: Task 5, `"a cascade not led by points shows no status"`.
5. **A group stage whose cut is an overall `rankRange`** (not `topNPerGroup`). One overall cut cannot be split per pool. Expected: no status on any pool table. Test: Task 4 (the view returns `qualify_per_group = false`) and Task 5 (`"an overall cut on a pooled table shows no status"`).

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/engine/src/sport/module.ts` | `MatchPointsBounds`, `boundsFrom`, required `matchPointsBounds` on `SportModule` | 1 |
| `packages/engine/src/sports/{football/football.ts,cricket/cricket.ts,period/kernel.ts,carrom/carrom.ts,boardgame/boardgame.ts,generic/generic.ts,nested/kernel.ts,setbased/kernel.ts}` | one `matchPointsBounds` each | 1 |
| `packages/engine/src/testkit/conformance.ts` (+ the two fake modules in `conformance.test.ts`, `conformance-pad.test.ts`) | §9.3b property: each side's points fall inside the bounds | 1 |
| `packages/engine/src/sport/match-points-bounds.test.ts` (new) | per-module bound checks over `builtinModules` and variants | 1 |
| `packages/engine/src/competition/points.ts` | `pointsRuleBounds` | 2 |
| `packages/engine/src/competition/qualification.ts` (new) + `qualification.test.ts` | statuses, if-you-lose, `tieRival`, brute force | 2 |
| `packages/engine/src/competition/tie-what-if.ts` (new) + `tie-what-if.test.ts` | `tieDecidingKey`, `tieWhatIf`, `tieKeyValue` | 3 |
| `packages/engine/src/competition/tiebreakers.ts` | export `DIFF_KEYS`, `FOR_KEYS`, new `AGAINST_KEYS` | 3 |
| `packages/engine/src/competition/index.ts` | re-exports | 2, 3 |
| `db/migration/deltas/V414__public_stages_qualification.sql` (new) | `stage_qualification_meta` + `public_stages_v` | 4 |
| `apps/web/src/server/public-site/data.ts`, `embed-data.ts` | select the new columns (+ `dv.config` in embed); cache key `pub-div-v3` | 4 |
| `apps/web/src/server/public-site/__tests__/public-stages-qualification-db.test.ts` (new) | view + function against real Postgres | 4 |
| `apps/web/src/lib/fixture-engine-status.ts` (new) | DB status → engine `FixtureStatus` (moved out of `engine-db/competition.ts`) | 5 |
| `apps/web/src/server/public-site/qualification-view.ts` (new) + `__tests__/qualification-view.test.ts` | input derivation + resolved strings | 5 |
| `apps/web/src/server/public-site/competition-hub-schema.ts` | `QualRow`, `QualTable`; `TableRow.qual`, `TableView.qualification` | 5 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`, `apps/web/src/lib/i18n-keys.ts` (generated) | `table.qual.*` | 5 |
| `apps/web/src/server/public-site/standings-view.ts`, `competition-hub.ts` | hub wiring; cache key `pub-hub-v4`; OpenAPI regen | 6 |
| `apps/web/src/components/public-site/qualification-bits.tsx` (new) | `QualMarker`, `QualCutRow`, `QualLegend`, `QualPopoverBody` | 7 |
| `apps/web/src/components/public-site/standings-table.tsx`; division `page.tsx`; embed `page.tsx` | markers/cut/legend/popover on the server table | 7 |
| `apps/web/src/components/public-site/standings-table-view.tsx` | same on the hub table | 8 |
| `apps/web/src/server/usecases/stage-qualification.ts` (new); console `page.tsx` | console wiring (R1a) | 9 |
| `apps/web/e2e/standings-qualification.spec.ts` (new); `scripts/smoke.ts` | e2e, smoke, regression, screenshots, PR | 10 |

---

### Task 1: `SportModule.matchPointsBounds` — per-match points bounds owned by each sport

**Files:**
- Modify: `packages/engine/src/sport/module.ts:760-773` (add the method beside `declaredPointsSets`, and the type plus helper above `SportModule`)
- Modify: `packages/engine/src/sports/football/football.ts:2671` (beside `declaredPointsSets`)
- Modify: `packages/engine/src/sports/cricket/cricket.ts:3966`
- Modify: `packages/engine/src/sports/period/kernel.ts:2649`
- Modify: `packages/engine/src/sports/carrom/carrom.ts:991`
- Modify: `packages/engine/src/sports/boardgame/boardgame.ts:775`
- Modify: `packages/engine/src/sports/generic/generic.ts:658`
- Modify: `packages/engine/src/sports/nested/kernel.ts:2227`
- Modify: `packages/engine/src/sports/setbased/kernel.ts:2475`
- Modify: `packages/engine/src/testkit/conformance.ts:~172` (new §9.3b `it` after §9.3)
- Modify: `packages/engine/src/testkit/conformance.test.ts:190`, `packages/engine/src/testkit/conformance-pad.test.ts:119` (fake modules gain the method)
- Create: `packages/engine/src/sport/match-points-bounds.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // @seazn/engine/sport
  export interface MatchPointsBounds { max: number; min: number; winFloor: number; lossCeil: number }
  export function boundsFrom(wins: readonly number[], losses: readonly number[], others?: readonly number[]): MatchPointsBounds;
  interface SportModule<Cfg, …> { matchPointsBounds(cfg: Cfg): MatchPointsBounds }
  ```

**Acceptance:** RULES.md unit (new test file + conformance §9.3b across every module's existing `conformanceSuite` calls); regression (all engine suites stay green); e2e/smoke are owed through Task 10 (the bounds feed every status a spectator sees).

- [ ] **Step 1: Write the failing per-module test**

Create `packages/engine/src/sport/match-points-bounds.test.ts`:

```ts
// Standings qualification status (spec 2026-09-22 §3.1, plan P1): every sport
// declares the points ONE SIDE can take from one match. `winFloor`/`lossCeil`
// exist because a win is not one number — OT, shoot-out and 3-2 wins pay less.
//
// Expected values are read off each module's OWN parsed cfg, never typed:
// change a default and this file moves with it. The volleyball and ice-hockey
// cases are the ones where the right answer differs from the wrong constant
// (`winFloor` ≠ `max`, `lossCeil` ≠ `min`).
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { generic } from "../sports/generic/index.ts";
import { boundsFrom } from "./module.ts";

describe("boundsFrom", () => {
  it("states the empty-`others` case: max/min come from wins and losses alone, min never above 0", () => {
    expect(boundsFrom([3], [1])).toEqual({ max: 3, min: 0, winFloor: 3, lossCeil: 1 });
  });
  it("winFloor is the SMALLEST win, lossCeil the LARGEST loss", () => {
    expect(boundsFrom([3, 2], [0, 1], [1])).toEqual({ max: 3, min: 0, winFloor: 2, lossCeil: 1 });
  });
});

describe("matchPointsBounds — every shipped module and variant is coherent", () => {
  for (const m of builtinModules) {
    const cfgs: [string, unknown][] = [["default", {}], ...Object.entries(m.variants ?? {})];
    for (const [label, raw] of cfgs) {
      it(`${m.key} (${label})`, () => {
        const cfg = m.configSchema.parse(raw);
        const b = m.matchPointsBounds(cfg);
        expect(b.min).toBeLessThanOrEqual(b.lossCeil);
        expect(b.lossCeil).toBeLessThanOrEqual(b.max);
        expect(b.min).toBeLessThanOrEqual(b.winFloor);
        expect(b.winFloor).toBeLessThanOrEqual(b.max);
        expect(b.min).toBeLessThanOrEqual(0); // no-result scores 0 (plan P8)
        // A declared pair total can never exceed what two sides could take.
        for (const total of m.declaredPointsSets(cfg)) expect(total).toBeLessThanOrEqual(2 * b.max);
      });
    }
  }
});

describe("matchPointsBounds — the cases a single 'win' constant gets wrong", () => {
  it("volleyball FIVB: a 3-2 win pays less than a 3-0, a 2-3 loss pays more than 0-3", () => {
    const cfg = volleyball.configSchema.parse({});
    const pairs = Object.values(cfg.pointsMap) as [number, number][];
    const b = volleyball.matchPointsBounds(cfg);
    expect(b.winFloor).toBe(Math.min(...pairs.map((p) => p[0])));
    expect(b.lossCeil).toBe(Math.max(...pairs.map((p) => p[1])));
    expect(b.winFloor).toBeLessThan(b.max); // the differential: winFloor ≠ max
    expect(b.lossCeil).toBeGreaterThan(b.min); // and lossCeil ≠ min
  });
  it("ice hockey: an OT win is the floor, an OT loss the ceiling", () => {
    const cfg = icehockey.configSchema.parse({});
    const p = cfg.points;
    const b = icehockey.matchPointsBounds(cfg);
    expect(b.winFloor).toBe(Math.min(p.win, p.otWin ?? p.win, p.shootoutWin ?? p.win));
    expect(b.lossCeil).toBe(Math.max(p.loss, p.otLoss ?? p.loss, p.shootoutLoss ?? p.loss));
    expect(b.max).toBe(Math.max(p.win, p.draw, p.otWin ?? 0, p.shootoutWin ?? 0));
  });
  it("generic: win/draw/loss read from `points.w/d/l`", () => {
    const cfg = generic.configSchema.parse({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false });
    expect(generic.matchPointsBounds(cfg)).toEqual({ max: cfg.points.w, min: 0, winFloor: cfg.points.w, lossCeil: cfg.points.l });
  });
});
```

- [ ] **Step 2: Run it, expect the collect to fail**

Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus/packages/engine && pnpm exec vitest run src/sport/match-points-bounds.test.ts --reporter=json --outputFile=/private/tmp/claude-501/qual-t1.json; echo EXIT=$?`
Expected: FAIL. `boundsFrom` is not exported, and `matchPointsBounds is not a function`. Read the JSON. A suite that failed to COLLECT shows `numTotalTests: 0`, which is also a red.

- [ ] **Step 3: Add the type, helper and interface member**

In `packages/engine/src/sport/module.ts`, directly above `export interface SportModule`:

```ts
/** Points ONE side can take from ONE match under a cfg — standings
 *  qualification status (spec 2026-09-22 §3.1, plan P1). `max`/`min` bound
 *  every outcome (a bye included: it scores through `standingsDelta` as a
 *  win). `winFloor` is what ANY win (OT, shoot-out, 3-2) is guaranteed to pay;
 *  `lossCeil` is the most ANY loss can still pay. A forecast that promised
 *  "win and you're through" with `max` would be wrong for an OT win. */
export interface MatchPointsBounds {
  max: number;
  min: number;
  winFloor: number;
  lossCeil: number;
}

/** Build bounds from a sport's win-type values, loss-type values and every
 *  other per-side value (draw, tie, no-result). `min` never exceeds 0: a
 *  no-result scores 0, and every shipped cfg schema is nonnegative (plan P8). */
export function boundsFrom(
  wins: readonly number[],
  losses: readonly number[],
  others: readonly number[] = [],
): MatchPointsBounds {
  const all = [...wins, ...losses, ...others];
  return {
    max: Math.max(...all),
    min: Math.min(0, ...all),
    winFloor: Math.min(...wins),
    lossCeil: Math.max(...losses),
  };
}
```

Inside `SportModule`, directly after `declaredPointsSets(cfg: Cfg): readonly number[];` (`:773`):

```ts
  // Standings qualification (spec 2026-09-22 §3.1) — per-SIDE bounds, checked
  // against real `standingsDelta` output by conformance §9.3b.
  matchPointsBounds(cfg: Cfg): MatchPointsBounds;
```

- [ ] **Step 4: Implement it in all 8 kernels, each directly after its `declaredPointsSets`**

Import `boundsFrom` from the file's existing `../../sport/module.ts` import in each.

`football/football.ts`:
```ts
  matchPointsBounds(cfg) {
    const p = cfg.points;
    return boundsFrom(
      [p.win, ...(p.shootoutWin !== undefined ? [p.shootoutWin] : [])],
      [p.loss, ...(p.shootoutLoss !== undefined ? [p.shootoutLoss] : [])],
      [p.draw],
    );
  },
```
`cricket/cricket.ts`:
```ts
  matchPointsBounds(cfg) {
    const p = cfg.points;
    return boundsFrom([p.win], [p.loss], [p.tie, p.noResult, ...(p.draw !== undefined ? [p.draw] : [])]);
  },
```
`period/kernel.ts`:
```ts
    matchPointsBounds(cfg) {
      const p = cfg.points;
      const opt = (v: number | undefined) => (v !== undefined ? [v] : []);
      return boundsFrom(
        [p.win, ...opt(p.otWin), ...opt(p.shootoutWin)],
        [p.loss, ...opt(p.otLoss), ...opt(p.shootoutLoss)],
        [p.draw],
      );
    },
```
`carrom/carrom.ts`:
```ts
  matchPointsBounds(cfg) {
    return boundsFrom([cfg.points.win], [cfg.points.loss], [cfg.points.draw]);
  },
```
`boardgame/boardgame.ts` (a bye is a win, `boardgame.ts:725-731`):
```ts
  matchPointsBounds(cfg) {
    return boundsFrom([cfg.scoring.win], [cfg.scoring.loss], [cfg.scoring.draw]);
  },
```
`generic/generic.ts`:
```ts
  matchPointsBounds(cfg) {
    return boundsFrom([cfg.points.w], [cfg.points.l], [cfg.points.d]);
  },
```
`nested/kernel.ts`:
```ts
    matchPointsBounds(cfg) {
      return boundsFrom([cfg.points.win], [cfg.points.loss]);
    },
```
`setbased/kernel.ts` (forfeits use `cleanSweepPair`, which is one of the map's pairs):
```ts
    matchPointsBounds(cfg) {
      const pairs = Object.values(cfg.pointsMap) as readonly (readonly [number, number])[];
      return boundsFrom(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    },
```
In `testkit/conformance.test.ts:190` and `testkit/conformance-pad.test.ts:119`, add beside each fake `declaredPointsSets`:
```ts
  matchPointsBounds: () => ({ max: 2, min: 0, winFloor: 2, lossCeil: 0 }),   // conformance.test.ts (declared [2])
  matchPointsBounds: () => ({ max: 0, min: 0, winFloor: 0, lossCeil: 0 }),   // conformance-pad.test.ts (declared [0])
```
(Read each fake's `standingsDelta` first. If it awards anything other than 2/0 or 0/0, set the bounds to what it actually awards.)

- [ ] **Step 5: Add conformance §9.3b**

In `testkit/conformance.ts`, directly after the §9.3 `it(...)` block (ends `:~187`):

```ts
    // §9.3b — each SIDE's points sit inside matchPointsBounds; a win pays at
    // least winFloor, a loss at most lossCeil (standings qualification, spec
    // 2026-09-22 §3.1). This is what makes "Win and in" never wrong.
    it("§9.3b standingsDelta stays inside matchPointsBounds", () => {
      const b = module.matchPointsBounds(cfg);
      expect(b.min).toBeLessThanOrEqual(b.max);
      fc.assert(
        fc.property(streamArb, (events) => {
          const decided = decidedOnly(events);
          if (!decided) return;
          for (const ctx of stageCtxs) {
            if (decided.outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind)) continue;
            const pair = module.standingsDelta(decided.outcome, cfg, ctx, decided.state);
            for (const d of pair) {
              expect(d.points).toBeGreaterThanOrEqual(b.min);
              expect(d.points).toBeLessThanOrEqual(b.max);
              if (d.won === 1) expect(d.points).toBeGreaterThanOrEqual(b.winFloor);
              if (d.lost === 1) expect(d.points).toBeLessThanOrEqual(b.lossCeil);
            }
          }
        }),
        { numRuns },
      );
    });
```

- [ ] **Step 6: Run the new test, the conformance-bearing suites and typecheck**

Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus/packages/engine && pnpm exec vitest run src/sport src/sports src/testkit/conformance.test.ts src/testkit/conformance-pad.test.ts --reporter=json --outputFile=/private/tmp/claude-501/qual-t1.json; echo EXIT=$? && pnpm typecheck; echo TSC=$?`
Expected: `numFailedTests: 0` and `numTotalTests` is at least the previous count plus the new tests. `TSC=0`. A tsc red naming a module you did not edit means a ninth `SportModule` implementer exists. Implement it too, and record it in the task report.

- [ ] **Step 7: Mutation checks (each must turn red, then revert)**

1. In `boundsFrom`, change `winFloor: Math.min(...wins)` to `Math.max(...wins)` → the volleyball and ice-hockey cases fail (and §9.3b for volleyball if a 3-2 is generated).
2. In `setbased/kernel.ts`, change `p[1]` to `p[0]` in the losses map → volleyball `lossCeil` fails.
3. In `period/kernel.ts`, drop `...opt(p.otWin)` → the ice-hockey `winFloor` case fails.
4. In `conformance.ts §9.3b`, delete the `winFloor` line and re-run the volleyball suite with mutant 1 applied. Record whether §9.3b alone would have caught it (report the KILLER LIST, not a count).

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-wt-qualstatus && git add packages/engine/src/sport packages/engine/src/sports packages/engine/src/testkit && git commit -F <msgfile>
```
Message: `feat(engine): SportModule.matchPointsBounds — per-side points bounds with win floor and loss ceiling` + blank line + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

### Task 2: Engine qualification status, "if you lose", tie rival, `pointsRuleBounds`, brute-force cross-check

**Files:**
- Create: `packages/engine/src/competition/qualification.ts`
- Create: `packages/engine/src/competition/qualification.test.ts`
- Modify: `packages/engine/src/competition/points.ts` (append `pointsRuleBounds`)
- Modify: `packages/engine/src/competition/points.test.ts` (append a describe)
- Modify: `packages/engine/src/competition/index.ts` (add `export * from "./qualification.ts";`)

**Interfaces:**
- Consumes: `MatchPointsBounds` (Task 1).
- Produces:
  ```ts
  export type QualStatus = { kind: "through" } | { kind: "out" } | { kind: "win_k"; k: number } | { kind: "needs_help" };
  export interface QualRow { entrantId: EntrantId; points: number; active: boolean }
  export interface QualificationInput { rows: readonly QualRow[]; remaining: ReadonlyMap<EntrantId, number>; perMatch: MatchPointsBounds; cut: number; anyPlayed: boolean; complete: boolean }
  export interface QualRowResult { status: QualStatus; ifYouLose: QualStatus | null }
  export function qualificationStatus(input: QualificationInput): ReadonlyMap<EntrantId, QualRowResult | null> | null;
  export function bestCase(input: QualificationInput, row: QualRow): number;
  export function worstCase(input: QualificationInput, row: QualRow): number;
  export function tieRival(input: QualificationInput, orderedIds: readonly EntrantId[], entrantId: EntrantId): EntrantId | null;
  export function pointsRuleBounds(rule: PointsRule): MatchPointsBounds; // points.ts
  ```

**Acceptance:** unit (hand tables + brute force + `pointsRuleBounds` oracle) and mutation list; regression (engine suite); e2e/smoke through Task 10.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/src/competition/qualification.test.ts`:

```ts
// Standings qualification status — spec 2026-09-22 §3 (R3: never wrong; R4: a
// tie at the line is never Through/Out).
//
// Bounds come from the generic module's own declaration (Task 1), never typed.
// The EMPTY and no-status cases are stated first. The R4 case is one where the
// wrong constant (`>` instead of `≥`) prints "Through" and the right one does not.
//
// Mutants killed (record the killer test for each when you run them):
//  (a) through `≥` → `>`              — "R4: level-able rival blocks Through"
//  (b) out `>` → `≥`                  — brute force (out wrong)
//  (c) win_k `≥` → `>`                — "R4 … win and in" + brute force
//  (d) win_k target uses max, not winFloor — brute force (volleyball system)
//  (e) best/worst swapped             — "through when no rival can reach"
//  (f) inactive rival not counted     — "a withdrawn rival still counts"
//  (g) ifYouLose uses min for hi      — "if-you-lose Out needs lossCeil"
//  (h) anyPlayed/complete guards dropped — "no-status cases"
import { describe, expect, it } from "vitest";
import { generic } from "../sports/generic/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import type { MatchPointsBounds } from "../sport/module.ts";
import {
  qualificationStatus,
  tieRival,
  type QualificationInput,
  type QualRow,
} from "./qualification.ts";

const GENERIC = generic.matchPointsBounds(
  generic.configSchema.parse({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false }),
);
const W = GENERIC.max; // one win, read from the module

function table(
  pts: Record<string, number>,
  opts: { r?: number | Record<string, number>; cut: number; inactive?: string[]; perMatch?: MatchPointsBounds; anyPlayed?: boolean; complete?: boolean },
): QualificationInput {
  const rows: QualRow[] = Object.entries(pts).map(([entrantId, points]) => ({
    entrantId, points, active: !(opts.inactive ?? []).includes(entrantId),
  }));
  const r = opts.r ?? 1;
  const remaining = new Map(rows.map((row) => [row.entrantId, typeof r === "number" ? r : (r[row.entrantId] ?? 0)]));
  return {
    rows, remaining, perMatch: opts.perMatch ?? GENERIC, cut: opts.cut,
    anyPlayed: opts.anyPlayed ?? true, complete: opts.complete ?? false,
  };
}
const statusOf = (input: QualificationInput, id: string) => qualificationStatus(input)?.get(id)?.status ?? null;

describe("no-status cases (stated first — an empty answer must not read as a status)", () => {
  it("no match played yet → null for the table", () => {
    expect(qualificationStatus(table({ A: 0, B: 0 }, { cut: 1, anyPlayed: false }))).toBeNull();
  });
  it("stage complete → null for the table", () => {
    expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1, complete: true }))).toBeNull();
  });
  it("cut < 1 or no rows → null", () => {
    expect(qualificationStatus(table({ A: W }, { cut: 0 }))).toBeNull();
    expect(qualificationStatus(table({}, { cut: 1 }))).toBeNull();
  });
  it("positive pair: the same table with a match played and not complete DOES produce statuses", () => {
    expect(qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1 }))).not.toBeNull();
  });
  it("a withdrawn entrant's own row is null", () => {
    const res = qualificationStatus(table({ A: W, E: 3 * W }, { cut: 1, inactive: ["E"] }));
    expect(res?.get("E")).toBeNull();
    expect(res?.get("A")).not.toBeNull();
  });
});

describe("statuses on hand-built tables (generic 3/1/0, derived)", () => {
  it("through when no rival can reach you", () => {
    // A = 3W, rivals' best = W + W, W + W, 0 + W — all below A's worst (3W).
    expect(statusOf(table({ A: 3 * W, B: W, C: W, D: 0 }, { cut: 2 }), "A")).toEqual({ kind: "through" });
  });
  it("R4: a rival who can only DRAW LEVEL still blocks Through → Win and in", () => {
    // After 2 of 3 Swiss rounds: A 2W, B W, C W, D 0, one round left, top 2.
    // B's and C's best (2W) EQUALS A's worst (2W): with `>` A would be Through.
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(statusOf(input, "A")).toEqual({ kind: "win_k", k: 1 });
  });
  it("out when N rivals are already beyond your best", () => {
    expect(statusOf(table({ A: 3 * W, B: W }, { cut: 1 }), "B")).toEqual({ kind: "out" });
  });
  it("win_k for k > 1", () => {
    // After round 1 of 3: A W, B W, C 0, D 0; two left, top 2. One win (2W) is
    // matched by three rivals' best; two wins (3W) only by B.
    expect(statusOf(table({ A: W, B: W, C: 0, D: 0 }, { cut: 2, r: 2 }), "A")).toEqual({ kind: "win_k", k: 2 });
  });
  it("needs help when even winning out is matched by N rivals", () => {
    expect(statusOf(table({ A: W, B: W, C: 0, D: 0 }, { cut: 2, r: 2 }), "C")).toEqual({ kind: "needs_help" });
  });
  it("a withdrawn rival still counts, frozen at its points", () => {
    // E (withdrawn, 3W) sits above A for good; with cut 2 only one place is left for A.
    const input = table({ A: 2 * W, B: W, E: 3 * W }, { cut: 2, inactive: ["E"] });
    expect(statusOf(input, "A")).toEqual({ kind: "win_k", k: 1 });
    // Positive pair: without E, A is through (B's best 2W ≥ 2W is one rival < 2).
    expect(statusOf(table({ A: 2 * W, B: W }, { cut: 2 }), "A")).toEqual({ kind: "through" });
  });
  it("r = 0 while the stage is still running: points are final for that row", () => {
    // cut 2: B (final 2W) and C (best W + W = 2W) both reach A's 2W, so not
    // Through (R4); nobody is beyond, so not Out; r = 0 gives no k, so Needs help.
    expect(statusOf(table({ A: 2 * W, B: 2 * W, C: W }, { cut: 2, r: { A: 0, B: 0, C: 1 } }), "A")).toEqual({ kind: "needs_help" });
    // Positive pair: once C cannot reach (C on 0, best W < 2W), A is Through.
    expect(statusOf(table({ A: 2 * W, B: 2 * W, C: 0 }, { cut: 2, r: { A: 0, B: 0, C: 1 } }), "A")).toEqual({ kind: "through" });
  });
});

describe("if you lose", () => {
  it("is computed for open rows only, from your next match lost", () => {
    const res = qualificationStatus(table({ A: W, B: W, C: 0, D: 0 }, { cut: 2, r: 2 }));
    expect(res?.get("A")?.ifYouLose).toEqual({ kind: "needs_help" });
  });
  it("Out after a loss needs lossCeil — the right answer differs from min's", () => {
    // B has 0 and one match left; A is final on 1. Cut 1. If B loses:
    // generic loss pays 0 → B's best 0 < 1 → Out. Ice-hockey OT loss pays 1 →
    // B's best 1, not beyond → still open. Both bounds come from the modules.
    const hockey = icehockey.matchPointsBounds(icehockey.configSchema.parse({}));
    expect(hockey.lossCeil).toBeGreaterThan(GENERIC.lossCeil); // precondition of the differential
    const mk = (perMatch: MatchPointsBounds) =>
      table({ A: perMatch.lossCeil === 0 ? 1 : hockey.lossCeil, B: 0 }, { cut: 1, r: { A: 0, B: 1 }, perMatch });
    expect(qualificationStatus(mk(GENERIC))?.get("B")?.ifYouLose).toEqual({ kind: "out" });
    expect(qualificationStatus(mk(hockey))?.get("B")?.ifYouLose).not.toEqual({ kind: "out" });
  });
  it("is null for Through and Out rows", () => {
    const res = qualificationStatus(table({ A: 3 * W, B: 0 }, { cut: 1 }));
    expect(res?.get("A")?.ifYouLose).toBeNull();
    expect(res?.get("B")?.ifYouLose).toBeNull();
  });
});

describe("tieRival — nearest entrant across the line who can finish level on points", () => {
  it("above the line: the first reachable row below it", () => {
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(tieRival(input, ["A", "B", "C", "D"], "B")).toBe("C");
  });
  it("below the line: the nearest reachable row above it", () => {
    const input = table({ A: 2 * W, B: W, C: W, D: 0 }, { cut: 2 });
    expect(tieRival(input, ["A", "B", "C", "D"], "C")).toBe("B");
  });
  it("null when no one across the line can draw level", () => {
    const input = table({ A: 3 * W, B: 0 }, { cut: 1 });
    expect(tieRival(input, ["A", "B"], "A")).toBeNull();
  });
});
```

Then append the brute-force block to the same file:

```ts
// Brute force (spec §6): ≤ 6 entrants, ≤ 2 rounds, byes, draws and multi-value
// wins. Enumerate EVERY outcome; every Through must be safe in all of them, every
// Out dead in all, every Win-k safe whenever the row wins ≥ k, and the same for
// the if-you-lose status over the outcomes where the row loses its first match.
// Bounds are computed from each system's own outcome list, the oracle's
// declaration. Deterministic PRNG so a red is reproducible.
describe("brute force — statuses hold over every real outcome", () => {
  type Sys = { dec: [number, number][]; draw: number | null; bye: number };
  const SYSTEMS: Sys[] = [
    { dec: [[3, 0]], draw: 1, bye: 3 },
    { dec: [[3, 0], [2, 1]], draw: null, bye: 3 }, // volleyball-shaped
    { dec: [[3, 0], [2, 1]], draw: 1, bye: 3 }, // ice-hockey-shaped
    { dec: [[2, 0]], draw: 1, bye: 2 },
    { dec: [[1, 0]], draw: 0.5, bye: 1 },
    { dec: [[2, 1]], draw: 1.5, bye: 2 }, // a loss that scores
  ];
  const boundsOf = (s: Sys): MatchPointsBounds => {
    const all = [...s.dec.flat(), ...(s.draw === null ? [] : [s.draw]), s.bye];
    return {
      max: Math.max(...all),
      min: Math.min(...all),
      winFloor: Math.min(...s.dec.map((d) => d[0]), s.bye),
      lossCeil: Math.max(...s.dec.map((d) => d[1])),
    };
  };
  it("20 000 random tables", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ri = (n: number) => Math.floor(rnd() * n);
    let checked = 0;
    for (let trial = 0; trial < 20_000; trial++) {
      const n = 2 + ri(5);
      const ids = Array.from({ length: n }, (_, k) => `e${k}`);
      const sys = SYSTEMS[ri(SYSTEMS.length)]!;
      const b = boundsOf(sys);
      const cut = 1 + ri(n - 1);
      const pts = new Map(ids.map((id) => [id, ri(3) * b.max + ri(2) * (sys.draw ?? 0)]));
      const active = new Map(ids.map((id) => [id, rnd() > 0.15]));
      type M = { a: string; b: string | null };
      const matches: M[] = [];
      for (let round = 0, rounds = ri(3); round < rounds; round++) {
        const pool = ids.filter((id) => active.get(id)).sort(() => rnd() - 0.5);
        while (pool.length >= 2) matches.push({ a: pool.pop()!, b: pool.pop()! });
        if (pool.length === 1) matches.push({ a: pool.pop()!, b: null });
      }
      const input: QualificationInput = {
        rows: ids.map((id) => ({ entrantId: id, points: pts.get(id)!, active: active.get(id)! })),
        remaining: new Map(ids.map((id) => [id, matches.filter((m) => m.a === id || m.b === id).length])),
        perMatch: b, cut, anyPlayed: true, complete: false,
      };
      const res = qualificationStatus(input)!;
      // enumerate outcomes: final points, wins, and "lost its first real match"
      type O = { p: Map<string, number>; w: Map<string, number>; lostFirst: Set<string> };
      const outs: O[] = [];
      const rec = (i: number, p: Map<string, number>, w: Map<string, number>, lost: Set<string>, seen: Set<string>) => {
        if (i === matches.length) return void outs.push({ p: new Map(p), w: new Map(w), lostFirst: new Set(lost) });
        const m = matches[i]!;
        const opts: [number, number, 0 | 1, 0 | 1][] = m.b === null
          ? [[sys.bye, 0, 1, 0]]
          : [
              ...sys.dec.map(([x, y]) => [x, y, 1, 0] as [number, number, 0 | 1, 0 | 1]),
              ...sys.dec.map(([x, y]) => [y, x, 0, 1] as [number, number, 0 | 1, 0 | 1]),
              ...(sys.draw === null ? [] : [[sys.draw, sys.draw, 0, 0] as [number, number, 0 | 1, 0 | 1]]),
            ];
        for (const [pa, pb, wa, wb] of opts) {
          const firstA = !seen.has(m.a), firstB = m.b !== null && !seen.has(m.b);
          const np = new Map(p), nw = new Map(w), nl = new Set(lost), ns = new Set(seen);
          np.set(m.a, np.get(m.a)! + pa); nw.set(m.a, nw.get(m.a)! + wa); ns.add(m.a);
          if (m.b !== null) { np.set(m.b, np.get(m.b)! + pb); nw.set(m.b, nw.get(m.b)! + wb); ns.add(m.b); }
          if (firstA && m.b !== null && wb === 1) nl.add(m.a);
          if (firstB && wa === 1) nl.add(m.b!);
          rec(i + 1, np, nw, nl, ns);
        }
      };
      rec(0, new Map(pts), new Map(ids.map((id) => [id, 0])), new Set(), new Set());
      for (const row of input.rows) {
        const r = res.get(row.entrantId);
        if (!row.active) { expect(r).toBeNull(); continue; }
        const firstIsBye = matches.find((m) => m.a === row.entrantId || m.b === row.entrantId)?.b === null;
        for (const o of outs) {
          const mine = o.p.get(row.entrantId)!;
          const others = ids.filter((x) => x !== row.entrantId).map((x) => o.p.get(x)!);
          const safe = others.filter((q) => q >= mine).length < cut;
          const dead = others.filter((q) => q > mine).length >= cut;
          const check = (s: QualStatus, where: string) => {
            if (s.kind === "through") expect(safe, `${where} through`).toBe(true);
            if (s.kind === "out") expect(dead, `${where} out`).toBe(true);
            if (s.kind === "win_k" && o.w.get(row.entrantId)! >= s.k) expect(safe, `${where} win_${s.k}`).toBe(true);
          };
          check(r!.status, `trial ${trial} ${row.entrantId}`);
          if (r!.ifYouLose && !firstIsBye && o.lostFirst.has(row.entrantId)) check(r!.ifYouLose, `trial ${trial} ${row.entrantId} if-lose`);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000); // the enumeration actually ran (measure once; raise the floor to ~80% of the observed count)
  });
});
```

(Add `type QualStatus` to the file's import from `./qualification.ts`.)

Append to `packages/engine/src/competition/points.test.ts`:

```ts
describe("pointsRuleBounds — safe per-side bounds for a custom points rule", () => {
  // Oracle: applyPointsRule itself, over every outcome shape and a spread of
  // margins. The bounds must CONTAIN every observed value, and for this rule be
  // TIGHT (equal to the extremes). A rule-free reading (win 4 / loss 0) is the
  // wrong constant this case separates from.
  const RUGBY = PointsRule.parse({
    base: { win: 4, draw: 2, loss: 0 },
    bonuses: [
      { when: "win_margin_gte", param: 20, points: 1 },
      { when: "loss_margin_lte", param: 7, points: 1 },
    ],
  });
  it("contains, and for this rule equals, what applyPointsRule actually awards", () => {
    const seen = { win: [] as number[], loss: [] as number[], all: [] as number[] };
    for (const [hs, as_] of [[30, 0], [21, 20], [10, 10], [5, 6], [0, 30]] as const) {
      const { outcome, pair } = result("H", "A", hs, as_);
      const [h, a] = applyPointsRule(outcome, pair, RUGBY);
      for (const d of [h, a]) {
        seen.all.push(d.points);
        if (d.won === 1) seen.win.push(d.points);
        if (d.lost === 1) seen.loss.push(d.points);
      }
    }
    const b = pointsRuleBounds(RUGBY);
    expect(b).toEqual({
      max: Math.max(...seen.all),
      min: Math.min(...seen.all, 0), // no_result scores 0
      winFloor: Math.min(...seen.win),
      lossCeil: Math.max(...seen.loss),
    });
    expect(b.max).toBeGreaterThan(RUGBY.base.win); // the differential: base.win alone is wrong
    expect(b.lossCeil).toBeGreaterThan(RUGBY.base.loss);
  });
  it("a forfeit rule widens the win floor and loss ceiling", () => {
    const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: -1 } });
    expect(pointsRuleBounds(rule)).toEqual({ max: 3, min: -1, winFloor: 2, lossCeil: 0 });
  });
});
```
(Add `pointsRuleBounds` to the file's import from `./points.ts`.)

- [ ] **Step 2: Run, expect failure**

Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus/packages/engine && pnpm exec vitest run src/competition/qualification.test.ts src/competition/points.test.ts --reporter=json --outputFile=/private/tmp/claude-501/qual-t2.json; echo EXIT=$?`
Expected: FAIL. `qualification.ts` does not exist (collect error, `numTotalTests` 0 for that file), and `pointsRuleBounds is not a function`.

- [ ] **Step 3: Implement `pointsRuleBounds`** (append to `points.ts`; add `import type { MatchPointsBounds } from "../sport/module.ts";`)

```ts
// Standings qualification (spec 2026-09-22 §3.1, plan P1): a stage PointsRule
// REPLACES the sport's points (applyPointsRule), so its bounds replace the
// module's. Bonuses are summed per outcome class — an over-approximation when
// two bonuses of one class exclude each other, which is safe (R3: cautious,
// never wrong).
const WIN_BONUS = new Set(["win_margin_gte", "forfeit_win"]);
const LOSS_BONUS = new Set(["loss_margin_lte", "score_ratio_gte", "forfeit_loss"]);

export function pointsRuleBounds(rule: PointsRule): MatchPointsBounds {
  const sum = (kinds: (when: string) => boolean, sign: 1 | -1) =>
    rule.bonuses
      .filter((b) => kinds(b.when))
      .reduce((s, b) => s + (sign === 1 ? Math.max(0, b.points) : Math.min(0, b.points)), 0);
  const win = (w: string) => WIN_BONUS.has(w);
  const loss = (w: string) => LOSS_BONUS.has(w);
  const draw = (w: string) => w === "draw";
  const noResult = (w: string) => w === "no_result";
  const wins = [rule.base.win, ...(rule.forfeit ? [rule.forfeit.winnerPoints] : [])];
  const losses = [rule.base.loss, ...(rule.forfeit ? [rule.forfeit.loserPoints] : [])];
  const winFloor = Math.min(...wins) + sum(win, -1);
  const lossCeil = Math.max(...losses) + sum(loss, 1);
  return {
    max: Math.max(Math.max(...wins) + sum(win, 1), lossCeil, rule.base.draw + sum(draw, 1), sum(noResult, 1)),
    min: Math.min(winFloor, Math.min(...losses) + sum(loss, -1), rule.base.draw + sum(draw, -1), sum(noResult, -1)),
    winFloor,
    lossCeil,
  };
}
```

- [ ] **Step 4: Implement `qualification.ts`**

```ts
// Standings qualification status — spec
// docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md §3.
// Pure. Independent-rival bound (R3): each rival is allowed its own best and
// worst case regardless of whom it plays. That admits outcomes that cannot
// happen (two rivals who meet cannot both win), so every Through/Out it prints
// also holds over the real outcomes; it can only be too cautious.
import type { EntrantId } from "../core/types.ts";
import type { MatchPointsBounds } from "../sport/module.ts";

export type QualStatus =
  | { kind: "through" }
  | { kind: "out" }
  | { kind: "win_k"; k: number }
  | { kind: "needs_help" };

export interface QualRow {
  entrantId: EntrantId;
  /** The table's match points (carry-over included). */
  points: number;
  /** false for a withdrawn/disqualified entrant: still a rival, frozen at `points`. */
  active: boolean;
}

export interface QualificationInput {
  rows: readonly QualRow[];
  /** entrant → matches left in THIS table (Swiss: rounds not yet settled). */
  remaining: ReadonlyMap<EntrantId, number>;
  perMatch: MatchPointsBounds;
  /** Places that go through from this table (a pool's quota under topNPerGroup). */
  cut: number;
  anyPlayed: boolean;
  complete: boolean;
}

export interface QualRowResult {
  status: QualStatus;
  /** Status after losing the next match — only for the two open statuses. */
  ifYouLose: QualStatus | null;
}

function remainingOf(input: QualificationInput, row: QualRow): number {
  return row.active ? Math.max(0, input.remaining.get(row.entrantId) ?? 0) : 0;
}
export function bestCase(input: QualificationInput, row: QualRow): number {
  return row.points + remainingOf(input, row) * input.perMatch.max;
}
export function worstCase(input: QualificationInput, row: QualRow): number {
  return row.points + remainingOf(input, row) * input.perMatch.min;
}

/** `lo`/`hi`: the least/most the row can already be sure of; `r`: matches left. */
interface Own { lo: number; hi: number; r: number }

function statusFor(input: QualificationInput, entrantId: EntrantId, own: Own): QualStatus {
  const rivals = input.rows.filter((row) => row.entrantId !== entrantId);
  const count = (pred: (row: QualRow) => boolean) => rivals.filter(pred).length;
  const { max, min, winFloor } = input.perMatch;
  const myWorst = own.lo + own.r * min;
  const myBest = own.hi + own.r * max;
  // R4: `≥` — a rival who can draw level counts as a rival who can beat you.
  if (count((j) => bestCase(input, j) >= myWorst) < input.cut) return { kind: "through" };
  if (count((j) => worstCase(input, j) > myBest) >= input.cut) return { kind: "out" };
  for (let k = 1; k <= own.r; k++) {
    const target = own.lo + k * winFloor + (own.r - k) * min;
    if (count((j) => bestCase(input, j) >= target) < input.cut) return { kind: "win_k", k };
  }
  return { kind: "needs_help" };
}

/** Per-row status for one table, or null when the table shows none (§3.3). */
export function qualificationStatus(
  input: QualificationInput,
): ReadonlyMap<EntrantId, QualRowResult | null> | null {
  if (!input.anyPlayed || input.complete) return null;
  if (!Number.isInteger(input.cut) || input.cut < 1 || input.rows.length === 0) return null;
  const out = new Map<EntrantId, QualRowResult | null>();
  for (const row of input.rows) {
    if (!row.active) {
      out.set(row.entrantId, null);
      continue;
    }
    const r = remainingOf(input, row);
    const status = statusFor(input, row.entrantId, { lo: row.points, hi: row.points, r });
    const open = status.kind === "win_k" || status.kind === "needs_help";
    const ifYouLose =
      open && r >= 1
        ? statusFor(input, row.entrantId, {
            lo: row.points + input.perMatch.min,
            hi: row.points + input.perMatch.lossCeil,
            r: r - 1,
          })
        : null;
    out.set(row.entrantId, { status, ifYouLose });
  }
  return out;
}

/** §3.4 step 4: the nearest entrant across the line with whom a tie on points
 *  is still reachable. `orderedIds` is the table in rank order. */
export function tieRival(
  input: QualificationInput,
  orderedIds: readonly EntrantId[],
  entrantId: EntrantId,
): EntrantId | null {
  const byId = new Map(input.rows.map((row) => [row.entrantId, row]));
  const me = byId.get(entrantId);
  const i = orderedIds.indexOf(entrantId);
  if (!me || i < 0) return null;
  const across = i < input.cut ? orderedIds.slice(input.cut) : orderedIds.slice(0, input.cut).reverse();
  const lo = worstCase(input, me);
  const hi = bestCase(input, me);
  for (const id of across) {
    const j = byId.get(id);
    if (j && Math.max(lo, worstCase(input, j)) <= Math.min(hi, bestCase(input, j))) return id;
  }
  return null;
}
```

Add `export * from "./qualification.ts";` to `competition/index.ts`.

- [ ] **Step 5: Run, expect pass**

Run the Step 2 command. Expected: `numFailedTests: 0`. Both files appear in `.testResults[].name` under `/Users/ashokhein/github/seazn.club-wt-qualstatus/packages/engine/`. Then `pnpm typecheck` gives `TSC=0` and `rtk proxy pnpm --filter @seazn/engine lint` gives 0 problems.

- [ ] **Step 6: Mutation sweep (each red, then revert; paste the killer test names into the file's header comment)**

(a) through `>=` → `>`; (b) out `>` → `>=`; (c) win_k `>=` → `>`; (d) `k * winFloor` → `k * max`; (e) swap `bestCase`/`worstCase` in the through rule; (f) `rivals` filter also drops `!row.active`; (g) `hi: row.points + input.perMatch.lossCeil` → `+ input.perMatch.min`; (h) delete the `anyPlayed || complete` guard; (i) in `pointsRuleBounds`, drop `sum(win, 1)` from `max`. Every one must be killed. A mutant that survives means the test is decoration: add the case that kills it before moving on.

- [ ] **Step 7: Commit** — `feat(engine): standings qualification status with never-wrong independent-rival bound` + trailer.

---

### Task 3: Engine tie-break what-if target

**Files:**
- Create: `packages/engine/src/competition/tie-what-if.ts`, `packages/engine/src/competition/tie-what-if.test.ts`
- Modify: `packages/engine/src/competition/tiebreakers.ts:236-237` (`export` the two consts; add `AGAINST_KEYS`)
- Modify: `packages/engine/src/competition/index.ts` (`export * from "./tie-what-if.ts";`)

**Interfaces:**
- Consumes: `derivedMetricText` (`display.ts`), `StandingsRow`, `TiebreakerKey`.
- Produces:
  ```ts
  export const WHAT_IF_KEYS: readonly ["point_ratio", "set_ratio", "board_ratio", "diff", "for"];
  export type WhatIfKey = (typeof WHAT_IF_KEYS)[number];
  export type TieWhatIf =
    | { kind: "target"; key: WhatIfKey; margin: number } // smallest integer net margin that puts row strictly ahead
    | { kind: "safe"; key: WhatIfKey }                     // ahead even after losing by a whole average match
    | { kind: "rule"; key: TiebreakerKey; mine: string | null; theirs: string | null };
  export function tieDecidingKey(cascade: readonly TiebreakerKey[]): TiebreakerKey | null;
  export function tieWhatIf(row: StandingsRow, rival: StandingsRow, cascade: readonly TiebreakerKey[]): TieWhatIf | null;
  export function tieKeyValue(row: StandingsRow, key: TiebreakerKey): string | null;
  // tiebreakers.ts
  export const DIFF_KEYS, FOR_KEYS; export const AGAINST_KEYS = ["ga", "against", "runs_against"] as const;
  ```

**Acceptance:** unit (oracle = the engine's own `rankStandings` comparator; differential cases); mutation list; e2e through Task 10.

- [ ] **Step 1: Write the failing tests**

```ts
// Tie-break what-if (spec §3.4, R5). Expected margins come from the ENGINE'S
// OWN comparator: apply margin m to the row as one more average-size match,
// rank the two rows with `rankStandings({ cascade: [key] })`, and require m to
// put the row strictly ahead and m − 1 not to. Everything is scaled by 2·played
// so the hypothetical ledger stays integral (compareRatio uses BigInt).
//
// Differential: case A's answer (4) is neither the average match size (5) nor 1.
//
// Mutants killed: floorDiv → Math.round; the `+ 1` dropped; rw/rl swapped;
// the reach test `>` → `>=`; tieDecidingKey reading cascade[0].
import { describe, expect, it } from "vitest";
import type { TiebreakerKey } from "../sport/module.ts";
import type { StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";
import { tieDecidingKey, tieKeyValue, tieWhatIf } from "./tie-what-if.ts";

const row = (id: string, played: number, metrics: Record<string, number>, won = 0): StandingsRow => ({
  entrantId: id, played, won, drawn: 0, lost: 0, points: 6, metrics,
});

/** Does margin m put `me` strictly ahead of `rival` on `key`, per the engine? */
function aheadOnRatio(me: StandingsRow, rival: StandingsRow, wk: string, lk: string, key: TiebreakerKey, m: number): boolean {
  const p = me.played, w = me.metrics[wk]!, l = me.metrics[lk]!;
  const scaled = (r: StandingsRow, a: number, b: number) => ({ ...r, metrics: { [wk]: a, [lk]: b } });
  const mine = scaled(me, 2 * p * w + (w + l) + p * m, 2 * p * l + (w + l) - p * m);
  const theirs = scaled(rival, 2 * p * rival.metrics[wk]!, 2 * p * rival.metrics[lk]!);
  const ranked = rankStandings([mine, theirs], { cascade: [key] }).rows;
  return ranked[0]!.entrantId === me.entrantId && ranked[0]!.tieUnbroken !== true;
}

describe("tieDecidingKey", () => {
  it("is the key right AFTER points, not the first key", () => {
    expect(tieDecidingKey(["points", "set_ratio", "wins"])).toBe("set_ratio");
    expect(tieDecidingKey(["wins", "points"])).toBeNull(); // nothing after points
    expect(tieDecidingKey([])).toBeNull(); // empty case stated
  });
});

describe("tieWhatIf — ratio keys", () => {
  it("A: set ratio — margin 4, not the match size 5, not 1 (engine-comparator oracle)", () => {
    const me = row("me", 4, { sets_won: 12, sets_lost: 8 });
    const rv = row("rv", 4, { sets_won: 11, sets_lost: 6 });
    const got = tieWhatIf(me, rv, ["points", "set_ratio"]);
    expect(got).toEqual({ kind: "target", key: "set_ratio", margin: 4 });
    expect(aheadOnRatio(me, rv, "sets_won", "sets_lost", "set_ratio", 4)).toBe(true);
    expect(aheadOnRatio(me, rv, "sets_won", "sets_lost", "set_ratio", 3)).toBe(false);
  });
  it("C: already ahead — 'lose by no more than 1' is a negative margin", () => {
    const me = row("me", 3, { points_won: 6, points_lost: 3 });
    const rv = row("rv", 3, { points_won: 4, points_lost: 3 });
    expect(tieWhatIf(me, rv, ["points", "point_ratio"])).toEqual({ kind: "target", key: "point_ratio", margin: -1 });
    expect(aheadOnRatio(me, rv, "points_won", "points_lost", "point_ratio", -1)).toBe(true);
    expect(aheadOnRatio(me, rv, "points_won", "points_lost", "point_ratio", -2)).toBe(false);
  });
  it("a margin larger than an average match → rule only, with both values", () => {
    const me = row("me", 4, { sets_won: 5, sets_lost: 3 }); // T = 2; needs 4
    const rv = row("rv", 4, { sets_won: 6, sets_lost: 2 });
    expect(tieWhatIf(me, rv, ["points", "set_ratio"])).toEqual({ kind: "rule", key: "set_ratio", mine: "1.67", theirs: "3.00" });
  });
  it("a rival with an unbeaten ratio (x/0) → rule only", () => {
    const got = tieWhatIf(row("me", 2, { sets_won: 4, sets_lost: 2 }), row("rv", 2, { sets_won: 4, sets_lost: 0 }), ["points", "set_ratio"]);
    expect(got?.kind).toBe("rule");
  });
  it("no matches played → rule only", () => {
    expect(tieWhatIf(row("me", 0, {}), row("rv", 1, { sets_won: 2, sets_lost: 0 }), ["points", "set_ratio"])?.kind).toBe("rule");
  });
  it("far ahead: losing by a whole average match still keeps the lead → safe", () => {
    const me = row("me", 2, { points_won: 100, points_lost: 10 });
    const rv = row("rv", 2, { points_won: 50, points_lost: 50 });
    expect(tieWhatIf(me, rv, ["points", "point_ratio"])).toEqual({ kind: "safe", key: "point_ratio" });
  });
});

describe("tieWhatIf — diff and for", () => {
  it("diff: need rgd − gd + 1", () => {
    const me = row("me", 4, { gf: 8, ga: 6, gd: 2 });
    const rv = row("rv", 4, { gf: 9, ga: 5, gd: 4 });
    expect(tieWhatIf(me, rv, ["points", "diff"])).toEqual({ kind: "target", key: "diff", margin: 3 });
  });
  it("D: goals scored — margin −1 on a match size of 8", () => {
    const me = row("me", 4, { gf: 20, ga: 12, gd: 8 });
    const rv = row("rv", 4, { gf: 23, ga: 10, gd: 13 });
    expect(tieWhatIf(me, rv, ["points", "for"])).toEqual({ kind: "target", key: "for", margin: -1 });
  });
});

describe("tieWhatIf — rules that never get a target (R5)", () => {
  for (const key of ["h2h_points", "buchholz", "sberger", "lots", "wins", "game_ratio"] as const) {
    it(`${key} → rule only`, () => {
      const got = tieWhatIf(row("me", 2, { buchholz: 5 }, 2), row("rv", 2, { buchholz: 6 }, 1), ["points", key]);
      expect(got?.kind).toBe("rule");
    });
  }
  it("values: Buchholz prints through derivedMetricText, head-to-head has none", () => {
    expect(tieKeyValue(row("me", 2, { buchholz: 5.5 }), "buchholz")).toBe("5½");
    expect(tieKeyValue(row("me", 2, {}), "h2h_points")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus/packages/engine && pnpm exec vitest run src/competition/tie-what-if.test.ts --reporter=json --outputFile=/private/tmp/claude-501/qual-t3.json; echo EXIT=$?` → collect failure.

- [ ] **Step 3: Export the ledger key lists** in `tiebreakers.ts:236-237`:

```ts
export const DIFF_KEYS = ["gd", "diff", "run_diff"] as const;
export const FOR_KEYS = ["gf", "for", "runs_for"] as const;
/** The "against" twin of FOR_KEYS — the what-if's average match size (tie-what-if.ts). */
export const AGAINST_KEYS = ["ga", "against", "runs_against"] as const;
```

- [ ] **Step 4: Implement `tie-what-if.ts`**

```ts
// Tie-break what-if — spec 2026-09-22 §3.4 (R5). Pure. The target assumes the
// rival's figures stay as they are and that the row plays ONE more match whose
// total size is its own average so far ((won + lost) / played, in the key's
// units). It is always shown with that assumption (R5).
import type { TiebreakerKey } from "../sport/module.ts";
import { derivedMetricText } from "./display.ts";
import type { StandingsRow } from "./standings.ts";
import { AGAINST_KEYS, DIFF_KEYS, FOR_KEYS } from "./tiebreakers.ts";

export const WHAT_IF_KEYS = ["point_ratio", "set_ratio", "board_ratio", "diff", "for"] as const;
export type WhatIfKey = (typeof WHAT_IF_KEYS)[number];

export type TieWhatIf =
  | { kind: "target"; key: WhatIfKey; margin: number }
  | { kind: "safe"; key: WhatIfKey }
  | { kind: "rule"; key: TiebreakerKey; mine: string | null; theirs: string | null };

const RATIO_LEDGER = {
  point_ratio: ["points_won", "points_lost"],
  set_ratio: ["sets_won", "sets_lost"],
  board_ratio: ["boards_won", "boards_lost"],
} as const;

const firstOf = (row: StandingsRow, keys: readonly string[]): number | undefined => {
  for (const key of keys) {
    const v = row.metrics[key];
    if (v !== undefined) return v;
  }
  return undefined;
};
const floorDiv = (a: number, b: number) => Math.floor(a / b);
const isWhatIfKey = (key: TiebreakerKey): key is WhatIfKey => (WHAT_IF_KEYS as readonly string[]).includes(key);

/** The cascade key that splits a tie on points: the one right after `points`. */
export function tieDecidingKey(cascade: readonly TiebreakerKey[]): TiebreakerKey | null {
  const i = cascade.indexOf("points");
  return i >= 0 && i + 1 < cascade.length ? cascade[i + 1]! : null;
}

/** A row's current value on a tie key, as the table would print it; null when the key has no per-row value (head-to-head, lots, seed). */
export function tieKeyValue(row: StandingsRow, key: TiebreakerKey): string | null {
  switch (key) {
    case "diff": {
      const v = firstOf(row, DIFF_KEYS);
      return v === undefined ? null : v > 0 ? `+${v}` : `${v}`;
    }
    case "for": {
      const v = firstOf(row, FOR_KEYS);
      return v === undefined ? null : `${v}`;
    }
    case "wins":
      return `${row.won}`;
    default:
      return derivedMetricText(row, key);
  }
}

/** Smallest integer margin m (own minus opponent, in the key's units) that puts
 *  the row strictly ahead; `size` is the row's total per `played` matches. */
function marginFor(key: WhatIfKey, row: StandingsRow, rival: StandingsRow): { margin: number; size: number } | null {
  const p = row.played;
  if (p <= 0) return null;
  if (key === "diff" || key === "for") {
    const f = firstOf(row, FOR_KEYS);
    const a = firstOf(row, AGAINST_KEYS);
    if (f === undefined || a === undefined) return null;
    const size = f + a;
    if (key === "diff") {
      const gd = firstOf(row, DIFF_KEYS);
      const rgd = firstOf(rival, DIFF_KEYS);
      if (gd === undefined || rgd === undefined) return null;
      return { margin: rgd - gd + 1, size };
    }
    const rf = firstOf(rival, FOR_KEYS);
    if (rf === undefined) return null;
    // f + (T + m)/2 > rf, T = size/p  ⇔  m·p > 2p(rf − f) − size
    return { margin: floorDiv(2 * p * (rf - f) - size, p) + 1, size };
  }
  const [wk, lk] = RATIO_LEDGER[key];
  const w = row.metrics[wk] ?? 0;
  const l = row.metrics[lk] ?? 0;
  const rw = rival.metrics[wk] ?? 0;
  const rl = rival.metrics[lk] ?? 0;
  const den = p * (rw + rl);
  if (den === 0 || rl === 0) return null; // rival has no data, or an unbeaten x/0
  // (w + (T+m)/2)/(l + (T−m)/2) > rw/rl, cross-multiplied and scaled by p
  const num = rw * (2 * l * p + w + l) - rl * (2 * w * p + w + l);
  return { margin: floorDiv(num, den) + 1, size: w + l };
}

export function tieWhatIf(
  row: StandingsRow,
  rival: StandingsRow,
  cascade: readonly TiebreakerKey[],
): TieWhatIf | null {
  const key = tieDecidingKey(cascade);
  if (key === null) return null;
  const rule: TieWhatIf = { kind: "rule", key, mine: tieKeyValue(row, key), theirs: tieKeyValue(rival, key) };
  if (!isWhatIfKey(key)) return rule;
  const m = marginFor(key, row, rival);
  if (m === null || m.size <= 0) return rule;
  const p = row.played;
  if (m.margin * p > m.size) return rule; // more than an average match can hold
  if (m.margin * p <= -m.size) return { kind: "safe", key };
  return { kind: "target", key, margin: m.margin };
}
```

- [ ] **Step 5: Run, expect pass.** Re-run the Step 2 command. Then `pnpm typecheck`. Re-run `src/competition` whole (`pnpm exec vitest run src/competition --reporter=json …`) to prove the `export` changes broke nothing.

- [ ] **Step 6: Mutation sweep** — (a) `floorDiv` → `Math.round`; (b) drop `+ 1` on the ratio margin; (c) swap `rw`/`rl`; (d) `> m.size` → `>= m.size`; (e) `tieDecidingKey` returns `cascade[0]`. Each must be red. Record the killers.

- [ ] **Step 7: Commit** — `feat(engine): tie-break what-if target for own-results tie keys` + trailer.

---

### Task 4: Migration — `stage_qualification_meta` + `public_stages_v`, public reads, cache keys

**Files:**
- Create: `db/migration/deltas/V414__public_stages_qualification.sql`
- Modify: `apps/web/src/server/public-site/data.ts:384-395` (`PublicStage`), `:901-903` (select), `:960` (`pub-div-v2` → `pub-div-v3`)
- Modify: `apps/web/src/server/embed-data.ts:57-64` (add `dv.config`), `:93-95` (select)
- Modify: every mention of the literal `pub-div-v2` (`grep -arn "pub-div-v2" apps/web/src` — `revalidate.ts` comments, `division-doc-cache-keys*` if they name it)
- Create: `apps/web/src/server/public-site/__tests__/public-stages-qualification-db.test.ts`

**Interfaces:**
- Consumes: `stages.progression` (V371/V373 shape: `sources[].stage` = `"previous"` | `{stageId}`, `sources[].take[]` = engine `TakeRule`).
- Produces:
  - SQL `stage_qualification_meta(p_stage_id uuid) returns table (qualify_count int, qualify_per_group boolean, next_stage_name text, swiss_rounds int, points_rule jsonb)`. Always one row for an existing stage. `qualify_count` is non-null only for a forecastable cut.
  - `public_stages_v` gains those five columns, appended in that order.
  - `PublicStage` gains `qualify_count: number | null; qualify_per_group: boolean; next_stage_name: string | null; swiss_rounds: number | null; points_rule: unknown;`

**Acceptance:** unit/regression (the DB test below, real Postgres); smoke (Task 10 reads the page these columns feed); e2e (Task 10).

- [ ] **Step 1: Re-check the migration tail against `main`**

Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus && git fetch origin main -q && git ls-tree --name-only origin/main db/migration/deltas/ | tail -3 && ls db/migration/deltas | tail -3`
Expected: the highest is `V413`. If `main` has moved past it, take the next free number and rename everywhere in this task. A number is claimed by merging, not by choosing. Repeat this check immediately before the final PR (Task 10).

- [ ] **Step 2: Write the failing DB test**

Create `apps/web/src/server/public-site/__tests__/public-stages-qualification-db.test.ts`. It seeds through the real usecases (`seedOrg`, `createCompetition`, `createDivision`, `createStages`), with call shapes exactly as in `public-entrants-departed.test.ts:95-114` and `usecases/__tests__/stage-progression.test.ts:82-96`, and reads the view through the SAME `sql` client `getPublicDivision` uses:

```ts
// V414 — the qualification cut-off, derived ONCE in SQL and read by both the
// public view and the console (plan Task 4 / spec §4). Real Postgres; skipped
// without DATABASE_URL (same convention as public-entrants-departed.test.ts).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;
type ViewRow = { name: string; qualify_count: number | null; qualify_per_group: boolean; next_stage_name: string | null; swiss_rounds: number | null; points_rule: unknown };

async function division(auth: AuthCtx, visibility: "public" | "private") {
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Qual ${suffix}`, visibility, branding: {} });
  return createDivision(auth, comp.id, { name: "Open", slug: `open-${suffix}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
}
const prog = (take: unknown[], stage: unknown = "previous") => ({ sources: [{ stage, take }], placement: "rank_order", timing: "on_complete" });
const view = async (divisionId: string) =>
  sql<ViewRow[]>`select name, qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule
                 from public_stages_v where division_id = ${divisionId} order by seq`;

describe.skipIf(!HAS_DB)("public_stages_v — qualification columns (V414)", () => {
  let auth: AuthCtx;
  beforeAll(async () => ({ auth } = await seedOrg("pro")));

  it("empty case first: a lone stage with no destination carries no cut", async () => {
    const d = await division(auth, "public");
    await createStages(auth, d.id, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    expect((await view(d.id))[0]).toMatchObject({ qualify_count: null, qualify_per_group: false, next_stage_name: null });
  });

  it("league → KO rankRange 1..4: count 4, overall, next stage named", async () => {
    const d = await division(auth, "public");
    await createStages(auth, d.id, [
      { seq: 1, kind: "league", name: "League", config: {} },
      { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
    ]);
    expect((await view(d.id))[0]).toMatchObject({ qualify_count: 4, qualify_per_group: false, next_stage_name: "Finals" });
  });

  it("groups → KO topNPerGroup 2: per group", async () => {
    const d = await division(auth, "public");
    await createStages(auth, d.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "topNPerGroup", n: 2 }]) },
    ]);
    expect((await view(d.id))[0]).toMatchObject({ qualify_count: 2, qualify_per_group: true, next_stage_name: "KO" });
  });

  it("a bestNth anywhere beside the cut → no cut (unforecastable)", async () => {
    const d = await division(auth, "public");
    await createStages(auth, d.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 3 } } },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }]) },
    ]);
    expect((await view(d.id))[0]!.qualify_count).toBeNull();
  });

  it("cup 1..2 plus plate 3..4 (by stageId): the cup is the cut; plate-only has none", async () => {
    const d = await division(auth, "public");
    const [league] = await createStages(auth, d.id, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    await createStages(auth, d.id, [
      { seq: 2, kind: "knockout", name: "Cup", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 2 }], { stageId: league!.id }) },
      { seq: 3, kind: "knockout", name: "Plate", config: {}, progression: prog([{ kind: "rankRange", from: 3, to: 4 }], { stageId: league!.id }) },
    ]);
    expect((await view(d.id))[0]).toMatchObject({ qualify_count: 2, next_stage_name: "Cup" });
  });

  it("swiss rounds and the stage points rule are published as-is", async () => {
    const d = await division(auth, "public");
    const points = { base: { win: 3, draw: 1, loss: 0 }, bonuses: [{ when: "win_margin_gte", param: 3, points: 1 }] };
    await createStages(auth, d.id, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 5, points } }]);
    const [r] = await view(d.id);
    expect(r!.swiss_rounds).toBe(5);
    expect(r!.points_rule).toMatchObject(points);
  });

  it("a private competition publishes nothing (the visibility gate is untouched)", async () => {
    const d = await division(auth, "private");
    await createStages(auth, d.id, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    expect(await view(d.id)).toEqual([]);
  });
});
```

(If `createStages` refuses a second call that adds stages to an existing graph, create all three stages in one call and resolve the league id with `select id from stages where division_id = … and seq = 1` before building the Plate/Cup progression. Any other schema refusal (for example `timing` or `pools` shape) is fixed by copying the exact working body from `stage-progression.test.ts:82-96`.)

- [ ] **Step 3: Run, expect red**

Bring up a fresh DB per the `seazn-local-env` skill (`db:apply` **and** `sync:sports`; confirm `show data_directory` is yours). Then run:
`cd /Users/ashokhein/github/seazn.club-wt-qualstatus/apps/web && pnpm exec vitest run src/server/public-site/__tests__/public-stages-qualification-db.test.ts --reporter=json --outputFile=/private/tmp/claude-501/qual-t4.json; echo EXIT=$?`
Expected: FAIL, `column "qualify_count" does not exist`. If `numTotalTests` equals the skipped count, `DATABASE_URL` was unset and nothing ran. That is not a red; fix the environment.

- [ ] **Step 4: Write the migration**

`db/migration/deltas/V414__public_stages_qualification.sql`:

```sql
-- V414 — standings qualification status (spec
-- docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md
-- §4.1; plan Task 4). The public standings table shows whether a place in the
-- next stage is won, open or lost, which needs the CUT: how many places go
-- through, per pool or overall, and to which stage. The cut is declared on the
-- DESTINATION stage's `progression`; this derives it once, here, for BOTH
-- readers — `public_stages_v` below (division page, hub, embed) and the
-- organiser console (usecases/stage-qualification.ts), so the two can never
-- disagree (spec §4.2 "do not fork the calculation").
--
-- Forecastable only when EXACTLY ONE take rule, across every destination that
-- names this stage, is a `rankRange` from 1 or a `topNPerGroup`, that rule is
-- its source's only rule, and no destination takes this stage by `bestNth`,
-- `picks` or `roundLosers` (each moves who qualifies in ways a points bound
-- cannot see). A `rankRange` from > 1 elsewhere (a plate) does not block it.
-- `"previous"` means the same-division stage with the largest seq below the
-- destination's (usecases/stage-seeding.ts:71-86).
--
-- SECURITY DEFINER with a pinned search_path, like org_has_feature (V344): a
-- function called from a view runs as the CALLER, and the public read path
-- must not depend on the caller's RLS context to see `stages`. It returns only
-- derived facts. Execute is revoked from PUBLIC and granted to app_user.
--
-- `swiss_rounds` and `points_rule` ride along so both readers get every input
-- from one row. `points_rule` is the stage's own points rule (not sensitive:
-- the table already prints the points it produces). Without it a custom-points
-- stage would be forecast with the sport's points and could be wrong (plan P4).
-- Raw `progression` and the rest of `config` stay private.

create or replace function stage_qualification_meta(p_stage_id uuid)
returns table (
  qualify_count int,
  qualify_per_group boolean,
  next_stage_name text,
  swiss_rounds int,
  points_rule jsonb
)
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
  with src as (
    select s.id, s.division_id, s.seq, s.kind, s.config from stages s where s.id = p_stage_id
  ),
  rules as (
    select d.name as dest_name,
           r.value as rule,
           jsonb_array_length(so.value -> 'take') as take_len
    from src
    join stages d on d.division_id = src.division_id and d.progression is not null
    cross join lateral jsonb_array_elements(d.progression -> 'sources') as so(value)
    cross join lateral jsonb_array_elements(so.value -> 'take') as r(value)
    where (so.value ->> 'stage' = 'previous'
           and src.seq = (select max(p.seq) from stages p
                          where p.division_id = d.division_id and p.seq < d.seq))
       or (so.value -> 'stage' ->> 'stageId') = src.id::text
  ),
  cut as (
    select dest_name, rule from rules
    where take_len = 1
      and ((rule ->> 'kind' = 'rankRange' and (rule ->> 'from')::int = 1)
           or rule ->> 'kind' = 'topNPerGroup')
  ),
  forecast as (
    select case when c.rule ->> 'kind' = 'rankRange' then (c.rule ->> 'to')::int
                else (c.rule ->> 'n')::int end as qualify_count,
           c.rule ->> 'kind' = 'topNPerGroup' as qualify_per_group,
           c.dest_name as next_stage_name
    from cut c
    where (select count(*) from cut) = 1
      and not exists (select 1 from rules where rule ->> 'kind' in ('bestNth', 'picks', 'roundLosers'))
  )
  select f.qualify_count,
         coalesce(f.qualify_per_group, false),
         f.next_stage_name,
         case when src.kind = 'swiss' then (src.config ->> 'rounds')::int end,
         src.config -> 'points'
  from src
  left join forecast f on true
$$;

revoke all on function stage_qualification_meta(uuid) from public;
grant execute on function stage_qualification_meta(uuid) to app_user;

-- Columns APPENDED after V233's six, in order (create or replace view may only
-- add columns at the end). The visibility gate is copied verbatim from V233.
create or replace view public_stages_v as
  select st.id, st.division_id, st.seq, st.kind, st.name, st.status,
         q.qualify_count, q.qualify_per_group, q.next_stage_name, q.swiss_rounds, q.points_rule
  from stages st
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  cross join lateral stage_qualification_meta(st.id) q
  where c.visibility in ('public','unlisted');
```

(`${flyway:defaultSchema}` is the placeholder V344 uses. Confirm this repo's Flyway config substitutes it in `deltas/` by reading one applied delta that uses it.)

- [ ] **Step 5: Wire the reads**

`data.ts` `PublicStage` (`:384-395`), append:
```ts
  /** V414 — the forecastable cut (null = none); see stage_qualification_meta. */
  qualify_count: number | null;
  qualify_per_group: boolean;
  next_stage_name: string | null;
  swiss_rounds: number | null;
  /** The stage's own PointsRule jsonb, or null (sport points apply). */
  points_rule: unknown;
```
`data.ts:901-903` and `embed-data.ts:93-95` become:
```ts
      select id, division_id, seq, kind, name, status,
             qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule
      from public_stages_v where division_id = ${…} order by seq
```
`embed-data.ts:64`: `dv.youth, dv.player_name_display` → `dv.youth, dv.player_name_display, dv.config`. The embed's `PublicDivision` needs `config` for Task 7's bounds, and the division page already has it (`data.ts:625`).
`data.ts:960`: `["pub-div-v2", division.id]` → `["pub-div-v3", division.id]`. The cached stage shape changed, and a stale entry would feed `undefined` qualify columns into the builder. Update every other `pub-div-v2` literal/comment the grep finds so no test pins the old name.

Hand-built `PublicStage` fixtures in existing tests now fail tsc. Find them with `grep -arln "PublicStage\|kind: \"league\", name" apps/web/src --include=*.test.ts` and add the five fields (`qualify_count: null, qualify_per_group: false, next_stage_name: null, swiss_rounds: null, points_rule: null`).

- [ ] **Step 6: Apply and run**

`cd /Users/ashokhein/github/seazn.club-wt-qualstatus && pnpm db:apply` (with the env the `seazn-local-env` skill names — never the dev DB by accident). Then re-run Step 3. Expected: all pass, `numFailedTests: 0`. Also run the neighbours that read the same views: `pnpm exec vitest run src/server/public-site/__tests__/public-entrants-departed.test.ts src/server/public-site/__tests__/competition-hub-db.test.ts src/server/public-site/__tests__/division-doc-cache-keys.test.ts --reporter=json …`. And `pnpm --filter web exec node ../../node_modules/typescript-native/bin/tsc --noEmit` (or the web typecheck script) must give `TSC=0`.

- [ ] **Step 7: Mutation checks** — (a) change `(rule ->> 'from')::int = 1` to `>= 1` → the plate-only expectation in the cup/plate case goes red (re-apply the delta between mutants on a scratch DB); (b) drop the `not exists (… bestNth …)` → the bestNth case reds; (c) drop `take_len = 1` → add and run a one-off case `take: [rankRange 1..2, rankRange 3..4]` into one KO and see it return 2. **Keep that case in the file** (a cut from one source that also takes 3..4 into the same stage is really top 4, so it must be null).

- [ ] **Step 8: Commit** — `feat(db): V414 stage_qualification_meta and qualification columns on public_stages_v` + trailer. Run `pnpm openapi:gen && git status --porcelain` first.

---

### Task 5: Web builder `buildQualificationView` + hub schema + copy in 4 locales

**Files:**
- Create: `apps/web/src/lib/fixture-engine-status.ts`
- Modify: `apps/web/src/server/engine-db/competition.ts:73-88` (delete the body of `toEngineStatus` and import it from the new lib, keeping the local name)
- Create: `apps/web/src/server/public-site/qualification-view.ts`
- Create: `apps/web/src/server/public-site/__tests__/qualification-view.test.ts`
- Modify: `apps/web/src/server/public-site/competition-hub-schema.ts:181-207` (new schemas + fields)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (keys after `table.champion`)
- Regenerate: `apps/web/src/lib/i18n-keys.ts` (`pnpm i18n:gen-keys`)

**Interfaces:**
- Consumes: Tasks 1–4 (`qualificationStatus`, `tieRival`, `tieWhatIf`, `pointsRuleBounds`, `PointsRule`, `isTableStageComplete`, `PublicStage` qualify columns).
- Produces:
  ```ts
  // lib/fixture-engine-status.ts
  export function engineFixtureStatus(dbStatus: string): FixtureStatus;
  // server/public-site/qualification-view.ts
  export const QUAL_TABLE_KINDS: ReadonlySet<string>; // league, group, swiss
  export interface StageQualMeta { qualifyCount: number | null; qualifyPerGroup: boolean; nextStageName: string | null; swissRounds: number | null; pointsRule: unknown }
  export function stageQualMeta(row: { qualify_count: number | null; qualify_per_group: boolean | null; next_stage_name: string | null; swiss_rounds: number | null; points_rule: unknown }): StageQualMeta;
  export interface QualFixture { stage_id: string; pool_id: string | null; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null }
  export function divisionPointsBounds(module_: AnySportModule | null | undefined, cfg: unknown): MatchPointsBounds | null;
  export interface QualificationView { table: QualTableT; rows: Record<string, QualRowT> }
  export interface QualificationViewInput {
    stage: { id: string; kind: string; meta: StageQualMeta };
    poolId: string | null;
    rows: readonly StandingsRow[];
    fixtures: readonly QualFixture[];
    entrantStatuses: Readonly<Record<string, string>>;
    bounds: MatchPointsBounds | null;
    cascade: readonly string[];
    entrantNames: Readonly<Record<string, string>>;
    msg: (key: TKey, vars?: Record<string, string | number>) => string;
    plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
  }
  export function buildQualificationView(input: QualificationViewInput): QualificationView | null;
  // competition-hub-schema.ts
  export const QualStatusKind: z.ZodEnum<["through","win_k","needs_help","out"]>;
  export const QualRow; export const QualTable; export type QualRowT; export type QualTableT;
  // TableRow gains `qual: QualRow.nullable()`, TableView gains `qualification: QualTable.nullable()`
  ```

**Acceptance:** unit (builder, every no-status case, the Review Focus 1–5 cases, and wording per status, including one es case to prove the locale path); i18n parity; regression (`standings-view.test.ts`, `hub-dictionary.test.ts`, `competition-hub-schema.test.ts` stay green); e2e/smoke in Task 10.

- [ ] **Step 1: Add the copy (all 4 locales), then regenerate keys**

Append to each `public.json` (flat keys, as the file already uses):

| key | en | es | fr | nl |
|---|---|---|---|---|
| `table.qual.status.through` | Through | Clasificado | Qualifié | Door |
| `table.qual.status.winK.one` | Win and in | Gana y pasa | Gagne et passe | Winnen en door |
| `table.qual.status.winK.other` | Win {count} and in | Gana {count} y pasa | Gagne {count} et passe | {count} winnen en door |
| `table.qual.status.needsHelp` | Needs help | Necesita ayuda | A besoin d'aide | Hulp nodig |
| `table.qual.status.out` | Out | Eliminado | Éliminé | Uitgeschakeld |
| `table.qual.headline.through` | Through to {next}, whatever happens next. | Clasificado para {next}, pase lo que pase. | Qualifié pour {next}, quoi qu'il arrive. | Door naar {next}, wat er ook gebeurt. |
| `table.qual.headline.winK.one` | Win your next match and you're through to {next}. | Gana tu próximo partido y pasas a {next}. | Gagne ton prochain match et tu passes en {next}. | Win je volgende wedstrijd en je gaat door naar {next}. |
| `table.qual.headline.winK.other` | Win {count} of your remaining matches and you're through to {next}. | Gana {count} de tus partidos restantes y pasas a {next}. | Gagne {count} de tes matchs restants et tu passes en {next}. | Win {count} van je resterende wedstrijden en je gaat door naar {next}. |
| `table.qual.headline.needsHelp` | Still open: you need other results to go your way. | Todo abierto: necesitas que otros resultados te favorezcan. | Encore ouvert : il te faut d'autres résultats favorables. | Nog open: je hebt andere uitslagen in je voordeel nodig. |
| `table.qual.headline.out` | Can no longer finish in the top {n}. | Ya no puede terminar entre los {n} primeros. | Ne peut plus finir dans les {n} premiers. | Kan niet meer bij de eerste {n} eindigen. |
| `table.qual.ifYouLose` | If you lose your next match: {status}. | Si pierdes tu próximo partido: {status}. | Si tu perds ton prochain match : {status}. | Als je je volgende wedstrijd verliest: {status}. |
| `table.qual.whatIf.winBy` | If you finish level on points with {rival}, {rule} decides: win your next match by {m} or more to finish ahead. | Si terminas empatado a puntos con {rival}, decide {rule}: gana tu próximo partido por {m} o más para quedar por delante. | Si tu finis à égalité de points avec {rival}, {rule} départage : gagne ton prochain match par {m} ou plus pour finir devant. | Eindig je gelijk op punten met {rival}, dan beslist {rule}: win je volgende wedstrijd met {m} of meer om voor te eindigen. |
| `table.qual.whatIf.loseByAtMost` | If you finish level on points with {rival}, {rule} decides: lose your next match by no more than {m} to finish ahead. | Si terminas empatado a puntos con {rival}, decide {rule}: pierde tu próximo partido por no más de {m} para quedar por delante. | Si tu finis à égalité de points avec {rival}, {rule} départage : perds ton prochain match de {m} au plus pour finir devant. | Eindig je gelijk op punten met {rival}, dan beslist {rule}: verlies je volgende wedstrijd met hooguit {m} om voor te eindigen. |
| `table.qual.whatIf.dontLose` | If you finish level on points with {rival}, {rule} decides: avoid losing your next match to finish ahead. | Si terminas empatado a puntos con {rival}, decide {rule}: no pierdas tu próximo partido para quedar por delante. | Si tu finis à égalité de points avec {rival}, {rule} départage : ne perds pas ton prochain match pour finir devant. | Eindig je gelijk op punten met {rival}, dan beslist {rule}: verlies je volgende wedstrijd niet om voor te eindigen. |
| `table.qual.whatIf.safe` | If you finish level on points with {rival}, you stay ahead on {rule} even after a heavy defeat. | Si terminas empatado a puntos con {rival}, sigues por delante en {rule} incluso tras una derrota abultada. | Si tu finis à égalité de points avec {rival}, tu restes devant au {rule} même après une lourde défaite. | Eindig je gelijk op punten met {rival}, dan blijf je voor op {rule}, zelfs na een zware nederlaag. |
| `table.qual.whatIf.rule` | If you finish level on points with {rival}, {rule} decides. | Si terminas empatado a puntos con {rival}, decide {rule}. | Si tu finis à égalité de points avec {rival}, {rule} départage. | Eindig je gelijk op punten met {rival}, dan beslist {rule}. |
| `table.qual.whatIf.ruleValues` | If you finish level on points with {rival}, {rule} decides. Now: you {mine}, {rival} {theirs}. | Si terminas empatado a puntos con {rival}, decide {rule}. Ahora: tú {mine}, {rival} {theirs}. | Si tu finis à égalité de points avec {rival}, {rule} départage. Actuellement : toi {mine}, {rival} {theirs}. | Eindig je gelijk op punten met {rival}, dan beslist {rule}. Nu: jij {mine}, {rival} {theirs}. |
| `table.qual.whatIf.assumption` | Assumes {rival}'s figures stay the same and your next match is an average one. | Supone que las cifras de {rival} no cambian y que tu próximo partido es uno típico. | Suppose que les chiffres de {rival} ne changent pas et que ton prochain match est dans ta moyenne. | Gaat ervan uit dat de cijfers van {rival} gelijk blijven en je volgende wedstrijd een gemiddelde is. |
| `table.qual.cut.one` | Top {n} go through to {next} · {count} round left | Los {n} primeros pasan a {next} · queda {count} ronda | Les {n} premiers passent en {next} · {count} tour restant | De eerste {n} gaan door naar {next} · nog {count} ronde |
| `table.qual.cut.other` | Top {n} go through to {next} · {count} rounds left | Los {n} primeros pasan a {next} · quedan {count} rondas | Les {n} premiers passent en {next} · {count} tours restants | De eerste {n} gaan door naar {next} · nog {count} rondes |
| `table.qual.cutNoRounds` | Top {n} go through to {next} | Los {n} primeros pasan a {next} | Les {n} premiers passent en {next} | De eerste {n} gaan door naar {next} |
| `table.qual.legend.through` | Through | Clasificado | Qualifié | Door |
| `table.qual.legend.open` | Still open | Todo abierto | Encore ouvert | Nog open |
| `table.qual.legend.out` | Out | Eliminado | Éliminé | Uitgeschakeld |
| `table.qual.legend.hint` | Tap a rank for details. | Toca una posición para ver detalles. | Touche un rang pour les détails. | Tik op een positie voor details. |
| `table.qual.rankLabel` | Rank {rank}, {status}, show details | Posición {rank}, {status}, ver detalles | Rang {rank}, {status}, voir les détails | Positie {rank}, {status}, details tonen |

Check the existing tone of each locale's `public.json` (`tú`/`tu`/`je` vs formal) and align. If the file addresses the reader formally, switch these to the formal form in that locale.

Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus && pnpm i18n:gen-keys && pnpm i18n:check; echo EXIT=$?` → `EXIT=0`, and `git diff --stat apps/web/src/lib/i18n-keys.ts` shows the new keys.

- [ ] **Step 2: Add the hub schemas** in `competition-hub-schema.ts`, before `TableRow`:

```ts
/** Standings qualification status (spec 2026-09-22 §4.1). Every string is
 *  already resolved in the org's locale by `buildQualificationView`. */
export const QualStatusKind = z.enum(["through", "win_k", "needs_help", "out"]);
export const QualRow = z.object({
  status: QualStatusKind,
  /** R7 label: "Through" / "Win 2 and in" / "Needs help" / "Out". */
  label: z.string(),
  /** "Rank 3, Win 2 and in, show details" — the trigger's accessible name. */
  ariaLabel: z.string(),
  headline: z.string(),
  ifYouLose: z.string().nullable(),
  whatIf: z.string().nullable(),
  whatIfAssumption: z.string().nullable(),
});
export const QualTable = z.object({
  /** Places above the line: the line renders after row `cutIndex`. */
  cutIndex: z.number().int().positive(),
  label: z.string(),
  legend: z.object({ through: z.string(), open: z.string(), out: z.string(), hint: z.string() }),
});
export type QualRowT = z.infer<typeof QualRow>;
export type QualTableT = z.infer<typeof QualTable>;
```
In `TableRow` add `qual: QualRow.nullable(),` after `tieBreakText`. In `TableView` add `qualification: QualTable.nullable(),` after `rows`. (Task 6 makes `buildTableView` emit both. Until then tsc reds in `standings-view.ts`. Emit `qual: null` and `qualification: null` there in THIS task so the tree stays green, and let Task 6 replace them.)

- [ ] **Step 3: Move the status mapping**

`apps/web/src/lib/fixture-engine-status.ts`:
```ts
// DB fixtures.status → the engine's FixtureStatus (spec 05 §1). ONE mapping for
// the standings fold (server/engine-db/competition.ts) and the qualification
// builder (server/public-site/qualification-view.ts): a second copy would let
// the table and its status disagree about whether a match counts as played.
import type { FixtureStatus } from "@seazn/engine/competition";

export function engineFixtureStatus(dbStatus: string): FixtureStatus {
  switch (dbStatus) {
    case "decided":
    case "finalized":
      return "decided";
    case "forfeited":
      return "walkover";
    case "abandoned":
    case "cancelled":
      return "void";
    case "in_play":
      return "in_play";
    default:
      return "scheduled";
  }
}
```
In `engine-db/competition.ts`, replace the `toEngineStatus` function (`:73-88`) with `import { engineFixtureStatus as toEngineStatus } from "@/lib/fixture-engine-status";` among the imports. Call sites stay unchanged.

- [ ] **Step 4: Write the failing builder tests**

`apps/web/src/server/public-site/__tests__/qualification-view.test.ts`:

```ts
// buildQualificationView — the ONE builder behind the division page, the embed,
// the console and the hub (plan P3). Bounds come from the generic module's own
// declaration (Task 1); statuses are cross-checked against the engine function
// on the same derived input, never typed. Empty/no-status cases first; each
// suppression case has its positive pair.
import { describe, expect, it } from "vitest";
import { qualificationStatus, type StandingsRow } from "@seazn/engine/competition";
import { generic } from "@seazn/engine/sports/generic";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import {
  buildQualificationView,
  divisionPointsBounds,
  type QualFixture,
  type QualificationViewInput,
  type StageQualMeta,
} from "../qualification-view";

const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const BOUNDS = divisionPointsBounds(generic, CFG)!;
const W = BOUNDS.max;
const IDS = ["A", "B", "C", "D"] as const;
const names = { A: "Ada", B: "Bo", C: "Cy", D: "Di" };

const row = (id: string, rank: number, points: number, played: number): StandingsRow => ({
  entrantId: id, rank, played, won: points / W, drawn: 0, lost: played - points / W, points,
  metrics: { for: 2 * (points / W), against: 2 * (played - points / W), diff: 2 * (2 * (points / W) - played) },
});
/** Swiss 4, 3 rounds, 2 played (home always won): A 2W, B W, C W, D 0. */
function swissAfterTwo(): { rows: StandingsRow[]; fixtures: QualFixture[] } {
  const fx = (round: number, h: string | null, a: string | null, status = "decided"): QualFixture => ({
    stage_id: "S", pool_id: null, round_no: round, status, home_entrant_id: h, away_entrant_id: a,
  });
  return {
    rows: [row("A", 1, 2 * W, 2), row("B", 2, W, 2), row("C", 3, W, 2), row("D", 4, 0, 2)],
    fixtures: [fx(1, "A", "D"), fx(1, "B", "C"), fx(2, "A", "B"), fx(2, "C", "D"), fx(3, null, null, "scheduled"), fx(3, null, null, "scheduled")],
  };
}
const META: StageQualMeta = { qualifyCount: 2, qualifyPerGroup: false, nextStageName: "Finals", swissRounds: 3, pointsRule: null };
function input(over: Partial<QualificationViewInput> = {}, dict: Record<string, string> = en): QualificationViewInput {
  const { rows, fixtures } = swissAfterTwo();
  return {
    stage: { id: "S", kind: "swiss", meta: META }, poolId: null, rows, fixtures,
    entrantStatuses: Object.fromEntries(IDS.map((id) => [id, "confirmed"])),
    bounds: BOUNDS, cascade: ["points", "diff"], entrantNames: names,
    msg: (k: TKey, v?: Record<string, string | number>) => t(dict, k, v),
    plural: (k: string, n: number, v?: Record<string, string | number>) => plural(dict, k, n, dict === es ? "es" : "en", v),
    ...over,
  };
}

describe("no status — stated first, each with its positive pair", () => {
  it("positive: the Swiss-after-two table DOES carry a view", () => {
    expect(buildQualificationView(input())).not.toBeNull();
  });
  it("no cut declared", () => expect(buildQualificationView(input({ stage: { id: "S", kind: "swiss", meta: { ...META, qualifyCount: null } } }))).toBeNull());
  it("a bracket stage kind", () => expect(buildQualificationView(input({ stage: { id: "S", kind: "knockout", meta: META } }))).toBeNull());
  it("no match played", () => {
    const { rows, fixtures } = swissAfterTwo();
    expect(buildQualificationView(input({ rows, fixtures: fixtures.map((f) => ({ ...f, status: "scheduled" })) }))).toBeNull();
  });
  it("stage complete (every round settled)", () => {
    const { fixtures } = swissAfterTwo();
    const done = fixtures.map((f, i) => (f.round_no === 3 ? { ...f, status: "decided", home_entrant_id: IDS[i % 4]!, away_entrant_id: IDS[(i + 1) % 4]! } : f));
    expect(buildQualificationView(input({ fixtures: done }))).toBeNull();
  });
  it("Review Focus 1: a rank-locked table shows no status", () => {
    const { rows } = swissAfterTwo();
    expect(buildQualificationView(input({ rows: rows.map((r, i) => (i === 0 ? { ...r, rankLocked: true } : r)) }))).toBeNull();
  });
  it("Review Focus 4: a cascade not led by points shows no status", () => {
    expect(buildQualificationView(input({ cascade: ["wins", "points"] }))).toBeNull();
  });
  it("Review Focus 5: an overall cut on a pooled table shows no status; per-group does", () => {
    const pooled = (perGroup: boolean) => {
      const { rows, fixtures } = swissAfterTwo();
      return buildQualificationView(input({
        stage: { id: "S", kind: "group", meta: { ...META, qualifyPerGroup: perGroup, swissRounds: null } },
        poolId: "P1", rows, fixtures: fixtures.filter((f) => f.round_no < 3).map((f) => ({ ...f, pool_id: "P1" }))
          .concat([{ stage_id: "S", pool_id: "P1", round_no: 3, status: "scheduled", home_entrant_id: "A", away_entrant_id: "C" }]),
      }));
    };
    expect(pooled(false)).toBeNull();
    expect(pooled(true)).not.toBeNull();
  });
  it("Review Focus 3: an unsettled null-seat league fixture suppresses; a settled null-seat bye does not", () => {
    const league = (status: string) => {
      const { rows, fixtures } = swissAfterTwo();
      return buildQualificationView(input({
        stage: { id: "S", kind: "league", meta: { ...META, swissRounds: null } }, rows,
        fixtures: [...fixtures.filter((f) => f.round_no < 3), { stage_id: "S", pool_id: null, round_no: 3, status: "scheduled", home_entrant_id: "A", away_entrant_id: "C" },
          { stage_id: "S", pool_id: null, round_no: 3, status, home_entrant_id: "B", away_entrant_id: null }],
      }));
    };
    expect(league("scheduled")).toBeNull();
    expect(league("forfeited")).not.toBeNull();
  });
  it("unknown module / unparsable cfg → no bounds → no status", () => {
    expect(divisionPointsBounds(null, CFG)).toBeNull();
    expect(buildQualificationView(input({ bounds: null }))).toBeNull();
  });
});

describe("statuses equal the engine's on the derived input", () => {
  it("R4 case: A is 'Win and in' (not Through); the line sits after place 2", () => {
    const view = buildQualificationView(input())!;
    expect(view.table.cutIndex).toBe(2);
    expect(view.rows.A!.status).toBe("win_k");
    expect(view.rows.A!.label).toBe(t(en, "table.qual.status.winK.one" as TKey));
    // Cross-check against the engine on the same input the builder derives:
    const { rows } = swissAfterTwo();
    const engine = qualificationStatus({
      rows: rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map(IDS.map((id) => [id, 1])), perMatch: BOUNDS, cut: 2, anyPlayed: true, complete: false,
    })!;
    for (const id of IDS) expect(view.rows[id]!.status).toBe(engine.get(id)!.status.kind);
  });
  it("Swiss remaining counts SETTLED rounds, not seated ones (plan P2)", () => {
    // Seat round 3 (unplayed). Remaining must stay 1 — counting seats would make it 0 and flip D to Out.
    const { rows, fixtures } = swissAfterTwo();
    const seated = fixtures.map((f, i) => (f.round_no === 3 ? { ...f, home_entrant_id: i % 2 ? "A" : "B", away_entrant_id: i % 2 ? "C" : "D" } : f));
    expect(buildQualificationView(input({ rows, fixtures: seated }))!.rows.D!.status).not.toBe("out");
  });
  it("a bye counts as a round played", () => {
    // D had a bye in round 2 (one seat, forfeited) instead of a match: still 1 round left.
    const { rows, fixtures } = swissAfterTwo();
    const withBye = fixtures.map((f) => (f.round_no === 2 && f.home_entrant_id === "C" ? { ...f, home_entrant_id: "D", away_entrant_id: null, status: "forfeited" } : f));
    const v = buildQualificationView(input({ rows, fixtures: withBye }))!;
    expect(v.rows.D!.status).not.toBe("out");
  });
  it("a withdrawn entrant gets no row status but still blocks others", () => {
    const v = buildQualificationView(input({ entrantStatuses: { A: "withdrawn", B: "confirmed", C: "confirmed", D: "confirmed" } }))!;
    expect(v.rows.A).toBeUndefined();
    expect(v.rows.B!.status).not.toBe("through");
  });
  it("Review Focus 2: a stage points rule overrides the sport's bounds", () => {
    // Win bonus +W: a rival's best now reaches further, so A's one win is no longer enough.
    const rule = { base: { win: W, draw: 1, loss: 0 }, bonuses: [{ when: "win_margin_gte", param: 1, points: W }] };
    const v = buildQualificationView(input({ stage: { id: "S", kind: "swiss", meta: { ...META, pointsRule: rule } } }))!;
    expect(v.rows.A!.status).not.toBe(buildQualificationView(input())!.rows.A!.status);
  });
});

describe("wording", () => {
  it("cut line in en and es (plural by rounds left)", () => {
    expect(buildQualificationView(input())!.table.label).toBe(plural(en, "table.qual.cut", 1, "en", { n: 2, next: "Finals" }));
    expect(buildQualificationView(input({}, es))!.table.label).toBe(plural(es, "table.qual.cut", 1, "es", { n: 2, next: "Finals" }));
  });
  it("aria label names the rank and the status", () => {
    const a = buildQualificationView(input())!.rows.A!;
    expect(a.ariaLabel).toBe(t(en, "table.qual.rankLabel" as TKey, { rank: 1, status: a.label }));
  });
  it("what-if for an open row names the rival and carries the assumption", () => {
    const b = buildQualificationView(input())!.rows.B!;
    expect(b.whatIf).toContain(names.C);
    expect(b.whatIfAssumption).toBe(t(en, "table.qual.whatIf.assumption" as TKey, { rival: names.C }));
  });
  it("through/out rows carry no if-you-lose and no what-if", () => {
    const { rows } = swissAfterTwo();
    const v = buildQualificationView(input({ rows: [row("A", 1, 3 * W, 2), ...rows.slice(1)] }))!;
    expect(v.rows.A!.ifYouLose).toBeNull();
    expect(v.rows.A!.whatIf).toBeNull();
  });
});
```

(`import en from "@/dictionaries/en/public.json"`: check how `hub-dictionary.test.ts` loads dictionaries and do the same, if it uses a loader rather than a JSON import. `plural`'s `locale` parameter is the `Locale` type from `@/lib/i18n-constants`.)

- [ ] **Step 5: Run, expect red** — `cd /Users/ashokhein/github/seazn.club-wt-qualstatus/apps/web && pnpm exec vitest run src/server/public-site/__tests__/qualification-view.test.ts --reporter=json --outputFile=/private/tmp/claude-501/qual-t5.json; echo EXIT=$?` → collect failure.

- [ ] **Step 6: Implement `qualification-view.ts`**

```ts
import "server-only";
// Standings qualification status — the ONE builder behind every standings
// surface (division page, embed, organiser console, competition hub). Spec
// docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md
// §4; plan Task 5. It derives the engine's input from what each surface already
// holds (snapshot rows, the division's fixtures, entrant statuses, the stage's
// V414 meta) and resolves every string in the caller's locale. It returns null
// whenever a status could be wrong (plan P7) — no status beats a wrong one (R3).
import {
  PointsRule,
  isTableStageComplete,
  pointsRuleBounds,
  qualificationStatus,
  tieRival,
  tieWhatIf,
  type QualStatus,
  type QualificationInput,
  type StandingsRow,
  type TableFixture,
} from "@seazn/engine/competition";
import type { AnySportModule, MatchPointsBounds, TiebreakerKey } from "@seazn/engine/sport";
import { FIELD_ENTRANT_STATUSES } from "@/lib/entrant-field";
import { engineFixtureStatus } from "@/lib/fixture-engine-status";
import type { TKey } from "@/lib/i18n-runtime";
import type { QualRowT, QualTableT } from "./competition-hub-schema";
import { tieBreakRule } from "./standings-view";

export const QUAL_TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss"]);

export interface StageQualMeta {
  qualifyCount: number | null;
  qualifyPerGroup: boolean;
  nextStageName: string | null;
  swissRounds: number | null;
  pointsRule: unknown;
}

/** snake→camel for `stage_qualification_meta`'s columns — the public view row
 *  and the console usecase row both come through here. */
export function stageQualMeta(row: {
  qualify_count: number | null;
  qualify_per_group: boolean | null;
  next_stage_name: string | null;
  swiss_rounds: number | null;
  points_rule: unknown;
}): StageQualMeta {
  return {
    qualifyCount: row.qualify_count,
    qualifyPerGroup: row.qualify_per_group === true,
    nextStageName: row.next_stage_name,
    swissRounds: row.swiss_rounds,
    pointsRule: row.points_rule ?? null,
  };
}

export interface QualFixture {
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/** The division's per-match bounds from its PINNED module and live cfg. Future
 *  matches score under live cfg (V347 freezes only already-scored ones), and
 *  `stage.config.rules` cannot carry points (engine-db/competition.ts:305-317). */
export function divisionPointsBounds(
  module_: AnySportModule | null | undefined,
  cfg: unknown,
): MatchPointsBounds | null {
  if (!module_) return null;
  const parsed = module_.configSchema.safeParse(cfg ?? {});
  return parsed.success ? module_.matchPointsBounds(parsed.data) : null;
}

export interface QualificationView {
  table: QualTableT;
  rows: Record<string, QualRowT>;
}

export interface QualificationViewInput {
  stage: { id: string; kind: string; meta: StageQualMeta };
  poolId: string | null;
  rows: readonly StandingsRow[];
  fixtures: readonly QualFixture[];
  entrantStatuses: Readonly<Record<string, string>>;
  bounds: MatchPointsBounds | null;
  cascade: readonly string[];
  entrantNames: Readonly<Record<string, string>>;
  msg: (key: TKey, vars?: Record<string, string | number>) => string;
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
}

const SETTLED = new Set(["decided", "walkover", "void"]);
const seats = (f: QualFixture, id: string) => f.home_entrant_id === id || f.away_entrant_id === id;

function statusLabel(s: QualStatus, i: QualificationViewInput): string {
  switch (s.kind) {
    case "through": return i.msg("table.qual.status.through");
    case "win_k": return i.plural("table.qual.status.winK", s.k);
    case "needs_help": return i.msg("table.qual.status.needsHelp");
    case "out": return i.msg("table.qual.status.out");
  }
}

function headline(s: QualStatus, i: QualificationViewInput, next: string, n: number): string {
  switch (s.kind) {
    case "through": return i.msg("table.qual.headline.through", { next });
    case "win_k": return i.plural("table.qual.headline.winK", s.k, { next });
    case "needs_help": return i.msg("table.qual.headline.needsHelp");
    case "out": return i.msg("table.qual.headline.out", { n });
  }
}

export function buildQualificationView(i: QualificationViewInput): QualificationView | null {
  const { meta } = i.stage;
  if (!QUAL_TABLE_KINDS.has(i.stage.kind)) return null;
  if (meta.qualifyCount === null || meta.qualifyCount < 1 || meta.nextStageName === null) return null;
  if (!meta.qualifyPerGroup && i.poolId !== null) return null; // Review Focus 5
  if (i.rows.length === 0 || i.rows.some((r) => r.rankLocked === true)) return null; // Review Focus 1
  if (i.cascade[0] !== "points") return null; // Review Focus 4
  let perMatch = i.bounds;
  if (meta.pointsRule !== null && meta.pointsRule !== undefined) {
    const rule = PointsRule.safeParse(meta.pointsRule);
    perMatch = rule.success ? pointsRuleBounds(rule.data) : null;
  }
  if (perMatch === null) return null;

  const isSwiss = i.stage.kind === "swiss";
  const tableFx = i.fixtures.filter((f) => f.stage_id === i.stage.id && (f.pool_id ?? null) === i.poolId);
  if (tableFx.length === 0) return null;
  const settled = (f: QualFixture) => SETTLED.has(engineFixtureStatus(f.status));
  // Review Focus 3: a league seat still TBD cannot be counted per entrant.
  if (!isSwiss && tableFx.some((f) => !settled(f) && (f.home_entrant_id === null || f.away_entrant_id === null))) return null;
  if (isSwiss && (meta.swissRounds === null || meta.swissRounds < 1)) return null;

  const remainingOf = (id: string): number =>
    isSwiss
      ? Math.max(0, meta.swissRounds! - new Set(tableFx.filter((f) => settled(f) && seats(f, id)).map((f) => f.round_no)).size)
      : tableFx.filter((f) => !settled(f) && seats(f, id)).length;
  const active = (id: string) => {
    const s = i.entrantStatuses[id];
    return s === undefined || FIELD_ENTRANT_STATUSES.includes(s);
  };
  const ordered = [...i.rows].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  const engineFx: TableFixture[] = tableFx.map((f, n) => ({ id: String(n), status: engineFixtureStatus(f.status), roundNo: f.round_no }));
  const engine: QualificationInput = {
    rows: ordered.map((r) => ({ entrantId: r.entrantId, points: r.points, active: active(r.entrantId) })),
    remaining: new Map(ordered.map((r) => [r.entrantId, remainingOf(r.entrantId)])),
    perMatch,
    cut: meta.qualifyCount,
    anyPlayed: tableFx.some((f) => engineFixtureStatus(f.status) === "decided" && f.home_entrant_id !== null && f.away_entrant_id !== null),
    complete: isTableStageComplete(
      { id: i.stage.id, kind: i.stage.kind as "league" | "group" | "swiss", entrants: [], cascade: [], ...(isSwiss ? { rounds: meta.swissRounds! } : {}) },
      engineFx,
    ),
  };
  const result = qualificationStatus(engine);
  if (result === null) return null;

  const n = meta.qualifyCount;
  const next = meta.nextStageName;
  const name = (id: string) => i.entrantNames[id] ?? id;
  const byId = new Map(ordered.map((r) => [r.entrantId, r]));
  const orderedIds = ordered.map((r) => r.entrantId);
  const roundsLeft = Math.max(0, ...engine.rows.filter((r) => r.active).map((r) => engine.remaining.get(r.entrantId) ?? 0));

  const rows: Record<string, QualRowT> = {};
  ordered.forEach((r, position) => {
    const res = result.get(r.entrantId);
    if (!res) return;
    const label = statusLabel(res.status, i);
    const open = res.status.kind === "win_k" || res.status.kind === "needs_help";
    let whatIf: string | null = null;
    let whatIfAssumption: string | null = null;
    if (open) {
      const rivalId = tieRival(engine, orderedIds, r.entrantId);
      const rival = rivalId ? byId.get(rivalId) : undefined;
      const w = rival ? tieWhatIf(r, rival, i.cascade as readonly TiebreakerKey[]) : null;
      if (w && rival) {
        const vars = { rival: name(rival.entrantId), rule: tieBreakRule(w.key, i.msg) };
        if (w.kind === "target") {
          whatIf = w.margin > 0
            ? i.msg("table.qual.whatIf.winBy", { ...vars, m: w.margin })
            : w.margin < 0
              ? i.msg("table.qual.whatIf.loseByAtMost", { ...vars, m: -w.margin })
              : i.msg("table.qual.whatIf.dontLose", vars);
          whatIfAssumption = i.msg("table.qual.whatIf.assumption", { rival: vars.rival });
        } else if (w.kind === "safe") {
          whatIf = i.msg("table.qual.whatIf.safe", vars);
          whatIfAssumption = i.msg("table.qual.whatIf.assumption", { rival: vars.rival });
        } else {
          whatIf = w.mine !== null && w.theirs !== null
            ? i.msg("table.qual.whatIf.ruleValues", { ...vars, mine: w.mine, theirs: w.theirs })
            : i.msg("table.qual.whatIf.rule", vars);
        }
      }
    }
    rows[r.entrantId] = {
      status: res.status.kind,
      label,
      ariaLabel: i.msg("table.qual.rankLabel", { rank: r.rank ?? position + 1, status: label }),
      headline: headline(res.status, i, next, n),
      ifYouLose: res.ifYouLose ? i.msg("table.qual.ifYouLose", { status: statusLabel(res.ifYouLose, i) }) : null,
      whatIf,
      whatIfAssumption,
    };
  });

  return {
    table: {
      cutIndex: n,
      label: roundsLeft > 0
        ? i.plural("table.qual.cut", roundsLeft, { n, next })
        : i.msg("table.qual.cutNoRounds", { n, next }),
      legend: {
        through: i.msg("table.qual.legend.through"),
        open: i.msg("table.qual.legend.open"),
        out: i.msg("table.qual.legend.out"),
        hint: i.msg("table.qual.legend.hint"),
      },
    },
    rows,
  };
}
```

(`rows` is a plain object, never a `Map`: the hub caches it through `unstable_cache`, which serialises Maps to `{}` (memory: unstable_cache ⇒ `{}`).)

- [ ] **Step 7: Run, expect pass; then the neighbours**

Re-run Step 5. Then `pnpm exec vitest run src/server/public-site src/server/engine-db --reporter=json --outputFile=/private/tmp/claude-501/qual-t5b.json`: `numFailedTests: 0`. Confirm `.testResults[].name` resolves inside this worktree. Web typecheck `TSC=0`, lint 0 problems.

- [ ] **Step 8: Mutation sweep** — (a) remove the `rankLocked` guard; (b) remove the `cascade[0]` guard; (c) remove the `poolId`/`qualifyPerGroup` guard; (d) Swiss remaining counts seated instead of settled (`settled(f) &&` deleted); (e) `active` treats `withdrawn` as active; (f) drop the `pointsRule` override; (g) `engineFixtureStatus` maps `forfeited` → `scheduled`. Each must be red. Record the killers.

- [ ] **Step 9: Commit** — `feat(web): buildQualificationView — one qualification builder for every standings surface` + trailer (`pnpm openapi:gen` drift check first: the schema changed, so expect `openapi/` to change. Commit that regen too).

---

### Task 6: Hub wiring — `buildTableView` emits `qualification` and `qual`

**Files:**
- Modify: `apps/web/src/server/public-site/standings-view.ts:208-291` (`TableViewInput`, `buildTableView`)
- Modify: `apps/web/src/server/public-site/competition-hub.ts:~774-800` (call site), `:1067` (`pub-hub-v3` → `pub-hub-v4`, plus every other literal of it)
- Modify: `apps/web/src/server/public-site/__tests__/standings-view.test.ts` (new cases)
- Regenerate: OpenAPI (`pnpm openapi:gen`)

**Interfaces:**
- Consumes: `buildQualificationView`, `divisionPointsBounds`, `stageQualMeta` (Task 5).
- Produces: `TableViewInput.qualification?: QualificationView | null`. `TableViewT.qualification` and `TableRow.qual` are populated.

**Acceptance:** unit (builder carries it through; a no-cut table emits `null` and nothing else changes: byte-compare the view with and without the new input for a no-cut table); regression (`competition-hub.test.ts`, `competition-hub-db.test.ts`, `hub-dictionary.test.ts`); e2e in Task 10.

- [ ] **Step 1: Failing tests** — append to `standings-view.test.ts`:

```ts
describe("qualification (spec 2026-09-22)", () => {
  it("empty case: no qualification input → view.qualification null and every row.qual null", () => {
    const view = buildTableView(baseInput()); // the file's existing fixture helper
    expect(view.qualification).toBeNull();
    expect(view.rows.every((r) => r.qual === null)).toBe(true);
  });
  it("carries the table line and each row's status through unchanged", () => {
    const qualification = {
      table: { cutIndex: 1, label: "Top 1 go through to KO · 1 round left", legend: { through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." } },
      rows: { [baseInput().rows[0]!.entrantId]: { status: "through", label: "Through", ariaLabel: "Rank 1, Through, show details", headline: "h", ifYouLose: null, whatIf: null, whatIfAssumption: null } },
    } as const;
    const view = buildTableView({ ...baseInput(), qualification });
    expect(view.qualification).toEqual(qualification.table);
    expect(view.rows[0]!.qual).toEqual(qualification.rows[baseInput().rows[0]!.entrantId]);
    expect(view.rows.slice(1).every((r) => r.qual === null)).toBe(true);
  });
  it("regression: a no-cut table is byte-identical apart from the two new null fields", () => {
    const { qualification: _q, ...before } = buildTableView(baseInput());
    const after = buildTableView({ ...baseInput(), qualification: null });
    expect({ ...after, rows: after.rows.map(({ qual: _x, ...r }) => r) }).toEqual({ ...before, rows: before.rows.map(({ qual: _x, ...r }) => r), qualification: undefined } as never);
  });
});
```
(Adapt `baseInput()` to the helper name the file already uses to build a `TableViewInput`.)

- [ ] **Step 2: Run, expect red** (`pnpm exec vitest run src/server/public-site/__tests__/standings-view.test.ts --reporter=json …`).

- [ ] **Step 3: Implement.** In `TableViewInput` add:
```ts
  /** Standings qualification (spec 2026-09-22), already resolved by
   *  `buildQualificationView`; null/absent = no cut to show. */
  qualification?: QualificationView | null;
```
(`import type { QualificationView } from "./qualification-view";`). In `buildTableView` add `qualification: input.qualification?.table ?? null,` to the returned object and `qual: input.qualification?.rows[r.entrantId] ?? null,` in each row (replacing Task 5's placeholders).

In `competition-hub.ts`, inside the `for (const snap of snapshots)` loop (`:~778`), compute once per division above the loop:
```ts
    const bounds = divisionPointsBounds(module_, d.config);
    const cascadeOf = d.tiebreakers ?? module_?.defaultTiebreakers ?? [];
    const statuses = Object.fromEntries(entrants.map((e) => [e.id, e.status]));
    const pluralMsg = (key: string, count: number, vars?: Record<string, string | number>) => plural(dict, key, count, locale, vars);
```
and pass to `buildTableView`:
```ts
            qualification: buildQualificationView({
              stage: { id: stage.id, kind: stage.kind, meta: stageQualMeta(stage) },
              poolId: snap.pool_id ?? null,
              rows: snap.rows,
              fixtures,
              entrantStatuses: statuses,
              bounds,
              cascade: cascadeOf,
              entrantNames: names,
              msg,
              plural: pluralMsg,
            }),
```
(`dict`/`locale` are the ones bound at `competition-hub.ts:570-572`; `plural` from `@/lib/i18n-runtime`. `d.config` is `PublicDivision.config`. Confirm the hub's division list carries it (`data.ts:625`).) Bump `["pub-hub-v3", …]` → `["pub-hub-v4", …]` and every other literal of it.

- [ ] **Step 4: Run** — Step 2 command, then `pnpm exec vitest run src/server/public-site --reporter=json …` (whole dir; `competition-hub-schema.test.ts` parses documents, so a missing `qual` would red there). `pnpm openapi:gen && git status --porcelain` → commit the regenerated spec.

- [ ] **Step 5: Mutation** — (a) emit `qualification: null` unconditionally → case 2 red; (b) key `qual` by rank instead of entrant id → case 2 red.

- [ ] **Step 6: Commit** — `feat(web): hub standings view carries qualification status` + trailer.

---

### Task 7: UI — markers, cut line, legend and popover on `StandingsTable` (division page + embed)

**Files:**
- Create: `apps/web/src/components/public-site/qualification-bits.tsx`
- Modify: `apps/web/src/components/public-site/standings-table.tsx` (props, rank cell, row loop, legend)
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx:~277-290`
- Modify: `apps/web/src/app/embed/divisions/[id]/[widget]/page.tsx:~186-199`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/__tests__/` (one new plumbing test beside `page-departed-entrant-status-plumbing.test.ts`)

**Interfaces:**
- Consumes: `QualificationView`, `buildQualificationView`, `divisionPointsBounds`, `stageQualMeta` (Task 5). `StandingsPopover` from `feat/standings-popovers` — **ASSUMED interface** (Step 1 confirms and adapts):
  ```ts
  // apps/web/src/components/public-site/standings-popover.tsx  ("use client")
  export interface StandingsPopoverProps {
    id: string;              // unique per page; panel id = `${id}-panel`
    label: string;           // trigger button's accessible name
    trigger: React.ReactNode;// visible trigger content (the rank chip)
    up?: boolean;            // open upward (last rows)
    children: React.ReactNode;
  }
  export function StandingsPopover(props: StandingsPopoverProps): React.JSX.Element;
  ```
  It closes on an outside tap and on Esc, and keeps one open at a time (inherited behaviour, spec §5).
- Produces: `StandingsTable` props gain `qualification?: QualificationView | null` and `tableKey: string`. `qualification-bits.tsx` exports `QualMarker`, `QualCutRow`, `QualLegend`, `QualPopoverBody` (used again by Task 8).

**Acceptance:** VERIFY-AS-CUSTOMER rows (screenshots at 320/768/1280, no page scroll, tap ≥ 40 hit-tested); unit (plumbing test: the page passes `qualification` built from the real `getPublicDivision` shape); e2e in Task 10; ≥ 2 UI options were shown and B chosen (spec R6 mockups). No new options are owed.

- [ ] **Step 1: Rebase onto the popover branch and re-read its API**

Only once `feat/standings-popovers`'s own review is complete (ask the orchestrator; never infer it). The tree must be clean (`git status --porcelain` empty; **no `git stash`**). Run:
`cd /Users/ashokhein/github/seazn.club-wt-qualstatus && git fetch origin feat/standings-popovers && git rebase origin/feat/standings-popovers; echo EXIT=$?`
If it conflicts, resolve the conflict, then re-run the Task 1–6 unit gates (engine `src/competition src/sport src/sports src/testkit`; web `src/server/public-site`) with the JSON reporter before going on. Then read `apps/web/src/components/public-site/standings-popover.tsx` in full, and how `standings-table.tsx` and `standings-table-view.tsx` now mount it. Write down its real props in the task report. Map each ASSUMED prop above to the real one. Where the real component lacks one (for example no `up`, because it computes placement itself), drop that prop from the code below and keep the component's own behaviour. Do not fork or wrap the popover to recover the assumed shape.

- [ ] **Step 2: Create `qualification-bits.tsx`** (server-safe: no hooks, no `"use client"`)

```tsx
// Standings qualification status — the shared marker, cut line, legend and
// popover body (spec 2026-09-22 §5, Option B). Used by BOTH standings tables so
// the division page, the embed, the console and the hub draw the same thing.
// Every string arrives resolved (buildQualificationView); nothing here knows a
// locale. The marker is aria-hidden: the status is spoken by the rank
// trigger's own label ("Rank 3, Win 2 and in, show details").
import type { QualRowT, QualTableT } from "@/server/public-site/competition-hub-schema";

type Kind = QualRowT["status"];

export function QualMarker({ status }: { status: Kind }) {
  if (status === "through") {
    return (
      <span aria-hidden="true" data-qual-marker="through"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-bold leading-none text-emerald-700">
        ✓
      </span>
    );
  }
  if (status === "out") {
    return (
      <span aria-hidden="true" data-qual-marker="out"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-bold leading-none text-zinc-500">
        –
      </span>
    );
  }
  return (
    <span aria-hidden="true" data-qual-marker={status}
      className="inline-block h-4 w-4 shrink-0 rounded-full border-2 border-zinc-400 bg-surface" />
  );
}

/** A full-width row after place N. The label is sticky so it stays on screen
 *  when the table scrolls sideways inside its region, and it may wrap to two
 *  lines at 320 (spec §5). */
export function QualCutRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr data-testid="qual-cut">
      <td colSpan={colSpan} className="border-t-2 border-dashed border-accent p-0">
        <span className="sticky left-0 block max-w-[calc(100vw-3rem)] whitespace-normal px-4 py-1.5 text-[11px] font-semibold leading-snug text-accent-strong md:max-w-none">
          {label}
        </span>
      </td>
    </tr>
  );
}

export function QualLegend({ legend }: { legend: QualTableT["legend"] }) {
  return (
    <p data-testid="qual-legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[11px] text-ink-muted">
      <span className="inline-flex items-center gap-1"><QualMarker status="through" />{legend.through}</span>
      <span className="inline-flex items-center gap-1"><QualMarker status="needs_help" />{legend.open}</span>
      <span className="inline-flex items-center gap-1"><QualMarker status="out" />{legend.out}</span>
      <span>{legend.hint}</span>
    </p>
  );
}

/** Popover content, in the spec's order: headline, if-you-lose, tie note, what-if. */
export function QualPopoverBody({ qual, tieNote }: { qual: QualRowT | null; tieNote: string | null }) {
  return (
    <div className="space-y-1.5 text-xs text-zinc-700">
      {qual ? <p data-testid="qual-headline" className="font-semibold text-ink">{qual.headline}</p> : null}
      {qual?.ifYouLose ? <p data-testid="qual-if-lose">{qual.ifYouLose}</p> : null}
      {tieNote ? <p data-testid="qual-tie-note">{tieNote}</p> : null}
      {qual?.whatIf ? (
        <div data-testid="qual-what-if">
          <p>{qual.whatIf}</p>
          {qual.whatIfAssumption ? <p className="mt-0.5 text-[11px] italic text-ink-muted">{qual.whatIfAssumption}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Extend `StandingsTable`**

Props (after `entrantStatuses`):
```ts
  /** Standings qualification (spec 2026-09-22), from `buildQualificationView`.
   *  Absent/null: the table renders exactly as before (regression-pinned). */
  qualification?: QualificationView | null;
  /** Unique per table on the page — the popover ids hang off it. */
  tableKey: string;
```
Rank cell, replacing the `<details>`/popover branch the rebased file now has (keep its `has-[…]:z-30` raise and sticky classes; adapt the selector to whatever the popover renders):
```tsx
{(() => {
  const qual = qualification?.rows[row.entrantId] ?? null;
  const tieNote = row.tieBreak
    ? msg("table.tieBreak", { with: row.tieBreak.with.map((id) => entrantNames[id] ?? "—").join(", "), rule: tieBreakRule(row.tieBreak.key, msg) })
    : null;
  if (!qual && !tieNote) return rankChip(row.rank);
  return (
    <StandingsPopover
      id={`st-${tableKey}-${row.entrantId}`}
      label={qual ? qual.ariaLabel : /* the popover branch's existing tie-only label, unchanged */ tieNote!}
      trigger={
        <span className="inline-flex min-h-10 min-w-10 items-center gap-1 md:min-h-0 md:min-w-0">
          {rankChip(row.rank)}
          {qual ? <QualMarker status={qual.status} /> : null}
          {tieNote && !qual ? <span className="text-[10px] text-accent">*</span> : null}
        </span>
      }
      up={index >= ranked.length - 2}
    >
      <QualPopoverBody qual={qual} tieNote={tieNote} />
    </StandingsPopover>
  );
})()}
```
Row loop: switch `ranked.map((row) => (<tr …>))` to `ranked.map((row, index) => (<Fragment key={row.entrantId}><tr … data-qual={qualification?.rows[row.entrantId]?.status}>…</tr>{cut}</Fragment>))`, with
```tsx
const cut = qualification && index === qualification.table.cutIndex - 1 && index < ranked.length - 1
  ? <QualCutRow colSpan={2 + columns.length} label={qualification.table.label} />
  : null;
```
(`Fragment` from `react`.) An Out row's name cell uses `text-ink-muted` instead of `text-ink`: `className={`py-2.5 pr-3 text-left font-medium ${qualification?.rows[row.entrantId]?.status === "out" ? "text-ink-muted" : "text-ink"}`}`. Wrap the returned region in `<div>` and render `{qualification ? <QualLegend legend={qualification.table.legend} /> : null}` after the region (outside the scroll box).

The existing `[tr:last-child_&]` upward-open rule keys on `tr:last-child`. The cut row is never last (`index < ranked.length - 1`), so it stays correct. Verify in Step 6.

- [ ] **Step 4: Wire the division page and the embed**

Division page (`page.tsx`, the `<StandingsTable …>` at `:~277`). Above `standingsPanel`:
```ts
  const bounds = (() => { try { return divisionPointsBounds(resolveModule(division.sport_key, division.module_version), division.config); } catch { return null; } })();
  const pluralMsg = (key: string, count: number, vars?: Record<string, string | number>) => plural(dict, key, count, orgLocale, vars);
  const msgOf = (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);
```
and on the table:
```tsx
                    tableKey={`${stage.id}-${snap.pool_id ?? "overall"}`}
                    qualification={buildQualificationView({
                      stage: { id: stage.id, kind: stage.kind, meta: stageQualMeta(stage) },
                      poolId: snap.pool_id ?? null,
                      rows: snap.rows as StandingsRow[],
                      fixtures,
                      entrantStatuses,
                      bounds,
                      cascade,
                      entrantNames,
                      msg: msgOf,
                      plural: pluralMsg,
                    })}
```
Embed page: the same, with `orgLocale` from `:99` and `dict` from `:107`. Add `tableKey` and `qualification` to its `StandingsTable`. `stage` is the loop's `stage`; `fixtures`/`entrantStatuses` are already in scope there.

- [ ] **Step 5: Plumbing unit test** — create `…/[divisionSlug]/__tests__/page-qualification-plumbing.test.ts`. Model it on `page-departed-entrant-status-plumbing.test.ts`: mock `getPublicDivision` to return a Swiss-after-two scene with `qualify_count: 2`, render the page's server tree, and assert that the `StandingsTable` element's `qualification` prop is non-null with `table.cutIndex === 2`. Also assert that the markup contains `data-testid="qual-cut"` and the `aria-label` of row 1 equals the builder's `ariaLabel` (anchor on `="`, AGENTS.md trap). Pair it with the same scene at `qualify_count: null`: no `qual-cut`, no `qual-legend`, no `data-qual-marker`. Run with the JSON reporter.

- [ ] **Step 6: See it** — local prod server per `seazn-local-env` (localhost). Seed Task 10's Swiss scene with its seed function, or by hand through the API. Capture cropped screenshots of the standings panel with a popover open at 1280, 768 and 320. At each width: no horizontal page scroll (`document.scrollingElement.scrollWidth <= innerWidth`); `elementFromPoint` at the rank trigger's centre, and 19px inside each edge at 320, lands inside the trigger (≥ 40px hit area); the last row's popover opens upward and is not clipped. Write down per-screen what you SAW. Compare the control set at 320 against 1280 (same markers and legend, not a shrunk copy).

- [ ] **Step 7: Commit** — `feat(web): qualification markers, cut line, legend and popover on the division and embed standings` + trailer.

---

### Task 8: UI — the hub's `StandingsTableView`

**Files:**
- Modify: `apps/web/src/components/public-site/standings-table-view.tsx:~271-410` (rank cell, row loop, legend)
- Modify: `apps/web/src/components/public-site/matches-hub/table-tab.tsx` only if the rebased popover branch requires a prop from the tab (read first; otherwise untouched)

**Interfaces:**
- Consumes: `view.qualification`, `r.qual` (Task 6); `QualMarker`, `QualCutRow`, `QualLegend`, `QualPopoverBody` (Task 7); `StandingsPopover` (the real props, as recorded in Task 7 Step 1).
- Produces: nothing new.

**Acceptance:** screenshots at 1280/768/320 on the hub Table tab with a popover open. The rank column's arithmetic (`w-12` = 40px content, header comment `:141`) still holds with a 16px marker, so recheck `NAME_MIN_PX` and the min-width custom properties with the marker in. e2e in Task 10.

- [ ] **Step 1: Confirm the rebase from Task 7 is in place** (`git log --oneline -1 origin/feat/standings-popovers` is an ancestor of `HEAD`: `git merge-base --is-ancestor origin/feat/standings-popovers HEAD; echo $?` → `0`). Re-read how the rebased `standings-table-view.tsx` mounts `StandingsPopover`.

- [ ] **Step 2: Rank cell** — inside the existing `<td className="py-2 pl-2 align-middle tabular-nums">`, replace the chip-plus-`*` span with:
```tsx
{r.qual || r.tieBreakText ? (
  <StandingsPopover
    id={`${testid}-pop-${r.entrantId}`}
    label={r.qual ? r.qual.ariaLabel : /* the popover branch's tie-only label */ r.tieBreakText!}
    trigger={
      <span className="flex min-h-10 min-w-10 items-center gap-px md:min-h-0 md:min-w-0">
        {rankChip(r.rank)}
        {r.qual ? <QualMarker status={r.qual.status} /> : null}
        {r.tieBreakText && !r.qual ? <span aria-hidden className="shrink-0 text-[10px] leading-none text-accent">*</span> : null}
      </span>
    }
    up={index >= rows.length - 2}
  >
    <QualPopoverBody qual={r.qual} tieNote={r.tieBreakText} />
  </StandingsPopover>
) : (
  <span className="flex items-center gap-px">{rankChip(r.rank)}</span>
)}
```
- [ ] **Step 3: Cut line and legend** — change `rows.map((r) => (` to `rows.map((r, index) => (<Fragment key={r.entrantId}>…</Fragment>))` and append the same `QualCutRow` rule as Task 7. Here `colSpan={2 + view.columns.length}` and the guard is `view.qualification && index === view.qualification.cutIndex - 1 && index < rows.length - 1` (a PREVIEW that stops at or before the line shows no line). Render `<QualLegend legend={view.qualification.legend} />` after the scroll region and before the `-more` button, only when `view.qualification && preview === undefined`. The Overview teaser keeps its markers but drops the legend. Record that choice in the report. An Out row's name `<span>` gets `text-ink-muted`.

- [ ] **Step 4: See it** — the same checks as Task 7 Step 6, on `/shared/{org}/{comp}?tab=table` (wait for `mh-tab-panel-table`), at 1280/768/320. Also check the Overview teaser at 320.

- [ ] **Step 5: Commit** — `feat(web): qualification status on the hub Table tab` + trailer.

---

### Task 9: Console wiring (R1a) — same markers on the organiser's division standings

**Files:**
- Create: `apps/web/src/server/usecases/stage-qualification.ts`
- Create: `apps/web/src/server/usecases/__tests__/stage-qualification-db.test.ts`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:~432-453` (load meta with the standings), `:~798-807` (pass props)

**Interfaces:**
- Consumes: SQL `stage_qualification_meta` (Task 4); `stageQualMeta`, `buildQualificationView`, `divisionPointsBounds` (Task 5); `StandingsTable` props (Task 7).
- Produces: `listStageQualificationMeta(auth: AuthCtx, stageIds: readonly string[]): Promise<Map<string, StageQualMeta>>`.

**Acceptance:** DB unit test proving parity (for a public division, the console usecase returns exactly what `public_stages_v` publishes for each stage; for a private one it still returns the meta); regression (the five `__tests__` of the console page stay green; they mock `@/server/usecases/stages` wholesale, which is why this lives in its own module); e2e parity in Task 10.

- [ ] **Step 1: Failing DB test**

```ts
// R1a — the console reads the SAME SQL function the public view calls, so the
// organiser can never see a different cut from the one players see.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { stageQualMeta } from "@/server/public-site/qualification-view";
import { listStageQualificationMeta } from "../stage-qualification";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("listStageQualificationMeta", () => {
  let auth: AuthCtx;
  beforeAll(async () => ({ auth } = await seedOrg("pro")));
  const scene = async (visibility: "public" | "private") => {
    const s = randomUUID().slice(0, 8);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Q ${s}`, visibility, branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: `o-${s}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    const stages = await createStages(auth, div.id, [
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 4 } },
      { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "on_complete" } },
    ]);
    return { div, stages };
  };
  it("empty input → empty map (no query)", async () => {
    expect((await listStageQualificationMeta(auth, [])).size).toBe(0);
  });
  it("parity: equals what public_stages_v publishes, stage by stage", async () => {
    const { div, stages } = await scene("public");
    const console_ = await listStageQualificationMeta(auth, stages.map((s) => s.id));
    const pub = await sql<Parameters<typeof stageQualMeta>[0] & { id: string }[]>`
      select id, qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule
      from public_stages_v where division_id = ${div.id}`;
    for (const row of pub) expect(console_.get(row.id)).toEqual(stageQualMeta(row));
    expect(console_.get(stages[0]!.id)).toMatchObject({ qualifyCount: 4, nextStageName: "Finals", swissRounds: 4 });
  });
  it("a private competition still gets its meta in the console", async () => {
    const { stages } = await scene("private");
    expect((await listStageQualificationMeta(auth, [stages[0]!.id])).get(stages[0]!.id)?.qualifyCount).toBe(4);
  });
  it("another org's stage id returns nothing (RLS on `stages` gates the join)", async () => {
    const { stages } = await scene("private");
    const { auth: other } = await seedOrg("pro");
    expect((await listStageQualificationMeta(other, [stages[0]!.id])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect red** (collect error: module missing).

- [ ] **Step 3: Implement**

```ts
import "server-only";
// R1a (spec 2026-09-22): the organiser console's standings show the same
// qualification status as the public pages. The console is force-dynamic and
// reads `stages` directly rather than `public_stages_v` (which also hides
// private competitions), so it calls the SAME SQL function the view calls —
// V414's stage_qualification_meta — and never derives a cut of its own.
// Selecting FROM `stages` under withTenant is what scopes it to this org: the
// function is SECURITY DEFINER, so RLS applies to the outer `stages` read.
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stageQualMeta, type StageQualMeta } from "@/server/public-site/qualification-view";

export async function listStageQualificationMeta(
  auth: AuthCtx,
  stageIds: readonly string[],
): Promise<Map<string, StageQualMeta>> {
  if (stageIds.length === 0) return new Map();
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<{ stage_id: string; qualify_count: number | null; qualify_per_group: boolean | null; next_stage_name: string | null; swiss_rounds: number | null; points_rule: unknown }[]>`
      select s.id as stage_id, q.qualify_count, q.qualify_per_group, q.next_stage_name, q.swiss_rounds, q.points_rule
      from stages s
      cross join lateral stage_qualification_meta(s.id) q
      where s.id in ${tx([...stageIds])}`,
  );
  return new Map(rows.map((r) => [r.stage_id, stageQualMeta(r)]));
}
```

- [ ] **Step 4: Wire the page.** In the `standings` block (`:~432`), after computing `tableStages`, load the meta once when `tab === "standings"`:
```ts
  const qualMeta = tab === "standings" ? await listStageQualificationMeta(auth, tableStages.map((s) => s.id)) : new Map();
  const qualBounds = divisionPointsBounds(sportModule, division.config);
```
On the `<StandingsTable>` (`:~798`) add:
```tsx
                        tableKey={`${stage.id}-${poolId ?? "overall"}`}
                        qualification={(() => {
                          const meta = qualMeta.get(stage.id);
                          return meta
                            ? buildQualificationView({
                                stage: { id: stage.id, kind: stage.kind, meta },
                                poolId,
                                rows: snap.rows as StandingsRow[],
                                fixtures,
                                entrantStatuses,
                                bounds: qualBounds,
                                cascade,
                                entrantNames,
                                msg: (k, v) => t(publicDict, k, v),
                                plural: (k, n, v) => plural(publicDict, k, n, locale, v),
                              })
                            : null;
                        })()}
```
(`fixtures` is `listDivisionFixtures`'s `FixtureRow[]`. It already has every `QualFixture` field. Its `locale` is the viewer's (`:95`), matching the table's dictionary (`publicDict`).)

- [ ] **Step 5: Run** — the new DB test, plus the console page's `__tests__/` directory as a whole: `pnpm exec vitest run "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__" src/server/usecases/__tests__/stage-qualification-db.test.ts --reporter=json …`. `numFailedTests: 0`, all five existing page tests included. If a page test now fails because `@/server/usecases/stage-qualification` is unmocked, add `vi.mock("@/server/usecases/stage-qualification", () => ({ listStageQualificationMeta: vi.fn(async () => new Map()) }))` beside its other mocks. That is the only permitted change to those files.

- [ ] **Step 6: Mutation** — (a) drop `from stages s` and call the function on the raw ids → the other-org case must go red (otherwise the definer function leaks across tenants: stop and escalate); (b) change `qualify_per_group` to a constant `false` in `stageQualMeta` → the parity case goes red once the scene uses `topNPerGroup`. Add that variant to the parity test.

- [ ] **Step 7: See it** — organiser signed in, `/o/{org}/c/{comp}/d/{div}?tab=standings` at 1280/768/320 with a popover open, and the same checks as Task 7 Step 6.

- [ ] **Step 8: Commit** — `feat(web): organiser console standings show qualification status (R1a)` + trailer.

---

### Task 10: E2E, smoke, regression, screenshots and the single PR

**Files:**
- Create: `apps/web/e2e/standings-qualification.spec.ts`
- Modify: `scripts/smoke.ts` (new suite beside `publicWithdrawnStandingsSuite`, `:~971` call and `:~8497` definition)
- Modify: `docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md` only if a finding here changes a ruling's wording (it must not change a ruling)

**Interfaces:** consumes everything above. Produces the PR.

**Acceptance:** e2e (public page, hub, pools, console parity, no-cut regression, 7 widths plus 1280); smoke; regression (existing standings/hub specs as whole files, `mobile.spec.ts` whole); per-screen visual verdicts; one PR.

- [ ] **Step 1: Write the e2e spec** (seed in `beforeAll`, not a serial test 1: see `withdrawn-entrant-public-board.spec.ts:44-52` for why)

```ts
// Standings qualification status (spec 2026-09-22) — driven through the REAL
// producer (API seed, real scoring) and the REAL consumers (public division
// page, hub Table tab, organiser console). Unit suites cannot see whether a page
// passes `qualification` to the table at all (AGENTS.md #1 inert seam).
//
// Expected statuses are computed with the ENGINE's own `qualificationStatus`
// over the organiser API's standings rows, with bounds from the generic
// module's declaration — never typed. The scene is chosen so the right answer
// differs from the wrong constant: after two rounds the leader can only be
// DRAWN level with (R4), so a `>` build would print Through; the correct build
// prints "Win and in".
import { expect, test, type Page } from "@playwright/test";
import { qualificationStatus } from "@seazn/engine/competition";
import { generic } from "@seazn/engine/sports/generic";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll, scoreFixture } from "./helpers";
import { activeOrgSlug, dictString, publicCompetition, spectator } from "./spectator-w2-kit";
import { closeOpenContexts } from "./spectator-public-helpers";

const CFG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };
const ROUNDS = 3;
const CUT = 2;
const WIDTHS = [320, 360, 375, 390, 430, 768, 834, 1280] as const;
type Fx = { id: string; stage_id: string; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null };

interface Scene { orgSlug: string; compSlug: string; divSlug: string; divisionId: string; swissId: string; poolDivSlug: string; plainDivSlug: string; names: Record<string, string> }
let scene: Scene;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const request = ctx.request;
  const { slug: orgSlug, id: orgId } = await activeOrgSlug(request);
  const comp = await publicCompetition(request, { name: `Qual ${TAG}`, orgId });
  const mkDiv = async (name: string) =>
    (await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: `${name} ${TAG}`, sport_key: "generic", variant_key: "score", config: CFG })).data!;

  // 1. Swiss 4 → Finals (top 2), two of three rounds played, home always wins.
  const div = await mkDiv("Swiss");
  const swiss = (await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: ROUNDS } })).data!;
  await apiJson(request, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: CUT }] }], placement: "rank_order", timing: "on_complete" } });
  const added = await addEntrantsViaApi(request, div.id, ["Ada", "Bo", "Cy", "Di"].map((n) => `${n} ${TAG}`));
  await apiJson(request, `/api/v1/divisions/${div.id}/start`, "POST");
  const fixturesOf = async () => ((await apiJson<Fx[]>(request, `/api/v1/divisions/${div.id}/fixtures`)).data ?? []).filter((f) => f.stage_id === swiss.id);
  for (let round = 1; round <= 2; round++) {
    await apiJson(request, `/api/v1/stages/${swiss.id}/generate`, "POST");
    await expect.poll(async () => (await fixturesOf()).filter((f) => f.round_no === round).every((f) => f.home_entrant_id && f.away_entrant_id), { timeout: 20_000 }).toBe(true);
    for (const f of await fixturesOf()) if (f.round_no === round && !["decided", "finalized"].includes(f.status)) await scoreFixture(request, f.id, 2, 0);
  }

  // 2. Groups (2 pools × 3) → KO top 1 per group, round 1 of each pool played.
  const poolDiv = await mkDiv("Pools");
  const groups = (await apiJson<{ id: string }>(request, `/api/v1/divisions/${poolDiv.id}/stages`, "POST", { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } })).data!;
  await apiJson(request, `/api/v1/divisions/${poolDiv.id}/stages`, "POST", { seq: 2, kind: "knockout", name: "KO", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }], placement: "rank_order", timing: "on_complete" } });
  await addEntrantsViaApi(request, poolDiv.id, ["P1", "P2", "P3", "P4", "P5", "P6"].map((n) => `${n} ${TAG}`));
  await apiJson(request, `/api/v1/divisions/${poolDiv.id}/start`, "POST");
  const poolFx = ((await apiJson<Fx[]>(request, `/api/v1/divisions/${poolDiv.id}/fixtures`)).data ?? []).filter((f) => f.stage_id === groups.id);
  for (const f of poolFx.filter((f) => f.round_no === 1)) await scoreFixture(request, f.id, 2, 0);

  // 3. Regression: a league with NO next stage renders exactly as before.
  const plain = await mkDiv("Plain");
  await apiJson(request, `/api/v1/divisions/${plain.id}/stages`, "POST", { seq: 1, kind: "league", name: "League", config: {} });
  await addEntrantsViaApi(request, plain.id, ["L1", "L2", "L3"].map((n) => `${n} ${TAG}`));
  await apiJson(request, `/api/v1/divisions/${plain.id}/start`, "POST");
  const plainFx = (await apiJson<Fx[]>(request, `/api/v1/divisions/${plain.id}/fixtures`)).data ?? [];
  await scoreFixture(request, plainFx[0]!.id, 2, 0);

  scene = {
    orgSlug, compSlug: comp.slug, divSlug: div.slug, divisionId: div.id, swissId: swiss.id, poolDivSlug: poolDiv.slug, plainDivSlug: plain.slug,
    names: Object.fromEntries(added.ids.map((id, i) => [id, `${["Ada", "Bo", "Cy", "Di"][i]} ${TAG}`])),
  };
  await ctx.close();
});
test.afterAll(async () => { await closeOpenContexts(); });

/** Expected per-entrant status kind, from the engine over the organiser API's rows. */
async function expected(request: import("@playwright/test").APIRequestContext): Promise<Record<string, string>> {
  const st = (await apiJson<{ rows: { entrantId: string; points: number; played: number }[] }>(request, `/api/v1/stages/${scene.swissId}/standings`)).data!;
  const perMatch = generic.matchPointsBounds(generic.configSchema.parse({ resultMode: "score", allowDraws: true, ...CFG }));
  const res = qualificationStatus({
    rows: st.rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
    remaining: new Map(st.rows.map((r) => [r.entrantId, ROUNDS - r.played])),
    perMatch, cut: CUT, anyPlayed: true, complete: false,
  })!;
  return Object.fromEntries([...res].map(([id, r]) => [id, r!.status.kind]));
}

/** marker kind per entrant as the PAGE renders it, keyed by the row's name cell. */
async function markers(page: Page, rowSel: string, nameSel: string): Promise<Record<string, string>> {
  return page.locator(rowSel).evaluateAll((trs, nameSel) => Object.fromEntries(trs.map((tr) => [
    tr.querySelector(nameSel)?.textContent?.trim() ?? "", tr.querySelector("[data-qual-marker]")?.getAttribute("data-qual-marker") ?? "none",
  ])), nameSel);
}
const byName = (exp: Record<string, string>) => Object.fromEntries(Object.entries(exp).map(([id, k]) => [scene.names[id]!, k]));

test("division page: markers equal the engine, the line sits after place 2, the leader is NOT Through (R4)", async ({ browser, request }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(`/shared/${scene.orgSlug}/${scene.compSlug}/${scene.divSlug}?tab=standings`);
  const panel = page.locator("#panel-standings");
  await expect(panel.getByTestId("qual-cut")).toHaveCount(1);
  const exp = byName(await expected(request));
  expect(await markers(page, '#panel-standings [role="region"] > table > tbody > tr[data-qual]', 'th[scope="row"]')).toEqual(exp);
  expect(Object.values(exp)).toContain("win_k"); // the differential is present in the scene
  expect(Object.values(exp)).not.toContain("through");
  // the cut row is the THIRD tr (after places 1 and 2)
  const rowsBefore = await panel.locator('[role="region"] > table > tbody > tr').evaluateAll((trs) => trs.findIndex((tr) => tr.getAttribute("data-testid") === "qual-cut"));
  expect(rowsBefore).toBe(CUT);
  await expect(panel.getByTestId("qual-legend")).toContainText(dictString("en", "table.qual.legend.open"));
  await expect(panel.getByTestId("qual-cut")).toContainText(dictString("en", "table.qual.cut.one", { n: CUT, next: "Finals", count: 1 }));
});

test("division page: popover content and dismissal", async ({ browser }) => {
  const page = await spectator(browser, { width: 390, height: 844 });
  await page.goto(`/shared/${scene.orgSlug}/${scene.compSlug}/${scene.divSlug}?tab=standings`);
  const trigger = page.getByRole("button", { name: /^Rank 1,/ });
  await trigger.click();
  await expect(page.getByTestId("qual-headline")).toHaveText(dictString("en", "table.qual.headline.winK.one", { next: "Finals" }));
  await expect(page.getByTestId("qual-if-lose")).toBeVisible();
  await page.mouse.click(5, 5); // outside tap
  await expect(page.getByTestId("qual-headline")).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("qual-headline")).toHaveCount(0);
});

test("hub Table tab shows the same markers", async ({ browser, request }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(`/shared/${scene.orgSlug}/${scene.compSlug}?tab=table`);
  await expect(page.getByTestId("mh-tab-panel-table")).toBeVisible();
  const exp = byName(await expected(request));
  expect(await markers(page, `[data-testid^="mh-table-${scene.divSlug}-"][data-testid$="-overall"] tbody tr[data-testid*="-row-"]`, 'th[scope="row"]')).toEqual(exp);
});

test("pools: one cut line per pool, after place 1", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(`/shared/${scene.orgSlug}/${scene.compSlug}/${scene.poolDivSlug}?tab=standings`);
  const regions = page.locator('#panel-standings [role="region"]');
  await expect(regions).toHaveCount(2);
  for (const region of await regions.all()) {
    await expect(region.getByTestId("qual-cut")).toHaveCount(1);
    expect(await region.locator("table > tbody > tr").evaluateAll((trs) => trs.findIndex((tr) => tr.getAttribute("data-testid") === "qual-cut"))).toBe(1);
  }
});

test("regression: a division with no cut renders no marker, line or legend", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  await page.goto(`/shared/${scene.orgSlug}/${scene.compSlug}/${scene.plainDivSlug}?tab=standings`);
  await expect(page.locator('#panel-standings [role="region"] tbody tr')).not.toHaveCount(0); // positive pair: the table IS there
  await expect(page.getByTestId("qual-cut")).toHaveCount(0);
  await expect(page.getByTestId("qual-legend")).toHaveCount(0);
  await expect(page.locator("[data-qual-marker]")).toHaveCount(0);
});

test("console parity (R1a): the organiser sees the public markers", async ({ page, browser }) => {
  // `page` carries the project's signed-in organiser storageState.
  await page.goto(`/o/${scene.orgSlug}/c/${scene.compSlug}/d/${scene.divSlug}?tab=standings`);
  const consoleMarkers = await markers(page, '[role="region"] > table > tbody > tr[data-qual]', 'th[scope="row"]');
  const pub = await spectator(browser, { width: 1280, height: 900 });
  await pub.goto(`/shared/${scene.orgSlug}/${scene.compSlug}/${scene.divSlug}?tab=standings`);
  expect(consoleMarkers).toEqual(await markers(pub, '#panel-standings [role="region"] > table > tbody > tr[data-qual]', 'th[scope="row"]'));
  await expect(page.getByTestId("qual-cut")).toHaveCount(1);
});

for (const width of WIDTHS) {
  test(`width ${width}: no page scroll, rank trigger hit area ≥ 40px`, async ({ browser }) => {
    const page = await spectator(browser, { width, height: 900 });
    await page.goto(`/shared/${scene.orgSlug}/${scene.compSlug}/${scene.divSlug}?tab=standings`);
    await expectNoHorizontalScroll(page);
    const trigger = page.getByRole("button", { name: /^Rank 1,/ });
    const hit = await trigger.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const inside = (x: number, y: number) => el.contains(document.elementFromPoint(x, y));
      return { centre: inside(cx, cy), w: b.width, h: b.height, left: inside(cx - 19, cy), right: inside(cx + 19, cy), up: inside(cx, cy - 19), down: inside(cx, cy + 19) };
    });
    expect(hit.centre).toBe(true);
    if (width < 768) expect([hit.left, hit.right, hit.up, hit.down]).toEqual([true, true, true, true]);
    await trigger.click();
    await expectNoHorizontalScroll(page); // an open popover must not widen the page
  });
}
```

(Check `activeOrgSlug`'s return shape (`MintedOrg`) and `addEntrantsViaApi`'s `{ ids }` in their files before running. The organiser `apiJson` calls ride the context's storageState. That is why `browser.newContext()` is used for seeding, as `withdrawn-entrant-public-board.spec.ts` does.)

- [ ] **Step 2: Run the spec against a local prod server**

Per `seazn-local-env`: fresh DB (`db:apply` + `sync:sports`), prod build of THIS worktree (confirm the chunk hash is this tree's, not a turbo cache hit from another worktree), server on localhost. Then:
`cd /Users/ashokhein/github/seazn.club-wt-qualstatus/apps/web && PLAYWRIGHT_BASE=http://localhost:<port> pnpm exec playwright test e2e/standings-qualification.spec.ts --reporter=list; echo EXIT=$?`
Expected: all pass. Run it three times (a flaky-shaped gate is believed only after three greens, AGENTS.md #8). On a timeout-shaped red, check whether the poll's own timeout was exceeded before chasing data (AGENTS.md #20).

- [ ] **Step 3: Mutation spot-checks through the browser** — rebuild with each, see red, revert, rebuild: (a) `qualification.ts` through rule `>=` → `>` → the R4 division-page test reds; (b) delete `qualification={…}` from the division page → markers/cut tests red; (c) delete it from the console page → the parity test reds; (d) delete `qualification:` from `competition-hub.ts` → the hub test reds. Record the killers. Never leave a mutated build serving: rebuild clean and re-run Step 2 after the last one.

- [ ] **Step 4: Regression — whole files, never `-g`**

Find every spec that touches standings by BEHAVIOUR (AGENTS.md #16): `grep -arln 'panel-standings\|mh-table-\|role="region"\] > table\|tab=standings\|tab=table\|standings-withdrawn' apps/web/e2e`. Run each file it lists whole, plus `e2e/mobile.spec.ts` whole (all seven width projects). mobile.spec is serial, so a red count is a floor: fix, then re-run until a full pass completes. Paste the per-file pass/fail counts into the task report.

- [ ] **Step 5: Smoke** — add `publicQualificationStandingsSuite()` to `scripts/smoke.ts`, called right after `publicWithdrawnStandingsSuite()` (`:~971`) and defined beside it (`:~8497`). It uses the same fresh free session, a public generic Swiss with 4 entrants and 3 rounds, a Finals KO `rankRange 1..2`, round 1 scored through the API, and the public division HTML via `html(newSession(), …?tab=standings)`. It checks: (1) the page is 200 and carries exactly one `data-testid="qual-cut"`; (2) four `data-qual-marker="` attributes (anchored on `="`); (3) a plain-league sibling division's page carries zero of each. The HTML is the only thing smoke can read. Run: `cd /Users/ashokhein/github/seazn.club-wt-qualstatus && BASE=http://localhost:<port> pnpm test:smoke 2>&1 | tail -40; echo EXIT=$?` and read the check lines for this suite. If smoke has its own filter mechanism, prefer running the full smoke once before the PR anyway: smoke runs on PRs, and this PR must go green there.

- [ ] **Step 6: Visual sign-off, per screen**

Cropped screenshots (never full-page; they dominate context) of: division standings, hub Table tab and console standings, each at 1280, 768 and 320, each with (a) popover closed and (b) the rank-1 popover open, plus the pools page at 320. Confirm the images exist and DIFFER between open and closed (AGENTS.md #10). Write one verdict line per screen: what you SAW (marker shapes, cut label wrapping, legend wrap, muted Out row, popover inside the viewport), not what should be there. Store the images outside the repo, in the scratchpad, and list their paths in the PR body.

- [ ] **Step 7: Final gates, then the one PR**

1. Migration tail re-check (Task 4 Step 1). Renumber if `main` moved.
2. Full engine suite, and the web unit suite from `apps/web` (never `--root`): `cd /Users/ashokhein/github/seazn.club-wt-qualstatus/apps/web && pnpm exec vitest run --reporter=json --outputFile=/private/tmp/claude-501/qual-final.json`. Read `numFailedTests` and confirm `.testResults[].name` paths are this worktree's. Web and engine typecheck. Lint via `rtk proxy`. `pnpm i18n:gen-keys && git diff --exit-code apps/web/src/lib/i18n-keys.ts`. `pnpm i18n:check`. `pnpm openapi:gen && git status --porcelain` empty.
3. A final reviewer pass over the whole branch diff (`git diff origin/main...HEAD`), which includes the popover commits. Fix its findings, then re-run 2.
4. Push and open ONE PR from `feat/standings-qualification-status` → `main`. **Do not open a separate PR for the popovers.** This branch already contains their commits. Body sections: *Popovers* (a summary of the `feat/standings-popovers` commits, written from their own commit messages), *Qualification status* (rulings R1–R8/R1a honoured, the premises table from this plan in short, Review Focus 1–5 and where each is pinned), *Migration V414*, *Tests* (raw counts: engine, web unit, e2e per file, smoke), *Screens* (the per-screen verdicts and image paths), *Open questions* (below). End the body with:
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
   e2e does not run on PRs (`e2e.yml` triggers on push to `main` and `workflow_dispatch` only; re-read the file). Trigger `workflow_dispatch` with the `pr` input if the owner wants CI e2e before merge, and say so in the PR.

---

## Open questions (for the owner; recommendation first)

1. **What-if reach (P6).** With the shipped default cascades, a target almost never appears: `wins` sits between points and the ratios in badminton, volleyball, table tennis, carrom and cricket, and football's default puts head-to-head second. **Recommendation:** ship Phase 1 as ruled (R5 literal). Players then see "set ratio decides" with both values, which is still more than today. Decide separately whether `wins` should be looked THROUGH when both rows would finish level on wins too, and whether `game_ratio` joins R5's list. The owner gets a target on the sports that motivated it, at the cost of one more rule to prove never-wrong.
2. **`points_rule` on `public_stages_v` (P4).** A fifth column the spec did not list. **Recommendation:** accept it. Without it, a custom-points stage would either show no status or risk a wrong one, and the rule is already visible through the points the table prints.
3. **Preview (Overview teaser) legend.** The plan shows markers and the cut line in the hub's preview but omits the legend (Task 8 Step 3). **Recommendation:** keep it that way. The teaser is a glance and the full tab carries the key. Revisit if the screenshots read as unexplained dots.

## Self-review (run against the spec, 2026-09-22)

- **Spec coverage:** §3.1–3.3 → Tasks 1, 2, 5; §3.4 → Tasks 3, 5; §4.1 migration/read/builder/caching → Tasks 4, 5, 6; §4.2 surfaces → Tasks 7 (division, embed), 8 (hub), 9 (console); §5 UI (marker, cut, legend, popover order, 40px, no page scroll, 4 locales) → Tasks 5, 7, 8, 10; §6 tests (engine unit, brute force, mutations, what-if differential, web unit, e2e public/hub/pools/7 widths, console, regression, smoke, visual) → Tasks 2, 3, 5, 10; §7 sequencing (amended to one PR) → Task 7 Step 1, Task 10 Step 7; §8 out of scope is untouched.
- **Placeholders:** the only deliberate "adapt" points are the popover's real props (unknowable until the rebase, with an explicit assumed interface) and existing test helper names (`baseInput`). Each names the file to read.
- **Type consistency:** `MatchPointsBounds` {max,min,winFloor,lossCeil} is used identically in Tasks 1, 2, 5. `QualificationInput`/`QualRowResult`/`tieRival` match between Tasks 2 and 5. `TieWhatIf` kinds `target|safe|rule` match between Tasks 3 and 5. `QualRowT`/`QualTableT` field names (`status,label,ariaLabel,headline,ifYouLose,whatIf,whatIfAssumption`; `cutIndex,label,legend`) match between Tasks 5–8. `stageQualMeta` column names match the SQL function's.
- **Review Focus:** all five are pinned (Task 2 for 2; Task 4 for 5; Task 5 for 1–5).
