// The ONE reading of DB fixture rows into the table withdrawal policy's input
// (spec 05 §5). Shared by the cascade that applies the policy
// (usecases/withdrawal.ts, DB-covered by withdrawal.test.ts) and the
// qualification builder that must predict it (ruling F1) — so the status sets
// and the opponent resolution are pinned here, where both readers meet.
import { describe, expect, it } from "vitest";
import { withdrawTableEntrant } from "@seazn/engine/competition";
import { restByeExtKey } from "@/lib/fixture-bye";
import {
  WITHDRAWAL_PENDING_STATUSES,
  WITHDRAWAL_PLAYED_STATUSES,
  tableWithdrawalInputs,
  type WithdrawalFixtureRow,
} from "../table-withdrawal";

const f = (id: string, status: string, home: string | null, away: string | null, outcome: unknown = null): WithdrawalFixtureRow => ({
  id,
  status,
  home_entrant_id: home,
  away_entrant_id: away,
  outcome,
});
const WIN = { kind: "win", winner: "A", loser: "B" };

describe("tableWithdrawalInputs", () => {
  it("pins the two status sets", () => {
    expect([...WITHDRAWAL_PLAYED_STATUSES].sort()).toEqual(["decided", "finalized", "forfeited"]);
    expect([...WITHDRAWAL_PENDING_STATUSES].sort()).toEqual(["in_play", "scheduled"]);
  });
  it("played = a played status WITH a result; pending = scheduled/in play; void is neither", () => {
    const { played, pending } = tableWithdrawalInputs("A", "league", [
      f("1", "decided", "A", "B", WIN),
      f("2", "finalized", "C", "A", WIN),
      f("3", "forfeited", "A", "D", { kind: "award", winner: "D" }),
      f("4", "decided", "A", "E", null), // no result yet: not played
      f("5", "scheduled", "A", "F"),
      f("6", "in_play", "G", "A"),
      f("7", "cancelled", "A", "H"),
      f("8", "abandoned", "A", "I"),
    ]);
    expect(played.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(played.every((x) => x.status === "decided")).toBe(true);
    expect(pending).toEqual([
      { id: "5", opponent: "F" },
      { id: "6", opponent: "G" },
    ]);
  });
  it("feeds the engine's mode: under 50% played expunges, half or more awards", () => {
    const stage = { id: "S", kind: "league" as const, entrants: ["A"], cascade: [] };
    const mode = (rows: WithdrawalFixtureRow[]) => {
      const e = withdrawTableEntrant(stage, "A", tableWithdrawalInputs("A", "league", rows)).events[0];
      return e?.type === "entrant_withdrawn" ? e.mode : undefined;
    };
    expect(mode([f("1", "decided", "A", "B", WIN), f("2", "scheduled", "A", "C"), f("3", "scheduled", "D", "A")])).toBe("expunge");
    expect(mode([f("1", "decided", "A", "B", WIN), f("2", "decided", "C", "A", WIN), f("3", "scheduled", "D", "A")])).toBe("award");
  });
});

// #850 — a round-robin REST bye is not a played match, so it must not move the
// 50% line; a Swiss sit-out still counts, exactly as before (regression pair).
describe("tableWithdrawalInputs — #850 rest byes", () => {
  // A rest bye carries the generator's MARKER (`restByeExtKey`); without it
  // the same shape is a fed league's walkover, which IS played.
  const BYE = (id: string, holder: string, round = 1) => ({
    ...f(id, "forfeited", holder, null, { kind: "award", winner: holder }),
    ext_key: restByeExtKey("", round),
  });

  it("a league/group rest bye is neither played nor pending; a Swiss bye is still played", () => {
    const rows = [f("1", "decided", "A", "B", WIN), BYE("2", "A"), f("3", "scheduled", "A", "C")];
    // The walkover twin (owner ruling 2026-09-24, fourth round): the SAME shape
    // unmarked is played in every kind, the league included.
    const walkover = { ...BYE("2", "A"), ext_key: "rr-r1-c2" };
    for (const kind of ["league", "group", "swiss"]) {
      expect(tableWithdrawalInputs("A", kind, [walkover]).played.map((x) => x.id), kind).toEqual(["2"]);
    }
    for (const kind of ["league", "group"]) {
      const { played, pending } = tableWithdrawalInputs("A", kind, rows);
      expect(played.map((x) => x.id), kind).toEqual(["1"]);
      expect(pending.map((x) => x.id), kind).toEqual(["3"]);
    }
    expect(tableWithdrawalInputs("A", "swiss", rows).played.map((x) => x.id)).toEqual(["1", "2"]);
  });

  // The verdict the ruling exists to protect, with a case where counting the
  // bye flips it: a double round robin of five, three matches played, five to
  // play, two byes taken. Played/total is 3/8 (expunge) without the byes and
  // 5/10 (award) with them — so a bye read as played would walk five
  // opponents over instead of expunging.
  it("the policy's mode flips back to expunge once the rest byes stop counting", () => {
    const rows = [
      f("m1", "decided", "A", "B", WIN),
      f("m2", "decided", "A", "C", WIN),
      f("m3", "decided", "D", "A", WIN),
      BYE("b1", "A", 1),
      BYE("b2", "A", 2),
      f("p1", "scheduled", "A", "E"),
      f("p2", "scheduled", "B", "A"),
      f("p3", "scheduled", "C", "A"),
      f("p4", "scheduled", "A", "D"),
      f("p5", "scheduled", "E", "A"),
    ];
    const mode = (kind: "league" | "swiss") => {
      const e = withdrawTableEntrant(
        { id: "S", kind, entrants: ["A"], cascade: [] },
        "A",
        tableWithdrawalInputs("A", kind, rows),
      ).events[0];
      return e?.type === "entrant_withdrawn" ? e.mode : undefined;
    };
    expect(mode("league")).toBe("expunge");
    expect(mode("swiss")).toBe("award");
  });
});

