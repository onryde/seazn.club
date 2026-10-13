// W2b Task 13 (spec §5.5 "Public", UI-2 option A) — the one reader from an outcome and its ledger to the public tag and
// sentence. The tags are UI-2's (the brief's table, ruled from public-copy.html option A); the outcomes they are read
// from are REAL folds through the engine wherever the engine can write one, and the reasons are `FORFEIT_REASONS`.
//
// The abandon tags read the LEDGER (§5.4), never the status: a cricket chase reduced by rain and played out to a DLS
// target ends `win{method:"dls"}` with NO abandon, stored `decided` exactly like a chase the rain ended — the case
// where the right answer (no tag) differs from the status reading's (a tag). A voided abandon is no abandon.
import { describe, expect, it } from "vitest";
import {
  FORFEIT_REASONS,
  foldMatchWithStoppage,
  outcomeOf,
  resolveVoids,
  type EventEnvelope,
} from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { cricket } from "@seazn/engine/sports/cricket";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import {
  ABANDON_RESULT_KINDS,
  FORFEIT_SENTENCE_KEYS,
  FORFEIT_TAG_KEYS,
  NO_LEDGER,
  creditsNobody,
  doubleWalkoverNextWinner,
  forfeitCopyLookup,
  forfeitCopyOf,
  forfeitLedgerOf,
  forfeitLedgerOfReason,
  forfeitSentence,
  forfeitTag,
  forfeitWords,
  unseatedForfeitLoserName,
  unseatedWithdrew,
} from "../forfeit-tag";
import { t } from "../i18n-runtime";
import type { Dict } from "../i18n-constants";
import pubEn from "@/dictionaries/en/public.json";
import pubEs from "@/dictionaries/es/public.json";
import pubFr from "@/dictionaries/fr/public.json";
import pubNl from "@/dictionaries/nl/public.json";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

type Module = (typeof builtinModules)[number];
const mod = (k: string): Module => {
  const m = builtinModules.find((x) => x.key === k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const firstCfg = (m: Module) => m.configSchema.parse(Object.values(m.variants ?? {})[0] ?? {});
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope =>
  makeEnvelope(seq, { type, payload }, voids);

/** Fold a ledger through a real module; the outcome and the ACTIVE events (voids resolved), as a surface holds them. */
function fold(m: Module, cfg: unknown, ledger: (l: ReturnType<typeof defaultLineupPair>) => EventEnvelope[]) {
  const l = defaultLineupPair(m.positions);
  const events = ledger(l);
  const f = foldMatchWithStoppage(m as never, cfg as never, l, events);
  return { l, outcome: outcomeOf(m as never, f), active: resolveVoids(events) };
}

// The DLS scenes are cricket's own golden ledgers (cricket.test.ts "cricket golden (c): DLS Standard Edition").
const ODI_DLS = cricket.configSchema.parse({
  ballsPerInnings: 300,
  maxOversPerBowler: 10,
  minOversForResult: 20,
  dls: { enabled: true, edition: "standard" },
});
const CRICKET = mod("cricket");
const rainEndedChase = () => [
  ev(1, "core.start"),
  ev(2, "cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }),
  ev(3, "cricket.revise", { oversPerSide: 40 }),
  ev(4, "cricket.innings.summary", { runs: 190, wickets: 6, legalBalls: 240 }),
  ev(5, "cricket.innings.summary", { runs: 150, wickets: 3, legalBalls: 132, partial: true }),
  ev(6, "core.abandon", { reason: "rain" }),
];
const washout = () => [
  ev(1, "core.start"),
  ev(2, "cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }),
  ev(3, "cricket.innings.summary", { runs: 40, wickets: 1, legalBalls: 60, partial: true }),
  ev(4, "core.abandon", { reason: "rain" }),
];
/** A rain-REDUCED chase played out to its DLS target: `win{dls}`, and no abandon anywhere in the ledger. */
const reducedChasePlayedOut = () => [
  ev(1, "core.start"),
  ev(2, "cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }),
  ev(3, "cricket.revise", { oversPerSide: 25 }),
  ev(4, "cricket.innings.summary", { runs: 167, wickets: 3, legalBalls: 140 }),
];

/** A ledger holding one active abandon, as a surface's active events hold it. */
const forfeitableAbandon = (reason: string) => [{ type: "core.start", payload: {} }, { type: "core.abandon", payload: { reason } }];

const PUBLIC: Record<string, Record<string, string>> = { en: pubEn, es: pubEs, fr: pubFr, nl: pubNl };
const UI: Record<string, Record<string, string>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };
const en = (key: string, vars?: Record<string, string>) => t(pubEn as unknown as Dict, key, vars);

describe("forfeitTag — empty case first", () => {
  it("a played win, a draw and no outcome carry no tag (each a REAL fold where the engine writes one)", () => {
    const generic = mod("generic");
    const cfg = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const won = fold(generic, cfg, () => [ev(1, "core.start"), ev(2, "generic.result", { p1Score: 3, p2Score: 1 })]);
    const drawn = fold(generic, cfg, () => [ev(1, "core.start"), ev(2, "generic.result", { p1Score: 2, p2Score: 2 })]);
    expect(won.outcome?.kind, "premise: the fold decided a win").toBe("win");
    expect(drawn.outcome?.kind, "premise: the fold decided a draw").toBe("draw");
    let checked = 0;
    for (const [name, outcome, active] of [
      ["played win", won.outcome, won.active],
      ["draw", drawn.outcome, drawn.active],
      ["no outcome", null, []],
      ["undefined", undefined, []],
    ] as const) {
      expect(forfeitTag(outcome, forfeitLedgerOf(active)), name).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("an empty ledger is no abandon, and an empty reason is not one", () => {
    expect(forfeitLedgerOf([])).toEqual(NO_LEDGER);
    expect(forfeitLedgerOfReason(null)).toEqual(NO_LEDGER);
    expect(forfeitLedgerOfReason(undefined)).toEqual(NO_LEDGER);
    expect(forfeitLedgerOfReason("")).toEqual(NO_LEDGER);
    expect(forfeitLedgerOfReason("rain")).toEqual({ abandon: { reason: "rain" } });
  });
});

describe("forfeitTag — one row per member (UI-2's tags, counted)", () => {
  const generic = mod("generic");
  const cfg = firstCfg(generic);
  /** Each forfeit reason, folded where its phase admits it: a walkover or a withdrawal before play, a disqualification
   *  once it started (X-RS-1), a retirement once something is played (ruling 113: one score on the tally). */
  const forfeitBy = (reason: string) =>
    fold(generic, cfg, (l) => [
      ...(reason === "retired" || reason === "disqualified" ? [ev(1, "core.start")] : []),
      ...(reason === "retired" ? [ev(2, "generic.score", { by: l.home.entrantId, points: 1 })] : []),
      ev(3, "core.forfeit", { by: l.away.entrantId, reason }),
    ]);
  const TAGS: Record<string, string> = { walkover: "w/o", withdrew: "w/o", retired: "ret.", disqualified: "DQ" };

  it("X-RS-2: walkover, withdrew → w/o; retired → ret.; disqualified → DQ — and the sentence names the offending side", () => {
    let rows = 0;
    for (const reason of FORFEIT_REASONS) {
      const f = forfeitBy(reason);
      expect(f.outcome, reason).toMatchObject({ kind: "award", winner: f.l.home.entrantId, loser: f.l.away.entrantId, reason });
      const tag = forfeitTag(f.outcome, forfeitLedgerOf(f.active));
      expect(tag, reason).not.toBeNull();
      expect(en(tag!.tagKey), reason).toBe(TAGS[reason]);
      const w = forfeitWords(tag!, en, (id) => (id === f.l.away.entrantId ? "Harbour United" : "Riverside FC"));
      expect(w.sentence, reason).toContain("Harbour United");
      expect(w.sentence, `${reason}: the winner is not the subject`).not.toContain("Riverside FC");
      rows++;
    }
    expect(rows).toBe(FORFEIT_REASONS.length);
    expect(rows).toBe(4);
  });

  it("X-RS-2: the four sentences are four different sentences (a walkover is not a withdrawal), in public-copy.html's words", () => {
    const words = FORFEIT_REASONS.map((reason) => {
      const f = forfeitBy(reason);
      return forfeitWords(forfeitTag(f.outcome, NO_LEDGER)!, en, () => "Harbour United").sentence;
    });
    expect(new Set(words).size).toBe(FORFEIT_REASONS.length);
    expect(words[FORFEIT_REASONS.indexOf("walkover")]).toBe("Harbour United didn't turn up — walkover");
  });

  it("X-DW-1: a double walkover → 2× w/o, \"Neither side turned up — both lose\"; the next-round clause only when a seat was fed", () => {
    const f = fold(generic, cfg, () => [ev(1, "core.forfeit", { by: "both", reason: "walkover" })]);
    expect(f.outcome).toEqual({ kind: "double_walkover" });
    const tag = forfeitTag(f.outcome, NO_LEDGER)!;
    expect(tag).not.toBeNull();
    expect(en(tag.tagKey)).toBe("2× w/o");
    expect(forfeitWords(tag, en, String).sentence).toBe("Neither side turned up — both lose");
    expect(forfeitWords(tag, en, String, { next: "Bears" }).sentence).toBe(
      "Neither side turned up — both lose. Next round: walkover for Bears",
    );
    // The clause's source: a line that feeds a next match, whose match stands walked over (the cascade's seat arrival).
    const walkedOver = { outcome: { kind: "award", winner: "bears", loser: null, reason: "walkover" } };
    expect(doubleWalkoverNextWinner(true, walkedOver)).toBe("bears");
    // …and every way it has none: no next match, a next match still waiting, one voided (both feeders dead), a final.
    let none = 0;
    for (const [name, feeds, next] of [
      ["the line feeds nothing (a final)", false, walkedOver],
      ["no next fixture", true, null],
      ["next match still waiting for its other side", true, { outcome: null }],
      ["next match voided — both its feeders died", true, { outcome: { kind: "double_walkover" } }],
      ["next match played", true, { outcome: { kind: "win", winner: "bears" } }],
    ] as const) {
      expect(doubleWalkoverNextWinner(feeds, next), name).toBeNull();
      none++;
    }
    expect(none).toBe(5);
  });

  it("X-AB-2: win{dls} with an active abandon → Aband. · DLS; no_result with an active abandon → Aband. · NR", () => {
    const dls = fold(CRICKET, ODI_DLS, rainEndedChase);
    expect(dls.outcome).toMatchObject({ kind: "win", method: "dls" });
    const dlsTag = forfeitTag(dls.outcome, forfeitLedgerOf(dls.active))!;
    expect(en(dlsTag.tagKey)).toBe("Aband. · DLS");
    expect(dlsTag.params.reason).toBe("rain");
    expect(forfeitWords(dlsTag, en, String, { result: "Eagles won by 46 runs (DLS)" }).sentence).toBe(
      "Abandoned (rain) — Eagles won by 46 runs (DLS)",
    );
    const nr = fold(CRICKET, ODI_DLS, washout);
    expect(nr.outcome).toEqual({ kind: "no_result" });
    const nrTag = forfeitTag(nr.outcome, forfeitLedgerOf(nr.active))!;
    expect(en(nrTag.tagKey)).toBe("Aband. · NR");
    // A surface with no result sentence of its own still names the reason.
    expect(forfeitWords(nrTag, en, String).sentence).toBe("Abandoned (rain)");
  });

  it("X-AB-2: the abandon tag reads the LEDGER — a DLS win with no abandon (a reduced chase played out) has none, and a voided abandon is none", () => {
    const played = fold(CRICKET, ODI_DLS, reducedChasePlayedOut);
    expect(played.outcome, "premise: the same outcome shape as the rain-ended chase").toMatchObject({ kind: "win", method: "dls" });
    expect(played.active.some((e) => e.type === "core.abandon"), "premise: no abandon in its ledger").toBe(false);
    expect(forfeitTag(played.outcome, forfeitLedgerOf(played.active))).toBeNull();
    // Abandon, then the void that takes it back: the ledger no longer holds it (TEST-STRATEGY rule 1, after a void).
    const voided = [...rainEndedChase(), ev(7, "core.void", {}, "e-6")];
    expect(forfeitLedgerOf(resolveVoids(voided))).toEqual(NO_LEDGER);
    // The positive pair: the same ledger without the void reads the abandon.
    expect(forfeitLedgerOf(resolveVoids(rainEndedChase()))).toEqual({ abandon: { reason: "rain" } });
  });

  it("a bye keeps today's copy — no tag; and a forfeit award with no loser to name is refused", () => {
    expect(forfeitTag({ kind: "award", winner: "h", loser: null, reason: "bye" }, NO_LEDGER)).toBeNull();
    // A reason-less award is the bye it always was (forfeit-credit.ts `awardReasonOf`, C-5).
    expect(forfeitTag({ kind: "award", winner: "h" }, NO_LEDGER)).toBeNull();
    expect(forfeitTag({ kind: "award", winner: "h", reason: "walkover" }, NO_LEDGER), "no loser, no sentence").toBeNull();
    expect(forfeitTag({ kind: "award", winner: "h", loser: "a", reason: "injury" }, NO_LEDGER), "a reason the engine never declared").toBeNull();
  });

  it("an abandon decided another way (a settle) is not tagged; a level abandon is Aband.", () => {
    const ledger = { abandon: { reason: "floodlights" } };
    expect(forfeitTag({ kind: "win", winner: "h", loser: "a", method: "settled_lot" }, ledger)).toBeNull();
    expect(forfeitTag({ kind: "win", winner: "h", loser: "a" }, ledger), "a method-less win is a played one").toBeNull();
    const level = forfeitTag({ kind: "draw" }, ledger)!;
    expect(en(level.tagKey)).toBe("Aband.");
    expect(forfeitTag({ kind: "tie" }, ledger)?.tagKey).toBe(level.tagKey);
    expect(forfeitTag({ kind: "draw" }, NO_LEDGER), "a draw with no abandon is a played draw").toBeNull();
  });
});

describe("the abandon tags, swept over every sport's own abandon (the engine's, never a table)", () => {
  // T16 review m3 (X-AB-1): an abandon that leaves NO result is still an abandon on every public surface — out of the
  // table and flagged for replay or settle, it reads "abandoned" with its reason (the bare sentence: there is no result
  // to append). Before, it read nothing: R16-3 turned a no-draw cfg's level bracket abandon from a draw (tagged) into no
  // result, and the public lost its "Abandoned (reason)".
  it("every sport: after kick-off an abandon is tagged from the ledger — its result's tag, or with no result, abandoned (X-AB-1)", () => {
    let sports = 0;
    let resulted = 0;
    let noResult = 0;
    for (const m of builtinModules) {
      sports++;
      const policies = "abandonPolicy" in (m.configSchema.parse(firstCfg(m)) as object) ? ["replay", "award"] : [null];
      for (const policy of policies) {
        const cfg = policy === null ? firstCfg(m) : m.configSchema.parse({ ...(firstCfg(m) as object), abandonPolicy: policy });
        const f = fold(m, cfg, () => [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]);
        const tag = forfeitTag(f.outcome, forfeitLedgerOf(f.active));
        const name = `${m.key}/${policy}: ${JSON.stringify(f.outcome)}`;
        if (f.outcome === null) {
          expect(tag, name).toEqual({ kind: "abandoned", tagKey: "forfeit.tag.abandoned", sentenceKey: "forfeit.sentence.abandoned", params: { reason: "rain" } });
          expect(en(forfeitSentence(tag!, () => "?").key, { reason: "rain" }), name).toBe("Abandoned (rain)");
          noResult++;
        } else {
          expect((ABANDON_RESULT_KINDS as readonly string[]).includes(f.outcome.kind), name).toBe(true);
          expect(tag?.kind, name).toMatch(/^abandoned/);
          expect(tag?.params.reason).toBe("rain");
          resulted++;
        }
      }
    }
    expect(sports).toBe(builtinModules.length);
    expect(resulted, "some sport's abandon leaves a result to tag").toBeGreaterThan(0);
    expect(noResult, "some sport's abandon leaves none").toBeGreaterThan(0);
  });

  it("no result, the edges: an empty ledger, a voided abandon and a withdrawal's expunge read nothing; a scheduled row's outcome is null too", () => {
    // The positive pair of the case above: a null outcome is tagged ONLY beside an active abandon that is not an
    // expunge. A withdrawal's expunge (withdrawal.ts `expungeAbandon`, reason "withdrew", D5) took the match out of the
    // table altogether, so nothing is owed on it: it is no abandon flagged for replay or settle, and reads as before.
    const generic = mod("generic");
    const cfg = firstCfg(generic);
    const voided = fold(generic, cfg, () => [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), ev(3, "core.void", {}, "e-2")]);
    const expunged = fold(generic, cfg, () => [ev(1, "core.start"), ev(2, "core.abandon", { reason: "withdrew", expunge: true })]);
    let checked = 0;
    for (const [name, outcome, ledger] of [
      ["a scheduled row: no ledger", null, NO_LEDGER],
      ["a voided abandon", voided.outcome, forfeitLedgerOf(voided.active)],
      ["an expunge", expunged.outcome, forfeitLedgerOf(expunged.active)],
    ] as const) {
      expect(outcome, `${name}: premise, no outcome`).toBeNull();
      expect(forfeitTag(outcome, ledger), name).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
    expect(forfeitLedgerOf(expunged.active), "an expunge is no abandon to the reader").toEqual(NO_LEDGER);
    // …and an expunge with an earlier active abandon behind it is still no abandon: the latest active one decides.
    expect(forfeitLedgerOf([...forfeitableAbandon("rain"), { type: "core.abandon", payload: { reason: "withdrew", expunge: true } }])).toEqual(NO_LEDGER);
  });

  it("every sport's walkover reads w/o and names the side that did not show", () => {
    let sports = 0;
    for (const m of builtinModules) {
      const f = fold(m, firstCfg(m), (l) => [ev(1, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]);
      const tag = forfeitTag(f.outcome, forfeitLedgerOf(f.active));
      expect(tag?.kind, m.key).toBe("walkover");
      expect(forfeitSentence(tag!, (id) => (id === f.l.away.entrantId ? "AWAY" : "HOME")), m.key).toEqual({
        key: tag!.sentenceKey,
        params: { loser: "AWAY" },
      });
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
  });

  it("Loop R I-1: a forfeit STORED before W2b ({kind, winner, method}, no loser, no reason) over both seats reads the tag its method names, the other seat its loser; one seat, no seats, a stranger winner or a method outside the vocabulary stays untagged", () => {
    const seats = { home_entrant_id: "h", away_entrant_id: "a" };
    let checked = 0;
    for (const reason of FORFEIT_REASONS) {
      for (const [winner, loser] of [["h", "a"], ["a", "h"]] as const) {
        // The expected answer is the TYPED award's (D2): the same forfeit, as W2b stores it.
        const typed = forfeitTag({ kind: "award", winner, loser, reason }, NO_LEDGER);
        expect(typed, `premise: the typed ${reason} is tagged`).not.toBeNull();
        expect(forfeitTag({ kind: "award", winner, method: reason }, NO_LEDGER, seats), `${reason}, ${winner} won`).toEqual(typed);
        checked++;
      }
    }
    expect(checked).toBe(FORFEIT_REASONS.length * 2);
    // The production row's shape (badminton: the set kernel stored no score) and the staging one's (football: with it).
    const badminton = forfeitTag({ kind: "award", winner: "h", method: "walkover" }, NO_LEDGER, seats)!;
    const football = forfeitTag({ kind: "award", winner: "a", score: { home: 0, away: 3 }, method: "walkover" }, NO_LEDGER, seats)!;
    expect([en(badminton.tagKey), badminton.params], "X-RS-2: w/o, naming the side that did not show").toEqual(["w/o", { winner: "h", loser: "a" }]);
    expect([en(football.tagKey), football.params]).toEqual(["w/o", { winner: "a", loser: "h" }]);
    // The negative pairs, each against a reading that WOULD tag: a one-seat award with no reason is a bye…
    const legacy = { kind: "award", winner: "h", method: "walkover" };
    expect(forfeitTag(legacy, NO_LEDGER, { home_entrant_id: "h", away_entrant_id: null }), "one seat: a bye").toBeNull();
    expect(forfeitTag(legacy, NO_LEDGER), "no seats handed over: no loser to name").toBeNull();
    expect(forfeitTag({ ...legacy, winner: "x" }, NO_LEDGER, seats), "a winner who holds neither seat").toBeNull();
    expect(forfeitTag(legacy, NO_LEDGER, { home_entrant_id: "h", away_entrant_id: "h" }), "a fixture facing itself: the winner is never its own loser").toBeNull();
    expect(forfeitTag(legacy, NO_LEDGER, { home_entrant_id: null, away_entrant_id: "h" }), "one seat, the other way round").toBeNull();
    expect(forfeitTag({ kind: "award", winner: "h", method: "no-show" }, NO_LEDGER, seats), "a method the vocabulary never had").toBeNull();
    expect(forfeitTag({ kind: "award", winner: "h", method: "bye" }, NO_LEDGER, seats), "a bye is no forfeit").toBeNull();
    expect(forfeitTag({ kind: "award", winner: "h" }, NO_LEDGER, seats), "the pre-W2b bye writers' shape").toBeNull();
  });
});

describe("every tag and sentence key, in all four locales", () => {
  /** `locale:key` values MEANT to read as the English. Empty: every tag is abbreviated per locale (UI-2). */
  const SAME_AS_ENGLISH: ReadonlySet<string> = new Set<string>([]);
  const PLACEHOLDER = /\{(\w+)\}/g;
  const params = (s: string) => [...new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();

  it("public.json: each key exists, is translated (not the English), and names the English placeholders", () => {
    const keys = [...FORFEIT_TAG_KEYS, ...FORFEIT_SENTENCE_KEYS];
    expect(keys.length).toBe(7 + 8);
    let read = 0;
    let translated = 0;
    let listed = 0;
    for (const key of keys) {
      const english = PUBLIC.en![key];
      expect(typeof english === "string" && english.length > 0, `en:${key}`).toBe(true);
      read++;
      for (const locale of ["es", "fr", "nl"]) {
        const text = PUBLIC[locale]![key];
        expect(typeof text === "string" && text.length > 0, `${locale}:${key}`).toBe(true);
        expect(params(text!), `${locale}:${key} placeholders`).toEqual(params(english!));
        read++;
        if (SAME_AS_ENGLISH.has(`${locale}:${key}`)) {
          expect(text).toBe(english);
          listed++;
        } else {
          expect(text, `${locale}:${key} is its own, not the English`).not.toBe(english);
          translated++;
        }
      }
    }
    expect(read).toBe(keys.length * 4);
    expect(translated + listed).toBe(keys.length * 3);
    expect(translated).toBeGreaterThan(0);
  });

  it("ui.json carries the same tags (the organiser's run sheet reads them through `msg`), word for word", () => {
    let checked = 0;
    for (const key of FORFEIT_TAG_KEYS) {
      for (const locale of ["en", "es", "fr", "nl"]) {
        expect(UI[locale]![key], `${locale}:${key}`).toBe(PUBLIC[locale]![key]);
        checked++;
      }
    }
    expect(checked).toBe(FORFEIT_TAG_KEYS.length * 4);
  });

  it("a pre-resolved ForfeitCopy reads exactly what t() reads, in every locale", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      const dict = { ...pubEn, ...PUBLIC[locale] } as unknown as Dict;
      const copy = forfeitCopyOf((k) => t(dict, k));
      const look = forfeitCopyLookup(copy);
      for (const key of [...FORFEIT_TAG_KEYS, ...FORFEIT_SENTENCE_KEYS]) {
        const vars = { loser: "L", next: "N", reason: "R", result: "X" };
        expect(look(key, vars), `${locale}:${key}`).toBe(t(dict, key, vars));
        checked++;
      }
    }
    expect(checked).toBe(4 * 15);
  });
});

// R116-4: `unseatedForfeitLoserName` — the joined loser's name, printed in an empty seat ONLY where the reader names her.
// The rows where the outcome names a loser and her name was joined, but the reader names nobody, are the ones that
// tell the helper from "print whatever was joined": a seated loser, both seats empty, an empty seat facing another side.
describe("unseatedForfeitLoserName — the reader's answer, by name (R116-4)", () => {
  it("names her only in the empty seat facing the award's winner; every other row prints nothing", () => {
    const award = { kind: "award", winner: "w", loser: "her", reason: "withdrew" };
    const row = (home: string | null, away: string | null, outcome: unknown = award) => ({
      outcome,
      home_entrant_id: home,
      away_entrant_id: away,
      forfeit_loser_name: "Her Name",
    });
    const ROWS: [name: string, r: ReturnType<typeof row>, want: [string | null, string | null]][] = [
      ["her seat home", row(null, "w"), ["Her Name", null]],
      ["her seat away", row("w", null), [null, "Her Name"]],
      ["a seated loser", row("her", "w"), [null, null]],
      ["both seats empty", row(null, null), [null, null]],
      ["the empty seat faces another side", row(null, "x"), [null, null]],
      ["a bye (no loser)", row(null, "w", { kind: "award", winner: "w", loser: null, reason: "bye" }), [null, null]],
      ["no result", row(null, "w", null), [null, null]],
    ];
    let checked = 0;
    for (const [name, r, want] of ROWS) {
      expect([unseatedForfeitLoserName(r, "home"), unseatedForfeitLoserName(r, "away")], name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});

// Design audit 3.4: one verb for a no-show. The match centre's own timeline, the forfeit dialog and the event copy say a
// side "didn't turn up"; the public sentences said "didn't show up" / "Neither side showed up" — on the same page as the
// timeline. The timeline's phrase is the authority (read, never retyped): each locale's walkover sentence carries it.
// The split was en's alone (fr/es/nl use one verb throughout), and en's public copy carries no "show(ed) up" at all.
describe("one verb for a no-show on the public site (audit 3.4)", () => {
  const PUB: Record<string, Record<string, string>> = { en: pubEn, fr: pubFr, es: pubEs, nl: pubNl } as never;
  it("every locale: the walkover sentence uses the timeline's own phrase for the side that did not turn up", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(PUB)) {
      const timeline = d["timeline.core.forfeit.walkover"]!;
      const at = timeline.indexOf("{side} ");
      expect(at, `${locale}: the timeline names the side, then what it did`).toBeGreaterThan(-1);
      const phrase = timeline.slice(at + "{side} ".length);
      expect(phrase.length, `${locale}: a phrase to compare`).toBeGreaterThan(0);
      expect(d["forfeit.sentence.walkover"], `${locale}: "${phrase}"`).toContain(`{loser} ${phrase}`);
      checked++;
    }
    expect(checked, `locales checked: ${checked}`).toBe(4);
  });
  it("en: no public sentence says \"show(ed) up\" beside the timeline's \"turn(ed) up\"", () => {
    const shown = Object.entries(pubEn as Record<string, string>).filter(([, v]) => /\bshow(s|ed|n)? up\b/iu.test(v)).map(([k]) => k);
    expect(shown).toEqual([]);
    expect(Object.values(pubEn as Record<string, string>).filter((v) => /\bturn(s|ed)? up\b/iu.test(v)).length, "premise: the timeline's verb is there").toBeGreaterThan(0);
  });
});

// Design audit 3.5: a forfeit sentence sits beside, or in place of, a result line — the court card's status line, the
// live score's decided line, the share title — and those lines carry no full stop ("{winner} won", "Match drawn").
// Every forfeit sentence (FORFEIT_SENTENCE_KEYS, read) ends the same way in every locale. The premise is the result
// lines' own form, asserted from the same dictionaries.
describe("the forfeit sentences end like the result lines they sit beside (audit 3.5)", () => {
  const PUB: Record<string, Record<string, string>> = { en: pubEn, fr: pubFr, es: pubEs, nl: pubNl } as never;
  it("every locale: no trailing full stop on a forfeit sentence, as on matchCentre.result.*", () => {
    let sentences = 0;
    let results = 0;
    for (const [locale, d] of Object.entries(PUB)) {
      for (const [k, v] of Object.entries(d)) {
        if (!k.startsWith("matchCentre.result.")) continue;
        expect(v, `${locale} ${k}: premise — a result line has no full stop`).not.toMatch(/\.\s*$/u);
        results++;
      }
      for (const k of FORFEIT_SENTENCE_KEYS) {
        const v = d[k];
        expect(v, `${locale} ${k}`).toBeTruthy();
        expect(v, `${locale} ${k}`).not.toMatch(/\.\s*$/u);
        sentences++;
      }
    }
    expect(sentences, `forfeit sentences checked: ${sentences}`).toBe(FORFEIT_SENTENCE_KEYS.length * 4);
    expect(results, `result lines checked: ${results}`).toBeGreaterThan(4);
  });
});

// Design audit 4.1: the empty seat ruling 116 names is a side that WITHDREW, and the organiser surfaces named her as if
// she were seated ("X won (w/o)" — withdrew shares the w/o tag, X-RS-2). `unseatedWithdrew` is the one predicate they
// mark her by: true exactly where the reader names her AND the award's reason is the withdrawal. The rows that tell it
// apart: a seated loser, a bye, a walkover naming an unseated loser for another reason, no result.
describe("unseatedWithdrew — the empty seat names a side that withdrew (audit 4.1)", () => {
  it("true only in her empty seat facing the winner, on a withdrawal; every other row false", () => {
    const award = (reason: string, loser: string | null = "her") => ({ kind: "award", winner: "w", loser, reason });
    const row = (home: string | null, away: string | null, outcome: unknown = award("withdrew")) => ({ outcome, home_entrant_id: home, away_entrant_id: away });
    const ROWS: [name: string, r: ReturnType<typeof row>, want: [boolean, boolean]][] = [
      ["her seat home", row(null, "w"), [true, false]],
      ["her seat away", row("w", null), [false, true]],
      ["a seated loser who withdrew", row("her", "w"), [false, false]],
      ["both seats empty", row(null, null), [false, false]],
      ["a bye (no loser)", row(null, "w", award("bye", null)), [false, false]],
      ["an unseated loser walked over (not a withdrawal)", row(null, "w", award("walkover")), [false, false]],
      ["no result", row(null, "w", null), [false, false]],
    ];
    let checked = 0;
    for (const [name, r, want] of ROWS) {
      expect([unseatedWithdrew(r, "home"), unseatedWithdrew(r, "away")], name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});

describe("creditsNobody — the one predicate every score-line host reads (audit 3.1, review I-1/M-1)", () => {
  it("true for a double walkover alone — empty case first; every other stored outcome false", () => {
    const ROWS: [name: string, outcome: unknown, want: boolean][] = [
      ["no outcome", null, false],
      ["undefined", undefined, false],
      ["a non-object", "double_walkover", false],
      ["a double walkover", { kind: "double_walkover" }, true],
      ["a one-sided walkover", { kind: "award", winner: "w", loser: "l", reason: "walkover" }, false],
      ["a withdrawal walkover", { kind: "award", winner: "w", loser: "l", reason: "withdrew" }, false],
      ["a bye", { kind: "award", winner: "w", loser: null, reason: "bye" }, false],
      ["a played win", { kind: "win", winner: "w", loser: "l" }, false],
      ["a draw", { kind: "draw" }, false],
      ["an abandon with no result", { kind: "no_result" }, false],
    ];
    let checked = 0;
    for (const [name, outcome, want] of ROWS) {
      expect(creditsNobody(outcome), name).toBe(want);
      // The same reading the hub and the schedule make inline — one rule, never a fourth copy that can drift.
      expect(creditsNobody(outcome), `${name}: agrees with forfeitTag`).toBe(forfeitTag(outcome, NO_LEDGER)?.kind === "double_walkover");
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});
