// W2c Task 9 (X-PT-1) — the server's read of a forfeit's "was anything played" fact (`forfeit-played.ts`), without a
// database: the read is asked of a stand-in `db` that records its queries and answers with ledger rows, so the empty
// case (no query at all), the row mapping (`voids_event_id` → `voids`, ruling 127) and the refusal of a fact never read
// are each witnessed. The real read through Postgres is w2b-status.test.ts's "X-PT-1 stage points" describe.
// single-sport: the module only lends `startIsPlay`; badminton's is unset (its first rally is play) and chess's is set.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forfeitPlayedFacts, playedFor } from "../forfeit-played";

const moduleOf = (key: string) => builtinModules.find((m) => m.key === key)!;
const BADMINTON = moduleOf("badminton");
const CHESS = moduleOf("boardgame");

type Row = { fixture_id: string; id: string; type: string; voids: string | null };
/** A stand-in for postgres.js: `db(ids)` hands the list through; the tagged call records its ids and answers `rows`. */
function fakeDb(rows: readonly Row[]) {
  const queries: unknown[][] = [];
  const db = ((first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first) && "raw" in first) {
      queries.push(values);
      const ids = new Set(values.flat() as string[]);
      return Promise.resolve(rows.filter((r) => ids.has(r.fixture_id)));
    }
    return first;
  }) as never;
  return { db, queries };
}

const award = (reason: string) => ({ kind: "award", winner: "h", loser: reason === "bye" ? null : "a", reason });
const fx = (id: string, outcome: unknown) => ({ id, outcome });
/** A pre-W2b chess forfeit as a stored stream still folds it: the method is retired on write (X-RS-1), read on replay. */
const LEGACY_CHESS_FORFEIT_WIN = { kind: "win", winner: "h", loser: "a", method: "forfeit" }; // legacy replay row

describe("forfeitPlayedFacts — one read of the forfeit-shaped fixtures' ledgers", () => {
  it("empty case first: no forfeit-shaped fixture (none at all, an open one, a played win, a draw) reads nothing", async () => {
    const { db, queries } = fakeDb([]);
    for (const fixtures of [[], [fx("o", null), fx("w", { kind: "win", winner: "h", loser: "a" }), fx("d", { kind: "draw" })]]) {
      expect((await forfeitPlayedFacts(db, fixtures, BADMINTON)).size).toBe(0);
    }
    expect(queries).toEqual([]);
  });

  it("each forfeit-shaped fixture gets its ledger's playRecorded: Start only, a rally, a voided rally, no ledger — one query (counted)", async () => {
    const rows: Row[] = [
      { fixture_id: "start-only", id: "s1", type: "core.start", voids: null },
      { fixture_id: "start-only", id: "s2", type: "core.forfeit", voids: null },
      { fixture_id: "rally", id: "r1", type: "core.start", voids: null },
      { fixture_id: "rally", id: "r2", type: "badminton.rally", voids: null },
      { fixture_id: "rally", id: "r3", type: "core.forfeit", voids: null },
      { fixture_id: "voided", id: "v1", type: "core.start", voids: null },
      { fixture_id: "voided", id: "v2", type: "badminton.rally", voids: null },
      { fixture_id: "voided", id: "v3", type: "core.void", voids: "v2" },
      { fixture_id: "voided", id: "v4", type: "core.forfeit", voids: null },
    ];
    const { db, queries } = fakeDb(rows);
    const fixtures = [
      fx("start-only", award("withdrew")),
      fx("rally", award("withdrew")),
      fx("voided", award("disqualified")),
      fx("no-ledger", award("walkover")),
      fx("won", { kind: "win", winner: "h", loser: "a" }),
    ];
    const facts = await forfeitPlayedFacts(db, fixtures, BADMINTON);
    expect(Object.fromEntries(facts)).toEqual({ "start-only": false, rally: true, voided: false, "no-ledger": false });
    expect(queries.length, "one query for the lot").toBe(1);
    expect(new Set((queries[0] as unknown[]).flat()), "it asks only the forfeit-shaped fixtures").toEqual(new Set(["start-only", "rally", "voided", "no-ledger"]));
  });

  it("the module decides what is play (ruling 118): a chess Start is play, a badminton Start is not", async () => {
    const rows: Row[] = [{ fixture_id: "f", id: "1", type: "core.start", voids: null }];
    const fixtures = [fx("f", LEGACY_CHESS_FORFEIT_WIN)];
    expect((await forfeitPlayedFacts(fakeDb(rows).db, fixtures, CHESS)).get("f")).toBe(true);
    expect((await forfeitPlayedFacts(fakeDb(rows).db, fixtures, BADMINTON)).get("f")).toBe(false);
  });
});

describe("playedFor — the fact `payout` is handed for one fixture", () => {
  it("a forfeit-shaped fixture reads its fact; any other is not asked (false, no lookup)", () => {
    const facts = new Map([["p", true], ["n", false]]);
    expect(playedFor(fx("p", award("retired")), facts)).toBe(true);
    expect(playedFor(fx("n", award("withdrew")), facts)).toBe(false);
    expect(playedFor(fx("unread", { kind: "win", winner: "h", loser: "a" }), facts)).toBe(false);
    expect(playedFor(fx("unread", null), facts)).toBe(false);
  });

  it("a forfeit-shaped fixture whose fact was never read is refused, never guessed", () => {
    expect(() => playedFor(fx("missing", award("walkover")), new Map())).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => playedFor(fx("missing", LEGACY_CHESS_FORFEIT_WIN), new Map())).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });
});
