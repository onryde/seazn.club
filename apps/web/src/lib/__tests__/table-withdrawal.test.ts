// The ONE reading of DB fixture rows into the table withdrawal policy's input
// (spec 05 §5). Shared by the cascade that applies the policy
// (usecases/withdrawal.ts, DB-covered by withdrawal.test.ts) and the
// qualification builder that must predict it (ruling F1) — so the status sets
// and the opponent resolution are pinned here, where both readers meet.
import { describe, expect, it } from "vitest";
import { withdrawTableEntrant } from "@seazn/engine/competition";
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
    const { played, pending } = tableWithdrawalInputs("A", [
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
      const e = withdrawTableEntrant(stage, "A", tableWithdrawalInputs("A", rows)).events[0];
      return e?.type === "entrant_withdrawn" ? e.mode : undefined;
    };
    expect(mode([f("1", "decided", "A", "B", WIN), f("2", "scheduled", "A", "C"), f("3", "scheduled", "D", "A")])).toBe("expunge");
    expect(mode([f("1", "decided", "A", "B", WIN), f("2", "decided", "C", "A", WIN), f("3", "scheduled", "D", "A")])).toBe("award");
  });
});
