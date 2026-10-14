// Final review M-9: settling a live board wrote the result and closed the bridge, but the Lichess game stayed alive —
// both players could play on at lichess.org, where a different outcome was ours to ignore. The settle now ends the
// game there too, best effort and after the result is written (brief ruling):
//   - fewer than 2 plies: abort, with either token;
//   - a decided winner: resign with the LOSER's token;
//   - a draw: offer and accept a draw with both tokens;
//   - void: abort if it can still be aborted, otherwise offer and accept a draw.
// Every failure is logged, and none touches the settle. Driven through the REAL settle (resolveExternalPlay) and the
// REAL Board API client against the Lichess fixture server: the expected endings are the rules above and lila's own
// (M9: a resign before ply 2 is an abort), read back from the fixture's game, never from the code under test.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Before ANY import can load board-api: its default client binds the base URL at import (as production does).
const FX = vi.hoisted(() => {
  const port = 4334;
  process.env.LICHESS_BASE_URL = `http://127.0.0.1:${port}`;
  return { port };
});

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { createBoardApi } from "@/server/external-play/lichess/board-api";
import { startLichessFixtureServer, type LichessFixtureServer } from "../../../../e2e/lichess-fixture-server";
import { RESOLVE_KINDS, resolveExternalPlay, type ResolveKind } from "../external-play/resolve";
import { holdForOrganiser, holdRefusedNoShow } from "../external-play/result";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

let fx: LichessFixtureServer;
let lichess: ReturnType<typeof createBoardApi>;
beforeAll(async () => {
  if (!HAS_DB) return;
  fx = await startLichessFixtureServer(FX.port);
  lichess = createBoardApi({ baseUrl: fx.url });
});
afterAll(async () => {
  await fx?.close();
  await sql.end({ timeout: 2 }).catch(() => undefined);
});
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fx?.reset();
  warn = vi.spyOn(log, "warn");
});

/** Every log.warn call this test made, as its arguments. */
const warnCalls = (): unknown[][] => warn.mock.calls as unknown[][];

const token = (lichessId: string) => `lio_seed_${lichessId}`;

/** The tail work a settle schedules, run to the end before the test reads Lichess. */
function collector() {
  const tasks: Promise<unknown>[] = [];
  return {
    defer: (fn: () => Promise<unknown> | unknown) => {
      tasks.push(Promise.resolve().then(fn));
    },
    drain: async () => {
      await Promise.all(tasks);
      return tasks.length;
    },
  };
}

async function round(opts: { knockout?: boolean } = {}): Promise<{ r: SeedOnlineChessRoundResult; b: SeedRoundBoard }> {
  const r = await seedOnlineChessRound({ fixtures: 1, scheduledAt: new Date(Date.now() - 5 * 60_000) });
  if (opts.knockout) await sql`update stages set kind = 'knockout' where id = ${r.stageId}`;
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
    values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, now() - interval '5 minutes')`;
  const b = r.boards[0]!;
  fx.registerToken(token(b.home.lichessId), b.home.lichessId);
  fx.registerToken(token(b.away.lichessId), b.away.lichessId);
  return { r, b };
}

/** A real game at the fixture — home White — with `plies` played there, and the bridge as T9/T10 leave it. `onFile`
 *  is the ply count OUR ledger holds (it may lag Lichess). */
async function liveGame(r: SeedOnlineChessRoundResult, b: SeedRoundBoard, plies: number, onFile = plies): Promise<string> {
  const made = await lichess.createChallengeToUser({ whiteToken: token(b.home.lichessId), blackUsername: b.away.lichessId, limitSeconds: 900, incrementSeconds: 10 });
  if (!made.ok) throw new Error(`create refused: ${made.code}`);
  const acc = await lichess.acceptChallenge({ blackToken: token(b.away.lichessId), challengeId: made.challengeId });
  if (!acc.ok) throw new Error(`accept refused: ${acc.code}`);
  const line = ["e2e4", "e7e5", "g1f3", "b8c6"].slice(0, plies);
  for (const [i, uci] of line.entries()) {
    const sent = await lichess.submitMove({ token: token(i % 2 === 0 ? b.home.lichessId : b.away.lichessId), gameId: made.challengeId, uci });
    if (!sent.ok) throw new Error(`ply ${i + 1} refused: ${sent.code}`);
  }
  const moves = line.slice(0, onFile);
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
       moves_uci, move_count, started_at)
    values (${b.fixtureId}, ${r.orgId}, 'live', now() - interval '5 minutes', ${made.challengeId}, 'home',
            ${b.home.lichessId}, ${b.away.lichessId}, ${sql.json(moves)}, ${moves.length},
            ${moves.length > 0 ? new Date() : null})`;
  return made.challengeId;
}

/** Board API calls the settle sent (the setup's are cleared first by `since`). */
const boardCalls = (since: number) =>
  fx.calls.slice(since).filter((c) => c.path.startsWith("/api/board/")).map((c) => `${c.path.split("/").slice(5).join("/")} ${c.token}`);

/** What lila's game says once the settle's tail has run. */
const ending = (gameId: string) => {
  const g = fx.game(gameId)!;
  return { status: g.status, winner: g.winner };
};

describe.runIf(HAS_DB)("a settle ends the live Lichess game (M-9)", () => {
  // The brief's rules as a table: plies on file, the settle, and the game lila then holds. Home is White.
  const TABLE: { plies: number; kind: ResolveKind; ends: { status: string; winner: "white" | "black" | null } }[] = [
    { plies: 0, kind: "home_wins", ends: { status: "aborted", winner: null } },
    { plies: 0, kind: "away_wins", ends: { status: "aborted", winner: null } },
    { plies: 0, kind: "draw", ends: { status: "aborted", winner: null } },
    { plies: 0, kind: "no_result", ends: { status: "aborted", winner: null } },
    { plies: 1, kind: "home_wins", ends: { status: "aborted", winner: null } },
    { plies: 2, kind: "home_wins", ends: { status: "resign", winner: "white" } },
    { plies: 2, kind: "away_wins", ends: { status: "resign", winner: "black" } },
    { plies: 2, kind: "draw", ends: { status: "draw", winner: null } },
    { plies: 2, kind: "no_result", ends: { status: "draw", winner: null } },
    { plies: 4, kind: "away_wins", ends: { status: "resign", winner: "black" } },
  ];

  it("every row of the rules: the result is written, then lila's game ends the way the rule says — counted", async () => {
    let checked = 0;
    for (const row of TABLE) {
      const label = `${row.plies} plies, ${row.kind}`;
      const { r, b } = await round();
      const gameId = await liveGame(r, b, row.plies);
      const since = fx.calls.length;
      const tail = collector();
      expect(await resolveExternalPlay(r.owner, b.fixtureId, row.kind, { defer: tail.defer }), label).toEqual({ status: "finished" });
      expect(await tail.drain(), `${label}: one tail task`).toBe(1);
      expect(ending(gameId), label).toEqual(row.ends);
      expect(boardCalls(since).length, `${label}: it called Lichess`).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(TABLE.length);
  });

  it("who sends what: a winner's settle resigns with the LOSER's token; a draw is offered and accepted by both; an early board is aborted", async () => {
    const cases: [number, ResolveKind, (b: SeedRoundBoard) => string[]][] = [
      [2, "home_wins", (b) => [`resign ${token(b.away.lichessId)}`]],
      [2, "away_wins", (b) => [`resign ${token(b.home.lichessId)}`]],
      [2, "draw", (b) => [`draw/yes ${token(b.home.lichessId)}`, `draw/yes ${token(b.away.lichessId)}`]],
      [0, "home_wins", (b) => [`abort ${token(b.home.lichessId)}`]],
    ];
    let checked = 0;
    for (const [plies, kind, sends] of cases) {
      const { r, b } = await round();
      await liveGame(r, b, plies);
      const since = fx.calls.length;
      const tail = collector();
      await resolveExternalPlay(r.owner, b.fixtureId, kind, { defer: tail.defer });
      await tail.drain();
      expect(boardCalls(since), `${plies} ${kind}`).toEqual(sends(b));
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("our ledger behind Lichess (0 plies on file, 2 played): the abort is refused, so the rule's own ending follows — resign, or for a void a draw", async () => {
    let checked = 0;
    for (const [kind, ends] of [
      ["home_wins", { status: "resign", winner: "white" }],
      ["no_result", { status: "draw", winner: null }],
    ] as const) {
      const { r, b } = await round();
      const gameId = await liveGame(r, b, 2, 0);
      const tail = collector();
      await resolveExternalPlay(r.owner, b.fixtureId, kind, { defer: tail.defer });
      await tail.drain();
      expect(ending(gameId), kind).toEqual(ends);
      // The refused abort is not a failure — the ending followed — so nothing is logged.
      expect(warnCalls().filter((c) => JSON.stringify(c).includes(gameId)), kind).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("lila's draw rules: a standing offer is ACCEPTED by the other side alone; a side inside the re-offer window does not offer — the other one does", async () => {
    // A standing offer by Black, on file and at Lichess: White's yes ends it; a second yes would hit a game over.
    {
      const { r, b } = await round();
      const gameId = await liveGame(r, b, 2);
      expect((await lichess.offerOrAcceptDraw({ token: token(b.away.lichessId), gameId, accept: true })).ok).toBe(true);
      await sql`update fixture_external_play set draw_offer_by = 'black', black_draw_offer_ply = 2 where fixture_id = ${b.fixtureId}`;
      const since = fx.calls.length;
      const tail = collector();
      await resolveExternalPlay(r.owner, b.fixtureId, "draw", { defer: tail.defer });
      await tail.drain();
      expect(boardCalls(since), "White accepts; Black sends nothing").toEqual([`draw/yes ${token(b.home.lichessId)}`]);
      expect(ending(gameId)).toEqual({ status: "draw", winner: null });
      expect(warnCalls().filter((c) => JSON.stringify(c).includes(gameId)), "no failure").toEqual([]);
    }
    // White offered at ply 2 and Black's move declined it; at ply 4 White is inside lila's 20-ply window, so White's
    // yes would be a silent no-op and Black's would only offer. Black offers, White accepts.
    {
      const { r, b } = await round();
      const gameId = await liveGame(r, b, 2);
      expect((await lichess.offerOrAcceptDraw({ token: token(b.home.lichessId), gameId, accept: true })).ok).toBe(true);
      for (const [who, uci] of [[b.home, "g1f3"], [b.away, "b8c6"]] as const) {
        expect((await lichess.submitMove({ token: token(who.lichessId), gameId, uci })).ok, uci).toBe(true);
      }
      await sql`
        update fixture_external_play
           set moves_uci = ${sql.json(["e2e4", "e7e5", "g1f3", "b8c6"])}, move_count = 4, white_draw_offer_ply = 2
         where fixture_id = ${b.fixtureId}`;
      const since = fx.calls.length;
      const tail = collector();
      await resolveExternalPlay(r.owner, b.fixtureId, "draw", { defer: tail.defer });
      await tail.drain();
      expect(boardCalls(since)).toEqual([`draw/yes ${token(b.away.lichessId)}`, `draw/yes ${token(b.home.lichessId)}`]);
      expect(ending(gameId)).toEqual({ status: "draw", winner: null });
    }
    // Both inside the window: nobody may offer — nothing is sent, and the failure is logged.
    {
      const { r, b } = await round();
      const gameId = await liveGame(r, b, 2);
      await sql`update fixture_external_play set white_draw_offer_ply = 2, black_draw_offer_ply = 2 where fixture_id = ${b.fixtureId}`;
      const since = fx.calls.length;
      const tail = collector();
      await resolveExternalPlay(r.owner, b.fixtureId, "draw", { defer: tail.defer });
      await tail.drain();
      expect(boardCalls(since)).toEqual([]);
      const logged = warnCalls().filter((c) => JSON.stringify(c).includes(gameId));
      expect(logged).toHaveLength(1);
      expect(logged[0]![0]).toMatchObject({ gameId, step: "draw", code: "draw_offer_window" });
    }
  });

  it("a drawn KNOCKOUT game: the tie-break is owed, and lila's game is drawn all the same", async () => {
    const { r, b } = await round({ knockout: true });
    const gameId = await liveGame(r, b, 2);
    const tail = collector();
    expect(await resolveExternalPlay(r.owner, b.fixtureId, "draw", { defer: tail.defer })).toEqual({ status: "tiebreak_owed" });
    await tail.drain();
    expect(ending(gameId)).toEqual({ status: "draw", winner: null });
  });

  it("a failure is logged and never touches the settle: the loser's grant revoked at Lichess — the result stands, the game plays on, the log names the step and the code", async () => {
    const { r, b } = await round();
    const gameId = await liveGame(r, b, 2);
    fx.revokeToken(token(b.away.lichessId));
    const tail = collector();
    expect(await resolveExternalPlay(r.owner, b.fixtureId, "home_wins", { defer: tail.defer })).toEqual({ status: "finished" });
    await tail.drain();
    const [f] = await sql<{ status: string }[]>`select status from fixtures where id = ${b.fixtureId}`;
    expect(f!.status, "the settle stands").toBe("decided");
    expect(ending(gameId), "lila's game was not ended").toEqual({ status: "started", winner: null });
    const logged = warnCalls().filter((c) => JSON.stringify(c).includes(gameId));
    expect(logged, JSON.stringify(warn.mock.calls)).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ fixtureId: b.fixtureId, gameId, step: "resign", colour: "black", code: "unauthorized" });
    expect(JSON.stringify(logged), "never a token").not.toContain("lio_seed_");
  });

  it("the recorded account has no token here any more (unlinked): that seat's step is logged as skipped, nothing is sent for it", async () => {
    const { r, b } = await round();
    const gameId = await liveGame(r, b, 2);
    await sql`delete from user_external_accounts where user_id = ${b.away.userId} and provider = 'lichess'`;
    const since = fx.calls.length;
    const tail = collector();
    await resolveExternalPlay(r.owner, b.fixtureId, "home_wins", { defer: tail.defer });
    await tail.drain();
    expect(boardCalls(since)).toEqual([]);
    expect(ending(gameId)).toEqual({ status: "started", winner: null });
    const logged = warnCalls().filter((c) => JSON.stringify(c).includes(gameId));
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ gameId, step: "resign", colour: "black", code: "no_token" });
  });

  it("a no-show's default (the absent loser's walkover) on a game created but never moved: the game is aborted", async () => {
    const { r, b } = await round();
    const gameId = await liveGame(r, b, 0);
    await holdRefusedNoShow({ fixtureId: b.fixtureId, absent: "black", detail: "sweep: black never moved (TEST)" });
    const since = fx.calls.length;
    const tail = collector();
    expect(await resolveExternalPlay(r.owner, b.fixtureId, "home_wins", { defer: tail.defer })).toEqual({ status: "finished" });
    const ledger = await sql<{ type: string }[]>`select type from score_events where fixture_id = ${b.fixtureId} order by seq`;
    expect(ledger.map((e) => e.type), "premise: the default path, not an adjudication").toEqual(["core.forfeit"]);
    expect(await tail.drain()).toBe(1);
    expect(boardCalls(since)).toEqual([`abort ${token(b.home.lichessId)}`]);
    expect(ending(gameId)).toEqual({ status: "aborted", winner: null });
  });

  it("a token that cannot be opened (LICHESS_TOKEN_UNAVAILABLE) is that seat's no_token — logged, the settle stands", async () => {
    const { r, b } = await round();
    const gameId = await liveGame(r, b, 2);
    const since = fx.calls.length;
    const tail = collector();
    const accessToken = async () => {
      throw new Error("LICHESS_TOKEN_UNAVAILABLE (TEST)");
    };
    expect(await resolveExternalPlay(r.owner, b.fixtureId, "away_wins", { defer: tail.defer, lichess: { accessToken } })).toEqual({ status: "finished" });
    await tail.drain();
    expect(boardCalls(since)).toEqual([]);
    const logged = warnCalls().filter((c) => JSON.stringify(c).includes(gameId));
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ gameId, step: "resign", colour: "white", code: "no_token" });
  });

  it("nothing to end — no game on file (a no-show's walkover, a not-started hold), or one Lichess already ended — and no Lichess call is made, for any settle", async () => {
    let checked = 0;
    // A held board with no game: every settle kind the board takes.
    for (const kind of ["home_wins", "away_wins", "draw"] as const satisfies readonly ResolveKind[]) {
      const { r, b } = await round();
      await sql`insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis) values (${b.fixtureId}, ${r.orgId}, 'pending', now() - interval '5 minutes')`;
      await (kind === "draw" ? holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" }) : holdRefusedNoShow({ fixtureId: b.fixtureId, absent: "black", detail: "TEST" }));
      const since = fx.calls.length;
      const tail = collector();
      await resolveExternalPlay(r.owner, b.fixtureId, kind, { defer: tail.defer });
      expect(await tail.drain(), kind).toBe(0);
      expect(fx.calls.length - since, kind).toBe(0);
      checked += 1;
    }
    // A game Lichess already ended (reconcile stamped game_over_at): nothing left to end.
    const { r, b } = await round();
    await liveGame(r, b, 2);
    await sql`update fixture_external_play set game_over_at = now() where fixture_id = ${b.fixtureId}`;
    const since = fx.calls.length;
    const tail = collector();
    await resolveExternalPlay(r.owner, b.fixtureId, "home_wins", { defer: tail.defer });
    expect(await tail.drain()).toBe(0);
    expect(fx.calls.length - since).toBe(0);
    checked += 1;
    expect(checked).toBe(4);
    expect(RESOLVE_KINDS.length, "premise: the kinds this file names").toBe(5);
  });
});

