# Overlay End-of-Over + Match Openers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship cricket match openers (slate vs + toss center card) and an anchored end-of-over summary card queued behind W2 moment slabs on `/overlay/fixtures/[id]`.

**Architecture:** Promote `cricketToss` and `lastClosedOver` from the existing scorecard fold onto `OverlayLiveData` (same path as `cricketLive`). Client pure helpers detect eligibility and build queue items. Widen the **existing** moment FIFO to carry structured `endOfOver` / `toss` kinds (render branch in the stage slot) — do **not** ship the full composition-seam `OVERLAY_PANELS` registry in this wave. Slate warming headline becomes team names; toss card is a center overlay on bar/bug only.

**Tech Stack:** Next App Router, React 19, TypeScript, vitest (`environment: "node"`), existing overlay W2 queue (`moment-queue.ts`), `@seazn/engine` `deriveCricketScorecard`, four-locale `public.json`.

**Spec:** `docs/superpowers/specs/2026-09-12-overlay-end-of-over-and-openers-design.md`

## Global Constraints

- One renderer: `/overlay/fixtures/[id]` only; theme-agnostic projection.
- Motion: `transform`/`opacity` only; no mount/reconnect replay; reduced motion = instant fold, same hold.
- End-of-over on **bar + bug** only; slate out of scope for that panel.
- i18n: new `overlay.*` keys in en/es/fr/nl; never bind to `matchCentre.*`.
- Consent-resolved player names via existing overlay person resolver.
- pnpm; vitest from `apps/web`; no snapshot tests.
- Worktree: `.claude/worktrees/overlay-end-of-over` on `feat/overlay-end-of-over`.

## File map

| File | Role |
|---|---|
| `lib/overlay-cricket.ts` | Add `OverlayCricketToss`, `OverlayClosedOver`; builders from scorecard |
| `lib/overlay-recent-types.ts` / `live-score-data.ts` | Wire fields on `OverlayLiveData` |
| `server/overlay/recent.ts` + `load.ts` / `project.ts` | Emit toss + lastClosedOver + scoringStarted |
| `lib/overlay-openers.ts` | Pure: A2 eligibility + toss moment builder |
| `lib/overlay-end-of-over.ts` | Pure: closed-over → queue item (compact/full) |
| `lib/overlay-moments.ts` | Allow `endOfOver` / `toss` kinds through queue identity |
| `components/overlay/overlay-end-of-over.tsx` | Split + compact card UI |
| `components/overlay/overlay-toss-card.tsx` | Center toss card UI |
| `components/overlay/overlay-stage.tsx` | Merge openers/end-of-over into queue; branch render |
| `components/overlay/overlay-slate.tsx` | A1 headline = Home vs Away |
| `dictionaries/{en,es,fr,nl}/public.json` | New keys |
| `moment-timing.ts` | `OVERLAY_TOSS_HOLD_MS = 8000` |

---

### Task 1: i18n keys

**Files:**
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`
- Run: `pnpm i18n:gen-keys` from repo root (or apps/web per package scripts)

**Keys (en):**
- `overlay.slate.warmingHeadlineVs`: `{home} vs {away}`
- `overlay.slate.warmingLineTossPending`: `Toss pending · {start}` (keep time/venue in `{start}` from existing context)
- `overlay.toss.wonAndElected`: `{team} won the toss and elected to {choice}`
- `overlay.toss.bat` / `overlay.toss.bowl`: `bat` / `bowl`
- `overlay.endOfOver.title`: `End of over {over}`
- `overlay.endOfOver.runsScore`: `{runs} runs · {score}`
- `overlay.endOfOver.thisOver`: `This over` (or reuse `overlay.cricket.thisOver`)

- [ ] **Step 1:** Add keys to all four locales (ES/FR/NL real translations, not English copies).
- [ ] **Step 2:** Run `pnpm i18n:gen-keys` and `pnpm i18n:check`.
- [ ] **Step 3:** Commit.

---

### Task 2: Scorecard → overlay toss + lastClosedOver

**Files:**
- Modify: `apps/web/src/lib/overlay-cricket.ts`
- Modify: `apps/web/src/components/public-site/live-score-data.ts` (`OverlayLiveData`)
- Modify: `apps/web/src/server/overlay/project.ts` / `load.ts` / cached fold path that already builds `cricketLive`
- Test: `apps/web/src/lib/__tests__/overlay-cricket.test.ts`
- Test: `apps/web/src/server/overlay/__tests__/…` (extend existing project/load tests)

**Interfaces:**
```ts
export type OverlayCricketToss = {
  wonBySide: 0 | 1;
  elected: "bat" | "bowl";
};

export type OverlayClosedOver = {
  /** 1-based over number in the active innings (or last closed innings). */
  over: number;
  runs: number;
  wickets: number;
  /** e.g. "142/6" from scoreAfter */
  score: string;
  glyphs: BallGlyph[];
  bowler?: OverlayCricketBowler;
  batters: OverlayCricketBatter[]; // may be empty → compact
};

// On OverlayLiveData:
cricketToss?: OverlayCricketToss | null;
lastClosedOver?: OverlayClosedOver | null;
/** True once any ball or over-summary has been recorded. */
scoringStarted?: boolean;
```

- [ ] **Step 1:** Failing tests: toss from scorecard with home wonBy → `wonBySide: 0`; last completed `OverLog` → `lastClosedOver`; incomplete current over not published as lastClosed; coarse over with empty glyphs still yields runs/score.
- [ ] **Step 2:** Implement `tossFromScorecard`, `lastClosedOverFromScorecard`, `scoringStartedFromScorecard` in `overlay-cricket.ts`.
- [ ] **Step 3:** Emit on load/project beside `cricketLive` (same scorecard derive).
- [ ] **Step 4:** Tests pass; commit.

---

### Task 3: Pure client builders — openers + end-of-over queue items

**Files:**
- Create: `apps/web/src/lib/overlay-openers.ts`
- Create: `apps/web/src/lib/overlay-end-of-over.ts`
- Create: `apps/web/src/lib/__tests__/overlay-openers.test.ts`
- Create: `apps/web/src/lib/__tests__/overlay-end-of-over.test.ts`
- Modify: `apps/web/src/lib/overlay-moments.ts` — extend `OverlayMoment` with optional `endOfOver?: OverlayClosedOver` and `graphic?: "slab" | "endOfOver" | "toss"` (default slab)

**Produces:**
```ts
// overlay-openers.ts
export function tossMoment(args: {
  toss: OverlayCricketToss;
  sideNames: [string, string];
  scoringStarted: boolean;
  msg: OverlayMsg;
  /** Synthetic seq: use lastSeq or 0; identity `toss:0` once. */
  seq: number;
}): OverlayMoment | null;

// overlay-end-of-over.ts
export function endOfOverMoment(args: {
  closed: OverlayClosedOver;
  sinceOver: number; // baseline: lastClosedOver.over at mount
  msg: OverlayMsg;
  seq: number; // use closed.over as stable id half
}): OverlayMoment | null;

export function isFullEndOfOver(closed: OverlayClosedOver): boolean;
```

Rules:
- `tossMoment`: null if `scoringStarted` or toss missing; else kind `toss`, graphic `toss`, headline from dictionary.
- `endOfOverMoment`: null if `closed.over <= sinceOver`; else kind `endOfOver`, graphic `endOfOver`, attach `endOfOver` payload; compact vs full via `isFullEndOfOver` (needs named bowler OR glyphs length > 0 OR named batters — full only if glyphs.length > 0 && (bowler?.name || batters some named); else compact).

- [ ] **Step 1:** Failing unit tests for null/eligible/compact/full/once-per-over.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit.

---

### Task 4: Queue hold for toss + stage merge

**Files:**
- Modify: `apps/web/src/components/overlay/moment-timing.ts` — add `OVERLAY_TOSS_HOLD_MS = 8000`
- Modify: `apps/web/src/components/overlay/use-moment-queue.ts` — if enqueued item has `graphic === "toss"`, use toss hold (or pass hold per item; simplest: when promoting toss, hold 8000)
- Modify: `apps/web/src/components/overlay/overlay-stage.tsx`
- Test: extend `moment-queue.test.ts` / hook tests if hold is per-kind

**Stage merge (order matters):**
```ts
const moments = momentsFor(...);
const eoo = endOfOverMoment({ closed: data.lastClosedOver, sinceOver: closedBaseline, ... });
const toss = tossMoment({ toss: data.cricketToss, scoringStarted: data.scoringStarted, ... });
// Enqueue: [...moments, ...(eoo ? [eoo] : []), ...(toss ? [toss] : [])]
// Moments first so OUT before end-of-over; toss only when no scoring (won't clash mid-over).
```

Baselines at mount:
- `momentBaseline = maxSeq(initial.recent)` (existing)
- `closedOverBaseline = initial.lastClosedOver?.over ?? 0` — never fire historical overs

- [ ] **Step 1:** Test: OUT then endOfOver order in reducer when both enqueued.
- [ ] **Step 2:** Wire stage; commit.

---

### Task 5: Slate A1 — names as headline

**Files:**
- Modify: `apps/web/src/components/overlay/overlay-slate.tsx`
- Modify: `apps/web/src/components/overlay/__tests__/overlay-slate.test.tsx`

Warming branch:
- Headline: `msg("overlay.slate.warmingHeadlineVs", { home, away })`
- Line: `msg("overlay.slate.warmingLineTossPending", { start: model.header.context })`

Keep old keys in dictionaries unused or redirect tests.

- [ ] **Step 1:** Update slate tests expectations.
- [ ] **Step 2:** Implement; commit.

---

### Task 6: UI components — toss card + end-of-over card

**Files:**
- Create: `apps/web/src/components/overlay/overlay-toss-card.tsx`
- Create: `apps/web/src/components/overlay/overlay-end-of-over.tsx`
- Modify: `apps/web/src/app/globals.css` (or overlay CSS section) — center toss; split end-of-over beside moment slot geometry
- Modify: `apps/web/src/components/overlay/overlay-stage.tsx` — render branch on `moment.graphic`
- Test: node render tests asserting text/testids for compact + full + toss

**End-of-over:** split layout (spec D5); compact single line; `data-testid="ovl-end-of-over"` `data-variant="full"|"compact"`.
**Toss:** centered on canvas; `data-testid="ovl-toss-card"`; only when style is bar or bug (stage gate: if style===slate && graphic===toss, skip — toss is for bar/bug).

- [ ] **Step 1:** Failing render tests.
- [ ] **Step 2:** Implement CSS + components + stage branch.
- [ ] **Step 3:** Commit.

---

### Task 7: Regression + dictionary coverage

- [ ] Run `pnpm exec vitest run src/components/overlay src/lib/__tests__/overlay- src/server/overlay` from `apps/web`.
- [ ] Extend `overlay-moment-dictionary.test.ts` (or sibling) for new keys × 4 locales.
- [ ] Fix failures; commit.

---

## Spec coverage check

| Spec item | Task |
|---|---|
| A1 slate names | 5 |
| A2 toss bar/bug 8s | 3, 4, 6 |
| A2 clears on scoring | 2 (`scoringStarted`), 3 |
| B full split / compact | 3, 6 |
| B queue behind moments | 4 |
| B bar+bug only | 6 stage gate |
| Data promote first | 2 |
| i18n own keys | 1, 7 |
| No mount replay | 4 baselines |

## Placeholder scan

None intentional. Composition seam `OVERLAY_PANELS` deferred explicitly (pragmatic: stage slot branch).
