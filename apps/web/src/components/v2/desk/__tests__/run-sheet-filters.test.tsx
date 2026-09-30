import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet, runSheetKeeps, type RunSheetFilter, type RunSheetKeepContext } from "@/components/v2/desk/run-sheet";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { ACTIVE_STATES, holdStateOf, type HoldState } from "@/server/relay/domain/session";
import { buildRunSheet, isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { resolveAttention, type PhaseInput } from "@/lib/division-phase";
import { messages } from "@/lib/messages";

// `RunSheetRow` reaches for `useRouter` (its inline Set-time editor refreshes
// on save). Nothing here clicks it, but the hook throws outside a router
// context, so the whole tree fails to render without this.
// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
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
    court_id: null,
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

function sheetHtml(
  filter: RunSheetFilter,
  canEdit: boolean,
  fixtures: RunSheetFixture[] = FIXTURES,
  stages: { id: string; seq: number; kind: string; name: string }[] = STAGES,
): string {
  return renderToStaticMarkup(
    <RunSheet
      blocks={buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS })}
      stages={stages}
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      matchMinutes={MATCH_MINUTES}
      entrantNames={{ e1: "Alpha", e2: "Bravo" }}
      canEdit={canEdit}
      hrefFor={(f) => `/f/${f.fixture_no}`}
      filter={filter}
      onFilter={() => {}}
      stageId={null}
      onStageFilter={() => {}}
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

/** Every fixture number the sheet actually rendered a row for.
 *
 *  NOT a total count of rows: `RunSheetRow`'s bye branch returns a bare ghost
 *  `<li>` with no `data-fixture-no` at all, so byes are invisible to this
 *  helper. Reaching for it to prove a bye is absent gives an assertion that
 *  passes in both states — `byeRowCount` below is the one that can see them. */
function renderedRows(html: string): number[] {
  return [...html.matchAll(/data-fixture-no="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** How many bye ghost rows the sheet rendered, counted by the copy the bye
 *  branch actually prints — derived from the catalog, not a typed twin. */
function byeRowCount(html: string): number {
  const phrase = messages["schedule.bye"].replace("{name}", "Alpha");
  return html.split(phrase).length - 1;
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
      awaitsSeedDraw: false,
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

// ---------------------------------------------------------------------------
// FINDING 14 — byes bypassed every filter.
//
// `keep` opened `if (filter === "all" || isBye(f)) return true;`, so the bye
// short-circuit ran BEFORE any filter test and a bye was retained under all of
// them. `buildRunSheet` enforces R7(a) on the GROUPING side; this predicate
// undid it on the RENDERING side. Meanwhile the chip counts already `continue`
// past byes, so selecting "Unscheduled" on a knockout with four round-1 byes
// showed a chip reading 0 above a section of four italic ghost rows.
//
// Ruling R7(a), quoted at run-sheet-groups.ts:11-12 — byes "never enter the
// unscheduled group and never carry an action". The literal reading is taken:
// byes are dropped from EVERY non-`all` filter. Under "All" they stay, because
// a bracket round that shows three fixtures and silently omits the bye
// explaining the missing fourth is worse than showing it.
const KNOCKOUT = [{ id: "k1", seq: 1, kind: "knockout", name: "Cup" }];

/** A round-1 bye: an award outcome with one side unfilled (`isBye`). Untimed
 *  and settled, exactly as the generator leaves them. */
function bye(no: number): RunSheetFixture {
  return fx(no, {
    stage_id: "k1",
    status: "decided",
    scheduled_at: null,
    outcome: { kind: "award", winner: "e1" },
    away_entrant_id: null,
  });
}

const BRACKET_FIXTURES: RunSheetFixture[] = [
  bye(11),
  bye(12),
  // Two real round-1 fixtures: one genuinely unscheduled, one played out.
  fx(13, { stage_id: "k1", scheduled_at: null }),
  fx(14, { stage_id: "k1", scheduled_at: "2026-09-05T08:00:00.000Z" }),
];

describe("byes are structural context, not work (R7a)", () => {
  // Guards the guard: if these rows ever stopped being byes, every assertion
  // below would pass against the unfixed code.
  it("the fixtures under test really are byes, and really do render under All", () => {
    expect(BRACKET_FIXTURES.filter(isBye).map((f) => f.fixture_no)).toEqual([11, 12]);
    const html = sheetHtml("all", true, BRACKET_FIXTURES, KNOCKOUT);
    // The POSITIVE pair for every absence assertion below. Byes carry no
    // `data-fixture-no`, so they are counted by their own copy.
    expect(byeRowCount(html)).toBe(2);
    expect(renderedRows(html)).toEqual([13, 14]);
  });

  it.each<RunSheetFilter>(["unscheduled", "needs_result", "today"])(
    "the %s filter excludes byes",
    (filter) => {
      expect(byeRowCount(sheetHtml(filter, true, BRACKET_FIXTURES, KNOCKOUT))).toBe(0);
    },
  );

  // The indefensible half of the defect: the chip's number and the rows beneath
  // it disagreed. Derived from the chip and the rows actually rendered, so the
  // two cannot drift apart again.
  it("the Unscheduled chip's number equals the rows that filter renders", () => {
    const all = sheetHtml("all", true, BRACKET_FIXTURES, KNOCKOUT);
    const selected = sheetHtml("unscheduled", true, BRACKET_FIXTURES, KNOCKOUT);
    expect(selected).not.toContain('data-testid="run-sheet-empty"');
    expect(renderedRows(selected)).toEqual([13]);
    expect(chipCount(all, "unscheduled")).toBe(renderedRows(selected).length);
  });

  // A bracket round left with ONLY byes under a work filter must render no
  // section at all, not an empty "Round 1" header — `roundsWithRows` drops a
  // round with zero rows, and the sheet then falls to its own empty state.
  it("a round whose only rows are byes disappears from a work filter entirely", () => {
    // Positive pair: the same two rows DO render under "All".
    expect(byeRowCount(sheetHtml("all", true, [bye(21), bye(22)], KNOCKOUT))).toBe(2);
    const html = sheetHtml("unscheduled", true, [bye(21), bye(22)], KNOCKOUT);
    expect(byeRowCount(html)).toBe(0);
    expect(renderedRows(html)).toEqual([]);
    expect(html).toContain('data-testid="run-sheet-empty"');
  });
});

// B3 fix round 1, I-2 (owner decision, option a): on a match day the sheet MOUNTS on "Today", which keeps only a timed
// fixture dated today. The run-sheet chip replaced the frozen page's always-visible probe stack as the division's path
// to Stop, so a fixture with a stream UP must stay on the sheet under "Today" — untimed (a walk-up match) or dated
// another day — or its chip, and Stop, is one hidden filter tap away. Every other row keeps the design's rule.
describe("a stream that is up keeps its row under Today (I-2, owner option a)", () => {
  /** Every hold state a session that is UP can read as — from the domain's declarations, never typed here. */
  const UP: HoldState[] = [...new Set(ACTIVE_STATES.map((s) => holdStateOf(s)).filter((h): h is HoldState => h !== null))];
  const today = dayKeyInTz(NOW_MS, TZ);
  const untimedStreamed = fx(101);
  const untimedPlain = fx(102);
  const otherDayStreamed = fx(103, { scheduled_at: "2026-09-03T10:00:00.000Z" });
  const otherDayPlain = fx(104, { scheduled_at: "2026-09-03T11:00:00.000Z" });
  const timedToday = fx(105, { scheduled_at: "2026-09-05T20:00:00.000Z" });
  const SET = [untimedStreamed, untimedPlain, otherDayStreamed, otherDayPlain, timedToday];
  const ctx = (streamStates: Record<string, HoldState> | undefined): RunSheetKeepContext => ({
    stageId: null, tz: TZ, today, nowMs: NOW_MS, matchMinutes: MATCH_MINUTES, streamStates,
  });
  const html = (filter: RunSheetFilter, streamStates: Record<string, HoldState> | undefined) =>
    renderToStaticMarkup(
      <RunSheet
        blocks={buildRunSheet({ fixtures: SET, stages: STAGES, tz: TZ, nowMs: NOW_MS })}
        stages={STAGES}
        tz={TZ}
        orgTz={TZ}
        nowMs={NOW_MS}
        matchMinutes={MATCH_MINUTES}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit={false}
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter={filter}
        onFilter={() => {}}
        stageId={null}
        onStageFilter={() => {}}
        streamStates={streamStates}
      />,
    );
  const chipsIn = (markup: string): number[] =>
    [...markup.matchAll(/<li data-fixture-no="(\d+)"[\s\S]*?<\/li>/g)]
      .filter((m) => m[0].includes('data-testid="run-sheet-stream-chip"'))
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);

  it("premises: the set really has untimed and other-day rows that Today hides without a stream, and one it keeps", () => {
    expect(UP.length, "anti-vacuity: the domain declares hold states for an up session").toBeGreaterThan(0);
    expect(dayKeyInTz(Date.parse(otherDayStreamed.scheduled_at!), TZ)).not.toBe(today);
    expect(dayKeyInTz(Date.parse(timedToday.scheduled_at!), TZ)).toBe(today);
    expect(renderedRows(html("today", undefined)), "no stream: the design's Today — the timed-today row only").toEqual([105]);
  });

  it("under Today, EVERY up state keeps its untimed and other-day rows, with their chips; the same rows without a stream stay hidden", () => {
    let checked = 0;
    for (const state of UP) {
      const states = { [untimedStreamed.id]: state, [otherDayStreamed.id]: state };
      const markup = html("today", states);
      expect(renderedRows(markup), state).toEqual([101, 103, 105]);
      expect(chipsIn(markup), `${state}: the kept rows carry their chip`).toEqual([101, 103]);
      // The pure row test agrees with the render (the render is its only caller).
      expect(runSheetKeeps(untimedStreamed, "today", ctx(states)), state).toBe(true);
      expect(runSheetKeeps(untimedPlain, "today", ctx(states)), `${state}: the positive pair`).toBe(false);
      expect(runSheetKeeps(otherDayPlain, "today", ctx(states)), `${state}: the positive pair`).toBe(false);
      checked++;
    }
    expect(checked).toBe(UP.length);
  });

  it("the keep is Today's only: the work filters, and a stage filter, still hide a streamed row they do not own", () => {
    const states = { [untimedStreamed.id]: UP[0]!, [otherDayStreamed.id]: UP[0]! };
    // A dated, not-overdue-by-rule row is not "unscheduled"; a streamed row of ANOTHER stage is outside the stage filter.
    expect(runSheetKeeps(otherDayStreamed, "unscheduled", ctx(states))).toBe(false);
    expect(runSheetKeeps(untimedStreamed, "today", { ...ctx(states), stageId: "s-other" })).toBe(false);
    expect(runSheetKeeps(untimedStreamed, "today", { ...ctx(states), stageId: "s1" }), "positive pair: its own stage").toBe(true);
  });
});
