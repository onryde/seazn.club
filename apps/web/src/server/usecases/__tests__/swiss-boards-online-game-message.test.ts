// The 409 a Swiss clear answers when an online game stands behind a board it would clear (`lockBoardsRefusingOnlineGames`). Its message is
// shown to the organiser (and sent to API callers), so it must name a place that exists: the Arbiter page was retired into Match Day, and
// "Settle that board in the arbiter panel" sent people to a page that is gone. Two things are held here:
//   1. the refusal itself - status, code and the words - on a game that stands, with its positive pair (no game: no refusal, and no ids: no
//      query at all);
//   2. a sweep over every message literal of every `HttpError(status, "...")` in production server code: none names a retired surface
//      (reported count, zero is a failure), so the next stale name is caught where it is written.
// The transaction is a double (a tagged template that answers by call order): the SQL is not what is under test, the answer is.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ONLINE_GAME_EXISTS_CODE } from "@/lib/open-round";
import { lockBoardsRefusingOnlineGames } from "@/server/usecases/stages/swiss-boards";
import type { Tx } from "@/server/usecases/stages/types";

/** A `tx` whose tagged calls answer `answers[i]` in order (the two locks, then the game read) and that passes `tx(ids)` helper calls through. */
function fakeTx(answers: unknown[][]): { tx: Tx; calls: () => number } {
  let n = 0;
  const tx = ((first: unknown) => {
    if (Array.isArray(first) && "raw" in first) {
      const answer = answers[n];
      n += 1;
      return Promise.resolve(answer ?? []);
    }
    return first;
  }) as unknown as Tx;
  return { tx, calls: () => n };
}

describe("lockBoardsRefusingOnlineGames", () => {
  it("EMPTY CASE FIRST: no board ids, no query and no refusal", async () => {
    const { tx, calls } = fakeTx([]);
    await expect(lockBoardsRefusingOnlineGames(tx, [])).resolves.toBeUndefined();
    expect(calls()).toBe(0);
  });

  it("a game that stands refuses 409 ONLINE_GAME_EXISTS and sends the organiser to Match Day, not to the retired arbiter page", async () => {
    const { tx, calls } = fakeTx([[], [], [{ fixture_id: "fx-1" }]]);
    const err = await lockBoardsRefusingOnlineGames(tx, ["fx-1"]).then(
      () => null,
      (e: unknown) => e as { status: number; code: string; message: string },
    );
    expect(err, "it refused").not.toBeNull();
    expect(err!.status).toBe(409);
    expect(err!.code).toBe(ONLINE_GAME_EXISTS_CODE);
    expect(err!.message).toContain("Settle that board in Match Day.");
    expect(err!.message).not.toMatch(/arbiter/i);
    expect(calls(), "the two locks, then the game read").toBe(3);
  });

  it("no game behind the boards: the locks are taken and nothing is refused (the pair of the refusal above)", async () => {
    const { tx, calls } = fakeTx([[], [], []]);
    await expect(lockBoardsRefusingOnlineGames(tx, ["fx-1"])).resolves.toBeUndefined();
    expect(calls()).toBe(3);
  });
});

describe("no HttpError message of the server names a retired surface", () => {
  const SRC = path.join(__dirname, "../../..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };

  it("every string-literal message of a thrown HttpError is free of the arbiter panel / column / page", () => {
    walk(path.join(SRC, "server"));
    walk(path.join(SRC, "lib"));
    const RETIRED = /arbiter (panel|column|page|console)/i;
    let checked = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/HttpError\(\s*\d{3}\s*,\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
        checked += 1;
        if (RETIRED.test(m[2]!)) offenders.push(`${path.relative(SRC, f)}: ${m[2]}`);
      }
    }
    expect(checked, "anti-vacuity: HttpError message literals read").toBeGreaterThan(100);
    expect(offenders, "messages that name a retired surface").toEqual([]);
  });
});
