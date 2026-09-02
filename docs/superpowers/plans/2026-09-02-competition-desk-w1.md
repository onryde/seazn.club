# Competition Desk W1 — competition page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The competition page stops contradicting itself and tells the organiser what needs them: a derived division phase, one status line per division, a "Needs you" list, a division ledger with the sport icon, the setup tip gated to setting-up, stages rendered in seq order.

**Architecture:** A pure resolver (`lib/division-phase.ts`) turns plain inputs into `phase` + `attention[]`; a server use case (`usecases/competition-desk.ts`) gathers those inputs per competition in four queries and composes the existing `listDivisionCardStats`; three server components render the result. No new tables, no client state, no polling (W3).

**Tech Stack:** Next 16 app router (server components), TypeScript 7, vitest (`apps/web`, node env, DB suites via `DATABASE_URL`), Playwright e2e, `postgres` tagged SQL via `withTenant`, pino via `@/server/logger`, i18n dictionaries `dictionaries/{en,es,fr,nl}/ui.json` + generated `i18n-keys.ts`.

**Spec:** `docs/superpowers/specs/2026-09-02-competition-desk-design.md` (sections "The shared model" and "W1"). The artifact with the target frames (C1/C2/C3): https://claude.ai/code/artifact/b9a5511a-0ba5-496d-b8d1-6b1ca9a865c8

## Global Constraints

- Work in the worktree `/Users/ashokhein/github/seazn.club-fxc` on branch `feat/fixture-console-redesign`. Prefix every command with `cd /Users/ashokhein/github/seazn.club-fxc &&` (or `cd .../seazn.club-fxc/apps/web &&`). Never touch the main checkout.
- Local env label `fxc`: `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fxc)"` exports `DATABASE_URL` (fresh Postgres on :54652) and `SMOKE_BASE` (prod server :3364). After code changes to the app: `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label fxc`.
- `divisions.status` ∈ `setup | scheduled | active | completed` (V209). `stages.status` ∈ `pending | active | complete` (V210). `fixtures.status` ∈ `scheduled | in_play | decided | finalized | abandoned | forfeited | cancelled` (schemas.ts:1018).
- Governing clock for "today" = `resolveVenueTz(null, organizations.timezone)` from `@/lib/tz`. Never `schedule_settings.tz` (display lane).
- Every user-facing string → all four dictionaries (`en`, `es`, `fr`, `nl`) under `desk.*`, then `npm run i18n:gen-keys` (regenerates `i18n-keys.ts`; tsc fails on an unknown key until then) and `npm run i18n:check` (parity).
- Sport icon on every division row (`sportEmoji(d.sport_key)` from `@/components/discovery-cards`, or the uploaded logo); none on the competition masthead.
- Test hooks use `data-testid` (dominant convention) plus `data-phase="…"` / `data-attention="…"` for e2e/smoke; assertions on server HTML anchor with `="` (an omitted prop serialises as `"$undefined"`).
- Logging: `import { log } from "@/server/logger"`; `log.info({ event: "…", … }, "…")` in new server code.
- Vitest is judged only from `--reporter=json --outputFile=<path>` (`numPassedTests`, `numFailedTests`, `numTotalTests`) and `.testResults[].name` paths under the worktree. `rtk` summaries are not evidence.
- Four test types per task where a task has user-facing behaviour: unit, e2e, smoke, regression. Backend-only tasks trace forward to Task 7's e2e.
- Before each commit: `npm run openapi:gen && git status --porcelain` must show no OpenAPI drift (W1 adds no endpoint; the check still runs).
- Commit trailers on every commit (changed 2026-09-02 mid-run; commits before
  `106437b83` carry the earlier `Claude Fable 5.1` line and stay as they are):
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR`.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/division-phase.ts` (new) | Pure resolver: `resolvePhase`, `resolveAttention`, `ATTENTION_SEVERITY`, `localDateKey`. No DB, no React, no engine. |
| `apps/web/src/lib/__tests__/division-phase.test.ts` (new) | Table-driven matrix over the resolver. |
| `apps/web/src/lib/division-status-line.ts` (new) | `statusLine(dict, locale, desk)` → one string. Pure. |
| `apps/web/src/lib/__tests__/division-status-line.test.ts` (new) | Per-phase strings, no contradictions. |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | `desk.*` keys. |
| `apps/web/src/server/usecases/competition-desk.ts` (new) | `getCompetitionDesk(auth, competitionId, now?)` — gathers inputs, runs the resolver, returns `CompetitionDesk`. |
| `apps/web/src/server/usecases/__tests__/competition-desk.test.ts` (new) | DB test seeding the 2026-09-02 shape; regression for the "Live + Nothing scheduled + 15/15" contradiction. |
| `apps/web/src/components/v2/desk/phase-pill.tsx` (new) | Server component: phase or red-attention pill. |
| `apps/web/src/components/v2/desk/needs-you.tsx` (new) | Server component: severity-ordered attention list with one action each. |
| `apps/web/src/components/v2/desk/division-ledger.tsx` (new) | Server component: rows with sport icon, status line, progress bar, pill, next/blocker, action. |
| `apps/web/src/components/v2/desk/__tests__/desk-ssr.test.tsx` (new) | `renderToStaticMarkup` tests incl. mutation-sensitive assertions. |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` | Wire desk into masthead, Needs you, ledger; Event pass moves to the tools row. |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | Compute the division's phase, pass `phase` to `StagesPanel`. |
| `apps/web/src/components/v2/stages-panel.tsx:713-720, 800-806` | Tip gated on `phase === "setting_up"`; stages sorted by `seq` only. |
| `apps/web/e2e/competition-desk.spec.ts` (new) | Seeds via API, asserts phase/attention/ledger, clicks through. |
| `apps/web/e2e/mobile.spec.ts:316-325` | No change needed: the competition path is already in `routes` (verify in Task 7). |
| `scripts/smoke.ts` | One `check(...)` that the competition page carries `data-phase=` per division. |
| `content/help/**` competition page article | Explain Needs you + phase pill (English only). |

---

### Task 1: Division phase resolver

**Files:**
- Create: `apps/web/src/lib/division-phase.ts`
- Test: `apps/web/src/lib/__tests__/division-phase.test.ts`

**Interfaces:**
- Produces (Tasks 3–6 import these):

```ts
export type DivisionStatus = "setup" | "scheduled" | "active" | "completed";
export type DivisionPhase = "setting_up" | "scheduled" | "match_day" | "finished";
export interface PhaseStage { id: string; name: string; seq: number; status: string; hasFixtures: boolean; needsProposal: boolean }
export interface PhaseFixture { id: string; status: string; scheduledAt: string | null; eventCount: number; matchMinutes: number }
export interface PhaseInput {
  divisionStatus: DivisionStatus;
  stages: PhaseStage[];
  fixtures: PhaseFixture[];
  now: string;   // ISO instant
  tz: string;    // governing org clock
  awaitingRegistrations: number;
}
export type Attention =
  | { kind: "needs_draw"; stageId: string; stageName: string }
  | { kind: "unscheduled"; count: number }
  | { kind: "no_scorer"; fixtureId: string; minutesSinceKickoff: number }
  | { kind: "result_missing"; fixtureId: string }
  | { kind: "registrations_waiting"; count: number };
export type Severity = "red" | "amber" | "slate";
export const ATTENTION_SEVERITY: Record<Attention["kind"], Severity>;
export function localDateKey(iso: string, tz: string): string;      // "2026-09-05"
export function resolvePhase(input: PhaseInput): DivisionPhase;
export function resolveAttention(input: PhaseInput): Attention[];  // sorted red → amber → slate, stable by kind order above
```

- [ ] **Step 1: Write the failing test (full matrix)**

`apps/web/src/lib/__tests__/division-phase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  resolvePhase,
  resolveAttention,
  localDateKey,
  type PhaseInput,
  type PhaseFixture,
  type PhaseStage,
} from "@/lib/division-phase";

const NOW = "2026-09-05T09:42:00Z"; // Sat 10:42 Europe/London (BST)
const TZ = "Europe/London";

const stage = (o: Partial<PhaseStage> = {}): PhaseStage => ({
  id: "st1", name: "League", seq: 1, status: "active", hasFixtures: true, needsProposal: false, ...o,
});
const fx = (o: Partial<PhaseFixture> = {}): PhaseFixture => ({
  id: "f1", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z", eventCount: 0, matchMinutes: 90, ...o,
});
const input = (o: Partial<PhaseInput> = {}): PhaseInput => ({
  divisionStatus: "active", stages: [stage()], fixtures: [fx()], now: NOW, tz: TZ, awaitingRegistrations: 0, ...o,
});

describe("localDateKey", () => {
  it("buckets by the governing zone, not UTC", () => {
    // 23:30 UTC on the 4th is 00:30 on the 5th in London (BST, +1)
    expect(localDateKey("2026-09-04T23:30:00Z", TZ)).toBe("2026-09-05");
    expect(localDateKey("2026-09-04T23:30:00Z", "UTC")).toBe("2026-09-04");
  });
});

describe("resolvePhase — rule order", () => {
  it("1 finished: every stage complete", () => {
    expect(resolvePhase(input({ stages: [stage({ status: "complete" })], fixtures: [fx({ status: "decided" })] }))).toBe("finished");
  });
  it("1 finished: no pending/active stage and no live fixture", () => {
    expect(resolvePhase(input({ stages: [], fixtures: [fx({ status: "decided" })] }))).toBe("finished");
  });
  it("2 setting_up: division status setup wins over a fixture dated today", () => {
    expect(resolvePhase(input({ divisionStatus: "setup", fixtures: [fx({ scheduledAt: "2026-09-05T11:00:00Z" })] }))).toBe("setting_up");
  });
  it("3 match_day: a fixture in play", () => {
    expect(resolvePhase(input({ fixtures: [fx({ status: "in_play", scheduledAt: null })] }))).toBe("match_day");
  });
  it("3 match_day: a scheduled fixture today in the org zone", () => {
    expect(resolvePhase(input({ fixtures: [fx({ scheduledAt: "2026-09-05T18:00:00Z" })] }))).toBe("match_day");
  });
  it("3 match_day: 00:30 local today counts as today, 23:30 UTC yesterday does not in UTC", () => {
    expect(resolvePhase(input({ fixtures: [fx({ scheduledAt: "2026-09-04T23:30:00Z" })] }))).toBe("match_day");
    expect(resolvePhase(input({ tz: "UTC", fixtures: [fx({ scheduledAt: "2026-09-04T23:30:00Z" })] }))).toBe("scheduled");
  });
  it("4 setting_up: lowest non-complete stage has no fixtures", () => {
    expect(resolvePhase(input({ stages: [stage({ hasFixtures: false })], fixtures: [] }))).toBe("setting_up");
  });
  it("4 setting_up: U16 shape — league complete, finals pending needs proposal", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "complete" }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true }),
    ];
    expect(resolvePhase(input({ stages, fixtures: [fx({ status: "decided" })] }))).toBe("setting_up");
  });
  it("5 scheduled: fixtures exist, none today, none in play", () => {
    expect(resolvePhase(input())).toBe("scheduled");
  });
  it("a decided fixture today does not make a match day", () => {
    expect(resolvePhase(input({ fixtures: [fx({ status: "decided", scheduledAt: "2026-09-05T08:00:00Z" })] }))).toBe("scheduled");
  });
});

describe("resolveAttention", () => {
  it("needs_draw for a pending stage awaiting its proposal", () => {
    const stages = [stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true })];
    expect(resolveAttention(input({ stages }))).toContainEqual({ kind: "needs_draw", stageId: "fin", stageName: "Finals" });
  });
  it("unscheduled counts only scheduled-status rows without a time", () => {
    const fixtures = [fx({ id: "a", scheduledAt: null }), fx({ id: "b", scheduledAt: null, status: "decided" }), fx({ id: "c" })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "unscheduled", count: 1 });
  });
  it("no_scorer: in play with zero events, minutes since kickoff from scheduledAt", () => {
    const fixtures = [fx({ id: "p", status: "in_play", scheduledAt: "2026-09-05T09:30:00Z", eventCount: 0 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "no_scorer", fixtureId: "p", minutesSinceKickoff: 12 });
  });
  it("no_scorer is not raised once an event exists", () => {
    const fixtures = [fx({ id: "p", status: "in_play", eventCount: 3 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "no_scorer")).toBe(false);
  });
  it("result_missing: scheduled, kickoff + matchMinutes already passed", () => {
    const fixtures = [fx({ id: "r", scheduledAt: "2026-09-05T07:00:00Z", matchMinutes: 90 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "result_missing", fixtureId: "r" });
  });
  it("result_missing is not raised while the match window is still open", () => {
    const fixtures = [fx({ id: "r", scheduledAt: "2026-09-05T09:00:00Z", matchMinutes: 90 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "result_missing")).toBe(false);
  });
  it("registrations_waiting from the count", () => {
    expect(resolveAttention(input({ awaitingRegistrations: 2 }))).toContainEqual({ kind: "registrations_waiting", count: 2 });
    expect(resolveAttention(input({ awaitingRegistrations: 0 })).some((a) => a.kind === "registrations_waiting")).toBe(false);
  });
  it("orders red before amber before slate", () => {
    const stages = [stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true })];
    const fixtures = [fx({ id: "u", scheduledAt: null })];
    const kinds = resolveAttention(input({ stages, fixtures, awaitingRegistrations: 1 })).map((a) => a.kind);
    expect(kinds).toEqual(["needs_draw", "unscheduled", "registrations_waiting"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/ashokhein/github/seazn.club-fxc/apps/web && npx vitest run src/lib/__tests__/division-phase.test.ts --reporter=json --outputFile=/tmp/seazn-env/fxc/t1.json; node -e 'const r=require("/tmp/seazn-env/fxc/t1.json");console.log(r.numPassedTests,r.numFailedTests,r.numTotalTests,r.testResults.map(t=>t.name))'`
Expected: suite fails to collect (`Cannot find module '@/lib/division-phase'`) — `numTotalTests` 0, one failed suite. That is the red.

- [ ] **Step 3: Implement the resolver**

`apps/web/src/lib/division-phase.ts`:

```ts
// Competition Desk (spec 2026-09-02 §"The shared model"): a division's phase is
// DERIVED from stage + fixture + status facts, never stored. Pure so the same
// answer renders on server and client and the matrix is unit-testable.

export type DivisionStatus = "setup" | "scheduled" | "active" | "completed";
export type DivisionPhase = "setting_up" | "scheduled" | "match_day" | "finished";

export interface PhaseStage {
  id: string;
  name: string;
  seq: number;
  status: string; // pending | active | complete
  hasFixtures: boolean;
  needsProposal: boolean;
}

export interface PhaseFixture {
  id: string;
  status: string; // scheduled | in_play | decided | finalized | abandoned | forfeited | cancelled
  scheduledAt: string | null;
  eventCount: number;
  matchMinutes: number;
}

export interface PhaseInput {
  divisionStatus: DivisionStatus;
  stages: PhaseStage[];
  fixtures: PhaseFixture[];
  /** ISO instant "now". Injected so tests and SSR agree. */
  now: string;
  /** The governing org clock (resolveVenueTz(null, organizations.timezone)). */
  tz: string;
  awaitingRegistrations: number;
}

export type Attention =
  | { kind: "needs_draw"; stageId: string; stageName: string }
  | { kind: "unscheduled"; count: number }
  | { kind: "no_scorer"; fixtureId: string; minutesSinceKickoff: number }
  | { kind: "result_missing"; fixtureId: string }
  | { kind: "registrations_waiting"; count: number };

export type Severity = "red" | "amber" | "slate";

/** Severity is a property of the KIND, fixed here, never chosen at a call site. */
export const ATTENTION_SEVERITY: Record<Attention["kind"], Severity> = {
  needs_draw: "red",
  no_scorer: "red",
  unscheduled: "amber",
  result_missing: "amber",
  registrations_waiting: "slate",
};

const KIND_ORDER: Attention["kind"][] = [
  "needs_draw",
  "no_scorer",
  "unscheduled",
  "result_missing",
  "registrations_waiting",
];
const SEVERITY_ORDER: Severity[] = ["red", "amber", "slate"];

/** YYYY-MM-DD of an instant in a zone. en-CA gives ISO order natively. */
export function localDateKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

const LIVE = new Set(["scheduled", "in_play"]);

function lowestOpenStage(stages: PhaseStage[]): PhaseStage | null {
  return (
    [...stages].filter((s) => s.status !== "complete").sort((a, b) => a.seq - b.seq)[0] ?? null
  );
}

export function resolvePhase(input: PhaseInput): DivisionPhase {
  const { stages, fixtures } = input;
  // 1. finished
  const everyStageComplete = stages.length > 0 && stages.every((s) => s.status === "complete");
  const noOpenStage = !stages.some((s) => s.status === "pending" || s.status === "active");
  const noLiveFixture = !fixtures.some((f) => LIVE.has(f.status));
  if (everyStageComplete || (noOpenStage && noLiveFixture)) return "finished";
  // 2. setting_up: not started
  if (input.divisionStatus === "setup") return "setting_up";
  // 3. match_day
  const today = localDateKey(input.now, input.tz);
  const matchDay = fixtures.some(
    (f) =>
      f.status === "in_play" ||
      (f.status === "scheduled" && f.scheduledAt !== null && localDateKey(f.scheduledAt, input.tz) === today),
  );
  if (matchDay) return "match_day";
  // 4. setting_up: the next stage has nothing to play yet
  const open = lowestOpenStage(stages);
  if (open && (!open.hasFixtures || open.needsProposal)) return "setting_up";
  // 5.
  return "scheduled";
}

export function resolveAttention(input: PhaseInput): Attention[] {
  const out: Attention[] = [];
  const nowMs = Date.parse(input.now);
  const open = lowestOpenStage(input.stages);
  if (open && open.needsProposal) {
    out.push({ kind: "needs_draw", stageId: open.id, stageName: open.name });
  }
  const unscheduled = input.fixtures.filter((f) => f.status === "scheduled" && f.scheduledAt === null).length;
  if (unscheduled > 0) out.push({ kind: "unscheduled", count: unscheduled });
  for (const f of input.fixtures) {
    if (f.status === "in_play" && f.eventCount === 0) {
      const since = f.scheduledAt ? Math.max(0, Math.round((nowMs - Date.parse(f.scheduledAt)) / 60_000)) : 0;
      out.push({ kind: "no_scorer", fixtureId: f.id, minutesSinceKickoff: since });
    } else if (
      f.status === "scheduled" &&
      f.scheduledAt !== null &&
      Date.parse(f.scheduledAt) + f.matchMinutes * 60_000 < nowMs
    ) {
      out.push({ kind: "result_missing", fixtureId: f.id });
    }
  }
  if (input.awaitingRegistrations > 0) {
    out.push({ kind: "registrations_waiting", count: input.awaitingRegistrations });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(ATTENTION_SEVERITY[a.kind]) - SEVERITY_ORDER.indexOf(ATTENTION_SEVERITY[b.kind]) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}
```

- [ ] **Step 4: Run the test, expect green**

Same command as Step 2. Expected: `numPassedTests` 20, `numFailedTests` 0, and the single `testResults[].name` under `/Users/ashokhein/github/seazn.club-fxc/`.

- [ ] **Step 5: Mutation check (do not commit the mutants)**

Delete the `f.status === "in_play" ||` clause in rule 3 → run → the "a fixture in play" test must FAIL. Restore. Replace `open.needsProposal` in rule 4 with `false` → the U16 test must FAIL. Restore. Confirm green again.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/src/lib/division-phase.ts apps/web/src/lib/__tests__/division-phase.test.ts && git commit -m "feat(desk): derived division phase and attention resolver

Pure resolver per spec 2026-09-02 §shared model: five ordered rules, org-clock
day bucketing, severity fixed per attention kind.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 2: Dictionary keys and the status line

**Files:**
- Modify: `apps/web/src/dictionaries/en/ui.json`, `es/ui.json`, `fr/ui.json`, `nl/ui.json` (append after the `card.progress.played` key)
- Create: `apps/web/src/lib/division-status-line.ts`
- Test: `apps/web/src/lib/__tests__/division-status-line.test.ts`
- Regenerate: `apps/web/src/lib/i18n-keys.ts` via `npm run i18n:gen-keys`

**Interfaces:**
- Consumes: `DivisionPhase`, `Attention` (Task 1); `t(dict, key, vars)` from `@/lib/i18n` (re-export of `@/lib/i18n-runtime:30`); `type Dict` from `@/lib/i18n-constants`.
- Produces:

```ts
export interface StatusLineInput {
  phase: DivisionPhase;
  played: number;
  total: number;
  unscheduled: number;
  inPlay: number;
  entrants: number;
  next: { scheduledAt: string | null; home: string | null; away: string | null } | null;
  needsDrawStageName: string | null;
  locale: string;
  displayTz: string;
}
export function statusLine(dict: Dict, input: StatusLineInput): string;
```

- [ ] **Step 1: Add the keys to all four dictionaries**

In each `ui.json`, immediately after the line `"card.progress.played": …,` insert (English shown; es/fr/nl carry translations, listed below):

```json
  "desk.phase.setting_up": "Setting up",
  "desk.phase.scheduled": "Scheduled",
  "desk.phase.match_day": "Match day",
  "desk.phase.finished": "Finished",
  "desk.phase.in_play": "{n} in play",
  "desk.pill.needs_draw": "Needs draw",
  "desk.pill.no_scorer": "No scorer",
  "desk.status.finished": "{played} of {total} played · complete",
  "desk.status.needsDraw": "{played} of {total} played · {stage} not drawn",
  "desk.status.settingUp": "Setting up · {entrants} entrants",
  "desk.status.matchDay": "{played} of {total} played · {inPlay} in play",
  "desk.status.scheduled": "Next {when} · {played} of {total} played",
  "desk.status.noNext": "{played} of {total} played · nothing scheduled",
  "desk.status.unscheduledSuffix": " · {n} unscheduled",
  "desk.needsYou.title": "Needs you",
  "desk.needsYou.needs_draw": "{division} · {stage} has no draw yet",
  "desk.needsYou.needs_draw.sub": "Entrants are waiting on the proposal.",
  "desk.needsYou.needs_draw.action": "Compute proposal",
  "desk.needsYou.unscheduled": "{division} · {n} fixtures unscheduled",
  "desk.needsYou.unscheduled.sub": "No time or pitch yet. The slideshow shows them as TBC.",
  "desk.needsYou.unscheduled.action": "Open schedule board",
  "desk.needsYou.no_scorer": "{division} · {home} v {away} has no scorer",
  "desk.needsYou.no_scorer.sub": "Kicked off {minutes} min ago. Nothing is being recorded.",
  "desk.needsYou.no_scorer.action": "Assign scorer",
  "desk.needsYou.result_missing": "{division} · result missing for {home} v {away}",
  "desk.needsYou.result_missing.sub": "The match window has passed with no result.",
  "desk.needsYou.result_missing.action": "Enter result",
  "desk.needsYou.registrations_waiting": "{n} registrations waiting for approval",
  "desk.needsYou.registrations_waiting.sub": "Review them before entrants are locked.",
  "desk.needsYou.registrations_waiting.action": "Review",
  "desk.ledger.title": "Divisions",
  "desk.ledger.next": "Next: {when} {home} v {away}",
  "desk.ledger.now": "Now: {home} v {away}",
  "desk.ledger.nothingNext": "Nothing scheduled next",
  "desk.ledger.open": "Open",
  "desk.ledger.runSheet": "Fixtures",
  "desk.masthead.divisions": "{n} divisions",
```

Translations (same keys, same `{vars}`):

es: "Configurando", "Programada", "Día de partido", "Finalizada", "{n} en juego", "Falta el sorteo", "Sin anotador", "{played} de {total} jugados · completa", "{played} de {total} jugados · {stage} sin sortear", "Configurando · {entrants} participantes", "{played} de {total} jugados · {inPlay} en juego", "Próximo {when} · {played} de {total} jugados", "{played} de {total} jugados · nada programado", " · {n} sin programar", "Requiere tu atención", "{division} · {stage} aún no tiene sorteo", "Los participantes esperan la propuesta.", "Calcular propuesta", "{division} · {n} partidos sin programar", "Sin hora ni pista. La presentación los muestra como pendientes.", "Abrir tablero de horarios", "{division} · {home} v {away} no tiene anotador", "Empezó hace {minutes} min. No se está registrando nada.", "Asignar anotador", "{division} · falta el resultado de {home} v {away}", "La ventana del partido pasó sin resultado.", "Introducir resultado", "{n} inscripciones esperan aprobación", "Revísalas antes de bloquear los participantes.", "Revisar", "Divisiones", "Próximo: {when} {home} v {away}", "Ahora: {home} v {away}", "Nada programado a continuación", "Abrir", "Partidos", "{n} divisiones".

fr: "En préparation", "Planifiée", "Jour de match", "Terminée", "{n} en cours", "Tirage requis", "Sans marqueur", "{played} sur {total} joués · terminée", "{played} sur {total} joués · {stage} non tiré", "En préparation · {entrants} participants", "{played} sur {total} joués · {inPlay} en cours", "Prochain {when} · {played} sur {total} joués", "{played} sur {total} joués · rien de planifié", " · {n} non planifiés", "À traiter", "{division} · {stage} n'a pas encore de tirage", "Les participants attendent la proposition.", "Calculer la proposition", "{division} · {n} matchs non planifiés", "Ni heure ni terrain. Le diaporama les affiche comme à confirmer.", "Ouvrir le tableau de planification", "{division} · {home} v {away} n'a pas de marqueur", "Coup d'envoi il y a {minutes} min. Rien n'est enregistré.", "Attribuer un marqueur", "{division} · résultat manquant pour {home} v {away}", "Le créneau du match est passé sans résultat.", "Saisir le résultat", "{n} inscriptions en attente d'approbation", "Vérifiez-les avant le verrouillage des participants.", "Vérifier", "Divisions", "Prochain : {when} {home} v {away}", "En cours : {home} v {away}", "Rien de planifié ensuite", "Ouvrir", "Matchs", "{n} divisions".

nl: "In voorbereiding", "Gepland", "Wedstrijddag", "Afgerond", "{n} bezig", "Loting nodig", "Geen scorer", "{played} van {total} gespeeld · afgerond", "{played} van {total} gespeeld · {stage} niet geloot", "In voorbereiding · {entrants} deelnemers", "{played} van {total} gespeeld · {inPlay} bezig", "Volgende {when} · {played} van {total} gespeeld", "{played} van {total} gespeeld · niets gepland", " · {n} ongepland", "Vraagt om jou", "{division} · {stage} heeft nog geen loting", "Deelnemers wachten op het voorstel.", "Voorstel berekenen", "{division} · {n} wedstrijden ongepland", "Geen tijd of baan. De slideshow toont ze als nader te bepalen.", "Planbord openen", "{division} · {home} v {away} heeft geen scorer", "{minutes} min geleden afgetrapt. Er wordt niets vastgelegd.", "Scorer toewijzen", "{division} · uitslag ontbreekt voor {home} v {away}", "Het wedstrijdvenster is verstreken zonder uitslag.", "Uitslag invoeren", "{n} inschrijvingen wachten op goedkeuring", "Beoordeel ze voordat deelnemers worden vergrendeld.", "Beoordelen", "Divisies", "Volgende: {when} {home} v {away}", "Nu: {home} v {away}", "Niets gepland hierna", "Openen", "Wedstrijden", "{n} divisies".

- [ ] **Step 2: Regenerate keys and check parity**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && npm run i18n:gen-keys && npm run i18n:check; echo "EXIT=$?"`
Expected: `EXIT=0`, `git status --porcelain` shows the four `ui.json` files and `apps/web/src/lib/i18n-keys.ts` modified.

- [ ] **Step 3: Write the failing status-line test**

`apps/web/src/lib/__tests__/division-status-line.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { statusLine, type StatusLineInput } from "@/lib/division-status-line";

const base: StatusLineInput = {
  phase: "scheduled", played: 10, total: 15, unscheduled: 0, inPlay: 0, entrants: 6,
  next: { scheduledAt: "2026-09-12T09:00:00Z", home: "Lakeside FC", away: "Harbour CC" },
  needsDrawStageName: null, locale: "en", displayTz: "Europe/London",
};

describe("statusLine", () => {
  it("finished never says nothing scheduled", () => {
    const s = statusLine(en, { ...base, phase: "finished", played: 15, total: 15, next: null });
    expect(s).toBe("15 of 15 played · complete");
    expect(s).not.toMatch(/nothing scheduled/i);
  });
  it("setting up with a pending draw names the stage", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 28, total: 28, needsDrawStageName: "Finals", next: null });
    expect(s).toBe("28 of 28 played · Finals not drawn");
  });
  it("setting up without a draw counts entrants", () => {
    expect(statusLine(en, { ...base, phase: "setting_up", played: 0, total: 0, next: null })).toBe("Setting up · 6 entrants");
  });
  it("match day counts in play and appends unscheduled", () => {
    expect(statusLine(en, { ...base, phase: "match_day", inPlay: 2, unscheduled: 3 })).toBe("10 of 15 played · 2 in play · 3 unscheduled");
  });
  it("scheduled leads with the next kick-off in the display zone", () => {
    expect(statusLine(en, base)).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played");
  });
  it("scheduled with no next fixture says so once, plainly", () => {
    expect(statusLine(en, { ...base, next: null })).toBe("10 of 15 played · nothing scheduled");
  });
});
```

- [ ] **Step 4: Run, expect collection failure**

Run: `cd /Users/ashokhein/github/seazn.club-fxc/apps/web && npx vitest run src/lib/__tests__/division-status-line.test.ts --reporter=json --outputFile=/tmp/seazn-env/fxc/t2.json; node -e 'const r=require("/tmp/seazn-env/fxc/t2.json");console.log(r.numPassedTests,r.numFailedTests,r.numTotalTests)'`
Expected: `0 0 0` with one failed suite (module missing).

- [ ] **Step 5: Implement**

`apps/web/src/lib/division-status-line.ts`:

```ts
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import type { DivisionPhase } from "@/lib/division-phase";

export interface StatusLineInput {
  phase: DivisionPhase;
  played: number;
  total: number;
  unscheduled: number;
  inPlay: number;
  entrants: number;
  next: { scheduledAt: string | null; home: string | null; away: string | null } | null;
  needsDrawStageName: string | null;
  locale: string;
  /** Display zone (schedule_settings.tz resolved) — formatting only. */
  displayTz: string;
}

/** "Sat 12 Sep 10:00" in the display zone. */
export function whenLabel(iso: string, locale: string, tz: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  })
    .format(new Date(iso))
    .replace(",", "");
}

export function statusLine(dict: Dict, i: StatusLineInput): string {
  const base = { played: i.played, total: i.total };
  let line: string;
  switch (i.phase) {
    case "finished":
      line = t(dict, "desk.status.finished", base);
      break;
    case "setting_up":
      line = i.needsDrawStageName
        ? t(dict, "desk.status.needsDraw", { ...base, stage: i.needsDrawStageName })
        : t(dict, "desk.status.settingUp", { entrants: i.entrants });
      break;
    case "match_day":
      line = t(dict, "desk.status.matchDay", { ...base, inPlay: i.inPlay });
      break;
    case "scheduled":
      line = i.next?.scheduledAt
        ? t(dict, "desk.status.scheduled", { ...base, when: whenLabel(i.next.scheduledAt, i.locale, i.displayTz) })
        : t(dict, "desk.status.noNext", base);
      break;
  }
  if (i.unscheduled > 0 && i.phase !== "finished") {
    line += t(dict, "desk.status.unscheduledSuffix", { n: i.unscheduled });
  }
  return line;
}
```

`Dict` lives in `@/lib/i18n-constants` (i18n-runtime.ts:5 imports it from there); `t` is re-exported by `@/lib/i18n:26`.

- [ ] **Step 6: Run, expect 6 passed**

Same command as Step 4. Expected `6 0 6`. If the `whenLabel` string differs by a comma or ordering in Node's ICU, adjust the `.replace` so the EN output is exactly `Sat 12 Sep 10:00` — the test pins the product string, not ICU.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts apps/web/src/lib/division-status-line.ts apps/web/src/lib/__tests__/division-status-line.test.ts && git commit -m "feat(desk): desk.* strings in four locales and the one-line division status

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 3: `getCompetitionDesk` use case

**Files:**
- Create: `apps/web/src/server/usecases/competition-desk.ts`
- Test: `apps/web/src/server/usecases/__tests__/competition-desk.test.ts`

**Interfaces:**
- Consumes: `listDivisionCardStats(auth, competitionId)` and `DivisionCardStats`/`NextFixture` (`./card-stats`); `listDivisions(auth, competitionId)` (`./divisions`, rows carry `id`, `name`, `slug`, `status`, `sport_key`, `logo_storage_path`, `logo_url`); `withTenant` (`@/lib/db`); `resolveVenueTz` (`@/lib/tz`); Task 1 resolver.
- Produces:

```ts
export interface DeskDivision {
  division_id: string;
  phase: DivisionPhase;
  attention: Attention[];
  played: number;
  total: number;
  unscheduled: number;
  in_play: number;
  entrants: number;
  awaiting_confirmation: number;
  stage_kinds: string[];
  next: NextFixture | null;
  needs_draw_stage: { id: string; name: string } | null;
  /** For attention rows that name a fixture. */
  fixture_names: Record<string, { home: string | null; away: string | null; fixture_no: number }>;
  display_tz: string;
}
export interface CompetitionDesk {
  org_tz: string;
  in_play: number;
  divisions: Map<string, DeskDivision>;
}
export async function getCompetitionDesk(auth: AuthCtx, competitionId: string, now?: Date): Promise<CompetitionDesk>;
export function competitionPhase(desk: CompetitionDesk): DivisionPhase | "in_play";
```

- [ ] **Step 1: Write the failing DB test**

`apps/web/src/server/usecases/__tests__/competition-desk.test.ts` — copy the `seedOrg`/`seedDivision` helpers verbatim from `apps/web/src/server/usecases/__tests__/add-fixture.test.ts` (they create an org, sports, a pro plan, a competition, a division with `count` entrants), then:

```ts
import { describe, expect, it, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { createStages, generateStageFixtures } from "../stages";
import { getCompetitionDesk, competitionPhase } from "../competition-desk";
// … seedOrg / seedDivision copied from add-fixture.test.ts …
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("getCompetitionDesk", () => {
  afterAll(async () => { await sql.end({ timeout: 1 }); });

  it("a fresh division with no stage is setting_up with no attention", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("setting_up");
    expect(d.attention).toEqual([]);
    expect(competitionPhase(desk)).toBe("setting_up");
  });

  it("generated, unscheduled league: scheduled? no — unscheduled fixtures on an active division are 'scheduled' phase with an unscheduled attention", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    await generateStageFixtures(auth, stage.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const desk = await getCompetitionDesk(auth, competitionId, new Date("2026-09-08T10:00:00Z"));
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("scheduled");
    expect(d.attention).toContainEqual({ kind: "unscheduled", count: 6 });
    expect(d.total).toBe(6);
  });

  it("regression #1: an all-decided league is finished, never 'nothing scheduled'", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    await generateStageFixtures(auth, stage.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    await sql`update fixtures set status = 'decided' where division_id = ${divisionId}`;
    await sql`update stages set status = 'complete' where id = ${stage.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("finished");
    expect(d.played).toBe(6);
    expect(d.attention.some((a) => a.kind === "unscheduled")).toBe(false);
  });

  it("an in_play fixture with no events raises no_scorer and lifts the competition to in_play", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    await generateStageFixtures(auth, stage.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${f.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("match_day");
    expect(d.in_play).toBe(1);
    expect(d.attention[0]).toMatchObject({ kind: "no_scorer", fixtureId: f.id });
    expect(d.fixture_names[f.id]?.fixture_no).toBe(1);
    expect(desk.in_play).toBe(1);
    expect(competitionPhase(desk)).toBe("in_play");
  });
});
```

`createStages(auth, divisionId, { seq, kind, name, config, progression })` and `generateStageFixtures(auth, stageId)` are the exact calls `add-fixture.test.ts:85-92` makes; `stage` may be typed optional there (`stage!.id`).

- [ ] **Step 2: Run, expect collection failure**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fxc)" && cd apps/web && npx vitest run src/server/usecases/__tests__/competition-desk.test.ts --reporter=json --outputFile=/tmp/seazn-env/fxc/t3.json; node -e 'const r=require("/tmp/seazn-env/fxc/t3.json");console.log(r.numPassedTests,r.numFailedTests,r.numTotalTests,r.numPendingTests)'`
Expected: `0 0 0 0`, failed suite (module missing). If instead it prints `0 0 4 4` (pending), `DATABASE_URL` did not reach the process — re-run with the `eval` in the same call.

- [ ] **Step 3: Implement**

`apps/web/src/server/usecases/competition-desk.ts`:

```ts
import "server-only";
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { resolveVenueTz } from "@/lib/tz";
import {
  resolveAttention,
  resolvePhase,
  type Attention,
  type DivisionPhase,
  type DivisionStatus,
  type PhaseFixture,
  type PhaseStage,
} from "@/lib/division-phase";
import { listDivisionCardStats, type NextFixture } from "./card-stats";
import { listDivisions } from "./divisions";

export interface DeskDivision {
  division_id: string;
  phase: DivisionPhase;
  attention: Attention[];
  played: number;
  total: number;
  unscheduled: number;
  in_play: number;
  entrants: number;
  awaiting_confirmation: number;
  stage_kinds: string[];
  next: NextFixture | null;
  needs_draw_stage: { id: string; name: string } | null;
  fixture_names: Record<string, { home: string | null; away: string | null; fixture_no: number }>;
  display_tz: string;
}

export interface CompetitionDesk {
  org_tz: string;
  in_play: number;
  divisions: Map<string, DeskDivision>;
}

const DEFAULT_MATCH_MINUTES = 60;

type StageRaw = { id: string; division_id: string; name: string; seq: number; status: string; timing: string | null; has_fixtures: boolean };
type FixtureRaw = {
  id: string; division_id: string; status: string; scheduled_at: string | null; fixture_no: number;
  home: string | null; away: string | null; event_count: number;
};
type SettingsRaw = { division_id: string; tz: string | null; match_minutes: number | null };

export async function getCompetitionDesk(auth: AuthCtx, competitionId: string, now: Date = new Date()): Promise<CompetitionDesk> {
  const [divisions, stats] = await Promise.all([listDivisions(auth, competitionId), listDivisionCardStats(auth, competitionId)]);
  const ids = divisions.map((d) => d.id);
  const { orgTz, stages, fixtures, settings } = await withTenant(auth.orgId, async (tx) => {
    const [org] = await tx<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
    const stages = ids.length
      ? await tx<StageRaw[]>`
          select s.id, s.division_id, s.name, s.seq, s.status,
                 s.progression ->> 'timing' as timing,
                 exists (select 1 from fixtures f where f.stage_id = s.id) as has_fixtures
            from stages s where s.division_id = any(${ids})`
      : [];
    const fixtures = ids.length
      ? await tx<FixtureRaw[]>`
          select f.id, f.division_id, f.status, f.scheduled_at, f.fixture_no,
                 h.display_name as home, a.display_name as away,
                 coalesce(e.n, 0)::int as event_count
            from fixtures f
            left join entrants h on h.id = f.home_entrant_id
            left join entrants a on a.id = f.away_entrant_id
            left join (select fixture_id, count(*) as n from score_events group by fixture_id) e on e.fixture_id = f.id
           where f.division_id = any(${ids})`
      : [];
    const settings = ids.length
      ? await tx<SettingsRaw[]>`
          select division_id, tz, (config ->> 'matchMinutes')::int as match_minutes
            from schedule_settings where division_id = any(${ids})`
      : [];
    return { orgTz: resolveVenueTz(null, org?.timezone), stages, fixtures, settings };
  });

  const nowIso = now.toISOString();
  const out = new Map<string, DeskDivision>();
  let inPlayTotal = 0;
  for (const d of divisions) {
    const s = stats.get(d.id);
    const st = settings.find((x) => x.division_id === d.id);
    const matchMinutes = st?.match_minutes ?? DEFAULT_MATCH_MINUTES;
    const phaseStages: PhaseStage[] = stages
      .filter((x) => x.division_id === d.id)
      .map((x) => ({
        id: x.id, name: x.name, seq: x.seq, status: x.status, hasFixtures: x.has_fixtures,
        // A pending seeding stage with nothing generated is waiting on its draw.
        needsProposal: x.status === "pending" && x.timing === "setup" && !x.has_fixtures,
      }));
    const rows = fixtures.filter((x) => x.division_id === d.id);
    const phaseFixtures: PhaseFixture[] = rows.map((x) => ({
      id: x.id, status: x.status, scheduledAt: x.scheduled_at, eventCount: x.event_count, matchMinutes,
    }));
    const input = {
      divisionStatus: d.status as DivisionStatus,
      stages: phaseStages,
      fixtures: phaseFixtures,
      now: nowIso,
      tz: orgTz,
      awaitingRegistrations: s?.awaiting_confirmation ?? 0,
    };
    const attention = resolveAttention(input);
    const needsDraw = attention.find((a) => a.kind === "needs_draw");
    const inPlay = rows.filter((x) => x.status === "in_play").length;
    inPlayTotal += inPlay;
    const fixture_names: DeskDivision["fixture_names"] = {};
    for (const x of rows) fixture_names[x.id] = { home: x.home, away: x.away, fixture_no: x.fixture_no };
    out.set(d.id, {
      division_id: d.id,
      phase: resolvePhase(input),
      attention,
      played: s?.played ?? 0,
      total: s?.total ?? rows.length,
      unscheduled: rows.filter((x) => x.status === "scheduled" && x.scheduled_at === null).length,
      in_play: inPlay,
      entrants: s?.entrants ?? 0,
      awaiting_confirmation: s?.awaiting_confirmation ?? 0,
      stage_kinds: s?.stage_kinds ?? [],
      next: s?.next ?? null,
      needs_draw_stage: needsDraw && needsDraw.kind === "needs_draw" ? { id: needsDraw.stageId, name: needsDraw.stageName } : null,
      fixture_names,
      display_tz: resolveVenueTz(st?.tz, orgTz),
    });
  }
  log.info(
    { event: "competition_desk_built", competitionId, divisions: out.size, inPlay: inPlayTotal, attention: [...out.values()].reduce((n, x) => n + x.attention.length, 0) },
    "competition_desk_built",
  );
  return { org_tz: orgTz, in_play: inPlayTotal, divisions: out };
}

/** The competition's own pill: in play beats match day beats everything else. */
export function competitionPhase(desk: CompetitionDesk): DivisionPhase | "in_play" {
  if (desk.in_play > 0) return "in_play";
  const phases = [...desk.divisions.values()].map((d) => d.phase);
  if (phases.includes("match_day")) return "match_day";
  if (phases.includes("scheduled")) return "scheduled";
  if (phases.includes("setting_up")) return "setting_up";
  return "finished";
}
```

Columns confirmed 2026-09-02: `fixtures.home_entrant_id`, `away_entrant_id`, `fixture_no`, `stage_id`, `scheduled_at`; `entrants.display_name` (V212:10); `schedule_settings.division_id`, `tz`, `config` (schedule.ts:436); `score_events.fixture_id` (V216).

- [ ] **Step 4: Run, expect 4 passed**

Same command as Step 2. Expected `4 0 4 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/src/server/usecases/competition-desk.ts apps/web/src/server/usecases/__tests__/competition-desk.test.ts && git commit -m "feat(desk): getCompetitionDesk — phase, attention and counts per division

Four tenant queries per competition page, composed with listDivisionCardStats.
Regression: an all-decided league is finished, never 'nothing scheduled'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 4: Desk components — phase pill, Needs you, division ledger

**Files:**
- Create: `apps/web/src/components/v2/desk/phase-pill.tsx`
- Create: `apps/web/src/components/v2/desk/needs-you.tsx`
- Create: `apps/web/src/components/v2/desk/division-ledger.tsx`
- Test: `apps/web/src/components/v2/desk/__tests__/desk-ssr.test.tsx`

**Interfaces:**
- Consumes: `DeskDivision`, `CompetitionDesk` (Task 3); `Attention`, `ATTENTION_SEVERITY`, `DivisionPhase` (Task 1); `statusLine`, `whenLabel` (Task 2); `t` from `@/lib/i18n`, `type Dict` from `@/lib/i18n-constants`; `sportEmoji` from `@/components/discovery-cards`; `resolveLogoUrl` from `@/server/public-site/data` is called by the PAGE (server-only module) and passed in as `logoUrl`; `routes` from `@/lib/routes`.
- Produces:

```tsx
export function PhasePill(props: { dict: Dict; phase: DivisionPhase | "in_play"; inPlay?: number; attention?: Attention[]; className?: string }): JSX.Element
export interface NeedsYouItem { key: string; severity: Severity; kind: Attention["kind"]; title: string; sub: string; action: { label: string; href: string } }
export function needsYouItems(dict: Dict, desk: CompetitionDesk, divisions: { id: string; name: string; slug: string }[], org: string, comp: string): NeedsYouItem[]
export function NeedsYou(props: { dict: Dict; items: NeedsYouItem[] }): JSX.Element | null
export interface LedgerRow { id: string; name: string; slug: string; sportKey: string; logoUrl: string | null; desk: DeskDivision | null; statusLine: string; menu?: ReactNode }  // desk null = summary failed: no pill, no next line
export function DivisionLedger(props: { dict: Dict; rows: LedgerRow[]; org: string; comp: string; locale: string }): JSX.Element
```

- [ ] **Step 1: Write the failing SSR test**

`apps/web/src/components/v2/desk/__tests__/desk-ssr.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { PhasePill } from "@/components/v2/desk/phase-pill";
import { NeedsYou, needsYouItems } from "@/components/v2/desk/needs-you";
import { DivisionLedger } from "@/components/v2/desk/division-ledger";
import type { CompetitionDesk, DeskDivision } from "@/server/usecases/competition-desk";

const div = (o: Partial<DeskDivision> = {}): DeskDivision => ({
  division_id: "d1", phase: "scheduled", attention: [], played: 10, total: 15, unscheduled: 0, in_play: 0,
  entrants: 6, awaiting_confirmation: 0, stage_kinds: ["league"], next: null, needs_draw_stage: null,
  fixture_names: {}, display_tz: "Europe/London", ...o,
});
const desk = (d: DeskDivision, inPlay = 0): CompetitionDesk => ({ org_tz: "Europe/London", in_play: inPlay, divisions: new Map([[d.division_id, d]]) });
const names = [{ id: "d1", name: "Premier Division", slug: "premier-division" }];

describe("PhasePill", () => {
  it("shows the phase when nothing is red", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" />);
    expect(html).toContain('data-phase="scheduled"');
    expect(html).toContain("Scheduled");
  });
  it("red attention beats the phase", () => {
    const html = renderToStaticMarkup(
      <PhasePill dict={en} phase="setting_up" attention={[{ kind: "needs_draw", stageId: "s", stageName: "Finals" }]} />,
    );
    expect(html).toContain('data-phase="setting_up"');
    expect(html).toContain('data-pill="needs_draw"');
    expect(html).toContain("Needs draw");
    expect(html).not.toContain("Setting up");
  });
  it("amber attention does not beat the phase", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" attention={[{ kind: "unscheduled", count: 3 }]} />);
    expect(html).toContain("Scheduled");
    expect(html).not.toContain('data-pill="unscheduled"');
  });
  it("in_play carries the count", () => {
    expect(renderToStaticMarkup(<PhasePill dict={en} phase="in_play" inPlay={2} />)).toContain("2 in play");
  });
});

describe("NeedsYou", () => {
  it("renders nothing at all when there is nothing to do", () => {
    expect(NeedsYou({ dict: en, items: [] })).toBeNull();
  });
  it("builds one item per attention with a division-scoped href, severity first", () => {
    const d = div({
      phase: "match_day", in_play: 1,
      attention: [
        { kind: "unscheduled", count: 3 },
        { kind: "no_scorer", fixtureId: "f9", minutesSinceKickoff: 12 },
      ],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const items = needsYouItems(en, desk(d, 1), names, "org", "comp");
    expect(items.map((i) => i.kind)).toEqual(["no_scorer", "unscheduled"]);
    expect(items[0].title).toBe("Premier Division · Riverside FC v Summit CC has no scorer");
    expect(items[0].action.href).toBe("/o/org/c/comp/d/premier-division/f/9");
    expect(items[1].action.href).toBe("/o/org/c/comp/d/premier-division/schedule");
    const html = renderToStaticMarkup(<NeedsYou dict={en} items={items} />);
    expect(html).toContain('data-attention="no_scorer"');
    expect(html).toContain('data-severity="red"');
    expect(html).toContain("Assign scorer");
  });
});

describe("DivisionLedger", () => {
  it("row carries the sport glyph, the status line, the phase and no monogram letter", () => {
    const d = div({ phase: "finished", played: 15, total: 15 });
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: d, statusLine: "15 of 15 played · complete" }]} />,
    );
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-phase="finished"');
    expect(html).toContain("⚽");
    expect(html).toContain("15 of 15 played · complete");
    expect(html).not.toMatch(/Nothing scheduled yet/);
    expect(html).toContain('href="/o/org/c/comp/d/premier-division"');
  });
  it("renders a row without pill or next line when the desk summary is unavailable", () => {
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "X", slug: "x", sportKey: "football", logoUrl: null, desk: null, statusLine: "10 of 15 played" }]} />,
    );
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-phase="unknown"');
    expect(html).not.toContain("data-pill=");
    expect(html).toContain("10 of 15 played");
  });
  it("uses the uploaded logo instead of the glyph when present", () => {
    const html = renderToStaticMarkup(
      <DivisionLedger dict={en} org="org" comp="comp" locale="en"
        rows={[{ id: "d1", name: "X", slug: "x", sportKey: "football", logoUrl: "https://cdn/x.png", desk: div(), statusLine: "s" }]} />,
    );
    expect(html).toContain('src="https://cdn/x.png"');
    expect(html).not.toContain("⚽");
  });
});
```

- [ ] **Step 2: Run, expect collection failure**

Run: `cd /Users/ashokhein/github/seazn.club-fxc/apps/web && npx vitest run src/components/v2/desk/__tests__/desk-ssr.test.tsx --reporter=json --outputFile=/tmp/seazn-env/fxc/t4.json; node -e 'const r=require("/tmp/seazn-env/fxc/t4.json");console.log(r.numPassedTests,r.numFailedTests,r.numTotalTests)'`
Expected: `0 0 0`, failed suite.

- [ ] **Step 3: Implement `phase-pill.tsx`**

```tsx
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { ATTENTION_SEVERITY, type Attention, type DivisionPhase } from "@/lib/division-phase";

const PHASE_CLASS: Record<DivisionPhase | "in_play", string> = {
  setting_up: "bg-purple-50 text-purple-700",
  scheduled: "bg-slate-100 text-slate-600",
  match_day: "bg-amber-50 text-amber-700",
  in_play: "bg-[#170b3b] text-lime-400",
  finished: "bg-green-50 text-green-700",
};

export function PhasePill({
  dict, phase, inPlay = 0, attention = [], className = "",
}: { dict: Dict; phase: DivisionPhase | "in_play"; inPlay?: number; attention?: Attention[]; className?: string }) {
  // Spec: a RED attention outranks the phase on the pill; amber/slate do not.
  const red = attention.find((a) => ATTENTION_SEVERITY[a.kind] === "red");
  const label = red
    ? t(dict, red.kind === "needs_draw" ? "desk.pill.needs_draw" : "desk.pill.no_scorer")
    : phase === "in_play"
      ? t(dict, "desk.phase.in_play", { n: inPlay })
      : t(dict, `desk.phase.${phase}`);
  const cls = red ? "bg-red-50 text-red-700" : PHASE_CLASS[phase];
  return (
    <span
      data-phase={phase}
      data-pill={red ? red.kind : phase}
      className={`badge inline-flex items-center gap-1.5 normal-case ${cls} ${className}`}
    >
      <i aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
```

`t(dict, \`desk.phase.${phase}\`)` needs a `TKey`-typed template; if tsc rejects the template literal, switch to an explicit `Record<DivisionPhase, TKey>` map with the five keys.

- [ ] **Step 4: Implement `needs-you.tsx`**

```tsx
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { ATTENTION_SEVERITY, type Attention, type Severity } from "@/lib/division-phase";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

export interface NeedsYouItem {
  key: string;
  severity: Severity;
  kind: Attention["kind"];
  title: string;
  sub: string;
  action: { label: string; href: string };
}

const SEV_ORDER: Severity[] = ["red", "amber", "slate"];
const DOT: Record<Severity, string> = { red: "bg-red-600", amber: "bg-amber-600", slate: "bg-slate-500" };

export function needsYouItems(
  dict: Dict,
  desk: CompetitionDesk,
  divisions: { id: string; name: string; slug: string }[],
  org: string,
  comp: string,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  let waiting = 0;
  for (const d of divisions) {
    const dd = desk.divisions.get(d.id);
    if (!dd) continue;
    for (const a of dd.attention) {
      const sev = ATTENTION_SEVERITY[a.kind];
      switch (a.kind) {
        case "needs_draw":
          items.push({
            key: `${d.id}:needs_draw`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.needs_draw", { division: d.name, stage: a.stageName }),
            sub: t(dict, "desk.needsYou.needs_draw.sub"),
            action: { label: t(dict, "desk.needsYou.needs_draw.action"), href: routes.division(org, comp, d.slug, "fixtures") },
          });
          break;
        case "unscheduled":
          items.push({
            key: `${d.id}:unscheduled`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.unscheduled", { division: d.name, n: a.count }),
            sub: t(dict, "desk.needsYou.unscheduled.sub"),
            action: { label: t(dict, "desk.needsYou.unscheduled.action"), href: routes.divisionSchedule(org, comp, d.slug) },
          });
          break;
        case "no_scorer": {
          const f = dd.fixture_names[a.fixtureId];
          items.push({
            key: `${d.id}:no_scorer:${a.fixtureId}`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.no_scorer", { division: d.name, home: f?.home ?? "—", away: f?.away ?? "—" }),
            sub: t(dict, "desk.needsYou.no_scorer.sub", { minutes: a.minutesSinceKickoff }),
            action: { label: t(dict, "desk.needsYou.no_scorer.action"), href: routes.fixture(org, comp, d.slug, f?.fixture_no ?? 0) },
          });
          break;
        }
        case "result_missing": {
          const f = dd.fixture_names[a.fixtureId];
          items.push({
            key: `${d.id}:result_missing:${a.fixtureId}`, severity: sev, kind: a.kind,
            title: t(dict, "desk.needsYou.result_missing", { division: d.name, home: f?.home ?? "—", away: f?.away ?? "—" }),
            sub: t(dict, "desk.needsYou.result_missing.sub"),
            action: { label: t(dict, "desk.needsYou.result_missing.action"), href: routes.fixture(org, comp, d.slug, f?.fixture_no ?? 0) },
          });
          break;
        }
        case "registrations_waiting":
          waiting += a.count; // one competition-level row, not one per division
          break;
      }
    }
  }
  if (waiting > 0) {
    items.push({
      key: "registrations", severity: "slate", kind: "registrations_waiting",
      title: t(dict, "desk.needsYou.registrations_waiting", { n: waiting }),
      sub: t(dict, "desk.needsYou.registrations_waiting.sub"),
      action: { label: t(dict, "desk.needsYou.registrations_waiting.action"), href: routes.competitionRegistration(org, comp) },
    });
  }
  return items.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
}

export function NeedsYou({ dict, items }: { dict: Dict; items: NeedsYouItem[] }) {
  if (items.length === 0) return null;
  return (
    <section data-testid="desk-needs-you" className="mb-6">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-slate-600">
        {t(dict, "desk.needsYou.title")} · {items.length}
      </h2>
      <div className="card divide-y divide-purple-50">
        {items.map((it) => (
          <div key={it.key} data-attention={it.kind} data-severity={it.severity} className="flex items-center gap-3 px-4 py-3">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[it.severity]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-900">{it.title}</p>
              <p className="text-xs text-slate-600">{it.sub}</p>
            </div>
            <Link href={it.action.href} className={`btn ${it.severity === "red" ? "btn-primary" : "btn-ghost"} shrink-0 px-3 py-1.5 text-xs`}>
              {it.action.label}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Implement `division-ledger.tsx`**

```tsx
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { sportEmoji } from "@/components/discovery-cards";
import { whenLabel } from "@/lib/division-status-line";
import type { DeskDivision } from "@/server/usecases/competition-desk";
import { PhasePill } from "./phase-pill";

export interface LedgerRow {
  id: string;
  name: string;
  slug: string;
  sportKey: string;
  logoUrl: string | null;
  /** null when getCompetitionDesk failed: the row still renders from card stats. */
  desk: DeskDivision | null;
  statusLine: string;
  menu?: ReactNode;
}

const BAR: Record<DeskDivision["phase"], string> = {
  setting_up: "bg-purple-600", scheduled: "bg-purple-600", match_day: "bg-amber-600", finished: "bg-green-700",
};

function nextLine(dict: Dict, d: DeskDivision, locale: string): string {
  if (!d.next) return t(dict, "desk.ledger.nothingNext");
  const home = d.next.home ?? "—";
  const away = d.next.away ?? "—";
  if (d.next.in_play) return t(dict, "desk.ledger.now", { home, away });
  const when = d.next.scheduled_at ? whenLabel(d.next.scheduled_at, locale, d.display_tz) : "";
  return t(dict, "desk.ledger.next", { when, home, away }).replace("  ", " ");
}

export function DivisionLedger({ dict, rows, org, comp, locale }: { dict: Dict; rows: LedgerRow[]; org: string; comp: string; locale: string }) {
  return (
    <section data-testid="desk-ledger">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-slate-600">
        {t(dict, "desk.ledger.title")} · {rows.length}
      </h2>
      <div className="card divide-y divide-purple-50">
        {rows.map((r) => {
          const d = r.desk;
          const pct = d && d.total > 0 ? Math.round((d.played / d.total) * 100) : 0;
          const href = routes.division(org, comp, r.slug);
          return (
            <div key={r.id} data-testid="desk-ledger-row" data-phase={d ? d.phase : "unknown"}
                 className="grid grid-cols-[36px_1fr_auto] items-center gap-3 px-4 py-3 md:grid-cols-[36px_1.3fr_1fr_130px_1.4fr_auto]">
              <span aria-hidden className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-purple-50 text-lg leading-none">
                {r.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- tenant-uploaded logo
                  <img src={r.logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  sportEmoji(r.sportKey)
                )}
              </span>
              <div className="min-w-0">
                <Link href={href} className="block truncate text-sm font-semibold text-slate-900">{r.name}</Link>
                <p className="truncate text-xs text-slate-600">{r.statusLine}</p>
              </div>
              <div className="hidden md:block">
                <div className="h-1.5 overflow-hidden rounded-full bg-purple-100">
                  <i className={`block h-full rounded-full ${d ? BAR[d.phase] : "bg-purple-300"}`} style={{ width: `${pct}%` }} />
                </div>
                {d && <p className="mt-1 text-[11px] text-slate-600">{t(dict, "card.progress.played", { played: d.played, total: d.total })}</p>}
              </div>
              <div className="hidden md:block">{d && <PhasePill dict={dict} phase={d.phase} attention={d.attention} />}</div>
              <p className="hidden text-xs text-slate-900 md:block">{d ? nextLine(dict, d, locale) : ""}</p>
              <div className="flex items-center gap-2">
                <Link href={href} className="btn btn-ghost px-3 py-1.5 text-xs">{t(dict, "desk.ledger.open")}</Link>
                {r.menu}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Run, expect 10 passed**

Same command as Step 2. Expected `10 0 10`.

- [ ] **Step 7: Mutation check**

In `phase-pill.tsx`, change `ATTENTION_SEVERITY[a.kind] === "red"` to `=== "amber"` → tests "red attention beats the phase" AND "amber attention does not beat the phase" must both fail. Restore, re-run green.

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/src/components/v2/desk && git commit -m "feat(desk): phase pill, Needs you list, division ledger (server components)

Sport glyph or uploaded logo on every row, never a monogram; red attention
outranks the phase on the pill; Needs you renders nothing when empty.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 5: Wire the competition page

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` — imports (lines 1-30), data block (41-57), masthead (110-146 → Event pass moves into the actions row, phase pill under the title), divisions grid (282-329 → ledger).
- Test: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/__tests__/page-desk.test.ts` is NOT created — the page is a server component with auth; coverage comes from Task 3 (use case), Task 4 (SSR) and Task 7 (e2e).

**Interfaces:**
- Consumes: `getCompetitionDesk`, `competitionPhase` (Task 3); `PhasePill`, `NeedsYou`, `needsYouItems`, `DivisionLedger`, `LedgerRow` (Task 4); `statusLine` (Task 2).

- [ ] **Step 1: Imports**

Add after line 9 (`listDivisionCardStats` import):

```ts
import { getCompetitionDesk, competitionPhase } from "@/server/usecases/competition-desk";
import { statusLine } from "@/lib/division-status-line";
import { PhasePill } from "@/components/v2/desk/phase-pill";
import { NeedsYou, needsYouItems } from "@/components/v2/desk/needs-you";
import { DivisionLedger, type LedgerRow } from "@/components/v2/desk/division-ledger";
```

Remove the now-unused imports once the grid is replaced: `EntityCard`, `ViewToggleContainer`, `StatusChip`, `divisionChipState`, `CHIP_SORT`, `monogram`, `nextLine`. Keep `formatLabel`, `CardMenu`, `divisionAccent` only if still referenced (the `RegistrationHubNavEntry` block below the data load reads `stats` — leave that untouched).

- [ ] **Step 2: Data block**

Change the `Promise.all` at lines 41-57 to add a sixth member after `listDivisionCardStats(auth, id)`:

```ts
    // Spec §Error handling: a summary failure never blanks the page.
    getCompetitionDesk(auth, id).catch((err: unknown) => {
      log.error({ event: "competition_desk_failed", competitionId: id, err }, "competition_desk_failed");
      return null;
    }),
```

(import `log` from `@/server/logger`) and the destructure to `const [competition, divisions, stats, desk, currency, [subRow]] = …`. Then, after `trialAvailable`, add:

```ts
  const compPhase = desk ? competitionPhase(desk) : null;
  const divisionNames = divisions.map((d) => ({ id: d.id, name: d.name, slug: d.slug }));
  const needs = desk && canEdit ? needsYouItems(dict, desk, divisionNames, orgSlug, compSlug) : [];
  const ledgerRows: LedgerRow[] = divisions.map((d) => {
    const dd = desk?.divisions.get(d.id) ?? null;
    const s = stats.get(d.id);
    if (!dd) {
      return {
        id: d.id, name: d.name, slug: d.slug, sportKey: d.sport_key,
        logoUrl: resolveLogoUrl(d.logo_storage_path, d.logo_url), desk: null,
        statusLine: t(dict, "card.progress.played", { played: s?.played ?? 0, total: s?.total ?? 0 }),
      };
    }
    return {
      id: d.id,
      name: d.name,
      slug: d.slug,
      sportKey: d.sport_key,
      logoUrl: resolveLogoUrl(d.logo_storage_path, d.logo_url),
      desk: dd,
      statusLine: statusLine(dict, {
        phase: dd.phase, played: dd.played, total: dd.total, unscheduled: dd.unscheduled, inPlay: dd.in_play,
        entrants: dd.entrants,
        next: dd.next ? { scheduledAt: dd.next.scheduled_at, home: dd.next.home, away: dd.next.away } : null,
        needsDrawStageName: dd.needs_draw_stage?.name ?? null, locale, displayTz: dd.display_tz,
      }),
      menu: (
        <CardMenu
          name={d.name}
          items={[
            { label: t(dict, "action.schedule"), href: routes.divisionSchedule(orgSlug, compSlug, d.slug) },
            { label: t(dict, "action.slideshow"), href: routes.slideshowDivision(d.id), external: true },
          ]}
        />
      ),
    };
  });
```

Order: rows sorted so red attention first, then `match_day`, `scheduled`, `setting_up`, `finished`:

```ts
  const PHASE_RANK = { match_day: 0, scheduled: 1, setting_up: 2, finished: 3 } as const;
  const rank = (r: LedgerRow) =>
    !r.desk ? 9 : r.desk.attention.some((x) => x.kind === "needs_draw" || x.kind === "no_scorer") ? -1 : PHASE_RANK[r.desk.phase];
  ledgerRows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
```

- [ ] **Step 3: Masthead**

Move the entire `<CompetitionPassEntry … />` element (lines 118-141) out of the title column and into the header-actions `<div className="flex flex-wrap items-center gap-2">` as its FIRST child (before the Slideshow link). Under the `<h1>` add:

```tsx
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              {compPhase && <PhasePill dict={dict} phase={compPhase} inPlay={desk?.in_play ?? 0} />}
              <span>{[...new Set(divisions.map((d) => d.sport_key))].join(" · ")}</span>
              <span>·</span>
              <span>{t(dict, "desk.masthead.divisions", { n: divisions.length })}</span>
            </div>
```

`desk.masthead.divisions` was added in Task 2. The sport list is TEXT — no icon on the masthead (owner ruling).

- [ ] **Step 4: Needs you + ledger**

Directly after the masthead `</div>` (the `mb-6 flex flex-wrap …` block closes at line ~232) insert `<NeedsYou dict={dict} items={needs} />`. Replace the `<ViewToggleContainer …>…</ViewToggleContainer>` block (282-327) with:

```tsx
              <DivisionLedger dict={dict} rows={ledgerRows} org={orgSlug} comp={compSlug} locale={locale} />
```

Keep the surrounding empty-state branch (`divisions.length === 0 ? … :`) and the `+ Add division` control exactly where they are.

- [ ] **Step 5: Typecheck and lint, scoped**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh gate --label fxc > /tmp/seazn-env/fxc/gate5.log 2>&1; echo "EXIT=$?"; grep -aE "Cached|error TS|✖|problems" /tmp/seazn-env/fxc/gate5.log | head`
Expected: `EXIT=0`, no `error TS`, `✖ 0 problems` or no `✖` line. Judge on the `Cached: N cached, M total` line that `apps/web` actually ran (not a cache hit).

- [ ] **Step 6: Rebuild, look**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label fxc > /tmp/seazn-env/fxc/rebuild5.log 2>&1; echo "EXIT=$?"; tail -3 /tmp/seazn-env/fxc/rebuild5.log`
Then screenshot `/o/my-organization/c/spring-football-league` at 1280, 768, 320 with the Playwright script pattern from the session scratchpad (`apps/web/node_modules/.cache/shot2.mjs`: login by password as `scripts/.seed-demo-state.json`'s pro email, `smokepass123`). Confirm: no `Nothing scheduled yet` on the page (`grep -c` the HTML via `curl -s -b cookie`), the U16 row reads "Needs draw", the Premier row reads "Finished", `document.documentElement.scrollWidth === viewport width` at all three widths.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && npm run openapi:gen >/dev/null 2>&1; git status --porcelain | grep -v '^ M apps/web/src/app' ; git add "apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx" apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts && git commit -m "feat(desk): competition page — phase pill, Needs you, division ledger

Event pass moves out of the hero slot into the tools row; sport named as text
on the masthead, glyph on each row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

(The `grep -v` line must print nothing — any other modified file is OpenAPI drift or an accidental edit.)

---

### Task 6: Division page — tip gated to setting-up, stages in seq order

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (where `<StagesPanel` is rendered, ~line 452-470; and the data block ~lines 100-200 where `stages`, `fixtures`, `settings` are already loaded)
- Modify: `apps/web/src/components/v2/stages-panel.tsx:393` (props), `:718` (tip), `:800-806` (sort)
- Test: `apps/web/src/components/v2/__tests__/stages-panel-phase.test.tsx` (new)

**Interfaces:**
- Consumes: `resolvePhase`, `PhaseInput` (Task 1); the page already has `stages: StageRow[]`, `fixtures` (from `listDivisionFixtures`), `settings` (from `getScheduleSettings`, display tz only) and `division.status`.
- Produces: `StagesPanel` prop `phase?: DivisionPhase` (optional; absent ⇒ tip hidden).

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/v2/__tests__/stages-panel-phase.test.tsx` — same harness as `stages-panel-delete.test.tsx:1-30` (static render, `next/navigation` and `confirm-provider` mocked), plus a tip mock so the id is observable:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string }> = {}) => ({
  id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active", ...o,
});
const fixture = (stageId: string) => ({
  id: `f-${stageId}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null,
});
const baseProps = {
  divisionId: "d1", divisionSeq: 5, competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage()], fixtures: [fixture("s1")], entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
};

describe("StagesPanel phase gating", () => {
  it("shows the start-locks tip only while setting up", () => {
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="setting_up" />)).toContain('data-tip="division.start-locks"');
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="scheduled" />)).not.toContain('data-tip="division.start-locks"');
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="finished" />)).not.toContain('data-tip="division.start-locks"');
  });
  it("renders stages by seq: a complete stage 1 stays above a pending stage 2", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} phase="setting_up"
        stages={[stage({ id: "s2", seq: 2, status: "pending", name: "Finals" }), stage({ id: "s1", seq: 1, status: "complete", name: "League" })]}
        fixtures={[fixture("s1")]} />,
    );
    expect(html.indexOf("League")).toBeGreaterThan(-1);
    expect(html.indexOf("League")).toBeLessThan(html.indexOf("Finals"));
  });
});
```

If `StagesPanel` has gained required props since `stages-panel-delete.test.tsx` was written, tsc (not vitest) reports them at the gate step; add them to `baseProps` with the same values that test uses.

- [ ] **Step 2: Run, expect 2 failed** (prop `phase` unknown → tsc is not run by vitest; the tip assertion fails because the tip renders for `finished`; the order assertion fails because complete sinks last).

Run: `cd /Users/ashokhein/github/seazn.club-fxc/apps/web && npx vitest run src/components/v2/__tests__/stages-panel-phase.test.tsx --reporter=json --outputFile=/tmp/seazn-env/fxc/t6.json; node -e 'const r=require("/tmp/seazn-env/fxc/t6.json");console.log(r.numPassedTests,r.numFailedTests,r.numTotalTests)'`
Expected: `0 2 2`.

- [ ] **Step 3: StagesPanel changes**

At `:393` add to the props destructure and type: `phase?: DivisionPhase;` (import `type { DivisionPhase } from "@/lib/division-phase"`). Optional by controller ruling: fifteen existing `stages-panel-*.test.tsx` files build props without it and the tsc gate would red on every one; an absent `phase` hides the tip (the gate is `phase === "setting_up"`), which is the safe direction.

At `:718` replace `{canEdit && <TipCallout id="division.start-locks" />}` with:

```tsx
      {canEdit && phase === "setting_up" && <TipCallout id="division.start-locks" />}
```

At `:800-806` replace the sort with:

```tsx
      {[...stages]
        .sort((a, b) => a.seq - b.seq)
        .map((stage) => {
```

- [ ] **Step 4: Division page computes the phase**

In `d/[divSlug]/page.tsx`, after `stages`, `fixtures` and `settings` are loaded (and `division` is in scope), add:

```ts
  const phase = resolvePhase({
    divisionStatus: division.status as DivisionStatus,
    stages: stages.map((s) => ({
      id: s.id, name: s.name, seq: s.seq, status: s.status,
      hasFixtures: fixtures.some((f) => f.stage_id === s.id),
      needsProposal: s.status === "pending" && (s.progression as { timing?: string } | null)?.timing === "setup" && !fixtures.some((f) => f.stage_id === s.id),
    })),
    fixtures: fixtures.map((f) => ({ id: f.id, status: f.status, scheduledAt: f.scheduled_at, eventCount: 0, matchMinutes: settings.config.matchMinutes ?? 60 })),
    now: new Date().toISOString(),
    tz: resolveVenueTz(null, page.org.timezone), // exactly what line 527 already passes as orgTz
    awaitingRegistrations: 0,
  });
```

(`eventCount: 0` and `awaitingRegistrations: 0` are fine here: this page needs only the PHASE; attention is the competition page's job. Import `resolvePhase`, `type DivisionStatus` from `@/lib/division-phase`; `resolveVenueTz` is already imported on this page.) Pass `phase={phase}` to `<StagesPanel` at line 508.

- [ ] **Step 5: Run, expect 2 passed**; then mutation: change the gate to `phase !== "finished"` → the tip test must FAIL on its `scheduled` case (that case exists precisely so this mutant cannot survive). Restore, re-run green.

- [ ] **Step 6: Gate and commit**

Run the scoped gate as in Task 5 Step 5. Then:

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/src/components/v2/stages-panel.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx" apps/web/src/components/v2/__tests__/stages-panel-phase.test.tsx && git commit -m "fix(desk): start-locks tip only while setting up; stages always in seq order

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 7: E2E, mobile matrix, smoke, help

**Files:**
- Create: `apps/web/e2e/competition-desk.spec.ts`
- Verify (no edit expected): `apps/web/e2e/mobile.spec.ts:316-325` already lists `competitionPath(request, compId)`.
- Modify: `scripts/smoke.ts` (one `check`)
- Modify: the competition-page help article under `content/help/` (find it: `grep -rla "Add division" content/help | head -1`)

- [ ] **Step 1: Write the e2e**

`apps/web/e2e/competition-desk.spec.ts`:

```ts
import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg, addEntrantsViaApi, createStageAndGenerate, setFixtureStatusSql } from "./helpers";

async function seed(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
  });
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Premier", sport_key: "football", variant_key: "11-a-side",
  });
  await addEntrantsViaApi(request, div.data!.id, ["Riverside FC", "Valley CC", "Lakeside FC", "Harbour CC"], "team");
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  return { compId: comp.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, fixtureIds };
}

test.describe("competition desk", () => {
  test("unscheduled league: Needs you names the gap and the ledger row is scheduled, not live", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const needs = page.getByTestId("desk-needs-you");
    await expect(needs.locator('[data-attention="unscheduled"]')).toHaveCount(1);
    await expect(needs).toContainText(`Premier · ${rig.fixtureIds.length} fixtures unscheduled`);
    const row = page.getByTestId("desk-ledger-row").first();
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).not.toContainText("Nothing scheduled yet");
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
    await needs.getByRole("link", { name: "Open schedule board" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${rig.divSlug}/schedule$`));
  });

  test("in play with no events: No scorer leads and the competition pill counts it", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await setFixtureStatusSql(rig.fixtureIds[0], "in_play");
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const first = page.getByTestId("desk-needs-you").locator("[data-attention]").first();
    await expect(first).toHaveAttribute("data-attention", "no_scorer");
    await expect(page.locator('[data-pill="no_scorer"]').first()).toBeVisible();
    await expect(page.locator('[data-phase="in_play"]').first()).toContainText("1 in play");
  });

  test("all decided: finished, no Needs you section at all", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    for (const id of rig.fixtureIds) await setFixtureStatusSql(id, "decided");
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    await expect(page.getByTestId("desk-ledger-row").first()).toHaveAttribute("data-phase", "finished");
    await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  });
});
```

The "all decided" case needs the stage complete as well (rule 1: every stage complete, or no open stage AND no live fixture). Add `setStageStatusSql(stageId: string, status: string)` to `apps/web/e2e/helpers.ts` directly beneath `setFixtureStatusSql` (helpers.ts:620), same shape with `update stages set status = ${status} where id = ${stageId}`; call it with the `stageId` returned by `createStageAndGenerate` before the loop over fixtures.

- [ ] **Step 2: Run it against the fxc server**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fxc)" && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label fxc >/tmp/seazn-env/fxc/rb7.log 2>&1 && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fxc)" && cd apps/web && E2E_PROD_TARGET=1 PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test --project=parallel e2e/competition-desk.spec.ts --reporter=line 2>&1 | tail -15`
Expected: `3 passed`. Use `localhost`, not `127.0.0.1`, in `SMOKE_BASE` (secure cookie).

- [ ] **Step 3: Mobile matrix**

Run: `cd /Users/ashokhein/github/seazn.club-fxc/apps/web && E2E_PROD_TARGET=1 PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test e2e/mobile.spec.ts -g "console routes" --reporter=line 2>&1 | tail -12`
Expected: passes for all seven width projects; the competition path is already in the `routes` array (`mobile.spec.ts:323`). If the widths project names differ, run without `-g` and read the per-project lines.

- [ ] **Step 4: Smoke**

In `scripts/smoke.ts`, next to the existing competition-page GET check (grep `"/o/"` in the file for where a competition page is fetched), add:

```ts
  check("competition page carries a derived phase per division", /data-phase="(setting_up|scheduled|match_day|finished|in_play)"/.test(compHtml));
```

fetched the way `scripts/smoke.ts:3807-3814` fetches the fixture page: `const compHtml = await (await fetch(`${BASE}/o/${orgSlug}/c/${compData.slug}`, { headers: { cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join("; ") } })).text();` placed right after that block, where `orgSlug`, `compData` and `admin` are already in scope. Run: `SMOKE_BASE=$SMOKE_BASE npm run smoke 2>&1 | grep -aE "derived phase|^PASS|^FAIL" | tail -5` — expect the new line `PASS`.

- [ ] **Step 5: Help**

In the competition-page article (found by the grep above), add one paragraph under the section that introduces the page: "**Needs you** lists what is blocking the competition — a stage waiting on its draw, fixtures without a time, a match in play with no scorer, results overdue, registrations to approve — with one button each. The pill beside the title is derived from your divisions: Setting up, Scheduled, Match day, N in play, or Finished. A division row shows its sport, one status line, and a red pill when something on it needs you." English only.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/e2e/competition-desk.spec.ts apps/web/e2e/helpers.ts scripts/smoke.ts content/help && git commit -m "test(desk): competition desk e2e, smoke phase check, help copy

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 7b: Customer walkthrough — an organiser takes a competition from blank to finished and the desk tells the truth at every step

**Files:**
- Create: `apps/web/e2e/walkthrough/competition-desk-organiser.spec.ts`
- Verify: `apps/web/playwright.config.ts:119` selects `e2e/walkthrough/` into the `walkthrough` project automatically (no config edit).

**Interfaces:**
- Consumes: helpers `activeOrg`, `apiJson`, `TAG`, `loginUi`, `createCompetitionViaUi(page, name, visibility?)`, `createDivisionViaUi(page, competitionId, name, …)`, `addEntrantsViaApi`, `scoreFixture(request, fixtureId, p1, p2)`, `setFixtureStatusSql`, `setStageStatusSql` (Task 7), `screenshotAtWidths`, `expectNoHorizontalScroll` from `../helpers`; `data-testid`/`data-phase`/`data-attention`/`data-pill` hooks from Task 4.

The walkthrough rule: the API may be used to REACH a state; every step that IS the thing under test — reading the desk and acting from it — is done through the UI. Here the thing under test is the desk's honesty and its buttons, so creating the competition and division goes through the UI (that is where a new organiser starts), entrants/results are reached via API (they are not this wave's surface), and every read + click on the competition page is by hand.

- [ ] **Step 1: Write the walkthrough**

`apps/web/e2e/walkthrough/competition-desk-organiser.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import {
  activeOrg, apiJson, TAG, createCompetitionViaUi, createDivisionViaUi, addEntrantsViaApi,
  createStageAndGenerate, scoreFixture, setFixtureStatusSql, setStageStatusSql,
  screenshotAtWidths, expectNoHorizontalScroll,
} from "../helpers";

test.describe.configure({ mode: "serial" });

test("an organiser watches the desk go Setting up → Scheduled → Match day → No scorer → Finished, and every button lands where it says", async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const shot = (name: string) => page.screenshot({ path: `${testInfo.outputPath()}/${name}.png`, fullPage: true });
  const org = await activeOrg(page);

  // 1. Blank competition, made by hand.
  const compId = await createCompetitionViaUi(page, `Desk Walk ${TAG}`, "public");
  const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${compId}`, "GET");
  const compPath = `/o/${org.slug}/c/${comp.data!.slug}`;
  await page.goto(compPath);
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  await expect(page.getByTestId("desk-ledger-row")).toHaveCount(0);
  await shot("01-blank");

  // 2. One division, made by hand: the row appears with its sport glyph and Setting up.
  const divId = await createDivisionViaUi(page, compId, "Premier");
  await page.goto(compPath);
  const row = page.getByTestId("desk-ledger-row").first();
  await expect(row).toHaveAttribute("data-phase", "setting_up");
  await expect(row).toContainText("Setting up");
  await expect(row.locator("span[aria-hidden]").first()).not.toHaveText(/^[A-Z]$/); // glyph or logo, never a monogram
  await shot("02-setting-up");

  // 3. Reach: entrants + generated fixtures (API). Read: Needs you names the unscheduled round.
  await addEntrantsViaApi(request, divId, ["Riverside FC", "Valley CC", "Lakeside FC", "Harbour CC"], "team");
  const { stageId, fixtureIds: ids } = await createStageAndGenerate(request, divId);
  await apiJson(request, `/api/v1/divisions/${divId}/start`, "POST");
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "scheduled");
  const needs = page.getByTestId("desk-needs-you");
  await expect(needs.locator('[data-attention="unscheduled"]')).toContainText(`${ids.length} fixtures unscheduled`);
  await shot("03-unscheduled");
  await needs.getByRole("link", { name: "Open schedule board" }).click();
  await expect(page).toHaveURL(/\/schedule$/);

  // 4. Reach: kick-off today (API PATCH). Read: Match day.
  const today = new Date(); today.setUTCHours(18, 0, 0, 0);
  await apiJson(request, `/api/v1/fixtures/${ids[0]}`, "PATCH", { scheduled_at: today.toISOString() });
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "match_day");
  await expect(page.locator('[data-phase="match_day"]').first()).toBeVisible();
  await shot("04-match-day");

  // 5. Reach: in play, nobody scoring (SQL). Read: No scorer leads, and the button lands on the fixture.
  await setFixtureStatusSql(ids[0], "in_play");
  await page.goto(compPath);
  await expect(needs.locator("[data-attention]").first()).toHaveAttribute("data-attention", "no_scorer");
  await expect(row.locator('[data-pill="no_scorer"]')).toBeVisible();
  await expect(page.locator('[data-phase="in_play"]').first()).toContainText("1 in play");
  await shot("05-no-scorer");
  await needs.getByRole("link", { name: "Assign scorer" }).click();
  await expect(page).toHaveURL(/\/f\/\d+$/);

  // 6. Reach: every result in, stage complete (API + SQL). Read: Finished, nothing needs the organiser.
  await setFixtureStatusSql(ids[0], "scheduled");
  for (const id of ids) await scoreFixture(request, id, 2, 1);
  await setStageStatusSql(stageId, "complete");
  await page.goto(compPath);
  await expect(row).toHaveAttribute("data-phase", "finished");
  await expect(row).toContainText("complete");
  await expect(row).not.toContainText("Nothing scheduled");
  await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  await shot("06-finished");

  // 7. The page holds at every width, in this final state.
  await screenshotAtWidths(page, testInfo, "desk-finished");
  await expectNoHorizontalScroll(page);
});
```

Helper signatures confirmed 2026-09-02 (`apps/web/e2e/helpers.ts`): `expectNoHorizontalScroll(page, { allowancePx? })` :43; `screenshotAtWidths(page, testInfo, name, widths?)` :240 (defaults to the standard width set); `addEntrantsViaApi(request, divisionId, names, kind?, seedOffset?)` :1157; `createStageAndGenerate(request, divisionId, stage?)` :1174 returning `{ stageId, fixtureIds }`; `scoreFixture(request, fixtureId, p1Score, p2Score)` :1397; `createCompetitionViaUi(page, name, visibility?)` :1460 returning the competition id; `createDivisionViaUi(page, competitionId, name)` :1497 returning the division id; `setFixtureStatusSql(fixtureId, status)` :620; `activeOrg(page)` :1013.

`scoreFixture` reads the fixture's state first, so the fixture left `in_play` by step 5 must be reset to `scheduled` before step 6 scores it — the reset in step 6 is deliberate, keep it.

- [ ] **Step 2: Run it in the walkthrough project**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fxc)" && cd apps/web && E2E_PROD_TARGET=1 PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test --project=walkthrough e2e/walkthrough/competition-desk-organiser.spec.ts --reporter=line 2>&1 | tail -12`
Expected: `1 passed`. Open the six numbered screenshots in the test's output dir and confirm each shows the state its name claims (pill text, Needs you rows). A screenshot that shows the previous state is a defect in the product or the wait, not a pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git add apps/web/e2e/walkthrough/competition-desk-organiser.spec.ts && git commit -m "test(desk): organiser walkthrough — blank to finished through the competition desk

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013UrscuUPj2x28AZFkQ9uNR"
```

---

### Task 8: Wave gate and visual sign-off

- [ ] **Step 1: Full apps/web vitest, JSON**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fxc)" && cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/seazn-env/fxc/all.json > /dev/null 2>&1; node -e 'const r=require("/tmp/seazn-env/fxc/all.json");console.log("pass",r.numPassedTests,"fail",r.numFailedTests,"total",r.numTotalTests,"suitesFailed",r.numFailedTestSuites,"foreign",r.testResults.filter(t=>!t.name.startsWith("/Users/ashokhein/github/seazn.club-fxc/")).length)'`
Expected: `fail 0`, `suitesFailed 0`, `foreign 0`. A `venues.test.ts` lock-contention red is a known flake — re-run that file alone up to three times before reading it as real.

- [ ] **Step 2: Full gate (lint + typecheck, CI-equivalent)**

Run: `cd /Users/ashokhein/github/seazn.club-fxc && GATE_FILTER= ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh gate --label fxc > /tmp/seazn-env/fxc/gate8.log 2>&1; echo "EXIT=$?"; grep -aE "Cached|error TS|✖" /tmp/seazn-env/fxc/gate8.log`
Expected `EXIT=0`, no `error TS`, no `✖ N problems` with N > 0.

- [ ] **Step 3: Screenshots, per-screen verdicts**

Against the rebuilt fxc server: competition page in three states (seeded league unscheduled; one in_play; all decided — set via SQL on the fxc DB) at 1280 / 768 / 320. Confirm the files exist, differ between states (`cmp`), and that `scrollWidth === innerWidth` at each width. Write the verdicts (one line per screen: what it shows, pass/fail) into `docs/superpowers/specs/2026-09-02-competition-desk-design.md` under a new `## W1 sign-off (date)` section and commit. That section, not "CI green", is the merge evidence.

- [ ] **Step 4: Rebase and push**

```bash
cd /Users/ashokhein/github/seazn.club-fxc && git fetch origin main && git rebase origin/main && git push -u origin feat/fixture-console-redesign
```

Open the PR only when the owner says so (never file PRs unprompted). Note for the PR body: e2e runs on push to `main` only; smoke runs on PRs only.
