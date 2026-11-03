// Match Day PB3 item 2 (m7 from the PB2 review) - the run sheet's Settle on a billing-FROZEN competition, on EVERY shape of sheet.
//
// `RunSheet` mounts its rows from five different places (a day block, a knockout's round list, the "not yet scheduled" group, the
// "settled" group, and a table stage's round list - flat or under bars). A `canSettle` prop that reaches only some of them would leave
// Settle missing on a frozen competition for the rest, and a row-level test cannot see that. This renders the real `RunSheet` with
// `canEdit` false (the freeze folded in, as the division page hands it) and `canSettle` true, once per mounting site that can hold a
// held row, and counts the Settle actions against the held rows each site was given. The "not yet scheduled" group is the one site that
// cannot: `buildRunSheet` sends only OPEN work (scheduled / in play) there and files a held row in the settled group, so it is not
// threaded - and the last test pins that premise, so the day it changes this reds instead of leaving a frozen row without Settle.
// Anti-vacuity: every site reports that it rendered its own block, and the sweep fails if it checked fewer than the sites it names.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const TIMED = "2026-09-05T14:00:00.000Z";

function fx(no: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: "s1",
    fixture_no: no,
    round_no: 1,
    seq_in_round: no,
    scheduled_at: TIMED,
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
const HELD = { status: "needs_decision", outcome: { kind: "draw" } } as const;

function render(
  stages: { id: string; seq: number; kind: string; name: string }[],
  fixtures: RunSheetFixture[],
  o: { embedded: boolean; canSettle?: boolean; awaitingSettle?: string[] },
): string {
  return renderToStaticMarkup(
    <DictProvider dict={enUi as unknown as Dict} locale="en">
      <RunSheet
        blocks={buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS })}
        stages={stages}
        tz={TZ}
        orgTz={TZ}
        nowMs={NOW_MS}
        matchMinutes={60}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit={false}
        canSettle={o.canSettle}
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter="all"
        onFilter={() => {}}
        stageId={o.embedded ? "s1" : null}
        embedded={o.embedded}
        awaitingSettle={o.awaitingSettle}
      />
    </DictProvider>,
  );
}

const actions = (html: string) => [...html.matchAll(/data-row-action="([a-z_]+)"/g)].map((m) => m[1]!);
const blocks = (html: string) => [...html.matchAll(/data-run-sheet-block="([a-z]+)"/g)].map((m) => m[1]!);

const league = [{ id: "s1", seq: 1, kind: "league", name: "League" }];
const knockout = [{ id: "s1", seq: 1, kind: "knockout", name: "Cup" }];
// A ladder stores each challenge as a round of its own, so its card draws ONE flat list with no bars.
const ladder = [{ id: "s1", seq: 1, kind: "ladder", name: "Ladder" }];

/** One entry per place `RunSheet` mounts a row. `block` is the marker the site draws (the day block draws none). */
const SITES: { site: string; stages: typeof league; fixtures: RunSheetFixture[]; embedded: boolean; block: string | null; awaiting?: string[] }[] = [
  { site: "a day block (division-wide sheet, timed)", stages: league, fixtures: [fx(1, HELD)], embedded: false, block: null },
  { site: "a knockout's round list", stages: knockout, fixtures: [fx(1, HELD)], embedded: false, block: "bracket" },
  {
    site: "the settled group (an untimed abandon still owed its settle)",
    stages: league,
    fixtures: [fx(1, { status: "abandoned", scheduled_at: null })],
    embedded: false,
    block: "settled",
    awaiting: ["f1"],
  },
  { site: "a table stage's round list under bars", stages: league, fixtures: [fx(1, HELD), fx(2, { round_no: 2 })], embedded: true, block: "rounds" },
  { site: "a ladder's flat list", stages: ladder, fixtures: [fx(1, HELD)], embedded: true, block: "flat" },
];

describe("PB3 m7: every mounting site of a run-sheet row offers Settle on a frozen competition", () => {
  it("checked every mounting site that can hold a held row (five cases) - zero checked is a failure", () => {
    const seen = new Set<string>();
    let checked = 0;
    for (const c of SITES) {
      const html = render(c.stages, c.fixtures, { embedded: c.embedded, canSettle: true, awaitingSettle: c.awaiting });
      const drawn = blocks(html);
      if (c.block === null) {
        expect(drawn, `${c.site}: no block marker, so this is the day block`).toEqual([]);
        seen.add("day");
      } else {
        expect(drawn, `${c.site}: the site under test did not render`).toContain(c.block);
        seen.add(c.block);
      }
      expect(actions(html).filter((a) => a === "decide"), c.site).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(SITES.length);
    // day, bracket, settled, and the embedded round list in both of its shapes (bars, or a ladder's flat list): four RunSheet sites, five cases.
    expect([...seen].sort()).toEqual(["bracket", "day", "flat", "rounds", "settled"]);
  });

  it("the same five cases, canSettle FALSE (a viewer, or an organiser without the right): no site offers Settle", () => {
    let checked = 0;
    for (const c of SITES) {
      const html = render(c.stages, c.fixtures, { embedded: c.embedded, canSettle: false, awaitingSettle: c.awaiting });
      expect(actions(html), c.site).not.toContain("decide");
      expect(actions(html).length, `${c.site}: the row rendered (positive pair)`).toBeGreaterThanOrEqual(1);
      checked++;
    }
    expect(checked).toBe(SITES.length);
  });

  it("an absent canSettle follows canEdit (false here): a caller that never heard of the freeze keeps today's behaviour", () => {
    const c = SITES[0]!;
    const html = render(c.stages, c.fixtures, { embedded: c.embedded });
    expect(actions(html)).toEqual(["view"]);
  });
});

describe("the premise behind the one site that is not threaded", () => {
  it("a held row is never filed in the not-yet-scheduled group: untimed, it lands in the settled group", () => {
    // If this ever fails, `buildRunSheet` has started to put held work in "unscheduled", and that site's RunSheetRow needs `canSettle`.
    const untimedHeld = fx(1, { ...HELD, scheduled_at: null });
    const built = buildRunSheet({ fixtures: [untimedHeld, fx(2, { scheduled_at: null })], stages: league, tz: TZ, nowMs: NOW_MS });
    const unscheduled = built.find((b) => b.kind === "unscheduled");
    const settled = built.find((b) => b.kind === "settled");
    expect(unscheduled, "the open untimed row is the unscheduled group's (positive pair)").toBeDefined();
    expect(unscheduled!.kind === "unscheduled" && unscheduled!.fixtures.map((f) => f.id)).toEqual(["f2"]);
    expect(settled!.kind === "settled" && settled!.fixtures.map((f) => f.id)).toEqual(["f1"]);
  });
});
