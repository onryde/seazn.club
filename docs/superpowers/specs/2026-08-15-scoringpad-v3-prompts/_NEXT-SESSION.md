# R7 follow-ups — instructions for a fresh session

R7 merged as PR #693. Everything below is a KNOWN, RECORDED item, not a
discovered bug. Read `_INDEX.md` R7-45 through R7-48 first: those entries record
how the last four defects on this branch were found, and three of them were
found by driving the product or by CI, never by a local gate.

**Ground rules that bit this programme repeatedly:**

- A grep is not a read; a read is not a run; and `playwright test --list` is not
  a run either — R7-48 shipped a broken e2e that had been "verified" by exactly
  that.
- Mutate every guard you add. If deleting the thing it guards leaves it green,
  it is decoration.
- `rtk` lies: vitest summaries print `PASS(0) FAIL(0)` for a suite that failed
  to COLLECT, and lint output is swallowed. Use `--reporter=json --outputFile`
  and `rtk proxy npx eslint`.
- Run vitest as `cd apps/web && DATABASE_URL= npx vitest run …`.
- Local env: `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label r7
  --server`. Playwright needs `PLAYWRIGHT_BASE=$SMOKE_BASE E2E_PROD_TARGET=1`
  from `apps/web` — `E2E_PROD_TARGET` is a FLAG, not a URL, and the preflight's
  own error message does not say so.

---

## 1. Cricket's innings-1 headline bar  (small, well-understood)

**State today.** `cricket.tsx` declares
`ownsHeadline: (view) => (asState(view.state).innings ?? []).length === 0`, so
the chassis bar is suppressed before a ball is bowled — it used to read
`— — —`. Once any innings exists the bar returns.

**What is left.** During the FIRST innings the bar reads `1/0 (0.1) — —`: the
batting side's line, which the two halves already show, plus a dash for a side
that has not batted. Not empty, so not the defect that was fixed — but still
mostly duplication.

**Why it was not done in R7.** Any rule separating "innings 1" from "innings 2"
must survive three shapes, and getting it wrong is worse than leaving it:

- **Test matches** (`inningsPerSide: 2`) — four innings, and `sideLine` joins a
  side's innings with `" & "`. "The other side has not batted" is NOT the same
  question as "we are in the first innings".
- **Super overs** — the headline appends ` · SO n–n`, which the halves do not
  carry. Never suppress a headline carrying a super-over suffix.
- **DLS / revised targets** — the strip's chase chip comes from `chaseTarget`,
  which returns null for an ENTIRE Test match unless someone explicitly
  revised. **Do NOT gate on `chaseTarget`**: `headline-ownership.test.ts` has an
  assertion specifically forbidding it, with the reasoning.

**Suggested shape** (not a ruling — verify before building): suppress while
exactly one side has any innings AND there is no super-over suffix. Derive both
from state, never by string-matching the rendered headline.

**Acceptance.** Extend the `cricket answers per STATE` block in
`apps/web/src/components/v2/scorepad/v3/__tests__/headline-ownership.test.ts`,
covering with REAL folds: pre-innings, mid-innings-1, mid-innings-2, a super
over, and a Test-shaped config. Mutation-prove by flipping the predicate both
ways. Then drive it in a browser — the `— — —` defect was found by looking at a
screenshot, not by a test.

## 2. The fixture HEADER card also shows `— — —`

A separate component from the pad (the page header above `Scoring`), so R7/D's
`ownsHeadline` does not reach it. Same noise, same cause: it renders
`summary.headline` verbatim. Decide whether the header should carry a result
line at all before a match has produced one. Verify by loading a
freshly-started cricket fixture and LOOKING at it.

## 3. R7-41 — type `TileSpec.label` / `SheetChoiceStep.title` as `MessageKey`

**Costed on this branch: 19 tsc errors across 6 files.** Not a mechanical
rename — it is blocked on one thing:

`apps/web/src/components/v2/scorepad/v3/skins/period-shared.ts` builds ~7 keys
at RUNTIME from the sport slug (`` t(`pad.${spec.key}.strip.shootout`) ``). A
template string cannot be a `MessageKey`. **That module needs a per-sport table
of literal keys FIRST**; the typing change is straightforward afterwards.

**Why it matters.** `tile-grid.tsx` calls `t(tile.label)` directly, bypassing
`PAD_LABEL_KEYS` entirely — which is how a raw
`pad.boardgame.scorebug.result.hint` key rendered on screen during R7, caught
only by a screenshot while every gate was green. The typing closes that class.

## 4. Standing check, earned twice on this branch

**When you stop rendering a component, enumerate EVERY feature it hosts — not
just the one you are reasoning about.**

- R7-46: a ledger consolidation left another wave's `isPartial` prop wired to a
  panel that surface no longer renders. The partial badge worked on
  `/score/[token]` and was invisible on the organiser console.
- R7-48: `lineupEditorApplies` correctly hid the lineup CONTROLS for
  one-competitor sports and took the AVAILABILITY chips with them, because they
  shared a component.

Neither was catchable by unit tests, for the same structural reason: a gate's
own tests assert what the gate DOES, never what it takes with it. Both were
found by e2e.
