// B06b Task 1 — a guard over suite 11's research inputs.
//
// The two datasets under `data/` are the pack's ground truth: every stream,
// every expected outcome and the whole historical timetable are derived from
// them. Nothing downstream can tell a mis-transcribed set score from a real
// one, so the reconciliation has to happen here, against the data's OWN
// internal structure — round formats, the bracket chain, the board clock —
// rather than against a table typed into this file, which would only freeze
// whatever the author believed on the day.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface WorldsMatch {
  round: string;
  matchNo: number;
  date: string;
  session: string | null;
  p1: string;
  p2: string;
  setsP1: number | null;
  setsP2: number | null;
  setScores: string[] | null;
  walkover: boolean;
  notes: string | null;
  winner?: string;
}

interface WomensMatch {
  round: string;
  matchNo: number;
  p1: string;
  p2: string | null;
  legsP1: number | null;
  legsP2: number | null;
  walkover: boolean;
  board?: number;
  startTime?: string;
  endTime?: string;
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../data/${file}`, import.meta.url)), "utf8")) as T;
}

const worlds = load<{
  roundFormat: { round: string; bestOfSets: number }[];
  seeds: { seed: number; name: string }[];
  field: { name: string }[];
  matches: WorldsMatch[];
  sessions: { date: string; session: string | null; matches?: number[]; noPlay?: boolean }[];
}>("suite11-pdc-worlds-2025.json");

const womens = load<{
  roundFormat: { round: string; bestOfLegs: number }[];
  field: { name: string }[];
  matches: WomensMatch[];
}>("suite11-pdc-womens-series-2024.json");

const worldsWinner = (m: WorldsMatch): string =>
  m.winner ?? ((m.setsP1 ?? 0) > (m.setsP2 ?? 0) ? m.p1 : m.p2);

describe("suite 11 raw data — Div A (2025 PDC World Championship)", () => {
  it("has the full 95-match bracket", () => {
    const byRound: Record<string, number> = {};
    for (const m of worlds.matches) byRound[m.round] = (byRound[m.round] ?? 0) + 1;
    expect(byRound).toEqual({ R1: 32, R2: 32, R3: 16, R4: 8, QF: 4, SF: 2, F: 1 });
    expect(worlds.field).toHaveLength(96);
    expect(worlds.seeds).toHaveLength(32);
  });

  it("every played match ends on exactly the round's winning set count", () => {
    for (const m of worlds.matches) {
      if (m.walkover) continue;
      const fmt = worlds.roundFormat.find((r) => r.round === m.round);
      if (!fmt) throw new Error(`no roundFormat for ${m.round}`);
      const need = Math.floor(fmt.bestOfSets / 2) + 1;
      expect(Math.max(m.setsP1 ?? 0, m.setsP2 ?? 0), `match ${m.matchNo}`).toBe(need);
    }
  });

  it("per-set leg scores reconcile with the set score", () => {
    let checked = 0;
    for (const m of worlds.matches) {
      if (!m.setScores) continue;
      let a = 0;
      let b = 0;
      for (const set of m.setScores) {
        const [x, y] = set.split("-").map(Number);
        if (x > y) a++;
        else b++;
      }
      expect([a, b], `match ${m.matchNo}`).toEqual([m.setsP1, m.setsP2]);
      checked++;
    }
    // The negative pair for the loop above: a suite where nothing had
    // setScores would pass it vacuously.
    expect(checked).toBe(94);
  });

  it("each round's entrants are exactly the previous round's winners", () => {
    const order = ["R1", "R2", "R3", "R4", "QF", "SF", "F"];
    for (let i = 1; i < order.length; i++) {
      const prevWinners = new Set(
        worlds.matches.filter((m) => m.round === order[i - 1]).map(worldsWinner),
      );
      for (const m of worlds.matches.filter((x) => x.round === order[i])) {
        const fresh = [m.p1, m.p2].filter((n) => !prevWinners.has(n));
        // R2 is where the 32 seeds enter; every other round is closed.
        const allowed = order[i] === "R2" ? 1 : 0;
        expect(fresh.length, `${order[i]} match ${m.matchNo}: ${fresh.join(", ")}`).toBe(allowed);
      }
    }
  });

  it("the 32 seeds enter at round two and nowhere else", () => {
    const seeded = new Set(worlds.seeds.map((s) => s.name));
    for (const m of worlds.matches.filter((x) => x.round === "R1")) {
      for (const name of [m.p1, m.p2]) expect(seeded.has(name), `${name} is seeded but plays R1`).toBe(false);
    }
    const inR2 = worlds.matches.filter((m) => m.round === "R2");
    for (const m of inR2) {
      const count = [m.p1, m.p2].filter((n) => seeded.has(n)).length;
      expect(count, `R2 match ${m.matchNo} pairs ${count} seeds`).toBe(1);
    }
  });

  it("the one walkover carries no scores and says why", () => {
    const wos = worlds.matches.filter((m) => m.walkover);
    expect(wos).toHaveLength(1);
    expect(wos[0].setScores).toBeNull();
    expect(wos[0].notes ?? "").toMatch(/withdrew/i);
  });

  it("every match is scheduled into exactly one session", () => {
    const seen = new Map<number, number>();
    for (const s of worlds.sessions) for (const n of s.matches ?? []) seen.set(n, (seen.get(n) ?? 0) + 1);
    for (const m of worlds.matches) expect(seen.get(m.matchNo), `match ${m.matchNo}`).toBe(1);
    expect([...seen.keys()]).toHaveLength(95);
  });

  it("runs over 16 playing days with the Christmas break closed", () => {
    const playing = worlds.sessions.filter((s) => !s.noPlay);
    expect(new Set(playing.map((s) => s.date)).size).toBe(16);
    const closed = worlds.sessions.filter((s) => s.noPlay).map((s) => s.date).sort();
    expect(closed).toEqual(["2024-12-24", "2024-12-25", "2024-12-26", "2024-12-31"]);
  });
});

describe("suite 11 raw data — Div B (PDC Women's Series 2024 Event 1)", () => {
  it("is a 128-slot draw with 17 byes", () => {
    expect(womens.field).toHaveLength(111);
    expect(womens.matches).toHaveLength(127);
    const byes = womens.matches.filter((m) => !m.p2);
    expect(byes).toHaveLength(17);
    expect(womens.field.length + byes.length).toBe(128);
  });

  it("every contested match ends on exactly the round's winning leg count", () => {
    for (const m of womens.matches) {
      if (m.walkover) continue;
      const fmt = womens.roundFormat.find((r) => r.round === m.round);
      if (!fmt) throw new Error(`no roundFormat for ${m.round}`);
      const need = Math.floor(fmt.bestOfLegs / 2) + 1;
      expect(Math.max(m.legsP1 ?? 0, m.legsP2 ?? 0), `match ${m.round}-${m.matchNo}`).toBe(need);
    }
  });

  it("Sherrock won it, over Greaves", () => {
    const final = womens.matches.find((m) => m.round === "F");
    if (!final) throw new Error("no final");
    expect(final.p1).toBe("Fallon Sherrock");
    expect(final.p2).toBe("Beau Greaves");
    expect([final.legsP1, final.legsP2]).toEqual([5, 4]);
  });

  it("matchNo restarts per round, so round+matchNo is the unique key", () => {
    // Div A numbers 1..95 event-wide; Div B restarts. A fixture key built from
    // matchNo alone collides 63 times here and silently overwrites streams.
    const bare = new Set(womens.matches.map((m) => m.matchNo));
    expect(bare.size).toBeLessThan(womens.matches.length);
    const keyed = new Set(womens.matches.map((m) => `${m.round}-${m.matchNo}`));
    expect(keyed.size).toBe(womens.matches.length);
  });

  it("every contested match has a board and both ends of its clock", () => {
    let checked = 0;
    for (const m of womens.matches) {
      if (m.walkover) continue;
      expect(typeof m.board, `match ${m.round}-${m.matchNo}`).toBe("number");
      expect(m.startTime, `match ${m.round}-${m.matchNo}`).toBeTruthy();
      expect(m.endTime, `match ${m.round}-${m.matchNo}`).toBeTruthy();
      expect(new Date(m.startTime as string).getTime()).toBeLessThan(new Date(m.endTime as string).getTime());
      checked++;
    }
    expect(checked).toBe(110);
  });

  it("the real timetable overlaps on board 2 exactly once, and nowhere else", () => {
    // A fact about the source, not a defect to fix — three DartConnect feeds
    // agree. Pinned so that a later edit "tidying" it away has to argue with a
    // test, and so a SECOND overlap is caught rather than absorbed.
    const byBoard = new Map<number, WomensMatch[]>();
    for (const m of womens.matches) {
      if (m.walkover) continue;
      byBoard.set(m.board as number, [...(byBoard.get(m.board as number) ?? []), m]);
    }
    expect(byBoard.size).toBe(16);
    const overlaps: string[] = [];
    for (const [board, ms] of byBoard) {
      ms.sort((a, b) => ((a.startTime as string) < (b.startTime as string) ? -1 : 1));
      for (let i = 1; i < ms.length; i++) {
        if ((ms[i].startTime as string) < (ms[i - 1].endTime as string)) {
          overlaps.push(`board ${board}: ${ms[i - 1].round}-${ms[i - 1].matchNo} / ${ms[i].round}-${ms[i].matchNo}`);
        }
      }
    }
    expect(overlaps).toEqual(["board 2: R3-2 / R4-2"]);
  });

  it("no player is on two boards at once", () => {
    const byPlayer = new Map<string, WomensMatch[]>();
    for (const m of womens.matches) {
      if (m.walkover) continue;
      for (const name of [m.p1, m.p2 as string]) byPlayer.set(name, [...(byPlayer.get(name) ?? []), m]);
    }
    for (const [name, ms] of byPlayer) {
      ms.sort((a, b) => ((a.startTime as string) < (b.startTime as string) ? -1 : 1));
      for (let i = 1; i < ms.length; i++) {
        expect((ms[i].startTime as string) >= (ms[i - 1].endTime as string), `${name} double-booked`).toBe(true);
      }
    }
  });
});

describe("suite 11 raw data — the cross-division career", () => {
  it("names at least one player in both fields", () => {
    const inWorlds = new Set(worlds.field.map((p) => p.name));
    const both = womens.field.filter((p) => inWorlds.has(p.name)).map((p) => p.name);
    // The careers oracle's subject. If this ever empties, the oracle must
    // report NO SUBJECT rather than the pack inventing one.
    expect(both).toContain("Fallon Sherrock");
    expect(both).toContain("Noa-Lynn van Leuven");
  });
});
