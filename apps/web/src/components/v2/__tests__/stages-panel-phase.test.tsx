import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps } from "react";
import { TIPS } from "@/config/tips";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string }> = {}) => ({
  id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active", ...o,
});
const fixture = (stageId: string, o: Partial<{ id: string; status: string; fixture_no: number; scheduled_at: string | null }> = {}) => ({
  id: `f-${stageId}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null, ...o,
});
const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage()], fixtures: [fixture("s1")], entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
  viewerPlan: "community" as const,
};

// UI5 item 1 (owner, 2026-11-03): the "Starting locks the setup" banner is gone. The same message already lives in
// the Start confirm dialog, the Entrants tab's locked note, Settings > Format's locked note and each stage's lock line,
// so the banner only repeated them. Gone means: no tip in the registry, no copy in any locale, and the panel draws
// no tip at all in the state that used to show it (an organiser, setting up, stages built, nothing played).
const TIP_ID = "division.start-locks";
const LOCALES = ["en", "es", "fr", "nl"] as const;

describe("the start-locks banner is gone (UI5 item 1)", () => {
  it("no tip in the registry and no copy in any of the four dictionaries", () => {
    expect(Object.keys(TIPS), "the registry has tips (premise)").not.toHaveLength(0);
    expect(Object.keys(TIPS)).not.toContain(TIP_ID);
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
      expect(Object.keys(dict).length, `${locale}: the dictionary loaded (premise)`).toBeGreaterThan(100);
      expect(Object.keys(dict).filter((k) => k.startsWith(`tips.${TIP_ID}.`)), locale).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every locale was read").toBe(LOCALES.length);
  });

  it("the panel draws no tip where the banner used to show: an organiser, setting up, stages built, nothing played", () => {
    // The old gate was `canEdit && phase === "setting_up" && !hasPlayedFixture(fixtures)`. The props below meet it, with
    // the old `phase` prop still sent (a caller that never learned it went away), so a banner left behind would draw here.
    const props = { ...baseProps, phase: "setting_up" } as unknown as ComponentProps<typeof StagesPanel>;
    const html = renderToStaticMarkup(<StagesPanel {...props} />);
    expect(html, "the panel rendered its stage (premise)").toContain("League");
    expect(html).not.toContain("data-tip=");
  });
});

describe("StagesPanel run sheet mounting and stage order", () => {
  /**
   * The run sheet's MOUNTING filter, which nothing pinned until an e2e went
   * red on 2026-09-20. (Match Day PB1, owner 2026-11-02: it is now "all" on a
   * match day too - "today" is a chip the organiser chooses.)
   * `run-sheet-dates-and-court.spec.ts` seeded a knockout's semis on a pinned
   * `2026-09-20`; when that date arrived the tab mounted on "today" instead of
   * "all", and the "today" predicate — timed AND dated today — dropped the
   * UNTIMED final, so the bracket rendered one round section where the test
   * expected two. UI5 item 1 took the division phase off the panel (it only
   * ever gated the start-locks banner), so the sheet's default can no longer
   * depend on it: a fixture dated today and one dated another day both mount
   * on "all".
   */
  const pressedFilter = (html: string): string | null =>
    /<button[^>]*data-filter="([a-z_]+)"[^>]*aria-pressed="true"/.exec(html)?.[1] ?? null;

  it("mounts the run sheet on 'all' whether or not a fixture is dated today, with Today offered un-pressed", () => {
    const today = new Date();
    today.setUTCHours(15, 0, 0, 0);
    const dated = (iso: string) => renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={[fixture("s1", { scheduled_at: iso })]} />);
    const onTheDay = dated(today.toISOString());
    const anotherDay = dated(new Date(today.getTime() - 3 * 86_400_000).toISOString());
    expect(pressedFilter(onTheDay)).toBe("all");
    expect(pressedFilter(anotherDay)).toBe("all");
    // The sheet that mounted on All is not a sheet with no Today chip: the chip is there to choose, un-pressed.
    expect(onTheDay).toMatch(/<button[^>]*data-filter="today"[^>]*aria-pressed="false"/);
  });

  it("renders stages by seq: a complete stage 1 stays above a pending stage 2", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps}
        stages={[stage({ id: "s2", seq: 2, status: "pending", name: "Finals" }), stage({ id: "s1", seq: 1, status: "complete", name: "League" })]}
        fixtures={[fixture("s1")]} />,
    );
    expect(html.indexOf("League")).toBeGreaterThan(-1);
    expect(html.indexOf("League")).toBeLessThan(html.indexOf("Finals"));
  });
});

// W2a fix round 1 (M10): a recorded abandon that decided nobody is stored `abandoned` — the status alone reads it as a
// result — so the division page hands its `listFixturesAwaitingSettle` ids down, and the run sheet's row for it is held
// (chip + Settle). This is the panel → sheet → row half of that seam; the page half is e2e (bracket-finish addendum 9).
describe("StagesPanel threads the recorded abandons awaiting their settle to the run sheet (M10)", () => {
  const ko = stage({ id: "ko", kind: "knockout", name: "Final" });
  const abandoned = fixture("ko", { id: "final", status: "abandoned", scheduled_at: "2026-03-01T10:00:00Z" });
  const props = { ...baseProps, stages: [ko], fixtures: [abandoned] };
  const CHIP = 'data-testid="run-sheet-held-chip"';

  it("the row is held when the page names it, and a plain abandon (the generator's void) is not", () => {
    const held = renderToStaticMarkup(<StagesPanel {...props} awaitingSettle={["final"]} />);
    expect(held).toContain('data-fixture-no="1"');
    expect(held).toContain(CHIP);
    expect(held).toContain('data-row-action="decide"');
    const voided = renderToStaticMarkup(<StagesPanel {...props} awaitingSettle={[]} />);
    expect(voided, "the positive pair: the same row renders").toContain('data-fixture-no="1"');
    expect(voided).not.toContain(CHIP);
    expect(voided).not.toContain('data-row-action="decide"');
  });
});
