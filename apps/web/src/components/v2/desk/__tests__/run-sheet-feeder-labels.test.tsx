import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { StagesPanel } from "@/components/v2/stages-panel";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { matchRef, resolveSlotLabel } from "@/lib/slot-label";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import { messages } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

/**
 * The draw list names an unfilled knockout seat by its FEEDER.
 *
 * The defect (owner, 2026-09-21, on the live product): a division page's
 * `?tab=fixtures` draw list showed a knockout whose quarter-finals read
 * "Rank 1 vs Rank 8" but whose four semi-final and final rows all read
 * "TBD vs TBD". The SAME fixtures on the schedule board read "Winner of
 * R1·1 vs Winner of R1·2". Two organiser surfaces, one set of rows, and
 * only one of them knew the label — a defect in the gap between two
 * individually-correct screens.
 *
 * WHY the rows differ, verified against the generators rather than assumed:
 * `generateStageFixtures` (the PLAIN bracket path, usecases/stages.ts ~1937)
 * stamps `matchSlotLabel(g.homeFrom)` into `home_slot_label`, so a plain
 * knockout already renders "Winner of R1·1" everywhere. The SETUP path
 * (`generateProgressionSetupFixtures`, ~2670) stamps a label ONLY for a
 * synthetic seed ref and for `bracket.slot.bye` — a sibling-fed seat is left
 * NULL on purpose, because `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒
 * sibling-fed" for `timing: "setup"` stages. So the stored label cannot be
 * the fix; the feed EDGES (`winner_to_fixture`/`winner_to_slot`) are, and
 * `feedLabels()` (lib/schedule-board.ts) is the builder that already turns
 * them into the same `{key, params}` vocabulary.
 *
 * VOCABULARY: this is an ORGANISER surface, so `slot.winner_match`
 * ("Winner of R1·2"), never the public `knockout.feederWinner` form
 * ("Winner of Semi-finals, match 1"). The split is deliberate.
 *
 * Every expected string below is DERIVED through `resolveSlotLabel` /
 * `matchRef` — the same composition point the component uses — so a
 * dictionary change moves this test with it instead of leaving it asserting
 * yesterday's copy. The `sanity` guards under each derivation stop a
 * derivation that silently collapsed to "TBD" from passing vacuously.
 */

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const ENTRANTS = { e1: "Alpha", e2: "Bravo", e3: "Charlie", e4: "Delta" };

const msg = ((key: string, vars?: Record<string, string | number>) => {
  const raw = (messages as Record<string, string>)[key];
  if (raw === undefined) return key;
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? `{${k}}`));
}) as (key: MessageKey, vars?: Record<string, string | number>) => string;

const TBD = resolveSlotLabel(null, msg, "schedule.tbd");
const WINNER_R1_1 = resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 1 } }, msg, "schedule.tbd");
const WINNER_R1_3 = resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 3 } }, msg, "schedule.tbd");
const LOSER_R1_2 = resolveSlotLabel({ key: "slot.loser_match", params: { round: 1, seq: 2 } }, msg, "schedule.tbd");
const WINNER_R1_2 = resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 2 } }, msg, "schedule.tbd");
const BYE = resolveSlotLabel({ key: "bracket.slot.bye", params: {} }, msg, "schedule.tbd");
/** The seed descriptor `generateProgressionSetupFixtures` stores for a
 *  rankRange take — and the label its third pass stamps onto a bye's
 *  winner-feed target. */
const RANK_1 = resolveSlotLabel({ key: "slot.rank_range", params: { rank: 1 } }, msg, "schedule.tbd");

// The derivations are only worth asserting against if they are DISTINCT and
// none of them collapsed to the fallback — otherwise every expectation below
// would pass on a component that still renders "TBD".
it("sanity: the derived labels are distinct, and none is the TBD fallback", () => {
  const derived = { WINNER_R1_1, WINNER_R1_2, WINNER_R1_3, LOSER_R1_2, BYE, RANK_1 };
  for (const [name, value] of Object.entries(derived)) {
    expect(value, `${name} collapsed to the TBD fallback`).not.toBe(TBD);
    expect(value, `${name} is empty`).not.toBe("");
  }
  expect(new Set(Object.values(derived)).size).toBe(6);
  expect(WINNER_R1_3).toContain(matchRef(1, 3, msg));
});

function fx(o: Partial<RunSheetFixture> & { id: string }): RunSheetFixture {
  return {
    stage_id: "s1",
    fixture_no: 1,
    round_no: 2,
    seq_in_round: 1,
    scheduled_at: null,
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: null,
    away_entrant_id: null,
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

/** The feed map the real builder produces for a 4-entrant single-elim: R1·1
 *  and R1·2 feed the final's home and away seats. Built by `feedLabels()`,
 *  never hand-written — a fixture on both ends would prove the fixture. */
function feedMapFor(rows: FeedRow[]) {
  return feedLabels(rows);
}

function rowHtml(fixture: RunSheetFixture, feed?: ReturnType<typeof feedLabels>): string {
  return renderToStaticMarkup(
    <RunSheetRow
      fixture={fixture}
      href="/f/1"
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      canEdit
      entrantNames={ENTRANTS}
      feedLabels={feed}
    />,
  );
}

// ---------------------------------------------------------------------------
// THE ROW — the five cases the owner named, each against the row's own markup
// (apps/web vitest is `environment: "node"`: no DOM, so this asserts what the
// component actually RETURNS, not a class scan).
// ---------------------------------------------------------------------------
describe("RunSheetRow — an unfilled seat is named by its feeder", () => {
  const FEED: FeedRow[] = [
    { id: "r1s1", round_no: 1, seq_in_round: 1, winner_to_fixture: "final", winner_to_slot: 1, loser_to_fixture: null, loser_to_slot: null },
    { id: "r1s2", round_no: 1, seq_in_round: 2, winner_to_fixture: "final", winner_to_slot: 2, loser_to_fixture: null, loser_to_slot: null },
    { id: "final", round_no: 2, seq_in_round: 1, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null },
  ];

  it("renders the winner-feeder label on BOTH seats instead of TBD", () => {
    const html = rowHtml(fx({ id: "final" }), feedMapFor(FEED));
    expect(html).toContain(WINNER_R1_1);
    expect(html).toContain(resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 2 } }, msg, "schedule.tbd"));
    expect(html).not.toContain(`>${TBD}<`);
  });

  it("without the feed map the row still reads TBD — the map is what changes it", () => {
    const html = rowHtml(fx({ id: "final" }));
    expect(html).toContain(TBD);
    expect(html).not.toContain(WINNER_R1_1);
  });

  it("a seat with NO feeder at all keeps the TBD fallback", () => {
    // `orphan` is in nobody's feed map, so its seats resolve to nothing.
    const html = rowHtml(fx({ id: "orphan" }), feedMapFor(FEED));
    expect(html).toContain(TBD);
    expect(html).not.toContain("Winner of");
  });

  it("a LOSER-bracket edge takes the loser form, never the winner form", () => {
    const rows: FeedRow[] = [
      { id: "r1s2", round_no: 1, seq_in_round: 2, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: "lb1", loser_to_slot: 1 },
      { id: "lb1", round_no: 2, seq_in_round: 1, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null },
    ];
    const html = rowHtml(fx({ id: "lb1" }), feedMapFor(rows));
    expect(html).toContain(LOSER_R1_2);
    expect(html).not.toContain(resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 2 } }, msg, "schedule.tbd"));
  });

  it("a seat fed by a BYE still reads as a bye — the stored label outranks the feed", () => {
    // `awardSeededByes` keys off the stored `bracket.slot.bye` marker; a feed
    // edge pointing at the same seat must not overwrite it, or a phantom seat
    // starts telling the organiser to wait for an opponent who is not coming.
    const rows: FeedRow[] = [
      { id: "r1s1", round_no: 1, seq_in_round: 1, winner_to_fixture: "bye-line", winner_to_slot: 2, loser_to_fixture: null, loser_to_slot: null },
      { id: "bye-line", round_no: 2, seq_in_round: 1, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null },
    ];
    const html = rowHtml(
      fx({ id: "bye-line", home_entrant_id: "e1", away_slot_label: { key: "bracket.slot.bye", params: {} } }),
      feedMapFor(rows),
    );
    expect(html).toContain(BYE);
    expect(html).not.toContain(WINNER_R1_1);
  });

  it("the HOME seat's stored label outranks its feed too — the live bye-award shape", () => {
    // The mirror of the case above, and NOT a symmetry exercise: this is the
    // shape `generateProgressionSetupFixtures`' third pass (usecases/stages.ts
    // ~2812) actually writes. When a bye line's `winner_to_slot` is 1 it
    // stamps the bye's award label onto the TARGET's HOME seat, so that seat
    // carries a stored "Rank 1" AND an inbound feed edge at the same time.
    // Stored must win: the bye means seed 1 is already through, and "Winner of
    // R1·1" would tell the organiser to wait on a match whose result changes
    // nothing.
    //
    // Until this test existed, inverting the precedence on the HOME line
    // survived the whole gate while the identical inversion on the AWAY line
    // died — the two seats spelled the rule out twice and only one copy was
    // covered. Both now share `seatLabel()`, and this pins the home side.
    const rows: FeedRow[] = [
      { id: "bye-r1", round_no: 1, seq_in_round: 1, winner_to_fixture: "sf1", winner_to_slot: 1, loser_to_fixture: null, loser_to_slot: null },
      { id: "sf1", round_no: 2, seq_in_round: 1, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null },
    ];
    const html = rowHtml(
      fx({ id: "sf1", home_slot_label: { key: "slot.rank_range", params: { rank: 1 } } }),
      feedMapFor(rows),
    );
    expect(html).toContain(RANK_1);
    expect(html).not.toContain(WINNER_R1_1);
    // The POSITIVE pair: the AWAY seat of that same fixture has no stored
    // label, so it still takes its feed label where one exists — this is
    // precedence, not a blanket opt-out of the feed on this row.
    const bothFed: FeedRow[] = [
      ...rows,
      { id: "bye-r1b", round_no: 1, seq_in_round: 2, winner_to_fixture: "sf1", winner_to_slot: 2, loser_to_fixture: null, loser_to_slot: null },
    ];
    const html2 = rowHtml(
      fx({ id: "sf1", home_slot_label: { key: "slot.rank_range", params: { rank: 1 } } }),
      feedMapFor(bothFed),
    );
    expect(html2).toContain(RANK_1);
    expect(html2).toContain(WINNER_R1_2);
  });

  it("a FILLED seat renders the entrant's name, unchanged", () => {
    const html = rowHtml(fx({ id: "final", home_entrant_id: "e1", away_entrant_id: "e2" }), feedMapFor(FEED));
    expect(html).toContain("Alpha");
    expect(html).toContain("Bravo");
    expect(html).not.toContain("Winner of");
  });

  it("a seat whose feeder is a settled WALKOVER is named like any other", () => {
    // Both rows are rendered here, because the claim is about the RELATIONSHIP
    // between them: the feeder really is settled by forfeit, and the fed seat
    // is still empty (nothing has called `fillSlot` yet). `feedLabels` reads
    // the EDGE and never the status, so the label must be identical to the
    // ordinary case — but a test that renders only the target and asserts the
    // ordinary label is just the first test in this block wearing a different
    // name, which is what this one used to be.
    const feederHtml = rowHtml(
      fx({
        id: "r1s1",
        status: "forfeited",
        home_entrant_id: "e1",
        away_entrant_id: "e2",
        outcome: { kind: "award", winner: "e1" },
      }),
      feedMapFor(FEED),
    );
    // The feeder is genuinely settled-by-forfeit, not merely scheduled: this
    // is the positive half without which "named like any other" is vacuous.
    const wonWo = msg("schedule.outcome.wonWo", { name: "Alpha" });
    // Asserted as a distinct string rather than `not.toContain(won)`: the
    // plain "won" copy is a SUBSTRING of the walkover copy in English, so the
    // negative form would be unsound.
    expect(wonWo, "the w/o copy is indistinguishable from a plain win").not.toBe(
      msg("schedule.outcome.won", { name: "Alpha" }),
    );
    expect(feederHtml).toContain(wonWo);

    const fedHtml = rowHtml(fx({ id: "final" }), feedMapFor(FEED));
    expect(fedHtml).toContain(WINNER_R1_1);
    expect(fedHtml).toContain(WINNER_R1_2);
    expect(fedHtml).not.toContain(`>${TBD}<`);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING — the same claim driven through the REAL producer (the division
// page's panel, fed rows shaped like `listDivisionFixtures` returns) and the
// REAL consumer (the run sheet). A row-level test alone cannot see whether
// anything in production ever BUILDS this map: the inert-seam class.
// ---------------------------------------------------------------------------
describe("StagesPanel — the draw list builds the feed map from the fixture rows", () => {
  const STAGE = {
    id: "s1", seq: 0, kind: "knockout", name: "Cup",
    config: {}, progression: null, status: "active",
  };
  const baseProps = {
    divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
    stages: [STAGE],
    entrantNames: ENTRANTS,
    canEdit: true,
    tz: "UTC",
    orgTz: "UTC",
    canExport: false,
    viewerPlan: "community" as const,
  };

  /** The panel's own `fixtures` prop row, spelled out so the no-edge variant
   *  below is the SAME type rather than a second inferred one (TypeScript
   *  otherwise narrows `winner_to_fixture` to the literal `"f3"` and then
   *  refuses the `null` the variant needs). */
  type PanelFixture = {
    id: string; stage_id: string; pool_id: string | null;
    round_no: number; seq_in_round: number; fixture_no: number;
    home_entrant_id: string | null; away_entrant_id: string | null;
    home_slot_label: null; away_slot_label: null;
    scheduled_at: string | null; venue: string | null; court_label: string | null;
    court_id: string | null; court_name: string | null;
    status: string; outcome: unknown;
    winner_to_fixture: string | null; winner_to_slot: number | null;
    loser_to_fixture: string | null; loser_to_slot: number | null;
  };

  /** Two semis with real entrants feeding a final whose seats are EMPTY and
   *  whose stored slot labels are NULL — exactly what
   *  `generateProgressionSetupFixtures` writes for a sibling-fed seat. */
  const fixtures: PanelFixture[] = [
    {
      id: "f1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
      home_entrant_id: "e1", away_entrant_id: "e2", home_slot_label: null, away_slot_label: null,
      scheduled_at: null, venue: null, court_label: null, court_id: null, court_name: null,
      status: "scheduled", outcome: null,
      winner_to_fixture: "f3", winner_to_slot: 1, loser_to_fixture: null, loser_to_slot: null,
    },
    {
      id: "f2", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 2, fixture_no: 2,
      home_entrant_id: "e3", away_entrant_id: "e4", home_slot_label: null, away_slot_label: null,
      scheduled_at: null, venue: null, court_label: null, court_id: null, court_name: null,
      status: "scheduled", outcome: null,
      winner_to_fixture: "f3", winner_to_slot: 2, loser_to_fixture: null, loser_to_slot: null,
    },
    {
      id: "f3", stage_id: "s1", pool_id: null, round_no: 2, seq_in_round: 1, fixture_no: 3,
      home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
      scheduled_at: null, venue: null, court_label: null, court_id: null, court_name: null,
      status: "scheduled", outcome: null,
      winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null,
    },
  ];

  /** Only the run sheet's own markup — so a label rendered by some OTHER
   *  panel on the page cannot answer for this one. */
  function runSheetHtml(rows: PanelFixture[]): string {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={rows} />);
    const at = html.indexOf('data-testid="run-sheet"');
    expect(at, "the run sheet did not render at all").toBeGreaterThan(-1);
    return html.slice(at);
  }

  it("names the final's empty seats by their feeders, not TBD", () => {
    const html = runSheetHtml(fixtures);
    // The positive pair: the sheet really did render the rows.
    expect(html).toContain("Alpha");
    expect(html).toContain("Charlie");
    expect(html).toContain(WINNER_R1_1);
    expect(html).toContain(resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 2 } }, msg, "schedule.tbd"));
  });

  it("drops back to TBD when the rows carry no feed edges (a league, a pre-V-column row)", () => {
    const noEdges = fixtures.map((f) => ({
      ...f, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null,
    }));
    const html = runSheetHtml(noEdges);
    expect(html).toContain("Alpha");
    expect(html).toContain(TBD);
    expect(html).not.toContain("Winner of");
  });
});
