// Owner ruling 2026-11-26: only a started match owes a result, measured from its ACTUAL start. The division page reads the
// starts (`listFixtureKickoffs`) and hands them to StagesPanel; this pins the panel's half of that seam: the "Needs result"
// chip counts from them, and the stage cards' run sheet is handed the same map (its filter is client state, so the sheet's
// own keeping is pinned in desk/__tests__/run-sheet-filters.test.tsx).
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
const sheetCalls = vi.hoisted(() => [] as { kickoffs?: Record<string, string> }[]);
vi.mock("@/components/v2/desk/run-sheet", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/v2/desk/run-sheet")>();
  return {
    ...real,
    RunSheet: (p: Parameters<typeof real.RunSheet>[0]) => {
      sheetCalls.push(p);
      return real.RunSheet(p);
    },
  };
});

const NOW = Date.now();
const MIN = 60_000;
const iso = (offsetMin: number) => new Date(NOW + offsetMin * MIN).toISOString();
const row = (id: string, status: string, scheduledOffsetMin: number) => ({
  id, division_id: "d1", stage_id: "s1", pool_id: null, fixture_no: 1, round_no: 1, seq_in_round: 1, status,
  scheduled_at: iso(scheduledOffsetMin), home_entrant_id: "e1", away_entrant_id: "e2", outcome: null, home_slot_label: null,
  away_slot_label: null, court_id: null, court_name: null, venue_name: null, officials: [], lane: null, is_final: false,
  third_place: false, conditional: false, ext_key: null,
});
const Panel = StagesPanel as unknown as (p: Record<string, unknown>) => ReactElement;
const render = (p: Record<string, unknown>) =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Record<string, string>} locale="en">
      <Panel
        divisionId="d1" competitionId="c1" orgSlug="org" compSlug="comp" divSlug="div"
        stages={[{ id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" }]}
        entrantNames={{ e1: "Player 1", e2: "Player 2" }} tz="UTC" orgTz="UTC" canExport={false} viewerPlan="community" canEdit
        matchMinutes={60} {...p}
      />
    </DictProvider>,
  );
/** The "Needs result" chip's count, as read. */
const needsResultCount = (html: string): number => {
  const at = html.indexOf('data-filter="needs_result"');
  expect(at, "the chip is rendered").toBeGreaterThan(-1);
  const words = html.slice(at, html.indexOf("</button>", at)).replace(/<[^>]+>/g, " ");
  const m = words.match(/(\d+)\s*$/);
  expect(m, `the chip carries a count: ${words}`).not.toBeNull();
  return Number(m![1]);
};

describe("StagesPanel measures 'Needs result' from the match's actual start", () => {
  beforeEach(() => {
    sheetCalls.length = 0;
  });

  it("a late slot with a start five minutes ago owes nothing; without the start the slot is all there is", () => {
    const fixtures = [row("f1", "in_play", -180)];
    expect(needsResultCount(render({ fixtures })), "premise: the slot alone reads as overdue").toBe(1);
    expect(needsResultCount(render({ fixtures, kickoffs: { f1: iso(-5) } }))).toBe(0);
  });

  it("the other direction: a slot still ahead with a start three hours ago is owed", () => {
    const fixtures = [row("f1", "in_play", 120)];
    expect(needsResultCount(render({ fixtures }))).toBe(0);
    expect(needsResultCount(render({ fixtures, kickoffs: { f1: iso(-180) } }))).toBe(1);
  });

  it("a match that never started owes nothing however late its slot is", () => {
    expect(needsResultCount(render({ fixtures: [row("f1", "scheduled", -3 * 24 * 60)] }))).toBe(0);
  });

  it("hands the same starts to every stage card's run sheet", () => {
    const kickoffs = { f1: iso(-5) };
    render({ fixtures: [row("f1", "in_play", -180)], kickoffs });
    expect(sheetCalls.length, "anti-vacuity: a sheet was rendered").toBeGreaterThan(0);
    for (const call of sheetCalls) expect(call.kickoffs).toBe(kickoffs);
  });
});
