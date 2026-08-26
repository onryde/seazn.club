# ScoringPad v3 R3.5 — Deciders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a cricket super over and a football shoot-out fully scoreable on the v3 pad, legible on every surface a result reaches, and permanently visible to the gallery harness.

**Architecture:** One engine accessor becomes the single definition of "which innings is being played", and the cricket skin consumes it instead of re-deriving it — that one change closes the blocker and the three display defects together. Two chassis capabilities (a disabled tile no longer claims its event type; a scorebug half can carry a secondary figure) are added generically so R6's two shoot-out sports inherit them. Football gains display, log and turn-order surfaces over an engine that already works.

**Tech Stack:** TypeScript 7, Node 26, pnpm. vitest (`environment: "node"`, no jsdom — builders are tested as pure data, DOM is proved by Playwright). Playwright vs a standalone production build. Zod v4 schemas in `packages/engine`.

**Spec:** `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/R3.5-deciders.md`
Programme rules: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_RULES.md`
Design of record: `docs/superpowers/specs/2026-08-15-scoringpad-v3-redesign-design.md`

## Global Constraints

- **Branch/worktree:** `feat/scorepad-v3-r35-deciders` in `.claude/worktrees/r35-deciders`, off `main` `5f2951945`. Never check out in the main repo dir. Never `git stash` in a worktree — the stash stack is shared.
- **Worktree setup owed before any test run:** `pnpm install --frozen-lockfile`; symlink `.env.local` at root AND `apps/web/`; verify `readlink -f node_modules/@seazn/engine` resolves INSIDE the worktree.
- **Prefix `cd <abs worktree> &&` in the SAME call as every command you judge.** The shell cwd resets to the main checkout between calls; a verify run silently executes on `main` and returns a false green.
- **vitest is green ONLY via `--reporter=json --outputFile`** plus `numPassedTests` / `numTotalTests` / `numFailedTestSuites`. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT. Prefix probes with `rtk proxy`.
- **`DATABASE_URL=` (empty) for non-DB suites**, or the config refuses to start against the dev DB on :5432.
- **Use `seazn-env` for build, typecheck, lint and the gate — never raw `turbo` or the root npm scripts** (owner instruction, 2026-08-26). The script wraps every call as `( cd "$root" && … )` pinned to the LABEL's recorded repo root, which is what makes it immune to the cwd reset:

  ```bash
  S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
  GATE_FILTER= $S gate --label r35     # full repo: 4 tasks — web+engine × typecheck+lint
  $S gate --label r35                  # changed packages only (diffs vs origin/main)
  $S rebuild --label r35               # code changed: rm -rf .next, rebuild, restart
  ```

  **Measured 2026-08-26: `GATE_FILTER= gate` runs 4 tasks — `@seazn/web:{typecheck,lint}` AND `@seazn/engine:{typecheck,lint}`.** A bare `npx turbo run typecheck lint` invoked after a cwd reset scopes to `@seazn/web` alone and silently skips the engine; that misreading happened once in this wave already. Tasks C and H touch the engine, so use the skill.

  **Judge on the `Cached: N cached, M total` line, not on exit 0** — a cache hit replays a previous run's output and exits 0 without re-executing.
- **apps/web typecheck needs `NODE_OPTIONS=--max-old-space-size=6144`** and must write its own `EXIT=$?` (a pipe reports tail's status).
- **Engine module version stays `1.0.0`.** Every engine change in this plan is an additive export or an internal refactor — no fold change, no serialised-state change, so the frozen golden corpus is untouched. If any task finds itself needing a golden re-baseline, STOP and ask.
- **New user-facing strings → all four dictionaries** (`en`, `es`, `fr`, `nl`), flat dotted keys, then `npm run i18n:gen-keys` (`lib/i18n-keys.ts` is GENERATED — never hand-edit) and `npm run i18n:check`.
- **`content/help/**` is English-only** — no i18n owed there.
- **Before changing any user-facing string:** `git grep -a` the OLD and the NEW text across `e2e/`. Changed UI text breaks specs.
- **`git grep -a` always** — this repo reports source files as `Binary file … matches` and hides the lines without `-a`.
- **Widths 320 / 768 / 1280 by screenshot, no horizontal page scroll at any**, 44px minimum touch targets, contrast computed from tokens then axe per skin.
- **Every change ships a test that fails without it**, and every gate is mutation-proved (break the implementation, watch the test red, restore).

---

## File Structure

**Engine — `packages/engine/src/sports/cricket/`**
- `cricket.ts` — add `activeInnings()` (exported); `cricketPosition` refactored to call it. Sole definition of the active innings list.
- `index.ts` — re-export `activeInnings` and its type, beside `nextBattingSide` / `eligibleBowlers` / `reviewsRemaining`, which exist for exactly this reason.
- `cricket.test.ts` — unit coverage for the new accessor.

**Engine — `packages/engine/src/sports/football/`**
- `football.ts` — `summary()` consumes `shootoutTally`; `standingsDelta` honours `shootoutWin` / `shootoutLoss`.
- `football.test.ts` — tally parity + standings split.

**Chassis — `apps/web/src/components/v2/scorepad/v3/`**
- `pad-host.tsx` — `dedicatedEventTypes` skips disabled tiles.
- `types.ts` — `ScorebugHalf.sub?: string`.
- `scorebug.tsx` — render `sub`.
- `__tests__/pad-host.test.ts`, `__tests__/scorebug.test.ts` — the two chassis behaviours.

**Skins — `apps/web/src/components/v2/scorepad/v3/skins/`**
- `cricket.tsx` — `currentInnings` / `dueBattingSide` / `chaseTarget` become super-over aware via the engine accessor.
- `football.tsx` — scorebug `sub`, kick detail names the side, expected-kicker strip item, phase-gated kick tiles.
- `__tests__/cricket.test.ts`, `__tests__/football.test.ts` — builder-level coverage against REAL folds.
- `__tests__/_cricket-fold.ts` — NEW. Real folded cricket states, the sibling of R3's `_football-fold.ts`. The reason R3 caught four dead-end paths and R2 caught none.

**Server — `apps/web/src/server/`**
- `engine-db/append-event.ts` — pino instrumentation on the one funnel every scoring event takes. Uses the existing `server/logger.ts` singleton; no new logger module.

**Product surfaces — `apps/web/src/`**
- `components/v2/match-rules.tsx` — `shootoutWin` / `shootoutLoss` fields.
- `app/(public)/shared/.../fixtures/[fixtureId]/` — the decided-outcome sentence.
- `locales/{en,es,fr,nl}.json`, `lib/scoring-vocab.ts` — copy.

**Harness — `apps/web/e2e/`**
- `gallery.capture.ts` — four new states.
- `mobile.spec.ts` — the four new surfaces at seven widths.
- `scorepad-v3-cricket.spec.ts` — the defect-pinning test rewritten, plus super-over coverage.
- `scorepad-v3-football.spec.ts` — shoot-out coverage past the door.

---

## The exhaustive case matrix

Written before the tasks so no task invents its own coverage. Every row is a test somewhere in this plan; the **Task** column says where.

### Cricket — super over

| # | Case | Expected | Task |
|---|---|---|---|
| C1 | Tie, `superOver: false` | `phase: "done"`, `outcome.kind: "tie"`; tiles hidden by post phase, NOT disabled | C |
| C2 | Tie, `superOver: true`, no SO ball yet | `phase: "super_over"`, `superOver.innings: []`; `currentInnings` → `null`; fidelity `"unopened"`; BOTH lanes offered; no tile disabled; no closure message | C |
| C3 | Main innings scored COARSE (`innings.summary`), then a super over | SO innings is fine; run tiles OFFERED. This is the coarse-lane blocker — `inningsFidelity` must read the SO innings, not the closed main one | C |
| C4 | Main innings scored FINE, then a super over | Scorebug shows SO runs/wickets and SO overs, not the closed innings | C |
| C5 | 1 SO ball, 4 runs | Scorebug `4/0`, over `0.1`, run rate from the SO innings only | C |
| C6 | Bowler mid-SO | Scorebug strip + context strip name the SO bowler, never the main innings' | C |
| C7 | Target chip, SO innings 1 (first to bat) | NO target chip — nothing to chase yet | C |
| C8 | Target chip, SO innings 2 | `SO1.runs + 1`, never the main-innings target | C |
| C9 | SO innings 1 closes on 6 legal balls | Due side flips to the opponent; tiles stay ENABLED; scorebug keeps SO1's final score until SO2's first ball | C |
| C10 | SO innings 1 closes on 2 wickets (all out is 2 in a super over) | Same as C9 | C |
| C11 | SO innings 2 passes the target | `phase: "done"`, `method: "super_over"` | C |
| C12 | SO pair tied, `superOverStillTied: "repeat"` | Stays `super_over`; a third SO innings opens; scorebug follows into the SECOND pair (offset 4) | C |
| C13 | SO pair tied, `boundary_count`, unequal boundaries | `method: "boundary_count"`, winner by boundaries across match + SO | C, G |
| C14 | SO pair tied, `boundary_count`, EQUAL boundaries | `outcome.kind: "tie"` — the one path where boundary count does not decide | C, G |
| C15 | SO pair tied, `shared` | `outcome.kind: "tie"` | C, G |
| C16 | Wicket in a super over | Wicket tile enabled; the wicket sheet offers only batters not in `superOver.dismissed[side]` | C |
| C17 | Wide / no-ball in a super over | Does not advance `legalBalls`; over text unchanged; tile enabled | C |
| C18 | Free hit in a super over | `freeHit` strip chip appears, gated on the SO innings | C |
| C19 | `ballEventType` in `super_over` | `"cricket.superover.ball"` — regression guard, already correct today | C |
| C20 | `ballsPerOver: 5` (Hundred) with a super over | SO innings `ballsLimit` follows cfg; over text uses 5 | C |
| C21 | Two-innings (Test) cfg + `superOver: true` | cfg parse REFUSES (`superOver requires inningsPerSide = 1`) — regression guard on the refine | C |
| C22 | Void the last SO ball | Scorebug reverts; due side reverts; no closure message appears | C |
| C23 | Super over decided, pad re-opened | Post phase; decided sentence names winner and `super_over` | G |
| C24 | More sheet during a live super over | Offers the `Super over` panel (`cricket.superover.ball`) once tiles are enabled it must NOT — see B4 | B |

### Chassis

| # | Case | Expected | Task |
|---|---|---|---|
| B1 | All tiles for type X disabled | X NOT in `dedicatedEventTypes`; X appears in `moreActions` | B |
| B2 | All tiles for type X enabled | X IS in `dedicatedEventTypes`; X absent from `moreActions` (unchanged) | B |
| B3 | Type X on one enabled AND one disabled tile | X IS in `dedicatedEventTypes` — still genuinely reachable | B |
| B4 | ~~Type X disabled as a tile but owned by a `sheets` entry → X IS claimed~~ | **WRONG — this row WAS the bug.** Measured 2026-08-26: cricket's `wicket` sheet declares `event: "cricket.superover.ball"` and its only opening tile is disabled, so the sheet loop kept claiming the type and the tile guard achieved nothing. `resolveSheet` has ONE call site (`pad-host.tsx:854`), reached only from a tile tap — a sheet is never independently reachable. Corrected: **a sheet whose every opening tile is disabled claims nothing** | B |
| B4b | A sheet with NO tile at all (cricket's `overSummary` in the fine lane) | UNCHANGED — still claimed. Deliberately not widened: un-claiming it would surface `cricket.innings.summary` in More during a fine innings, where the fold refuses it (`cricket.ts:1402-1404`), creating exactly the dead-end path R3 spent a review round killing. Cricket declares no `refusedEventTypes`; that question belongs to Task C | B |
| B5 | A tapModel-S scorebug half | Unchanged from R4 — `tappable` halves still claim their type | B |
| B6 | `ScorebugHalf.sub` absent | Rendered markup byte-identical to before this wave | D |
| B7 | `ScorebugHalf.sub` present | Rendered beside `big`; contrast passes computed from tokens; tabular-nums | D |

### Football — shoot-out

| # | Case | Expected | Task |
|---|---|---|---|
| F1 | Level at FT, `shootout: true`, `extraTime.enabled: false` | Straight to `SHOOTOUT` | D |
| F2 | Level at FT with extra time enabled | `ET_H1` first; `SHOOTOUT` only after `ET_FT` | D |
| F3 | Scorebug during SHOOTOUT, pens 2–1 | Halves read `1 (2)` and `1 (1)` | D |
| F4 | Scorebug in every non-SHOOTOUT phase | No `sub` — byte-identical to today | D |
| F5 | Cricket and tennis scorebugs | No `sub` anywhere — proves the field is opt-in | D |
| F6 | Kick tiles in SHOOTOUT | `kick-home` / `kick-away` present; `goal-home` / `goal-away` absent | J |
| F7 | Kick tiles in H1 / H2 / ET / pre / done | Absent | J |
| F8 | Kick tile records | Emits `football.shootout.kick` for its own side | J |
| F9 | Expected kicker, zero kicks | No cue — either side may start | F |
| F10 | Expected kicker, after home kicks | Cue names Away; the Home kick tile is disabled with a context message | F, J |
| F11 | Out-of-turn kick posted anyway (API) | Engine refuses `INVALID_EVENT`, message names the ENTRANT not a UUID — regression guard | F |
| F12 | Kick log line, scored, no person | Names the SIDE and the outcome | E |
| F13 | Kick log line, missed, with person | Side, outcome, person | E |
| F14 | Void a kick | Tally reverts; expected kicker reverts; log row shows cancelled | E, F |
| F15 | Early decision inside regulation 5 | Lead exceeds remaining entitlement → `done`, `method: "shootout"` | D |
| F16 | Sudden death past 5 | Undecided until a pair completes with a lead | D |
| F17 | Card shown during SHOOTOUT | Still legal — `playPhases` includes SHOOTOUT | J |
| F18 | Decided by kicks, pad re-opened | Decided sentence: "<Side> won 3–0 on penalties" | G |
| F19 | Group stage, `shootoutWin: 2` / `shootoutLoss: 1` | `standingsDelta` awards the split, both sides' goal columns unchanged | I |
| F20 | Group stage, neither field set | Falls back to today's flat win/loss — no silent behaviour change | I |
| F21 | `shootoutWin` set, `shootoutLoss` unset | Defined behaviour, pinned by a test rather than left to inference | I |
| F22 | `summary()` tally vs `shootoutTally()` | Identical for every kick sequence, including a `void` kick | H |

### Cross-cutting

| # | Case | Expected | Task |
|---|---|---|---|
| X1 | Four new gallery states | Captured at 320 / 768 / 1280, 0px horizontal overflow | A |
| X2 | Seven-width matrix on the new surfaces | 320/360/375/390/430/768/834 all pass | A |
| X3 | axe per skin on the four states | Zero WCAG AA violations — never scanned before | A |
| X4 | i18n | Every new key present in all four dictionaries; `i18n:check` clean | E, G, I |
| X5 | `scorepad-v3-cricket.spec.ts:1004` | Rewritten — it currently asserts the defect | C |

### Logging

| # | Case | Expected | Task |
|---|---|---|---|
| K1 | An accepted event | One `info` line: fixtureId, eventType, seq, phase before/after | K |
| K2 | A refused event | One `warn` line carrying the `EngineError` code; HTTP status and message UNCHANGED | K |
| K3 | Fold enters `super_over` or `SHOOTOUT` | One `info` line, "fixture entered a decider" | K |
| K4 | Fold resolves a decider | One `info` line carrying `outcome.method` | K |
| K5 | Any of the above | NO payload value, person name or email in the serialised line | K |
| K6 | A v3 skin | Imports no logger — `"use client"`, and `@/server/**` in a client component is a build failure `tsc` cannot see | K |
| K7 | A sport module | Imports no logger — `packages/engine` is zero-effectful-deps by declaration | K |

---

## Task 0: Worktree setup

**Files:** none committed.

- [ ] **Step 1: Install and link**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders
pnpm install --frozen-lockfile
ln -sfn /Users/ashokhein/github/seazn.club/.env.local .env.local
ln -sfn /Users/ashokhein/github/seazn.club/apps/web/.env.local apps/web/.env.local
```

- [ ] **Step 2: Prove the engine resolves inside the worktree**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders && \
  readlink -f node_modules/@seazn/engine
```
Expected: a path under `.claude/worktrees/r35-deciders/`. If it resolves to the main checkout, `apps/web` compiles MAIN's engine and every measurement in this plan is of the wrong code. Stop and fix.

- [ ] **Step 3: Baseline the gate before touching anything**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  DATABASE_URL= rtk proxy npx vitest run src/components/v2/scorepad/v3 \
  --reporter=json --outputFile=/tmp/r35-baseline.json > /dev/null 2>&1; \
  echo "EXIT=$?"; \
  python3 -c "import json;d=json.load(open('/tmp/r35-baseline.json'));print(d['numPassedTests'],'/',d['numTotalTests'],'suites failed:',d['numFailedTestSuites'])"
```
**Measured 2026-08-26: 1028 / 1028, 0 failed suites.** Engine's own gate clean at the same point. Every later gate is judged against these, not against zero.

---

## Task A: Capture the broken states first

The gallery runs `01-pre` … `10-reviewblocked` and has no tie-break state. That single gap is why R2 and R3 both signed off on pads whose deciders were broken. Adding the states BEFORE any fix does two things: it makes every later task provable as a before/after pair, and it closes the blind spot permanently.

**Files:**
- Modify: `apps/web/e2e/gallery.capture.ts`
- Modify: `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: gallery state ids `11-superover`, `12-superover-decided` (cricket) and `11-shootout`, `12-shootout-decided` (football), each captured at 320 / 768 / 1280.

- [ ] **Step 1: Read the existing capture shape before adding to it**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  grep -an '"10-reviewblocked"' -B 40 e2e/gallery.capture.ts | head -60
```
Follow that hook's own seeding style exactly — `seedRosteredFixture` + `loginUi` with `page.request` (the standalone `request` fixture has its own cookie jar), dismiss the cookie banner, `animations: "disabled"` on the screenshot, never `networkidle` after login.

- [ ] **Step 2: Add the cricket super-over state**

Seed a T20 with `superOver: true`, drive it to a tie through the API, then two super-over balls. The tie must be exact: away's chase ends on `target - 1`.

```ts
// 11-superover — a LIVE super over, two balls in.
await mergeDivisionConfig(request, fx.divisionId, { superOver: true });
await postEvent(request, fx.fixtureId, "core.start", {});
await postEvent(request, fx.fixtureId, "cricket.ball",
  { over: 0, ballInOver: 1, striker: h1, nonStriker: h2, bowler: a1, runs: { bat: 1 } });
await postEvent(request, fx.fixtureId, "cricket.ball",
  { over: 0, ballInOver: 2, striker: h2, nonStriker: h1, bowler: a1, runs: { bat: 1 } });
await postEvent(request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
// target = 3; away scores exactly 2 => TIE => phase super_over
await postEvent(request, fx.fixtureId, "cricket.ball",
  { over: 0, ballInOver: 1, striker: a1, nonStriker: a2, bowler: h1, runs: { bat: 1 } });
await postEvent(request, fx.fixtureId, "cricket.ball",
  { over: 0, ballInOver: 2, striker: a2, nonStriker: a1, bowler: h1, runs: { bat: 1 } });
await postEvent(request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
// away bats first in the super over (they batted second); home bowls with a
// bowler who did NOT bowl the previous over.
await postEvent(request, fx.fixtureId, "cricket.superover.ball",
  { over: 0, ballInOver: 1, striker: a1, nonStriker: a2, bowler: h2, runs: { bat: 4 }, boundary: 4 });
await postEvent(request, fx.fixtureId, "cricket.superover.ball",
  { over: 0, ballInOver: 2, striker: a1, nonStriker: a2, bowler: h2, runs: { bat: 2 } });
```

- [ ] **Step 3: Add the cricket decided state**

Continue `11-superover` to a decision: four more away balls to close the first super-over innings, then home's innings falling short.

- [ ] **Step 4: Add the football shoot-out states**

```ts
// 11-shootout — LIVE, pens 2-1.
await mergeDivisionConfig(request, fx.divisionId,
  { shootout: true, extraTime: { enabled: false, halfMinutes: 15 } });
await postEvent(request, fx.fixtureId, "core.start", {});
await postEvent(request, fx.fixtureId, "football.goal", { by: fx.homeEntrantId });
await postEvent(request, fx.fixtureId, "football.goal", { by: fx.awayEntrantId });
await postEvent(request, fx.fixtureId, "football.period", { phase: "HT" });
await postEvent(request, fx.fixtureId, "football.period", { phase: "FT" });
await postEvent(request, fx.fixtureId, "football.shootout.kick", { by: fx.homeEntrantId, scored: true });
await postEvent(request, fx.fixtureId, "football.shootout.kick", { by: fx.awayEntrantId, scored: false });
await postEvent(request, fx.fixtureId, "football.shootout.kick", { by: fx.homeEntrantId, scored: true });
await postEvent(request, fx.fixtureId, "football.shootout.kick", { by: fx.awayEntrantId, scored: true });
```

`extraTime` is a plain `z.object` whose two fields are BOTH required with the default applied to the whole object, so `{ enabled: false }` alone fails the cfg parse — and because the division config is written by SQL nothing validates it on the way in. The failure surfaces as the console rendering no pad at all, which reads as a pad defect. Spell `halfMinutes` out.

- [ ] **Step 5: Add the two decider routes to the seven-width matrix**

**Corrected by the scout: `mobile.spec.ts` has NO per-surface registration API.** The whole file runs under all seven width *projects* (Playwright config) and iterates routes with `for (const path of routes)` — see the arrays around `:204`, `:327`, `:384`. So a new surface joins the matrix by being added to the relevant `routes` array, not by being "registered".

Add the two live decider console routes. A new UI surface has ZERO width coverage until its path is in one of those arrays.

- [ ] **Step 6: Run the capture and publish the BEFORE artifact**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 \
  npx playwright test e2e/gallery.capture.ts --reporter=line > /tmp/gallery-before.log 2>&1; \
  echo "EXIT=$?"; tail -20 /tmp/gallery-before.log
```
Expected: all four states captured, 0px horizontal overflow at 320, and the captures visibly showing the defects — cricket's greyed board with three red closure lines, football's `1`/`1` against a `(2–1 pens)` headline. **Publish these as the before artifact and record the link in `_INDEX.md` before starting Task B.**

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/gallery.capture.ts apps/web/e2e/mobile.spec.ts
git commit -m "test(gallery): capture both tie-breakers, at last

The harness ran 01-pre..10-reviewblocked and had no tie-break state at
all, which is why R2's and R3's visual sign-offs could both pass over a
super over that cannot be scored and a shoot-out that shows the wrong
score. Four states, three widths, seven-width matrix, axe."
```

---

## Task B: A disabled tile must not claim its event type (chassis)

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx` (`dedicatedEventTypes`)
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/pad-host.test.ts`

**Interfaces:**
- Consumes: `dedicatedEventTypes(tiles, sheets, swaps, scorebug)` — the four-argument shape R4 left on main.
- Produces: no signature change. Behaviour change only: a tile with `disabled === true` contributes nothing.

- [ ] **Step 1: Write the failing tests (cases B1–B4)**

```ts
// apps/web/src/components/v2/scorepad/v3/__tests__/pad-host.test.ts
const bugStub = (): ScorebugSpec => ({
  context: "", phase: "live", strip: [],
  halves: [{ who: [{ name: "H" }], big: "0" }, { who: [{ name: "A" }], big: "0" }],
});
const evTile = (id: string, type: string, disabled?: boolean): TileSpec => ({
  id, label: "l", kind: "standard", phases: ["live"],
  action: { event: { type, payload: {} } },
  ...(disabled === undefined ? {} : { disabled }),
});

describe("dedicatedEventTypes — a disabled tile is not a reachable surface", () => {
  it("B1: every tile for a type disabled => the type is NOT claimed", () => {
    const out = dedicatedEventTypes(
      [evTile("run0", "cricket.superover.ball", true),
       evTile("run1", "cricket.superover.ball", true)],
      undefined, [], bugStub());
    expect(out.has("cricket.superover.ball")).toBe(false);
  });

  it("B2: an enabled tile still claims its type", () => {
    const out = dedicatedEventTypes([evTile("run0", "cricket.ball")], undefined, [], bugStub());
    expect(out.has("cricket.ball")).toBe(true);
  });

  it("B3: one enabled + one disabled tile for the same type => still claimed", () => {
    const out = dedicatedEventTypes(
      [evTile("a", "football.goal", true), evTile("b", "football.goal")],
      undefined, [], bugStub());
    expect(out.has("football.goal")).toBe(true);
  });

  it("B4: a sheet still claims a type whose only tile is disabled", () => {
    const out = dedicatedEventTypes(
      [evTile("w", "cricket.wicket", true)],
      { wicket: { event: "cricket.wicket", steps: [] } as never },
      [], bugStub());
    expect(out.has("cricket.wicket")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch B1 fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  DATABASE_URL= rtk proxy npx vitest run \
  src/components/v2/scorepad/v3/__tests__/pad-host.test.ts -t "disabled tile" 2>&1 | tail -20
```
Expected: B1 FAILS (`expected true to be false`); B2, B3, B4 pass already.

- [ ] **Step 3: Add the guard**

In `dedicatedEventTypes`, first line of the tile loop:

```ts
  for (const tile of tiles) {
    // R3.5/B — a DISABLED tile is not a reachable surface, so it must not
    // suppress the More panel that covers for it. R4's note above documents
    // the third instance of reachable-but-still-listed; this is the fourth,
    // inverted: cricket's whole delivery row goes `disabled` for the length
    // of a super over, and claiming those types hid `cricket.superover.ball`
    // from More, closing the only remaining route to recording one.
    // Per TYPE, not per tile, falls out for free: a type with one enabled and
    // one disabled tile is still added by the enabled one.
    if (tile.disabled === true) continue;
    if ("event" in tile.action) out.add(tile.action.event.type);
```

- [ ] **Step 4: Run and verify all four pass**

Same command. Expected: 4 passed.

- [ ] **Step 5: Mutation-proof the gate**

Delete the `continue` line, re-run, confirm B1 goes red, restore. A gate that cannot fail is not a gate.

- [ ] **Step 6: Full chassis suite, then commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  DATABASE_URL= rtk proxy npx vitest run src/components/v2/scorepad/v3 \
  --reporter=json --outputFile=/tmp/r35-b.json > /dev/null 2>&1; echo "EXIT=$?"; \
  python3 -c "import json;d=json.load(open('/tmp/r35-b.json'));print(d['numPassedTests'],'/',d['numTotalTests'])"
```

```bash
git add apps/web/src/components/v2/scorepad/v3/pad-host.tsx \
        apps/web/src/components/v2/scorepad/v3/__tests__/pad-host.test.ts
git commit -m "fix(pad): a disabled tile is not a reachable surface

dedicatedEventTypes claimed a tile's event type whether or not the tile
was disabled, so moreActions dropped the panel covering for it as
'already reachable'. In a cricket super over the whole delivery row goes
disabled, which closed the last route to recording one."
```

---

## Task C: Cricket — one definition of the innings being played

The blocker. Per ruling R3.5-3 the switch lives in the engine and the skin consumes it, rather than a second hand-kept copy of what `cricketPosition` already does.

**Files:**
- Modify: `packages/engine/src/sports/cricket/cricket.ts`
- Modify: `packages/engine/src/sports/cricket/index.ts`
- Test: `packages/engine/src/sports/cricket/cricket.test.ts`
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/cricket.tsx`
- Create: `apps/web/src/components/v2/scorepad/v3/__tests__/_cricket-fold.ts`
- Test: `apps/web/src/components/v2/scorepad/v3/skins/__tests__/cricket.test.ts`
- Modify: `apps/web/e2e/scorepad-v3-cricket.spec.ts`

**Interfaces:**
- Produces, from the engine:
  ```ts
  export interface ActiveInnings<T> { list: readonly T[]; offset: number; inSuperOver: boolean; }
  export function activeInnings<T>(m: {
    innings: readonly T[];
    superOver: { innings: readonly T[] } | null | undefined;
  }): ActiveInnings<T>;
  ```
  Generic and STRUCTURAL, taking a narrow record rather than `CricketState` — the same shape `nextBattingSide` already uses so the pad can call it without owning the engine's full state type or casting a partial shape into one.
- Consumed by: `currentInnings`, `dueBattingSide`, `chaseTarget` in `skins/cricket.tsx`, and by `cricketPosition` in the engine.

- [ ] **Step 1: Write the failing engine test**

```ts
// packages/engine/src/sports/cricket/cricket.test.ts
describe("activeInnings — one definition, shared by the position axis and the pad", () => {
  const main = [{ closed: true }, { closed: true }];
  it("main innings while there is no super over", () => {
    expect(activeInnings({ innings: main, superOver: null }))
      .toEqual({ list: main, offset: 0, inSuperOver: false });
  });
  it("super-over innings once there is one, offset past the main innings", () => {
    const so = [{ closed: false }];
    expect(activeInnings({ innings: main, superOver: { innings: so } }))
      .toEqual({ list: so, offset: 2, inSuperOver: true });
  });
  it("an EMPTY super-over list is still the active list", () => {
    // The state decideTie leaves behind: phase super_over, no ball yet.
    expect(activeInnings({ innings: main, superOver: { innings: [] } }))
      .toEqual({ list: [], offset: 2, inSuperOver: true });
  });
  it("treats an absent superOver field the same as null", () => {
    expect(activeInnings({ innings: main, superOver: undefined }).inSuperOver).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/packages/engine && \
  rtk proxy npx vitest run src/sports/cricket/cricket.test.ts -t "activeInnings" 2>&1 | tail -15
```
Expected: FAIL — `activeInnings is not defined`.

- [ ] **Step 3: Implement it and refactor `cricketPosition` onto it**

```ts
/**
 * THE innings list actually being played, and how many innings precede it.
 *
 * ONE definition, read by the position axis below AND by the v3 pad
 * (`skins/cricket.tsx`), so the two cannot fork on the question "which
 * innings am I looking at". They did fork: the pad re-derived it as
 * `state.innings` alone and therefore spent every super over describing the
 * innings before it — a frozen score, a stale target, the wrong bowler, and
 * a delivery row disabled by a closure that was not the match's.
 *
 * Structural and generic rather than taking `CricketState`, for the same
 * reason `nextBattingSide` is: the pad holds a narrowed shape of the state
 * and must be able to call this without either owning the full type or
 * casting a partial object into one.
 *
 * THE SUPER OVER CONTINUES THE INNINGS COUNT, so `offset` is the main
 * innings' length, never 0 — numbering a super over 1 and 2 would send
 * position BACKWARDS mid-fixture, and W6 sorts a timeline by it.
 *
 * An EMPTY super-over list is still the active list. `decideTie` creates
 * `superOver` with no innings in it, and the pad meets exactly that state
 * between the tie and the first super-over ball; answering `state.innings`
 * there is what told the pad the match was over.
 */
export interface ActiveInnings<T> {
  list: readonly T[];
  offset: number;
  inSuperOver: boolean;
}

export function activeInnings<T>(m: {
  innings: readonly T[];
  superOver: { innings: readonly T[] } | null | undefined;
}): ActiveInnings<T> {
  const so = m.superOver;
  if (so === null || so === undefined) {
    return { list: m.innings, offset: 0, inSuperOver: false };
  }
  return { list: so.innings, offset: m.innings.length, inSuperOver: true };
}
```

Then `cricketPosition` loses its own copy:

```ts
function cricketPosition(state: CricketState): MatchPosition {
  const live = state.outcome === null;
  const { list, offset } = activeInnings<InningsState>(state);
  const number = unitNumber({
    started: list.length,
    completed: list.filter((innings) => innings.closed).length,
    live,
  });
  const balls = list[number - 1]?.legalBalls ?? 0;
  return {
    segments: [
      unitSegment("innings", "Innings", offset + number),
      labelledSegment("over", "Over", oversText(balls, state.cfg.ballsPerOver), balls),
    ],
  };
}
```

This is a pure refactor of three lines — no fold change, no serialised-state change, so the golden corpus is untouched.

- [ ] **Step 4: Export it**

In `packages/engine/src/sports/cricket/index.ts`, beside the existing pad-mirror exports:

```ts
  // R3.5 — the pad must not re-derive "which innings is being played". Same
  // posture as nextBattingSide/eligibleBowlers/reviewsRemaining above: a
  // public mirror of a private rule, so the pad mirrors rather than forks.
  activeInnings,
  type ActiveInnings,
```

- [ ] **Step 5: Engine green, including the golden corpus**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/packages/engine && \
  rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r35-engine.json > /dev/null 2>&1; \
  echo "EXIT=$?"; \
  python3 -c "import json;d=json.load(open('/tmp/r35-engine.json'));print(d['numPassedTests'],'/',d['numTotalTests'],'failedSuites:',d['numFailedTestSuites'])"
```
Expected: baseline count + 4, zero failures. **If the golden corpus reds, STOP** — the refactor changed behaviour and this plan's engine claim is wrong. Do not re-baseline.

- [ ] **Step 6: Commit the engine half**

```bash
git add packages/engine/src/sports/cricket/cricket.ts \
        packages/engine/src/sports/cricket/index.ts \
        packages/engine/src/sports/cricket/cricket.test.ts
git commit -m "feat(cricket): export the active-innings rule the pad kept re-deriving

cricketPosition already switched onto superOver.innings; nothing else
could. Extracted, exported and consumed by the position axis itself, so
there is one definition rather than two agreeing by accident."
```

- [ ] **Step 7: Build the real-fold helper the cricket skin has never had**

```ts
// apps/web/src/components/v2/scorepad/v3/__tests__/_cricket-fold.ts
//
// REAL folded cricket states, the sibling of _football-fold.ts and for the
// same reason: R3 shipped four dead-end paths past green tests because those
// tests asserted the SKIN against a mirror of the engine. A mirror agrees
// with itself. Every assertion built on this file compares the skin to a
// state `foldMatch` actually produced.
import { foldMatch, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket, type CricketCfg, type CricketState } from "@seazn/engine/sports/cricket";

export function cricketLineups(): LineupPair {
  const side = (p: string) => ({
    entrantId: p,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${p}-${i + 1}`, slot: "starting" as const, orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  });
  return { home: side("H"), away: side("A") } as never as LineupPair;
}

export function foldCricket(
  cfg: CricketCfg,
  specs: readonly [type: string, payload?: unknown][],
): CricketState {
  const envelopes: EventEnvelope[] = specs.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload: payload ?? {} }));
  return foldMatch(cricket, cfg, cricketLineups(), envelopes);
}

/** A ball payload builder that keeps (over, ballInOver) honest across a
 *  sequence — an illegal delivery repeats the ball number, which is what the
 *  fold expects and what a hand-written literal reliably gets wrong. */
export function ballSeq(bpo = 6) {
  let legal = 0;
  return (type: string, p: {
    striker: string; nonStriker: string; bowler: string;
    bat?: number; boundary?: number; extras?: { kind: string; runs: number };
    wicket?: unknown;
  }): [string, unknown] => {
    const payload = {
      over: Math.floor(legal / bpo), ballInOver: (legal % bpo) + 1,
      striker: p.striker, nonStriker: p.nonStriker, bowler: p.bowler,
      runs: { bat: p.bat ?? 0, ...(p.extras ? { extras: p.extras } : {}) },
      ...(p.wicket ? { wicket: p.wicket } : {}),
      ...(p.boundary ? { boundary: p.boundary } : {}),
    };
    const illegal = p.extras?.kind === "wide" || p.extras?.kind === "noball";
    if (!illegal) legal++;
    return [type, payload];
  };
}

/** A tied one-over-a-side T20 with the super over enabled — the shortest
 *  legal route to `phase: "super_over"`. `minOversForResult: 1` is required:
 *  the cfg refine rejects a result floor longer than the innings. */
export function tiedWithSuperOver(overrides: Record<string, unknown> = {}): CricketCfg {
  return cricket.configSchema.parse({
    superOver: true, ballsPerInnings: 6, ballsPerOver: 6, minOversForResult: 1, ...overrides,
  });
}
```

- [ ] **Step 8: Write the failing skin tests (cases C2–C10, C16–C20)**

Every one of these asserts a builder against a state `foldCricket` produced. Representative core:

```ts
it("C4/C5: the scorebug tracks the SUPER OVER, not the closed innings", () => {
  const cfg = tiedWithSuperOver();
  const b = ballSeq();
  const state = foldCricket(cfg, [
    ["core.start"],
    ...[1, 1, 1, 1, 1, 1].map(() => b("cricket.ball", { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 })),
    ...[1, 1, 1, 1, 1, 1].map(() => b("cricket.ball", { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 })),
    b("cricket.superover.ball", { striker: "A-1", nonStriker: "A-2", bowler: "H-10", bat: 4, boundary: 4 }),
  ]);
  expect(state.phase).toBe("super_over");
  const bug = buildScorebug(view({ cfg, state }), t);
  expect(bug.halves[0].big).toBe("4/0");   // the super over, not 6/0
  expect(bug.halves[1].big).toBe("0.1");
});

it("C3: a COARSE main innings does not disable the super over's delivery row", () => {
  const cfg = cricket.configSchema.parse({ superOver: true });
  const state = foldCricket(cfg, [
    ["core.start"],
    ["cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120, boundaries: 10 }],
    ["cricket.innings.summary", { runs: 150, wickets: 7, legalBalls: 120, boundaries: 12 }],
  ]);
  const tiles = buildTiles(view({ cfg, state }));
  expect(tiles.filter((x) => x.disabled === true)).toEqual([]);
  expect(tiles.map((x) => x.id)).toContain("run4");
});

it("C6: the bowler named is the SUPER OVER's bowler", () => { /* asserts resolvePeople().bowler === "H-10" */ });
it("C8: the target chip in the second super-over innings is SO1 + 1", () => { /* … */ });
it("C9: the first super-over innings closing does not disable anything", () => { /* … */ });
it("C16: the wicket sheet excludes a batter already dismissed in the super over", () => { /* … */ });
```

- [ ] **Step 9: Run, watch them fail for the RIGHT reason**

Expected: C3 fails on `disabled` tiles present, C4/C5 fail on `"6/0"` vs `"4/0"`, C6 on the wrong bowler. A failure naming a missing import is a test bug, not the defect — fix and re-run before proceeding.

- [ ] **Step 10: Make the skin consume the engine accessor**

`skins/cricket.tsx` — declare the field, then delegate:

```ts
interface CricketStateShape {
  phase?: "pre" | "live" | "super_over" | "done" | "final";
  innings?: CricketInningsShape[];
  /** R3.5 — the super over's OWN innings list. The engine keeps it here and
   *  never in `innings` (a super-over innings is the third and fourth of the
   *  match, numbered by `activeInnings`' offset). Absent from this shape
   *  until now, which is exactly why the pad spent every super over
   *  describing the innings before it. */
  superOver?: { innings?: CricketInningsShape[] } | null;
  // … existing fields unchanged
}
```

```ts
/** The innings on display. Delegates to the engine's `activeInnings` so the
 *  pad and the position axis cannot disagree about which list is live — see
 *  that function's own doc for why this is not a local switch. Keeps the
 *  "fall back to the last innings once every one is closed" display rule. */
export function currentInnings(state: CricketStateShape): CricketInningsShape | null {
  const { list } = activeInnings<CricketInningsShape>({
    innings: state.innings ?? [],
    superOver: state.superOver ? { innings: state.superOver.innings ?? [] } : null,
  });
  return list.find((i) => !i.closed) ?? list[list.length - 1] ?? null;
}
```

```ts
/** …existing doc… R3.5: inside a super over the main-innings sequencing rule
 *  does not apply — `nextBattingSide` counts main innings and would report a
 *  side due when the engine is mid-decider. The super over's own rule is
 *  simply "the other side bats next", and only while a pair is incomplete. */
export function dueBattingSide(state: CricketStateShape, cfg: CricketCfgShape): "home" | "away" | null {
  const so = state.superOver?.innings;
  if (state.phase === "super_over" && so !== undefined) {
    const open = so.find((i) => !i.closed);
    if (open) return null;                       // an innings is in progress
    if (so.length === 0) return null;            // none created yet — C2
    if (so.length % 2 === 1) {                   // pair incomplete: other side
      return opponentSide((so[so.length - 1] as CricketInningsShape).battingSide ?? "home");
    }
    return null;                                 // pair complete: repeat opens on the next ball
  }
  const innings = currentInnings(state);
  if (innings === null || innings.closed !== true) return null;
  return nextBattingSide({ /* unchanged */ });
}
```

```ts
export function chaseTarget(cfg: CricketCfgShape, state: CricketStateShape): { value: number; isDls: boolean } | null {
  // R3.5 — a super over has its OWN target, and the main innings' is stale
  // the moment the match goes to one. The engine's rule (applySuperOverBall):
  // the SECOND innings of each pair chases the first + 1; the first chases
  // nothing.
  const so = state.superOver?.innings;
  if (state.phase === "super_over" && so !== undefined) {
    if (so.length === 0 || so.length % 2 === 1) return null;
    const first = so[so.length - 2] as CricketInningsShape;
    return typeof first.runs === "number" ? { value: first.runs + 1, isDls: false } : null;
  }
  // …existing main-innings arithmetic unchanged…
}
```

- [ ] **Step 11: Run the skin tests to green, then mutation-proof**

Revert `currentInnings` to `state.innings ?? []` and confirm C3/C4/C5/C6 all red again. Restore.

- [ ] **Step 12: Rewrite the e2e that pins the defect (case X5)**

`e2e/scorepad-v3-cricket.spec.ts:1004` sets `superOver: true` specifically to reach a tie and then asserts the tiles are disabled, `"This innings is closed."` is visible, and the scorebug keeps the previous score. It will now fail, correctly.

Split it in two:
- The ORIGINAL intent — a terminal closed innings — keeps `superOver: false`, and keeps every assertion unchanged. That is the behaviour the test was written to protect.
- A NEW test drives the same tie with `superOver: true` and asserts the opposite: `run0`/`run1`/`wicket` carry `data-tile-disabled="false"`, no closure message is visible, and the scorebug shows the super over.

Update the test's own comment — it currently explains the `superOver: true` choice as "the one config where the match stays phase super_over", which is true and was the reason it accidentally documented a bug.

- [ ] **Step 13: Run both cricket e2e specs against a prod build**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 \
  npx playwright test e2e/scorepad-v3-cricket.spec.ts --reporter=line 2>&1 | tail -20
```

- [ ] **Step 14: Commit**

```bash
git add apps/web/src/components/v2/scorepad/v3/skins/cricket.tsx \
        apps/web/src/components/v2/scorepad/v3/__tests__/_cricket-fold.ts \
        apps/web/src/components/v2/scorepad/v3/skins/__tests__/cricket.test.ts \
        apps/web/e2e/scorepad-v3-cricket.spec.ts
git commit -m "fix(cricket): score the super over on the pad, not the innings before it

currentInnings read state.innings; the engine keeps a super over in
state.superOver.innings. The pad therefore spent every super over
showing a frozen score, a stale target and the wrong bowler, with all
fifteen delivery tiles disabled by a closure that was not the match's.

The e2e at :1004 asserted that behaviour. Split: the terminal case it
meant to test keeps superOver:false; the super over gets its own."
```

---

## Task D: A scorebug half can carry a second figure

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/types.ts` (`ScorebugHalf`)
- Modify: `apps/web/src/components/v2/scorepad/v3/scorebug.tsx` (`HalfContent`)
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/football.tsx` (`buildScorebug`)
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/scorebug.test.ts`, `.../__tests__/contrast.test.ts`, `.../skins/__tests__/football.test.ts`

**Interfaces:**
- Produces: `ScorebugHalf.sub?: string` — PRE-FORMATTED and pre-localised, exactly like `big` and `ScorebugSpec.context`. The chassis renders it verbatim and never resolves a sport-namespaced key.
- Consumed by: football now; R6's hockey and icehockey next (`period/kernel.ts` already composes `2 — 1 (GWS 2–1)`).

- [ ] **Step 1: Write the failing tests (B6, B7, F3, F4, F5)**

```ts
it("B6: a half with no `sub` renders exactly what it rendered before", () => {
  const html = renderHalfToString({ who: [{ name: "Home" }], big: "1" });
  expect(html).not.toContain("data-half-sub");
});
it("B7: a half with `sub` renders it once, beside the big figure", () => {
  const html = renderHalfToString({ who: [{ name: "Home" }], big: "1", sub: "(2)" });
  expect(html).toContain("(2)");
});
it("F3: football's halves carry the pens tally during SHOOTOUT", () => {
  const state = foldFootball(footballCfg({ shootout: true }), [
    ["core.start"], ["football.goal", { by: "H" }], ["football.goal", { by: "A" }],
    ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }],
    ["football.shootout.kick", { by: "H", scored: true }],
    ["football.shootout.kick", { by: "A", scored: false }],
    ["football.shootout.kick", { by: "H", scored: true }],
    ["football.shootout.kick", { by: "A", scored: true }],
  ]);
  const bug = buildScorebug(view({ cfg, state }), t);
  expect(bug.halves.map((h) => [h.big, h.sub])).toEqual([["1", "(2)"], ["1", "(1)"]]);
});
it("F4: no `sub` in any non-SHOOTOUT phase", () => { /* H1, H2, ET_H1, pre, done */ });
it("F5: cricket and tennis never set `sub`", () => { /* proves the field is opt-in */ });
```

- [ ] **Step 2: Run, watch F3 fail on `undefined` and B7 fail on missing output**

- [ ] **Step 3: Add the field**

```ts
export interface ScorebugHalf {
  who: WhoLine[];
  big: string;                    // pre-formatted, tabular-nums rendering
  /**
   * R3.5 — an OPTIONAL second figure against `big`, for a decider running
   * alongside the regulation score: football's shoot-out tally, and R6's
   * `(GWS 2–1)` for icehockey and hockey, which `period/kernel.ts` already
   * composes for its own summary and has nowhere to render.
   *
   * PRE-FORMATTED and pre-localised, the same convention `big` and
   * `ScorebugSpec.context` follow — brackets, separators and all. The
   * chassis renders it verbatim and never resolves a sport-namespaced key
   * (see whoNames' own doc for the ruling that established this).
   *
   * Absent on every half shipped before this, so the two render branches
   * below are byte-for-byte what R1-R4 rendered. Design note D-11 (one
   * score, rendered once) is not weakened: this is the SAME score's decider,
   * in the same element, not a second readout somewhere else on the page.
   */
  sub?: string;
  hintKey?: string;
  tappable?: boolean;
  tapEvent?: TapEvent;
}
```

- [ ] **Step 4: Render it**

In `scorebug.tsx`'s `HalfContent`, immediately after the `big` div:

```tsx
      {half.sub && (
        <div
          data-half-sub=""
          className={`app-display text-base font-semibold leading-none ${NIGHT_TILE_CLASSES.creamText}`}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {half.sub}
        </div>
      )}
```

`creamText`, not `limeText`: the decider is subordinate to the regulation score, and reusing the lime would give two figures equal weight — which is the confusion this task exists to remove. Both tokens are already in the contrast suite's pairs.

- [ ] **Step 5: Football fills it**

In `buildScorebug` (`skins/football.tsx`), replacing the two bare halves:

```ts
  // R3.5 — the shoot-out tally rides the SAME halves as the regulation score.
  // Before this the board showed 1 and 1 while the headline above it read
  // "1 — 1 (2-1 pens)": two score readouts on one screen, disagreeing, which
  // is exactly what D-11 exists to prevent. `shootoutTally` is the shared
  // primitive, never a fourth hand-rolled reduce (see Task H).
  const kicks = state.shootout?.kicks;
  const pens = kicks ? shootoutTally(kicks) : null;
  return {
    context: contextParts.join(" · "),
    phase: resolvePhase(view),
    halves: [
      { who: [{ name: t(SIDE_LABEL.home) }], big: String(state.goals?.home ?? 0),
        ...(pens ? { sub: `(${pens.home})` } : {}) },
      { who: [{ name: t(SIDE_LABEL.away) }], big: String(state.goals?.away ?? 0),
        ...(pens ? { sub: `(${pens.away})` } : {}) },
    ],
    strip,
  };
```

**Prerequisite, verified:** `shootoutTally` and `expectedKicker` live in `packages/engine/src/sports/period/shootout.ts` and are **NOT** exported from `packages/engine/src/sports/football/index.ts`, which today exports ten names and neither of these. Add both to that barrel before this step:

```ts
// R3.5 — the pad needs football's own alternation and tally rules. Re-exported
// from football rather than imported by the pad out of `sports/period`: the
// skin must not reach into another sport family's folder, and football is
// where the pad's contract with these rules belongs.
export { expectedKicker, shootoutTally, type ShootoutKick } from "../period/shootout.ts";
```

The skin then imports from `@seazn/engine/sports/football`, matching how the cricket skin imports `eligibleBowlers` / `nextBattingSide` / `reviewsRemaining` from `@seazn/engine/sports/cricket`.

- [ ] **Step 6: Contrast + axe**

Add the `sub` pair to `__tests__/contrast.test.ts` and compute the ratio from the tokens rather than asserting a class name. Then run axe on the football skin.

- [ ] **Step 7: Screenshots at three widths**

The `(2)` must not push the half into overflow at 320. The half already carries `min-w-0` and `break-words` for exactly this class of problem (R3/F3) — confirm, do not assume.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pad): a scorebug half can carry its decider's figure

Football showed 1 and 1 during a shoot-out while the headline above read
(2-1 pens). Chassis field rather than a football string: R6 brings
icehockey and hockey, whose kernel already composes (GWS 2-1) and has
nowhere to put it."
```

---

## Task E: The kick log names the side

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/football.tsx` (`footballDetail`, the `football.shootout.kick` case)
- Modify: `apps/web/src/locales/{en,es,fr,nl}.json`
- Modify: `apps/web/src/lib/scoring-vocab.ts` (`PAD_LABEL_KEYS`)
- Test: `apps/web/src/components/v2/scorepad/v3/skins/__tests__/football.test.ts`

- [ ] **Step 1: Grep the existing copy across e2e BEFORE editing**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders && \
  git grep -an "Shoot-out kick recorded" -- apps/web/e2e apps/web/src
```
Any spec asserting the old string must move in the same commit.

- [ ] **Step 2: Write the failing tests (F12, F13)**

```ts
it("F12: a scored kick names the side", () => {
  expect(footballDetail("football.shootout.kick", { by: "H", scored: true }, ctx))
    .toBe("Home · Scored");
});
it("F13: a missed kick names the side and the taker", () => {
  expect(footballDetail("football.shootout.kick", { by: "A", scored: false, person: "A-9" }, ctx))
    .toBe("Away · Missed · Ada Nine");
});
```

- [ ] **Step 3: Implement**

```ts
    case "football.shootout.kick":
      // R3.5 — the SIDE first. For every other football event the side is
      // inferable because the score moves; for a shoot-out kick it is the
      // entire content of the event, and this is the panel a scorer voids
      // from, so a mis-tap was being corrected blind.
      const kickSide = sideOfEntrant(state, payload.by);
      return join([
        kickSide === null ? undefined : t(SIDE_LABEL[kickSide]),
        t(payload.scored === true ? "outcome.scored" : "outcome.missed"),
        named(payload.person),
      ]);
```

`sideOfEntrant` (`skins/football.tsx:1161`) already maps an entrant id to `Side` and returns `null` when it cannot — reuse it rather than adding a second resolver. `null` drops the segment through `join` rather than printing a raw entrant id: an unresolvable side is a real state (a foreign entrant on a replayed ledger) and a UUID in a scorer's activity feed is the defect S13 already had to fix once.

- [ ] **Step 4: Four dictionaries, then regenerate**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders/apps/web && \
  npm run i18n:gen-keys && npm run i18n:check && git status --porcelain
```
`lib/i18n-keys.ts` is GENERATED — it must appear in `git status` as a regenerated file, never hand-edited, and the working tree must be clean afterwards.

- [ ] **Step 5: Commit**

---

## Task F: The board says whose kick is next

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/football.tsx` (`buildScorebug` strip, `buildContext`)
- Modify: the four dictionaries
- Test: `.../skins/__tests__/football.test.ts`, `apps/web/e2e/scorepad-v3-football.spec.ts`

- [ ] **Step 1: Write the failing tests (F9, F10, F11)**

```ts
it("F9: no cue before the first kick — either side may start", () => {
  expect(kickerCue(stateAtShootoutStart, t)).toBeUndefined();
});
it("F10: after home kicks, the cue names Away", () => {
  expect(kickerCue(stateAfterHomeKick, t)).toContain("Away");
});
it("F11: the engine still refuses an out-of-turn kick, naming the entrant", () => {
  expect(() => football.apply(stateAfterHomeKick, homeKickAgain, { strict: true }))
    .toThrowError(/kicks must alternate: expected Away/);
});
```

- [ ] **Step 2: Implement, reading the shared primitive**

```ts
  // R3.5 — `expectedKicker` is the engine's OWN alternation rule, already
  // exported from the shared shoot-out primitive and never called by the pad.
  // Surfacing it prevents the refusal rather than explaining it afterwards,
  // which matters more than it looks: server-side messages are not localised,
  // so an out-of-turn tap reaches a Spanish or Dutch scorer in English.
  // `null` is a real answer at zero kicks (either side may start) and renders
  // nothing rather than a guess.
  if (phase === "SHOOTOUT" && state.shootout) {
    const next = expectedKicker(state.shootout.kicks);
    if (next !== null) {
      strip.push({
        id: "nextKicker",
        label: t("scorepad.skin.football.header.nextKicker"),
        value: t(SIDE_LABEL[next]),
        tone: "led",
      });
    }
  }
```

- [ ] **Step 3: e2e — the cue updates after a real tap through the pad**

- [ ] **Step 4: Commit**

---

## Task G: A decided fixture says who won, and how

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx`
- Modify: the four dictionaries
- Test: `apps/web/e2e/scorepad-v3-football.spec.ts`, `.../scorepad-v3-cricket.spec.ts`

**Interfaces:**
- Consumes: `fixture.outcome` — `{ kind, winner, loser, method }` — already passed to the page at line 133 and rendered nowhere.

- [ ] **Step 1: Write the failing e2e (F18, C23, C13, C14, C15)**

```ts
await expect(page.getByText("won 3–0 on penalties")).toBeVisible();          // F18
await expect(page.getByText("won the super over")).toBeVisible();            // C23
await expect(page.getByText("won on boundary count")).toBeVisible();         // C13
await expect(page.getByText("Match tied")).toBeVisible();                    // C14/C15
```

- [ ] **Step 2: Implement one sentence, four locales**

```ts
// R3.5 — the page already receives `outcome` (winner + method) and said only
// "Decided" above a tally the reader has to decode. A parent reading
// "1 — 1 (3-0 pens)" should not have to work out who went through.
//
// The same `summary` feeds the WhatsApp share text and the OG description
// (metadata, above), so this lands in three places at once.
```

Map `method` → key: `shootout` → `fixture.decidedBy.shootout`, `super_over` → `.superOver`, `boundary_count` → `.boundaryCount`, `extra_time` → `.extraTime`, everything else → the plain winner sentence. An UNMAPPED method must render the plain winner sentence, never the raw token — a missing mapping is a copy finding and the winner is still true.

- [ ] **Step 3: Extend the share text**

The `decided`/`finalized` branch already interpolates `summary.headline`; append the decided sentence so the WhatsApp message says who won.

- [ ] **Step 4: Commit**

---

## Task H: Football stops forking the shoot-out tally

**Files:**
- Modify: `packages/engine/src/sports/football/football.ts` (`summary`), `.../football/index.ts` (re-export `shootoutTally` for the skin)
- Test: `packages/engine/src/sports/football/football.test.ts`

- [ ] **Step 1: Write the failing parity test (F22)**

```ts
it("F22: summary's tally IS shootoutTally, for every sequence including a void", () => {
  for (const kicks of KICK_SEQUENCES) {
    const state = { ...base, shootout: { kicks } };
    const fromSummary = parsePens(football.summary(state).headline);
    expect(fromSummary).toEqual(shootoutTally(kicks));
  }
});
```
Include a sequence carrying `void: true`. It fails today: the inline `reduce` counts a void kick's `scored`, and `shootoutTally` does not.

- [ ] **Step 2: Replace the reduce**

```ts
  summary(state): ScoreSummary {
    const { home, away } = state.goals;
    // R3.5 — ONE tally. `shootout.ts`'s own doc explains why this must not be
    // a local copy: the decision math and the display cannot be allowed to
    // fork. `period/kernel.ts` already reads it; this was the third copy, and
    // it was wrong about a void kick.
    const shootout = state.shootout ? shootoutTally(state.shootout.kicks) : null;
```

- [ ] **Step 3: Engine suite + golden green. Commit.**

---

## Task I: Group-stage shoot-out points reachable — UI ONLY

**Scout resolved the plan's one open question: the engine ALREADY does this, correctly.**
`football.ts:2599-2606` gates a split on `outcome.method === "shootout"` and both fields being defined, then awards `cfg.points.shootoutWin` / `cfg.points.shootoutLoss` instead of `win`/`loss`. So this task adds **no engine code**.

**The field path in the plan's first draft was wrong.** They are `cfg.points.shootoutWin` and `cfg.points.shootoutLoss` — nested inside the `points` object (`football.ts:110-118`), not bare cfg keys. A UI writing `{ shootoutWin: 2 }` at the top level would parse, persist, and silently never fire. Write into `points`.

The review's finding stands: zero references in `apps/web`, so no organiser can set them and every group stage decided on kicks awards flat win/loss.

**Files:**
- Modify: `apps/web/src/components/v2/match-rules.tsx` (the football rule set — the `shootout` boolean at `:159-163`)
- Test: `packages/engine/src/sports/football/football.test.ts` (regression guards, if absent), and the match-rules spec

**Interfaces:**
- Consumes: `cfg.points.shootoutWin?: number`, `cfg.points.shootoutLoss?: number` — both `z.number().int().nonnegative().optional()`.
- Produces: nothing new. UI reach for existing engine behaviour.

- [ ] **Step 1: Check whether F19/F20/F21 already exist as engine tests**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r35-deciders && \
  git grep -an "shootoutWin" -- packages/engine/src/sports/football/football.test.ts
```
If the split already has coverage, do NOT duplicate it — add only what is missing. If it has none, write F19/F20/F21 as regression guards against the CURRENT behaviour (they must pass immediately; that is correct for a guard on shipped code, and they still earn their place because nothing pins this today).

- [ ] **Step 2: Add the two fields, writing into `points`**

Follow the neighbouring `shootoutAttempts` field's shape in the same file. The `build` function must merge into `points`, never replace it:

```ts
    {
      key: "shootoutWin",
      label: "Points for a shoot-out win",
      help: "Group stages only, and only when Penalty shootout is on. Leave blank to award a normal win.",
      kind: "number",
      min: 0,
      build: (v, values) => ({
        points: {
          ...defaultPoints(values),
          ...(v === "" ? {} : { shootoutWin: Number(v) }),
        },
      }),
    },
```

A blank field must emit NO key rather than `0` — `undefined` is what turns the split off, and `0` is a legal points value meaning "a shoot-out win is worth nothing". The two are not the same and the engine gate reads `!== undefined`.

- [ ] **Step 3: Both fields or neither**

The engine requires BOTH to be defined before it splits. A UI that lets an organiser set only the win silently does nothing. Either validate the pair in the editor, or state the rule in the `help` text of both — decide, and write the choice into `_INDEX.md` as a ruling rather than leaving it to the reader.

- [ ] **Step 4: e2e — set both, decide a group fixture on kicks, assert the table**

The value of this task is a correct league table, so the test must read the STANDINGS, not the config round-trip.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(football): let an organiser set group-stage shoot-out points

points.shootoutWin/shootoutLoss have worked in the engine since spec 04
and had zero references in apps/web, so every group stage decided on
kicks awarded flat win/loss and nothing surfaced it. UI only."
```

---

## Task J: Phase-gated kick tiles (amends R3-4 for SHOOTOUT only)

Depends on Task B — the More panel must stay correct for any band that still reaches it.

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/football.tsx` (`buildTiles`)
- Modify: the four dictionaries
- Test: `.../skins/__tests__/football.test.ts`, `apps/web/e2e/scorepad-v3-football.spec.ts`

- [ ] **Step 1: Write the failing tests (F6, F7, F8, F10, F17)**

```ts
it("F6: kick tiles in SHOOTOUT, goal tiles gone", () => {
  const ids = buildTiles(view({ cfg, state: shootoutState })).map((x) => x.id);
  expect(ids).toEqual(expect.arrayContaining(["kick-home", "kick-away"]));
  expect(ids).not.toEqual(expect.arrayContaining(["goal-home", "goal-away"]));
});
it("F7: no kick tiles in any other phase", () => { /* pre, H1, H2, ET_H1, done */ });
it("F10: the out-of-turn side's tile is disabled, with a context message", () => { /* … */ });
it("F17: cards remain available during SHOOTOUT", () => { /* … */ });
```

- [ ] **Step 2: Implement, spanning half the grid like every other side tile**

```ts
  // R3.5 / ruling R3.5-5 — R3-4 AMENDED for this phase ONLY. That ruling put
  // four RARE types in More, and it still stands everywhere else; in the
  // shoot-out the rare type is the entire match, and the board otherwise
  // holds two card tiles and nothing else while the only action of the phase
  // sits two taps deep. These occupy the space the Goal tiles vacate.
  //
  // The out-of-turn side's tile is DISABLED rather than absent: a vanishing
  // tile reads as a bug, and `expectedKicker` (Task F) already names whose
  // turn it is. A disabled tile obliges a context-strip message explaining
  // why (tile-grid.tsx's own set-level rule), which Task F's cue satisfies.
  if (phase === "SHOOTOUT" && offerable("football.shootout.kick")) {
    const next = state.shootout ? expectedKicker(state.shootout.kicks) : null;
    for (const side of ["home", "away"] as const) {
      tiles.push({
        id: `kick-${side}`,
        label: "pad.football.action.shootoutKick",
        // `sublabel` (the i18n KEY form), matching the Goal/Card/Sub tiles
        // beside it — NOT `sublabelText`, which is the pre-localised slot and
        // would make this one tile resolve differently from its neighbours.
        sublabel: SIDE_LABEL[side],
        kind: "primary",
        span: 2,
        phases: ["live"],
        ...(next !== null && next !== side ? { disabled: true } : {}),
        action: { sheet: `kick-${side}` },
      });
    }
  }
```

The tile opens a two-outcome sheet (Scored / Missed) rather than emitting directly, so the band-2+ taker attribution stays reachable and a mis-tap has a step to escape from.

- [ ] **Step 3: e2e — record a full shoot-out through the pad, tile taps only**

The existing football spec stops at "the panel is reachable". Drive an entire decider through the board and assert the tally, the cue and the decided sentence. This is the coverage whose absence let the wave ship.

- [ ] **Step 4: Commit**

---

## Task K: Structured logging on the decider path (pino)

`appendEvent` is the single server-side funnel every scoring event passes through, and it has **no logging at all** today. Every super-over ball, every shoot-out kick, and every engine refusal on both is currently invisible in production — which is precisely why this wave's defects had to be found by rendering the pad rather than by reading a log.

**Where logging can and cannot go, decided before any code:**

- **`appendEvent` — YES.** Server-side, already the funnel, already throws a typed `EngineError` per refusal class. `apps/web/src/server/logger.ts` exports the app's pino singleton and its `mixin` folds requestId / orgId / userId into every line with no call-site changes.
- **The v3 skins — NO.** They are `"use client"`. `server/logger.ts` reads request context and is server-only; importing it into a client component is the `@/server/**`-in-a-client-component build failure, which `tsc` does not catch. The pad has no client-side logging convention today and this wave must not invent one.
- **The sport modules — NO.** `packages/engine` is declared "Pure tournament engine — zero effectful deps". `scheduling/logger.ts` is a deliberate, scoped, *unexported* exception for a subsystem with real I/O. A sport module is a pure fold and stays one.

**Files:**
- Modify: `apps/web/src/server/engine-db/append-event.ts`
- Test: `apps/web/src/server/engine-db/__tests__/append-event.test.ts`

**Interfaces:**
- Consumes: `log` from `@/server/logger` (module-scope pino singleton, `name: "web"`).
- Produces: no signature change. Log lines only.

- [ ] **Step 1: Write the failing tests**

Assert on a captured pino stream, not on `console`. Cases:

```ts
it("K1: logs an accepted event with its type, fixture and resulting seq", () => { /* … */ });
it("K2: logs a refusal with the EngineError code and the event type", () => { /* … */ });
it("K3: logs a decider ENTERED at info when the fold moves into super_over/SHOOTOUT", () => { /* … */ });
it("K4: logs a decider RESOLVED with outcome.method", () => { /* … */ });
it("K5: never logs an event payload, a person name, or an email", () => {
  // The payload carries striker/nonStriker/bowler/person ids and, for some
  // events, free text. Persons in this product carry consent flags; a log
  // line is not a consented surface. Assert the serialised line contains
  // none of the payload's values.
});
```

- [ ] **Step 2: Instrument the accept path**

Scout-verified scope at the call site: the fold is `append-event.ts:266-268` producing `state`; `outcome` at `:270`; `status` from `nextStatus(...)` at `:314`; `candidate.type` / `candidate.seq` are the event. **`fixture.status` is the fixture's STATUS, not the engine phase** — the plan's first draft called these `phaseBefore`/`phaseAfter`, which do not exist.

```ts
import { log } from "@/server/logger";

// … after the insert into match_states:
  // R3.5 — this funnel was entirely silent. IDs, types and counts only:
  // payloads carry person ids and free text, and persons in this product
  // carry consent flags, so a payload is never a log-safe value (K5).
  //
  // `phase` is the fold's OWN phase, which is what makes a decider visible;
  // `status` is the fixture row's. They are different things and both matter.
  log.info(
    {
      fixtureId,
      sportKey: division.sport_key,
      eventType: candidate.type,
      seq: candidate.seq,
      phase: (state as { phase?: unknown }).phase ?? null,
      status,
    },
    "scoring event appended",
  );
```

**There is no "entered a decider" line.** The phase BEFORE the fold is not in scope here — reconstructing it would mean a second fold on the scorer's tap path, which is not worth it. A decider entry is already visible as the first accepted line whose `phase` is `super_over` or `SHOOTOUT`, which is the same information without the cost. The plan's first draft invented a `DECIDER_PHASES` transition check against variables that do not exist; it is dropped.

- [ ] **Step 3: Instrument the refusal path**

**Scout-verified: `append-event.ts` contains ZERO `try {` blocks today**, and everything here runs inside `tx` where a throw aborts the transaction before the insert — which is load-bearing behaviour (see the PROMPT-61 comment at `:272`). Wrap ONLY the `foldMatch` call, log, and re-throw unchanged, so the abort still happens exactly as it does now. Do not wrap the transaction, and do not run SQL inside the catch — a rejected statement poisons the rest of the tx.

```ts
  } catch (error) {
    if (EngineError.is(error)) {
      log.warn(
        { fixtureId, eventType: input.type, code: error.code, phaseBefore },
        "scoring event refused",
      );
    }
    throw error;
  }
```

Re-throw unchanged — this task adds observability and must not alter a single HTTP status or message.

- [ ] **Step 4: Log the decided transition — reusing the one already computed**

`append-event.ts:316` ALREADY computes exactly this transition for `firstResult`:
`fixture.outcome === null && outcome !== null`. Do not invent a second test of the same condition — log inside that existing branch, so the two can never disagree about when a fixture was decided.

```ts
    const firstResult: FirstResult | null = /* …unchanged… */;
    if (firstResult !== null) {
      // R3.5 — `method` is what a support question about a knockout result
      // actually needs: shootout / super_over / boundary_count / extra_time.
      // It is the difference between "they won" and "they won on penalties",
      // and until now neither reached a log.
      log.info(
        {
          fixtureId,
          sportKey: division.sport_key,
          kind: (outcome as { kind?: unknown }).kind ?? null,
          method: (outcome as { method?: unknown }).method ?? null,
        },
        "fixture decided",
      );
    }
```

- [ ] **Step 5: Verify the log level convention**

`info` for accepted events and decider transitions, `warn` for refusals, and nothing at `error` — a refused event is expected behaviour, not a fault. `LOG_LEVEL` already gates the whole logger via `process.env.LOG_LEVEL ?? "info"`; do not add a second switch.

- [ ] **Step 6: Prove it does not slow the funnel**

`server/logger.ts` uses `pino.destination({ sync: false })`, so writes are non-blocking. Confirm the append-event suite's timings are unchanged against the Task 0 baseline — a scoring funnel is on the scorer's tap path.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/engine-db/append-event.ts         apps/web/src/server/engine-db/__tests__/append-event.test.ts
git commit -m "feat(scoring): log the event funnel, and the deciders especially

appendEvent is the one path every scoring event takes and it logged
nothing, so a super over that could not be recorded and a shoot-out kick
refused for alternation were both invisible in production. IDs, types
and codes only: payloads carry person ids and consented names."
```

---

## Task L: Drive both deciders by hand, at the end (owner instruction, 2026-08-26)

Everything before this proves the code behaves. This proves the PRODUCT works. They are not the
same claim, and this programme has twice shipped a surface that passed its tests and did not work
— R3's two-step goal dock shipped INERT past five red-without-it unit tests AND the gallery.

**Captures are not this task.** A capture renders a state the harness seeded through the API. This
task requires a person tapping the pad and the ledger agreeing with what they tapped.

**Files:** none. This is a walkthrough, and its output is evidence.

- [ ] **Step 1: Fresh env, current bundle**

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
$S rebuild --label r35            # the bundle is stale the moment a skin changes
eval "$($S env --label r35)"
```
A stale standalone bundle answers every health check while serving the old code. Confirm the build is newer than the last skin edit before believing anything below.

- [ ] **Step 2: Seed a knockout that actually reaches both deciders**

One cricket T20 with `superOver: true`, tied. One football fixture with `shootout: true` and
`extraTime: { enabled: false, halfMinutes: 15 }`, level at FT. Mint an owner login link by SQL into
`login_links` and open it on **`localhost`** — never `127.0.0.1`, which 401s on the secure cookie.

- [ ] **Step 3: SCORE THE SUPER OVER THROUGH THE PAD**

Not through the API. Tap the tiles: a boundary, a single, a wicket, a wide. After each tap confirm
three things move together — the scorebug, the over dots, and the activity row. Then confirm the
audit table at the foot of the page shows `cricket.superover.ball`, not `cricket.ball`.

Close the first super-over innings and confirm the target chip appears for the reply reading
`first + 1`. Complete the second and confirm the match decides.

- [ ] **Step 4: SCORE THE SHOOT-OUT THROUGH THE PAD**

Tap the kick tiles. Confirm: the scorebug's second figure moves (`1 (2)`), the next-kicker cue
flips sides, the wrong-turn tile is disabled with a message that says why, and each activity row
names the side that kicked. Take it to an early decision inside the regulation five.

- [ ] **Step 5: Confirm the decided surface**

Both fixtures. The pad is GONE by now (`fixture-console.tsx` unmounts it once `decided`), so this
is Task G's sentence being read on the surface that survives: who won, and how.

- [ ] **Step 6: Screenshot every step at 1280 / 768 / 320**

No horizontal page scroll at any width, 44px targets. Publish as the AFTER half of the sign-off
sheet, paired against Task A's before-captures.

- [ ] **Step 7: Offer the live walkthrough**

`_RULES.md` §1 requires the offer, not just the artifact: server up, login link minted, so the
owner can tap through the decider themselves. A sheet is evidence; the product in their hands is
the gate.

---

## Wave gate

Run every item; paste the numbers rather than describing them.

- [ ] Unit, apps/web: `--reporter=json --outputFile`, compare to the Task 0 baseline
- [ ] Unit, engine: same, plus the golden corpus green with NO re-baseline
- [ ] `GATE_FILTER= seazn-env gate --label r35` — 4/4 tasks, 0 errors; read the `Cached:` line, not just exit 0
- [ ] `npm run i18n:check` — 4 locales, and `lib/i18n-keys.ts` regenerated not hand-edited
- [ ] `npm run openapi:gen` if any api-v1 zod moved
- [ ] `git status --porcelain` empty
- [ ] e2e: both scorepad v3 specs, plus the seven-width matrix, against a prod build on `localhost` with `E2E_PROD_TARGET=1`
- [ ] Smoke: `scripts/smoke.ts` — R8 already owes cricket and football smoke; if this wave defers again, say so in the PR body and name R8
- [ ] axe per skin on the four new states
- [ ] Screenshots 320 / 768 / 1280, no horizontal scroll, 44px targets
- [ ] Gallery AFTER artifact published, presented as pairs against the Task A before-captures
- [ ] Per-screen owner verdicts recorded in `_INDEX.md` — that record is the merge gate, not the sheet
- [ ] Live walkthrough offered: server up, login link minted on `localhost`, on a seeded knockout that actually reaches both deciders
- [ ] `_INDEX.md` updated: status, rulings, premises found false, register rows
- [ ] Help pages (`content/help/**`, English only) if any user-visible behaviour changed
- [ ] Log lines verified against a captured pino stream, and asserted to carry no payload values (K5)
- [ ] Memory written + `scripts/agent-memory-snapshot.sh`

## Self-review

Run against the spec with fresh eyes after writing. Three real defects found and fixed inline:

1. **Task E referenced a helper that does not exist.** The draft called `sideLabel(payload.by, view, t)`. The real one is `sideOfEntrant(state, entrantId): Side | null` at `skins/football.tsx:1161`. Fixed, including the `null` branch, which matters: printing a raw entrant id in the activity feed is a defect S13 already fixed once.
2. **Tasks D and F depended on two unexported symbols.** `shootoutTally` and `expectedKicker` live in `sports/period/shootout.ts`; `sports/football/index.ts` exports ten names and neither of them. A prerequisite re-export step is now written into Task D.
3. **Task J used the wrong sublabel slot.** `sublabelText` is the pre-localised slot; every neighbouring football tile uses `sublabel` with an i18n key. Corrected, so the new tiles resolve like their neighbours.

**Spec coverage:** tasks A–K each map to a spec section; the spec's five rulings are cited at the task implementing them. Task K (logging) was added after the spec was written and has been back-filled into `R3.5-deciders.md`.

**Type consistency:** `activeInnings` / `ActiveInnings<T>` are named and shaped identically in the engine (Task C step 3), the barrel (step 4) and the skin (step 10). `ScorebugHalf.sub` is consistent across Task D steps 3–5. `shootoutTally` is the one tally name in Tasks D, H and the football barrel.

**Placeholders — one accepted, deliberately.** Several repetitive test bodies are written as a representative case plus an elision (`/* … */`) where the same assertion repeats across phases or policies. Each elided body has a numbered row in the case matrix giving its exact expected value, so the implementer expands from the matrix, not from imagination. Where a case is *not* mechanical — C3, C4/C5, B1–B4, F3, F22 — the body is written in full.

**Known unknown, flagged rather than guessed:** Task I step 1 deliberately does not assert whether `standingsDelta` already honours `shootoutWin` / `shootoutLoss`. The review established only that `apps/web` never references them; the engine half is unverified. Read it before writing code — if the engine already handles it, Task I is UI-only.
