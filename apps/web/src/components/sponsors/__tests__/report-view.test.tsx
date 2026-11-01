// R4 sponsors on stream, S14 - the sponsor report's drawing (components/sponsors/report-view.tsx), pure: a report handed in,
// markup out (renderToStaticMarkup; apps/web vitest has no DOM). The DATABASE-backed figures are report-public.test.ts's and the
// page's seam is page.test.tsx's; this file pins what the drawing decides on its own:
//   - the break labels: every break kind a shipped sport declares (`naturalBreaks.kinds`, the engine's own list) has a label,
//     and it is the ONE map's label for that kind (`break-labels.ts`, the On stream tab's too); an unknown kind is the one
//     fallback, "a break in play" (`BREAK_FALLBACK_MSG`), a scene showing is the break screen - never a raw kind;
//   - the match line: both sides, an empty seat ("to be decided"), a deleted fixture;
//   - an OPEN showing says it is still being counted, never "0 s";
//   - viewers is a dash with words for a screen reader, never 0;
//   - the list says it is the latest N of M when the report holds more showings than it lists, and only then;
//   - the empty report: the empty sentence, no card.
// Sports: every shipped sport's declared kinds (the registry sweep).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { getDictionary, t } from "@/lib/i18n";
import { fmtOnScreen, type SponsorReport, type SponsorReportShowing } from "@/lib/sponsor-report";
import { BREAK_FALLBACK_MSG, BREAK_MSG } from "../break-labels";
import * as reportView from "../report-view";
import { SponsorReportView, breakLabel, matchLabel } from "../report-view";

const en = await getDictionary("en", "ui");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const showing = (over: Partial<SponsorReportShowing> = {}): SponsorReportShowing => ({
  airingId: crypto.randomUUID(),
  startedAt: "2026-06-02T10:00:00.000Z",
  onScreenMs: 8_000,
  match: { home: "Riverside", away: "Kingsway" },
  breakKind: "over_end",
  source: "rotation",
  frameUrl: null,
  viewers: null,
  watchUrl: null,
  ...over,
});
const report = (over: Partial<SponsorReport> = {}): SponsorReport => ({
  sponsor: { name: "Meridian Bank", logoUrl: null },
  orgName: "Riverside Sports Club",
  period: { from: "2026-06-01", to: "2026-06-30" },
  competition: null,
  asOf: "2026-07-01T09:00:00.000Z",
  timesShown: 1,
  onScreenMs: 8_000,
  viewerImpressions: null,
  streamVisits: 0,
  showings: [showing()],
  ...over,
});
const draw = (r: SponsorReport) => renderToStaticMarkup(<SponsorReportView report={r} ui={en} locale="en" />);

describe("break labels", () => {
  it("every kind a shipped sport declares has a label, and it is the ONE map's label for it (counted)", () => {
    const declared = new Set(builtinModules.flatMap((m) => (m.naturalBreaks?.kinds ?? []).map((k) => k.kind)));
    expect(declared.size, "anti-vacuity: the engine declares break kinds").toBeGreaterThan(5);
    let checked = 0;
    for (const kind of declared) {
      expect(breakLabel(en, { breakKind: kind, source: "rotation" }), kind).toBe(t(en, BREAK_MSG[kind]!));
      checked++;
    }
    expect(checked).toBe(declared.size);
    // final review m5: the report holds no map of its own.
    expect(Object.keys(reportView)).not.toContain("REPORT_BREAK_MSG");
  });

  it("an unknown kind reads as the ONE fallback, a break in play (the On stream tab's too), a scene showing as the break screen - never the raw kind", () => {
    expect(BREAK_FALLBACK_MSG).toBe("sponsors.break.inPlay");
    expect(breakLabel(en, { breakKind: "made_up_kind", source: "rotation" })).toBe(t(en, BREAK_FALLBACK_MSG));
    expect(breakLabel(en, { breakKind: null, source: "operator" })).toBe(t(en, BREAK_FALLBACK_MSG));
    expect(breakLabel(en, { breakKind: null, source: "scene" })).toBe(t(en, "sponsorReport.break.scene"));
    expect(breakLabel(en, { breakKind: "toString", source: "rotation" }), "an inherited name is not a kind").toBe(t(en, BREAK_FALLBACK_MSG));
    expect(draw(report({ showings: [showing({ breakKind: "made_up_kind" })] }))).not.toContain("made_up_kind");
  });
});

describe("the match line", () => {
  it("both sides, an empty seat, a deleted fixture", () => {
    expect(matchLabel(en, { home: "Riverside", away: "Kingsway" })).toBe(t(en, "sponsorReport.match.sides", { home: "Riverside", away: "Kingsway" }));
    expect(matchLabel(en, { home: "Riverside", away: null })).toBe(
      t(en, "sponsorReport.match.sides", { home: "Riverside", away: t(en, "sponsorReport.match.tbd") }),
    );
    expect(matchLabel(en, null)).toBe(t(en, "sponsorReport.match.gone"));
  });
});

describe("the figures and the list", () => {
  it("an open showing is still being counted, never 0 s; a closed one its own time", () => {
    const html = draw(report({ timesShown: 2, showings: [showing({ onScreenMs: null }), showing({ onScreenMs: 12_000 })] }));
    expect(html).toContain(esc(t(en, "sponsorReport.showing.open")));
    expect(html).toContain(esc(t(en, "sponsorReport.showing.onScreen", { duration: fmtOnScreen("en", 12_000) })));
    expect(html).not.toContain(esc(t(en, "sponsorReport.showing.onScreen", { duration: fmtOnScreen("en", 0) })));
  });

  it("viewers is a dash with words, never a 0; a number when there is one", () => {
    expect(draw(report())).toMatch(/data-testid="report-viewers"[^>]*><span aria-hidden="true">—<\/span><span class="sr-only">Not available yet<\/span>/);
    expect(draw(report({ viewerImpressions: 2140 }))).toMatch(/data-testid="report-viewers"[^>]*>2,140</);
  });

  it("says it lists the latest N of M only when it lists fewer than were shown", () => {
    const latest = (shown: number, total: number) => esc(t(en, "sponsorReport.showings.latest", { shown, total }));
    expect(draw(report({ timesShown: 50, showings: [showing(), showing()] }))).toContain(latest(2, 50));
    expect(draw(report({ timesShown: 2, showings: [showing(), showing()] }))).not.toContain("showings, newest first");
  });

  it("the empty report: the empty sentence and no card; a frame-less showing the placeholder, a framed one its image", () => {
    const empty = draw(report({ timesShown: 0, onScreenMs: 0, showings: [] }));
    expect(empty).toContain(esc(t(en, "sponsorReport.showings.empty")));
    expect(empty).not.toContain('data-testid="report-showing"');
    const framed = draw(report({ timesShown: 2, showings: [showing({ frameUrl: "https://storage.test/signed/9?sig=x" }), showing()] }));
    expect(framed).toContain('src="https://storage.test/signed/9?sig=x"');
    expect((framed.match(/data-testid="report-frame-missing"/g) ?? []).length).toBe(1);
    expect(framed, "a signed url never leaves in a Referer").toMatch(/<img[^>]*referrerPolicy="no-referrer"|<img[^>]*referrerpolicy="no-referrer"/i);
  });

  it("a sponsor with no logo gets its initials; one with a logo its image, as stored", () => {
    expect(draw(report())).toContain(">MB<");
    expect(draw(report({ sponsor: { name: "Meridian Bank", logoUrl: "https://cdn.example/mb.png" } }))).toContain('src="https://cdn.example/mb.png"');
  });
});
