// W4 B2a Task 4 (R9: derive from the engine) — `bracketTitleOf` must name what the ENGINE's `bracketTitle` names, on
// every bracket the engine itself generates. The engine is the oracle: each case plays a real `generateSingleElim`
// draw to its final state as DB-shaped `ChampionFixture` rows, maps the same rows to the engine's `BracketFixture`
// shape, and compares the two answers. The sweep reports what it checked (zero is a failure) and what it skipped.
import { describe, expect, it } from "vitest";
import { bracketTitle, type BracketFixture, type BracketTitle } from "@seazn/engine/competition";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { bracketTitleOf, type ChampionFixture } from "../champion";

type Outcome = "champion" | "joint" | "vacant";
const OUTCOMES: readonly Outcome[] = ["champion", "joint", "vacant"];
const SIZES = Array.from({ length: 31 }, (_, i) => i + 2); // n = 2 … 32
const MODES = [
  { name: "Shared", thirdPlace: false },
  { name: "Play-off", thirdPlace: true },
] as const;

interface Played {
  rows: ChampionFixture[];
  engine: BracketFixture[];
}

/** Play a generated bracket to its final state. Every game is decided (alternating home/away winners, so the draw is
 *  not trivially the top seed's), except the final, which ends as `outcome` says. */
function play(n: number, thirdPlace: boolean, outcome: Outcome): Played {
  const entrants = Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const gen = generateSingleElim({ entrants, thirdPlace }).fixtures;
  const winner = new Map<string, string>();
  const loser = new Map<string, string>();
  const rows: ChampionFixture[] = [];
  const engine: BracketFixture[] = [];
  const seat = (ref: { fixtureId: string; side: "winner" | "loser" } | undefined, direct: string | undefined) =>
    direct ?? (ref ? (ref.side === "winner" ? winner : loser).get(ref.fixtureId) : undefined);
  const ordered = [...gen].sort((a, b) => a.round - b.round);
  ordered.forEach((g, i) => {
    const home = g.award !== undefined ? g.award : seat(g.homeFrom, g.home);
    const away = g.award !== undefined ? undefined : seat(g.awayFrom, g.away);
    const isFinal = g.isFinal === true && g.thirdPlace !== true;
    const row: ChampionFixture = {
      id: g.id,
      stage_id: "ko",
      round_no: g.round + 1,
      status: "decided",
      outcome: null,
      is_final: isFinal,
      third_place: g.thirdPlace === true,
      conditional: g.conditional === true,
      home_entrant_id: home ?? null,
      away_entrant_id: away ?? null,
    };
    const eng: BracketFixture = {
      id: g.id,
      round: g.round,
      isFinal,
      ...(g.thirdPlace ? { thirdPlace: true } : {}),
      status: "decided",
      ...(home !== undefined ? { home } : {}),
      ...(away !== undefined ? { away } : {}),
    };
    if (isFinal && outcome === "joint") {
      row.joint_winners_at = "2026-11-10T10:00:00Z";
      eng.jointWinners = true;
    } else if (isFinal && outcome === "vacant") {
      row.status = "forfeited";
      row.outcome = { kind: "double_walkover" };
      eng.status = "walkover";
      eng.walkedOver = "both";
    } else if (home !== undefined) {
      const w = away === undefined ? home : i % 2 === 0 ? home : away;
      const l = away === undefined ? undefined : w === home ? away : home;
      row.outcome = { kind: "win", winner: w };
      eng.winner = w;
      winner.set(g.id, w);
      if (l !== undefined) {
        eng.loser = l;
        loser.set(g.id, l);
      }
    }
    rows.push(row);
    engine.push(eng);
  });
  return { rows, engine };
}

describe("bracketTitleOf equals the engine's bracketTitle on every generated bracket", () => {
  it("n = 2…32 × {champion, joint, vacant} × {Shared, Play-off}", () => {
    let checked = 0;
    let skipped = 0;
    const byKind: Record<string, number> = { champion: 0, joint: 0, vacant: 0 };
    for (const mode of MODES) {
      for (const n of SIZES) {
        for (const outcome of OUTCOMES) {
          let played: Played;
          try {
            played = play(n, mode.thirdPlace, outcome);
          } catch (e) {
            // X-TP-5: a third-place match needs two real semi-finals — the engine refuses n = 2 and 3 with one.
            expect((e as { code?: string }).code, `${mode.name} n=${n}`).toBe("CONFIG_INVALID");
            skipped++;
            continue;
          }
          const want: BracketTitle | undefined = bracketTitle(played.engine);
          const got = bracketTitleOf(played.rows);
          const label = `${mode.name} n=${n} ${outcome}`;
          expect(want, `${label}: the engine titles a played bracket`).toBeDefined();
          expect(want!.kind, `${label}: the case is the outcome it was built to be`).toBe(outcome);
          const { fixtureId, ...title } = got ?? { fixtureId: "" };
          expect(title, label).toEqual(want);
          expect(fixtureId, `${label}: names the deciding final`).toBe(played.rows.find((r) => r.is_final)!.id);
          byKind[outcome]!++;
          checked++;
        }
      }
    }
    const total = SIZES.length * OUTCOMES.length * MODES.length;
    console.log(`champion-title parity: checked ${checked}, skipped ${skipped}, of ${total}`);
    expect(checked + skipped).toBe(total); // 31 × 3 × 2 = 186
    // Play-off needs two real semi-finals: n = 2 and 3 are refused, per outcome (2 × 3).
    expect(skipped).toBe(2 * OUTCOMES.length);
    expect(checked).toBe(180);
    expect(byKind).toEqual({ champion: 60, joint: 60, vacant: 60 });
  });

  it("the empty case: the engine and the app both title nothing while the final is unplayed", () => {
    const { rows, engine } = play(8, false, "champion");
    const unplayedRows = rows.map((r) => (r.is_final ? { ...r, status: "scheduled", outcome: null } : r));
    const unplayedEngine = engine.map((f) => (f.isFinal ? { ...f, status: "scheduled" as const, winner: undefined, loser: undefined } : f));
    expect(bracketTitle(unplayedEngine)).toBeUndefined();
    expect(bracketTitleOf(unplayedRows)).toBeNull();
  });
});
