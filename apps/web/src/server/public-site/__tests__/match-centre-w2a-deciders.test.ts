// W2a Task 13 (spec §5.5, D5) — the match centre's result line for a bracket fixture decided by an organiser's
// settle or a chess tie-break. Before W2a every such method fell through `resultMsg`'s unknown-method branch to
// `regulation` ("{winner} won"): true, and silent about HOW. The method list is the engine's own (SETTLE_METHODS
// through settledMethod, TIEBREAK_RUNGS), and the outcome/summary are read off a REAL boardgame fold.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, SETTLE_METHODS, settledMethod, type EventEnvelope } from "@seazn/engine/core";
import type { ModuleEvent } from "@seazn/engine/sport";
import { boardgame, TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { RESULT_KINDS, RESULT_SCORED_KEYS, buildMatchCentre, type MatchCentreInput } from "../match-centre";
import type { PublicFixture } from "../data";
import type { SideT } from "../match-centre-schema";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const DICTS = { en, fr, es, nl } as unknown as Record<string, Dict>;
const LOCALES = Object.keys(DICTS);
const METHODS: readonly string[] = [...SETTLE_METHODS.map(settledMethod), ...TIEBREAK_RUNGS.map((r) => `tiebreak_${r}`)];

const lineups = defaultLineupPair(boardgame.positions);
const HOME = lineups.home.entrantId;
const AWAY = lineups.away.entrantId;
const SIDES: [SideT, SideT] = [
  { entrantId: HOME, name: "Anand Viswanathan", short: "ANA", colour: null, badgeUrl: null },
  { entrantId: AWAY, name: "Bela Nakamura", short: "BEL", colour: null, badgeUrl: null },
];
const cfg = boardgame.configSchema.parse({ tiebreak: true });
const DRAWN = [
  { type: "core.start", payload: {} },
  { type: "boardgame.result", payload: { winner: null, method: "agreement" } },
];

function folded(evs: readonly { type: string; payload: unknown }[]) {
  const events: EventEnvelope[] = evs.map((e, i) => makeEnvelope(i + 1, { type: e.type, payload: e.payload } as ModuleEvent));
  const f = foldMatchWithStoppage(boardgame, cfg, lineups, events);
  return { events, outcome: outcomeOf(boardgame, f), summary: boardgame.summary(f.state) };
}

function doc(fixture: Partial<PublicFixture>, events: readonly EventEnvelope[] = []) {
  const input: MatchCentreInput = {
    fixture: {
      id: "fx1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
      home_entrant_id: HOME, away_entrant_id: AWAY, home_slot_label: null, away_slot_label: null,
      scheduled_at: "2026-10-09T09:00:00.000Z", venue: null, court_label: null, venue_name: null, court_name: null,
      status: "decided", outcome: null, summary: null, last_seq: null, ...fixture,
    } as PublicFixture,
    sportKey: "boardgame", cfg, events, lineups: { home: [], away: [] }, sides: SIDES, venueTz: "UTC", locale: "en",
    now: new Date("2026-10-09T12:00:00.000Z"), hrefs: { division: "/d", competition: "/c", calendar: null }, stage: null,
    moduleVersion: null, formatLabel: null,
  };
  return buildMatchCentre(input);
}

const winOf = (method: string, winner = AWAY) => ({ kind: "win", winner, loser: winner === AWAY ? HOME : AWAY, method }) as PublicFixture["outcome"];

describe("match centre — W2a decider methods name HOW the bracket was decided (spec §5.5, D5)", () => {
  it("empty case first: a method-less win reads the plain line, and the engine's method list is not empty", () => {
    const line = doc({ outcome: { kind: "win", winner: AWAY, loser: HOME } as PublicFixture["outcome"] }).header.statusLine;
    expect(line).toEqual({ key: "matchCentre.result.regulation", params: { winner: "Bela Nakamura" } });
    expect(METHODS.length).toBe(SETTLE_METHODS.length + TIEBREAK_RUNGS.length);
  });

  it("RESULT_KINDS carries every decider method the engine declares, so the dictionary gates cover each one", () => {
    let checked = 0;
    for (const m of METHODS) {
      expect(RESULT_KINDS as readonly string[], m).toContain(m);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("each method keys its own sentence, naming the winner, distinct from the plain line, in 4 locales", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const plain = t(DICTS[loc]!, "matchCentre.result.regulation", { winner: "Bela Nakamura" });
      const seen = new Set<string>();
      for (const m of METHODS) {
        const line = doc({ outcome: winOf(m) }).header.statusLine;
        expect(line, m).toEqual({ key: `matchCentre.result.${m}`, params: { winner: "Bela Nakamura" } });
        const text = t(DICTS[loc]!, line!.key, line!.params);
        expect(text, `${loc} ${m}`).toContain("Bela Nakamura");
        expect(text, `${loc} ${m}`).not.toBe(plain);
        expect(text, `${loc} ${m}`).not.toMatch(/\{|matchCentre\.|settled_|tiebreak_/);
        seen.add(text);
        checked++;
      }
      expect(seen.size, loc).toBe(METHODS.length);
    }
    expect(checked).toBe(LOCALES.length * METHODS.length);
  });

  it("a scored tie-break states its score; an unscored one and a scored Armageddon do not", () => {
    expect(RESULT_SCORED_KEYS.length).toBe(2);
    const rapid = doc({ outcome: winOf("tiebreak_rapid"), summary: { headline: "½ — ½", detail: { tiebreak: { rung: "rapid", score: "1½–½" } } } as PublicFixture["summary"] }).header.statusLine;
    expect(rapid).toEqual({ key: "matchCentre.result.tiebreak_rapid.scored", params: { winner: "Bela Nakamura", score: "1½–½" } });
    expect(t(DICTS.en!, rapid!.key, rapid!.params)).toBe("Bela Nakamura won on rapid tie-break (1½–½)");
    const bare = doc({ outcome: winOf("tiebreak_rapid"), summary: { headline: "½ — ½", detail: { tiebreak: { rung: "rapid" } } } as PublicFixture["summary"] }).header.statusLine;
    expect(bare).toEqual({ key: "matchCentre.result.tiebreak_rapid", params: { winner: "Bela Nakamura" } });
    const arm = doc({ outcome: winOf("tiebreak_armageddon"), summary: { headline: "½ — ½", detail: { tiebreak: { rung: "armageddon", score: "1–0" } } } as PublicFixture["summary"] }).header.statusLine;
    expect(arm).toEqual({ key: "matchCentre.result.tiebreak_armageddon", params: { winner: "Bela Nakamura" } });
    // A settle never carries a score, even a stray one in the detail.
    const lot = doc({ outcome: winOf("settled_lot"), summary: { headline: "½ — ½", detail: { tiebreak: { score: "2–0" } } } as PublicFixture["summary"] }).header.statusLine;
    expect(lot).toEqual({ key: "matchCentre.result.settled_lot", params: { winner: "Bela Nakamura" } });
  });

  it("seam: a REAL fold — drawn knockout game, then a scored rapid tie-break — keeps the level score and names the tie-break", () => {
    const f = folded([...DRAWN, { type: "boardgame.tiebreak", payload: { rung: "rapid", winner: AWAY, score: "1½–½" } }]);
    expect(f.outcome).toMatchObject({ kind: "win", winner: AWAY, method: "tiebreak_rapid" });
    const d = doc({ outcome: f.outcome as PublicFixture["outcome"], summary: f.summary as PublicFixture["summary"] }, f.events);
    expect(t(DICTS.en!, d.header.statusLine!.key, d.header.statusLine!.params)).toBe("Bela Nakamura won on rapid tie-break (1½–½)");
    expect(d.header.scoreLines[0], "the board stays level").toBe(d.header.scoreLines[1]);
    expect(d.header.scoreLines[0]).not.toBeNull();
  });

  it("seam: a REAL settle by lot reads its own sentence through outcomeOf, and the board stays level", () => {
    const f = folded([...DRAWN, { type: "core.settle", payload: { winner: HOME, method: "lot" } }]);
    const d = doc({ outcome: f.outcome as PublicFixture["outcome"], summary: f.summary as PublicFixture["summary"] }, f.events);
    expect(t(DICTS.en!, d.header.statusLine!.key, d.header.statusLine!.params)).toBe("Anand Viswanathan advanced on lot");
    expect(d.header.scoreLines[0]).toBe(d.header.scoreLines[1]);
  });

  it("a held fixture (needs_decision) names no winner: the status line is the held one, never a result", () => {
    const f = folded(DRAWN);
    const d = doc({ status: "needs_decision", outcome: f.outcome as PublicFixture["outcome"], summary: f.summary as PublicFixture["summary"] }, f.events);
    expect(d.header.statusLine).toEqual({ key: "matchCentre.status.needs_decision" });
    expect(t(DICTS.en!, "matchCentre.status.needs_decision")).not.toMatch(/won|advanced/);
  });
});
