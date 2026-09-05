import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { resolveAttention, type PhaseInput } from "@/lib/division-phase";

// `RunSheetRow` reaches for `useRouter` (its inline Set-time editor refreshes
// on save). Nothing here clicks it, but the hook throws outside a router
// context, so the whole tree fails to render without this.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Competition Desk W2 — the filter chips' two DERIVED counts, which had no
// unit coverage at all (max-effort review §0.4: six of fifteen findings live
// in this component precisely because 6833 passing tests never render it).
//
// Both defects this file exists for are pure-predicate ones, so they are
// provable here, with no DOM:
//
//  - Finding 1: "Unscheduled" was `rowAction(f).kind === "set_time"`, and
//    `fixtureRowAction` returns `set_time` only when `canEdit`. A viewer, or
//    an owner on a frozen competition, read "Unscheduled 0" above a list of
//    unscheduled fixtures.
//  - Finding 2: "Needs result" was `rowAction(f).kind === "open_pad"`, i.e.
//    `status === "in_play"` — DISJOINT from `division-phase.ts`'s
//    `result_missing`, the W1 authority the same organiser is shown on the
//    same desk.
//
// Every expected count below is DERIVED from that authority
// (`resolveAttention` over the same fixtures), never typed in — a change to
// the predicate moves this test with it instead of leaving it asserting
// yesterday's numbers.

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 18, 0, 0); // 2026-09-05T18:00Z
const MATCH_MINUTES = 60;

function fx(no: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: "s1",
    fixture_no: no,
    round_no: 1,
    seq_in_round: no,
    scheduled_at: null,
    status: "scheduled",
    court_name: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

/** One division's worth of rows, chosen so the OLD predicates and the new
 *  ones disagree on both COUNT and MEMBERSHIP — a set where they merely
 *  disagreed on membership would let a count-only assertion pass a mutant. */
const FIXTURES: RunSheetFixture[] = [
  // Two overdue results: `scheduled`, dated, kick-off + matchMinutes in the
  // past. The old `open_pad` predicate counted NEITHER.
  fx(1, { scheduled_at: "2026-09-05T10:00:00.000Z" }),
  fx(2, { scheduled_at: "2026-09-05T08:00:00.000Z" }),
  // Inside the matchMinutes grace (starts 17:30, still running at 18:00) —
  // not yet an owed result. This is the row that pins that `matchMinutes` is
  // actually consulted rather than being a decorative prop.
  fx(3, { scheduled_at: "2026-09-05T17:30:00.000Z" }),
  // Live right now. The OLD predicate counted exactly this row as "needs
  // result"; the authority does not.
  fx(4, { status: "in_play", scheduled_at: "2026-09-05T09:00:00.000Z" }),
  // Two genuinely unscheduled rows.
  fx(5),
  fx(6),
  // A settled row, in neither filter.
  fx(7, { status: "decided", scheduled_at: "2026-09-04T10:00:00.000Z", outcome: { kind: "score" } }),
];

const STAGES = [{ id: "s1", seq: 1, kind: "league", name: "League" }];

function sheetHtml(filter: RunSheetFilter, canEdit: boolean): string {
  return renderToStaticMarkup(
    <RunSheet
      blocks={buildRunSheet({ fixtures: FIXTURES, stages: STAGES, tz: TZ, nowMs: NOW_MS })}
      stages={STAGES}
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      matchMinutes={MATCH_MINUTES}
      entrantNames={{ e1: "Alpha", e2: "Bravo" }}
      canEdit={canEdit}
      hrefFor={(f) => `/f/${f.fixture_no}`}
      filter={filter}
      onFilter={() => {}}
    />,
  );
}

/** The number printed inside a filter chip, or `null` when that chip carries
 *  no count at all. Read out of the rendered markup rather than from the
 *  component's internals — this is the figure the organiser actually sees. */
function chipCount(html: string, filter: RunSheetFilter): number | null {
  const chip = new RegExp(`<button[^>]*data-filter="${filter}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  expect(chip, `no "${filter}" chip in the rendered sheet`).not.toBeNull();
  const count = /<span[^>]*>(\d+)<\/span>\s*$/.exec(chip![1]!);
  return count ? Number(count[1]) : null;
}

/** Every fixture number the sheet actually rendered a row for. */
function renderedRows(html: string): number[] {
  return [...html.matchAll(/data-fixture-no="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** The W1 authority's own answer for the same rows — the source every
 *  expectation below is derived from. */
function authority(): { resultMissing: number[]; unscheduled: number } {
  const input: PhaseInput = {
    divisionStatus: "active",
    stages: [],
    fixtures: FIXTURES.map((f) => ({
      id: f.id,
      status: f.status,
      scheduledAt: f.scheduled_at,
      startedAt: null,
      eventCount: 1,
      matchMinutes: MATCH_MINUTES,
      hasScorer: true,
      stageId: f.stage_id,
      tbd: false,
    })),
    now: new Date(NOW_MS).toISOString(),
    tz: TZ,
    awaitingRegistrations: 0,
  };
  const out = resolveAttention(input);
  const missing = out.find((a) => a.kind === "result_missing");
  const unsched = out.find((a) => a.kind === "unscheduled");
  return {
    resultMissing: (missing?.kind === "result_missing" ? missing.fixtureIds : []).map((id) =>
      Number(id.replace("f", "")),
    ),
    unscheduled: unsched?.kind === "unscheduled" ? unsched.count : 0,
  };
}

describe("run sheet filter chips — counts and membership", () => {
  it("the fixture set itself makes the old and new predicates disagree", () => {
    // Guards the guard: if a later edit to FIXTURES made the two predicates
    // agree, every assertion below would pass against the unfixed code.
    const { resultMissing, unscheduled } = authority();
    expect(resultMissing).toEqual([1, 2]);
    expect(unscheduled).toBe(2);
    const inPlay = FIXTURES.filter((f) => f.status === "in_play").map((f) => f.fixture_no);
    expect(inPlay).toEqual([4]);
    expect(resultMissing).not.toContain(4);
  });

  // FINDING 1 — permission-blind.
  it.each([true, false])("counts Unscheduled from the FACT, not the offered action (canEdit=%s)", (canEdit) => {
    const html = sheetHtml("all", canEdit);
    // Positive pair: the sheet rendered every row before anything is said
    // about a count. Without this, a blank page satisfies the assertion.
    expect(renderedRows(html)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(chipCount(html, "unscheduled")).toBe(authority().unscheduled);
  });

  it("a viewer selecting Unscheduled sees the unscheduled rows, not an empty state", () => {
    const html = sheetHtml("unscheduled", false);
    expect(html).not.toContain('data-testid="run-sheet-empty"');
    expect(renderedRows(html)).toEqual([5, 6]);
  });

  // FINDING 2 — the same authority as the "Needs you" panel.
  it.each([true, false])("counts Needs result from the W1 authority (canEdit=%s)", (canEdit) => {
    const html = sheetHtml("all", canEdit);
    expect(renderedRows(html)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(chipCount(html, "needs_result")).toBe(authority().resultMissing.length);
  });

  it("selecting Needs result renders exactly the fixtures the authority names", () => {
    const html = sheetHtml("needs_result", true);
    expect(html).not.toContain('data-testid="run-sheet-empty"');
    expect(renderedRows(html)).toEqual(authority().resultMissing);
  });

  it("a live fixture is not an owed result", () => {
    const html = sheetHtml("needs_result", true);
    expect(renderedRows(html)).not.toContain(4);
  });

  it("a fixture still inside its matchMinutes does not yet owe a result", () => {
    const html = sheetHtml("needs_result", true);
    expect(renderedRows(html)).not.toContain(3);
  });
});
