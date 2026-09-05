# Spectator W1 — Match Centre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the public fixture page (`/shared/[org]/[comp]/[div]/fixtures/[id]`) into a match centre for every sport — cricket with a full scorecard and commentary read from the ledger, every other sport with a Timeline and a Sets/Periods tab — that updates in place while a match is live.

**Architecture:** A pure engine fold (`deriveCricketScorecard`) replays the cricket reducer event by event and diffs its state, so no ball rule is written twice. A web view model (`buildMatchCentre`) turns the fold, the ledger, the lineups and the consent resolver into one JSON document that BOTH the server render and the existing poll/Realtime refresh carry (`GET /api/v1/public/fixtures/{id}` gains `match_centre`). A client `MatchCentre` component renders the W0 option A composition (court card → tab rail → tab body) from that document and re-renders every tab on refresh.

**Tech Stack:** TypeScript 7, Node 26, pnpm; Next.js (App Router, `output: standalone`); `@seazn/engine` (zod schemas, `SportModule`); vitest (`environment: "node"` in `apps/web`, no DOM); Playwright (`walkthrough` project, seven-width `mobile.spec.ts` projects); Supabase Realtime + 15 s poll; Tailwind with the public-site tokens.

**Spec:** `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` (§"The shared model", §W1, standing rules R1–R10). Programme rules: `docs/superpowers/specs/2026-09-04-spectator-prompts/_RULES.md`. Prompt: `.../W1-match-centre.md`. W0 canvas (option A is the composition): https://claude.ai/code/artifact/f745adf2-fd1f-4f14-9184-ba6f0eb41978

## Global Constraints

- Worktree `.claude/worktrees/spectator`, branch `feat/spectator-surface`; never the main checkout. `pnpm install --frozen-lockfile`; **pnpm, never `npm install`**.
- Every string through the `public` dictionary namespace in **all four locales** `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (flat dotted keys), then `npm run i18n:gen-keys` (regenerates `apps/web/src/lib/i18n-keys.ts` — never hand-edit it). Cricket column abbreviations R B 4s 6s SR · O M R W Econ stay as notation with localised `title`.
- Every person name goes through `resolvePersonDisplayName(fullName, consent, divisionSetting, youth)` (`apps/web/src/lib/name-display.ts:72`). Never a second resolver. A masked person renders the masked label, never a blank row.
- Fidelity from the engine: `padSpec(cfg).fidelity` (`packages/engine/src/sports/cricket/cricket.ts:2985`), scale `FIDELITY = {0:"result",1:"card",2:"timeline",3:"detail"}` (`packages/engine/src/sport/module.ts:96`). Render tabs by PRESENCE; an empty tab is never rendered.
- One authority per fact: ball semantics = the cricket reducer (`cricket.apply`), replayed — never re-implemented. Result/margin = `cricket.summary(state)`. Chase target = `chaseTarget(state)` (exported in Task 1).
- No new entitlement rows. Realtime stays behind `org_has_feature(...,'realtime',...)`; poll otherwise. `org.branded` decides the footer. Nothing in the entitlements v18 matrix or copy is touched.
- Live means live, never reload (R10): the refresh path re-renders every tab from the new document; the walkthrough opens the anonymous page BEFORE the taps and never navigates it.
- Phone composition, not shrink (R1): one DOM, `max-md:*` branches; ≥768 adds columns, never controls; every scrolling region has `tabindex="0"`, a role and an accessible name; no horizontal page scroll at 320/360/375/390/430/768/834.
- Testids: `mc-*` on every new control. Assertions on Next HTML anchor on `="` (an omitted prop serialises as `"$undefined"`).
- Subagents: Opus at minimum (frontmatter); scoped vitest/tsc only — the orchestrator runs the full gate with `--reporter=json --outputFile` and judges `numTotalTests`/`numFailedTests`, never exit codes. `cd` to the worktree in the SAME call as any verify command.
- Commit after every task with a normal-prose message ending in the two trailers:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01TCLYbFJZ8bseHS4kp4nGDa`.
  In this worktree, git commands are plain `/usr/bin/git <verb> …` with no compound shell around them (the isolation guard refuses anything else).
- Do NOT touch: the scorepad and its skins, the cricket reducer's logic (type exports and one `export` keyword on `chaseTarget` only), the organiser console, the landscape OG card, registration pages, the `present` slides, `e2e.yml`.

---

## File structure

**Engine (`packages/engine/src/sports/cricket/`)**
- `scorecard.ts` — NEW. `deriveCricketScorecard(input)`: replays `cricket.init` + `cricket.apply` over the ledger, diffs state per event, returns `CricketScorecard`. Pure. No I/O, no i18n.
- `scorecard-types.ts` — NEW. The `CricketScorecard` family of types (also imported by the web app).
- `cricket.ts` — MODIFY: `export` on `interface FineInnings` (line 410), `interface CricketState` (line 456) and `function chaseTarget` (line 705). No logic change.
- `index.ts` (or the folder's barrel the exports map resolves — pin it) — MODIFY: re-export the fold and types.
- `__tests__/scorecard-ledger.ts` — NEW test helper: scripted ledger builder that derives `over`/`ballInOver` from the reducer's own state.
- `__tests__/scorecard.test.ts` — NEW.

**Web server (`apps/web/src/server/public-site/`)**
- `match-centre-schema.ts` — NEW. zod schemas for the match-centre document (the API response is generated from zod, so the document must be a schema) + inferred types.
- `public-lineups.ts` — NEW. `readPublicLineups(sql, fixtureId, division)`: fixture lineups joined to persons with consent, names resolved through `resolvePersonDisplayName`.
- `match-centre.ts` — NEW. `buildMatchCentre(...)`: sport-agnostic header/tabs/info + `cricket` view + `timeline` + `sets`.
- `timeline.ts` — NEW. `buildTimeline(...)` and `buildSets(...)` for every non-cricket sport.
- `data.ts` — MODIFY: `getPublicFixture` returns `matchCentre`.
- `../usecases/public.ts` — MODIFY: `publicFixture(fixtureId)` returns `match_centre`.
- `../../app/api/v1/public/fixtures/[id]/route.ts` — unchanged code, response schema grows (OpenAPI regen).

**Web UI (`apps/web/src/components/public-site/match-centre/`)**
- `use-live-fixture.ts` — NEW. The transport hook extracted from `live-score.tsx` (poll + Realtime), returning the whole poll payload.
- `match-centre.tsx` — NEW client root. `court-card.tsx`, `tab-rail.tsx`, `summary-tab.tsx`, `scorecard-tab.tsx`, `commentary-tab.tsx`, `timeline-tab.tsx`, `sets-tab.tsx`, `info-tab.tsx`, `stat-table.tsx` (shared table primitives), `glyphs.tsx` (ball glyphs).
- `../live-score.tsx` — MODIFY: becomes the non-cricket Summary body (`LiveScoreBody`) and stops owning transport.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` — MODIFY: renders `<MatchCentre>`; metadata carries the score when final.

**Dictionaries**: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (+ `i18n:gen-keys`).

**Tests**: engine `__tests__/scorecard.test.ts`; web `apps/web/src/server/public-site/__tests__/{match-centre,timeline,public-lineups,match-centre-dictionary}.test.ts`; UI `apps/web/src/components/public-site/match-centre/__tests__/*.test.tsx` (static markup via `renderToStaticMarkup`); `apps/web/e2e/walkthrough/spectator-public.spec.ts`; `apps/web/e2e/mobile.spec.ts` (one added case); `scripts/smoke.ts` (one added check).

---

### Task 1: Engine — export the seams and fold the totals by replaying the reducer

**Files:**
- Modify: `packages/engine/src/sports/cricket/cricket.ts:410` (`interface FineInnings`), `:456` (`interface CricketState`), `:705` (`function chaseTarget`) — add `export`, nothing else.
- Create: `packages/engine/src/sports/cricket/scorecard-types.ts`
- Create: `packages/engine/src/sports/cricket/scorecard.ts`
- Create: `packages/engine/src/sports/cricket/__tests__/scorecard-ledger.ts`
- Test: `packages/engine/src/sports/cricket/__tests__/scorecard.test.ts`

**Interfaces:**
- Consumes: `cricket` module object (`cricket.ts:3007`: `init(cfg, lineups)`, `apply(state, ev, ctx)`, `summary(state)`), `CricketCfg` (`cricket.ts:137`), `CricketBallEv`, `EventEnvelope` and `LineupPair` from `@seazn/engine/core` / `@seazn/engine/sport` (pin the exact import paths from `apps/web/src/server/engine-db/fold.ts`, which already imports them).
- Produces: `deriveCricketScorecard(input: ScorecardInput): CricketScorecard` with `input = { events: readonly EventEnvelope[]; cfg: CricketCfg; lineups: LineupPair }`; the types below.

- [ ] **Step 1: Write the types**

`packages/engine/src/sports/cricket/scorecard-types.ts`:

```ts
import type { FidelityBand } from "../../sport/module.ts";

export type SideId = string;
export type PersonId = string;

export type DismissalKind =
  | "bowled" | "caught" | "lbw" | "runout" | "stumped" | "hitwicket"
  | "retired" | "obstructed" | "timedout" | "hitballtwice";

export interface BattingLine {
  order: number;                 // 1-based batting position
  person: PersonId;
  runs: number;
  balls: number;
  fours: number | null;          // null when the ledger cannot say (band 2)
  sixes: number | null;
  strikeRate: number | null;     // runs*100/balls, null when balls === 0
  dismissal:
    | { kind: "not_out" }
    | { kind: "out_unknown" }    // band 2: the line said out, nothing more
    | { kind: DismissalKind; bowler: PersonId | null; fielder: PersonId | null; fielderAssist: PersonId | null };
}

export interface BowlingLine {
  person: PersonId;
  legalBalls: number;
  overs: string;                 // "2.3"
  maidens: number | null;        // null at band 2
  runs: number;
  wickets: number;
  economy: number | null;        // runs*6/legalBalls, null when legalBalls === 0
  wides: number | null;
  noBalls: number | null;
}

export type BallGlyph =
  | { kind: "runs"; runs: 0 | 1 | 2 | 3 | 4 | 6 | number }
  | { kind: "wide"; runs: number }
  | { kind: "noball"; runs: number }
  | { kind: "bye" | "legbye" | "penalty"; runs: number }
  | { kind: "wicket"; dismissal: DismissalKind };

export interface OverLog {
  number: number;                // 1-based
  bowler: PersonId | null;
  balls: BallGlyph[];
  runs: number;                  // conceded in the over (all runs incl. extras)
  wickets: number;
  scoreAfter: { runs: number; wickets: number };
}

export interface FallOfWicket {
  wicket: number;                // 1-based
  runs: number;                  // team score at the fall
  over: string;                  // "3.2"
  batter: PersonId;
}

export interface Partnership {
  batters: [PersonId, PersonId];
  runs: number;
  balls: number;
  wicket: number | "unbroken";
}

export interface CricketInningsCard {
  number: number;                // 1-based
  side: SideId;
  isSuperOver: boolean;
  declared: boolean;
  closed: boolean;
  total: { runs: number; wickets: number; legalBalls: number; overs: string; runRate: number | null };
  extras: { wides: number; noBalls: number; byes: number; legByes: number; penalties: number; total: number } | null; // null at band ≤ 2
  batting: BattingLine[];
  didNotBat: PersonId[];
  bowling: BowlingLine[];
  fallOfWickets: FallOfWicket[];
  partnerships: Partnership[];
  overs: OverLog[];
}

export interface CricketLive {
  battingSide: SideId;
  striker: PersonId | null;
  nonStriker: PersonId | null;
  bowler: PersonId | null;
  thisOver: BallGlyph[];
  partnership: { runs: number; balls: number } | null;
  lastWicket: { batter: PersonId; runs: number; balls: number; scoreAt: string } | null;
  crr: number | null;
  target: number | null;
  rrr: number | null;
  needRuns: number | null;
  ballsLeft: number | null;
  projected: number | null;
}

export interface CricketScorecard {
  band: FidelityBand;            // max band present in the ledger
  toss: { wonBy: SideId; elected: "bat" | "bowl" } | null;
  innings: CricketInningsCard[];
  live: CricketLive | null;
  result: { headline: string; margin: unknown; winner: SideId | null } | null; // from cricket.summary / outcome
}
```

- [ ] **Step 2: Write the ledger builder used by every fold test**

`packages/engine/src/sports/cricket/__tests__/scorecard-ledger.ts` — builds envelopes by REPLAYING the reducer so `over`/`ballInOver` are always what the strict fold expects (the W0 harness proved the derivation `over = floor(legalBalls/6)`, `ballInOver = legalBalls % 6 + 1`):

```ts
import { cricket } from "../cricket.ts";
import type { CricketCfg, CricketState } from "../cricket.ts";

export type Delivery =
  | { bat: 0 | 1 | 2 | 3 | 4 | 6 }
  | { extra: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number; bat?: number }
  | { out: "bowled" | "caught" | "lbw" | "runout" | "stumped" | "hitwicket" | "obstructed" | "timedout" | "hitballtwice"; fielder?: string; assist?: string; bat?: number }
  | { retire: true };

export interface Script {
  cfg: Partial<CricketCfg>;
  home: string[];               // person ids in batting order
  away: string[];
  tossWonBy: "home" | "away";
  elected: "bat" | "bowl";
  innings: Array<{ batting: "home" | "away"; bowlers: string[]; deliveries: Delivery[]; close?: "all_out" | "overs_complete" | "target_reached" | "time" | "other" }>;
}

/** Returns the envelopes AND the reducer's final state, so tests can assert parity. */
export function scriptLedger(script: Script): { events: EventEnvelope[]; state: CricketState; cfg: CricketCfg; lineups: LineupPair } {
  // 1. cfg = cricket.configSchema.parse({ ...script.cfg })
  // 2. lineups = { home: script.home.map(...slot...), away: ... } in the LineupPair shape fold.ts builds
  // 3. state = cricket.init(cfg, lineups); seq = 0
  // 4. push core.start, then cricket.toss { wonBy: <entrantId>, elected } — toss BEFORE core.start is what the
  //    API enforces (422 WRONG_PHASE) — check the reducer's order requirement and mirror it here.
  // 5. for each innings: striker = order[0], nonStriker = order[1], nextIn = 2; for each delivery:
  //      over = floor(legalBalls/bpo), ballInOver = legalBalls % bpo + 1, bowler = bowlers[over % bowlers.length]
  //      build the CricketBall payload, envelope it, state = cricket.apply(state, env, { strictFold: true })
  //      read striker/nonStriker back FROM state.innings[at].fine (never track them locally)
  //    then cricket.innings.close { reason } when script says so
  // 6. return { events, state, cfg, lineups }
}
```

Write it fully (the comments above are the algorithm; the code is ~90 lines). Envelope shape: copy from `apps/web/src/server/engine-db/fold.ts:58-135` (`{ seq, type, payload, at }` — pin the exact fields).

- [ ] **Step 3: Write the first failing tests — totals parity and band**

```ts
// packages/engine/src/sports/cricket/__tests__/scorecard.test.ts
import { describe, it, expect } from "vitest";
import { deriveCricketScorecard } from "../scorecard.ts";
import { cricket } from "../cricket.ts";
import { scriptLedger } from "./scorecard-ledger.ts";

const HOME = ["h1","h2","h3","h4","h5","h6","h7","h8"];
const AWAY = ["a1","a2","a3","a4","a5","a6","a7","a8"];

export const TWO_INNINGS = {
  cfg: { ballsPerInnings: 12, playersPerSide: 8 },   // 2 overs a side keeps the fixture readable
  home: HOME, away: AWAY, tossWonBy: "home", elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7","a8"], deliveries: [
      { bat: 1 }, { bat: 4 }, { extra: "wide", runs: 1 }, { bat: 0 }, { out: "caught", fielder: "a3" }, { bat: 2 }, { bat: 6 },
      { extra: "noball", runs: 1, bat: 2 }, { bat: 0 }, { extra: "bye", runs: 1 }, { out: "runout", fielder: "a5", assist: "a6", bat: 1 }, { extra: "legbye", runs: 1 }, { bat: 3 } ] },
    { batting: "away", bowlers: ["h7","h8"], deliveries: [
      { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 },   // a maiden
      { bat: 4 }, { out: "bowled" }, { out: "lbw" }, { out: "stumped", fielder: "h1" }, { extra: "penalty", runs: 5 }, { bat: 1 } ] },
  ],
} as const;

describe("deriveCricketScorecard — totals", () => {
  it("empty ledger → no innings, no live, band 0, result null (EMPTY CASE FIRST)", () => {
    const { cfg, lineups } = scriptLedger({ ...TWO_INNINGS, innings: [] });
    const card = deriveCricketScorecard({ events: [], cfg, lineups });
    expect(card.innings).toEqual([]);
    expect(card.live).toBeNull();
    expect(card.result).toBeNull();
    expect(card.band).toBe(0);
  });

  it("innings totals equal the reducer's own summary on the same ledger (parity)", () => {
    const { events, state, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    const summary = cricket.summary(state) as { detail: { innings: Array<{ runs: number; wickets: number; legalBalls: number }> } };
    expect(card.innings.map((i) => [i.total.runs, i.total.wickets, i.total.legalBalls]))
      .toEqual(summary.detail.innings.map((i) => [i.runs, i.wickets, i.legalBalls]));
  });

  it("extras are counted by kind and sum to the innings' extras", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1.extras).toEqual({ wides: 1, noBalls: 1, byes: 1, legByes: 1, penalties: 0, total: 4 });
  });

  it("band is the max band present: balls → 3", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    expect(deriveCricketScorecard({ events, cfg, lineups }).band).toBe(3);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run (from the worktree root, same call): `cd <worktree> && pnpm --filter @seazn/engine exec vitest run src/sports/cricket/__tests__/scorecard.test.ts --reporter=json --outputFile=/tmp/spx-eng.json; node -e "const r=require('/tmp/spx-eng.json');console.log(r.numTotalTests,r.numFailedTests)"`
Expected: collection fails (`scorecard.ts` missing) → fix the ledger builder first if IT fails to compile; then 4 total, 4 failed.

- [ ] **Step 5: Implement the replay fold (totals, extras, band)**

`packages/engine/src/sports/cricket/scorecard.ts`:

```ts
import { cricket, chaseTarget, padSpec, type CricketCfg, type CricketState, type FineInnings } from "./cricket.ts";
import type { EventEnvelope } from "../../core/events.ts";        // pin path from fold.ts
import type { LineupPair } from "../../sport/module.ts";           // pin path
import type { FidelityBand } from "../../sport/module.ts";
import type { CricketScorecard, CricketInningsCard, BallGlyph, OverLog, FallOfWicket, Partnership, BattingLine, BowlingLine, CricketLive } from "./scorecard-types.ts";

export interface ScorecardInput { events: readonly EventEnvelope[]; cfg: CricketCfg; lineups: LineupPair }

export function deriveCricketScorecard({ events, cfg, lineups }: ScorecardInput): CricketScorecard {
  const bands = padSpec(cfg).fidelity;
  let band: FidelityBand = 0;
  let state = cricket.init(cfg, lineups);
  const acc = new InningsAccumulator(cfg, lineups);          // per-innings running tallies built from state diffs
  let toss: CricketScorecard["toss"] = null;

  for (const ev of events) {
    const before = state;
    state = cricket.apply(state, ev as never, { strictFold: false });   // the ledger is already validated
    const b = bands[ev.type];
    if (b !== undefined && b > band) band = b;
    if (ev.type === "cricket.toss") toss = { wonBy: (ev.payload as { wonBy: string }).wonBy, elected: (ev.payload as { elected: "bat" | "bowl" }).elected };
    if (ev.type === "cricket.ball" || ev.type === "cricket.superover.ball") acc.onBall(before, state, ev);
    if (ev.type === "cricket.player.line") acc.onLine(state, ev);
    if (ev.type === "cricket.innings.summary") acc.onSummary(state, ev);
    acc.syncTotals(state);                                    // totals ALWAYS come from state, never from our tallies
  }
  const summary = cricket.summary(state);
  const outcome = cricket.outcome(state);
  return {
    band,
    toss,
    innings: acc.cards(state),
    live: acc.live(state, chaseTarget),
    result: outcome ? { headline: summary.headline, margin: (summary as { detail?: { margin?: unknown } }).detail?.margin ?? null, winner: outcome.winner ?? null } : null,
  };
}
```

Implement `InningsAccumulator` in the same file: for each innings index it keeps `overs: OverLog[]`, `fow: FallOfWicket[]`, `partnerships`, `extrasByKind`, `fours/sixes` per batter, `wides/noBalls` per bowler, `maidens` per bowler (an over is a maiden when its `runs` conceded by the bowler — bat runs + wides + no-balls, NOT byes/leg-byes/penalties — is 0 and it has `cfg.ballsPerOver` legal balls). `onBall(before, after, ev)`: read `after.innings[i].fine` (`FineInnings`) — `batterRuns/batterBalls/bowlerBalls/bowlerRuns/bowlerWickets/dismissed/striker/nonStriker/currentBowler` — and the payload (`runs.bat`, `runs.extras`, `wicket`, `boundary`) to append the glyph, update the over log, and on a wicket push a `FallOfWicket` with `runs: after.innings[i].runs` and `over: fmtOvers(after.innings[i].legalBalls)`. `syncTotals` copies `runs/wickets/legalBalls/declared/closed` from state. For this task only totals, extras and band need to be right; Tasks 2–3 fill the rest, but write the accumulator's skeleton with every field now so later tasks only add logic.

`fmtOvers(legalBalls, bpo)` → `${Math.floor(lb/bpo)}.${lb % bpo}`.

- [ ] **Step 6: Run to verify they pass**

Same command. Expected: 4 total, 0 failed. Then run the WHOLE engine suite scoped to cricket to prove the `export` additions changed nothing: `pnpm --filter @seazn/engine exec vitest run src/sports/cricket --reporter=json --outputFile=/tmp/spx-eng-all.json` and compare `numTotalTests` with the same run on `main` (record both numbers in the commit message).

- [ ] **Step 7: Commit**

`/usr/bin/git add packages/engine/src/sports/cricket` then `/usr/bin/git commit -F <message file>` — message: "engine(cricket): scorecard fold — totals, extras by kind, fidelity band, by replaying the reducer" + the two trailers.

---

### Task 2: Engine — batting and bowling lines, did-not-bat

**Files:**
- Modify: `packages/engine/src/sports/cricket/scorecard.ts` (accumulator: `cards()` batting/bowling)
- Test: `packages/engine/src/sports/cricket/__tests__/scorecard.test.ts`

**Interfaces:**
- Consumes: `FineInnings.batterRuns/batterBalls/bowlerBalls/bowlerRuns/bowlerWickets/dismissed/retiredNotOut`, ball payload `boundary`, `wicket`, `runs.extras`.
- Produces: `CricketInningsCard.batting: BattingLine[]` in batting ORDER (order of first appearance at the crease, from the lineup order for openers), `bowling: BowlingLine[]` in order of first over bowled, `didNotBat` = lineup persons of the batting side never at the crease.

- [ ] **Step 1: Failing tests**

```ts
describe("deriveCricketScorecard — batting and bowling", () => {
  it("batting lines carry runs, balls, 4s, 6s, SR and the dismissal with credit", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const h1 = inn1.batting.find((b) => b.person === "h1")!;
    expect(h1.fours).toBe(1);            // the 4 off ball 2 — derive from the SCRIPT, not typed by hand: count {bat:4} while h1 faced
    expect(h1.strikeRate).toBe(Math.round((h1.runs * 100) / h1.balls * 10) / 10);
    const caught = inn1.batting.find((b) => b.dismissal.kind === "caught")!;
    expect(caught.dismissal).toEqual({ kind: "caught", bowler: "a7", fielder: "a3", fielderAssist: null });
    const runout = inn1.batting.find((b) => b.dismissal.kind === "runout")!;
    expect(runout.dismissal).toMatchObject({ kind: "runout", bowler: null, fielder: "a5", fielderAssist: "a6" });
  });

  it("a wide and a no-ball count against the bowler; byes, leg-byes and penalties do not", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1, inn2] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const a7 = inn1.bowling.find((b) => b.person === "a7")!;
    expect(a7.wides).toBe(1);
    // runs conceded by a7 = bat runs off a7 + wides + no-ball runs, minus nothing else — assert against the
    // reducer: inn1.total.runs - byes - legByes - penalties === sum(bowling.runs)
    const conceded = inn1.bowling.reduce((s, b) => s + b.runs, 0);
    expect(conceded).toBe(inn1.total.runs - inn1.extras!.byes - inn1.extras!.legByes - inn1.extras!.penalties);
    expect(inn2.bowling.find((b) => b.person === "h7")!.maidens).toBe(1);   // the six dots
  });

  it("did-not-bat lists the lineup persons who never reached the crease, in lineup order", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const atCrease = new Set(inn1.batting.map((b) => b.person));
    expect(inn1.didNotBat).toEqual(HOME.filter((p) => !atCrease.has(p)));
  });

  it("economy and strike rate are null when nothing was bowled or faced (no NaN, no Infinity)", () => {
    const { events, cfg, lineups } = scriptLedger({ ...TWO_INNINGS, innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ extra: "wide", runs: 1 }] }] });
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1.batting[0]!.strikeRate).toBeNull();
    expect(inn1.bowling[0]!.economy).toBeNull();          // 0 legal balls
  });
});
```

Make the `fours` expectation derived: `HOME`'s h1 faces balls 1–2 (1 run then 4) — compute expected from the script in the test (`scriptFours(TWO_INNINGS, "h1")`) rather than the literal `1`, so the assertion follows the script.

- [ ] **Step 2: Run — expect 4 new failures** (same command as Task 1).

- [ ] **Step 3: Implement** in the accumulator: per innings, `order: string[]` (append striker/nonStriker on first sight), `fours/sixes: Record<person, number>` from `boundary` when `runs.bat` is 4/6 (a `boundary: 4` with `runs.bat: 4` counts; a bye to the boundary does not), `dismissal: Record<person, BattingLine["dismissal"]>` from `wicket` (`bowlerCredited ? bowler : null`), `bowlerOrder`, `wides/noBalls: Record<bowler, number>`, `maidens` computed at over close. Lines are built in `cards()` by zipping the order with `fine.batterRuns`/`batterBalls` (state is the authority for runs and balls). `didNotBat` = batting-side lineup order minus `order`.

- [ ] **Step 4: Run — expect all green.** Then apply and RECORD two mutants in the test file header (as a comment block "Mutants killed"): (a) delete the wide branch in the accumulator → the wides assertion reds; (b) count byes against the bowler → the conceded-runs assertion reds. Restore after each.

- [ ] **Step 5: Commit** — "engine(cricket): scorecard fold — batting and bowling lines, did-not-bat".

---

### Task 3: Engine — fall of wickets, partnerships, over log, live block, chase maths

**Files:**
- Modify: `packages/engine/src/sports/cricket/scorecard.ts`
- Test: `packages/engine/src/sports/cricket/__tests__/scorecard.test.ts`

**Interfaces:**
- Consumes: exported `chaseTarget(state: CricketState): number` (`cricket.ts:705`), `FineInnings.striker/nonStriker/currentBowler`, `cfg.ballsPerInnings`, `cfg.ballsPerOver`, `CricketState.innings[i].closed`.
- Produces: `fallOfWickets`, `partnerships` (last one `"unbroken"` while the innings is open), `overs: OverLog[]`, `live: CricketLive | null` (null when no innings is open).

- [ ] **Step 1: Failing tests**

```ts
describe("deriveCricketScorecard — fall of wickets, partnerships, overs, live", () => {
  it("fall of wickets records the team score and over at each wicket, in order", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1.fallOfWickets.map((f) => f.wicket)).toEqual([1, 2]);
    expect(inn1.fallOfWickets[0]!.over).toBe("0.4");          // 5th delivery, 4th legal (the wide before it does not count)
    expect(inn1.fallOfWickets[0]!.runs).toBe(1 + 4 + 1 + 0);   // derive from the script prefix, not a typed constant
  });

  it("partnerships sum to the innings total and the last one is unbroken while the innings is open", () => {
    const live = scriptLedger({ ...TWO_INNINGS, innings: [TWO_INNINGS.innings[0]] });   // no close → open
    const [inn1] = deriveCricketScorecard({ events: live.events, cfg: live.cfg, lineups: live.lineups }).innings;
    expect(inn1.partnerships.reduce((s, p) => s + p.runs, 0)).toBe(inn1.total.runs);
    expect(inn1.partnerships.at(-1)!.wicket).toBe("unbroken");
  });

  it("over log: runs per over sum to the total, and 'this over' in live is the open over's glyphs", () => {
    const live = scriptLedger({ ...TWO_INNINGS, innings: [TWO_INNINGS.innings[0]] });
    const card = deriveCricketScorecard({ events: live.events, cfg: live.cfg, lineups: live.lineups });
    const [inn1] = card.innings;
    expect(inn1.overs.reduce((s, o) => s + o.runs, 0)).toBe(inn1.total.runs);
    expect(card.live!.thisOver.length).toBe(inn1.overs.at(-1)!.balls.length);
    expect(card.live!.striker).toBe(/* read from the reducer */ (live.state.innings.at(-1) as { fine: { striker: string } }).fine.striker);
  });

  it("chase maths: target, need, balls left, RRR; null in the first innings", () => {
    const script = { ...TWO_INNINGS, innings: [TWO_INNINGS.innings[0], { ...TWO_INNINGS.innings[1], deliveries: TWO_INNINGS.innings[1].deliveries.slice(0, 7) }] };
    const s = scriptLedger(script);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    const inn1 = card.innings[0]!, inn2 = card.innings[1]!;
    expect(card.live!.target).toBe(chaseTarget(s.state));            // ONE authority
    expect(card.live!.needRuns).toBe(inn1.total.runs + 1 - inn2.total.runs);
    expect(card.live!.ballsLeft).toBe(s.cfg.ballsPerInnings! - inn2.total.legalBalls);
    expect(card.live!.rrr).toBeCloseTo((card.live!.needRuns! * 6) / card.live!.ballsLeft!, 2);
    const first = scriptLedger({ ...TWO_INNINGS, innings: [TWO_INNINGS.innings[0]] });
    expect(deriveCricketScorecard({ events: first.events, cfg: first.cfg, lineups: first.lineups }).live!.target).toBeNull();
  });

  it("live is null once the match is decided", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    expect(deriveCricketScorecard({ events, cfg, lineups }).live).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect 5 new failures.**

- [ ] **Step 3: Implement**: per innings `currentPartnership = { batters: [striker, nonStriker] at start, runs, balls }`, closed on a wicket (push with `wicket: n`) and re-opened with the incoming pair read from state AFTER the ball; on innings close, push the open one as `"unbroken"` only if the innings is still open (a closed innings' last partnership keeps its numeric wicket if it ended on a wicket, else `"unbroken"` — the same word cricket uses for an innings that closed on overs/target). Over log: a new `OverLog` when `legalBalls % bpo === 0` before a legal ball; `scoreAfter` from state. Live: only when `state.innings.at(-1)?.closed === false`; `target = innings.length >= 2 ? chaseTarget(state) : null`; `crr = legalBalls ? runs*6/legalBalls : null`; `projected` only in the first innings and only with `cfg.ballsPerInnings` set.

- [ ] **Step 4: Run — all green.** Mutants to apply and record: (c) swap striker/non-striker on a run-out → the partnership-batters assertion (add one: the pair after the run-out) reds; (d) drop the maiden check → Task 2's maiden test reds; (e) compute `rrr` with `ballsLeft + 1` → the RRR test reds.

- [ ] **Step 5: Commit** — "engine(cricket): scorecard fold — fall of wickets, partnerships, over log, live block, chase maths".

---

### Task 4: Engine — band 0/2 inputs, result, super over, package export

**Files:**
- Modify: `packages/engine/src/sports/cricket/scorecard.ts`
- Modify: the cricket barrel the exports map resolves for `@seazn/engine/sports/cricket` (pin: `packages/engine/package.json` `"./sports/*"` target; if it maps to `src/sports/*/index.ts`, edit `packages/engine/src/sports/cricket/index.ts`; if to `src/sports/*.ts`, edit `packages/engine/src/sports/cricket.ts`).
- Test: `packages/engine/src/sports/cricket/__tests__/scorecard.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe("deriveCricketScorecard — coarser bands, result, super over", () => {
  it("band 2: player lines fill batting/bowling with nulls where the ledger cannot say", () => {
    // build: core.start, toss, cricket.innings.summary {runs: 54, wickets: 4, legalBalls: 48}, then
    // cricket.player.line { innings: 1, person: "h1", batting: { runs: 30, balls: 20, out: true } },
    // cricket.player.line { innings: 1, person: "a7", bowling: { legalBalls: 12, runs: 20, wickets: 2 } }, then innings.close
    const card = deriveCricketScorecard(lineLedger());
    expect(card.band).toBe(2);
    const h1 = card.innings[0]!.batting.find((b) => b.person === "h1")!;
    expect(h1).toMatchObject({ runs: 30, balls: 20, fours: null, sixes: null, dismissal: { kind: "out_unknown" } });
    expect(card.innings[0]!.bowling[0]).toMatchObject({ person: "a7", maidens: null, wides: null, noBalls: null, economy: 10 });
    expect(card.innings[0]!.overs).toEqual([]);
    expect(card.innings[0]!.fallOfWickets).toEqual([]);
    expect(card.innings[0]!.extras).toBeNull();
  });

  it("band 0: innings summaries alone give totals and (with a second innings) a target — no players", () => {
    const card = deriveCricketScorecard(summaryOnlyLedger());   // two innings.summary events, second partial: true
    expect(card.band).toBe(0);
    expect(card.innings[0]!.batting).toEqual([]);
    expect(card.live!.target).toBe(card.innings[0]!.total.runs + 1);
  });

  it("result comes from the reducer's own summary/outcome; a tie reads as a tie", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    expect(card.result?.headline).toBe(cricket.summary(scriptLedger(TWO_INNINGS).state).headline);
  });

  it("a super over appears as an innings flagged isSuperOver", () => {
    const so = scriptLedger(SUPER_OVER_SCRIPT);   // a tie then cricket.superover.ball events; cfg.superOver: true
    const card = deriveCricketScorecard({ events: so.events, cfg: so.cfg, lineups: so.lineups });
    expect(card.innings.filter((i) => i.isSuperOver).length).toBe(2);
  });
});
```

Write `lineLedger()`, `summaryOnlyLedger()` and `SUPER_OVER_SCRIPT` in `scorecard-ledger.ts` (the super-over event sequence is in `apps/web/e2e/mobile.spec.ts:1029-1056` — mirror it).

- [ ] **Step 2: Run — expect 4 new failures.**

- [ ] **Step 3: Implement** `onLine` (fill batting/bowling from the payload, `out === true → out_unknown`, `economy` from `legalBalls/runs`), `onSummary` (totals only; a `partial: true` summary keeps the innings open so `live` is non-null and `target` derives from innings 1 + 1 — use `chaseTarget` when the state supports it, else `innings[0].runs + 1` and note which path in a comment), super-over innings from `state.superOver.innings` (pin the field, `cricket.ts:471-474`) flagged `isSuperOver: true`.

- [ ] **Step 4: Export**: add `export { deriveCricketScorecard } from "./scorecard.ts"; export type * from "./scorecard-types.ts";` to the cricket barrel. Verify from the web package that `import { deriveCricketScorecard } from "@seazn/engine/sports/cricket"` resolves: `cd <worktree>/apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -a scorecard` (scoped read of the output; the full tsc is the orchestrator's).

- [ ] **Step 5: Run engine cricket suite — all green; record `numTotalTests` in the commit.** Mutant (f): make `band` the MIN instead of the max → the band tests red.

- [ ] **Step 6: Commit** — "engine(cricket): scorecard fold — band 0/2 inputs, result, super over; exported from the cricket barrel".

---

### Task 5: Web — the match-centre document schema and the public lineup reader

**Files:**
- Create: `apps/web/src/server/public-site/match-centre-schema.ts`
- Create: `apps/web/src/server/public-site/public-lineups.ts`
- Test: `apps/web/src/server/public-site/__tests__/public-lineups.test.ts`

**Interfaces:**
- Consumes: `resolvePersonDisplayName(fullName, consent, divisionSetting, youth)` (`apps/web/src/lib/name-display.ts:72`); the lineup tables `readLineup(tx, fixtureId, entrantId)` reads (`apps/web/src/server/usecases/fixtures.ts:397-412` — copy its SQL join shape, NOT its auth); `maskPublicEntrantNames` (`data.ts:510`) for how division consent settings are loaded.
- Produces:
  ```ts
  export type PublicPerson = { personId: string; name: string; masked: boolean };
  export async function readPublicLineups(sql: Sql, fixtureId: string, division: DivisionConsentCtx): Promise<Record<string /*entrantId*/, PublicPerson[]>>;
  ```
  and, in `match-centre-schema.ts`, zod schemas `MatchCentreDoc`, `MatchCentreHeader`, `MatchCentreTabId`, `CricketView`, `TimelineLine`, `SetsView`, `InfoView` with inferred types of the same names suffixed `T` (e.g. `MatchCentreDocT`).

- [ ] **Step 1: Write the schema** (names are what the UI and API use; keep camelCase inside the document — the API field that carries it is `match_centre`):

```ts
import { z } from "zod";

export const MatchCentreTabId = z.enum(["summary", "scorecard", "commentary", "timeline", "sets", "info"]);
export const Msg = z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() }); // a dictionary key + params, resolved client-side with t()

export const Side = z.object({ entrantId: z.string(), name: z.string(), short: z.string(), colour: z.string().nullable(), badgeUrl: z.string().nullable() });
export const Person = z.object({ personId: z.string(), name: z.string(), masked: z.boolean() });

export const MatchCentreHeader = z.object({
  live: z.boolean(),
  status: z.enum(["scheduled", "in_play", "decided", "other"]),
  sides: z.tuple([Side, Side]),
  scoreLines: z.tuple([z.string().nullable(), z.string().nullable()]),   // "56/6" | "2" | "6-4 3-6"
  subLines: z.tuple([z.string().nullable(), z.string().nullable()]),     // "(8.0)" | null
  battingIndex: z.union([z.literal(0), z.literal(1)]).nullable(),
  statusLine: Msg.nullable(),        // "Queens need 34 from 21" / "Blue Blazers won by 12 runs" / "Starts Sat 14:00"
  rateLine: z.string().nullable(),   // "CRR 8.44 · RRR 9.71" — numbers, no copy
  updatedAt: z.string(),             // ISO
});

export const CricketBattingRow = z.object({ person: Person, runs: z.number(), balls: z.number(), fours: z.number().nullable(), sixes: z.number().nullable(), strikeRate: z.string().nullable(), dismissal: Msg, notOut: z.boolean() });
export const CricketBowlingRow = z.object({ person: Person, overs: z.string(), maidens: z.number().nullable(), runs: z.number(), wickets: z.number(), economy: z.string().nullable(), wides: z.number().nullable(), noBalls: z.number().nullable() });
export const CricketInningsView = z.object({
  number: z.number(), side: Side, isSuperOver: z.boolean(),
  total: z.object({ runs: z.number(), wickets: z.number(), overs: z.string(), runRate: z.string().nullable() }),
  extrasLine: z.string().nullable(),
  batting: z.array(CricketBattingRow), didNotBat: z.array(Person), bowling: z.array(CricketBowlingRow),
  fallOfWickets: z.array(z.object({ wicket: z.number(), runs: z.number(), over: z.string(), batter: Person })),
  partnerships: z.array(z.object({ batters: z.tuple([Person, Person]), runs: z.number(), balls: z.number(), wicket: z.union([z.number(), z.literal("unbroken")]) })),
  overs: z.array(z.object({ number: z.number(), bowler: Person.nullable(), glyphs: z.array(z.string()), runs: z.number(), wickets: z.number(), scoreAfter: z.string(), lines: z.array(Msg) })), // glyph strings "1","4","W","wd","nb+2","·"
});
export const CricketView = z.object({
  band: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  toss: Msg.nullable(),
  innings: z.array(CricketInningsView),
  live: z.object({ striker: Person.nullable(), nonStriker: Person.nullable(), bowler: Person.nullable(), batters: z.array(CricketBattingRow), bowling: z.array(CricketBowlingRow), thisOver: z.array(z.string()), partnership: z.string().nullable(), lastWicket: Msg.nullable() }).nullable(),
  topPerformers: z.array(z.object({ role: z.enum(["batter", "bowler"]), person: Person, side: Side, line: z.string(), detail: z.string().nullable() })),
});
export const TimelineLine = z.object({ seq: z.number(), at: z.string().nullable(), marker: z.string().nullable(), sideIndex: z.union([z.literal(0), z.literal(1)]).nullable(), text: Msg, emphasis: z.enum(["normal", "score", "strong"]) });
export const SetsView = z.object({ kind: z.enum(["sets", "periods"]), columns: z.array(z.string()), rows: z.tuple([z.array(z.string().nullable()), z.array(z.string().nullable())]), closedMask: z.array(z.boolean()) });
export const InfoView = z.object({ rows: z.array(z.object({ label: Msg, value: Msg })), calendarHref: z.string().nullable(), divisionHref: z.string(), competitionHref: z.string() });

export const MatchCentreDoc = z.object({
  fixtureId: z.string(), sportKey: z.string(), header: MatchCentreHeader,
  tabs: z.array(MatchCentreTabId).min(1),
  cricket: CricketView.nullable(), timeline: z.array(TimelineLine).nullable(), sets: SetsView.nullable(), info: InfoView,
});
export type MatchCentreDocT = z.infer<typeof MatchCentreDoc>;
export type MatchCentreHeaderT = z.infer<typeof MatchCentreHeader>;
export type CricketViewT = z.infer<typeof CricketView>;
export type TimelineLineT = z.infer<typeof TimelineLine>;
export type SetsViewT = z.infer<typeof SetsView>;
export type InfoViewT = z.infer<typeof InfoView>;
export type PersonT = z.infer<typeof Person>;
export type SideT = z.infer<typeof Side>;
export type MsgT = z.infer<typeof Msg>;
```

- [ ] **Step 2: Failing test for the lineup reader** (DB-backed — follows the pattern of `apps/web/src/server/public-site/__tests__/consent.test.ts`; requires `DATABASE_URL`, skips otherwise exactly as that file does):

```ts
it("readPublicLineups resolves names through the consent resolver — a public_name:false member is masked, never blank", async () => {
  // seed via the same SQL helpers consent.test.ts uses: an org, a public competition, a division, two entrants,
  // persons with consent {public_name: true} and one with {public_name: false}, a fixture, lineups for both sides
  const lineups = await readPublicLineups(sql, fixtureId, divisionCtx);
  const home = lineups[homeEntrantId]!;
  expect(home.map((p) => p.personId)).toEqual(homePersonIdsInOrder);            // order_no ascending
  const masked = home.find((p) => p.personId === privatePersonId)!;
  expect(masked.masked).toBe(true);
  expect(masked.name).not.toBe("");
  expect(masked.name).not.toBe(privateFullName);                               // the NEGATIVE needs its POSITIVE pair:
  expect(home.find((p) => p.personId === publicPersonId)!.name).toBe(publicFullName);
});
```

- [ ] **Step 3: Run — expect failure (module missing).**

- [ ] **Step 4: Implement `readPublicLineups`**: one SQL query joining `fixture_lineups` (pin table/column names from `readLineup`'s SQL at `usecases/fixtures.ts:397-412`) to `persons` with their consent columns (pin from `maskPublicEntrantNames`, `data.ts:510-599`), ordered by `entrant_id, order_no`; map each row through `resolvePersonDisplayName(full_name, consent, division.setting, youth)`; `masked = name !== full_name`.

- [ ] **Step 5: Run — green.** `cd <worktree>/apps/web && DATABASE_URL=… pnpm exec vitest run src/server/public-site/__tests__/public-lineups.test.ts --reporter=json --outputFile=/tmp/spx-pl.json` — read `numTotalTests`; a `0` means it skipped for want of `DATABASE_URL`, which is NOT a pass.

- [ ] **Step 6: Commit** — "web(public-site): match-centre document schema and a consent-gated public lineup reader".

---

### Task 6: Web — `buildMatchCentre` for cricket (names, formatting, keys, tabs by presence, top performers)

**Files:**
- Create: `apps/web/src/server/public-site/match-centre.ts`
- Test: `apps/web/src/server/public-site/__tests__/match-centre.test.ts`

**Interfaces:**
- Consumes: `deriveCricketScorecard` + types (`@seazn/engine/sports/cricket`), `MatchCentreDoc` schemas (Task 5), `PublicPerson` (Task 5), `PublicFixture` (`data.ts:206-268` — fields `status`, `scheduled_at`, `venue_name`, `court_name`, `home_entrant_id`, `away_entrant_id`, `outcome`, `summary`), `resolveVenueTz(divisionTz, orgTz)` (`apps/web/src/lib/tz.ts:44`).
- Produces:
  ```ts
  export interface MatchCentreInput {
    fixture: PublicFixture; sportKey: string; cfg: unknown; events: readonly EventEnvelope[];
    lineups: Record<string, PublicPerson[]>; sides: [SideT, SideT];
    venueTz: string; locale: string; now: Date; hrefs: { division: string; competition: string; calendar: string | null };
    stage: { name: string; roundLabel: string | null } | null; band?: never;
  }
  export function buildMatchCentre(input: MatchCentreInput): MatchCentreDocT;
  ```
  Pure: no DB, no clock other than `input.now`.

- [ ] **Step 1: Failing tests** (build the ledger with `scriptLedger` from the engine test helper — export it from the engine test folder or copy the builder into `apps/web/src/server/public-site/__tests__/cricket-ledger.ts`; copying is acceptable here because it is test scaffolding, not a rule):

```ts
describe("buildMatchCentre — cricket", () => {
  it("EMPTY ledger: header says scheduled, tabs are summary + info only, cricket view has no innings", () => {
    const doc = buildMatchCentre(input({ events: [] }));
    expect(doc.tabs).toEqual(["summary", "info"]);
    expect(doc.header.status).toBe("scheduled");
    expect(doc.cricket?.innings).toEqual([]);
  });
  it("band 3 live: tabs are summary, scorecard, commentary, info in that ORDER; header carries the chase line", () => {
    const doc = buildMatchCentre(input({ events: liveChaseEvents }));
    expect(doc.tabs).toEqual(["summary", "scorecard", "commentary", "info"]);
    expect(doc.header.live).toBe(true);
    expect(doc.header.statusLine).toEqual({ key: "public.matchCentre.chase.need", params: { side: "Southend Queens", runs: 34, balls: 21 } });
    expect(doc.header.rateLine).toMatch(/^CRR \d+\.\d\d · RRR \d+\.\d\d$/);
  });
  it("band 2: no commentary tab; dismissal is out_unknown key; 4s/6s null", () => {
    const doc = buildMatchCentre(input({ events: lineEvents }));
    expect(doc.tabs).toEqual(["summary", "scorecard", "info"]);
    expect(doc.cricket!.innings[0]!.batting[0]!.dismissal).toEqual({ key: "public.matchCentre.dismissal.out_unknown" });
  });
  it("a masked person is masked EVERYWHERE the name appears: batting, bowling, fall of wickets, partnerships, commentary, top performers", () => {
    const doc = buildMatchCentre(input({ events: finalEvents, lineups: lineupsWithOneMasked("h1") }));
    const json = JSON.stringify(doc);
    expect(json).not.toContain(FULL_NAME_OF_H1);
    expect(json).toContain(MASKED_NAME_OF_H1);     // positive pair
  });
  it("every dismissal kind the engine declares maps to a dictionary key", () => {
    for (const kind of ["bowled","caught","lbw","runout","stumped","hitwicket","retired","obstructed","timedout","hitballtwice"] as const) {
      expect(dismissalMsg({ kind, bowler: "b", fielder: "f", fielderAssist: null }, names).key).toBe(`public.matchCentre.dismissal.${kind}`);
    }
  });
  it("top performers: best batter by runs then strike rate; best bowler by wickets then economy — with an ORDER-differential case", () => {
    // two batters with equal runs, different SR → the higher SR wins; two bowlers with equal wickets → the lower economy wins
  });
  it("final: header status decided, statusLine is the result key with the margin params, live null", () => {
    const doc = buildMatchCentre(input({ events: finalEvents }));
    expect(doc.header.status).toBe("decided");
    expect(doc.header.statusLine?.key).toMatch(/^public\.matchCentre\.result\./);
    expect(doc.cricket!.live).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failures.**

- [ ] **Step 3: Implement** `buildMatchCentre`: `sport === "cricket"` → `card = deriveCricketScorecard({ events, cfg: parsedCfg, lineups: toLineupPair(lineups) })`; `personOf(id)` looks up `lineups` (both sides) → `PersonT`, falling back to `{ personId: id, name: "?", masked: true }` never a blank; formatting helpers `fmt1(n)` (one decimal, `"161.9"`), `fmt2(n)`; `dismissalMsg(d, personOf)` → `{ key: "public.matchCentre.dismissal.<kind>", params: { bowler, fielder, assist } }`; `tabs` = `["summary", ...(card.innings.some(i => i.batting.length) ? ["scorecard"] : []), ...(card.innings.some(i => i.overs.length) ? ["commentary"] : []), "info"]`; header from `card` + `fixture` (`statusLine` for scheduled = `{ key: "public.matchCentre.status.startsAt", params: { when: formatted in venueTz + locale } }`); `topPerformers` computed per innings; `overs[].lines` = per-ball `Msg` with keys `public.matchCentre.ball.<glyphKind>` and params `{ over: "12.3", bowler, batter, runs }`; the result `Msg` mapped from the engine's margin shape (pin `summary.detail.margin` fields at `cricket.ts:3300-3325`: `{ kind: "runs" | "wickets" | "tie" | "superover" | "dls" | "no_result" | ... , value? }` → keys `public.matchCentre.result.<kind>`).

- [ ] **Step 4: Run — green.** Mutants: (g) drop the `masked` name substitution in `personOf` → the everywhere-masked test reds; (h) swap the top-performer tie-break → the order-differential case reds.

- [ ] **Step 5: Commit** — "web(public-site): buildMatchCentre — cricket view model with consent, keys, tabs by presence, top performers".

---

### Task 7: Web — Timeline and Sets/Periods for every other sport

**Files:**
- Create: `apps/web/src/server/public-site/timeline.ts`
- Modify: `apps/web/src/server/public-site/match-centre.ts` (non-cricket branch)
- Test: `apps/web/src/server/public-site/__tests__/timeline.test.ts`

**Interfaces:**
- Consumes: the sport module registry (`registry` from `@seazn/engine/sport`, `registerBuiltins` from `@seazn/engine/sports` — as `apps/web/src/server/engine-db/registry.ts:6-8` does), each module's `init/apply/summary`; `summary.detail.sets` (`{home, away, closed}[]`, `setbased/kernel.ts:2400`, `nested/kernel.ts:2164`) and `detail.periods` (`period/kernel.ts:2513`, `football.ts:2552`); football payloads `FootballGoal{by,scorer?,assist?,minute?,ownGoal?,penalty?}`, `FootballCard{by,person?,color,minute?}`, `FootballPeriod{phase}`, `FootballShootoutKick{by,person?,scored}` (`football.ts:212-294`); `tennis.point` `{by, server?, scorer?, meta?: {kind?}}` (`nested/kernel.ts:223`).
- Produces:
  ```ts
  export function buildTimeline(args: { sportKey: string; events: readonly EventEnvelope[]; module: AnySportModule; cfg: unknown; lineups: LineupPair; sides: [SideT, SideT]; personOf: (id: string) => PersonT }): TimelineLineT[];
  export function buildSets(args: { sportKey: string; summary: ScoreSummary; sides: [SideT, SideT] }): SetsViewT | null;
  export const TIMELINE_KEY_FOR: Record<string /*event type*/, string /*dictionary key*/>;   // the template table, keyed by recorded event type
  ```

- [ ] **Step 1: Failing tests**

```ts
describe("buildTimeline", () => {
  it("EMPTY ledger → []", () => expect(buildTimeline(args({ events: [] }))).toEqual([]));
  it("football: goal, card, period and shoot-out kick each render their own key with side, minute and person", () => {
    const lines = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    expect(lines.map((l) => l.text.key)).toEqual(expect.arrayContaining([
      "public.timeline.football.goal", "public.timeline.football.card", "public.timeline.football.period", "public.timeline.football.shootout.kick",
    ]));
    const goal = lines.find((l) => l.text.key === "public.timeline.football.goal")!;
    expect(goal.sideIndex).toBe(0);
    expect(goal.marker).toBe("23'");
  });
  it("newest first: seq descending", () => { /* assert lines[0].seq > lines[1].seq */ });
  it("an event type with no template renders the neutral line, never nothing", () => {
    const lines = buildTimeline(args({ events: [envelope("some.future.type", {})] }));
    expect(lines[0]!.text.key).toBe("public.timeline.generic.event");
  });
  it("racket sports: a set transition line is derived by replaying the module and diffing summary.detail.sets", () => {
    const lines = buildTimeline(args({ sportKey: "tennis", events: tennisSetLedger }));
    expect(lines.some((l) => l.text.key === "public.timeline.set.won")).toBe(true);
  });
});
describe("buildSets", () => {
  it("tennis: kind sets, one column per set, closed mask from detail.sets[].closed", () => { /* … */ });
  it("football: kind periods, columns from detail.periods[].phase", () => { /* … */ });
  it("cricket and generic: null", () => { /* … */ });
});
describe("timeline dictionary coverage (derived from the engine's own golden corpora)", () => {
  it("every event type recorded in any sport's golden corpus has a template key in all four locales", () => {
    // glob packages/engine/src/testkit/**/golden corpora (pin the path + file shape: `GOLDEN-POLICY.md`), collect event types,
    // for each type: TIMELINE_KEY_FOR[type] ?? "public.timeline.generic.event" must exist in en/es/fr/nl public.json
  });
});
```

- [ ] **Step 2: Run — failures.**

- [ ] **Step 3: Implement**: `buildTimeline` replays `module.init/apply` per event (like the cricket fold), emits one `TimelineLine` per recorded event using `TIMELINE_KEY_FOR[ev.type]` with params built by a small per-type param mapper (`football.goal` → `{ side, scorer, assist, minute, flags }`; `football.card` → `{ side, person, colour, minute }`; period → `{ phase }`; kick → `{ side, person, scored }`; `*.point` → `{ side, scorer, kind }`; `core.start`/`core.*` → `{}`), and after each event diffs `summary.detail.sets`/`periods` length or `closed` flags to emit derived `public.timeline.set.won` / `public.timeline.period.end` lines with the score. `buildSets` maps `detail.sets`/`periods` to the view. Wire the non-cricket branch of `buildMatchCentre`: `tabs = ["summary", ...(timeline.length ? ["timeline"] : []), ...(sets ? ["sets"] : []), "info"]`; header `scoreLines` from `summary.perSide[].line`.

- [ ] **Step 4: Run — green.** Mutant (i): drop the neutral fallback → the unknown-type test reds; (j): sort ascending → the newest-first test reds.

- [ ] **Step 5: Commit** — "web(public-site): Timeline and Sets/Periods view for every non-cricket sport, templates keyed by recorded event type".

---

### Task 8: Dictionaries — every key, four locales, generated key file, coverage test

**Files:**
- Modify: `apps/web/src/dictionaries/en/public.json`, `.../es/public.json`, `.../fr/public.json`, `.../nl/public.json`
- Regenerate: `apps/web/src/lib/i18n-keys.ts` via `npm run i18n:gen-keys` (never by hand)
- Test: `apps/web/src/server/public-site/__tests__/match-centre-dictionary.test.ts`

- [ ] **Step 1: Failing test — every key the builders can emit exists in all four locales**

```ts
import en from "@/dictionaries/en/public.json"; // …es, fr, nl
const KEYS = [
  ...Object.values(TIMELINE_KEY_FOR), "public.timeline.generic.event", "public.timeline.set.won", "public.timeline.period.end",
  ...DISMISSAL_KINDS.map((k) => `public.matchCentre.dismissal.${k}`), "public.matchCentre.dismissal.not_out", "public.matchCentre.dismissal.out_unknown",
  ...RESULT_KINDS.map((k) => `public.matchCentre.result.${k}`),
  ...BALL_GLYPH_KINDS.map((k) => `public.matchCentre.ball.${k}`),
  "public.matchCentre.chase.need", "public.matchCentre.status.startsAt", "public.matchCentre.status.live", "public.matchCentre.status.decided",
  "public.matchCentre.tab.summary", "public.matchCentre.tab.scorecard", "public.matchCentre.tab.commentary", "public.matchCentre.tab.timeline", "public.matchCentre.tab.sets", "public.matchCentre.tab.info",
  "public.matchCentre.band.3", "public.matchCentre.band.2", "public.matchCentre.band.1", "public.matchCentre.band.0",
  // …every UI label used by Tasks 9–13: atTheCrease, thisOver, partnership, lastWicket, topBatter, topBowler, fallOfWickets, partnerships,
  // extras, total, didNotBat, endOfOver, loadEarlier, info.toss, info.format, info.venue, info.start, info.stage, info.calendar, info.scoredAs,
  // col.batter, col.bowler, col.runs, col.balls, col.fours, col.sixes, col.strikeRate, col.overs, col.maidens, col.wickets, col.economy, col.wides, col.noBalls,
  // updatedAgo, poweredBy
];
for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
  it(`${locale} has every match-centre key`, () => { for (const k of KEYS) expect(dict, k).toHaveProperty(k); });
}
it("params referenced in a template exist in every locale's template", () => { /* {side} {runs} {balls} in chase.need, etc. */ });
```

- [ ] **Step 2: Run — expect failures listing the missing keys.**

- [ ] **Step 3: Add the keys to all four `public.json` files** (English first; Spanish, French, Dutch with the sport's own vocabulary — cricket terms stay English where the language has no native term, e.g. "lbw", "run out", as cricket broadcasters in those languages do). Then `cd <worktree> && npm run i18n:gen-keys` and confirm `apps/web/src/lib/i18n-keys.ts` changed.

- [ ] **Step 4: Run — green.** Also run `pnpm exec vitest run src/lib --reporter=json` scoped in `apps/web` to catch any existing dictionary-shape test.

- [ ] **Step 5: Commit** — "i18n(public): match-centre, timeline and dismissal keys in en/es/fr/nl; keys regenerated".

---

### Task 9: API — the poll endpoint and the page both carry the document

**Files:**
- Modify: `apps/web/src/server/usecases/public.ts:263-298` (`publicFixture`)
- Modify: `apps/web/src/server/public-site/data.ts:689-747` (`getPublicFixture`)
- Modify: the OpenAPI response schema the route is generated from (pin: grep `publicFixture\|public/fixtures` in `apps/web/src/server/api-v1/openapi*.ts` / `schemas.ts`); regenerate with `npm run openapi:gen`.
- Test: `apps/web/src/server/usecases/__tests__/public-fixture-match-centre.test.ts`; `apps/web/src/app/api/v1/public/fixtures/[id]/__tests__/route.test.ts` (create if absent, following a sibling route test).

**Interfaces:**
- Produces: `publicFixture(fixtureId)` returns its existing Pick PLUS `match_centre: MatchCentreDocT`; `getPublicFixture(...)` returns its existing object PLUS `matchCentre: MatchCentreDocT`. Both are built by ONE helper added to `match-centre.ts`: `export async function loadMatchCentre(sql, fixture: PublicFixture, ctx: { orgTz, division, locale, hrefs, stage }): Promise<MatchCentreDocT>` which loads `score_events` (the same query `foldFixture` uses, `engine-db/fold.ts:67`), the frozen config snapshot (`fixtureConfigSnapshotSql` pattern, `e2e/helpers.ts:827` shows the column — pin the server-side reader), lineups via `readPublicLineups`, sides (names via `maskPublicEntrantNames`, badge via `entrants.badge_url` / `team_display_v.logo_path`, colour via `team_display_v.colors`), then calls `buildMatchCentre`.

- [ ] **Step 1: Failing tests** (DB-backed, seeded through the same SQL helpers as Task 5): `publicFixture(id)` → `match_centre.fixtureId === id`, `MatchCentreDoc.safeParse(res.match_centre).success === true`, tabs for a seeded band-3 live match are `["summary","scorecard","commentary","info"]`; a private competition's fixture still returns what it returned before (404 path unchanged — pin the existing behaviour and assert it).

- [ ] **Step 2: Run — failures.**

- [ ] **Step 3: Implement** `loadMatchCentre`, wire both call sites; add `match_centre: MatchCentreDoc` to the response schema; `cd <worktree> && npm run openapi:gen && /usr/bin/git status --porcelain openapi` → the diff must be exactly the new field in `openapi/v1.json` and `openapi/v1.public.json`.

- [ ] **Step 4: Run — green.** Read the `numTotalTests` of the two files.

- [ ] **Step 5: Commit** — "api(public): the public fixture document carries match_centre for the page and the poll; OpenAPI regenerated".

---

### Task 10: UI — transport hook, `MatchCentre` root, court card, tab rail

**Files:**
- Create: `apps/web/src/components/public-site/match-centre/use-live-fixture.ts`
- Create: `apps/web/src/components/public-site/match-centre/match-centre.tsx`, `court-card.tsx`, `tab-rail.tsx`
- Modify: `apps/web/src/components/public-site/live-score.tsx` (remove transport; export `LiveScoreBody` rendering from a `LiveFixtureData`)
- Test: `apps/web/src/components/public-site/match-centre/__tests__/{court-card,tab-rail,match-centre}.test.tsx`

**Interfaces:**
- Consumes: `fetchLiveFixture(fixtureId)` → `LiveFixtureData` and `fetchPublicRealtimeToken(fixtureId)` (`live-score-data.ts:30-38`), `POLL_MS = 15_000` (`live-score.tsx:29`), the Supabase channel wiring (`live-score.tsx:93-101`: `sb.channel(token.channel, { config: { private: true } }).on("broadcast", { event: "state_changed" }, …)`), the 250 ms debounce (`:61-67`).
- Produces:
  ```ts
  export function useLiveFixture(fixtureId: string, initial: LiveFixtureData, realtime: boolean): { data: LiveFixtureData; updatedAt: number; transport: "realtime" | "poll" };
  export function MatchCentre(props: { fixtureId: string; initial: LiveFixtureData; realtime: boolean; dict: PublicDict; locale: string; tabParam: string | null }): JSX.Element;   // "use client"
  export function CourtCard(props: { header: MatchCentreHeaderT; dict: PublicDict; updatedAt: number }): JSX.Element;
  export function TabRail(props: { tabs: MatchCentreTabIdT[]; active: MatchCentreTabIdT; onChange: (t) => void; dict: PublicDict }): JSX.Element;
  ```
  `LiveFixtureData` gains `match_centre: MatchCentreDocT` (from Task 9's schema; import the type, do not redeclare).

- [ ] **Step 1: Failing static-markup tests** (no DOM in vitest: use `renderToStaticMarkup` from `react-dom/server`; anchor on `="`):

```tsx
it("TabRail renders one role=tab per tab with aria-selected on the active one, inside a focusable, labelled rail", () => {
  const html = renderToStaticMarkup(<TabRail tabs={["summary","scorecard","commentary","info"]} active="scorecard" onChange={() => {}} dict={en} />);
  expect(html).toContain('role="tablist"'); expect(html).toContain('tabindex="0"'); expect(html).toContain('aria-label="');
  expect(html.match(/role="tab"/g)?.length).toBe(4);
  expect(html).toContain('data-testid="mc-tab-scorecard" aria-selected="true"');
  expect(html).toContain('data-testid="mc-tab-summary" aria-selected="false"');   // positive pair of the negative
});
it("CourtCard live: LIVE pill, both score lines, the chase line and the rate line; final: result chip, no rate line", () => { /* two renders */ });
it("MatchCentre renders only the tabs the document lists — a band-2 doc has no mc-tab-commentary", () => {
  const html = renderToStaticMarkup(<MatchCentre {...props(band2Doc)} />);
  expect(html).not.toContain('data-testid="mc-tab-commentary"');
  expect(html).toContain('data-testid="mc-tab-scorecard"');
});
```

- [ ] **Step 2: Run — failures.**

- [ ] **Step 3: Implement**: `useLiveFixture` = the exact logic lifted from `live-score.tsx:61-117` (poll every `POLL_MS`, Realtime subscribe when `realtime`, debounce 250 ms, both call `refresh()` → `setData(await fetchLiveFixture(fixtureId))`, `updatedAt = Date.now()` on each success; never throw to the UI — on a fetch error keep the last data). `MatchCentre`: `const { data, updatedAt } = useLiveFixture(...)`; `doc = data.match_centre`; active tab state initialised from `tabParam` if it is in `doc.tabs`, else `doc.tabs[0]`; on change, `history.replaceState` with `?tab=`; renders `<CourtCard>`, `<TabRail>`, then the active tab's component (Tasks 11–13) — all from `doc`, so a refresh re-renders everything. Composition and classes per W0 option A and the token sheet: court card `overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg` (as `live-score.tsx:143`), scores `font-display text-2xl font-bold tabular-nums` phone / `text-4xl` ≥ `md`, LIVE pill emerald as today; rail `flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4` with `role="tablist" tabIndex={0} aria-label={t(dict,"public.matchCentre.tabs.label")}`; tab pill classes from `tabs.tsx:31/33` (`rounded-full px-2.5 py-0.5`, accent bg when active, accent-soft otherwise). `LiveScoreBody` = today's `LiveScore` JSX minus transport, taking `data` as a prop.

- [ ] **Step 4: Run — green.** Mutant (k): render every tab regardless of `doc.tabs` → the band-2 test reds.

- [ ] **Step 5: Commit** — "ui(match-centre): live transport hook, MatchCentre root, court card, tab rail (option A)".

---

### Task 11: UI — Summary tab (cricket live block, top performers, fall of wickets, partnerships) and the non-cricket Summary

**Files:**
- Create: `apps/web/src/components/public-site/match-centre/summary-tab.tsx`, `stat-table.tsx`, `glyphs.tsx`
- Test: `apps/web/src/components/public-site/match-centre/__tests__/summary-tab.test.tsx`

**Interfaces:**
- Consumes: `CricketViewT`, `MatchCentreDocT`, `LiveScoreBody` (Task 10).
- Produces: `SummaryTab({ doc, dict, initial })` — cricket: `mc-live-block` (batters table R B 4s 6s SR with striker dot, bowler row O M R W Econ, `mc-this-over` glyph strip), `mc-top-performers` (two cards), `mc-fow-<inningsNo>` (a rail, `role="list"`, `tabindex="0"`, aria-label), `mc-partnerships-<inningsNo>` (bar list); non-cricket: `LiveScoreBody`.

- [ ] **Step 1: Failing tests**: cricket live doc renders `mc-live-block` with the striker's name and a `data-striker="true"` on exactly one row; final doc has no `mc-live-block` but has `mc-top-performers` with both roles; the FoW rail has `role="list"` + `tabindex="0"` + `aria-label="…"`; a masked person's name appears as given by the doc (the component never re-derives names); non-cricket doc renders the `LiveScoreBody` markers (pin one existing testid or the headline text from `live-score.tsx:160`).

- [ ] **Step 2: Run — failures.**

- [ ] **Step 3: Implement** with `stat-table.tsx` (`<table>` with `<caption class="sr-only">`, right-aligned `tabular-nums` numeric cells, header `title` attributes from the dictionary — the abbreviations themselves stay R/B/4s/6s/SR) and `glyphs.tsx` (`Glyph({ g })`: 26 px round chip; "4"/"6" accent bg, "W" ink bg, extras outlined, dot for 0). Phone: name cell `min-w-0 truncate`; ≥ `md`: cards two-up (`md:grid-cols-2`).

- [ ] **Step 4: Run — green.** **Step 5: Commit** — "ui(match-centre): Summary tab — live block, top performers, fall of wickets, partnerships; non-cricket summary body".

---

### Task 12: UI — Scorecard tab

**Files:**
- Create: `apps/web/src/components/public-site/match-centre/scorecard-tab.tsx`
- Test: `apps/web/src/components/public-site/match-centre/__tests__/scorecard-tab.test.tsx`

- [ ] **Step 1: Failing tests**: one `mc-innings-<n>` section per innings; the innings in play (or the last) is `open` (`<details open>` or `aria-expanded="true"` — use native `<details>` so it works without JS and in static markup); batting rows carry `data-testid="mc-bat-<personId>"` with the dismissal line as a second-line `<span>`; extras line and total line present; `mc-dnb-<n>` lists did-not-bat; bowling table present; at band 2 the 4s/6s/Maidens/wd/nb columns are ABSENT (`not.toContain('title="' + en["public.matchCentre.col.fours"]')`) and at band 3 present (positive pair).

- [ ] **Step 2: Run — failures.** **Step 3: Implement** (columns chosen by whether every row's value is `null`; name cell `min-w-0 truncate` with the dismissal `Msg` resolved via `t(dict, key, params)`; tables inside `overflow-x-auto` containers carrying `tabindex="0"`, `role="region"`, `aria-label` as the last resort — the target is no scroll at 320 with the six numeric columns at `text-[13px]` and `px-1`; verify in Task 15's screenshots and, if 320 still scrolls inside the box, fold 4s/6s into the R(B) cell as the spec allows and RECORD it in `_INDEX.md`).

- [ ] **Step 4: Run — green.** **Step 5: Commit** — "ui(match-centre): Scorecard tab — innings accordion, batting and bowling tables, extras, did-not-bat, fall of wickets".

---

### Task 13: UI — Commentary, Timeline, Sets/Periods, Info tabs

**Files:**
- Create: `commentary-tab.tsx`, `timeline-tab.tsx`, `sets-tab.tsx`, `info-tab.tsx` under `apps/web/src/components/public-site/match-centre/`
- Test: `__tests__/{commentary-tab,timeline-tab,sets-tab,info-tab}.test.tsx`

- [ ] **Step 1: Failing tests**: Commentary renders over groups newest-first (`mc-over-<n>` order descending), each ball line `mc-ball-<over>.<ballInOver>`; only the last five overs render initially and `mc-load-earlier` is present when more exist (EMPTY case first: a doc with no overs renders nothing and no button); Timeline renders `mc-timeline-line-<seq>` newest-first with the side marker; Sets renders one column per set/period with `data-closed`; Info renders `mc-info` rows in the order toss · format · venue · start · stage · scored-as · calendar, with the start time formatted in the venue zone (assert a fixed ISO + `Europe/London` → the expected local string) and the `band` line text from the dictionary.

- [ ] **Step 2: Run — failures.** **Step 3: Implement** (Commentary: over header line "Over N · R runs · score · bowler figures" via `Msg` keys; "Load earlier overs" reveals five more per click — client state; Info: `Intl.DateTimeFormat(locale, { timeZone: venueTz, … })`).

- [ ] **Step 4: Run — green.** Mutant (l): sort overs ascending → the newest-first test reds. **Step 5: Commit** — "ui(match-centre): Commentary, Timeline, Sets/Periods and Info tabs".

---

### Task 14: Page wiring, metadata, and the cricket regression

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` (render `<MatchCentre>`, pass `initial` = the same `LiveFixtureData` shape the poll returns — build it server-side from `getPublicFixture`'s result so first paint and refresh are ONE shape; `generateMetadata` adds the score/result to `<title>` and description when `status === "decided"`; every literal string → `t(dict, …)`; `searchParams.tab` → `tabParam`).
- Modify: `apps/web/src/components/public-site/live-score.tsx` (delete the old default export's transport; keep `LiveScoreBody`).
- Test: extend `.../fixtures/[fixtureId]/__tests__/page.test.ts` (render the page's server component with a stubbed `getPublicFixture` as the existing tests do — pin the stubbing pattern at `page.test.ts:43-120`).

- [ ] **Step 1: Failing tests**: (a) a decided cricket fixture's `generateMetadata().title` contains both score lines and the result phrase; (b) the rendered page HTML contains `data-testid="mc-tab-scorecard"` for a band-3 cricket fixture and does NOT contain the old bare `font-display text-5xl` headline block (`live-score.tsx:160`) — positive: it DOES contain `data-testid="mc-court-card"`; (c) rendering the page in each of `en, es, fr, nl` yields HTML with no string from a fixed list of the old hardcoded English (`"Live"`, `"Ended"`, `"Discipline"`, `"Goals by period"`, `"Winner:"`, `"Share on WhatsApp"`) outside `lang="en"`.

- [ ] **Step 2: Run — failures.** **Step 3: Implement.** **Step 4: Run — green; then run the whole `apps/web` unit suite ONCE from `apps/web` with the JSON reporter and compare `numTotalTests` with `main`'s (the number must be ≥ main's + the tests this plan added; a drop means a suite failed to COLLECT).**

- [ ] **Step 5: Commit** — "public(fixture): the fixture page is the match centre; metadata carries the score; no hardcoded English".

---

### Task 15: Walkthrough v1, the seven-width case, smoke, screenshots

**Files:**
- Create: `apps/web/e2e/walkthrough/spectator-public.spec.ts` (grow from `w0-spectator-capture.spec.ts`: reuse `seedAll`-style seeding and `playInnings`; DELETE `w0-spectator-capture.spec.ts` in this task — its job is done and its capture code moves into a `W0_DIR`-gated helper inside the new spec if still wanted)
- Modify: `apps/web/e2e/mobile.spec.ts` (add the public fixture route to the "public surfaces: no horizontal scroll" test at `:1205-1249`, seeding a band-3 cricket fixture in its `beforeAll` the way that test seeds its other routes)
- Modify: `scripts/smoke.ts` (one `check`: `GET /shared/<org>/<comp>/<div>/fixtures/<id>` contains `data-testid="mc-court-card"`; `GET /api/v1/public/fixtures/<id>` JSON has `match_centre.tabs.length >= 2` — seed through the smoke script's existing seeding helpers)

**The walkthrough, in order (R7 + R10):**
1. `seedShort()` — a public competition, one cricket division (8 overs, 8 a side, `cricket.toss` BEFORE `core.start`), one football division (three sides), one tennis division (two entrants), via the API in `beforeAll`. Never a full T20 through the API (≈ 9 min).
2. Cricket match A: play innings 1 and 27 balls of innings 2 through the API (`playInnings`).
3. **Open the anonymous context on match A's page FIRST** (`browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 320, height: 568 } })`), assert `mc-court-card` visible and read the current over count.
4. In the signed-in `page`, open the pad (`fixturePath(...)`) and **TAP one over**: six legal balls including one wide and one wicket, using the v3 cricket skin's tiles (pin the tile ids from `apps/web/e2e/scorepad-v3-cricket.spec.ts` — never invent them). After each tap, `expect.poll` the ledger count as that spec does, budget = `Math.max(60_000, taps * (HOLD_MS + 2_000))`.
5. Back in the anonymous context, WITHOUT navigating: `await expect(anon.getByTestId(/^mc-ball-\d+\.\d$/).first()).toContainText(...)` within `POLL_MS + 5_000`; assert the wicket appears in `mc-fow-2`, the batter's `mc-bat-<id>` line shows the runs the tap produced (derive from what was tapped), and the court card's score changed (positive) while `anon.url()` is unchanged (negative with its positive pair: the `updatedAt` text changed).
6. Repeat step 5's assertions at 1280 in a second anonymous context opened AFTER the taps (proves first paint too).
7. Match B (finished, seeded via API): result line in `mc-court-card`, `mc-top-performers` has two cards, no `mc-live-block`.
8. Football fixture: `mc-tab-timeline` and `mc-tab-sets` present, `mc-tab-scorecard` absent; a goal posted via API while the anonymous page is open appears as `mc-timeline-line-*` without navigation.
9. Tennis fixture: `mc-tab-sets` present with one column per set.
10. Screens: `screenshotAtWidths` (pin the helper in `helpers.ts`) for each tab at 320/768/1280, live and final, into the test-results dir; `expectNoHorizontalScroll(anon)` on every tab at every width.
11. Axe pass on the match centre at 320 (pin the axe helper from `scorepad-skins.spec.ts`): zero `serious`/`critical`.
12. `afterAll` (never `finally`): nothing shared to thaw here — the spec owns its data — but tear down contexts.

- [ ] **Step 1: Write the spec** as above (real code, ~400 lines; reuse the W0 harness's `postEvent`, `createPersons`, `playInnings`, `fixtureSides`, `putLineups`).
- [ ] **Step 2: Run it against a fresh env**: `seazn-env up --label spx --server` from the worktree, `eval` its env, `cd apps/web && PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test e2e/walkthrough/spectator-public.spec.ts --project=walkthrough --workers=1 --reporter=json > /tmp/spx-wt.json`. Judge on the JSON. Take the env down after.
- [ ] **Step 3: Run the WHOLE `mobile.spec.ts`** (never `-g`) across the seven projects; a serial file's red count is a floor — rerun after each fix until a full pass.
- [ ] **Step 4: Smoke**: `SMOKE_BASE=… node --experimental-strip-types scripts/smoke.ts` (pin the exact run command from `package.json`) → the two new checks print PASS with what they saw.
- [ ] **Step 5: Commit** — "e2e(spectator): walkthrough v1 — anonymous page open before the taps, one over tapped, every tab live; seven-width case; smoke checks".

---

### Task 16: Gates, review loop, programme index

- [ ] **Step 1: Orchestrator runs the full gate** from the worktree, quiescent tree: `seazn-env gate --label spx` (lint + typecheck, judge on the `Cached:` line); `cd apps/web && pnpm exec vitest run --reporter=json --outputFile=/tmp/spx-web.json`; `cd packages/engine && pnpm exec vitest run --reporter=json --outputFile=/tmp/spx-eng.json`; paste `numTotalTests`/`numFailedTests`/`numFailedTestSuites` for both, and confirm `.testResults[].name` paths are under the worktree. `npm run openapi:gen && /usr/bin/git status --porcelain openapi` must print nothing.
- [ ] **Step 2: Reviewer dispatch** on the whole branch (Opus; brief = this plan + `_RULES.md` + spec §W1; output = gap list, not prose). Fix inline; re-review until clean. **Run the final whole-branch review even if every task review was clean.**
- [ ] **Step 3: Screens** at 320/768/1280 for every tab, live and final, attached to the PR description; the control-set diff 320 vs 1280 (reuse the W0 harness's `controlSet` — zero new controls at 1280).
- [ ] **Step 4: `_INDEX.md`**: W1 row → "PR #… open", false premises found, mutants list (a–l) with the test that killed each, measured walkthrough cost.
- [ ] **Step 5: Open the PR** only when the owner says so (never unprompted); until then the branch stays local. e2e runs on `workflow_dispatch` with the PR number once a PR exists.

---

## Self-review (done while writing)

- **Spec coverage**: shared model → Tasks 1–4; view model + transport → 5–9; composition A, tabs, live in place → 10–14; i18n → 8 + 14; consent → 5, 6, 11; fidelity by presence → 4, 6, 10, 12; every other sport (ruling 10) → 7, 13, 15; R10 → 9, 10, 15; four test types → unit (1–14), e2e (15), smoke (15), regression (14, 15); screens and control-set diff → 15–16; `_INDEX.md` → 16. Gap: none found; the OG card is deliberately untouched (spec).
- **Placeholders**: the only algorithm described in prose is the ledger builder in Task 1 Step 2 (an explicit numbered algorithm with the exact derivations) — acceptable; every other step names the code.
- **Type consistency**: `MatchCentreDocT` / `CricketViewT` / `TimelineLineT` / `SetsViewT` / `InfoViewT` / `PersonT` / `SideT` / `MsgT` (Task 5) are the names used by Tasks 6–14; `deriveCricketScorecard(input: { events, cfg, lineups })` (Task 1) is what Task 6 calls; `useLiveFixture(fixtureId, initial, realtime)` (Task 10) is what Task 14 wires; `match_centre` is the API field, `matchCentre` the server-render field (Task 9).
