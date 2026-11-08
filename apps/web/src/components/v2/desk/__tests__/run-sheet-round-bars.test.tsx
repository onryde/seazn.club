// Match Day E1 item 1 (owner 2026-11-01): a stage card groups its rows under a header bar PER ROUND ("Round 2 · 0 of 1 done · 21:10-21:50"),
// rows inside a round in time order with the untimed ones last, "No time yet" on the row instead of a "Not yet scheduled" GROUP, and no
// "Round N" label on the row. A knockout keeps its NAMED rounds in the same bar. Node env, no DOM (AGENTS.md class 2): what the bar says
// and where each row sits is read off the real `RunSheet` the stage card mounts (`embedded`, `stageId`), fed by `buildRunSheet`'s own
// blocks. Every expected sentence comes from the dictionaries; every sweep reports its count and zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StageKind } from "@seazn/engine/core";
import { stageActions, stageCounts } from "@/lib/stage-card/summaries";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { BRACKET_STAGE_KINDS, ROUND_SEQUENCE_STAGE_KINDS, buildRunSheet, isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { dayLabel } from "@/lib/day-label";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { poolLabelsInOrder } from "@/lib/pool-label";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const DICTS: Record<Locale, Dict> = { en: enUi, fr: frUi, es: esUi, nl: nlUi };
const UI = enUi as Record<string, string>;
const TZ = "UTC";
const DAY = "2026-09-05";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);

function fx(no: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: "s1",
    fixture_no: no,
    round_no: 1,
    seq_in_round: no,
    scheduled_at: `${DAY}T14:00:00.000Z`,
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

type Stage = { id: string; seq: number; kind: string; name: string };
const stage = (kind: string): Stage[] => [{ id: "s1", seq: 1, kind, name: "Stage" }];

function sheet(
  fixtures: RunSheetFixture[],
  stages: Stage[],
  o: { embedded?: boolean; locale?: Locale; filter?: RunSheetFilter; nowMs?: number; awaitingSettle?: string[]; pools?: { id: string; label: string }[] } = {},
): string {
  const locale = o.locale ?? "en";
  const nowMs = o.nowMs ?? NOW_MS;
  return renderToStaticMarkup(
    <DictProvider dict={DICTS[locale]} locale={locale}>
      <RunSheet
        blocks={buildRunSheet({ fixtures, stages, tz: TZ, nowMs })}
        stages={stages}
        tz={TZ}
        orgTz={TZ}
        nowMs={nowMs}
        matchMinutes={60}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter={o.filter ?? "all"}
        onFilter={() => {}}
        stageId={(o.embedded ?? true) ? "s1" : null}
        embedded={o.embedded ?? true}
        awaitingSettle={o.awaitingSettle}
        pools={o.pools}
      />
    </DictProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
/** The bars, in order, as the words a person reads. */
const bars = (html: string): string[] =>
  [...html.matchAll(/<header[^>]*data-testid="run-sheet-round-bar"[^>]*>([\s\S]*?)<\/header>/g)].map((m) => text(m[1]!).replace(/\s+·/g, " ·"));
/** Fixture numbers in the order their rows are drawn. */
const rowNos = (html: string): number[] => [...html.matchAll(/data-fixture-no="(\d+)"/g)].map((m) => Number(m[1]));
const done = (n: number, total: number, dict: Record<string, string> = UI) => dict[total === 1 ? "runsheet.round.done.one" : "runsheet.round.done.other"]!.replace("{done}", String(n)).replace("{total}", String(total));

describe("E1 item 1: a table stage's card groups its rows under a bar per round", () => {
  it("the empty case: a stage with no rows draws no bar and no row; a filter that keeps none says so in a line, with no bar", () => {
    expect(sheet([], stage("league"))).toBe("");
    const html = sheet([fx(1)], stage("league"), { filter: "unscheduled" });
    expect(bars(html)).toEqual([]);
    expect(html).toContain('data-testid="stage-run-sheet-empty"');
    expect(rowNos(html)).toEqual([]);
  });

  it("two rounds: a bar each, 'Round N · x of y done · day · time span', the rows under their own bar - and no 'Not yet scheduled' group, and no 'Round N' on a row", () => {
    const html = sheet(
      [
        fx(1, { round_no: 1, status: "decided", outcome: { kind: "win", winner: "e1" }, scheduled_at: `${DAY}T10:00:00.000Z` }),
        fx(2, { round_no: 1, scheduled_at: `${DAY}T10:40:00.000Z` }),
        fx(3, { round_no: 2, scheduled_at: `${DAY}T21:10:00.000Z` }),
      ],
      stage("league"),
    );
    expect(bars(html)).toEqual([
      `Round 1 · ${done(1, 2)} · ${dayLabel(DAY, "en")} · 10:00–10:40`,
      `Round 2 · ${done(0, 1)} · ${dayLabel(DAY, "en")} · 21:10`,
    ]);
    expect(rowNos(html)).toEqual([1, 2, 3]);
    expect(html, "the group is gone").not.toContain(UI["runsheet.unscheduled.title"]!);
    expect(html).not.toContain('data-run-sheet-block="unscheduled"');
    // "Round 2" is said ONCE - by the bar - never again on a row's meta line.
    expect(text(html).split("Round 2").length - 1, "Round 2 appears once").toBe(1);
    expect(html).not.toMatch(/<p[^>]*>[^<]*Round \d<\/p>/);
  });

  it("a round of untimed rows: the bar has no 'when'; each open row says 'No time yet'; an in-play row with no time is in its round, in play, and does NOT say 'No time yet'", () => {
    const html = sheet(
      [
        fx(1, { round_no: 3, scheduled_at: null }),
        fx(2, { round_no: 3, scheduled_at: null, status: "in_play" }),
        fx(3, { round_no: 3, scheduled_at: null, status: "decided", outcome: { kind: "win", winner: "e2" } }),
      ],
      stage("league"),
    );
    expect(bars(html)).toEqual([`Round 3 · ${done(1, 3)}`]);
    expect(html).not.toContain("data-run-sheet-round-span");
    expect(html).not.toContain("data-run-sheet-round-dates");
    // Only fixture 1 is a match nobody has timed: a RESULT with no time (3) says nothing of the kind, and a match being played (2) is not
    // waiting for a time at all - it shows its in-play state instead (the row's amber dot beside the time cell).
    expect(html.split(UI["runsheet.noTimeYet"]!).length - 1, "one row says No time yet (desktop line + phone line: 2)").toBe(2);
    const rowOf = (no: number) => html.slice(html.indexOf(`data-fixture-no="${no}"`), html.indexOf("</li>", html.indexOf(`data-fixture-no="${no}"`)));
    expect(rowOf(1)).toContain(UI["runsheet.noTimeYet"]!);
    expect(rowOf(2), "positive pair: the in-play row rendered, in its round").toContain("bg-amber-500");
    expect(rowOf(2), "an in-play match is not waiting for a time").not.toContain(UI["runsheet.noTimeYet"]!);
    expect(rowOf(3), "a played match with no time is a result, not 'No time yet'").not.toContain(UI["runsheet.noTimeYet"]!);
    expect(html, "in its round, not in a group").not.toContain('data-run-sheet-block="unscheduled"');
  });

  it("inside a round the rows run in time order and the untimed ones sit last (the draw gave them the other way round)", () => {
    const html = sheet(
      [
        fx(1, { scheduled_at: null, seq_in_round: 1 }),
        fx(2, { scheduled_at: `${DAY}T16:00:00.000Z`, seq_in_round: 2 }),
        fx(3, { scheduled_at: `${DAY}T15:00:00.000Z`, seq_in_round: 3 }),
      ],
      stage("league"),
    );
    expect(rowNos(html)).toEqual([3, 2, 1]);
    expect(bars(html)).toEqual([`Round 1 · ${done(0, 3)} · ${dayLabel(DAY, "en")} · 15:00–16:00`]);
  });

  it("a round spanning two days names both days and prints no one clock span", () => {
    const html = sheet([fx(1, { scheduled_at: `${DAY}T10:00:00.000Z` }), fx(2, { scheduled_at: "2026-09-06T10:00:00.000Z" })], stage("league"));
    expect(bars(html)).toEqual([`Round 1 · ${done(0, 2)} · ${dayLabel(DAY, "en")} – ${dayLabel("2026-09-06", "en")}`]);
  });

  it("rounds read in the order they are played; the NOW rule appears once, in the round it falls in", () => {
    const html = sheet(
      [
        fx(1, { round_no: 1, scheduled_at: `${DAY}T09:00:00.000Z` }),
        fx(2, { round_no: 1, scheduled_at: `${DAY}T15:00:00.000Z` }),
        fx(3, { round_no: 2, scheduled_at: `${DAY}T16:00:00.000Z` }),
      ],
      stage("league"),
    );
    expect(html.split('data-testid="run-sheet-now"').length - 1, "one NOW rule").toBe(1);
    // NOW (12:00) falls between fixture 1 (09:00) and fixture 2 (15:00), both of Round 1.
    expect(html.indexOf('data-testid="run-sheet-now"')).toBeGreaterThan(html.indexOf('data-fixture-no="1"'));
    expect(html.indexOf('data-testid="run-sheet-now"')).toBeLessThan(html.indexOf('data-fixture-no="2"'));
    // Nothing timed today: no rule at all.
    expect(sheet([fx(1, { scheduled_at: "2026-09-09T09:00:00.000Z" })], stage("league")).includes('data-testid="run-sheet-now"')).toBe(false);
    // Everything today is behind us: the rule closes the last round.
    const late = sheet([fx(1, { scheduled_at: `${DAY}T08:00:00.000Z` })], stage("league"));
    expect(late.indexOf('data-testid="run-sheet-now"')).toBeGreaterThan(late.indexOf('data-fixture-no="1"'));
  });

  it("every stage kind the engine declares, counted: a bracket kind keeps its NAMED rounds in the same bar, a round-sequence kind gets 'Round N', the ladder gets NO bar", () => {
    let bracket = 0;
    let table = 0;
    let flat = 0;
    for (const kind of StageKind.options) {
      const html = sheet([fx(1), fx(2, { round_no: 2 })], stage(kind));
      const b = bars(html);
      if (BRACKET_STAGE_KINDS.has(kind)) {
        expect(b.length, `${kind}: a bar per round`).toBeGreaterThan(0);
        expect(html, `${kind}: the bracket block`).toContain('data-run-sheet-block="bracket"');
        expect(b.every((line) => /^(Round \d|[A-Z])/.test(line)), `${kind}: named`).toBe(true);
        bracket++;
      } else if (ROUND_SEQUENCE_STAGE_KINDS.has(kind)) {
        expect(html, `${kind}: round sections`).toContain('data-run-sheet-block="rounds"');
        expect(b.map((line) => line.split(" · ")[0]), `${kind}: Round N`).toEqual(["Round 1", "Round 2"]);
        table++;
      } else {
        // The ladder stores each challenge as a round of its own: two challenges are two rounds in the data and ONE list on the card.
        expect(b, `${kind}: no bar at all`).toEqual([]);
        expect(html, `${kind}: a flat list`).toContain('data-run-sheet-block="flat"');
        expect(html, `${kind}: not the day/unscheduled groups`).not.toContain("data-run-sheet-day");
        expect(rowNos(html), `${kind}: both rows are there`).toEqual([1, 2]);
        expect(text(html), `${kind}: and neither says which round it is`).not.toMatch(/Round \d/);
        flat++;
      }
      expect(b.every((line) => line.includes(" of ") || line.includes(" de ")), `${kind}: every bar says how many are done`).toBe(true);
    }
    expect(table, "round-sequence kinds swept").toBe(ROUND_SEQUENCE_STAGE_KINDS.size);
    expect(bracket, "bracket kinds swept").toBe(BRACKET_STAGE_KINDS.size);
    expect(flat, "the ladder swept").toBe(1);
    expect(table + bracket + flat).toBe(StageKind.options.length);
  });

  it("a ladder's flat list runs in time order, the untimed challenge last, with 'No time yet' on it - and its challenges' rounds never become bars", () => {
    const html = sheet(
      [
        fx(1, { round_no: 1, scheduled_at: null }),
        fx(2, { round_no: 2, scheduled_at: `${DAY}T16:00:00.000Z` }),
        fx(3, { round_no: 3, scheduled_at: `${DAY}T09:00:00.000Z`, status: "decided", outcome: { kind: "win", winner: "e1" } }),
      ],
      stage("ladder"),
    );
    expect(bars(html)).toEqual([]);
    expect(rowNos(html)).toEqual([3, 2, 1]);
    const rowOf = (no: number) => html.slice(html.indexOf(`data-fixture-no="${no}"`), html.indexOf("</li>", html.indexOf(`data-fixture-no="${no}"`)));
    expect(rowOf(1)).toContain(UI["runsheet.noTimeYet"]!);
    expect(rowOf(2)).not.toContain(UI["runsheet.noTimeYet"]!);
    // The empty case, and a filter that keeps none: no list, no bar.
    expect(sheet([], stage("ladder"))).toBe("");
    expect(rowNos(sheet([fx(1)], stage("ladder"), { filter: "unscheduled" }))).toEqual([]);
  });

  it("a knockout's bar and its rows: the named round leads, the row drops its own 'Round N', an untimed row says No time yet", () => {
    const html = sheet([fx(1, { scheduled_at: null }), fx(2, { scheduled_at: null })], stage("knockout"));
    expect(bars(html)[0]).toMatch(/^Final · /);
    expect(html).toContain(UI["runsheet.noTimeYet"]!);
    expect(text(html)).not.toContain("Round 1");
  });

  // Match Day E1 fix round 3 (supersedes fix round 1's m2 and fix round 2's section order): pools play at the same time on separate courts, so
  // no order of per-pool sections is also time order. A group stage's card has ONE bar per round across its pools ("Round 1 · 3 of 4 done"),
  // the rows of a round in time order (a tie to the page's first pool), and each row says which pool it is in a chip.
  describe("a group stage: one bar per round across its pools, a pool chip on every row", () => {
    const PUBLIC: Record<Locale, Record<string, string>> = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic };
    const poolRows = [{ id: "pB", key: "B", name: "Pool B" }, { id: "pA", key: "A", name: "Pool A" }];
    const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
    const WIN = { kind: "win", winner: "e1" };
    // Pools of four on separate courts, playing at the same time: each pool has two matches a round, at the same two kickoffs (Group A on
    // Court 1 = fixtures 1-6, Group B on Court 2 = fixtures 11-16). `decided` marks some of them played.
    const SLOTS = [["09:00", "09:35"], ["10:10", "10:45"], ["11:20", "11:55"]] as const;
    const fours = (decided: readonly number[] = []): RunSheetFixture[] =>
      ([["pA", "Court 1", 0], ["pB", "Court 2", 10]] as const).flatMap(([pool, court, base]) =>
        SLOTS.flatMap((pair, r) =>
          pair.map((hhmm, k) => {
            const no = base + r * 2 + k + 1;
            return fx(no, { pool_id: pool, court_name: court, round_no: r + 1, scheduled_at: at(hhmm), ...(decided.includes(no) ? { status: "decided", outcome: WIN } : {}) });
          }),
        ),
      );
    const poolOf = (no: number): "pA" | "pB" => (no > 10 ? "pB" : "pA");
    const pubLabel = (locale: Locale, key: string) => PUBLIC[locale]["table.poolLabel"]!.replace("{key}", key);
    const labelOfPool = (locale: Locale, id: string) => pubLabel(locale, id === "pA" ? "A" : "B");
    const poolsFor = (locale: Locale) => poolLabelsInOrder(PUBLIC[locale] as never, poolRows);
    /** The chip text on one row, or null when the row has none. */
    const chipOf = (html: string, no: number): string | null => {
      const start = html.indexOf(`data-fixture-no="${no}"`);
      const li = html.slice(start, html.indexOf("</li>", start));
      return /data-testid="run-sheet-pool-chip"[^>]*>([^<]*)</.exec(li)?.[1] ?? null;
    };
    /** The page in reading order: each row's fixture number, with the NOW rule as "NOW" where it sits. */
    const reading = (html: string): (number | "NOW")[] =>
      [...html.matchAll(/data-fixture-no="(\d+)"|data-testid="run-sheet-now"/g)].map((m) => (m[1] === undefined ? "NOW" : Number(m[1])));
    const timeOf = (rows: RunSheetFixture[], no: number): number => Date.parse(rows.find((f) => f.fixture_no === no)!.scheduled_at!);

    it("every locale: THREE bars, 'Round N' with no pool word on them, each counting both pools' matches of its round", () => {
      const decided = [1, 2, 11]; // Round 1: three of the four are played; Rounds 2 and 3: none
      let checked = 0;
      for (const locale of LOCALES) {
        const ui = DICTS[locale] as Record<string, string>;
        const rows = fours(decided);
        const html = sheet(rows, stage("group"), { locale, pools: poolsFor(locale) });
        const b = bars(html);
        expect(b.length, `${locale}: a bar per round, not per pool per round`).toBe(3);
        expect(b.map((line) => line.split(" · ")[0]), `${locale}: the round's own word`).toEqual([1, 2, 3].map((n) => ui["schedule.round"]!.replace("{n}", String(n))));
        for (const label of [pubLabel(locale, "A"), pubLabel(locale, "B")]) expect(b.join("\n"), `${locale}: no pool word on a bar`).not.toContain(label);
        // Each bar counts its round's real matches of EVERY pool - read off the rows themselves.
        const facts = b.map((line) => line.split(" · ")[1]);
        const expected = [1, 2, 3].map((r) => {
          const inRound = rows.filter((f) => f.round_no === r);
          return done(inRound.filter((f) => f.status === "decided").length, inRound.length, ui);
        });
        expect(facts, `${locale}: each round's own count`).toEqual(expected);
        expect(rowNos(html).length, `${locale}: every row is drawn`).toBe(rows.length);
        checked++;
      }
      expect(checked).toBe(LOCALES.length);
    });

    it("the bars add up to the stage's counts, and the NOW rule appears once", () => {
      const rows = fours([1, 2, 11, 13]);
      const html = sheet(rows, stage("group"), { pools: poolsFor("en") });
      const parsed = bars(html).map((line) => /(\d+) of (\d+) done/.exec(line)!);
      expect(parsed.length, "anti-vacuity: the bars were read").toBe(3);
      const sum = parsed.reduce((a, m) => ({ done: a.done + Number(m[1]), total: a.total + Number(m[2]) }), { done: 0, total: 0 });
      expect(sum).toEqual({ done: stageCounts(rows).played, total: rows.length });
      expect(sum.done, "premise: some are played, some are not").toBeGreaterThan(0);
      expect(sum.done).toBeLessThan(sum.total);
      expect(html.split('data-testid="run-sheet-now"').length - 1, "one NOW rule for the card").toBe(1);
    });

    it("every row carries ITS pool's chip, in every locale's own words (the pool of the row, not a neighbour's)", () => {
      let checked = 0;
      for (const locale of LOCALES) {
        const rows = fours();
        const html = sheet(rows, stage("group"), { locale, pools: poolsFor(locale) });
        for (const f of rows) {
          expect(chipOf(html, f.fixture_no), `${locale}: fixture ${f.fixture_no}`).toBe(labelOfPool(locale, poolOf(f.fixture_no)));
          checked++;
        }
      }
      expect(checked, "every row of every locale").toBe(LOCALES.length * 12);
      expect(new Set(fours().map((f) => poolOf(f.fixture_no))).size, "premise: both pools' answers are reached").toBe(2);
    });

    it("the chip is a label drawn on the row in the DOM at every width, and shrinks inside its row rather than widening it", () => {
      const html = sheet(fours(), stage("group"), { pools: poolsFor("en") });
      const chip = /<span[^>]*data-testid="run-sheet-pool-chip"[^>]*>/.exec(html)?.[0] ?? "";
      expect(chip, "positive pair: the chip rendered").not.toBe("");
      expect(chip, "house chip token").toMatch(/\bchip\b/);
      expect(chip, "bounded and truncating, so a long label cannot widen a 320 row").toMatch(/\bmax-w-\[10rem\]/);
      expect(chip).toMatch(/\btruncate\b/);
      expect(chip, "not hidden at any width").not.toMatch(/\bhidden\b/);
      expect(chip, "not a control: no link, no button").not.toMatch(/^<(a|button)\b/);
    });

    // THE CASE THE RULING IS FOR. The old per-pool bars read A R1 (09:00, 09:35) and then B R1 (09:00, 09:35), so a NOW at 09:20 could not be
    // both after B's 09:00 and before A's 09:35. One round, rows in time order: it can. Expected positions are read off the rows' own times.
    it("pools on separate courts at the same time: the NOW line at 09:20 sits after BOTH 09:00 rows and before BOTH 09:35 rows", () => {
      const rows = fours();
      const now = Date.parse(at("09:20"));
      const html = sheet(rows, stage("group"), { pools: poolsFor("en"), nowMs: now });
      const seq = reading(html);
      const nowAt = seq.indexOf("NOW");
      expect(seq.filter((x) => x === "NOW").length, "exactly one NOW line").toBe(1);
      const before = seq.slice(0, nowAt) as number[];
      expect(before.length, "premise: rows are behind the clock").toBeGreaterThan(0);
      for (const no of before) expect(timeOf(rows, no), `row ${no} above the line has started`).toBeLessThan(now);
      for (const no of seq.slice(nowAt + 1) as number[]) expect(timeOf(rows, no), `row ${no} below the line is still to come`).toBeGreaterThan(now);
      expect(seq.slice(0, 5), "A 09:00, B 09:00, then the line, then A 09:35, B 09:35").toEqual([1, 11, "NOW", 2, 12]);
      expect(seq.length, "anti-vacuity: twelve rows and the line").toBe(13);
      // The pools listed the other way round: the times still lead, and only the tie moves.
      const flipped = reading(sheet(rows, stage("group"), { pools: [...poolsFor("en")].reverse(), nowMs: now }));
      expect(flipped.slice(0, 5)).toEqual([11, 1, "NOW", 12, 2]);
    });

    it("the NOW line follows the clock through the rounds: 10:30 sits between Round 2's 10:10 rows and its 10:45 rows; after 12:00 it closes the card", () => {
      const rows = fours();
      const mid = reading(sheet(rows, stage("group"), { pools: poolsFor("en"), nowMs: Date.parse(at("10:30")) }));
      const nowAt = mid.indexOf("NOW");
      const idsBefore = mid.slice(0, nowAt) as number[];
      const idsAfter = mid.slice(nowAt + 1) as number[];
      expect(idsBefore.length + idsAfter.length, "anti-vacuity: all twelve rows read").toBe(12);
      for (const no of idsBefore) expect(timeOf(rows, no)).toBeLessThan(Date.parse(at("10:30")));
      for (const no of idsAfter) expect(timeOf(rows, no)).toBeGreaterThan(Date.parse(at("10:30")));
      expect(new Set(idsBefore.slice(4)), "after Round 1's four rows come Round 2's two 10:10 rows").toEqual(new Set([3, 13]));
      const late = reading(sheet(rows, stage("group"), { pools: poolsFor("en"), nowMs: Date.parse(at("12:30")) }));
      expect(late.indexOf("NOW"), "nothing is still to come: the line closes the day").toBe(late.length - 1);
    });

    // ACCEPTED BEHAVIOUR, NOT A GOAL. The card reads round by round, so when Group A's Round 2 starts before Group B's Round 1 has finished
    // (B started a match late), a Round 2 row that has already started reads BELOW the NOW line, under the Round 2 bar. The ruling accepts
    // it (E1 fix round 3): one bar per round across pools is the price of rows that read in time order where it matters, inside a round.
    it("ACCEPTED RESIDUAL: Group A's Round 2 starts before Group B's Round 1 ends - the started Round 2 row reads below the NOW line", () => {
      const rows = [
        fx(1, { pool_id: "pA", round_no: 1, scheduled_at: at("09:00") }),
        fx(2, { pool_id: "pA", round_no: 1, scheduled_at: at("09:35") }),
        fx(3, { pool_id: "pA", round_no: 2, scheduled_at: at("09:40") }), // A is quick: Round 2 starts at 09:40
        fx(11, { pool_id: "pB", round_no: 1, scheduled_at: at("09:00") }),
        fx(12, { pool_id: "pB", round_no: 1, scheduled_at: at("09:50") }), // B's second Round 1 match starts late
        fx(13, { pool_id: "pB", round_no: 2, scheduled_at: at("10:20") }),
      ];
      const now = Date.parse(at("09:45"));
      const seq = reading(sheet(rows, stage("group"), { pools: poolsFor("en"), nowMs: now }));
      expect(seq, "Round 1 in time order, the line above B's 09:50, then Round 2").toEqual([1, 11, 2, "NOW", 12, 3, 13]);
      expect(timeOf(rows, 3), "premise: row 3 has already started").toBeLessThan(now);
      expect(seq.indexOf(3), "and still reads below the line - the accepted cost of one bar per round").toBeGreaterThan(seq.indexOf("NOW"));
    });

    it("a pool the panel was not told about: its rows have no chip, but they are still in the round's one bar - never a bar of their own", () => {
      const rows = fours();
      const html = sheet(rows, stage("group"), { pools: poolLabelsInOrder(enPublic as never, [poolRows[1]!]) }); // only pool A is named
      expect(bars(html).length, "still three bars").toBe(3);
      expect(chipOf(html, 1), "the named pool's row has its chip").toBe("Group A");
      expect(chipOf(html, 11), "the unnamed pool's row has none").toBeNull();
      expect(rowNos(html).length, "and every row is still drawn").toBe(12);
    });

    it("a league (no pools) is unchanged: 'Round N' bars, no chip on any row, whether or not pools are handed over", () => {
      const html = sheet([fx(1), fx(2, { round_no: 2 })], stage("league"), { pools: poolLabelsInOrder(enPublic as never, poolRows) });
      expect(bars(html).map((line) => line.split(" · ")[0])).toEqual(["Round 1", "Round 2"]);
      expect(html).not.toContain("run-sheet-pool-chip");
      expect(rowNos(html).length, "positive pair: the rows rendered").toBe(2);
    });
  });

  // Match Day E1 fix round 1 (I1): the bars add up to the stage card's own counts. The card's Complete button reads `stageCounts` over the
  // stage's fixtures (and the page's awaiting-settle ids); a bar that counted "played" its own way said "1 of 2" on a stage Complete was
  // already enabled for. Driven through the real RunSheet, the real `stageCounts` and the real `stageActions`.
  describe("the bars add up to the stage's own counts (the shared count)", () => {
    const AWARD = { kind: "award", winner: "e1", loser: "e2", reason: "walkover" };
    const WIN = { kind: "win", winner: "e1" };
    const BYE_AWARD = { kind: "award", winner: "e1", loser: null, reason: "bye" };
    const parse = (line: string): { done: number; total: number } => {
      // W4 B1b Q1: a round with no line that counts says it is a bye, never "0 of 0" - nothing done, nothing to do.
      const facts = line.split(" · ")[1];
      for (const key of ["runsheet.round.byes.one", "runsheet.round.byes.other"]) {
        if (facts === UI[key]!.replace("{count}", String(facts?.match(/\d+/)?.[0] ?? ""))) return { done: 0, total: 0 };
      }
      for (const key of ["runsheet.round.done.one", "runsheet.round.done.other"]) {
        const rx = new RegExp(UI[key]!.replace("{done}", "(\\d+)").replace("{total}", "(\\d+)"));
        const m = rx.exec(line);
        if (m) return { done: Number(m[1]), total: Number(m[2]) };
      }
      throw new Error(`no done fact in "${line}"`);
    };
    type Case = { what: string; rows: RunSheetFixture[]; held?: string[]; complete: boolean };
    const CASES: Case[] = [
      {
        what: "a walkover and a cancellation settle their round: nothing is open, Complete is enabled",
        rows: [fx(1, { status: "forfeited", outcome: AWARD }), fx(2, { status: "cancelled" }), fx(3, { round_no: 2, status: "decided", outcome: WIN })],
        complete: true,
      },
      {
        what: "an abandonment awaiting its settle is open: the bar does not count it and Complete is disabled",
        rows: [fx(1, { status: "abandoned" }), fx(2, { status: "decided", outcome: WIN })],
        held: ["f1"],
        complete: false,
      },
      {
        what: "the same abandonment once settled (no longer awaiting): done, and Complete is enabled",
        rows: [fx(1, { status: "abandoned" }), fx(2, { status: "decided", outcome: WIN })],
        held: [],
        complete: true,
      },
      {
        what: "an in-play match and a held decision keep their rounds open",
        rows: [fx(1, { status: "in_play" }), fx(2, { round_no: 2, status: "needs_decision" }), fx(3, { round_no: 3, status: "decided", outcome: WIN })],
        complete: false,
      },
      {
        what: "a bye is no match: it adds to neither side of any bar, and does not hold Complete shut",
        rows: [fx(1, { status: "decided", outcome: WIN }), fx(2, { round_no: 2, away_entrant_id: null, status: "forfeited", outcome: BYE_AWARD })],
        complete: true,
      },
    ];

    it.each(["swiss", "league", "group", "americano"] as const)("%s: every case, the bars summed equal stageCounts, and Complete is enabled exactly when the bars are all full", (kind) => {
      let checked = 0;
      let enabled = 0;
      for (const c of CASES) {
        const held = new Set(c.held ?? []);
        const html = sheet(c.rows, stage(kind), { awaitingSettle: c.held });
        const sum = bars(html).map(parse).reduce((acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }), { done: 0, total: 0 });
        const real = c.rows.filter((r) => !isBye(r));
        const counts = stageCounts(c.rows, held);
        const realCounts = stageCounts(real, held);
        expect(sum.done, `${kind}/${c.what}: done`).toBe(realCounts.played);
        expect(sum.total, `${kind}/${c.what}: total`).toBe(real.length);
        // What the bars leave open is exactly what the card's counts line leaves open - byes, which a card settles, never open anything.
        expect(sum.total - sum.done, `${kind}/${c.what}: open`).toBe(counts.inPlay + counts.unplayed);
        const complete = [stageActions({ status: "active", ...counts, hasFixtures: true, adhoc: true, pairNext: false, canUnpair: false })]
          .flatMap((a) => [a.primary, ...a.secondary])
          .find((b) => b?.action === "complete");
        expect(complete?.enabled, `${kind}/${c.what}: Complete`).toBe(c.complete);
        expect(sum.done === sum.total, `${kind}/${c.what}: bars full <=> Complete enabled`).toBe(c.complete);
        if (c.complete) enabled++;
        checked++;
      }
      expect(checked, "every case checked").toBe(CASES.length);
      expect(enabled, "both Complete states are reached").toBeGreaterThan(0);
      expect(enabled).toBeLessThan(CASES.length);
    });
  });

  it("all four locales: the done fact is the locale's own sentence (plural by the total), the round is its own word", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = DICTS[locale] as Record<string, string>;
      const html = sheet([fx(1, { round_no: 2 }), fx(2, { round_no: 2 })], stage("league"), { locale });
      const bar = bars(html)[0]!;
      expect(bar, `${locale}: the done fact`).toContain(done(0, 2, dict));
      expect(bar, `${locale}: the round word`).toContain(dict["schedule.round"]!.replace("{n}", "2"));
      checked++;
    }
    expect(checked, "every locale").toBe(LOCALES.length);
    expect(LOCALES.length).toBe(4);
  });

  it("on a phone the facts take their own line and no dot is stranded at the start of it; from md they sit beside the name, dot first", () => {
    const html = sheet([fx(1)], stage("league"));
    const bar = /<header[^>]*data-testid="run-sheet-round-bar"[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    expect(bar, "positive pair: the bar rendered").toContain("Round 1");
    const facts = /<span class="([^"]*)">(<span class="([^"]*)">[^<]*<\/span>)/.exec(bar);
    expect(facts, "the facts span leads with the dot span").not.toBeNull();
    expect(facts![1], "facts: their own line below md").toMatch(/\bmax-md:basis-full\b/);
    expect(facts![3], "the dot: hidden below md, shown from md").toMatch(/\bmax-md:hidden\b/);
    expect(text(facts![2]!).trim(), "the dot is a middle dot").toBe("\u00b7");
  });

  it("the bar's heading reads as ONE sentence by its raw text (what a screen reader and a locator see): the name, a space, then the facts", () => {
    // `bars()` above turns every tag into a space, so a name and a fact that touch in the markup ("Final· 0 of 1 done") read as
    // separated there. A locator's `^Final(\s|$)` and a screen reader work from the text WITHOUT that padding: the space must be real.
    let checked = 0;
    for (const [kind, name] of [["league", "Round 1"], ["knockout", "Final"]] as const) {
      const html = sheet([fx(1)], stage(kind));
      const bar = /<header[^>]*data-testid="run-sheet-round-bar"[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
      const raw = bar.replace(/<[^>]*>/g, "");
      expect(raw.startsWith(name), `${kind}: the bar leads with the round's name (positive pair)`).toBe(true);
      expect(raw.slice(name.length), `${kind}: whitespace follows the name`).toMatch(/^\s+\S/);
      expect(raw, `${kind}: the name and the dot never touch`).not.toMatch(new RegExp(`${name}\u00b7`));
      checked++;
    }
    expect(checked, "kinds swept").toBe(2);
  });

  it("the division-wide sheet (not embedded) is untouched: its day headings and its 'Not yet scheduled' group are still there", () => {
    const html = sheet([fx(1), fx(2, { scheduled_at: null })], stage("league"), { embedded: false });
    expect(html).toContain("data-run-sheet-day");
    expect(html).toContain('data-run-sheet-block="unscheduled"');
    expect(html).not.toContain('data-run-sheet-block="rounds"');
  });
});

// W4 B1b fix round 1 (Q1, controller ruling): a knockout round's bar NEVER reads "0 of 0". A round with no line that counts - a
// final settled as a bye (its dead seat's feeder handed on nobody), a round of day-one setup byes still waiting on the confirm -
// says it is a bye ("Bye", "2 byes") in the reader's language instead. A final waiting on a dead seat whose feeder's winner
// withdrew (`awaits_walkover`, the server's flag) is owed its walkover and reads "0 of 1". Every sentence from the dictionaries.
describe("a knockout round with no line that counts says it is a bye, never '0 of 0' (W4 B1b Q1)", () => {
  const BYE_LABEL = { key: "bracket.slot.bye", params: {} };
  const SEED = { key: "slot.rank", params: { rank: 1 } };
  const FED = { key: "slot.winner_match", params: { round: 1, seq: 1 } };
  const byes = (count: number, dict: Record<string, string> = UI) =>
    dict[count === 1 ? "runsheet.round.byes.one" : "runsheet.round.byes.other"]!.replace("{count}", String(count));
  const KO = stage("knockout");

  it("the empty case first: a knockout's final with two seats waiting reads '0 of 1', no bye word", () => {
    const html = sheet([fx(1, { home_entrant_id: null, away_entrant_id: null, home_slot_label: FED, away_slot_label: FED, scheduled_at: null })], KO);
    expect(bars(html)).toEqual([`Final · ${done(0, 1)}`]);
  });

  it("every locale: a final settled as a bye reads 'Bye'; a final awaiting its walkover reads '0 of 1'; neither reads '0 of 0'", () => {
    const awardedBye = fx(1, { away_entrant_id: null, away_slot_label: BYE_LABEL, status: "forfeited", scheduled_at: null, outcome: { kind: "award", winner: "e1", loser: null, reason: "bye" } });
    const awaitingWalkover = fx(1, { home_entrant_id: null, away_entrant_id: null, home_slot_label: BYE_LABEL, away_slot_label: FED, scheduled_at: null, awaits_walkover: true });
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = DICTS[locale] as Record<string, string>;
      expect(typeof dict["runsheet.round.byes.one"] === "string" && typeof dict["runsheet.round.byes.other"] === "string", `${locale}: the bye words exist`).toBe(true);
      const bye = bars(sheet([awardedBye], KO, { locale }));
      expect(bye.length, `${locale}: one bar`).toBe(1);
      expect(bye[0]!.split(" · ")[1], `${locale}: the settled bye says it is a bye`).toBe(byes(1, dict));
      expect(bye[0], `${locale}: never 0 of 0`).not.toContain(done(0, 0, dict));
      const owed = bars(sheet([awaitingWalkover], KO, { locale }));
      expect(owed[0]!.split(" · ")[1], `${locale}: the walkover is owed`).toBe(done(0, 1, dict));
      checked++;
    }
    expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
  });

  it("a round of two setup byes still waiting on the confirm says '2 byes'; beside one real line it counts the line alone", () => {
    const waitingBye = (no: number) =>
      fx(no, { home_entrant_id: null, away_entrant_id: null, home_slot_label: SEED, away_slot_label: BYE_LABEL, scheduled_at: null, seq_in_round: no });
    expect(bars(sheet([waitingBye(1), waitingBye(2)], KO)).map((b) => b.split(" · ")[1]), "two byes").toEqual([byes(2)]);
    const real = fx(3, { scheduled_at: null, seq_in_round: 3 });
    expect(bars(sheet([waitingBye(1), real], KO)).map((b) => b.split(" · ")[1]), "the bye beside a match: 0 of 1").toEqual([done(0, 1)]);
  });
});
