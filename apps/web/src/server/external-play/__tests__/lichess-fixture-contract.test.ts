// Task 17 (spec §8.7) — the Lichess fixture server is the e2e stand-in for
// lichess.org, so its OWN behaviour is a contract. Every expected value below
// is a MEASURED fact (spec §2 M-numbers, docs/superpowers/specs/evidence/
// 2026-10-09-chess-spikes/*.log, the recorded payloads in
// __fixtures__/lichess/) or a rule read from lila's source and cited where it
// is used — never a value read back out of the stub. A stub that drifts from
// these makes the walkthrough prove a Lichess that does not exist.
//
// Every board call goes through the REAL adapter (`createBoardApi`, pointed at
// the stub by `baseUrl`), so a shape the stub serves that our parser cannot
// read fails here, not in a browser. Raw fetches are used only where the
// adapter refuses to send the request at all (M5's malformed UCI, which
// `assertUci` stops before the wire).
//
// Anti-vacuity: the sweeps count what they checked and fail on zero.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess, type Square } from "chess.js";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LICHESS_FIXTURE_PORT,
  startLichessFixtureServer,
  type LichessFixtureServer,
} from "../../../../e2e/lichess-fixture-server";
import { createBoardApi } from "../lichess/board-api";

let fx: LichessFixtureServer;
let api: ReturnType<typeof createBoardApi>;
beforeAll(async () => {
  fx = await startLichessFixtureServer(0);
  api = createBoardApi({ baseUrl: fx.url });
});
afterAll(async () => {
  await fx.close();
});

// Two Lichess accounts and their bearer tokens. Lichess ids are lower-case
// usernames; the challenge path takes the username.
const W = { id: "ada", token: "tok-white" };
const B = { id: "bob", token: "tok-black" };
beforeEach(() => {
  fx.reset();
  fx.registerToken(W.token, W.id);
  fx.registerToken(B.token, B.id);
});

const EVIDENCE = join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "docs", "superpowers", "specs", "evidence", "2026-10-09-chess-spikes");
const RECORDED = join(import.meta.dirname, "..", "__fixtures__", "lichess");
const M6_BODY = { error: "Not your turn, or game already over" }; // spike-battery2.log §D, verbatim
const M12_BODY = { error: "This game cannot be played with the Board API." }; // spike-battery2.log §A, verbatim
const M3_BODY = { error: "Too many requests. Try again later." }; // b3-spike.log (2), verbatim
const BAD_LIMIT_BODY = { "clock.limit": ["Invalid value"], error: { "clock.limit": ["Invalid value"] } }; // tc-boundary.log

/** A game created and accepted through the REAL adapter — the product path. */
async function startGame(limitSeconds = 180, incrementSeconds = 0): Promise<string> {
  const made = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds, incrementSeconds });
  if (!made.ok) throw new Error(`create refused: ${made.code} ${made.raw}`);
  const acc = await api.acceptChallenge({ blackToken: B.token, challengeId: made.challengeId });
  if (!acc.ok) throw new Error(`accept refused: ${acc.code} ${acc.raw}`);
  return made.challengeId;
}

async function play(id: string, ...uci: string[]): Promise<void> {
  for (const [i, m] of uci.entries()) {
    const r = await api.submitMove({ token: i % 2 === 0 ? W.token : B.token, gameId: id, uci: m });
    if (!r.ok) throw new Error(`ply ${i + 1} ${m} refused: ${r.code} ${r.raw}`);
  }
}

const rawPost = (path: string, token: string) =>
  fetch(`${fx.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

describe("lichess fixture server — the measured facts", () => {
  it("empty case: a fresh stub has served nothing", () => {
    expect(fx.calls).toEqual([]);
  });

  it("listens on the fixed port the CI env names, unless a test asks for an ephemeral one", () => {
    // The CI wiring (e2e.yml, ci-local.sh) points the app at 127.0.0.1:4321;
    // 4319 is the AI fixture's, 12111 Stripe's.
    expect(LICHESS_FIXTURE_PORT).toBe(4321);
    expect(fx.port, "this suite asked for port 0").not.toBe(LICHESS_FIXTURE_PORT);
  });

  it("creation answers the challenge at the TOP level (T9 measured `id`, not {challenge:{id}}) and records the form", async () => {
    const made = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 300, incrementSeconds: 3 });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const call = fx.calls.find((c) => c.method === "POST" && c.path === `/api/challenge/${B.id}`);
    expect(call?.token).toBe(W.token);
    expect(call?.body).toMatchObject({ "clock.limit": "300", "clock.increment": "3", rated: "false", color: "white", variant: "standard" });
  });

  it("a fresh challenge is pending in the challenger's outgoing list (it leaves after ~30 s unaccepted: the OFFLINE case below), and once accepted the game is in BOTH players' ongoing lists", async () => {
    const made = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 300, incrementSeconds: 3 });
    if (!made.ok) throw new Error("create refused");
    const before = await api.listOutgoingChallenges(W.token);
    expect(before).toMatchObject({ ok: true });
    if (!before.ok) return;
    expect(before.challenges).toEqual([
      expect.objectContaining({
        id: made.challengeId, destUserId: B.id, status: "created", rated: false, variantKey: "standard",
        timeControl: { type: "clock", limit: 300, increment: 3 }, color: "white",
      }),
    ]);
    const noneYet = await api.listOngoingGames(W.token);
    expect(noneYet.ok && noneYet.games, "an unaccepted challenge is not an ongoing game (T9 measured)").toEqual([]);

    expect(await api.acceptChallenge({ blackToken: B.token, challengeId: made.challengeId })).toEqual({ ok: true });
    const after = await api.listOutgoingChallenges(W.token);
    expect(after.ok && after.challenges, "an accepted challenge leaves the outgoing list").toEqual([]);
    const w = await api.listOngoingGames(W.token);
    const b = await api.listOngoingGames(B.token);
    // T9 measured: gameId EQUALS the challenge id; colour from the caller's side.
    expect(w.ok && w.games).toEqual([{ gameId: made.challengeId, color: "white", opponentId: B.id }]);
    expect(b.ok && b.games).toEqual([{ gameId: made.challengeId, color: "black", opponentId: W.id }]);

    const meta = await api.exportGameMeta(made.challengeId);
    expect(meta.ok && meta.meta).toMatchObject({
      gameId: made.challengeId, rated: false, variant: "standard", clockInitialSeconds: 300, clockIncrementSeconds: 3,
    });
    expect(meta.ok && typeof meta.meta.createdAtMs).toBe("number");
  });

  it("M5: a malformed UCI is ACCEPTED and TRUNCATED, not rejected (spike-battery2.log §D: e7e6xx -> 200, e6 played)", async () => {
    const id = await startGame();
    await play(id, "e2e4");
    // Raw: our adapter's assertUci refuses e7e6xx before the wire (that is
    // the point of M5), so only a raw request can show what Lichess does.
    const bad = await rawPost(`/api/board/game/${id}/move/e7e6xx`, B.token);
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ ok: true });
    const read = await api.readGameStream({ token: W.token, gameId: id });
    expect(read.ok && read.game.movesUci).toEqual(["e2e4", "e7e6"]);
  });

  // I1 (T17 review): the stub used to test an always-truthy object, so an illegal move answered 200 and still stamped a
  // clock entry — which shifts every later M11 clock onto the wrong side. Lichess refuses an illegal move; its body is
  // not measured, so the stub's is a named `fixture:` 400 (header).
  it("I1: an ILLEGAL move is refused with a 400, and changes nothing — moves, the export's clocks, lastMoveAt", async () => {
    const id = await startGame(300, 3);
    await play(id, "e2e4", "e7e5", "g1f3");
    const exportOf = async () => (await (await fetch(`${fx.url}/game/export/${id}`)).json()) as { moves: string; clocks: number[]; lastMoveAt: number };
    const before = await exportOf();
    expect(before.clocks, "premise: one clock per ply").toHaveLength(3);
    // Black's king two squares forward: the syntax is fine (assertUci passes it), the position refuses it.
    const r = await api.submitMove({ token: B.token, gameId: id, uci: "e8e6" });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.raw).toContain("fixture: illegal move");
    const raw = await rawPost(`/api/board/game/${id}/move/e8e6`, B.token);
    expect(raw.status).toBe(400);
    const read = await api.readGameStream({ token: W.token, gameId: id });
    expect(read.ok && read.game.movesUci).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(await exportOf(), "moves, clocks and lastMoveAt as they were").toEqual(before);
    // The next legal move is still Black's, and its clock lands as the 4th entry — still one per ply.
    expect(await api.submitMove({ token: B.token, gameId: id, uci: "b8c6" })).toEqual({ ok: true });
    const after = await exportOf();
    expect(after.moves.split(" ")).toHaveLength(4);
    expect(after.clocks).toHaveLength(4);
  });

  // M1 (T17 review): DERIVED FROM SOURCE, not measured — scalachess core/src/main/scala/format/Uci.scala:42 reads the
  // fifth character as `move.lift(4).flatMap(Role.promotable)`, so a non-promotable one is None and the pawn queens
  // (the same rule that queens a bare `b7a8`). Raw: our adapter's assertUci refuses `b7a8x` before the wire.
  it("M1: a junk suffix on a promotion is dropped and the pawn queens — b7a8x is played as b7a8q", async () => {
    const id = await startGame();
    await play(id, "a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "h7h6");
    const r = await rawPost(`/api/board/game/${id}/move/b7a8x`, W.token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const read = await api.readGameStream({ token: B.token, gameId: id });
    expect(read.ok && read.game.movesUci.at(-1)).toBe("b7a8q");
    expect(read.ok && read.game.movesUci).toHaveLength(9);
  });

  it("M6: out-of-turn and game-over answer ONE 400 body, verbatim — the stub does not disambiguate them either", async () => {
    const id = await startGame();
    await play(id, "e2e4");
    const outOfTurn = await rawPost(`/api/board/game/${id}/move/d2d4`, W.token);
    expect(outOfTurn.status).toBe(400);
    expect(await outOfTurn.json()).toEqual(M6_BODY);
    // Through the adapter, the class our server acts on.
    expect(await api.submitMove({ token: W.token, gameId: id, uci: "d2d4" })).toMatchObject({ ok: false, code: "not_your_turn_or_over" });

    expect(await api.submitMove({ token: B.token, gameId: id, uci: "e7e5" })).toEqual({ ok: true });
    expect(await api.resignGame({ token: W.token, gameId: id })).toEqual({ ok: true });
    const over = await rawPost(`/api/board/game/${id}/move/g1f3`, W.token);
    expect(over.status).toBe(400);
    expect(await over.json(), "game over: the SAME body as out-of-turn").toEqual(M6_BODY);
  });

  it("M12: the time-control boundary (tc-boundary.log): 120+1 is created and then every move refused; 180+0 plays", async () => {
    // Measured: 120+1 (est. 160 s, Lichess speed bullet) — move 400 M12;
    // 180+0 (est. 180 s, blitz) — move 200. 60+0 likewise refused (§A).
    for (const [limit, inc, playable] of [[120, 1, false], [60, 0, false], [180, 0, true]] as const) {
      fx.reset();
      fx.registerToken(W.token, W.id);
      fx.registerToken(B.token, B.id);
      const id = await startGame(limit, inc);
      const res = await rawPost(`/api/board/game/${id}/move/e2e4`, W.token);
      if (playable) {
        expect(res.status, `${limit}+${inc}`).toBe(200);
      } else {
        expect(res.status, `${limit}+${inc}: creation succeeded, the move is refused`).toBe(400);
        expect(await res.json()).toEqual(M12_BODY);
        expect(await api.submitMove({ token: W.token, gameId: id, uci: "e2e4" })).toMatchObject({ code: "unplayable_time_control" });
      }
    }
  });

  it("a clock limit Lichess does not offer is refused at creation with its own body (tc-boundary.log: 170 and 140)", async () => {
    for (const limit of [170, 140]) {
      const res = await fetch(`${fx.url}/api/challenge/${B.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${W.token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "clock.limit": String(limit), "clock.increment": "0" }).toString(),
      });
      expect(res.status, String(limit)).toBe(400);
      expect(await res.json()).toEqual(BAD_LIMIT_BODY);
    }
  });

  it("M3: creation is rate-limited once the budget is spent, with Lichess's own 429 body (b3-spike.log (2): 5 x 200, then 429)", async () => {
    fx.setCreateBudget(5, 60_000);
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 180, incrementSeconds: 0 });
      codes.push(r.ok ? "ok" : r.code);
      if (!r.ok) expect(JSON.parse(r.raw)).toEqual(M3_BODY);
    }
    expect(codes).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited", "rate_limited"]);
    // A refused create is still a recorded call: the walkthrough's
    // "no challenge before the open" assertion depends on that.
    expect(fx.calls.filter((c) => c.method === "POST" && c.path === `/api/challenge/${B.id}`)).toHaveLength(7);
  });

  it("M9: a resign on ply ONE is an abort with NO winner key; on ply TWO it is a resign won by the other side (spike-battery2.log §B, §D)", async () => {
    const early = await startGame();
    await play(early, "e2e4");
    expect(await api.resignGame({ token: W.token, gameId: early })).toEqual({ ok: true });
    const a = (await (await fetch(`${fx.url}/game/export/${early}`)).json()) as Record<string, unknown>;
    expect(a.status).toBe("aborted");
    expect("winner" in a, "Lichess OMITS winner rather than sending null (fixtures README)").toBe(false);

    const late = await startGame();
    await play(late, "e2e4", "e7e6");
    expect(await api.resignGame({ token: W.token, gameId: late })).toEqual({ ok: true });
    const snap = await api.exportGame(late);
    expect(snap).toMatchObject({ status: "resign", winner: "black", movesSan: ["e4", "e6"] });
  });

  it("M11: the export's `clocks` is CENTISECONDS, one entry PER PLY, beside a seconds `clock` envelope with totalTime = limit + 40 x increment", async () => {
    const id = await startGame(180, 2);
    await play(id, "e2e4", "e7e5");
    const body = (await (await fetch(`${fx.url}/game/export/${id}?clocks=true&pgnInJson=false`)).json()) as {
      clocks: number[]; clock: { initial: number; increment: number; totalTime: number }; moves: string;
    };
    // export-mid.json: the first two plies cost nothing (the clock is not
    // running until both have moved), so both entries are the initial
    // 180 s = 18000 cs. A stub that emitted ms would make our conversion
    // look right while being 10x wrong.
    expect(body.clocks).toEqual([18_000, 18_000]);
    expect(body.clock).toEqual({ initial: 180, increment: 2, totalTime: 180 + 40 * 2 });
    expect(body.moves, "the export speaks SAN (export-mid.json)").toBe("e4 e5");
    const snap = await api.exportGame(id);
    expect(snap?.whiteMs).toBe(180_000);
    expect(snap?.blackMs).toBe(180_000);
  });

  // M5 (T17 review): the walkthrough compares the bridge row's clocks with the stub's game() view, so the view must be
  // the stream's clock re-expressed as at the last move — exact for the side NOT to move, an upper bound for the mover.
  it("the game() view's clockMs is the stream's clock as at lastMoveAt: equal for the waiting side, never below the mover's", async () => {
    const id = await startGame(300, 3);
    await play(id, "e2e4", "e7e5");
    const stream = async () => {
      const r = await api.readGameStream({ token: W.token, gameId: id });
      if (!r.ok) throw new Error("stream refused");
      return r.game;
    };
    // Two plies cost nothing, so both sides hold the whole limit (the rulebook's 300 s) as at the last move; from
    // here White's clock runs (scalachess Clock.step), so the stream reads White at or under it.
    expect(fx.game(id)?.clockMs).toEqual({ white: 300_000, black: 300_000 });
    const two = await stream();
    expect(two.blackMs, "the waiting side").toBe(300_000);
    expect(two.whiteMs, "the mover").toBeLessThanOrEqual(300_000);
    await new Promise((r) => setTimeout(r, 30));
    await play(id, "g1f3");
    // Black to move: White's reading is exact (paid its 30+ ms, earned 3 s), Black's runs from lastMoveAt.
    const v = fx.game(id)!;
    const three = await stream();
    expect(three.whiteMs, "the waiting side: the view IS the stream").toBe(v.clockMs.white);
    expect(v.clockMs.white, "paid the pause, earned the 3 s increment").toBeGreaterThan(300_000);
    expect(v.clockMs.white).toBeLessThanOrEqual(303_000 - 30);
    expect(three.blackMs, "the mover: counted down from lastMoveAt").toBeLessThanOrEqual(v.clockMs.black);
    expect(v.clockMs.black).toBe(300_000);
  });

  it("M16: an export of a game in play withholds the last 3 plies once past 5 (8 on the board, 5 exported — export-mid.json beside gamefull-mid-*.ndjson)", async () => {
    const id = await startGame();
    const eight = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"];
    await play(id, ...eight);
    const stream = await api.readGameStream({ token: W.token, gameId: id });
    expect(stream.ok && stream.game.movesUci).toEqual(eight);
    const snap = await api.exportGame(id);
    expect(snap?.movesSan).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    // Finished, the export is whole (export-expired.json: 8 plies).
    await api.resignGame({ token: B.token, gameId: id });
    expect((await api.exportGame(id))?.movesSan).toHaveLength(8);
  });

  it("the board stream's first line is a gameFull our reader parses, through EITHER player's token, and refuses a stranger", async () => {
    const id = await startGame(300, 3);
    await play(id, "e2e4", "e7e5");
    for (const token of [W.token, B.token]) {
      const read = await api.readGameStream({ token, gameId: id });
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (!read.ok) continue;
      expect(read.game).toMatchObject({
        gameId: id, whiteId: W.id, blackId: B.id, movesUci: ["e2e4", "e7e5"], status: "started", winner: null,
        incrementMs: 3_000, drawOffer: { white: false, black: false },
      });
      // Two plies in, neither side has PAID for a move (scalachess Clock:
      // the first two plies cost nothing), so Black — not to move — holds
      // exactly 300 s; White's clock is running now and reads at most that
      // (gamefull-mid-white.ndjson: the mover's wtime ticks below initial).
      expect(read.game.blackMs).toBe(300_000);
      expect(read.game.whiteMs).toBeLessThanOrEqual(300_000);
      expect(read.game.whiteMs).toBeGreaterThan(300_000 - 5_000);
    }
    fx.registerToken("tok-stranger", "carol");
    const stranger = await api.readGameStream({ token: "tok-stranger", gameId: id });
    expect(stranger.ok).toBe(false);
  });

  it("a read SETTLES an expired clock, visible on the NEXT read (gamefull-expired-1 then -2, measured 2026-10-11)", async () => {
    const id = await startGame();
    const eight = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"];
    await play(id, ...eight);
    // White is to move; its clock runs out with nobody reading.
    fx.expireClock(id);
    const recorded1 = JSON.parse(readFileSync(join(RECORDED, "gamefull-expired-1.ndjson"), "utf8")).state;
    const recorded2 = JSON.parse(readFileSync(join(RECORDED, "gamefull-expired-2.ndjson"), "utf8")).state;
    const first = await api.readGameStream({ token: B.token, gameId: id });
    expect(first.ok && first.game.status).toBe(recorded1.status); // started
    expect(first.ok && first.game.whiteMs).toBe(recorded1.wtime); // 0
    expect(first.ok && first.game.winner).toBeNull();
    const second = await api.readGameStream({ token: B.token, gameId: id });
    expect(second.ok && second.game.status).toBe(recorded2.status); // outoftime
    expect(second.ok && second.game.winner).toBe(recorded2.winner); // black
    // README: the export then agrees, and is complete.
    const snap = await api.exportGame(id);
    expect(snap).toMatchObject({ status: "outoftime", winner: "black" });
    expect(snap?.movesSan).toHaveLength(8);
  });

  it("M10: a pending draw offer shows in the stream (wdraw) and NOWHERE in the export; the other side's yes draws it", async () => {
    const id = await startGame();
    await play(id, "e2e4", "e7e5");
    expect(await api.offerOrAcceptDraw({ token: W.token, gameId: id, accept: true })).toEqual({ ok: true });
    const pending = await api.readGameStream({ token: B.token, gameId: id });
    expect(pending.ok && pending.game.drawOffer).toEqual({ white: true, black: false });
    const raw = await (await fetch(`${fx.url}/game/export/${id}`)).text();
    expect(raw, "export-live-clocks.json: no draw-offer field while one stands").not.toMatch(/draw/i);
    expect(JSON.parse(raw).status).toBe("started");
    expect(await api.offerOrAcceptDraw({ token: B.token, gameId: id, accept: true })).toEqual({ ok: true });
    const done = (await (await fetch(`${fx.url}/game/export/${id}`)).json()) as Record<string, unknown>;
    expect(done.status).toBe("draw"); // spike-battery2.log §E
    expect("winner" in done).toBe(false);
  });

  // I2 (T17 review): the draw rules as MEASURED live (t17-live-lichess.md §2, 2026-10-13; lila BotPlayer.scala:84-90 /
  // Game.playerCanOfferDraw agree). Every call answers 200 {"ok":true} — the stream's wdraw/bdraw is the only witness.
  const offers = async (id: string) => {
    const r = await api.readGameStream({ token: B.token, gameId: id });
    if (!r.ok) throw new Error("stream refused");
    return r.game.drawOffer;
  };
  const drawCall = (id: string, by: { token: string }, accept: boolean) => api.offerOrAcceptDraw({ token: by.token, gameId: id, accept });

  it("I2 'no (offerer)' / 'no (opponent)': the offerer's own draw/no leaves the offer standing; the opponent's clears it", async () => {
    const id = await startGame();
    await play(id, "e2e4", "e7e5");
    expect(await drawCall(id, W, true)).toEqual({ ok: true });
    expect(await offers(id)).toEqual({ white: true, black: false });
    expect(await drawCall(id, W, false), "200 either way").toEqual({ ok: true });
    expect(await offers(id), "the offerer's no is a no-op").toEqual({ white: true, black: false });
    expect(await drawCall(id, B, false)).toEqual({ ok: true });
    expect(await offers(id), "the opponent's no declines it").toEqual({ white: false, black: false });
  });

  it("I2 'a'–'d': no offer before ply 2; a re-offer within 20 plies of the side's last offer is a silent no-op — refused at 4 and at 22, allowed at 23 (2 < 23 - 20)", async () => {
    // A Ruy Lopez main line: 23 plies and no position repeated.
    const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5",
      "a4b3", "d7d6", "c2c3", "e8g8", "h2h3", "c6b8", "d2d4", "b8d7", "b1d2", "c8b7", "b3c2"];
    const id = await startGame(900, 10);
    // a, b: no offer before ply 2, from either side — and a no-op there is not recorded as an offer (c, below).
    expect(await drawCall(id, W, true)).toEqual({ ok: true });
    expect(await offers(id), "ply 0: no-op").toEqual({ white: false, black: false });
    expect(await api.submitMove({ token: W.token, gameId: id, uci: LINE[0]! })).toEqual({ ok: true });
    expect(await drawCall(id, W, true)).toEqual({ ok: true });
    expect(await drawCall(id, B, true)).toEqual({ ok: true });
    expect(await offers(id), "ply 1: no-op for both").toEqual({ white: false, black: false });
    expect(await api.submitMove({ token: B.token, gameId: id, uci: LINE[1]! })).toEqual({ ok: true });
    expect(await drawCall(id, W, true)).toEqual({ ok: true });
    expect(await offers(id), "ply 2: offered").toEqual({ white: true, black: false });
    expect(await api.submitMove({ token: W.token, gameId: id, uci: LINE[2]! })).toEqual({ ok: true });
    expect(await offers(id), "e1: White's own move keeps White's offer").toEqual({ white: true, black: false });
    expect(await api.submitMove({ token: B.token, gameId: id, uci: LINE[3]! })).toEqual({ ok: true });
    expect(await offers(id), "e2: Black's move declined it").toEqual({ white: false, black: false });
    expect(await drawCall(id, W, true), "ply 4: 200").toEqual({ ok: true });
    expect(await offers(id), "ply 4: no-op (2 >= 4 - 20)").toEqual({ white: false, black: false });
    expect(await drawCall(id, B, true)).toEqual({ ok: true });
    expect(await offers(id), "c: Black never offered, so Black may").toEqual({ white: false, black: true });
    expect(await drawCall(id, B, false)).toEqual({ ok: true });
    expect(await offers(id), "Black's own no: still standing").toEqual({ white: false, black: true });
    for (const [i, m] of LINE.slice(4, 22).entries()) {
      const r = await api.submitMove({ token: (4 + i) % 2 === 0 ? W.token : B.token, gameId: id, uci: m });
      if (!r.ok) throw new Error(`ply ${5 + i} ${m} refused: ${r.code} ${r.raw}`);
    }
    expect(await offers(id), "White's move at ply 5 declined Black's offer").toEqual({ white: false, black: false });
    expect(await drawCall(id, W, true)).toEqual({ ok: true });
    expect(await offers(id), "ply 22: no-op (2 >= 22 - 20)").toEqual({ white: false, black: false });
    expect(await api.submitMove({ token: W.token, gameId: id, uci: LINE[22]! })).toEqual({ ok: true });
    expect(await drawCall(id, W, true)).toEqual({ ok: true });
    expect(await offers(id), "ply 23: allowed (2 < 23 - 20), on the opponent's turn").toEqual({ white: true, black: false });
  });

  it("a checkmate ends the game as `mate`, won by the mover", async () => {
    const id = await startGame();
    await play(id, "f2f3", "e7e5", "g2g4", "d8h4"); // fool's mate
    expect(await api.exportGame(id)).toMatchObject({ status: "mate", winner: "black" });
  });

  it("lila's move reading: e1h1 castles (lands e1g1), and a promotion without a suffix is a queen", async () => {
    // lila source (implementer memory, "Lichess semantics"): Board API
    // `e1h1` is a king-takes-own-rook castle; a bare `e7e8` auto-queens.
    const id = await startGame();
    await play(id, "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1h1");
    const read = await api.readGameStream({ token: W.token, gameId: id });
    expect(read.ok && read.game.movesUci.at(-1)).toBe("e1g1");

    const promo = await startGame();
    await play(promo, "a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "h7h6");
    expect(await api.submitMove({ token: W.token, gameId: promo, uci: "b7a8" })).toEqual({ ok: true });
    const after = await api.readGameStream({ token: B.token, gameId: promo });
    expect(after.ok && after.game.movesUci.at(-1)).toBe("b7a8q");
  });

  it("GET /api/challenge serves the LIVE shape (T17 probe, challenge-list-{white,black}.json): every key at every depth with the recorded types, no createdAt, and the recorded values for a 10+0 create", async () => {
    // The recording is a 600+0 create; the stub is driven the same way, so
    // every value our create decides can be compared, not just the keys.
    const made = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 600, incrementSeconds: 0 });
    if (!made.ok) throw new Error(`create refused: ${made.code}`);
    const listOf = async (token: string) =>
      (await (await fetch(`${fx.url}/api/challenge`, { headers: { Authorization: `Bearer ${token}` } })).json()) as
        { in: Record<string, unknown>[]; out: Record<string, unknown>[] };
    const recorded = {
      white: JSON.parse(readFileSync(join(RECORDED, "challenge-list-white.json"), "utf8")) as Awaited<ReturnType<typeof listOf>>,
      black: JSON.parse(readFileSync(join(RECORDED, "challenge-list-black.json"), "utf8")) as Awaited<ReturnType<typeof listOf>>,
    };
    const served = { white: await listOf(W.token), black: await listOf(B.token) };
    /** Every key path with its JSON type — the shape, independent of values. */
    const shape = (v: unknown, at = "$"): string[] =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.entries(v).flatMap(([k, x]) => [`${at}.${k}:${x === null ? "null" : typeof x}`, ...shape(x, `${at}.${k}`)]).sort()
        : [];
    // What a create decides, read from the RECORDED entry — never from the stub.
    const decided = (e: Record<string, unknown>) => {
      const { status, rated, variant, speed, timeControl, color, finalColor, perf, direction } = e as Record<string, Record<string, unknown>>;
      return { status, rated, variant, speed, timeControl, color, finalColor, perfName: perf?.name, direction };
    };
    let checked = 0;
    for (const [who, list, side, empty] of [
      ["white", "white", "out", "in"], ["black", "black", "in", "out"],
    ] as const) {
      const rec = recorded[list][side];
      const got = served[who][side];
      expect(rec.length, `premise: the recording has one ${side} entry for ${who}`).toBe(1);
      expect(got, `${who} ${side}[]`).toHaveLength(1);
      expect(served[who][empty], `${who} ${empty}[]`).toEqual([]);
      expect(got[0], `${who}: Lichess never sends createdAt`).not.toHaveProperty("createdAt");
      expect(shape(got[0]), `${who}: the live key set and types`).toEqual(shape(rec[0]));
      expect(decided(got[0]!), `${who}: the values a 10+0 create decides`).toEqual(decided(rec[0]!));
      expect(got[0]).toMatchObject({ id: made.challengeId, challenger: { id: W.id }, destUser: { id: B.id } });
      checked++;
    }
    expect(checked, "zero lists checked is a FAILURE").toBe(2);
  });

  it("an unaccepted challenge goes OFFLINE (T17 probe): listed at +2 s, gone from BOTH lists by +36 s — and still acceptable at +34 s, still cancellable after", async () => {
    // Measured (t17-live-lichess.md §1; calls.log): created 08:42:56, listed
    // 08:42:58, out[] empty 08:43:32, cancelled 08:43:40 → 200; a second read
    // `offline` at +32 s and was accepted at +34 s → 200, the game started.
    // Only Date is faked — the stub reads Date.now() per request.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const listed = async () => {
        const w = await api.listOutgoingChallenges(W.token);
        const b = (await (await fetch(`${fx.url}/api/challenge`, { headers: { Authorization: `Bearer ${B.token}` } })).json()) as { in: unknown[] };
        return { out: w.ok ? w.challenges.map((c) => c.id) : null, in: b.in.length };
      };
      const c1 = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 600, incrementSeconds: 0 });
      if (!c1.ok) throw new Error("create refused");
      vi.setSystemTime(t0 + 2_000);
      expect(await listed(), "+2 s: listed").toEqual({ out: [c1.challengeId], in: 1 });
      vi.setSystemTime(t0 + 36_000);
      expect(await listed(), "+36 s: gone from both lists").toEqual({ out: [], in: 0 });
      expect(await api.cancelChallenge({ token: W.token, challengeId: c1.challengeId }), "+44 s cancel of an offline challenge").toEqual({ ok: true });
      expect(fx.game(c1.challengeId)?.status).toBe("canceled");

      const t1 = Date.now();
      const c2 = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 600, incrementSeconds: 0 });
      if (!c2.ok) throw new Error("create refused");
      vi.setSystemTime(t1 + 34_000);
      expect((await listed()).out, "+34 s: not listed").toEqual([]);
      expect(await api.acceptChallenge({ blackToken: B.token, challengeId: c2.challengeId }), "+34 s accept of an offline challenge").toEqual({ ok: true });
      const playing = await api.listOngoingGames(W.token);
      expect(playing.ok && playing.games).toEqual([{ gameId: c2.challengeId, color: "white", opponentId: B.id }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort before both have moved; cancel withdraws a pending challenge and aborts an accepted, unplayed game (T9 measured)", async () => {
    const id = await startGame();
    expect(await api.abortGame({ token: B.token, gameId: id })).toEqual({ ok: true });
    expect((await api.exportGame(id))?.status).toBe("aborted");

    const pending = await api.createChallengeToUser({ whiteToken: W.token, blackUsername: B.id, limitSeconds: 180, incrementSeconds: 0 });
    if (!pending.ok) throw new Error("create refused");
    expect(await api.cancelChallenge({ token: W.token, challengeId: pending.challengeId })).toEqual({ ok: true });
    const out = await api.listOutgoingChallenges(W.token);
    expect(out.ok && out.challenges).toEqual([]);

    const accepted = await startGame();
    expect(await api.cancelChallenge({ token: W.token, challengeId: accepted })).toEqual({ ok: true });
    const ongoing = await api.listOngoingGames(W.token);
    expect(ongoing.ok && ongoing.games, "the cancelled game left White's ongoing list").toEqual([]);
  });

  it("401s every call bearing a revoked token, per token, and records the refused call first", async () => {
    const id = await startGame();
    fx.revokeToken(W.token);
    const before = fx.calls.length;
    expect(await api.submitMove({ token: W.token, gameId: id, uci: "e2e4" })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(fx.calls.length, "the refused call is still on the record").toBe(before + 1);
    expect(fx.calls.at(-1)?.token).toBe(W.token);
    const stream = await api.readGameStream({ token: W.token, gameId: id });
    expect(stream).toMatchObject({ ok: false, code: "unauthorized" });
    const res = await rawPost(`/api/board/game/${id}/resign`, W.token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "No such token" });
    // Per token, not per game: Black still reads.
    expect((await api.readGameStream({ token: B.token, gameId: id })).ok).toBe(true);
  });

  it("an unregistered bearer is refused like a revoked one — a misconfigured token never plays", async () => {
    const id = await startGame();
    const res = await rawPost(`/api/board/game/${id}/move/e2e4`, "tok-nobody");
    expect(res.status).toBe(401);
  });

  it("an unexpected route names itself instead of answering something plausible", async () => {
    const res = await fetch(`${fx.url}/api/stream/event`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("fixture: unhandled GET /api/stream/event");
    expect(fx.calls.at(-1)).toMatchObject({ method: "GET", path: "/api/stream/event" });
  });
});

describe("recorded payloads, through the REAL parser (§8.7)", () => {
  it("every recorded export parses through exportGame and keeps its status", async () => {
    const files = readdirSync(RECORDED).filter((f) => f.startsWith("export-") && f.endsWith(".json"));
    let checked = 0;
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(RECORDED, f), "utf8")) as Record<string, unknown>;
      fx.serveRawExport(String(raw.id), raw);
      const snap = await api.exportGame(String(raw.id));
      expect(snap, `${f} did not parse`).not.toBeNull();
      expect(snap?.status, `${f} lost its status`).toBe(raw.status);
      checked++;
    }
    expect(checked, "zero recorded exports checked is a FAILURE").toBeGreaterThan(0);
    expect(checked).toBe(files.length);
  });

  it("every recorded gameFull line parses through readGameStream and keeps its moves and status", async () => {
    const files = readdirSync(RECORDED).filter((f) => f.startsWith("gamefull-") && f.endsWith(".ndjson"));
    let checked = 0;
    for (const f of files) {
      const text = readFileSync(join(RECORDED, f), "utf8");
      const rec = JSON.parse(text) as { id: string; state: { moves: string; status: string; wtime: number } };
      fx.serveRawStream(rec.id, text);
      const read = await api.readGameStream({ token: W.token, gameId: rec.id });
      expect(read.ok, `${f}: ${JSON.stringify(read)}`).toBe(true);
      if (!read.ok) continue;
      expect(read.game.movesUci.join(" ")).toBe(rec.state.moves);
      expect(read.game.status).toBe(rec.state.status);
      expect(read.game.whiteMs, "gameFull clocks are ALREADY ms (wtime 175220 at 3+0)").toBe(rec.state.wtime);
      checked++;
    }
    expect(checked, "zero recorded gameFull lines checked is a FAILURE").toBeGreaterThan(0);
    expect(checked).toBe(files.length);
  });

  it("centiseconds become milliseconds exactly once (export-live-clocks.json, recorded M11)", async () => {
    const raw = JSON.parse(readFileSync(join(RECORDED, "export-live-clocks.json"), "utf8")) as {
      id: string; clock: { initial: number }; clocks: number[];
    };
    fx.serveRawExport(raw.id, raw);
    const snap = await api.exportGame(raw.id);
    // Derived from the UNIT and the recorded envelope, never from the reader:
    // two plies in, each side still holds its initial 600 s = 600_000 ms. A
    // reader that forgot the x10 gives 60_000; one that applied it twice,
    // 6_000_000.
    const expectedMs = raw.clock.initial * 1000;
    expect(raw.clocks.every((cs) => cs * 10 === expectedMs), "premise: the recorded cs equal the initial").toBe(true);
    expect(snap?.whiteMs).toBe(expectedMs);
    expect(snap?.blackMs).toBe(expectedMs);
  });

  it("the stub's own measured bodies are the ones in the evidence logs, byte for byte", () => {
    const battery = readFileSync(join(EVIDENCE, "spike-battery2.log"), "utf8");
    const b3 = readFileSync(join(EVIDENCE, "b3-spike.log"), "utf8");
    const tc = readFileSync(join(EVIDENCE, "tc-boundary.log"), "utf8");
    let checked = 0;
    for (const [log, body] of [[battery, M6_BODY], [battery, M12_BODY], [b3, M3_BODY], [tc, BAD_LIMIT_BODY]] as const) {
      expect(log.includes(JSON.stringify(body)), JSON.stringify(body)).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ─── The ordered action sequence is the surface: a property ──────────────────
//
// A tiny model of the MEASURED rules, written here and nowhere near the stub:
// moves alternate (M6 refuses the other side's and any move after the end);
// an illegal move by the side to move is refused and changes nothing (I1); a
// resign before ply 2 aborts with no winner, from ply 2 the other side wins
// (M9); an abort is allowed before ply 2 (lila `abortable`). Draws follow the
// LIVE table (t17-live-lichess.md §2, 2026-10-13): no offer before ply 2; a yes
// to the opponent's standing offer draws (spike §E); a yes while one's own
// offer stands, or within 20 plies of one's last offer, is a no-op; `no`
// declines only the opponent's offer; a move declines the opponent's offer
// and keeps the mover's own. Legal moves come from chess.js, an independent
// library, on the model's own board.
type Act =
  | { kind: "move" | "illegal"; by: "white" | "black"; pick: number }
  | { kind: "resign" | "abort" | "drawYes" | "drawNo"; by: "white" | "black" };

const side = fc.constantFrom("white" as const, "black" as const);
const actArb: fc.Arbitrary<Act> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("move" as const), by: side, pick: fc.nat(40) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("illegal" as const), by: side, pick: fc.nat(4095) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("drawYes" as const), by: side }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("drawNo" as const), by: side }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom("resign" as const, "abort" as const), by: side }) },
);

const FILES = "abcdefgh";
const SQUARES = [...FILES].flatMap((f) => [1, 2, 3, 4, 5, 6, 7, 8].map((r) => `${f}${r}`));
/** A move the rules refuse on `board`: no legal move shares its from/to, and it is not a king onto its own rook (which
 *  lila reads as a castle). Syntactically valid UCI, so our adapter sends it. */
function illegalOn(board: Chess, pick: number): string {
  const legal = new Set(board.moves({ verbose: true }).map((m) => m.from + m.to));
  for (let i = 0; i < 64 * 64; i++) {
    const n = (pick + i) % (64 * 64);
    const from = SQUARES[Math.floor(n / 64)]!;
    const to = SQUARES[n % 64]!;
    if (from === to || legal.has(from + to)) continue;
    const piece = board.get(from as Square);
    const target = board.get(to as Square);
    if (piece?.type === "k" && target?.type === "r" && target.color === piece.color) continue;
    return from + to;
  }
  throw new Error("illegalOn: no illegal move found");
}

type Paths = { illegalRefused: number; offered: number; accepted: number; ownOfferNoKept: number; windowNoOp: number; opponentNoCleared: number };
type Ends = { resign: number; aborted: number; draw: number; mate: number; running: number };

/** Plays `acts` against a fresh game through the real adapter and checks the stub against the model after EVERY
 *  action; counts the model paths it took into `paths` and how the game ended into `ends`. */
async function runActs(acts: Act[], paths: Paths, ends: Ends): Promise<number> {
  fx.reset();
  fx.registerToken(W.token, W.id);
  fx.registerToken(B.token, B.id);
  const id = await startGame();
  const board = new Chess();
  const model = { status: "started", winner: null as null | "white" | "black", offer: null as null | "white" | "black", plies: [] as string[] };
  const lastOffer: Record<"white" | "black", number | null> = { white: null, black: null };
  const tok = (c: "white" | "black") => (c === "white" ? W.token : B.token);
  const other = (c: "white" | "black") => (c === "white" ? "black" : "white");
  let actions = 0;
  for (const a of acts) {
    actions++;
    const over = model.status !== "started";
    const turn = board.turn() === "w" ? "white" : "black";
    if (a.kind === "move" || a.kind === "illegal") {
      const legal = board.moves({ verbose: true });
      const mv = a.kind === "move" ? legal[a.pick % Math.max(1, legal.length)] : undefined;
      const uci = a.kind === "illegal" ? illegalOn(board, a.pick) : mv ? mv.from + mv.to + (mv.promotion ?? "") : "a1a1";
      const r = await api.submitMove({ token: tok(a.by), gameId: id, uci });
      if (over || a.by !== turn) {
        expect(r, "M6").toMatchObject({ ok: false, code: "not_your_turn_or_over" });
      } else if (a.kind === "illegal" || !mv) {
        expect(r, `I1: ${uci} refused`).toMatchObject({ ok: false });
        expect(!r.ok && r.raw).toContain("fixture: illegal move");
        paths.illegalRefused++;
      } else {
        expect(r).toEqual({ ok: true });
        board.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
        model.plies.push(uci);
        if (model.offer === other(a.by)) model.offer = null;
        if (board.isCheckmate()) { model.status = "mate"; model.winner = a.by; }
        else if (board.isStalemate()) model.status = "stalemate";
        else if (board.isInsufficientMaterial()) model.status = "draw";
      }
    } else if (a.kind === "resign") {
      const r = await api.resignGame({ token: tok(a.by), gameId: id });
      if (over) expect(r.ok).toBe(false);
      else if (model.plies.length < 2) { expect(r.ok).toBe(true); model.status = "aborted"; }
      else { expect(r.ok).toBe(true); model.status = "resign"; model.winner = other(a.by); }
      if (model.status !== "started") model.offer = null;
    } else if (a.kind === "abort") {
      const r = await api.abortGame({ token: tok(a.by), gameId: id });
      if (!over && model.plies.length < 2) { expect(r.ok).toBe(true); model.status = "aborted"; }
      else expect(r.ok).toBe(false);
    } else {
      const r = await api.offerOrAcceptDraw({ token: tok(a.by), gameId: id, accept: a.kind === "drawYes" });
      if (over) { expect(r.ok).toBe(false); continue; }
      expect(r, "every draw call answers 200, a no-op too").toEqual({ ok: true });
      const ply = model.plies.length;
      const last = lastOffer[a.by];
      if (a.kind === "drawNo") {
        if (model.offer === other(a.by)) { model.offer = null; paths.opponentNoCleared++; }
        else if (model.offer === a.by) paths.ownOfferNoKept++;
      } else if (model.offer === other(a.by)) {
        model.status = "draw"; model.offer = null; paths.accepted++;
      } else if (model.offer === null && ply >= 2) {
        if (last === null || last < ply - 20) { model.offer = a.by; lastOffer[a.by] = ply; paths.offered++; }
        else paths.windowNoOp++;
      }
    }
    const read = await api.readGameStream({ token: W.token, gameId: id });
    expect(read.ok).toBe(true);
    if (!read.ok) return actions;
    expect(read.game.status).toBe(model.status);
    expect(read.game.winner).toBe(model.winner);
    expect(read.game.movesUci).toEqual(model.plies);
    if (model.status === "started") {
      expect(read.game.drawOffer).toEqual({ white: model.offer === "white", black: model.offer === "black" });
    }
  }
  const k = model.status === "started" ? "running" : model.status === "stalemate" ? "draw" : model.status;
  ends[k as keyof Ends]++;
  return actions;
}

describe("property: the stub follows the measured rules over any action sequence", () => {
  const mv = (by: "white" | "black"): Act => ({ kind: "move", by, pick: 0 });
  const yes = (by: "white" | "black"): Act => ({ kind: "drawYes", by });
  const no = (by: "white" | "black"): Act => ({ kind: "drawNo", by });
  // Each prefix ENDS with the rule it exists for, and runs a fixed number of times with a random tail after it, so
  // every rule is reached whatever the seed (a free-running property reached the offerer's own `no` in 0 of 80 runs).
  const PREFIXES: [keyof Paths, Act[]][] = [
    ["illegalRefused", [{ kind: "illegal", by: "white", pick: 0 }]],
    ["offered", [mv("white"), mv("black"), yes("white")]],
    ["accepted", [mv("white"), mv("black"), yes("white"), yes("black")]],
    ["ownOfferNoKept", [mv("white"), mv("black"), yes("white"), no("white")]],
    ["opponentNoCleared", [mv("white"), mv("black"), yes("white"), no("black")]],
    ["windowNoOp", [mv("white"), mv("black"), yes("white"), no("black"), yes("white")]],
  ];
  const RUNS = 12;
  for (const [claim, prefix] of PREFIXES) {
    it(`${claim}, then anything: status, winner, the move list and the draw offers agree with the model after every action`, async () => {
      const paths: Paths = { illegalRefused: 0, offered: 0, accepted: 0, ownOfferNoKept: 0, windowNoOp: 0, opponentNoCleared: 0 };
      const ends: Ends = { resign: 0, aborted: 0, draw: 0, mate: 0, running: 0 };
      let actions = 0;
      let runs = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(actArb, { minLength: 0, maxLength: 30 }), async (tail) => {
          actions += await runActs([...prefix, ...tail], paths, ends);
          runs++;
        }),
        { numRuns: RUNS },
      );
      expect(runs, "anti-vacuity: runs").toBe(RUNS);
      expect(actions, "zero actions checked is a FAILURE").toBeGreaterThanOrEqual(RUNS * prefix.length);
      // The prefix's own claim was taken on EVERY run.
      expect(paths[claim], `${claim}: ${JSON.stringify(paths)}`).toBeGreaterThanOrEqual(RUNS);
    });
  }
});
