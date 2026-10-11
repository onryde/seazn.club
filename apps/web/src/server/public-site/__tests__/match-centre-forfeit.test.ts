// W2b Task 13 (spec §5.5 "Public", UI-2 option A) — the match centre's line for a credited result. Before W2b every
// award read "{winner} won by forfeit" (when it read at all: a `forfeited` fixture is an `other` status, so the court
// card said "Forfeited"), a double walkover said nothing, and an abandon with a result read as an ordinary result.
// The line is now `forfeitTag`'s sentence (lib/forfeit-tag.ts), and every outcome here is a REAL fold.
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
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { buildMatchCentre, type MatchCentreInput } from "../match-centre";
import type { PublicFixture } from "../data";
import type { MsgT, SideT } from "../match-centre-schema";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

type Module = (typeof builtinModules)[number];
const mod = (k: string): Module => {
  const m = builtinModules.find((x) => x.key === k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const DICTS: Record<string, Dict> = Object.fromEntries(
  Object.entries({ en, es, fr, nl }).map(([l, d]) => [l, { ...en, ...d } as unknown as Dict]),
);
const EN = DICTS.en!;
const words = (m: MsgT | null, dict: Dict = EN) => (m === null ? null : t(dict, m.key, m.params));
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope =>
  makeEnvelope(seq, { type, payload }, voids);

interface Scene {
  m: Module;
  cfg: unknown;
  ledger: (l: ReturnType<typeof defaultLineupPair>) => EventEnvelope[];
  status: string;
  names?: [string, string];
}

/** A fixture as the loader hands it to `buildMatchCentre`: outcome and summary off the fold, the ledger void-resolved. */
function centre(s: Scene, over: Partial<MatchCentreInput> = {}) {
  const l = defaultLineupPair(s.m.positions);
  const events = s.ledger(l);
  const f = foldMatchWithStoppage(s.m as never, s.cfg as never, l, events);
  const outcome = outcomeOf(s.m as never, f);
  const [homeName, awayName] = s.names ?? ["Riverside FC", "Harbour United"];
  const sides: [SideT, SideT] = [
    { entrantId: l.home.entrantId, name: homeName, short: "HOM", colour: null, badgeUrl: null },
    { entrantId: l.away.entrantId, name: awayName, short: "AWY", colour: null, badgeUrl: null },
  ];
  const input: MatchCentreInput = {
    fixture: {
      id: "fx1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
      home_entrant_id: l.home.entrantId, away_entrant_id: l.away.entrantId, home_slot_label: null, away_slot_label: null,
      scheduled_at: "2026-10-09T09:00:00.000Z", venue: null, court_label: null, venue_name: null, court_name: null,
      status: s.status, outcome: outcome as PublicFixture["outcome"], summary: s.m.summary(f.state as never) as PublicFixture["summary"],
      last_seq: events.length,
    } as PublicFixture,
    sportKey: s.m.key, cfg: s.cfg, events: resolveVoids(events), lineups: { home: [], away: [] }, sides, venueTz: "UTC",
    locale: "en", now: new Date("2026-10-09T12:00:00.000Z"), hrefs: { division: "/d", competition: "/c", calendar: null },
    stage: null, moduleVersion: null, formatLabel: null,
    resolveMsg: (msg) => t(EN, msg.key, msg.params),
    ...over,
  };
  return { doc: buildMatchCentre(input), l, outcome, state: f.state };
}

const GENERIC = mod("generic");
const GENERIC_CFG = GENERIC.configSchema.parse(Object.values(GENERIC.variants ?? {})[0] ?? {});
// Each reason where its phase admits it (X-RS-1): a retirement once something is played (ruling 113: one score).
const forfeit = (reason: string) => (l: ReturnType<typeof defaultLineupPair>) => [
  ...(reason === "retired" || reason === "disqualified" ? [ev(1, "core.start")] : []),
  ...(reason === "retired" ? [ev(2, "generic.score", { by: l.home.entrantId, points: 1 })] : []),
  ev(3, "core.forfeit", { by: l.away.entrantId, reason }),
];

describe("match centre — a forfeit says which forfeit, naming the side (X-RS-2)", () => {
  it("empty case first: a played result keeps its result line (no forfeit sentence)", () => {
    const { doc } = centre({ m: GENERIC, cfg: GENERIC_CFG, status: "decided", ledger: (l) => [ev(1, "core.start"), ev(2, "generic.result", { winnerId: l.home.entrantId })] });
    expect(doc.header.statusLine?.key).toBe("matchCentre.result.regulation");
  });

  it("X-RS-2: each reason's sentence names the offending side — never the winner, never \"won by forfeit\"", () => {
    let rows = 0;
    const seen = new Set<string>();
    for (const reason of FORFEIT_REASONS) {
      const { doc } = centre({ m: GENERIC, cfg: GENERIC_CFG, status: "forfeited", ledger: forfeit(reason) });
      const line = doc.header.statusLine;
      expect(line?.key, reason).toBe(`forfeit.sentence.${reason}`);
      expect(line?.params, reason).toEqual({ loser: "Harbour United" });
      for (const [locale, dict] of Object.entries(DICTS)) {
        const text = words(line, dict)!;
        expect(text, `${locale} ${reason}`).toContain("Harbour United");
        expect(text, `${locale} ${reason}`).not.toContain("Riverside FC");
        expect(text, `${locale} ${reason}`).not.toMatch(/\{|forfeit\./);
      }
      seen.add(words(line)!);
      rows++;
    }
    expect(rows).toBe(FORFEIT_REASONS.length);
    expect(seen.size, "four reasons, four sentences").toBe(FORFEIT_REASONS.length);
    expect(words(centre({ m: GENERIC, cfg: GENERIC_CFG, status: "forfeited", ledger: forfeit("walkover") }).doc.header.statusLine)).toBe(
      "Harbour United didn't show up — walkover.",
    );
  });

  it("the sentence is a finished match's: a row the header still reads as scheduled or in play keeps its own line", () => {
    // A guard, not a comment: the status and the outcome are two stored columns, and a row whose status has not caught
    // up (written apart, or read between the two writes) must not tell a spectator a live match was walked over.
    let rows = 0;
    for (const status of ["scheduled", "in_play"]) {
      const line = centre({ m: GENERIC, cfg: GENERIC_CFG, status, ledger: forfeit("walkover") }).doc.header.statusLine;
      expect(line?.key ?? "(no line)", status).not.toMatch(/^forfeit\./);
      rows++;
    }
    expect(rows).toBe(2);
    // The positive pair: the same ledger on a finished row reads the sentence.
    expect(centre({ m: GENERIC, cfg: GENERIC_CFG, status: "forfeited", ledger: forfeit("walkover") }).doc.header.statusLine?.key).toBe(
      "forfeit.sentence.walkover",
    );
  });

  it("X-RS-2 + ruling 108: a football walkover shows the credited score beside the sentence (the engine's awardScore)", () => {
    const FOOTBALL = mod("football");
    const cfg = FOOTBALL.configSchema.parse({});
    const { doc, l, state } = centre({ m: FOOTBALL, cfg, status: "forfeited", ledger: forfeit("walkover") });
    // From the engine's own credit, never a typed 3–0.
    const credit = FOOTBALL.forfeitCredit(cfg, FOOTBALL.init(cfg, l) as never, "walkover", "away");
    expect(doc.header.scoreLines).toEqual([String(credit.perSide[0].gf), String(credit.perSide[1].gf)]);
    expect(credit.perSide[0].gf, "premise: the credit is not 0–0").toBeGreaterThan(0);
    expect(FOOTBALL.summary(state as never).perSide.map((p) => p.line)).toEqual(doc.header.scoreLines);
    expect(words(doc.header.statusLine)).toBe("Harbour United didn't show up — walkover.");
  });
});

// W2b T13 fix round 1 (review M-5) — the football case above is one sport; the credited score and the sentence are owed
// by EVERY sport. The expected lines are the engine's own summary of the folded walkover (never typed), and the header
// must carry them in side order beside the sentence. Each sport's cfg is its simulator cfg (SIM_CONFIGS), else its first
// declared variant, else the schema default — the same order the engine's sweeps use.
describe("match centre — a walkover's credited score and sentence, every sport (review M-5)", () => {
  const cfgOf = (m: Module): unknown =>
    m.configSchema.parse((SIM_CONFIGS as Record<string, unknown>)[m.key] ?? Object.values(m.variants ?? {})[0] ?? {});

  it("every builtin sport: the header shows the engine's credited lines (home, away) and names the side that did not show", () => {
    let checked = 0;
    let credited = 0;
    for (const m of builtinModules) {
      const cfg = cfgOf(m);
      const { doc, state, outcome } = centre({ m, cfg, status: "forfeited", ledger: forfeit("walkover") });
      expect(outcome, `${m.key}: the fold credits home`).toMatchObject({ kind: "award", reason: "walkover" });
      const lines = (m.summary(state as never) as { perSide: { entrantId: string; line: string }[] }).perSide;
      const [home, away] = [doc.header.sides[0].entrantId, doc.header.sides[1].entrantId];
      expect(doc.header.scoreLines, m.key).toEqual([
        lines.find((p) => p.entrantId === home)?.line ?? null,
        lines.find((p) => p.entrantId === away)?.line ?? null,
      ]);
      expect(doc.header.statusLine, m.key).toEqual({ key: "forfeit.sentence.walkover", params: { loser: "Harbour United" } });
      if (doc.header.scoreLines[0] !== null && doc.header.scoreLines[0] !== doc.header.scoreLines[1]) credited++;
      checked++;
    }
    expect(checked, "every builtin sport").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    // Anti-vacuity: the lines compared are a CREDIT, not two empty or level lines in every sport.
    expect(credited, "sports whose header reads a non-level credited score").toBeGreaterThan(builtinModules.length / 2);
  });
});

describe("match centre — a double walkover (X-DW-1)", () => {
  const dw = () => [ev(1, "core.forfeit", { by: "both", reason: "walkover" })];

  it("X-DW-1: \"Neither side showed up — both lose.\", and the next-round walkover clause only when a seat was fed", () => {
    const bare = centre({ m: GENERIC, cfg: GENERIC_CFG, status: "forfeited", ledger: dw });
    expect(bare.outcome).toEqual({ kind: "double_walkover" });
    expect(bare.doc.header.statusLine).toEqual({ key: "forfeit.sentence.doubleWalkover" });
    expect(words(bare.doc.header.statusLine)).toBe("Neither side showed up — both lose.");
    const fed = centre({ m: GENERIC, cfg: GENERIC_CFG, status: "forfeited", ledger: dw }, { doubleWalkoverNext: "Bears" });
    expect(words(fed.doc.header.statusLine)).toBe("Neither side showed up — both lose. Next round: walkover for Bears.");
    // An empty name is no clause, not "walkover for ."
    const blank = centre({ m: GENERIC, cfg: GENERIC_CFG, status: "forfeited", ledger: dw }, { doubleWalkoverNext: "" });
    expect(words(blank.doc.header.statusLine)).toBe("Neither side showed up — both lose.");
  });

  it("spec §5.5: no fixture whose active result is a chess double forfeit renders \"Level — winner to be decided\"", () => {
    const BOARD = mod("boardgame");
    const cfg = BOARD.configSchema.parse({ ...BOARD.bracketDeciders!(BOARD.configSchema.parse({})) });
    const held = t(EN, "matchCentre.status.needs_decision");
    expect(held, "premise: the held copy is the one this guards").toBe("Level — winner to be decided");
    let checked = 0;
    // Every status the row can be stored under — including the pre-W2b `needs_decision` the migration reclassifies.
    for (const status of ["forfeited", "needs_decision", "decided", "finalized"]) {
      const { doc, outcome } = centre({ m: BOARD, cfg, status, ledger: dw, names: ["Anand", "Bela"] });
      expect(outcome).toEqual({ kind: "double_walkover" });
      expect(doc.header.statusLine?.key, status).not.toBe("matchCentre.status.needs_decision");
      expect(words(doc.header.statusLine), status).not.toBe(held);
      expect(words(doc.header.statusLine), status).toBe("Neither side showed up — both lose.");
      checked++;
    }
    expect(checked).toBe(4);
    // The positive pair: a held chess DRAW (no forfeit) still reads the held copy.
    const draw = centre({ m: BOARD, cfg, status: "needs_decision", ledger: () => [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })] });
    expect(words(draw.doc.header.statusLine)).toBe(held);
  });
});

describe("match centre — an abandon with a result (X-AB-2)", () => {
  // Cricket's own golden DLS ledgers (cricket.test.ts "cricket golden (c)").
  const ODI = cricket.configSchema.parse({ ballsPerInnings: 300, maxOversPerBowler: 10, minOversForResult: 20, dls: { enabled: true, edition: "standard" } });
  const CRICKET = mod("cricket");
  const rainEnded = () => [
    ev(1, "core.start"),
    ev(2, "cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }),
    ev(3, "cricket.revise", { oversPerSide: 40 }),
    ev(4, "cricket.innings.summary", { runs: 190, wickets: 6, legalBalls: 240 }),
    ev(5, "cricket.innings.summary", { runs: 150, wickets: 3, legalBalls: 132, partial: true }),
    ev(6, "core.abandon", { reason: "rain" }),
  ];
  const playedOut = () => [
    ev(1, "core.start"),
    ev(2, "cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }),
    ev(3, "cricket.revise", { oversPerSide: 25 }),
    ev(4, "cricket.innings.summary", { runs: 167, wickets: 3, legalBalls: 140 }),
  ];

  it("X-AB-2: \"Abandoned (rain) — Eagles won by N runs (DLS).\" — N is the fold's own margin", () => {
    const { doc, state, outcome } = centre({ m: CRICKET, cfg: ODI, status: "decided", ledger: rainEnded, names: ["Kites", "Eagles"] });
    expect(outcome).toMatchObject({ kind: "win", method: "dls" });
    const margin = (state as { margin: { kind: string; value: number } }).margin;
    expect(margin.kind, "premise: a runs margin").toBe("runs");
    expect(words(doc.header.statusLine)).toBe(`Abandoned (rain) — Eagles won by ${margin.value} runs (DLS).`);
    // Every locale names the reason and the result, with no brace left.
    for (const [locale, dict] of Object.entries(DICTS)) {
      const local = centre(
        { m: CRICKET, cfg: ODI, status: "decided", ledger: rainEnded, names: ["Kites", "Eagles"] },
        { resolveMsg: (m) => t(dict, m.key, m.params) },
      );
      const text = words(local.doc.header.statusLine, dict)!;
      expect(text, locale).toContain("rain");
      expect(text, locale).toContain("Eagles");
      expect(text, locale).toContain(String(margin.value));
      expect(text, locale).not.toMatch(/\{/);
    }
  });

  it("X-AB-2: the ledger, not the status — the same DLS win played out (no abandon) reads its plain result", () => {
    const { doc, outcome } = centre({ m: CRICKET, cfg: ODI, status: "decided", ledger: playedOut, names: ["Kites", "Eagles"] });
    expect(outcome, "premise: the same outcome shape").toMatchObject({ kind: "win", method: "dls" });
    expect(doc.header.statusLine?.key).toMatch(/^matchCentre\.result\./);
    expect(words(doc.header.statusLine)).not.toMatch(/Abandoned/);
  });

  it("X-AB-2 after a void: an abandon the scorer took back is no abandon", () => {
    // The take-back of the abandon leaves an undecided chase; the fixture is live again.
    const { doc } = centre({ m: CRICKET, cfg: ODI, status: "in_play", ledger: () => [...rainEnded(), ev(7, "core.void", {}, "e-6")] });
    expect(words(doc.header.statusLine) ?? "").not.toMatch(/Abandoned/);
  });

  it("a washout: \"Abandoned (rain) — No result.\"; with no resolver the reason still reads", () => {
    const washout = () => [
      ev(1, "core.start"),
      ev(2, "cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }),
      ev(3, "cricket.innings.summary", { runs: 40, wickets: 1, legalBalls: 60, partial: true }),
      ev(4, "core.abandon", { reason: "rain" }),
    ];
    const withWords = centre({ m: CRICKET, cfg: ODI, status: "decided", ledger: washout });
    expect(words(withWords.doc.header.statusLine)).toBe(`Abandoned (rain) — ${t(EN, "matchCentre.result.no_result")}.`);
    const bare = centre({ m: CRICKET, cfg: ODI, status: "decided", ledger: washout }, { resolveMsg: undefined });
    expect(bare.doc.header.statusLine).toEqual({ key: "forfeit.sentence.abandonedBare", params: { reason: "rain" } });
  });

  it("M-2: a HELD washout (status abandoned — a level result in a bracket, owed the organiser's settle) never reads finished", () => {
    // fixtureStatusFromFold rule 2: an abandon whose result is level where a level result is forbidden stays
    // `abandoned`. Its no-result is not the match's result yet — who advances is owed — so the line names the abandon
    // and its reason only. The decided washout above is the positive pair (a table stage's no-result IS the result).
    const washout = () => [
      ev(1, "core.start"),
      ev(2, "cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }),
      ev(3, "cricket.innings.summary", { runs: 40, wickets: 1, legalBalls: 60, partial: true }),
      ev(4, "core.abandon", { reason: "rain" }),
    ];
    const { doc, outcome } = centre({ m: CRICKET, cfg: ODI, status: "abandoned", ledger: washout });
    expect(outcome, "premise: a level result").toMatchObject({ kind: "no_result" });
    expect(doc.header.statusLine).toEqual({ key: "forfeit.sentence.abandonedBare", params: { reason: "rain" } });
    expect(words(doc.header.statusLine)).not.toContain(t(EN, "matchCentre.result.no_result"));
  });
});
