import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { isUnscheduledFixture } from "@/lib/division-phase";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

// Competition Desk W2, max-effort review finding 11 — "two competing
// 'unscheduled' headings on one tab, over three disagreeing counts of one fact".
//
// The duplication itself is time-boxed: `stages-panel.tsx`'s pinned per-stage
// section keeps the auto-schedule CTA until Task 5 moves it to the rail, while
// `run-sheet.tsx` owns the ROWS. Both halves are on this one screen until then,
// so the two things that have to hold in the interim are pinned here, and both
// are measured from ONE render of the real panel — which mounts the real run
// sheet inside it, so the numbers under test are the ones an organiser sees
// side by side rather than two separately-constructed fixtures.
//
//  1. The two headings must not read as the same sentence. "Not scheduled yet"
//     against "Not yet scheduled" was a word-for-word TRANSPOSITION, which is
//     why plain string inequality is not the assertion — it passes on exactly
//     the defect. The word MULTISET is, in all four locales.
//  2. The per-stage counts and the division-wide chip must be the same fact
//     counted twice, never two predicates. `isUnscheduledFixture` is the one
//     authority (`division-phase.ts`, W1's ledger).

const DICTS = { en: enUi, fr: frUi, es: esUi, nl: nlUi } as Record<string, Record<string, string>>;

function words(s: string): string[] {
  return s
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort();
}

describe("the two unscheduled headings do not read as the same sentence", () => {
  it.each(Object.keys(DICTS))("%s: the stage heading is not a transposition of the sheet heading", (locale) => {
    const dict = DICTS[locale]!;
    const stageHeading = dict["schedule.unscheduled.title"]!;
    const sheetHeading = dict["runsheet.unscheduled.title"]!;
    // Positive pair: both strings actually exist in this locale, so the
    // comparison below is between two real headings and not two undefineds.
    expect(stageHeading, `schedule.unscheduled.title missing in ${locale}`).toBeTruthy();
    expect(sheetHeading, `runsheet.unscheduled.title missing in ${locale}`).toBeTruthy();
    expect(words(stageHeading)).not.toEqual(words(sheetHeading));
  });
});

// --- the counts -------------------------------------------------------------

const stage = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string }> = {}) => ({
  id: "s1",
  seq: 1,
  kind: "league",
  name: "League",
  config: {},
  progression: null,
  status: "active",
  ...o,
});

const fixture = (
  stageId: string,
  no: number,
  o: Partial<{ status: string; scheduled_at: string | null; outcome: unknown; away_entrant_id: string | null }> = {},
) => ({
  id: `f${no}`,
  stage_id: stageId,
  pool_id: null,
  round_no: 1,
  seq_in_round: no,
  fixture_no: no,
  home_entrant_id: "e1",
  away_entrant_id: "e2" as string | null,
  scheduled_at: null as string | null,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status: "scheduled",
  outcome: null as unknown,
  ...o,
});

// Two stages, deliberately unequal, so a per-stage number can never be
// confused with the division-wide one; plus rows that are NOT unscheduled work
// (a timed fixture, a settled untimed one, and a bye) so a count that skipped
// the predicate entirely would be wrong rather than accidentally right.
const FIXTURES = [
  fixture("s1", 1),
  fixture("s1", 2),
  fixture("s1", 3),
  fixture("s1", 4, { scheduled_at: "2026-09-05T10:00:00.000Z" }),
  fixture("s2", 5),
  fixture("s2", 6, { status: "decided", outcome: { kind: "win", winner: "e1" } }),
  // R7(a): a bye is never scheduling work, on either surface.
  fixture("s2", 7, { status: "decided", away_entrant_id: null, outcome: { kind: "award", winner: "e1" } }),
];

const PROPS = {
  divisionId: "d1",
  divisionSeq: 5,
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  stages: [stage(), stage({ id: "s2", seq: 2, name: "Finals" })],
  fixtures: FIXTURES,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};

/** Every per-stage "to schedule" badge, in stage order. */
function stageCounts(html: string): number[] {
  return [...html.matchAll(/data-testid="stage-unscheduled-count"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
}

/** The division-wide chip's number, as rendered by the run sheet the panel
 *  mounts — the same figure the organiser reads a few centimetres away. */
function chipCount(html: string): number | null {
  const chip = /<button[^>]*data-filter="unscheduled"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  expect(chip, "no Unscheduled chip in the rendered panel").not.toBeNull();
  const n = /<span[^>]*>(\d+)<\/span>\s*$/.exec(chip![1]!);
  return n ? Number(n[1]) : null;
}

describe("one fact, counted once — the stage badges and the sheet's chip agree", () => {
  const html = renderToStaticMarkup(<StagesPanel {...PROPS} />);

  // The authority's own answer for the same rows. Derived, never typed in.
  const expected = FIXTURES.filter((f) => isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at }));

  it("the fixture set really does make the numbers distinguishable", () => {
    // Guards the guard: with equal stages, or with no non-work rows, a wrong
    // predicate could still produce the right totals by luck.
    expect(expected.map((f) => f.fixture_no)).toEqual([1, 2, 3, 5]);
    expect(stageCounts(html)).toEqual([3, 1]);
  });

  it("the per-stage badges sum to the division-wide chip", () => {
    const badges = stageCounts(html);
    expect(badges.length, "no per-stage unscheduled badge rendered").toBeGreaterThan(0);
    expect(badges.reduce((a, b) => a + b, 0)).toBe(chipCount(html));
  });

  it("and that total is the authority's, not a second predicate's", () => {
    expect(chipCount(html)).toBe(expected.length);
  });
});
