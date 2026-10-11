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
  doubleWalkoverNextWinner,
  forfeitCopyLookup,
  forfeitCopyOf,
  forfeitLedgerOf,
  forfeitLedgerOfReason,
  forfeitSentence,
  forfeitTag,
  forfeitWords,
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
  /** Each forfeit reason, folded where its phase admits it: a walkover or a withdrawal before play, a retirement or a
   *  disqualification once it started (X-RS-1). */
  const forfeitBy = (reason: string) =>
    fold(generic, cfg, (l) => [
      ...(reason === "retired" || reason === "disqualified" ? [ev(1, "core.start")] : []),
      ev(2, "core.forfeit", { by: l.away.entrantId, reason }),
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
    expect(words[FORFEIT_REASONS.indexOf("walkover")]).toBe("Harbour United didn't show up — walkover.");
  });

  it("X-DW-1: a double walkover → 2× w/o, \"Neither side showed up — both lose.\"; the next-round clause only when a seat was fed", () => {
    const f = fold(generic, cfg, () => [ev(1, "core.forfeit", { by: "both", reason: "walkover" })]);
    expect(f.outcome).toEqual({ kind: "double_walkover" });
    const tag = forfeitTag(f.outcome, NO_LEDGER)!;
    expect(tag).not.toBeNull();
    expect(en(tag.tagKey)).toBe("2× w/o");
    expect(forfeitWords(tag, en, String).sentence).toBe("Neither side showed up — both lose.");
    expect(forfeitWords(tag, en, String, { next: "Bears" }).sentence).toBe(
      "Neither side showed up — both lose. Next round: walkover for Bears.",
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
      "Abandoned (rain) — Eagles won by 46 runs (DLS).",
    );
    const nr = fold(CRICKET, ODI_DLS, washout);
    expect(nr.outcome).toEqual({ kind: "no_result" });
    const nrTag = forfeitTag(nr.outcome, forfeitLedgerOf(nr.active))!;
    expect(en(nrTag.tagKey)).toBe("Aband. · NR");
    // A surface with no result sentence of its own still names the reason.
    expect(forfeitWords(nrTag, en, String).sentence).toBe("Abandoned (rain).");
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
  it("every sport: after kick-off an abandon's outcome is tagged from the ledger, or there is no outcome to tag", () => {
    let sports = 0;
    let tagged = 0;
    let untagged = 0;
    for (const m of builtinModules) {
      sports++;
      const policies = "abandonPolicy" in (m.configSchema.parse(firstCfg(m)) as object) ? ["replay", "award"] : [null];
      for (const policy of policies) {
        const cfg = policy === null ? firstCfg(m) : m.configSchema.parse({ ...(firstCfg(m) as object), abandonPolicy: policy });
        const f = fold(m, cfg, () => [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]);
        const tag = forfeitTag(f.outcome, forfeitLedgerOf(f.active));
        if (f.outcome === null) {
          expect(tag, `${m.key}/${policy}`).toBeNull();
          untagged++;
        } else {
          expect((ABANDON_RESULT_KINDS as readonly string[]).includes(f.outcome.kind), `${m.key}: ${f.outcome.kind}`).toBe(true);
          expect(tag?.kind, `${m.key}/${policy}: ${JSON.stringify(f.outcome)}`).toMatch(/^abandoned/);
          expect(tag?.params.reason).toBe("rain");
          tagged++;
        }
      }
    }
    expect(sports).toBe(builtinModules.length);
    expect(tagged, "some sport's abandon leaves a result to tag").toBeGreaterThan(0);
    expect(untagged, "some sport's abandon leaves none").toBeGreaterThan(0);
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
