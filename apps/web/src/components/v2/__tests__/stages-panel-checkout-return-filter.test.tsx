import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { StagesPanel, initialRunSheetFilter } from "@/components/v2/stages-panel";
import { runSheetKeeps, type RunSheetFilter, type RunSheetKeepContext } from "@/components/v2/desk/run-sheet";
import { DIVISION_PHASES, resolvePhase, type PhaseInput } from "@/lib/division-phase";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

/**
 * D2 (stream-credits walkthrough, owner: fix now, 2026-09-29). A stream-credit checkout returns to
 * `?tab=fixtures&fixture=<id>&stream=open&checkout=success&session_id=…`, and that fixture's panel is meant to reopen on
 * the Phone tab. On a match day the run sheet MOUNTS on "Today" (design, desk §filters), and "Today" keeps only a TIMED
 * fixture dated today — so an untimed fixture's row never rendered, its panel never mounted, and a club that had just
 * paid landed on a page without its match. The mounting filter must include the returned fixture; every other visit
 * keeps the design's default.
 *
 * Expected filters are never typed from the code under test: "includes it" is asked of the run sheet's OWN row predicate
 * (`runSheetKeeps`, the one `<RunSheet>` filters rows with), and the default is the design's rule (Today on
 * `match_day`, else All) with the phase BUILT by `resolvePhase` rather than written as a word.
 */

const NOW = "2026-03-01T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const TZ = "UTC";
const TIMED_TODAY = "2026-03-01T15:00:00Z";

const stage = () => ({
  id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active",
});
const fixture = (o: { id: string; fixture_no: number; scheduled_at: string | null }) => ({
  stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: o.fixture_no, home_entrant_id: "e1", away_entrant_id: "e2",
  venue: null, court_label: null, court_id: null, court_name: null, status: "scheduled", outcome: null, ...o,
});
const timed = fixture({ id: "f-timed", fixture_no: 1, scheduled_at: TIMED_TODAY });
const untimed = fixture({ id: "f-untimed", fixture_no: 2, scheduled_at: null });

const phaseInput: PhaseInput = {
  divisionStatus: "active",
  stages: [
    { id: "s1", name: "League", seq: 1, status: "active", hasFixtures: true, timing: null, sourceReady: false, proposal: "none" as const },
  ],
  fixtures: [timed, untimed].map((f) => ({
    id: f.id, status: f.status, scheduledAt: f.scheduled_at, startedAt: null, eventCount: 0, matchMinutes: 30,
    hasScorer: true, stageId: "s1", awaitsSeedDraw: false,
  })),
  now: NOW,
  tz: TZ,
  awaitingRegistrations: 0,
};

const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage()], fixtures: [timed, untimed], entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true, tz: TZ, orgTz: TZ, canExport: false, matchMinutes: 30,
  viewerPlan: "community" as const,
};

/** The run sheet's own row test, at the panel's clock. `stageId: null` — the stage filter mounts unset. */
const ctx: RunSheetKeepContext = { stageId: null, tz: TZ, today: dayKeyInTz(NOW_MS, TZ), nowMs: NOW_MS, matchMinutes: 30 };
const asRow = (f: typeof timed): RunSheetFixture => ({ ...f }) as unknown as RunSheetFixture;
const designDefault = (phase: string): RunSheetFilter => (phase === "match_day" ? "today" : "all");

const pressedFilter = (html: string): string | null =>
  /<button[^>]*data-filter="([a-z_]+)"[^>]*aria-pressed="true"/.exec(html)?.[1] ?? null;
const rowRendered = (html: string, fixtureNo: number): boolean => html.includes(`data-fixture-no="${fixtureNo}"`);
const returnTo = (fixtureId: string) => ({ stream: "open", fixture: fixtureId });

describe("the run sheet's mounting filter honours a checkout return (D2)", () => {
  const phase = resolvePhase(phaseInput);

  it("premise: the division is on its match day, and 'Today' hides the untimed fixture but keeps the timed one", () => {
    expect(phase, "a division with a fixture dated today is match_day (rule 3)").toBe("match_day");
    expect(runSheetKeeps(asRow(untimed), "today", ctx)).toBe(false);
    expect(runSheetKeeps(asRow(timed), "today", ctx)).toBe(true);
  });

  describe("the derivation", () => {
    it("returned UNTIMED fixture → a filter whose rows include it", () => {
      const chosen = initialRunSheetFilter(phase, asRow(untimed), { tz: TZ, nowMs: NOW_MS, matchMinutes: 30 });
      expect(runSheetKeeps(asRow(untimed), chosen, ctx), `mounted on "${chosen}"`).toBe(true);
      // Not merely "some filter": the default would have hidden it, so the choice moved.
      expect(chosen).not.toBe(designDefault(phase));
    });

    it("returned fixture timed TODAY → the default 'today' is kept", () => {
      expect(initialRunSheetFilter(phase, asRow(timed), { tz: TZ, nowMs: NOW_MS, matchMinutes: 30 })).toBe(
        designDefault(phase),
      );
      expect(designDefault(phase)).toBe("today");
    });

    it("NO return → the design's default, on every phase (positive pair)", () => {
      let checked = 0;
      for (const p of DIVISION_PHASES) {
        expect(initialRunSheetFilter(p, null, { tz: TZ, nowMs: NOW_MS, matchMinutes: 30 }), p).toBe(designDefault(p));
        checked++;
      }
      expect(initialRunSheetFilter(undefined, null, { tz: TZ, nowMs: NOW_MS, matchMinutes: 30 })).toBe("all");
      expect(checked, "phases checked").toBe(DIVISION_PHASES.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("a returned fixture is on the mounted sheet whatever the phase", () => {
      let checked = 0;
      for (const p of DIVISION_PHASES) {
        for (const f of [timed, untimed]) {
          const chosen = initialRunSheetFilter(p, asRow(f), { tz: TZ, nowMs: NOW_MS, matchMinutes: 30 });
          expect(runSheetKeeps(asRow(f), chosen, ctx), `${p} / ${f.id} mounted on "${chosen}"`).toBe(true);
          checked++;
        }
      }
      expect(checked, "phase × fixture cases checked").toBe(DIVISION_PHASES.length * 2);
      expect(checked).toBeGreaterThan(0);
    });
  });

  describe("the panel, rendered", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const render = (checkoutReturn?: { stream?: string; fixture?: string }) =>
      renderToStaticMarkup(<StagesPanel {...baseProps} phase={phase} checkoutReturn={checkoutReturn} />);

    it("NO return → mounts on 'today', and the untimed row is not rendered (the positive pair)", () => {
      // The page's exact shape on an ordinary visit (page.tsx hands both params through, each undefined) — a truthy
      // object, so the lookup runs and must find nothing — and the prop left off entirely.
      let checked = 0;
      for (const html of [render({ stream: undefined, fixture: undefined }), render()]) {
        expect(pressedFilter(html)).toBe("today");
        expect(rowRendered(html, timed.fixture_no)).toBe(true);
        expect(rowRendered(html, untimed.fixture_no)).toBe(false);
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("a return naming the UNTIMED fixture → its row is rendered", () => {
      const html = render(returnTo(untimed.id));
      expect(rowRendered(html, untimed.fixture_no)).toBe(true);
      expect(pressedFilter(html)).toBe("all");
    });

    it("a return naming the fixture timed TODAY → still 'today', its row rendered", () => {
      const html = render(returnTo(timed.id));
      expect(pressedFilter(html)).toBe("today");
      expect(rowRendered(html, timed.fixture_no)).toBe(true);
    });

    it("a returned fixture id that is not in this division → the default, no crash", () => {
      const html = render(returnTo("f-elsewhere"));
      expect(pressedFilter(html)).toBe("today");
    });

    it("a URL that names the fixture but will not open its panel (no stream=open) → the default", () => {
      expect(pressedFilter(render({ fixture: untimed.id }))).toBe("today");
      expect(pressedFilter(render({ stream: "closed", fixture: untimed.id }))).toBe("today");
    });
  });

  /**
   * "Today" is the VENUE's day (the run sheet's `tz`, the division's venue zone), never UTC's or the org's. Auckland is
   * UTC+13 on 2026-03-01 (NZDT): at 12:00Z it is already 01:00 on 2 March there, so a fixture at 09:00Z (22:00 on
   * 1 March, local) is TODAY in UTC and YESTERDAY at the venue. The expected filter is asked of `runSheetKeeps` under the
   * venue's own clock; the two premises prove the case tells the zones apart, so a derivation reading the wrong one reds.
   */
  describe("the zone: 'today' is the venue's day", () => {
    const VENUE = "Pacific/Auckland";
    const yesterdayAtVenue = fixture({ id: "f-venue-yesterday", fixture_no: 3, scheduled_at: "2026-03-01T09:00:00Z" });
    const venueCtx: RunSheetKeepContext = { ...ctx, tz: VENUE, today: dayKeyInTz(NOW_MS, VENUE) };
    const venuePhase = resolvePhase({
      ...phaseInput,
      tz: VENUE,
      fixtures: [timed, yesterdayAtVenue].map((f) => ({
        id: f.id, status: f.status, scheduledAt: f.scheduled_at, startedAt: null, eventCount: 0, matchMinutes: 30,
        hasScorer: true, stageId: "s1", awaitsSeedDraw: false,
      })),
    });

    it("premise: match day at the venue; the fixture is today in UTC and not today at the venue", () => {
      expect(venuePhase, "15:00Z is 04:00 on 2 March in Auckland — today there").toBe("match_day");
      expect(runSheetKeeps(asRow(yesterdayAtVenue), "today", ctx), "today in UTC").toBe(true);
      expect(runSheetKeeps(asRow(yesterdayAtVenue), "today", venueCtx), "yesterday at the venue").toBe(false);
    });

    it("the derivation reads the venue's clock: the returned fixture is on the mounted sheet there", () => {
      const chosen = initialRunSheetFilter(venuePhase, asRow(yesterdayAtVenue), { tz: VENUE, nowMs: NOW_MS, matchMinutes: 30 });
      expect(runSheetKeeps(asRow(yesterdayAtVenue), chosen, venueCtx), `mounted on "${chosen}"`).toBe(true);
      expect(chosen).not.toBe(designDefault(venuePhase));
    });

    describe("rendered, venue zone ≠ org zone", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(NOW));
      });
      afterEach(() => {
        vi.useRealTimers();
      });
      const renderAtVenue = (checkoutReturn: { stream?: string; fixture?: string }) =>
        renderToStaticMarkup(
          <StagesPanel {...baseProps} tz={VENUE} orgTz="UTC" phase={venuePhase} fixtures={[timed, yesterdayAtVenue]} checkoutReturn={checkoutReturn} />,
        );

      it("a return naming it → its row is rendered; an ordinary visit → it is not (the positive pair)", () => {
        const returned = renderAtVenue(returnTo(yesterdayAtVenue.id));
        expect(rowRendered(returned, yesterdayAtVenue.fixture_no)).toBe(true);
        expect(pressedFilter(returned)).toBe("all");
        const ordinary = renderAtVenue({ stream: undefined, fixture: undefined });
        expect(pressedFilter(ordinary)).toBe("today");
        expect(rowRendered(ordinary, yesterdayAtVenue.fixture_no)).toBe(false);
        expect(rowRendered(ordinary, timed.fixture_no)).toBe(true);
      });
    });
  });
});
