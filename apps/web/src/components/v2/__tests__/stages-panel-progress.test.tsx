// Competition Desk W3, owner-approved redesign "Option A" (Task 10
// follow-up) — the stage card's BODY used to render nothing beyond its own
// header (measured: 814x234px of "1. Group Stage · Group · Active" and a
// rule). This suite pins the fixtures-progress summary that fills it: a
// suppressible counts line (`stage-progress-counts`, done / in play / to
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
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

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

/** The counts line's TEXT: tags stripped, because the "N to schedule" clause is a link (Match Day E1 fix round 1, m3). */
function progressCounts(html: string): string | null {
  const m = /data-testid="stage-progress-counts"[^>]*>(.*?)<\/p>/s.exec(html);
  return m ? m[1]!.replace(/<[^>]*>/g, "") : null;
}

/** The "N to schedule" link inside the counts line: its href and its words, or null when the line carries none. */
function toScheduleLink(html: string): { href: string; text: string } | null {
  const line = /data-testid="stage-progress-counts"[^>]*>(.*?)<\/p>/s.exec(html)?.[1];
  const m = line === undefined ? null : /<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/s.exec(line);
  return m ? { href: m[1]!, text: m[2]!.replace(/<[^>]*>/g, "") } : null;
}

describe("stage card body — fixtures progress (owner-approved 'Option A')", () => {
  it.each(DICTS)("%s: the counts line names done (2), in play (1) and to schedule (2), real translations", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <StagesPanel {...PROPS} />
      </DictProvider>,
    );
    const counts = progressCounts(html);
    expect(counts, `no stage-progress-counts rendered (${locale})`).not.toBeNull();
    expect(counts, `${locale} done clause`).toContain(d["schedule.progress.done.other"]!.replace("{count}", "2"));
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
  it("D12: an online board whose round nobody has opened is counted 'not opened' — and the clause is absent at zero", () => {
    const unopened = {
      f3: { cameraPolicy: "off", cameraFlagCount: 0, connectionProblemCount: 0, offSeaznFlagCount: 0, held: null, live: false, unopened: true },
      f4: { cameraPolicy: "off", cameraFlagCount: 0, connectionProblemCount: 0, offSeaznFlagCount: 0, held: null, live: true, unopened: false },
    } as const;
    const counts = progressCounts(renderToStaticMarkup(<StagesPanel {...PROPS} onlinePlay={unopened} />))!;
    expect(counts).toContain(en["schedule.progress.notOpened.one"]!.replace("{count}", "1"));
    const bare = progressCounts(renderToStaticMarkup(<StagesPanel {...PROPS} />))!;
    expect(bare, "the positive pair: the same line renders").toContain(en["schedule.progress.inPlay.one"]!);
    expect(bare).not.toContain(en["schedule.progress.notOpened.one"]!.replace("{count}", "1"));
    expect(bare).not.toContain("0 not opened");
  });

  // Match Day E1 fix round 1 (m3): the card's footer link to the division schedule was removed with the unscheduled footer, so the
  // "N to schedule" clause is the way there - a link to the same page, in the viewer's own words.
  it.each(DICTS)("%s: the 'N to schedule' clause is a link to the division schedule, and only that clause is", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <StagesPanel {...PROPS} />
      </DictProvider>,
    );
    const link = toScheduleLink(html);
    expect(link, `${locale}: the to-schedule clause is not a link`).not.toBeNull();
    expect(link!.href).toBe(routes.divisionSchedule("org", "comp", "div"));
    expect(link!.text).toBe(d["schedule.progress.toSchedule.other"]!.replace("{count}", "2"));
    const anchors = (/data-testid="stage-progress-counts"[^>]*>(.*?)<\/p>/s.exec(html)![1]!.match(/<a /g) ?? []).length;
    expect(anchors, `${locale}: the done / in-play clauses stay plain text`).toBe(1);
  });

  it("a stage with nothing to schedule has no link - the clause is absent, so is the way to the schedule", () => {
    const scheduled = MIXED_FIXTURES.map((f) => ({ ...f, scheduled_at: f.scheduled_at ?? "2026-09-06T10:00:00.000Z" }));
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={scheduled} />);
    expect(progressCounts(html), "premise: the counts line still renders (done / in play)").toContain(en["schedule.progress.inPlay.one"]!);
    expect(toScheduleLink(html)).toBeNull();
  });

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
    expect(counts).toContain(en["schedule.progress.done.other"]!.replace("{count}", "2"));
    expect(counts).toContain(en["schedule.progress.toSchedule.other"]!.replace("{count}", "2"));
  });

  it("suppresses the whole counts line - never an empty <p> - when all three counts are zero", () => {
    // Every match dated and waiting: not done (no result), not in play, nothing to schedule (it has a time). The line has nothing to say.
    const allWaiting = MIXED_FIXTURES.map((f) => ({ ...f, status: "scheduled", outcome: null, scheduled_at: "2026-09-06T10:00:00.000Z" }));
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={allWaiting} />);
    expect(html, "premise: the stage's matches are on the page").toContain('data-testid="stage-run-sheet"');
    expect(html, "an empty counts <p> rendered - the empty-cell-is-not-information rule was not applied").not.toContain(
      'data-testid="stage-progress-counts"',
    );
  });

  it("a stage whose every match was cancelled reads 'N done' - cancelled is settled for the card, the Complete button and the bars alike", () => {
    // Was "not played" under the old strict rule (decided / finalized only); the shared count (`stageCounts`) settles it.
    const allVoid = MIXED_FIXTURES.map((f) => ({ ...f, status: "cancelled" }));
    const counts = progressCounts(renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={allVoid} />));
    expect(counts, "the counts line rendered").not.toBeNull();
    expect(counts).toContain(en["schedule.progress.done.other"]!.replace("{count}", String(allVoid.length)));
  });

  it("renders no progress section, and keeps the existing 'no fixtures' message, for a stage with zero fixtures", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={[]} />);
    expect(html).not.toContain('data-testid="stage-progress"');
    expect(html).toContain(en["schedule.noFixtures.can"]!);
  });

  // Match Day E1 fix round 1 (controller ruling): the counts line says "N done" with the SAME number the stage's round bars add up to
  // (`stageCounts`' settled bucket, byes out, a held match open). It used to say "1 played" (decided / finalized only) beside a bar's
  // "2 of 3 done" as soon as a walkover existed. Driven through the real panel: the line and the bars are both read out of ONE render.
  describe("parity: the counts line and the sum of the round bars (E1 fix 1)", () => {
    const WIN = { kind: "win", winner: "e1" };
    const BYE_AWARD = { kind: "award", winner: "e1", loser: null, reason: "bye" };
    // Expected counts are read off the case list below (the statuses a match can end in), never off the code under test.
    // Round 1: a decided match, a walkover (forfeited), a settled abandonment, a bye (no match). Round 2: a held abandonment (its settle
    // is still owed), a cancellation, an in-play match, one waiting.
    const rows = [
      fixture("s1", 1, { status: "decided", outcome: WIN, scheduled_at: "2026-09-01T09:00:00.000Z" }),
      fixture("s1", 2, { status: "forfeited", outcome: { kind: "forfeit", winner: "e1", by: "e2", reason: "walkover" }, scheduled_at: "2026-09-01T10:00:00.000Z" }),
      fixture("s1", 3, { status: "abandoned", scheduled_at: "2026-09-01T11:00:00.000Z" }),
      { ...fixture("s1", 4, { status: "forfeited", outcome: BYE_AWARD }), away_entrant_id: null },
      { ...fixture("s1", 5, { status: "abandoned", scheduled_at: "2026-09-02T09:00:00.000Z" }), round_no: 2 },
      { ...fixture("s1", 6, { status: "cancelled", scheduled_at: "2026-09-02T10:00:00.000Z" }), round_no: 2 },
      { ...fixture("s1", 7, { status: "in_play", scheduled_at: "2026-09-02T11:00:00.000Z" }), round_no: 2 },
      { ...fixture("s1", 8, { scheduled_at: "2026-09-02T12:00:00.000Z" }), round_no: 2 },
    ];
    const DONE = 4; // decided, forfeited, abandoned (settled), cancelled - the bye is no match, the held abandonment is still open
    const TOTAL = 7; // eight rows, one bye
    const barsOf = (html: string): { done: number; total: number }[] =>
      [...html.matchAll(/<header[^>]*data-testid="run-sheet-round-bar"[^>]*>([\s\S]*?)<\/header>/g)].map((m) => {
        const t = /(\d+) of (\d+) done/.exec(m[1]!.replace(/<[^>]*>/g, ""));
        if (t === null) throw new Error(`a round bar carries no "N of M done": ${m[1]!.slice(0, 160)}`);
        return { done: Number(t[1]), total: Number(t[2]) };
      });
    const lineDone = (html: string): number | null => {
      const m = /(\d+) done/.exec(progressCounts(html) ?? "");
      return m ? Number(m[1]) : null;
    };

    it("walkover + settled abandonment + cancellation are done, the held abandonment is not: the line and the bars agree", () => {
      const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={rows} awaitingSettle={["f5"]} />);
      const bars = barsOf(html);
      expect(bars.length, "anti-vacuity: the stage's two round bars were read").toBe(2);
      const sum = bars.reduce((a, b) => ({ done: a.done + b.done, total: a.total + b.total }), { done: 0, total: 0 });
      expect(sum, "the bars add up to the cases above").toEqual({ done: DONE, total: TOTAL });
      expect(lineDone(html), "the counts line says the number the bars add up to").toBe(sum.done);
      expect(progressCounts(html)).toContain(en["schedule.progress.done.other"]!.replace("{count}", String(DONE)));
      expect(progressCounts(html), "the old strict word is gone").not.toContain("played");
    });

    it("settling the held abandonment moves the line and the bars together (a second render, after the settle)", () => {
      const before = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={rows} awaitingSettle={["f5"]} />);
      const after = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={rows} awaitingSettle={[]} />);
      expect(lineDone(before)).toBe(DONE);
      expect(lineDone(after), "the settled abandonment is done on the line ...").toBe(DONE + 1);
      expect(barsOf(after).reduce((a, b) => a + b.done, 0), "... and on the bars").toBe(DONE + 1);
    });

    it("no match done: the line carries no 'done' clause (and so does not say '0 done')", () => {
      const open = rows.map((r) => ({ ...r, status: "scheduled", outcome: null }));
      const html = renderToStaticMarkup(<StagesPanel {...PROPS} fixtures={open} />);
      expect(progressCounts(html), "premise: the line still renders").not.toBeNull();
      expect(lineDone(html)).toBeNull();
      expect(progressCounts(html)).not.toContain("0 done");
    });
  });

  it("does not render a 'Next: ...' line — the brief's own explicit exclusion", () => {
    const html = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    // Review m5: the positive half — the stage's own fixtures ARE on the page (Match Day C3 put them in the card), so an empty
    // render cannot satisfy the exclusion below.
    expect(html, "the panel rendered no stage controls at all — nothing was measured").toContain(
      'data-testid="stage-run-sheet"',
    );
    expect(html.toLowerCase()).not.toMatch(/\bnext:/);
  });
});

// Match Day C3 (spec §12 item 9) retired the "View N fixtures" destination control that stood here (owner-approved "Option 2",
// 2026-09-xx): a stage's fixtures now render IN its card (`stage-run-sheet`), so there is nowhere to "view" them from. What replaces
// its tests - the fixtures in the card, the absent control and its absent words - is `stages-panel-stage-card.test.tsx`.
