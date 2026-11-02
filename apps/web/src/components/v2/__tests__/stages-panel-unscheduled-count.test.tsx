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

// Competition Desk W2, max-effort review finding 11 - "two competing 'unscheduled' headings on one tab, over three disagreeing counts of
// one fact". Match Day E1 item 1 (owner 2026-11-01) removed one of the two competitors: the card's footer row ("To schedule in this
// stage N ->") is gone, for an editor and a viewer alike; the counts line above the rows ("3 to schedule") already says it. What is
// left to hold, measured from ONE render of the real panel (which mounts the real run sheet inside it, so the numbers are the ones an
// organiser sees side by side):
//  1. the footer is gone, in every locale's words - no `stage-unscheduled-count` element, and the retired heading text appears
//     nowhere in the card (its key was deleted with it);
//  2. the per-stage "N to schedule" counts and the division-wide chip are the same fact counted twice, never two predicates.
//     `isUnscheduledFixture` is the one authority (`division-phase.ts`, W1's ledger).

const DICTS = { en: enUi, fr: frUi, es: esUi, nl: nlUi } as Record<string, Record<string, string>>;

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

/** Every per-stage "N to schedule" clause of the counts line, in stage order - the words come from the dictionary's own plural
 *  templates, so the number is read by the sentence the organiser reads (a card with nothing to schedule has no clause). */
function stageCounts(html: string): number[] {
  const [pre, post] = (enUi as Record<string, string>)["schedule.progress.toSchedule.other"]!.split("{count}") as [string, string];
  const out: number[] = [];
  for (const m of html.matchAll(/data-testid="stage-progress-counts"[^>]*>(.*?)<\/p>/gs)) {
    for (const clause of m[1]!.replace(/<[^>]*>/g, "").split(" \u00b7 ").map((c) => c.trim())) {
      if (!clause.startsWith(pre) || !clause.endsWith(post)) continue;
      const n = Number(clause.slice(pre.length, clause.length - post.length));
      if (Number.isInteger(n)) out.push(n);
    }
  }
  return out;
}

/** The division-wide chip's number, as rendered by the run sheet the panel
 *  mounts — the same figure the organiser reads a few centimetres away. */
function chipCount(html: string): number | null {
  const chip = /<button[^>]*data-filter="unscheduled"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  expect(chip, "no Unscheduled chip in the rendered panel").not.toBeNull();
  const n = /<span[^>]*>(\d+)<\/span>\s*$/.exec(chip![1]!);
  return n ? Number(n[1]) : null;
}

describe("one fact, counted once - the stage counts and the sheet's chip agree", () => {
  const html = renderToStaticMarkup(<StagesPanel {...PROPS} />);

  // The authority's own answer for the same rows. Derived, never typed in.
  const expected = FIXTURES.filter((f) => isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at }));

  it("the fixture set really does make the numbers distinguishable", () => {
    // Guards the guard: with equal stages, or with no non-work rows, a wrong
    // predicate could still produce the right totals by luck.
    expect(expected.map((f) => f.fixture_no)).toEqual([1, 2, 3, 5]);
    expect(stageCounts(html)).toEqual([3, 1]);
  });

  it("the per-stage counts sum to the division-wide chip", () => {
    const counts = stageCounts(html);
    expect(counts.length, "no per-stage 'to schedule' count rendered").toBeGreaterThan(0);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(chipCount(html));
  });

  it("and that total is the authority's, not a second predicate's", () => {
    expect(chipCount(html)).toBe(expected.length);
  });
});

// E1 item 1: the footer row is gone for BOTH viewers (it used to be the rail's slot for an editor and an inline copy for a viewer), and the
// count it carried is still there - in the card's counts line, which every viewer reads.
describe("E1 item 1 - the 'To schedule in this stage' footer is gone, the count stays", () => {
  it("no footer element and no retired heading text, editor and viewer, in every locale", () => {
    let checked = 0;
    for (const canEdit of [true, false]) {
      const html = renderToStaticMarkup(<StagesPanel {...PROPS} canEdit={canEdit} />);
      expect(stageCounts(html), `canEdit=${canEdit}: positive pair - the count itself is on the card`).toEqual([3, 1]);
      expect(html, `canEdit=${canEdit}`).not.toContain("stage-unscheduled-count");
      expect(html, `canEdit=${canEdit}: the footer's dashed band`).not.toContain("border-dashed");
      for (const [locale, dict] of Object.entries(DICTS)) {
        expect(dict["schedule.unscheduled.title"], `${locale}: the retired key is deleted with its only reader`).toBeUndefined();
        expect(html, `${locale}`).not.toContain("To schedule in this stage");
        checked++;
      }
    }
    expect(checked, "editor and viewer x four locales").toBe(8);
  });
});
