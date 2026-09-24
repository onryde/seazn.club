// Competition Desk W3, owner-approved redesign "Option A" (Task 10
// follow-up) — the stage card's BODY used to render nothing beyond its own
// header (measured: 814x234px of "1. Group Stage · Group · Active" and a
// rule). This suite pins the fixtures-progress summary that fills it: a
// suppressible counts line (`stage-progress-counts`, played / in play / to
// schedule).
//
// Owner ruling (this round, "remove the progress bar, keep the counts
// line"): the bar (`stage-progress-bar`) that used to sit above this line
// is GONE — it only earned its place while it could show mixed state, and
// a solid full-width block once every fixture was scheduled said nothing
// the counts text does not say better on a card whose real job is the
// actions below it. The tests that existed solely to probe the bar's own
// segment rendering are deleted deliberately below, with that reasoning
// recorded at the deletion site — everything that tests the COUNTS line
// (which the owner explicitly kept) survives unchanged.
//
// Modelled on `stages-panel-unscheduled-heading.test.tsx`'s own harness —
// `renderToStaticMarkup(<StagesPanel .../>)` with no DOM needed, since this
// is pure derived-count + suppression logic, not layout. Layout (the D2/D3/
// D4 alignment fixes on the rail) is out of this file's reach entirely —
// apps/web vitest is `environment: "node"` — and is verified by Playwright
// instead (run-sheet.spec.ts).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { restByeExtKey } from "@/lib/fixture-bye";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const en = enUi as Record<string, string>;

const DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

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
  o: Partial<{
    status: string;
    scheduled_at: string | null;
    outcome: unknown;
    away_entrant_id: string | null;
    ext_key: string | null;
  }> = {},
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

// A real mix, deliberately: 2 unscheduled (no time), 1 scheduled-with-a-time
// (not played, not in play — a control fixture that must land in NONE of
// the three counted clauses, per the brief's exact three clauses), 1
// in_play, 2 played (one `decided`, one `finalized` — both count, neither is
// the only kind that does).
const MIXED_FIXTURES = [
  fixture("s1", 1),
  fixture("s1", 2),
  fixture("s1", 3, { scheduled_at: "2026-09-05T10:00:00.000Z" }),
  fixture("s1", 4, { status: "in_play", scheduled_at: "2026-09-05T09:00:00.000Z" }),
  fixture("s1", 5, { status: "decided", scheduled_at: "2026-09-04T09:00:00.000Z", outcome: { kind: "win", winner: "e1" } }),
  fixture("s1", 6, { status: "finalized", scheduled_at: "2026-09-03T09:00:00.000Z", outcome: { kind: "win", winner: "e1" } }),
];

const PROPS = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  stages: [stage()],
  fixtures: MIXED_FIXTURES,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};

function progressCounts(html: string): string | null {
  const m = /data-testid="stage-progress-counts"[^>]*>([^<]*)</.exec(html);
  return m ? m[1]! : null;
}

describe("stage card body — fixtures progress (owner-approved 'Option A')", () => {
  it.each(DICTS)("%s: the counts line names played (2), in play (1) and to schedule (2), real translations", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <StagesPanel {...PROPS} />
      </DictProvider>,
    );
    const counts = progressCounts(html);
    expect(counts, `no stage-progress-counts rendered (${locale})`).not.toBeNull();
    expect(counts, `${locale} played clause`).toContain(d["schedule.progress.played.other"]!.replace("{count}", "2"));
    expect(counts, `${locale} in-play clause`).toContain(d["schedule.progress.inPlay.one"]!);
    expect(counts, `${locale} to-schedule clause`).toContain(d["schedule.progress.toSchedule.other"]!.replace("{count}", "2"));
  });

  it("the four locales are not the same English string copied four times", () => {
    const rendered = DICTS.map(([locale, dict]) =>
      progressCounts(
        renderToStaticMarkup(
          <DictProvider dict={dict} locale={locale}>
            <StagesPanel {...PROPS} />
          </DictProvider>,
        ),
      ),
    );
    expect(rendered.every((s) => s !== null)).toBe(true);
    // es/fr/nl must each differ from the English string actually shipped.
    for (const s of rendered.slice(1)) {
      expect(s).not.toBe(rendered[0]);
    }
  });

  // Deleted deliberately (owner ruling, this round, "remove the progress
  // bar, keep the counts line"): this test's whole subject was the bar's
  // own three-segment rendering (`stage-progress-bar`, `barSegmentCount`
  // counting `style="width:` occurrences) — the bar no longer exists on
  // this component at all, so there is nothing left for either the testid
  // lookup or the segment count to assert. `stage-progress-bar` is instead
  // pinned ABSENT below, and the counts line's own suppression math (which
  // this test never touched) is what the tests around it still cover.
  it("stage-progress-bar no longer renders at all — the bar was removed, not merely emptied", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    // Review m5: the positive half. Without it a StagesPanel that rendered
    // NOTHING satisfies the absence below, and this test passes on a panel
    // that has stopped working entirely.
    expect(html, "the panel rendered no progress line at all — nothing was measured").toContain(
      'data-testid="stage-progress-counts"',
    );
    expect(html).not.toContain('data-testid="stage-progress-bar"');
  });

  it("suppresses the 'in play' clause — and only that one — when nobody is in play", () => {
    const noInPlay = MIXED_FIXTURES.filter((f) => f.status !== "in_play");
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={noInPlay} />);
    const counts = progressCounts(html)!;
    expect(counts, "in-play clause leaked in with a zero count").not.toContain(en["schedule.progress.inPlay.one"]!);
    expect(counts, "in-play clause leaked in with a zero count").not.toContain("0 in play");
    // The other two clauses are unaffected — this is a suppression of ONE
    // clause, not the whole line going missing.
    expect(counts).toContain(en["schedule.progress.played.other"]!.replace("{count}", "2"));
    expect(counts).toContain(en["schedule.progress.toSchedule.other"]!.replace("{count}", "2"));
  });

  it("suppresses the whole counts line — never an empty <p> — when all three counts are zero", () => {
    // Every fixture cancelled: not played (no result), not in play, not
    // unscheduled (isUnscheduledFixture requires status === 'scheduled').
    const allVoid = MIXED_FIXTURES.map((f) => ({ ...f, status: "cancelled" }));
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={allVoid} />);
    expect(html, "an empty counts <p> rendered — the empty-cell-is-not-information rule was not applied").not.toContain(
      'data-testid="stage-progress-counts"',
    );
  });

  it("renders no progress section, and keeps the existing 'no fixtures' message, for a stage with zero fixtures", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={[]} />);
    expect(html).not.toContain('data-testid="stage-progress"');
    expect(html).toContain(en["schedule.noFixtures.can"]!);
  });

  it("does not render a 'Next: ...' line — the brief's own explicit exclusion", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    // Review m5: the positive half — the destination control the brief kept
    // IS on the page, so an empty render cannot satisfy the exclusion below.
    expect(html, "the panel rendered no stage controls at all — nothing was measured").toContain(
      'data-testid="stage-view-fixtures"',
    );
    expect(html.toLowerCase()).not.toMatch(/\bnext:/);
  });
});

// Owner-approved "Option 2" (on top of Option B) — "why are we not showing
// the fixtures in each stage?" answered with a destination control, not a
// second copy of the rows: `stage-view-fixtures`, reading as "View N
// fixtures" (`plural()`, this programme's own repeat "1 fixtures" offender).
// Since #850 the count leaves out the stage's round-robin REST-bye rows
// (`isRestBye`) and nothing else — every other row counts exactly as it did,
// a Swiss or bracket bye and a fed league's walkover included.
function viewFixturesTag(html: string): string | null {
  const m = /<button[^>]*data-testid="stage-view-fixtures"[^>]*>/.exec(html);
  return m ? m[0] : null;
}
function viewFixturesText(html: string): string | null {
  const m = /data-testid="stage-view-fixtures"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  if (m === null) return null;
  // Strip tags AND the trailing decorative arrow (`aria-hidden`, not part
  // of the translated copy this test actually pins).
  return m[1]!.replace(/<[^>]*>/g, "").replace(/→$/, "").trim();
}

describe("stage card — 'View N fixtures' destination control (owner-approved 'Option 2')", () => {
  it.each(DICTS)("%s: reads 'View N fixtures' with the stage's match count (6), real translations", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <StagesPanel {...PROPS} />
      </DictProvider>,
    );
    const text = viewFixturesText(html);
    expect(text, `no stage-view-fixtures control rendered (${locale})`).not.toBeNull();
    expect(text, `${locale} view-fixtures copy`).toBe(d["schedule.stage.viewFixtures.other"]!.replace("{count}", "6"));
  });

  it("the four locales are not the same English string copied four times", () => {
    const rendered = DICTS.map(([locale, dict]) =>
      viewFixturesText(
        renderToStaticMarkup(
          <DictProvider dict={dict} locale={locale}>
            <StagesPanel {...PROPS} />
          </DictProvider>,
        ),
      ),
    );
    expect(rendered.every((s) => s !== null)).toBe(true);
    for (const s of rendered.slice(1)) {
      expect(s).not.toBe(rendered[0]);
    }
  });

  it("uses the singular form for exactly one fixture — never 'View 1 fixtures'", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={[MIXED_FIXTURES[0]!]} />);
    expect(viewFixturesText(html)).toBe(en["schedule.stage.viewFixtures.one"]!);
  });

  // #850, review O2 / finding 5: a 5-entrant league persists a rest-bye row
  // per round, and the control read "View 15 fixtures" over 10 matches. It
  // counts what the counts line counts — the fixtures anyone PLAYS — so the
  // number it promises is the number of match rows the sheet then shows.
  it("#850: counts MATCHES — a league's rest-bye rows are not fixtures (6 matches + 2 byes reads 6)", () => {
    const restBye = (no: number) =>
      fixture("s1", no, {
        status: "forfeited",
        away_entrant_id: null,
        outcome: { kind: "award", winner: "e1" },
        ext_key: restByeExtKey("", no),
      });
    const html = renderToStaticMarkup(
      <StagesPanel {...PROPS} fixtures={[...MIXED_FIXTURES, restBye(7), restBye(8)]} />,
    );
    expect(viewFixturesText(html)).toBe(en["schedule.stage.viewFixtures.other"]!.replace("{count}", "6"));
    // ...and the counts line beside it agrees about what a fixture is.
    expect(html).toContain('data-testid="stage-progress-counts"');
  });

  // Owner ruling 2026-09-24 (fourth round): a fed league's WALKOVER (the bye's
  // shape, a match key) keeps its pre-#850 display — it is one of the stage's
  // fixtures, and "View N fixtures" counted it before #850. Only the MARKED
  // rest bye beside it drops out: 6 + 1 walkover + 1 rest bye reads 7.
  it("#850: a fed league's walkover still counts; only the marked rest bye does not (reads 7, not 6 or 8)", () => {
    const walkover = fixture("s1", 7, {
      status: "forfeited",
      away_entrant_id: null,
      outcome: { kind: "award", winner: "e1" },
      ext_key: "rr-r1-c3",
    });
    const rest = fixture("s1", 8, {
      status: "forfeited",
      away_entrant_id: null,
      outcome: { kind: "award", winner: "e1" },
      ext_key: restByeExtKey("", 1),
    });
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={[...MIXED_FIXTURES, walkover, rest]} />);
    expect(viewFixturesText(html)).toBe(en["schedule.stage.viewFixtures.other"]!.replace("{count}", "7"));
  });

  it("is absent for a stage with zero fixtures — nothing to view", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={[]} />);
    expect(html).not.toContain('data-testid="stage-view-fixtures"');
  });

  it("stays >= 44px tall (min-h-11)", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    const tag = viewFixturesTag(html);
    expect(tag, "stage-view-fixtures control not found").not.toBeNull();
    expect(tag!).toContain("min-h-11");
  });

  it("renders for a non-editing viewer too — this is navigation, not an edit action gated behind StageRail", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} canEdit={false} />);
    expect(html).toContain('data-testid="stage-view-fixtures"');
  });
});
