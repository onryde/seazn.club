import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { dayLabel, dayLabelLong } from "@/lib/day-label";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Competition Desk W2 — the run sheet's two DATE-BEARING headers.
//
// FINDING 13. `DayHeading` called `date.toLocaleDateString([], …)`. The `[]`
// first argument means "the runtime's default locale", i.e. the VIEWER'S
// BROWSER — so the largest string on a fully French console read "Saturday 5
// September" for an en-US viewer and "9月5日土曜日" for a ja-JP one. This is the
// exact regression `lib/day-label.ts` exists to prevent, and its own header
// records the previous instance verbatim.
//
// RULING R34. A bracket fixture's calendar DATE was nowhere on the tab: rows
// print `HH:mm` only, and only DAY blocks carry a date header — bracket stages
// never produce one. So a knockout Final three weeks out showed "14:00" and
// nothing to say which day. The retired `round-dates` bar carried exactly this
// fact, and ruling A2 kept round sections for brackets, so the container
// already exists. Suppressed when the round has no timed fixtures at all —
// a header that fires with nothing to say is the defect it would be fixing.
//
// Both are formatted through `day-label.ts` with an EXPLICIT locale, which is
// also what makes them hydration-stable (an explicit locale renders identically
// on server and client, which is why `schedule-board.tsx` needs no client-only
// gate for the same call).

const DICTS: Record<Locale, Dict> = { en: enUi, fr: frUi, es: esUi, nl: nlUi };

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const DAY_KEY = "2026-09-05";

function fx(no: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: "s1",
    fixture_no: no,
    round_no: 1,
    seq_in_round: no,
    scheduled_at: `${DAY_KEY}T14:00:00.000Z`,
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

function sheetHtml(
  fixtures: RunSheetFixture[],
  stages: { id: string; seq: number; kind: string; name: string }[],
  locale: Locale = "en",
  filter: RunSheetFilter = "all",
): string {
  return renderToStaticMarkup(
    <DictProvider dict={DICTS[locale]} locale={locale}>
      <RunSheet
        blocks={buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS })}
        stages={stages}
        tz={TZ}
        orgTz={TZ}
        nowMs={NOW_MS}
        matchMinutes={60}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter={filter}
        onFilter={() => {}}
        stageId={null}
        onStageFilter={() => {}}
      />
    </DictProvider>,
  );
}

const LEAGUE = [{ id: "s1", seq: 1, kind: "league", name: "League" }];
const KNOCKOUT = [{ id: "s1", seq: 1, kind: "knockout", name: "Cup" }];

/** The text of the day header the sheet rendered for `dayKey`. */
function dayHeaderText(html: string, dayKey: string): string {
  const m = new RegExp(`data-run-sheet-day="${dayKey}"[^>]*>([\\s\\S]*?)</h3>`).exec(html);
  expect(m, `no day header for ${dayKey}`).not.toBeNull();
  return m![1]!.replace(/<[^>]*>/g, "");
}

/** Every bracket round header's text, in render order. */
function roundHeaderTexts(html: string): string[] {
  return [...html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, ""));
}

// --- FINDING 13 -------------------------------------------------------------

describe("the day header is formatted in the APP's locale, not the browser's", () => {
  it.each(LOCALES)("%s renders the day in that locale", (locale) => {
    const html = sheetHtml([fx(1)], LEAGUE, locale);
    // Positive pair: the header exists and the row under it rendered, so the
    // equality below is not being satisfied by an empty page.
    expect(html).toContain('data-fixture-no="1"');
    expect(dayHeaderText(html, DAY_KEY)).toContain(dayLabelLong(DAY_KEY, locale));
  });

  // The witness: four locales, four different DATE strings.
  //
  // Deliberately the first "·" segment and not the whole header — the header
  // also carries a pluralized fixture count, which is localized by the dict and
  // therefore differs per locale ANYWAY. Comparing whole headers here passed
  // against a locale-blind date, which is the assertion-that-cannot-fail shape
  // this wave keeps paying for. (Caught by running the mutant.)
  it("the four locales render four different DATES", () => {
    const dates = LOCALES.map((l) => dayHeaderText(sheetHtml([fx(1)], LEAGUE, l), DAY_KEY).split("·")[0]!.trim());
    expect(new Set(dates).size, `dates were ${JSON.stringify(dates)}`).toBe(LOCALES.length);
  });

  // Server-rendered markup used to be BLANK here — the label was filled by a
  // `useEffect`, which never runs in `renderToStaticMarkup` (nor in Next's SSR
  // pass). An explicit locale is deterministic, so the effect is gone and the
  // date is in the first paint.
  it("the date is present in server-rendered markup, not filled in after mount", () => {
    expect(dayHeaderText(sheetHtml([fx(1)], LEAGUE), DAY_KEY)).not.toBe(DAY_KEY);
  });
});

// --- RULING R34 -------------------------------------------------------------

describe("a bracket round section carries its calendar date", () => {
  it("a single-day round names that day beside the round label", () => {
    const html = sheetHtml([fx(1), fx(2)], KNOCKOUT);
    const headers = roundHeaderTexts(html);
    expect(headers, "no bracket round header rendered").toHaveLength(1);
    expect(headers[0]).toContain(dayLabel(DAY_KEY, "en"));
  });

  it("a round spanning two days shows a range, earliest first", () => {
    const html = sheetHtml([fx(1), fx(2, { scheduled_at: "2026-09-06T10:00:00.000Z" })], KNOCKOUT);
    const header = roundHeaderTexts(html)[0]!;
    expect(header).toContain(dayLabel(DAY_KEY, "en"));
    expect(header).toContain(dayLabel("2026-09-06", "en"));
    expect(header.indexOf(dayLabel(DAY_KEY, "en"))).toBeLessThan(header.indexOf(dayLabel("2026-09-06", "en")));
  });

  // "Suppress it when it would add nothing."
  //
  // The reachable shape is a SETTLED, never-timed bracket round — an entirely
  // normal knockout, since nothing in this product requires timing a round
  // before playing it, and `buildRunSheet` keeps those rows in their round
  // section on purpose. (An OPEN untimed bracket fixture cannot witness this:
  // it is filed in the "Not yet scheduled" block, which is review finding 9 and
  // out of this task's scope.)
  const played = { status: "decided", scheduled_at: null, outcome: { kind: "win", winner: "e1" } };
  it("a settled round that was never timed says nothing about dates", () => {
    const html = sheetHtml([fx(1, played), fx(2, played)], KNOCKOUT, "en", "all");
    const headers = roundHeaderTexts(html);
    // Positive pair: the round section really did render, with its rows.
    expect(headers).toHaveLength(1);
    expect(html).toContain('data-fixture-no="1"');
    expect(html).not.toContain("data-run-sheet-round-dates");
    expect(headers[0]).not.toMatch(/\d/);
  });

  // A round that is PART timed still names the days it does know — dropping the
  // header because one row is untimed would lose the fact for the rest.
  it("a part-timed round still names the days it knows", () => {
    const html = sheetHtml([fx(1), fx(2, played)], KNOCKOUT, "en", "all");
    expect(roundHeaderTexts(html)[0]).toContain(dayLabel(DAY_KEY, "en"));
  });

  it("the date is localized too, and rendered server-side", () => {
    const html = sheetHtml([fx(1)], KNOCKOUT, "fr");
    expect(roundHeaderTexts(html)[0]).toContain(dayLabel(DAY_KEY, "fr"));
    expect(dayLabel(DAY_KEY, "fr")).not.toBe(dayLabel(DAY_KEY, "en"));
  });
});

// --- F3 (W2 walkthrough gate 1) ---------------------------------------------
//
// Bracket blocks carry their stage; day blocks carry a date; the unscheduled
// and settled groups carry neither — and they are the two that merge every
// stage. With 20 of 31 rows in the unscheduled queue in the reported
// division, "Round 1 · Bravo vs Echo" appeared twice, two rows apart, one
// live and one never scheduled, with nothing on screen resolving them.
describe("the unscheduled and settled groups name their stage in a multi-stage division (F3)", () => {
  const ALPHA = { id: "s1", seq: 1, kind: "league", name: "Alpha" };
  const BETA = { id: "s2", seq: 2, kind: "league", name: "Beta" };

  it("an unscheduled row from each stage prints that stage's name", () => {
    const html = sheetHtml(
      [
        fx(1, { stage_id: "s1", scheduled_at: null, status: "scheduled" }),
        fx(2, { stage_id: "s2", scheduled_at: null, status: "scheduled" }),
      ],
      [ALPHA, BETA],
    );
    expect(html).toContain("data-run-sheet-block=\"unscheduled\"");
    expect(html).toContain("Alpha ·");
    expect(html).toContain("Beta ·");
  });

  it("a settled row from each stage prints that stage's name", () => {
    const html = sheetHtml(
      [
        fx(1, { stage_id: "s1", scheduled_at: null, status: "decided", outcome: { kind: "win", winner: "e1" } }),
        fx(2, { stage_id: "s2", scheduled_at: null, status: "decided", outcome: { kind: "win", winner: "e1" } }),
      ],
      [ALPHA, BETA],
    );
    expect(html).toContain("data-run-sheet-block=\"settled\"");
    expect(html).toContain("Alpha ·");
    expect(html).toContain("Beta ·");
  });

  it("a SINGLE-stage division's unscheduled row names no stage at all", () => {
    const html = sheetHtml([fx(1, { scheduled_at: null, status: "scheduled" })], LEAGUE);
    expect(html).toContain("data-run-sheet-block=\"unscheduled\"");
    expect(html).not.toContain("League ·");
  });
});
