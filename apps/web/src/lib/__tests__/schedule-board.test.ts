// Daily play hours ⇄ session windows (PROMPT-33 follow-up): the settings
// panel offers "we play 09:00–18:00"; the engine wants absolute intervals.
//
// Both directions resolve on the VENUE clock (`settings.orgTz`, #448), which
// the caller passes in. They used to resolve through the browser's, so an
// organiser in another zone expanded "09:00" into their own 09:00 and the
// solver was handed windows that did not match the hours on screen.
//
// EVERY CASE BELOW USES A ZONE THE TEST PROCESS IS NOT IN. `Pacific/Auckland`
// is UTC+12/+13, so its calendar day differs from the fixtures' UTC instants —
// a browser-zone expansion lands on different DAYS, not just different hours.
import { describe, expect, it } from "vitest";
import { dailyHoursToWindows, feedLabels, windowsToDailyHours, type FeedRow } from "@/lib/schedule-board";
import { zonedDateInput, zonedTimeInput } from "@/lib/zoned-datetime";
import { matchRef, resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { msgFor } from "@/lib/messages-i18n";
import { LOCALES } from "@/lib/i18n-constants";
import { consoleFixtures } from "@/components/v2/schedule-board";
import { cardTitle, type BoardFixture } from "@/components/v2/board/types";
import { boardRoundCodes, withRoundCodeRefs } from "@/components/v2/board/round-codes";

/** The venue zone in every case below. */
const AKL = "Pacific/Auckland";
const PROCESS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Wall-clock "HH:MM" on the venue clock. */
const at = (iso: string) => zonedTimeInput(iso, AKL);
/** Calendar day on the venue clock. */
const day = (iso: string) => zonedDateInput(iso, AKL);

describe("dailyHoursToWindows", () => {
  it("expands one window per day across the start→end span, inclusive", () => {
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T12:00:00.000Z",
      "2026-09-17T12:00:00.000Z",
      AKL,
    );
    expect(windows).not.toBeNull();
    expect(windows!.length).toBe(3);
    for (const w of windows!) {
      expect(at(w.from)).toBe("09:00");
      expect(at(w.to)).toBe("18:00");
      expect(new Date(w.to).getTime()).toBeGreaterThan(new Date(w.from).getTime());
    }
    // Pin the DAYS too, on the venue calendar. Both fixtures are noon UTC, which
    // is already the NEXT day in Auckland — so a browser-zone expansion produces
    // 15/16/17 here, and a bare "three windows, 09:00 each" assertion could not
    // tell the two apart.
    expect(windows!.map((w) => day(w.from))).toEqual([
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ]);
    expect(windows![0]!.from).toBe("2026-09-15T21:00:00.000Z");
    expect(windows![0]!.to).toBe("2026-09-16T06:00:00.000Z");
  });

  it("caps at two weeks when the schedule has no end date", () => {
    const windows = dailyHoursToWindows("10:00", "20:00", "2026-09-15T09:00:00.000Z", null, AKL);
    expect(windows!.length).toBe(14);
    expect(windows!.map((w) => day(w.from))).toEqual(
      Array.from({ length: 14 }, (_, i) => `2026-09-${String(15 + i).padStart(2, "0")}`),
    );
  });

  it("holds the venue wall clock across a DST boundary", () => {
    // Auckland springs forward on 27 Sep 2026 (a 23-hour day). Adding a fixed
    // 86_400_000 ms per day — which is what a UTC-stepped expansion does — walks
    // the window to 10:00 on the far side of it, and the organiser never typed
    // that. Nothing but consecutive days around the transition can see this.
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-26T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
      AKL,
    )!;
    expect(windows.map((w) => day(w.from))).toEqual([
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ]);
    for (const w of windows) {
      expect(at(w.from), w.from).toBe("09:00");
      expect(at(w.to), w.to).toBe("18:00");
    }
    // The gaps are the proof in raw milliseconds: 23 hours over the transition,
    // 24 after it.
    const gaps = windows
      .slice(1)
      .map((w, i) => (Date.parse(w.from) - Date.parse(windows[i]!.from)) / 3_600_000);
    expect(gaps).toEqual([23, 24]);
  });

  it("rejects inverted, equal and malformed hours", () => {
    expect(dailyHoursToWindows("18:00", "09:00", "2026-09-15T09:00:00.000Z", null, AKL)).toBeNull();
    expect(dailyHoursToWindows("09:00", "09:00", "2026-09-15T09:00:00.000Z", null, AKL)).toBeNull();
    expect(dailyHoursToWindows("9am", "6pm", "2026-09-15T09:00:00.000Z", null, AKL)).toBeNull();
    expect(dailyHoursToWindows("09:00", "18:00", "not-a-date", null, AKL)).toBeNull();
  });

  it("ignores an unparseable end date rather than refusing the whole expansion", () => {
    // The panel can hand over a blank-ish end; falling back to the two-week cap
    // keeps the auto pass working instead of silently clearing play hours.
    const windows = dailyHoursToWindows("09:00", "18:00", "2026-09-15T09:00:00.000Z", "nope", AKL);
    expect(windows!.length).toBe(14);
  });
});

describe("windowsToDailyHours", () => {
  it("round-trips a uniform daily pattern", () => {
    const windows = dailyHoursToWindows(
      "09:30",
      "17:45",
      "2026-09-15T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      AKL,
    )!;
    expect(windowsToDailyHours(windows, AKL)).toEqual({ from: "09:30", to: "17:45" });
  });

  it("reads the hours on the venue clock, not the reader's", () => {
    // The prefill has to agree with the expansion or the panel shows hours the
    // organiser never typed and re-saves them on the next submit.
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
      AKL,
    )!;
    expect(windowsToDailyHours(windows, AKL)).toEqual({ from: "09:00", to: "18:00" });
    // Same windows read in a zone that is not the venue's: still uniform, but
    // NOT the hours anyone typed. Guards the pair above against a
    // zone-insensitive implementation that would return 09:00 either way.
    expect(windowsToDailyHours(windows, "America/Los_Angeles")).not.toEqual({
      from: "09:00",
      to: "18:00",
    });
  });

  it("keeps reading a uniform pattern across a DST boundary", () => {
    // The same 23-hour day as above: the three windows are 23h and 24h apart in
    // absolute terms but all read 09:00–18:00 locally, and the panel must show
    // the hours rather than falling back to "custom windows".
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-26T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
      AKL,
    )!;
    expect(windowsToDailyHours(windows, AKL)).toEqual({ from: "09:00", to: "18:00" });
  });

  it("returns null for hand-built irregular windows (leave them alone)", () => {
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
      AKL,
    )!;
    const irregular = [...windows, { from: "2026-09-17T13:00:00.000Z", to: "2026-09-17T15:00:00.000Z" }];
    expect(windowsToDailyHours(irregular, AKL)).toBeNull();
    expect(windowsToDailyHours([], AKL)).toBeNull();
  });
});

describe("guards — the premise these assertions rest on", () => {
  it("runs in a process zone that disagrees with the venue zone", () => {
    // Every expectation above would also hold for a browser-zone implementation
    // if the machine happened to be in Auckland. It is not; fail loudly if that
    // ever changes rather than reporting a vacuous green.
    expect(PROCESS_TZ).not.toBe(AKL);
    expect(zonedDateInput("2026-09-15T12:00:00.000Z", PROCESS_TZ)).not.toBe("2026-09-16");
  });
});

// P7/F1: feedLabels() used to hand-build "Winner of R1 #2" — a second,
// hardcoded-English copy of the same vocabulary fixtures.home_slot_label
// already carries as {key,params}. It now builds the SAME shape.
describe("feedLabels", () => {
  const row = (over: Partial<FeedRow> & { id: string }): FeedRow => ({
    round_no: 1,
    seq_in_round: 1,
    winner_to_fixture: null,
    winner_to_slot: null,
    loser_to_fixture: null,
    loser_to_slot: null,
    ...over,
  });

  it("builds a SlotLabel — never a pre-rendered string — with the SOURCE fixture's numeric {round, seq}", () => {
    const rows = [
      row({ id: "semi", round_no: 1, seq_in_round: 2, winner_to_fixture: "final", winner_to_slot: 1 }),
      row({ id: "final" }),
    ];
    const labels = feedLabels(rows);
    expect(labels["final"]!.home).toEqual({ key: "slot.winner_match", params: { round: 1, seq: 2 } });
    // params are NUMBERS, never a rendered fragment like "R1·2" or "R1 #2".
    expect(typeof labels["final"]!.home!.params.round).toBe("number");
    expect(typeof labels["final"]!.home!.params.seq).toBe("number");
  });

  it("slot 1 -> home, slot 2 -> away; loser feed uses slot.loser_match", () => {
    const rows = [
      row({ id: "semi1", round_no: 1, seq_in_round: 1, loser_to_fixture: "bronze", loser_to_slot: 1 }),
      row({ id: "semi2", round_no: 1, seq_in_round: 2, loser_to_fixture: "bronze", loser_to_slot: 2 }),
      row({ id: "bronze" }),
    ];
    const labels = feedLabels(rows);
    expect(labels["bronze"]!.home).toEqual({ key: "slot.loser_match", params: { round: 1, seq: 1 } });
    expect(labels["bronze"]!.away).toEqual({ key: "slot.loser_match", params: { round: 1, seq: 2 } });
  });

  it("skips a feed pointing at a fixture outside the row set (defensive, same as before)", () => {
    const rows = [row({ id: "semi", winner_to_fixture: "not-in-set", winner_to_slot: 1 })];
    expect(feedLabels(rows)).toEqual({});
  });

  it("skips a row with no feed wiring at all", () => {
    expect(feedLabels([row({ id: "solo" })])).toEqual({});
  });

  // Schedule-board knockout round codes (2026-09-23): the board names a
  // feeder by its round code ("Winner of QF·3"), resolving {round, seq} inside
  // a stage. A cross-stage edge (`wireCrossFeeds`) carries the SOURCE stage's
  // coordinates, and the seat's own stage can hold a DIFFERENT fixture at the
  // same {round, seq} — so such an edge says which stage it came from.
  it("stamps the SOURCE stage onto a cross-stage edge, and only onto a cross-stage edge", () => {
    const rows = [
      row({ id: "ko-qf", stage_id: "ko", round_no: 1, seq_in_round: 3, winner_to_fixture: "ko-sf", winner_to_slot: 2 }),
      row({ id: "ko-sf", stage_id: "ko", round_no: 2, seq_in_round: 2 }),
      row({ id: "main-r1", stage_id: "main", round_no: 1, seq_in_round: 3, loser_to_fixture: "plate-r1", loser_to_slot: 1 }),
      row({ id: "plate-r1", stage_id: "plate", round_no: 1, seq_in_round: 1 }),
    ];
    const labels = feedLabels(rows);
    // Same stage: byte-identical to before — no `stage` param, no payload cost.
    expect(labels["ko-sf"]!.away).toEqual({ key: "slot.winner_match", params: { round: 1, seq: 3 } });
    // Cross stage: the source stage rides along.
    expect(labels["plate-r1"]!.home).toEqual({
      key: "slot.loser_match",
      params: { round: 1, seq: 3, stage: "main" },
    });
  });

  it("rows without stage_id (the public namer's per-stage rows) are unchanged", () => {
    const rows = [
      row({ id: "a", round_no: 1, seq_in_round: 1, winner_to_fixture: "b", winner_to_slot: 1 }),
      row({ id: "b", round_no: 2, seq_in_round: 1 }),
    ];
    expect(feedLabels(rows)["b"]!.home).toEqual({ key: "slot.winner_match", params: { round: 1, seq: 1 } });
  });
});

// The required anti-drift regression (F1 brief): the board card's OWN short
// code — schedule-board.tsx:271's consoleFixtures(), via matchRef() — and the
// feed label's {ext} substitution — feedLabels() + resolveSlotLabel(), the
// exact wiring cardTitle() uses on every real board render — must produce the
// SAME ref text for the SAME {round, seq}. Both sides call the REAL
// production functions (not a hand-computed "expected" string), so this goes
// red if EITHER re-hardcodes its own template independently of the other.
describe("anti-drift: board card ref code vs feed label {ext} (P7/F1, required)", () => {
  const boardFixture = (id: string, round_no: number, seq_in_round: number) => ({
    id,
    stage_id: "st-1",
    division_id: "d1",
    round_no,
    seq_in_round,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: null,
    venue: null,
    court_label: null,
    court_id: null,
    court_name: null,
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  });

  for (const locale of LOCALES) {
    it(`${locale}: consoleFixtures()'s .code and the fed slot's matchup embed the identical ref text`, () => {
      const lookup: SlotLabelLookup = (k, vars) => msgFor(locale, k, vars);

      // (a) the SOURCE fixture's own short-code chip, via the real
      // schedule-board.tsx:271 code path.
      const [sourceRow] = consoleFixtures([boardFixture("source", 2, 3)], { e1: "A", e2: "B" }, {}, lookup);
      const cardCode = sourceRow!.code;
      expect(cardCode).toBe(matchRef(2, 3, lookup)); // sanity: same fn schedule-board.tsx:271 calls

      // (b) a TARGET fixture fed by that source's winner, via the real
      // feedLabels() + cardTitle() path every board render uses.
      const rows: FeedRow[] = [
        { id: "source", round_no: 2, seq_in_round: 3, winner_to_fixture: "target", winner_to_slot: 1, loser_to_fixture: null, loser_to_slot: null },
        { id: "target", round_no: 3, seq_in_round: 1, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null },
      ];
      const feeds = feedLabels(rows);
      const targetFixture: BoardFixture = {
        ...boardFixture("target", 3, 1),
        home_entrant_id: null,
        away_entrant_id: null,
      };
      const matchup = cardTitle(targetFixture, {}, feeds, lookup);

      expect(matchup).toContain(cardCode);
    });
  }

  // Schedule-board knockout round codes (2026-09-23): the same invariant on
  // the CODED path. A knockout quarter-final's own AI-console/ghost code and
  // the "Winner of …" text on the semi it feeds must both say "QF·3" — the
  // board threads ONE round-code map into both, so they cannot disagree.
  for (const locale of LOCALES) {
    it(`${locale}: knockout — consoleFixtures()'s .code and the fed slot's matchup embed the identical CODED ref`, () => {
      const lookup: SlotLabelLookup = (k, vars) => msgFor(locale, k, vars);
      const qf = { ...boardFixture("qf3", 1, 3) };
      const sf: BoardFixture = { ...boardFixture("sf2", 2, 2), home_entrant_id: null, away_entrant_id: null };
      const others = [
        boardFixture("qf1", 1, 1),
        boardFixture("qf2", 1, 2),
        boardFixture("qf4", 1, 4),
        boardFixture("sf1", 2, 1),
        boardFixture("f", 3, 1),
      ];
      const board = [qf, sf, ...others];
      const codes = boardRoundCodes(board, [{ id: "st-1", kind: "knockout" }], lookup);
      const rows: FeedRow[] = board.map((f) => ({
        id: f.id,
        round_no: f.round_no,
        seq_in_round: f.seq_in_round,
        winner_to_fixture: f.id === "qf3" ? "sf2" : null,
        winner_to_slot: f.id === "qf3" ? 1 : null,
        loser_to_fixture: null,
        loser_to_slot: null,
      }));
      const feeds = withRoundCodeRefs(board, feedLabels(rows), codes);

      const byId = new Map(consoleFixtures(board, { e1: "A", e2: "B" }, feeds, lookup, codes).map((r) => [r.id, r]));
      const cardCode = byId.get("qf3")!.code;
      const qfCode = msgFor(locale, "bracket.roundShort.quarter");
      expect(cardCode).toBe(matchRef(1, 3, lookup, qfCode));
      expect(cardCode).not.toBe(matchRef(1, 3, lookup)); // the coded ref really differs from R1·3
      expect(cardTitle(sf, {}, feeds, lookup)).toContain(cardCode);
      expect(byId.get("sf2")!.matchup).toContain(cardCode);
    });
  }

  it("a league fixture's console code is untouched by the round-code map (R{round}·{seq})", () => {
    const lookup: SlotLabelLookup = (k, vars) => msgFor("en", k, vars);
    const board = [boardFixture("l1", 2, 3)];
    const codes = boardRoundCodes(board, [{ id: "st-1", kind: "league" }], lookup);
    expect(codes.size).toBe(0);
    expect(consoleFixtures(board, {}, {}, lookup, codes)[0]!.code).toBe("R2·3");
  });

  it("resolveSlotLabel's {ext} substitution for a feed label is the literal matchRef() output, not a re-derived copy", () => {
    const lookup: SlotLabelLookup = (k, vars) => msgFor("en", k, vars);
    const label = feedLabels([
      { id: "s", round_no: 4, seq_in_round: 2, winner_to_fixture: "t", winner_to_slot: 1, loser_to_fixture: null, loser_to_slot: null },
      { id: "t", round_no: 5, seq_in_round: 1, winner_to_fixture: null, winner_to_slot: null, loser_to_fixture: null, loser_to_slot: null },
    ])["t"]!.home!;
    expect(resolveSlotLabel(label, lookup, "schedule.tbd")).toBe(`Winner of ${matchRef(4, 2, lookup)}`);
  });
});
