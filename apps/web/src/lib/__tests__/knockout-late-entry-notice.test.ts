// W4 app-A Task 19 (X-LE-10 UI half; R24 pick 2B): what the desk SAYS after a late player is added to a knockout —
// "Add to bracket" on the Entrants tab, the waiting strip's tap, or a Reinstate. Pick 2B: the Swiss late-entry notice
// block, reused (`lib/swiss-late-entry-notice.ts`, preflight P26: no sibling file), green for what happened and amber for
// what the organiser still owes.
//
// The table: one row per `KnockoutLateEntryResult.case` (all five) plus the variants a case carries — the unscheduled
// match (X-LE-12, Swiss's own line reused), a reinstated player's own seat, and the reinstatement whose place has been
// played on (K13, B3 re-review). Every expected sentence is the approved English copy typed out here (task-19 brief Step
// 1, b6a-carry, R24 page item 2), never read off the function under test; rendered through the REAL English catalog and
// the REAL runtime.
//
// Single-sport by nature: the notice reads a result's case, ids and reason — no sport field reaches it.
import { describe, expect, it } from "vitest";
import {
  LATE_ENTRY_MESSAGE_KEYS,
  LATE_ENTRY_PLURAL_KEYS,
  lateEntryNotice,
  lateEntryNoticeText,
  luckyLoserNotice,
  type LateEntryNoticeLine,
} from "@/lib/swiss-late-entry-notice";
import type { KnockoutLateEntryResult, LateEntryResult } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";

const enI18n = {
  t: (key: string, vars?: Record<string, string | number>) => tRuntime(en, key, vars),
  plural: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(en, key, count, "en", vars),
};

const STAGE = "stage-1";
const OLIVER = "e-oliver";
const ARJUN = "e-arjun";
const FARHAN = "e-farhan";
const RASMUS = "e-rasmus";
const NORA = "e-nora";
const NAMES: Record<string, string> = {
  [OLIVER]: "Oliver Grant",
  [ARJUN]: "Arjun Menon",
  [FARHAN]: "Farhan Iqbal",
  [RASMUS]: "Rasmus Holm",
  [NORA]: "Nora Lind",
};

const ko = (o: Partial<KnockoutLateEntryResult> & Pick<KnockoutLateEntryResult, "case">): KnockoutLateEntryResult => ({
  format: "knockout",
  entrant_id: OLIVER,
  stage_id: STAGE,
  ...o,
});

type Rendered = { text: string; tone: LateEntryNoticeLine["tone"] };
const render = (lines: readonly LateEntryNoticeLine[]): Rendered[] => lines.map((l) => ({ text: lateEntryNoticeText(l, enI18n), tone: l.tone }));

describe("X-LE-10 knockout late-entry notice: one notice per case (R24 pick 2B)", () => {
  it("the empty case first: no result, no line", () => {
    expect(lateEntryNotice([], NAMES, { locale: "en" })).toEqual([]);
  });

  const TABLE: { name: string; results: LateEntryResult[]; expected: Rendered[] }[] = [
    {
      name: "bye: the late player plays the holder of the bye",
      results: [ko({ case: "bye", fixture_id: "f1", opponent_id: ARJUN, scheduled: true })],
      expected: [{ text: "Oliver Grant plays Arjun Menon, who had a bye.", tone: "done" }],
    },
    {
      name: "bye, the reopened match found no free court time: flagged unscheduled",
      results: [ko({ case: "bye", fixture_id: "f1", opponent_id: ARJUN, scheduled: false })],
      expected: [
        { text: "Oliver Grant plays Arjun Menon, who had a bye.", tone: "done" },
        { text: "1 new match is unscheduled.", tone: "todo" },
      ],
    },
    {
      name: "withdrawn_slot: the late player takes the withdrawn player's place, against the opponent",
      results: [ko({ case: "withdrawn_slot", fixture_id: "f2", opponent_id: RASMUS, withdrawn_id: FARHAN, scheduled: true })],
      expected: [{ text: "Oliver Grant takes Farhan Iqbal's place against Rasmus Holm.", tone: "done" }],
    },
    {
      name: "withdrawn_slot unscheduled",
      results: [ko({ case: "withdrawn_slot", fixture_id: "f2", opponent_id: RASMUS, withdrawn_id: FARHAN, scheduled: false })],
      expected: [
        { text: "Oliver Grant takes Farhan Iqbal's place against Rasmus Holm.", tone: "done" },
        { text: "1 new match is unscheduled.", tone: "todo" },
      ],
    },
    {
      name: "withdrawn_slot on a reinstated player's OWN seat: back in their place, never 'takes their own place'",
      results: [ko({ case: "withdrawn_slot", fixture_id: "f2", opponent_id: RASMUS, withdrawn_id: OLIVER, scheduled: true })],
      expected: [{ text: "Oliver Grant is back in their place against Rasmus Holm.", tone: "done" }],
    },
    {
      name: "waiting: the T11 flag's own sentence, a to-do",
      results: [ko({ case: "waiting" })],
      expected: [{ text: "1 late player waiting — add to bracket", tone: "todo" }],
    },
    {
      name: "waiting, a batch of two: counted once",
      results: [ko({ case: "waiting" }), ko({ case: "waiting", entrant_id: NORA })],
      expected: [{ text: "2 late players waiting — add to bracket", tone: "todo" }],
    },
    {
      name: "refused, no slot: the refusal's own sentence",
      results: [ko({ case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" })],
      expected: [{ text: "Round 1 complete; no slot left.", tone: "todo" }],
    },
    {
      name: "refused, played on (a reinstatement, K13): back on the list, not in the bracket",
      results: [ko({ case: "refused", reason: "KO_LATE_ENTRY_PLAYED_ON" })],
      expected: [{ text: "Oliver Grant is back on the list, but their place in the bracket has been played on.", tone: "todo" }],
    },
    {
      name: "rebuild_offered: no slot, nothing started — Rebuild draws them in",
      results: [ko({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" })],
      expected: [{ text: "No slot is left, but nothing has started: use Rebuild fixtures to add Oliver Grant.", tone: "todo" }],
    },
    {
      // Final review m1 (owner ruling 2026-11-09): Rebuild refuses a frozen schedule, so it is not offered — unfreeze first.
      name: "refused, the schedule frozen (m1): no Rebuild offered, unfreeze first",
      results: [ko({ case: "refused", reason: "KO_LATE_ENTRY_SCHEDULE_FROZEN" })],
      expected: [
        {
          text: "No slot is left, and the schedule is frozen: unfreeze it on the Schedule page, then use Rebuild fixtures to add Oliver Grant.",
          tone: "todo",
        },
      ],
    },
  ];

  it("every case, line by line, with its tone", () => {
    let checked = 0;
    const cases = new Set<string>();
    for (const row of TABLE) {
      expect(render(lateEntryNotice(row.results, NAMES, { locale: "en" })), row.name).toEqual(row.expected);
      for (const r of row.results) if (r.format === "knockout") cases.add(r.case);
      checked++;
    }
    expect(checked).toBe(TABLE.length);
    // All five cases of the wire enum are in the table (anti-vacuity: the schema's own list, not one typed here).
    expect([...cases].sort()).toEqual(["bye", "rebuild_offered", "refused", "waiting", "withdrawn_slot"]);
  });

  it("a second add replaces nothing here: two results in one batch say both, a repeated line once", () => {
    const lines = render(
      lateEntryNotice(
        [
          ko({ case: "bye", fixture_id: "f1", opponent_id: ARJUN, scheduled: false }),
          ko({ case: "withdrawn_slot", entrant_id: NORA, fixture_id: "f2", opponent_id: RASMUS, withdrawn_id: FARHAN, scheduled: false }),
        ],
        NAMES,
        { locale: "en" },
      ),
    );
    expect(lines).toEqual([
      { text: "Oliver Grant plays Arjun Menon, who had a bye.", tone: "done" },
      { text: "1 new match is unscheduled.", tone: "todo" },
      { text: "Nora Lind takes Farhan Iqbal's place against Rasmus Holm.", tone: "done" },
    ]);
  });

  it("assumptions are guards: a case missing what its sentence names is refused by name, never a sentence with a hole", () => {
    const bad: [string, KnockoutLateEntryResult][] = [
      ["bye without its holder", ko({ case: "bye", fixture_id: "f1" })],
      ["withdrawn_slot without whose place", ko({ case: "withdrawn_slot", fixture_id: "f2", opponent_id: RASMUS })],
      ["withdrawn_slot without the opponent", ko({ case: "withdrawn_slot", fixture_id: "f2", withdrawn_id: FARHAN })],
      ["refused without a reason", ko({ case: "refused" })],
      ["refused with an unknown reason", ko({ case: "refused", reason: "SOMETHING_ELSE" })],
    ];
    let checked = 0;
    for (const [why, r] of bad) {
      expect(() => lateEntryNotice([r], NAMES, { locale: "en" }), why).toThrow(/knockout late entry/);
      checked++;
    }
    expect(checked).toBe(bad.length);
  });

  it("every key the notice can emit is in all four dictionaries, with the English placeholders", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    const keys = [
      ...LATE_ENTRY_MESSAGE_KEYS.filter((k) => k.startsWith("knockout.")),
      ...LATE_ENTRY_PLURAL_KEYS.filter((k) => k.startsWith("knockout.")).flatMap((k) => [`${k}.one`, `${k}.other`]),
    ];
    let checked = 0;
    for (const key of keys) {
      for (const [locale, dict] of Object.entries(dicts)) {
        expect(typeof dict[key] === "string" && dict[key]!.trim() !== "", `${locale} has ${key}`).toBe(true);
        expect(placeholders(dict[key]!), `${locale} ${key} placeholders`).toEqual(placeholders(dicts.en![key]!));
        checked++;
      }
    }
    // 8 knockout message keys (the five cases' lines, the played-on one, the lucky loser's, m1's unfreeze-first) + 1 plural
    // base (two forms) × 4 locales.
    expect(checked).toBe((8 + 2) * 4);
  });
});

// B6a fix round 1 (review #6): the offer names the control by the name it wears. The waiting strip's button is
// `progression.rosterDrift.rebuildCta` ("Rebuild fixtures"); the sentence that points at it carries that label VERBATIM in every
// language - "Rebuild the bracket" named a button that does not exist. Expected: the button's own label, read per locale off
// the dictionary that renders the button (not off the notice).
describe("the Rebuild offer names the button it points at (one-name rule)", () => {
  it("the sentence carries the button's label in all four languages, and says it in English as typed", () => {
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    let checked = 0;
    // m1: the unfreeze-first sentence points at the same button (after the unfreeze), so it carries the same label.
    for (const key of ["knockout.lateEntry.rebuildOffered", "knockout.lateEntry.unfreezeFirst"]) {
      for (const [locale, dict] of Object.entries(dicts)) {
        const label = dict["progression.rosterDrift.rebuildCta"];
        const sentence = dict[key];
        expect(label && label.trim() !== "", `${locale}: the button has a label`).toBeTruthy();
        expect(sentence, `${locale} ${key}: the sentence names the button "${label}"`).toContain(label);
        expect(sentence, `${locale} ${key}: the name's placeholder`).toContain("{name}");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two sentences × four locales").toBe(8);
    expect(en["progression.rosterDrift.rebuildCta"], "premise: the button reads Rebuild fixtures").toBe("Rebuild fixtures");
  });
});

// T13 review #4 (b6a carry): withdrawing (or disqualifying) a qualifier whose round-1 seat a lucky loser took says WHO took it —
// the cascade's `lucky_loser` (T13), read by no component before. No lucky loser (the line walked over, or the reply is from
// a server that does not send the field) says nothing: a notice for a thing that did not happen would be the false line.
describe("X-LL-1 the withdrawal notice names the lucky loser who took the seat", () => {
  it("the empty cases first: no cascade, no field, and a null lucky loser say nothing", () => {
    expect(luckyLoserNotice(undefined, "Farhan Iqbal", NAMES)).toEqual([]);
    expect(luckyLoserNotice({}, "Farhan Iqbal", NAMES)).toEqual([]);
    expect(luckyLoserNotice({ lucky_loser: null }, "Farhan Iqbal", NAMES)).toEqual([]);
  });

  it("a lucky loser: who takes whose place, done", () => {
    const lines = luckyLoserNotice({ lucky_loser: { entrant_id: NORA, fixture_id: "f9" } }, "Farhan Iqbal", NAMES);
    expect(render(lines)).toEqual([{ text: "Nora Lind takes Farhan Iqbal's place in round 1, as the best loser.", tone: "done" }]);
  });

  it("said in the reader's language: all four dictionaries carry the sentence with its two placeholders", () => {
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [locale, dict] of Object.entries(dicts)) {
      const v = dict["knockout.lateEntry.luckyLoser"];
      expect(v, `${locale} has the key`).toBeTruthy();
      expect(v).toContain("{lucky}");
      expect(v).toContain("{name}");
      if (locale !== "en") expect(v, `${locale} is translated`).not.toBe(dicts.en!["knockout.lateEntry.luckyLoser"]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
