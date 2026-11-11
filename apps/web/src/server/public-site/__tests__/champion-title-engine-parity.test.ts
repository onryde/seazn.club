// W4 B2a Task 4 (R9: derive from the engine) — `bracketTitleOf` must name what the ENGINE's `bracketTitle` names, on
// every bracket the engine itself generates. The engine is the oracle: each case plays a real `generateSingleElim`
// draw to its final state as DB-shaped `ChampionFixture` rows, maps the same rows to the engine's `BracketFixture`
// shape, and compares the two answers. The sweep reports what it checked (zero is a failure) and what it skipped.
import { describe, expect, it } from "vitest";
import { bracketTitle, type BracketFixture, type BracketTitle } from "@seazn/engine/competition";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder, type BracketFixtureGen } from "@seazn/engine/scheduling";
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

// B2a m4: the other bracket kinds. Generic play over ANY generated bracket: every game is decided (alternating
// winners) except the deciding final(s), which `plan` settles. Compared against the engine's `bracketTitle` as above.
//
// Double elimination is where the app deliberately diverges, and the sweep says exactly where: the app never sees the
// reset VOIDED (nothing in production writes that void), so a reset the grand final made unnecessary is read off the
// RESULT (winners' champion = the grand final's home side), where the engine reads it off the row (`void`). The cases
// below hand each side the row it would hold — `cancelled` for the app, `void` for the engine — and a scheduled reset
// behind a vacant/joint grand final, where both withhold the title. DE with a voided reset behind a vacant or joint
// grand final is NOT compared: the engine titles it, the app withholds it (the reset is never voided in production;
// a vacant DE grand final is stranded until T12 voids it — review m3).
type Mode = "champion" | "joint" | "vacant";
interface Plan {
  /** The settled state of each isFinal fixture, by id; absent = a plain decided game. */
  finals: Record<string, Mode | "scheduled" | "void">;
}
function playAny(gen: readonly BracketFixtureGen[], plan: Plan, flip: (id: string) => boolean): Played {
  const winner = new Map<string, string>();
  const loser = new Map<string, string>();
  const rows: ChampionFixture[] = [];
  const engine: BracketFixture[] = [];
  const seat = (ref: { fixtureId: string; side: "winner" | "loser" } | undefined, direct: string | undefined) =>
    direct ?? (ref ? (ref.side === "winner" ? winner : loser).get(ref.fixtureId) : undefined);
  for (const g of [...gen].sort((a, b) => a.round - b.round)) {
    const home = g.award !== undefined ? g.award : seat(g.homeFrom, g.home);
    const away = g.award !== undefined ? undefined : seat(g.awayFrom, g.away);
    const isFinal = g.isFinal === true && g.thirdPlace !== true;
    const state = isFinal ? (plan.finals[g.id] ?? "champion") : "champion";
    const row: ChampionFixture = {
      id: g.id, stage_id: "ko", round_no: g.round + 1, status: "decided", outcome: null,
      is_final: isFinal, third_place: g.thirdPlace === true, conditional: g.conditional === true,
      home_entrant_id: home ?? null, away_entrant_id: away ?? null,
    };
    const eng: BracketFixture = {
      id: g.id, round: g.round, isFinal, ...(g.bracket ? { bracket: g.bracket } : {}), ...(g.thirdPlace ? { thirdPlace: true } : {}),
      status: "decided", ...(home !== undefined ? { home } : {}), ...(away !== undefined ? { away } : {}),
    };
    if (state === "joint") {
      row.joint_winners_at = "2026-11-10T10:00:00Z";
      eng.jointWinners = true;
    } else if (state === "vacant") {
      row.status = "forfeited"; row.outcome = { kind: "double_walkover" }; eng.status = "walkover"; eng.walkedOver = "both";
    } else if (state === "scheduled") {
      row.status = "scheduled"; eng.status = "scheduled";
    } else if (state === "void") {
      row.status = "cancelled"; eng.status = "void";
    } else if (home !== undefined) {
      const w = away === undefined ? home : flip(g.id) ? away : home;
      const l = away === undefined ? undefined : w === home ? away : home;
      row.outcome = { kind: "win", winner: w }; eng.winner = w; winner.set(g.id, w);
      if (l !== undefined) { eng.loser = l; loser.set(g.id, l); }
    }
    rows.push(row);
    engine.push(eng);
  }
  return { rows, engine };
}
const names = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const compare = (label: string, p: Played) => {
  let want: BracketTitle | undefined;
  try {
    want = bracketTitle(p.engine);
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`);
  }
  const got = bracketTitleOf(p.rows);
  if (want === undefined) {
    expect(got, `${label}: the engine titles nothing, so the app does not`).toBeNull();
    return "none" as const;
  }
  expect(got, label).not.toBeNull();
  const title = got!.kind === "champion" ? { kind: "champion", champion: got!.champion } : got!.kind === "joint" ? { kind: "joint", winners: got!.winners } : { kind: "vacant" };
  expect(title, label).toEqual(want);
  return want.kind;
};

describe("parity on stepladder and page playoff (single deciding final)", () => {
  it("n = 3…12 × {champion, joint, vacant} × {stepladder, page playoff}", () => {
    let checked = 0;
    let skipped = 0;
    const kinds = { champion: 0, joint: 0, vacant: 0 };
    for (const [kind, gen] of [["stepladder", generateStepladder], ["page_playoff", generatePagePlayoff]] as const) {
      for (let n = 3; n <= 12; n++) {
        for (const mode of OUTCOMES) {
          let fixtures: BracketFixtureGen[];
          try {
            fixtures = gen({ entrants: names(n) }).fixtures;
          } catch (e) {
            expect((e as { code?: string }).code, `${kind} n=${n}`).toBe("CONFIG_INVALID");
            skipped++;
            continue;
          }
          const finals = fixtures.filter((f) => f.isFinal === true && f.thirdPlace !== true);
          expect(finals.length, `${kind} n=${n}: exactly one deciding final`).toBe(1);
          const p = playAny(fixtures, { finals: { [finals[0]!.id]: mode } }, (id) => id.length % 2 === 0);
          const got = compare(`${kind} n=${n} ${mode}`, p);
          expect(got, `${kind} n=${n}: the case is the outcome it was built to be`).toBe(mode);
          kinds[mode]++;
          checked++;
        }
      }
    }
    console.log(`stepladder/page_playoff parity: checked ${checked}, skipped ${skipped}`);
    expect(checked).toBeGreaterThan(0);
    expect(checked + skipped).toBe(2 * 10 * 3);
    expect(kinds.champion).toBe(kinds.joint);
    expect(kinds.joint).toBe(kinds.vacant);
  });
});

describe("parity on double elimination (the reset is where the app reads the result, not the row)", () => {
  it("n = 3…16: WB champion takes GF1 (reset unneeded), LB champion takes GF1 (reset played), and the reset ends champion / joint / vacant", () => {
    let checked = 0;
    let skipped = 0;
    let unseatedChecked = 0;
    const seen = new Set<string>();
    for (let n = 3; n <= 16; n++) {
      const fixtures = generateDoubleElim({ entrants: names(n), bracketReset: true }).fixtures;
      const finals = fixtures.filter((f) => f.isFinal === true).sort((a, b) => a.round - b.round);
      expect(finals.length, `n=${n}: a grand final and a conditional reset`).toBe(2);
      const [gf, reset] = [finals[0]!, finals[1]!];
      expect(reset.conditional, `n=${n}: the second final is the conditional reset`).toBe(true);
      // A bracket this small can leave a grand final with a side no game feeds (a losers' bye line): there is no
      // finalist pair to rule on, and the engine refuses a joint ruling there. Counted, never silently dropped.
      const probe = playAny(fixtures, { finals: {} }, () => false).rows.find((r) => r.id === gf.id)!;
      const seated = probe.home_entrant_id !== null && probe.away_entrant_id !== null;
      const cases: [string, Plan, (id: string) => boolean][] = [
        // (1) WB champion (home) wins GF1; the reset is unneeded: cancelled in the app's rows, void in the engine's.
        ["wb-wins reset void", { finals: { [reset.id]: "void" } }, (id) => id !== gf.id],
        // (2) LB champion (away) wins GF1; the reset is played and decided / joint / vacant.
        ...OUTCOMES.map((m): [string, Plan, (id: string) => boolean] => [`lb-wins reset ${m}`, { finals: { [reset.id]: m } }, (id) => id === gf.id]),
        // (3) The reset still SCHEDULED behind a joint or vacant GF1: both withhold the title.
        ...(["joint", "vacant"] as const).map((m): [string, Plan, (id: string) => boolean] => [`gf ${m} reset scheduled`, { finals: { [gf.id]: m, [reset.id]: "scheduled" } }, () => false]),
      ];
      for (const [name, plan, flip] of cases) {
        // Only a JOINT or VACANT ruling needs two seated finalists (the engine refuses one over an empty seat); the champion
        // cases (WB wins GF1 with the reset void, LB wins GF1 and the reset is decided) are compared on every bracket.
        const rulesOnFinalists = /joint|vacant/.test(name);
        if (!seated && rulesOnFinalists) {
          skipped++;
          continue;
        }
        const got = compare(`DE n=${n} ${name}`, playAny(fixtures, plan, flip));
        seen.add(got);
        if (name.endsWith("reset scheduled")) expect(got, `n=${n} ${name}`).toBe("none");
        if (!seated) unseatedChecked++;
        checked++;
      }
    }
    console.log(`double-elimination parity: checked ${checked}, skipped ${skipped}`);
    expect(checked).toBeGreaterThan(0);
    expect(checked + skipped).toBe(14 * 6);
    // An unseated grand final skips its 4 joint/vacant cases and still checks its 2 champion cases (B2a carried minor).
    expect(unseatedChecked * 2, "the champion cases of an unseated grand final were compared, not skipped").toBe(skipped);
    expect([...seen].sort(), "every title kind and the withheld case were really compared").toEqual(["champion", "joint", "none", "vacant"]);
  });
});
