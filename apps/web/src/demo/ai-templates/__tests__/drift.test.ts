// #364 Task 4 — the drift guard: the museum tripwire for the committed demo runs.
//
// The three JSONs beside this directory are recordings of REAL architect runs
// (Task 3). They are rendered forever by the public marketing page, which means
// they are the one artefact in this repo that nobody re-derives: no route builds
// them, no migration touches them, and no type error can reach them, because
// `AiDemoFixture.pack` and `.response` are deliberately `unknown` (types.ts).
//
// So this suite re-runs TODAY's referee over YESTERDAY's recording. For each
// fixture it re-parses the wire response with today's zod, re-projects the plan,
// re-runs the structural gate the runner runs before the engine, and re-runs the
// engine verifier itself with the pack's own config — the same four calls
// `runAiPlan` (schedule-ai.ts:1993) and `aiPlanForCompetition`
// (competition-schedule-ai.ts:1953) make on a live run. When tomorrow's schema
// or tomorrow's verifier rejects a committed run, this goes red HERE rather than
// on the marketing page.
//
// It is PURE on purpose: static fixture reads, no database, no network, no gate.
// It lives outside `__capture__/` for that reason — everything in there is
// DB-gated and skips without `DATABASE_URL`, and a guard that skips is not one.
//
// What is deliberately NOT asserted, and why:
//
//   * warning PARITY. `pack.parsed` is empty by construction on every committed
//     fixture — `buildSchedulePack` takes the `opts.resolved ?? resolveParsed(…)`
//     path (schedule-ai.ts:908) and never compiles the instruction — so the
//     warn-only conflict set can legitimately differ between capture time and
//     guard time. Only BLOCKING is asserted (the runner's own `isBlocking`).
//   * the board row `code`. The capture derives `F{fixture_no}`; production's
//     `consoleFixtures` derives `R{round}·{seq}`. Known, documented in
//     `__capture__/capture.test.ts:200`, and fine — the demo lists a whole
//     competition flat, where a round/seq code repeats across divisions. The
//     field SET is asserted; that one field's VALUE format is not.
import { readFileSync } from "node:fs";
import path from "node:path";

import { validateAssignments, type Conflict } from "@seazn/engine/scheduling";
import { describe, expect, it } from "vitest";

import type { AiConsoleFixture } from "@/components/v2/board/ai-diff";
import { AiCompetitionPlanResponse, AiPlanResponse } from "@/server/api-v1/schemas";
import {
  jointStructuralCheck,
  partitionConflicts,
  verifyJoint,
  type CompetitionPack,
} from "@/server/usecases/competition-schedule-ai";
import {
  isBlocking,
  packFeedDependencies,
  structuralCheck,
  toEngineAssignments,
  toObstacleAssignments,
  verifyConfig,
  type SchedulePack,
} from "@/server/usecases/schedule-ai";
import { AiSchedulePlan } from "@/server/usecases/schedule-ai-prompt";

import type { AiDemoFixture } from "../types";

/** `apps/web/src/demo/ai-templates` — where the committed fixtures live. */
const FIXTURE_DIR = path.resolve(__dirname, "..");

/**
 * Read a committed fixture. THROWS rather than skips when one is missing, for
 * the same reason the capture guard does: the JSONs are the artefact this file
 * exists to protect, and a guard that quietly passes when its subject is absent
 * is not a guard.
 *
 * `JSON.parse` rather than a JSON `import`: the joint fixture is 235 KB and a
 * static import would hand `tsc` a literal type of that size for no benefit.
 */
function loadFixture(slug: string): AiDemoFixture {
  const file = path.join(FIXTURE_DIR, `${slug}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`no committed fixture at ${file} — run \`npm run capture:ai-demo\``);
  }
  const fixture = JSON.parse(raw) as AiDemoFixture;
  backfillRoundOrderFields(fixture.pack);
  return fixture;
}

/**
 * C1 gap B: `SchedulePack.stageIds`/`.roundNos` (and their joint twins on
 * `CompetitionPack`) postdate every committed recording — captured before the
 * fields existed, so the raw JSON has neither key at all. `unknown` is what
 * keeps this file compiling as the schema evolves (see the header); the flip
 * side is that a genuinely NEW field is invisible to `tsc` and surfaces as a
 * runtime crash instead (`pack.stageIds[id]` on an `undefined` map) the
 * moment a consumer starts reading it — which is what happened here the
 * instant `toEngineAssignments`/`toJointEngineAssignments` started reading
 * `stageIds`/`roundNos`.
 *
 * Backfilling empty maps is the historically honest reading: these
 * recordings genuinely carry no stage/round-robin data, so every fixture in
 * them comes through un-gated exactly as `buildSchedulePack` would leave a
 * non-round-robin fixture — never invented from `f.round` (the ungated,
 * model-facing display value), which would be the same forwarding bug this
 * whole feature exists to prevent, just relocated into a test. A future
 * `npm run capture:ai-demo` re-recording that already carries real values is
 * untouched — this only fills a key that is genuinely absent.
 */
function backfillRoundOrderFields(pack: unknown): void {
  if (typeof pack !== "object" || pack === null) return;
  const p = pack as { stageIds?: unknown; roundNos?: unknown };
  if (p.stageIds === undefined) p.stageIds = {};
  if (p.roundNos === undefined) p.roundNos = {};
}

/**
 * (g) The exact key set `consoleFixtures()` emits, read off its return object
 * literal at `src/components/v2/schedule-board.tsx:249-271`. Cite that line when
 * this list changes — it is the only place the two shapes meet.
 *
 * Typed as `Record<keyof Required<AiConsoleFixture>, true>` so the TYPE half is a
 * `tsc` gate rather than a comment: a field added to `AiConsoleFixture`
 * (ai-diff.ts:21-60) is a missing property here, a field removed from it is an
 * excess property, and `consoleFixtures`'s own literal is checked against that
 * same interface by its declared return type. `Required<>` is load-bearing —
 * `division_id` is optional on the interface (a joint-only chip source) and the
 * committed boards all carry it.
 */
const CONSOLE_FIXTURE_KEYS: Record<keyof Required<AiConsoleFixture>, true> = {
  id: true,
  stage_id: true,
  division_id: true,
  scheduled_at: true,
  court_label: true,
  code: true,
  matchup: true,
  isFinal: true,
  isJunior: true,
  status: true,
  home_entrant_id: true,
  away_entrant_id: true,
};

const CONSOLE_FIXTURE_KEY_LIST = Object.keys(CONSOLE_FIXTURE_KEYS).sort();

/** A value that may legitimately be absent from the board (unplaced fixture, bye). */
function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}

/** (g) One board row, field by field, against the production console shape. */
function expectConsoleFixtureShape(row: AiConsoleFixture): void {
  expect(Object.keys(row).sort()).toEqual(CONSOLE_FIXTURE_KEY_LIST);
  expect(typeof row.id).toBe("string");
  expect(typeof row.stage_id).toBe("string");
  expect(typeof row.division_id).toBe("string");
  expect(isStringOrNull(row.scheduled_at)).toBe(true);
  expect(isStringOrNull(row.court_label)).toBe(true);
  // `code` VALUE is deliberately unasserted (see the header); its presence and
  // type are not.
  expect(typeof row.code).toBe("string");
  expect(typeof row.matchup).toBe("string");
  expect(typeof row.isFinal).toBe("boolean");
  expect(typeof row.isJunior).toBe("boolean");
  expect(typeof row.status).toBe("string");
  expect(isStringOrNull(row.home_entrant_id)).toBe(true);
  expect(isStringOrNull(row.away_entrant_id)).toBe(true);
}

/**
 * (b) The plan the structural gate and the verifier are handed.
 *
 * Re-parsed through `AiSchedulePlan` rather than hand-mapped, for two reasons.
 * It STRIPS the two keys the wire adds and the plan does not carry — a joint
 * row's `division_id` and an unschedulable row's `rule` — which is exactly the
 * projection the brief asks for. And it is itself an assertion: the plan schema
 * is strictly NARROWER than the wire one (`scheduled_at` needs
 * `.datetime({offset:true})`, `court_label` `.min(1)`, both bare `z.string()` on
 * the wire), so a recording whose slots stopped being plan-legal reds here.
 *
 * `unschedulable` is projected TOO, and that is not cosmetic: `structuralCheck`
 * walks both halves and its last rule is "every movable id must appear in one of
 * them". A projection of `proposal` alone would report every deliberately
 * unschedulable fixture as missing from the plan — i.e. it would fail hardest on
 * exactly the run worth testing (finals-day).
 */
function planFrom(response: {
  proposal: unknown[];
  unschedulable: unknown[];
  explanations: unknown[];
  summary: string;
}): AiSchedulePlan {
  return AiSchedulePlan.parse({
    assignments: response.proposal,
    unschedulable: response.unschedulable,
    explanations: response.explanations,
    summary: response.summary,
  });
}

// ---------------------------------------------------------------------------
// Assertions every template owes, whichever path produced it
// ---------------------------------------------------------------------------

function expectCommonInvariants(fixture: AiDemoFixture, plan: AiSchedulePlan): void {
  // (h) The organiser's sentence the page shows being typed must be the sentence
  // the model was actually given. A hand-edited marketing line — a nicer verb, a
  // dropped clause — makes the recording a fiction, and nothing else notices.
  expect(fixture.meta.instruction).toBe((fixture.pack as { instruction: string }).instruction);

  // (d) Every proposed slot names a fixture the board actually holds. The page
  // paints ghosts by joining these two, so an id in one and not the other is a
  // blank block.
  const boardIds = new Set(fixture.board.fixtures.map((f) => f.id));
  for (const a of plan.assignments) expect(boardIds.has(a.fixture_id)).toBe(true);
  for (const u of plan.unschedulable) expect(boardIds.has(u.fixture_id)).toBe(true);

  // (d) …and a lane to paint it in. `board.courts` (types.ts:47) is what the
  // demo renders columns from — the UNION for a joint template — while every
  // court check upstream of here is against `pack.settings.courts` (or, jointly,
  // the fixture's own division's set). Those are different surfaces: a slot on a
  // court the pack has and the board does not verifies perfectly clean and then
  // paints a ghost into a column that is not there.
  const lanes = new Set(fixture.board.courts);
  expect(lanes.size).toBeGreaterThan(0);
  for (const a of plan.assignments) expect(lanes.has(a.court_label)).toBe(true);

  // (g) The board is field-compatible with what production's console builds.
  expect(fixture.board.fixtures.length).toBeGreaterThan(0);
  for (const row of fixture.board.fixtures) expectConsoleFixtureShape(row);
}

/**
 * The non-emptiness floor, pinned to the captured counts rather than `> 0`.
 *
 * Without it the tripwire's own SUBJECT can vanish silently: `AiPlanResponse`
 * puts no `.min(1)` on `proposal`, and both structural gates return `null` for
 * an empty plan against an empty `movableIds` (their loops have nothing to
 * iterate and every rule is vacuously satisfied). So a re-capture that wrote
 * `movableIds: []` / `proposal: []` — a seed that stopped producing fixtures, a
 * harness that recorded a refusal — would sail through (a)-(d), (g) and (h)
 * while the demo page rendered an empty board.
 *
 * Exact counts, the same stance as finals-day's `unschedulable === 4`: these are
 * recordings, and a recording that changed size is a different recording that
 * owes a deliberate re-baseline.
 */
function expectCapturedSize(
  fixture: AiDemoFixture,
  plan: AiSchedulePlan,
  captured: { placed: number; movable: number },
): void {
  expect(plan.assignments).toHaveLength(captured.placed);
  expect(fixture.movableIds).toHaveLength(captured.movable);
  // The pack must agree it had that much to move, or the counts above are
  // pinning a `movableIds` list nothing produced.
  expect((fixture.pack as { fixtures: { movable: unknown[] } }).fixtures.movable).toHaveLength(
    captured.movable,
  );
}

// ---------------------------------------------------------------------------
// T1 / T3 — the single-division recordings
// ---------------------------------------------------------------------------

describe.each([
  // `placed` / `movable` are the CAPTURED counts — see `expectCapturedSize`.
  // finals-day is the interesting pair: 25 placed out of 29 movable, the four
  // the blackout defeated being the difference.
  { slug: "club-night", mode: "generate" as const, placed: 12, movable: 12 },
  { slug: "finals-day", mode: "repair" as const, placed: 25, movable: 29 },
])("$slug — the committed run still verifies", ({ slug, mode, placed, movable }) => {
  const fixture = loadFixture(slug);

  it("declares itself a single-division run", () => {
    expect(fixture.meta.slug).toBe(slug);
    expect(fixture.meta.joint).toBe(false);
    expect(fixture.meta.mode).toBe(mode);
  });

  it("still records the board it captured, at the size it captured", () => {
    const plan = planFrom(AiPlanResponse.parse(fixture.response));
    expectCapturedSize(fixture, plan, { placed, movable });
  });

  it("(a) the recorded response still parses as today's AiPlanResponse", () => {
    expect(() => AiPlanResponse.parse(fixture.response)).not.toThrow();
  });

  it("(b) the plan projection still passes today's structural gate", () => {
    const parsed = AiPlanResponse.parse(fixture.response);
    const plan = planFrom(parsed);
    // `null` is the pass value — the function returns a human note on the FIRST
    // violation, so asserting the note itself is what names the drift.
    expect(structuralCheck(plan, new Set(fixture.movableIds), fixture.pack as SchedulePack)).toBe(
      null,
    );
  });

  it("(c) the plan still verifies with zero blocking conflicts", () => {
    const parsed = AiPlanResponse.parse(fixture.response);
    const plan = planFrom(parsed);
    const pack = fixture.pack as SchedulePack;
    // The runner's own four-argument call (schedule-ai.ts:1993) — one assembly,
    // not a second opinion, or the guard and the product drift apart.
    const conflicts: Conflict[] = validateAssignments(
      toEngineAssignments(plan, pack),
      verifyConfig(pack),
      toObstacleAssignments(pack),
      packFeedDependencies(pack),
    );
    // BLOCKING only — see the header on why warning parity is not asserted.
    expect(conflicts.filter(isBlocking)).toEqual([]);
  });

  it("(d/g/h) board, courts, instruction and proposal ids agree", () => {
    const plan = planFrom(AiPlanResponse.parse(fixture.response));
    expectCommonInvariants(fixture, plan);
  });
});

// ---------------------------------------------------------------------------
// T3 (finals-day) — what makes the repair recording worth keeping
// ---------------------------------------------------------------------------

describe("finals-day — the repair recording's own truths", () => {
  const fixture = loadFixture("finals-day");
  const parsed = AiPlanResponse.parse(fixture.response);

  it("(e) leaves exactly the four fixtures the run could not place", () => {
    // Captured truth, pinned exactly rather than `> 0`: this recording exists to
    // show the product being HONEST about what it cannot fit, and a re-capture
    // that quietly placed them all is a different demo.
    expect(parsed.unschedulable).toHaveLength(4);
  });

  it("(e) every unschedulable reason names the blackout that caused it", () => {
    for (const u of parsed.unschedulable) expect(u.reason).toMatch(/blackout/i);
    // …and the blackout is really in the pack, so the reason is not just prose.
    expect((fixture.pack as SchedulePack).settings.blackouts.length).toBeGreaterThan(0);
  });

  it("(e) never proposes a slot for a fixture already decided", () => {
    const decided = new Set(
      fixture.board.fixtures.filter((f) => f.status === "decided").map((f) => f.id),
    );
    expect(decided.size).toBeGreaterThan(0);
    for (const a of parsed.proposal) expect(decided.has(a.fixture_id)).toBe(false);
    // The stronger statement: a decided fixture was never even offered to the
    // model, so "untouched" is structural and not the model's good manners.
    for (const id of fixture.movableIds) expect(decided.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2 (northside-open) — the joint recording
// ---------------------------------------------------------------------------

describe("northside-open — the committed joint run still verifies", () => {
  const fixture = loadFixture("northside-open");
  const pack = fixture.pack as CompetitionPack;

  it("declares itself a joint run", () => {
    expect(fixture.meta.slug).toBe("northside-open");
    expect(fixture.meta.joint).toBe(true);
    expect(fixture.meta.mode).toBe("generate");
  });

  it("still records the board it captured, at the size it captured", () => {
    const plan = planFrom(AiCompetitionPlanResponse.parse(fixture.response));
    // The whole board placed: 115 movable, 115 slots, nothing unschedulable.
    expectCapturedSize(fixture, plan, { placed: 115, movable: 115 });
    expect(plan.unschedulable).toHaveLength(0);
  });

  it("(a) the recorded response still parses as today's AiCompetitionPlanResponse", () => {
    expect(() => AiCompetitionPlanResponse.parse(fixture.response)).not.toThrow();
  });

  it("(b) the plan projection still passes today's joint structural gate", () => {
    const plan = planFrom(AiCompetitionPlanResponse.parse(fixture.response));
    // The joint gate is not the single-division one: a court must be in the
    // fixture's OWN division's `settings.courts`, never merely in the pack-wide
    // union. This board has three divisions with three different court sets, so
    // that difference is live here.
    expect(jointStructuralCheck(plan, new Set(fixture.movableIds), pack)).toBe(null);
  });

  it("(c) verifies with zero blocking conflicts, in every division", () => {
    const plan = planFrom(AiCompetitionPlanResponse.parse(fixture.response));
    // `verifyJoint` IS the per-division verify: one `validateAssignments` pass
    // per division, each with that division's own `verifyConfigFor` config and
    // each over the whole board, deduped. Calling it rather than re-assembling
    // the per-division passes here is deliberate — a second assembly is how a
    // guard's verdict and the product's verdict drift apart.
    const { blocking } = partitionConflicts(verifyJoint(plan, pack));
    expect(blocking).toEqual([]);

    // …and the per-division statement, read off that ONE referee's output rather
    // than a second run of it: nothing blocking is attributed to any division.
    const divisionOf = new Map(pack.fixtures.movable.map((f) => [f.id, f.division_id]));
    for (const d of pack.divisions) {
      expect(blocking.filter((c) => divisionOf.get(c.fixtureId) === d.id)).toEqual([]);
    }
  });

  it("(f) still reports the divergent courts the joint board exists to show", () => {
    const parsed = AiCompetitionPlanResponse.parse(fixture.response);
    expect(parsed.divergent_courts.length).toBeGreaterThan(0);
    // The pack and the response must agree on which they are — the board's court
    // warning is rendered from the response, the truth lives on the pack.
    expect([...parsed.divergent_courts].sort()).toEqual([...pack.divergentCourts].sort());
  });

  it("(f) carries one pricing quote row per division", () => {
    const parsed = AiCompetitionPlanResponse.parse(fixture.response);
    // `divisions` is the meter stamp's per-division PRICE rows merged with the
    // board's picker data (schemas.ts:2369 — the key is declared twice and the
    // ORDER of the two declarations decides which survives). A joint run serves
    // ONE model, so differing `rung` values across these rows are per-division
    // QUOTES, not per-division escalation — nothing here may assert otherwise.
    expect(parsed.divisions).toHaveLength(pack.divisions.length);
    expect(parsed.divisions.map((d) => d.id).sort()).toEqual(
      pack.divisions.map((d) => d.id).sort(),
    );
    for (const row of parsed.divisions) {
      expect(row.movable).toBeGreaterThan(0);
      expect(typeof row.name).toBe("string");
    }
    // One served model, one recorded model.
    expect(fixture.meta.model.length).toBeGreaterThan(0);
  });

  it("(d/g/h) board, courts, instruction and proposal ids agree", () => {
    const plan = planFrom(AiCompetitionPlanResponse.parse(fixture.response));
    // `board.courts` is the five-court UNION here, which is the right lane set:
    // the demo renders one flat competition board, not three division grids.
    expectCommonInvariants(fixture, plan);
  });
});
