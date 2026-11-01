// W3 Task 10 — what the desk SAYS after "Add late player" (spec 2026-10-31-format-matrix-w3-swiss-design.md §4,
// ruling 250; X-SW-12/13/14 UI half), and the two pending-latecomer counts the rail shows.
//
// The notice table: one row per case the server returns (`LateEntryResult`, Task 9) plus the two counts. Every
// expected sentence is the approved English copy typed out here (brief Task 10 "Copy", with the controller's carries:
// m13 "reprint the round's sheets", I3 "name the entrants whose match changed, nobody is notified", m11 "a (b) board in
// an opened online round owes an invite") — never read off the function under test. Rendered through the REAL English
// catalog and the REAL runtime: a stub catalog on both ends would prove the stub.
//
// Single-sport by nature: the notice reads a result's case, round and ids — no sport field reaches it. The counts read
// seats and stamps, likewise.
import { describe, expect, it } from "vitest";
import {
  LATE_ENTRY_MESSAGE_KEYS,
  LATE_ENTRY_PLURAL_KEYS,
  lateEntryNotice,
  lateEntryNoticeText,
  swissLatecomerCounts,
  swissLatecomerLines,
  type LateEntryNoticeLine,
} from "@/lib/swiss-late-entry-notice";
import type { LateEntryResult } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";

const enI18n = {
  t: (key: string, vars?: Record<string, string | number>) => tRuntime(en, key, vars),
  plural: (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(en, key, count, "en", vars),
};

const STAGE = "stage-1";
const ELIF = "e-elif";
const ANA = "e-ana";
const BEN = "e-ben";
const CAI = "e-cai";
const NAMES: Record<string, string> = { [ELIF]: "Elif", [ANA]: "Ana", [BEN]: "Ben", [CAI]: "Cai" };

const result = (o: Partial<LateEntryResult> & Pick<LateEntryResult, "case" | "round">): LateEntryResult => ({
  entrant_id: ELIF,
  stage_id: STAGE,
  ...o,
});

type Rendered = { text: string; tone: LateEntryNoticeLine["tone"] };
const render = (lines: readonly LateEntryNoticeLine[]): Rendered[] =>
  lines.map((l) => ({ text: lateEntryNoticeText(l, enI18n), tone: l.tone }));

describe("swiss late-entry notice", () => {
  // The table. `expected` is the whole notice, line by line, with each line's tone: "done" says what happened,
  // "todo" is something the organiser still has to do.
  const TABLE: {
    name: string;
    results: LateEntryResult[];
    onlineRoundOpen?: (stageId: string, round: number) => boolean;
    expected: Rendered[];
  }[] = [
    {
      name: "(a) re-paired: two entrants' matches changed — named, nobody notified, printed sheets owed again",
      results: [result({ case: "a", round: 2, repaired: { changed_entrant_ids: [CAI, ANA] } })],
      expected: [
        { text: "Round 2 re-paired with Elif: 2 entrants' matches changed.", tone: "done" },
        { text: "They are not notified. Tell Ana and Cai.", tone: "todo" },
        { text: "If you printed scorer sheets for round 2, print them again.", tone: "todo" },
      ],
    },
    {
      name: "(a) re-paired: ONE entrant's match changed (the old bye holder now plays the newcomer) — singular copy",
      results: [result({ case: "a", round: 1, repaired: { changed_entrant_ids: [ANA] } })],
      expected: [
        { text: "Round 1 re-paired with Elif: 1 entrant's match changed.", tone: "done" },
        { text: "They are not notified. Tell Ana.", tone: "todo" },
        { text: "If you printed scorer sheets for round 1, print them again.", tone: "todo" },
      ],
    },
    {
      name: "(a) re-paired, nobody else moved (the newcomer took the bye) — no one to tell, no sheet to reprint",
      results: [result({ case: "a", round: 1, repaired: { changed_entrant_ids: [] } })],
      expected: [{ text: "Round 1 re-paired with Elif. No other match changed.", tone: "done" }],
    },
    {
      name: "(a) odd field went even and the new match found no free slot — unscheduled, flagged",
      results: [
        result({
          case: "a",
          round: 2,
          repaired: { changed_entrant_ids: [BEN] },
          new_board: { fixture_id: "f-new", scheduled: false },
        }),
      ],
      expected: [
        { text: "Round 2 re-paired with Elif: 1 entrant's match changed.", tone: "done" },
        { text: "They are not notified. Tell Ben.", tone: "todo" },
        { text: "If you printed scorer sheets for round 2, print them again.", tone: "todo" },
        { text: "1 new match is unscheduled.", tone: "todo" },
      ],
    },
    {
      name: "(a) the new match took the round's next free slot — nothing unscheduled to flag",
      results: [
        result({
          case: "a",
          round: 2,
          repaired: { changed_entrant_ids: [BEN] },
          new_board: { fixture_id: "f-new", scheduled: true },
        }),
      ],
      expected: [
        { text: "Round 2 re-paired with Elif: 1 entrant's match changed.", tone: "done" },
        { text: "They are not notified. Tell Ben.", tone: "todo" },
        { text: "If you printed scorer sheets for round 2, print them again.", tone: "todo" },
      ],
    },
    {
      name: "(b) took the bye: the newcomer plays the bye holder on a scheduled match",
      results: [
        result({ case: "b", round: 3, bye_holder_id: ANA, new_board: { fixture_id: "f-b", scheduled: true } }),
      ],
      expected: [{ text: "Elif plays Ana, who had the bye in round 3.", tone: "done" }],
    },
    {
      name: "(b) took the bye, no free slot — the new match is unscheduled",
      results: [
        result({ case: "b", round: 3, bye_holder_id: ANA, new_board: { fixture_id: "f-b", scheduled: false } }),
      ],
      expected: [
        { text: "Elif plays Ana, who had the bye in round 3.", tone: "done" },
        { text: "1 new match is unscheduled.", tone: "todo" },
      ],
    },
    {
      name: "(b) in a round already opened online (T9 m11): the new game has no invite yet",
      results: [
        result({ case: "b", round: 3, bye_holder_id: ANA, new_board: { fixture_id: "f-b", scheduled: true } }),
      ],
      onlineRoundOpen: (stageId, round) => stageId === STAGE && round === 3,
      expected: [
        { text: "Elif plays Ana, who had the bye in round 3.", tone: "done" },
        { text: "Round 3 is already open online. Invite Elif and Ana from the round's run sheet.", tone: "todo" },
      ],
    },
    {
      name: "(c) next round: the current round is untouched",
      results: [result({ case: "c", round: 4 })],
      expected: [{ text: "Elif joins from round 4.", tone: "done" }],
    },
    {
      name: "a batch (CSV): each created entrant's notice, in the order the server created them",
      results: [
        result({ case: "a", round: 1, repaired: { changed_entrant_ids: [] } }),
        result({ entrant_id: BEN, case: "c", round: 2 }),
      ],
      expected: [
        { text: "Round 1 re-paired with Elif. No other match changed.", tone: "done" },
        { text: "Ben joins from round 2.", tone: "done" },
      ],
    },
    {
      name: "a batch re-pairing the same round twice asks for the reprint ONCE",
      results: [
        result({ case: "a", round: 1, repaired: { changed_entrant_ids: [ANA] } }),
        result({ entrant_id: CAI, case: "a", round: 1, repaired: { changed_entrant_ids: [BEN, ELIF] } }),
      ],
      expected: [
        { text: "Round 1 re-paired with Elif: 1 entrant's match changed.", tone: "done" },
        { text: "They are not notified. Tell Ana.", tone: "todo" },
        { text: "If you printed scorer sheets for round 1, print them again.", tone: "todo" },
        { text: "Round 1 re-paired with Cai: 2 entrants' matches changed.", tone: "done" },
        { text: "They are not notified. Tell Ben and Elif.", tone: "todo" },
      ],
    },
    {
      name: "an entrant missing from the name map reads as '?', the run sheet's own placeholder",
      results: [result({ entrant_id: "e-unknown", case: "c", round: 2 })],
      expected: [{ text: "? joins from round 2.", tone: "done" }],
    },
  ];

  it("renders the approved copy for every case, line by line", () => {
    let checked = 0;
    for (const row of TABLE) {
      const lines = lateEntryNotice(row.results, NAMES, { locale: "en", onlineRoundOpen: row.onlineRoundOpen });
      // The count of lines first: an extra or a missing line is the defect, whatever the others say.
      expect(lines.length, row.name).toBe(row.expected.length);
      expect(render(lines), row.name).toEqual(row.expected);
      checked += 1;
    }
    // Anti-vacuity: the table ran, every row of it.
    expect(checked).toBe(TABLE.length);
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it("the empty case: no result (a division with no running Swiss) says nothing", () => {
    expect(lateEntryNotice([], NAMES, { locale: "en" })).toEqual([]);
  });

  it("a result missing what its case always carries is refused by name, never rendered as a wrong sentence", () => {
    // (a) without `repaired` would otherwise read as "No other match changed" — a claim nobody checked.
    expect(() => lateEntryNotice([result({ case: "a", round: 1 })], NAMES, { locale: "en" })).toThrow(
      /late entry \(a\) without its changed entrants/,
    );
    // (b) without its holder has no opponent to name.
    expect(() => lateEntryNotice([result({ case: "b", round: 2 })], NAMES, { locale: "en" })).toThrow(
      /late entry \(b\) without its bye holder/,
    );
  });

  it("(b) with no online round open stays one line — the invite line needs the round OPEN, not just online play", () => {
    const res = [result({ case: "b", round: 3, bye_holder_id: ANA, new_board: { fixture_id: "f", scheduled: true } })];
    expect(lateEntryNotice(res, NAMES, { locale: "en", onlineRoundOpen: () => false })).toHaveLength(1);
    // Another round open online is not this one.
    expect(lateEntryNotice(res, NAMES, { locale: "en", onlineRoundOpen: (_s, r) => r === 2 })).toHaveLength(1);
  });

  it("names are listed in the reader's language (Intl.ListFormat), sorted for a stable notice", () => {
    const res = [result({ case: "a", round: 2, repaired: { changed_entrant_ids: [CAI, BEN, ANA] } })];
    const tell = (locale: string) => lateEntryNotice(res, NAMES, { locale })[1];
    expect(tell("en")?.params.names).toBe("Ana, Ben, and Cai");
    expect(tell("fr")?.params.names).toBe("Ana, Ben et Cai");
    expect(tell("nl")?.params.names).toBe("Ana, Ben en Cai");
    expect(tell("es")?.params.names).toBe("Ana, Ben y Cai");
  });
});

describe("swiss pending latecomers (the rail line)", () => {
  // Round 1 seated, round 2 waiting: the next Pair seats round 2.
  const seat = (round: number, home: string | null, away: string | null) => ({
    round_no: round,
    home_entrant_id: home,
    away_entrant_id: away,
    outcome: null,
    ext_key: `sw-r${round}-b1`,
  });
  const fixtures = [seat(1, ANA, BEN), seat(2, null, null), seat(3, null, null)];
  const stamp = (round: number | null, stageId: string | null = STAGE) => ({
    swiss_first_round: round,
    swiss_first_round_stage_id: stageId,
  });

  const TABLE: {
    name: string;
    active: string[];
    firstRounds: Record<string, ReturnType<typeof stamp>>;
    rounds?: number;
    fixtures?: typeof fixtures;
    counts: { joinNext: number; afterLast: number };
    lines: string[];
  }[] = [
    {
      name: "two latecomers stamped for the round the next Pair seats: join next round",
      active: [ANA, BEN, CAI, ELIF],
      firstRounds: { [CAI]: stamp(2), [ELIF]: stamp(2) },
      counts: { joinNext: 2, afterLast: 0 },
      lines: ["2 late entrants join next round"],
    },
    {
      name: "one latecomer: singular",
      active: [ANA, BEN, CAI],
      firstRounds: { [CAI]: stamp(2) },
      counts: { joinNext: 1, afterLast: 0 },
      lines: ["1 late entrant joins next round"],
    },
    {
      name: "an automatic arrival after the last round started (T9 recordC(rounds + 1)): joined after the last round",
      active: [ANA, BEN, CAI],
      firstRounds: { [CAI]: stamp(4) },
      rounds: 3,
      fixtures: [seat(1, ANA, BEN), seat(2, ANA, BEN), seat(3, ANA, BEN)],
      counts: { joinNext: 0, afterLast: 1 },
      lines: ["1 late entrant joined after the last round"],
    },
    {
      name: "both counts at once",
      active: [ANA, BEN, CAI, ELIF],
      firstRounds: { [CAI]: stamp(2), [ELIF]: stamp(4) },
      counts: { joinNext: 1, afterLast: 1 },
      lines: ["1 late entrant joins next round", "1 late entrant joined after the last round"],
    },
    {
      name: "the empty case: nobody stamped — no line",
      active: [ANA, BEN],
      firstRounds: {},
      counts: { joinNext: 0, afterLast: 0 },
      lines: [],
    },
    {
      name: "a latecomer already seated (first round 1, round 1 paired) is no longer pending",
      active: [ANA, BEN],
      firstRounds: { [BEN]: stamp(1) },
      counts: { joinNext: 0, afterLast: 0 },
      lines: [],
    },
    {
      name: "a withdrawn latecomer (not in the active field) is not pending",
      active: [ANA, BEN],
      firstRounds: { [CAI]: stamp(2) },
      counts: { joinNext: 0, afterLast: 0 },
      lines: [],
    },
    {
      name: "another stage's stamp does not count here (V485 stage scope)",
      active: [ANA, BEN, CAI],
      firstRounds: { [CAI]: stamp(2, "stage-2") },
      counts: { joinNext: 0, afterLast: 0 },
      lines: [],
    },
    {
      name: "a stamp for a round after the next one (round 1 unpaired after a (c)) is not 'next round'",
      active: [ANA, BEN, CAI],
      firstRounds: { [CAI]: stamp(2) },
      fixtures: [seat(1, null, null), seat(2, null, null), seat(3, null, null)],
      counts: { joinNext: 0, afterLast: 0 },
      lines: [],
    },
  ];

  it("counts both kinds of pending latecomer, and the rail line says each count", () => {
    let checked = 0;
    for (const row of TABLE) {
      const counts = swissLatecomerCounts({
        stageId: STAGE,
        rounds: row.rounds ?? 3,
        fixtures: row.fixtures ?? fixtures,
        activeEntrantIds: row.active,
        entrantFirstRounds: row.firstRounds,
      });
      expect(counts, row.name).toEqual(row.counts);
      const lines = swissLatecomerLines(counts);
      expect(lines.length, row.name).toBe(row.lines.length);
      expect(lines.map((l) => lateEntryNoticeText(l, enI18n)), row.name).toEqual(row.lines);
      // The rail line is information, never a to-do.
      for (const l of lines) expect(l.tone, row.name).toBe("done");
      checked += 1;
    }
    expect(checked).toBe(TABLE.length);
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("an unknown roster or a stage without a declared round count has no line, rather than a zero dressed as a fact", () => {
    const base = { stageId: STAGE, fixtures, entrantFirstRounds: { [CAI]: stamp(2) } };
    expect(swissLatecomerCounts({ ...base, rounds: 3, activeEntrantIds: undefined })).toEqual({ joinNext: 0, afterLast: 0 });
    for (const rounds of [0, -1, 2.5, Number.NaN, undefined]) {
      expect(swissLatecomerCounts({ ...base, rounds, activeEntrantIds: [CAI] }), String(rounds)).toEqual({
        joinNext: 0,
        afterLast: 0,
      });
    }
  });
});

describe("swiss late-entry copy in all four locales", () => {
  const DICTS = { en, es, fr, nl } as Record<string, Record<string, string>>;
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("every key the notice can emit exists in every locale with the same placeholders as English", () => {
    let checked = 0;
    const plain = [...LATE_ENTRY_MESSAGE_KEYS];
    const plurals = [...LATE_ENTRY_PLURAL_KEYS].flatMap((base) => [`${base}.one`, `${base}.other`]);
    for (const key of [...plain, ...plurals]) {
      const english = (en as Record<string, string>)[key];
      expect(typeof english, `en ${key}`).toBe("string");
      for (const [locale, dict] of Object.entries(DICTS)) {
        const value = dict[key];
        expect(typeof value, `${locale} ${key}`).toBe("string");
        expect(placeholders(value!), `${locale} ${key}`).toEqual(placeholders(english!));
        if (locale !== "en") expect(value, `${locale} ${key} is translated`).not.toBe(english);
        checked += 1;
      }
    }
    // 7 plain keys + 3 plural bases × 2 forms, × 4 locales.
    expect(checked).toBe((7 + 3 * 2) * 4);
  });
});
