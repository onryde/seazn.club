// W5 app-A Task 23 (X-CU-7, X-CU-8, X-CU-11; R24 pick 7A): what the desk says after a late player joins a running league or
// group. The notice table: one row per WIRE case — the case list is read off the wire schema (`TableLateEntryResult`), never
// off the module under test, and the count is asserted (4). Every expected sentence is the approved English typed out here
// (R24 page, pick 7A, with the controller's carries), rendered through the REAL English catalog and the REAL runtime.
//
// Single-sport by nature: the notice reads a result's case, rounds, pool and ids — no sport field reaches it.
import { describe, expect, it } from "vitest";
import { TableLateEntryResult as TableLateEntryResultSchema } from "@/server/api-v1/schemas/entrants";
import type { LateEntryResult, TableLateEntryResult } from "@/server/api-v1/schemas";
import { lateEntryNotice, lateEntryNoticeText, reinstateNotice, reinstateReplyNotice, type LateEntryNoticeLine } from "@/lib/swiss-late-entry-notice";
import { TABLE_LATE_ENTRY_MESSAGE_KEYS, TABLE_LATE_ENTRY_PLURAL_KEYS, tableLateEntryLines } from "@/lib/roundrobin-late-entry-notice";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";

const enI18n = {
  t: (key: string, vars?: Record<string, string | number>) => tRuntime(en, key, vars),
  plural: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(en, key, count, "en", vars),
};
const say = (lines: LateEntryNoticeLine[]) => lines.map((l) => [l.tone, lateEntryNoticeText(l, enI18n)] as const);

const STAGE = "stage-1";
const WES = "e-wes";
const NAMES: Record<string, string> = { [WES]: "Westgate Wanderers", "e-ivy": "Ivy" };
const fx = (round: number, placement: "bye_slot" | "catch_up_round" = "catch_up_round", scheduled = false) => ({
  fixture_id: `f-${round}`,
  round_no: round,
  placement,
  scheduled,
});
const result = (o: Partial<TableLateEntryResult> & Pick<TableLateEntryResult, "case">): TableLateEntryResult => ({
  format: "group",
  entrant_id: WES,
  stage_id: STAGE,
  source: "organiser",
  ...o,
});
const notice = (results: LateEntryResult[], pooled = true) => say(lateEntryNotice(results, NAMES, { locale: "en", pooled }));

const TELL = ["todo", "Their opponents are not notified. Tell them about the new matches."] as const;
const NO_UNDO = ["todo", "Adding a late player can't be undone. Withdraw the player instead."] as const;

/** One row per wire case. `want` is the English the organiser reads. */
const CASES: Record<TableLateEntryResult["case"], { r: TableLateEntryResult; want: (readonly [string, string])[] }> = {
  catch_up: {
    // The R24 frame: Group C, catch-up rounds 6 to 9, all unscheduled (RB5-L13).
    r: result({ case: "catch_up", pool_key: "C", fixtures: [fx(6), fx(7), fx(8), fx(9)], appended_rounds: 4 }),
    want: [
      ["done", "Westgate Wanderers joined Group C."],
      ["done", "Westgate Wanderers has 4 catch-up matches, in rounds 6, 7, 8, and 9."],
      ["todo", "4 new matches have no time or court yet. Give each one a time and court."],
      TELL,
      NO_UNDO,
    ],
  },
  rebuild_offered: {
    // Nothing has started, and the catch-up lines were written (the default). Fix round 1 I1: the R24 7A sentence ("Rebuild fixtures
    // ... would draw it again") is said where its button is — on the waiting strip, BEFORE the tap. After a placement no Rebuild is
    // offered on the screen (the player is on fixtures: no strip row, no drift banner), so the notice no longer points at one.
    r: result({ case: "rebuild_offered", pool_key: "A", fixtures: [fx(2, "bye_slot"), fx(4)] }),
    want: [
      ["done", "Westgate Wanderers joined Group A."],
      ["done", "Westgate Wanderers has 2 catch-up matches, in rounds 2 and 4."],
      ["todo", "2 new matches have no time or court yet. Give each one a time and court."],
      TELL,
      NO_UNDO,
    ],
  },
  refused: {
    r: result({ case: "refused", reason: "RR_LATE_ENTRY_STAGE_COMPLETE" }),
    want: [["todo", "This table has finished. Late players can't join it."]],
  },
  waiting: {
    r: result({ case: "waiting", source: "automatic" }),
    want: [["todo", "1 late player waiting — add to the table"]],
  },
};

describe("X-CU-7 / X-CU-8 the late-entry notice for a league or group: one row per wire case", () => {
  it("covers every case the wire declares (count asserted, from the schema)", () => {
    const wire = TableLateEntryResultSchema.shape.case.options;
    expect(wire.length, "the wire's case list").toBe(4);
    expect(Object.keys(CASES).sort()).toEqual([...wire].sort());
    let checked = 0;
    for (const c of wire) {
      expect(notice([CASES[c].r]), c).toEqual(CASES[c].want);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the empty case first: no result, no line", () => {
    expect(lateEntryNotice([], NAMES, { locale: "en", pooled: true })).toEqual([]);
  });

  it("a league (or a one-pool group) never names a pool; one scheduled match says no 'no time' line", () => {
    const league = result({ format: "league", case: "catch_up", fixtures: [fx(5, "catch_up_round", true)] });
    expect(notice([league], false)).toEqual([["done", "Westgate Wanderers has 1 catch-up match, in round 5."], TELL, NO_UNDO]);
    // differential: a one-pool group's answer still carries pool_key "A" — said nowhere (owner R24, one-pool shows no letter).
    const onePool = result({ case: "catch_up", pool_key: "A", fixtures: [fx(5)] });
    expect(notice([onePool], false).map(([, t]) => t)).not.toContain("Westgate Wanderers joined Group A.");
  });

  it("prefer_rebuild redrew the stage: one line, no catch-up", () => {
    expect(notice([result({ case: "rebuild_offered", reason: "rebuilt" })])).toEqual([
      ["done", "Westgate Wanderers is in: the stage was drawn again with them in it."],
    ]);
  });

  // B5 fix wave G1 (batch review I1 + m2): the strip's Rebuild is the card's Rebuild, so it says what the card's notice says about
  // the manual ranks it dropped (the card's own clause, `progression.rosterDrift.pinsCleared`), and it names EVERY player the
  // redraw drew in, not only the one pressed. English typed from the catalog rows the card's notice already ships.
  it("G1 a redraw that dropped pins says so with the card's own clause (one and several)", () => {
    expect(notice([result({ case: "rebuild_offered", reason: "rebuilt", drawn_in: [WES], pins_cleared: 1 })])).toEqual([
      ["done", "Westgate Wanderers is in: the stage was drawn again with them in it."],
      ["done", "1 manual rank was cleared: its group changed."],
    ]);
    expect(notice([result({ case: "rebuild_offered", reason: "rebuilt", pins_cleared: 2 })]).map(([, t]) => t)).toContain(
      "2 manual ranks were cleared: their groups changed.",
    );
    // The empty case: no pin dropped, no clause (pins_cleared absent or 0).
    expect(notice([result({ case: "rebuild_offered", reason: "rebuilt", pins_cleared: 0 })])).toHaveLength(1);
  });

  it("G1 m2 a redraw that drew in several waiting players names them all; one drawn in is the one-name sentence", () => {
    expect(notice([result({ case: "rebuild_offered", reason: "rebuilt", drawn_in: [WES, "e-ivy"] })])).toEqual([
      ["done", "Westgate Wanderers and Ivy are in: the stage was drawn again with all of them in it."],
    ]);
    expect(notice([result({ case: "rebuild_offered", reason: "rebuilt", drawn_in: [WES] })])).toEqual([
      ["done", "Westgate Wanderers is in: the stage was drawn again with them in it."],
    ]);
  });

  it("G1 a drawn_in list that does not start with the pressed player is refused (never a sentence about someone else)", () => {
    expect(() =>
      tableLateEntryLines(result({ case: "rebuild_offered", reason: "rebuilt", drawn_in: ["e-ivy"] }), (id) => NAMES[id] ?? "?", { locale: "en", pooled: true }),
    ).toThrow();
  });

  it("two waiting arrivals are counted once, on the table's own line (never the bracket's)", () => {
    const two = [result({ case: "waiting", source: "automatic" }), result({ case: "waiting", source: "automatic", entrant_id: "e-ivy" })];
    expect(notice(two)).toEqual([["todo", "2 late players waiting — add to the table"]]);
  });

  it("a second add in one batch: each catch-up is said, the shared reminders once", () => {
    const ivy = result({ case: "catch_up", entrant_id: "e-ivy", pool_key: "B", fixtures: [fx(10)] });
    const lines = notice([CASES.catch_up.r, ivy]).map(([, t]) => t);
    expect(lines).toContain("Ivy joined Group B.");
    expect(lines).toContain("Ivy has 1 catch-up match, in round 10.");
    expect(lines.filter((t) => t === TELL[1]).length).toBe(1);
  });

  it("refuses to say a case missing what its sentence names (never a sentence with a hole)", () => {
    const opts = { locale: "en", pooled: true };
    const nameOf = (id: string) => NAMES[id] ?? "?";
    const BAD: [string, TableLateEntryResult][] = [
      ["catch_up without fixtures", result({ case: "catch_up", pool_key: "C" })],
      ["catch_up with no fixture", result({ case: "catch_up", pool_key: "C", fixtures: [] })],
      ["pooled group without its pool", result({ case: "catch_up", fixtures: [fx(6)] })],
      ["two matches in one round", result({ case: "catch_up", pool_key: "C", fixtures: [fx(6), fx(6)] })],
      ["refused with no reason", result({ case: "refused" })],
      ["refused with an unknown code", result({ case: "refused", reason: "NOPE" })],
      ["refused with a round-robin code that is no late-entry refusal", result({ case: "refused", reason: "RR_CUT_EXCEEDS_FIELD" })],
      ["waiting said one by one", result({ case: "waiting" })],
    ];
    let checked = 0;
    for (const [name, r] of BAD) {
      expect(() => tableLateEntryLines(r, nameOf, opts), name).toThrow();
      checked++;
    }
    expect(checked).toBe(BAD.length);
  });

  it("every key it can emit reads in all four locales, with the English placeholders", () => {
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const keys = [
      ...TABLE_LATE_ENTRY_MESSAGE_KEYS,
      ...TABLE_LATE_ENTRY_PLURAL_KEYS.flatMap((k) => [`${k}.one`, `${k}.other`]),
    ];
    let checked = 0;
    for (const key of keys) {
      for (const [loc, d] of Object.entries(dicts)) {
        expect(typeof d[key], `${loc} ${key}`).toBe("string");
        expect(ph(d[key]!), `${loc} ${key} placeholders`).toEqual(ph((en as Record<string, string>)[key]!));
        checked++;
      }
    }
    expect(checked).toBe(keys.length * 4);
  });

  // Final fix wave (m3): a Reinstate's `reinstate.not_restored` had no reader (an inert seam). Expected sentences are typed here,
  // in every locale, from the approved copy; the count is the number of lines the reply names.
  it("m3 a Reinstate that could not restore results says how many, in every locale (the empty and the absent reply say nothing)", () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    expect(reinstateNotice(undefined, "Ivy"), "no reply").toEqual([]);
    expect(reinstateNotice(null, "Ivy"), "no reply").toEqual([]);
    expect(reinstateNotice({}, "Ivy"), "an ordinary patch carries no `reinstate`").toEqual([]);
    expect(reinstateNotice({ reinstate: { not_restored: [] } }, "Ivy"), "everything came back").toEqual([]);
    const one = reinstateNotice({ reinstate: { not_restored: ids.slice(0, 1) } }, "Ivy");
    const three = reinstateNotice({ reinstate: { not_restored: ids } }, "Ivy");
    expect([one, three].map((l) => l.map((x) => x.tone))).toEqual([["todo"], ["todo"]]);
    const WANT = {
      en: ["Ivy is back in the table, but the result removed from 1 of their matches could not be put back. Check that match and enter the result again.",
           "Ivy is back in the table, but the results removed from 3 of their matches could not be put back. Check those matches and enter the results again."],
      es: ["Ivy vuelve a estar en la tabla, pero no se pudo restaurar el resultado eliminado de 1 de sus partidos. Revisa ese partido e introduce el resultado de nuevo.",
           "Ivy vuelve a estar en la tabla, pero no se pudieron restaurar los resultados eliminados de 3 de sus partidos. Revisa esos partidos e introduce los resultados de nuevo."],
      fr: ["Ivy est de retour dans le classement, mais le résultat retiré de 1 de ses matchs n'a pas pu être rétabli. Vérifiez ce match et saisissez à nouveau le résultat.",
           "Ivy est de retour dans le classement, mais les résultats retirés de 3 de ses matchs n'ont pas pu être rétablis. Vérifiez ces matchs et saisissez à nouveau les résultats."],
      nl: ["Ivy staat weer in de stand, maar het weggehaalde resultaat van 1 van de wedstrijden kon niet worden teruggezet. Controleer die wedstrijd en voer het resultaat opnieuw in.",
           "Ivy staat weer in de stand, maar de weggehaalde resultaten van 3 van de wedstrijden konden niet worden teruggezet. Controleer die wedstrijden en voer de resultaten opnieuw in."],
    } as const;
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [loc, d] of Object.entries(dicts)) {
      const i18n = {
        t: (key: string, vars?: Record<string, string | number>) => tRuntime(d, key, vars),
        plural: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(d, key, count, loc as "en" | "es" | "fr" | "nl", vars),
      };
      expect(one.map((l) => lateEntryNoticeText(l, i18n)), `${loc} one`).toEqual([WANT[loc as keyof typeof WANT][0]]);
      expect(three.map((l) => lateEntryNoticeText(l, i18n)), `${loc} several`).toEqual([WANT[loc as keyof typeof WANT][1]]);
      checked += 2;
    }
    expect(checked, "(locale, count) sentences read").toBe(8);
  });

  it("m3 the panel's one reader: a knockout late-entry answer and a not-restored list are both said; neither alone adds the other's line; a plain reply says nothing", () => {
    const koBye = { format: "knockout", case: "bye", entrant_id: WES, stage_id: STAGE, source: "organiser", opponent_id: "e-ivy" } as LateEntryResult;
    const lost = { not_restored: ["11111111-1111-4111-8111-111111111111"] };
    const says = (reply: unknown) => reinstateReplyNotice(reply, WES, NAMES, { locale: "en" }).map((l) => ("plural" in l ? l.plural : l.key));
    expect(says(null), "no reply").toEqual([]);
    expect(says({}), "an ordinary reinstate").toEqual([]);
    expect(says({ reinstate: { not_restored: [] } }), "a clean league reinstate").toEqual([]);
    expect(says({ reinstate: lost })).toEqual(["roundrobin.reinstate.notRestored"]);
    expect(says({ late_entry: koBye }), "a knockout answer alone: its own line, none of the other").toEqual(["knockout.lateEntry.tookBye"]);
    expect(says({ late_entry: koBye, reinstate: lost })).toEqual(["knockout.lateEntry.tookBye", "roundrobin.reinstate.notRestored"]);
  });
});
