// Write the result (chess in-page board design §3.6, Task 12). A finished
// Lichess game becomes OUR fixture's result, written under organiser
// authority. Every expected value below comes from the spec's §3.6 table, the
// controller's addenda, Lichess's own source (lila / scalachess, pinned where
// cited) or the engine's declarations — never from result.ts or map-result.ts.
//
// Every game a result is written for is created by T9's REAL producer
// (`createGameIfReady`, Board API module-mocked at its boundary), so it starts
// as the 'ready' row production writes; a 'live' one got there through T10's
// real `act`. Rows edited by SQL are labelled with the writer they stand for.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`), so the one other-sport case below is
// the guard's refusal, not a second write path.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import { BoardgameMethod } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { AppendEventRequest, StageKind } from "@/server/api-v1/schemas";
import { appendEvent } from "@/server/engine-db";
import { appendEventInTx } from "@/server/engine-db/append-event";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { STATUS_METHOD_KEYS } from "@/server/external-play/map-result";
import type { BoardCall, GameSnapshot } from "@/server/external-play/types";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady } from "../external-play/create-game";
import { act } from "../external-play/play";
import { holdForOrganiser, resultIdempotencyKey, writeResultFrom } from "../external-play/result";
import { scoreEvent } from "../scoring";
import { startDivision } from "../schedule";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedFutureDivision, seedOrg } from "./_seed";
import { seedOnlineChessFixture } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

// The Board API is module-mocked: T9's creation and T10's play consume it, and
// the module boundary IS the seam. Every default REFUSES, so a case that
// reaches Lichess without saying what Lichess answers fails loudly.
const UNEXPECTED: BoardCall = { ok: false, code: "unavailable", raw: "unexpected Board API call" };
const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
  submitMove: vi.fn(),
  resignGame: vi.fn(),
  offerOrAcceptDraw: vi.fn(),
  abortGame: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue(UNEXPECTED);
  board.submitMove.mockResolvedValue(UNEXPECTED);
  board.resignGame.mockResolvedValue(UNEXPECTED);
  board.offerOrAcceptDraw.mockResolvedValue(UNEXPECTED);
  board.abortGame.mockResolvedValue(UNEXPECTED);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");

type Colour = "white" | "black";
type Player = { entrantId: string; personId: string; userId: string; lichessId: string };
type Game = Awaited<ReturnType<typeof seedOnlineChessFixture>> & {
  gameId: string;
  white: Player;
  black: Player;
  whiteSide: "home" | "away";
};

/** A game as T9's real producer leaves it: 'ready', colours recorded, no
 *  score event (T10 never writes one), so the fold is still in phase `pre`.
 *  `kind` flips the stage AFTER the division started — standing for an
 *  organiser who built that stage kind (the seed's fixture is SQL-inserted
 *  into a league stage). `whiteAway` gives Black to home through the real
 *  pairing card, so the winning colour and the winning side differ. */
async function readyGame(over: { kind?: string; whiteAway?: boolean } = {}): Promise<Game> {
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    clock: { base: 300, increment: 3 },
  });
  if (over.whiteAway) {
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "boardgame.pairing", payload: { white: s.away.entrantId } });
  }
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: gameId });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  const out = await createGameIfReady(s.fixtureId, { now: NOW, publish: async () => {} });
  expect(out, "premise: T9's REAL producer created the game").toEqual({ created: true, gameId });
  const whiteSide = over.whiteAway ? "away" : "home";
  expect(await bridgeOf(s.fixtureId), "premise: 'ready', colours recorded").toMatchObject({
    status: "ready",
    white_side: whiteSide,
    challenge_id: gameId,
  });
  if (over.kind) await sql`update stages set kind = ${over.kind} where id = ${s.stageId}`;
  return over.whiteAway
    ? { ...s, gameId, white: s.away, black: s.home, whiteSide }
    : { ...s, gameId, white: s.home, black: s.away, whiteSide };
}

/** A game that T10's REAL `act` moved to 'live' with one accepted move. */
async function liveGame(over: { kind?: string; whiteAway?: boolean } = {}): Promise<Game> {
  const g = await readyGame(over);
  const out = await act(
    { fixtureId: g.fixtureId, personId: g.white.personId, action: { kind: "move", uci: "e2e4" } },
    { accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: async () => ({ ok: true }) },
  );
  expect(out, "premise: T10 accepted the first move").toEqual({ ok: true, applied: true });
  expect((await bridgeOf(g.fixtureId))!.status, "premise: T10 moved the row to live").toBe("live");
  return g;
}

function snap(g: { gameId: string }, over: Record<string, unknown> = {}): GameSnapshot {
  return {
    gameId: g.gameId,
    status: "mate",
    winner: "white",
    movesSan: ["e4", "e5"],
    whiteMs: 1,
    blackMs: 1,
    increment: 0,
    ...over,
  } as GameSnapshot;
}

type Bridge = { status: string; needs_reason: string | null; last_error: string | null; white_side: string | null; challenge_id: string | null };
async function bridgeOf(fixtureId: string): Promise<Bridge | undefined> {
  const [row] = await sql<Bridge[]>`
    select status, needs_reason, last_error, white_side, challenge_id
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return row;
}
async function fixtureOf(fixtureId: string) {
  const [row] = await sql<{ status: string; outcome: { kind: string; winner?: string } | null }[]>`
    select status, outcome from fixtures where id = ${fixtureId}`;
  return row!;
}
async function typesOf(fixtureId: string): Promise<string[]> {
  const rows = await sql<{ type: string }[]>`select type from score_events where fixture_id = ${fixtureId} order by seq`;
  return rows.map((r) => r.type);
}
/** Every event but the fold's start and the arbiter's pairing card. */
async function resultEvents(fixtureId: string) {
  return sql<{ type: string; payload: { winner?: string | null; method?: string; by?: string } }[]>`
    select type, payload from score_events
     where fixture_id = ${fixtureId} and type not in ('core.start', 'boardgame.pairing') order by seq`;
}
const entrantOf = (g: Game, c: Colour) => (c === "white" ? g.white.entrantId : g.black.entrantId);

// ---------------------------------------------------------------------------
// The rulebook, transcribed by hand. Sources, in precedence order:
//   spec §3.6's table (binding) and the brief's method vocabulary for it;
//   the controller's addendum 1 (cheat / insufficientMaterialClaim /
//   variantEnd / unrecognised);
//   Lichess's own source where both are silent — lila 3747530a1
//   (modules/round/src/main/Finisher.scala, RoundAsyncActor.scala,
//   Drawer.scala) and scalachess 2ab0a40 (Status.scala), read 2026-10-10,
//   NOT measured.
// ---------------------------------------------------------------------------
type Expect =
  | { wrote: "decided"; method: BoardgameMethod }
  | { wrote: "draw"; method: BoardgameMethod | null } // null: no method on the payload
  | { wrote: "aborted" }
  | { wrote: "needs_organiser"; reason: "provider_error" | "tiebreak_owed" | "fair_play" }
  | { wrote: "none" };

const ORGANISER: Expect = { wrote: "needs_organiser", reason: "provider_error" };

function rulebook(status: string, winner: Colour | null, bracket: boolean): Expect {
  const decidedOr = (method: BoardgameMethod, otherwise: Expect): Expect =>
    winner ? { wrote: "decided", method } : otherwise;
  const drawUnlessWinner = (method: BoardgameMethod): Expect => (winner ? ORGANISER : { wrote: "draw", method });
  const base = ((): Expect => {
    switch (status) {
      // §3.5: only a status other than created/started is terminal.
      case "created":
      case "started":
        return { wrote: "none" };
      // §3.6 + M9: no result; an early resign lands here with no winner.
      case "aborted":
        return { wrote: "aborted" };
      // Finisher.noStart: a game that is not mandatory is ABORTED when nobody
      // makes the first move; NoStart is the mandatory-game form of the same
      // fact — nobody played. No game, so the same hold as `aborted`.
      case "noStart":
        return { wrote: "aborted" };
      // §3.6 "decided result, winner as reported". scalachess
      // `finishedWithWinner` and Finisher: mate and resign always carry one,
      // so a winnerless one is not guessed.
      case "mate":
        return decidedOr("checkmate", ORGANISER);
      case "resign":
        return decidedOr("resign", ORGANISER);
      // Finisher.outOfTime: the winner is withheld exactly when the side
      // left on the board has insufficient mating material — a DRAW, the
      // FIDE 6.9 flag-fall rule the engine calls `insufficient`.
      case "outoftime":
        return decidedOr("time", { wrote: "draw", method: "insufficient" });
      // RoundAsyncActor ResignForce / DrawForce → Finisher.rageQuit(None):
      // the opponent left and the remaining player was given (or chose) a
      // draw. Lichess records no reason, so no method is recorded either.
      case "timeout":
        return decidedOr("time", { wrote: "draw", method: null });
      case "draw":
        return drawUnlessWinner("agreement");
      case "stalemate":
        return drawUnlessWinner("stalemate");
      // Addendum 1 → draw. Status.scala: "the side that cannot lose claims a
      // draw" (Drawer.scala:55, RoundAsyncActor.scala:204).
      case "insufficientMaterialClaim":
        return drawUnlessWinner("insufficient");
      // Addendum 1 → the organiser's FAIR-PLAY queue: Lichess has already
      // ruled a fair-play violation (Status.scala Cheat; the winner it
      // reports is the innocent side). Its own reason, never a provider fault
      // (T12 fix round 1, I2).
      case "cheat":
        return { wrote: "needs_organiser", reason: "fair_play" };
      // Addendum 1 → organiser (variantEnd: ship 1 is standard only;
      // unrecognised: never a silent pass). Brief → organiser (unknownFinish).
      case "variantEnd":
      case "unknownFinish":
      case "unrecognised":
        return ORGANISER;
      default:
        throw new Error(`rulebook has no row for ${status}`);
    }
  })();
  // §3.6 / §7: a drawn game in a bracket is HELD, never written as decided.
  if (base.wrote === "draw" && bracket) return { wrote: "needs_organiser", reason: "tiebreak_owed" };
  return base;
}

/** What `writeResultFrom` returns for an expectation. */
function answerOf(e: Expect) {
  return e.wrote === "needs_organiser" ? { wrote: e.wrote, reason: e.reason } : { wrote: e.wrote };
}

/** Lichess's OWN status list: the recorded OpenAPI enum (the same 14 as
 *  scalachess Status.scala), plus T3's explicit "unrecognised" marker. */
const BRACKETS_ALL = StageKind.options.filter((k) => BRACKET_STAGE_KINDS.has(k));
const DECIDING_ALL = StageKind.options.filter((k) => !BRACKET_STAGE_KINDS.has(k));

const DECLARED_STATUSES: string[] = (() => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../external-play/__fixtures__/lichess");
  const text = readFileSync(join(dir, "openapi-GameStatusName.yaml"), "utf8");
  return [...text.slice(text.indexOf("enum:")).matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]!);
})();

/** Asserts the ledger, fixture and bridge say exactly what `e` says. */
async function expectWritten(g: Game, s: GameSnapshot, e: Expect, label: string) {
  const events = await resultEvents(g.fixtureId);
  const fx = await fixtureOf(g.fixtureId);
  const b = await bridgeOf(g.fixtureId);
  expect(events.map((x) => x.type), `${label}: never a forfeit`).not.toContain("core.forfeit");
  if (e.wrote === "decided" || e.wrote === "draw") {
    expect(events.length, `${label}: one result event`).toBe(1);
    expect(events[0]!.type, label).toBe("boardgame.result");
    expect(events[0]!.payload.method ?? null, `${label}: method`).toBe(e.method);
    const winner = e.wrote === "decided" ? entrantOf(g, s.winner!) : null;
    expect(events[0]!.payload.winner ?? null, `${label}: winner entrant`).toBe(winner);
    expect(fx.outcome?.kind, `${label}: outcome`).toBe(e.wrote === "decided" ? "win" : "draw");
    if (e.wrote === "decided") expect(fx.outcome?.winner, `${label}: outcome winner`).toBe(winner);
    expect(await typesOf(g.fixtureId), `${label}: started, then the result`).toContain("core.start");
    expect(b!.status, `${label}: T12 does not move the bridge`).not.toBe("needs_organiser");
  } else {
    expect(events, `${label}: nothing on the ledger`).toEqual([]);
    expect(await typesOf(g.fixtureId), `${label}: not even a start`).not.toContain("core.start");
    expect(fx.outcome, `${label}: undecided`).toBeNull();
    if (e.wrote === "none") {
      expect(b!.status, `${label}: bridge untouched`).not.toBe("needs_organiser");
    } else {
      expect(b!.status, label).toBe("needs_organiser");
      expect(b!.needs_reason, label).toBe(e.wrote === "aborted" ? "aborted" : e.reason);
    }
  }
}

// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("fixture_external_play.needs_reason accepts this task's reasons", () => {
  // Every reason T12 writes: the callers' (HOLD_REASONS) and the snapshot's.
  const REASONS = ["token_revoked", "provider_error", "double_walkover_blocked", "tiebreak_owed", "fair_play", "aborted"] as const;

  it("accepts every reason this task writes, and refuses a free-text one", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date(Date.now() - 60_000),
      linked: true,
    });
    let checked = 0;
    for (const reason of REASONS) {
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, needs_reason)
        values (${s.fixtureId}, ${s.orgId}, now(), 'needs_organiser', ${reason})
        on conflict (fixture_id) do update set status = 'needs_organiser', needs_reason = ${reason}`;
      const [row] = await sql<{ needs_reason: string }[]>`
        select needs_reason from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row!.needs_reason, reason).toBe(reason);
      checked++;
    }
    expect(checked, "reasons checked").toBe(REASONS.length);

    await expect(sql`
      update fixture_external_play set needs_reason = 'the dog ate it'
       where fixture_id = ${s.fixtureId}`).rejects.toMatchObject({
      code: "23514",
      constraint_name: "fixture_external_play_needs_reason_check",
    });
  });
});

describe("the rulebook transcription itself", () => {
  it("has a row for EVERY status Lichess declares, plus the unrecognised marker — counted", () => {
    expect(DECLARED_STATUSES.length, "premise: the recorded enum parsed").toBe(14);
    let checked = 0;
    for (const status of [...DECLARED_STATUSES, "unrecognised"]) {
      for (const winner of ["white", "black", null] as const) {
        expect(() => rulebook(status, winner, false), status).not.toThrow();
        checked++;
      }
    }
    expect(checked, "status × winner cells checked").toBe(15 * 3);
  });

  it("the spec's table and map-result's STATUS_METHOD agree on every decisive status", () => {
    // Two independently-maintained sources. Drift between them is the defect
    // this catches; neither is read back out of result.ts.
    const fromSpec = ["mate", "resign", "outoftime", "timeout", "draw", "stalemate", "insufficientMaterialClaim"].sort();
    const covered = fromSpec.filter((s) => STATUS_METHOD_KEYS.includes(s));
    expect(covered, "every spec status has a method in map-result").toEqual(fromSpec);
    expect(covered.length).toBeGreaterThan(0);
  });

  it("every STATUS_METHOD key is a status Lichess actually declares — no invented statuses", () => {
    expect(STATUS_METHOD_KEYS.length, "premise: the table is not empty").toBeGreaterThan(0);
    const invented = STATUS_METHOD_KEYS.filter((k) => !DECLARED_STATUSES.includes(k));
    expect(invented).toEqual([]);
  });

  it("every method the rulebook writes is one the engine declares", () => {
    let checked = 0;
    for (const status of [...DECLARED_STATUSES, "unrecognised"]) {
      for (const winner of ["white", "black", null] as const) {
        const e = rulebook(status, winner, false);
        if ((e.wrote === "decided" || e.wrote === "draw") && e.method !== null) {
          expect(BoardgameMethod.options, `${status}/${winner}`).toContain(e.method);
          checked++;
        }
      }
    }
    expect(checked, "methods checked").toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("writeResultFrom — every terminal status (spec §3.6)", () => {
  /** Spec §3.6's table, hand-encoded from the RULEBOOK — not read back out
   *  of the code under test. `winnerIsNull` is the load-bearing column: M9's
   *  early resign differs from a real resign by having no winner at all. */
  const SPEC_3_6 = [
    { status: "mate", winner: "white", wrote: "decided", event: "boardgame.result", method: "checkmate", winnerIsNull: false },
    { status: "resign", winner: "black", wrote: "decided", event: "boardgame.result", method: "resign", winnerIsNull: false },
    { status: "outoftime", winner: "black", wrote: "decided", event: "boardgame.result", method: "time", winnerIsNull: false },
    { status: "timeout", winner: "white", wrote: "decided", event: "boardgame.result", method: "time", winnerIsNull: false },
    { status: "draw", winner: null, wrote: "draw", event: "boardgame.result", method: "agreement", winnerIsNull: true },
    { status: "stalemate", winner: null, wrote: "draw", event: "boardgame.result", method: "stalemate", winnerIsNull: true },
    // M9. Resigning after ONE move reports status=aborted winner=None. The
    // wrong answer here is "someone won"; the right one is "there was no game".
    { status: "aborted", winner: null, wrote: "aborted", event: null, method: null, winnerIsNull: true },
  ] as const;

  it("the rulebook oracle agrees with the spec's own table on every row it names — counted", () => {
    // The oracle is pinned to the SPEC here, not only to the code: a drift
    // in both together (a "fix" to code and oracle at once) is caught.
    let checked = 0;
    for (const row of SPEC_3_6) {
      const e = rulebook(row.status, row.winner, false);
      expect(e.wrote, row.status).toBe(row.wrote);
      if (e.wrote === "decided" || e.wrote === "draw") expect(e.method, row.status).toBe(row.method);
      checked++;
    }
    expect(checked, "spec rows checked").toBe(SPEC_3_6.length);
  });

  it("maps each terminal status to the event and method the spec names, and reports the count", async () => {
    let checked = 0;
    for (const row of SPEC_3_6) {
      const g = await readyGame(); // league: a draw is legal there
      const out = await writeResultFrom(snap(g, { status: row.status, winner: row.winner }), g.fixtureId);
      expect(out, row.status).toEqual({ wrote: row.wrote });
      const events = await resultEvents(g.fixtureId);
      if (row.event === null) {
        expect(events, `${row.status} writes no result event`).toEqual([]);
      } else {
        expect(events.length, row.status).toBe(1);
        expect(events[0]!.type).toBe(row.event);
        expect(events[0]!.payload.method).toBe(row.method);
        expect(events[0]!.payload.winner === null, `${row.status} winner-is-null`).toBe(row.winnerIsNull);
      }
      checked++;
    }
    expect(checked, "terminal statuses checked").toBe(SPEC_3_6.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("EVERY status Lichess declares, and the unrecognised marker, lands where the rulebook says — counted", async () => {
    // One row per status at the winner Lichess reports with it; the property
    // below crosses every winner and stage kind.
    const typical: Record<string, Colour | null> = {
      mate: "white", resign: "black", outoftime: "white", timeout: "black", cheat: "black",
      noStart: "white", variantEnd: "white",
    };
    let checked = 0;
    for (const status of [...DECLARED_STATUSES, "unrecognised"]) {
      const g = await readyGame();
      const winner = typical[status] ?? null;
      const s = snap(g, status === "unrecognised"
        ? { status, rawStatus: "someStatusLichessAddsLater", winner }
        : { status, winner });
      const e = rulebook(status, winner, false);
      expect(await writeResultFrom(s, g.fixtureId), status).toEqual(answerOf(e));
      await expectWritten(g, s, e, status);
      checked++;
    }
    expect(checked, "statuses checked").toBe(DECLARED_STATUSES.length + 1);
  });

  it("EVERY status × EVERY winner Lichess could report (white, black, none) lands where the rulebook says — counted", async () => {
    // The typical-winner sweep above checks one cell per status; a winnerless
    // timeout, a winnerless mate or a drawn status carrying a winner are
    // separate branches, and a mutant on one of them survived that sweep
    // (measured: timeout-without-winner recorded as "time" was killed only
    // by the property, which reaches that cell by draw).
    const WINNERS: (Colour | null)[] = ["white", "black", null];
    let checked = 0;
    let written = 0;
    let held = 0;
    for (const status of [...DECLARED_STATUSES, "unrecognised"]) {
      for (const winner of WINNERS) {
        const g = await readyGame();
        const s = snap(g, status === "unrecognised"
          ? { status, rawStatus: "someStatusLichessAddsLater", winner }
          : { status, winner });
        const e = rulebook(status, winner, false);
        const label = `${status}/${winner ?? "none"}`;
        expect(await writeResultFrom(s, g.fixtureId), label).toEqual(answerOf(e));
        await expectWritten(g, s, e, label);
        if (e.wrote === "decided" || e.wrote === "draw") written++;
        if (e.wrote === "aborted" || e.wrote === "needs_organiser") held++;
        checked++;
      }
    }
    expect(checked, "cells checked").toBe((DECLARED_STATUSES.length + 1) * WINNERS.length);
    expect(written, "anti-vacuity: some cells write").toBeGreaterThan(0);
    expect(held, "anti-vacuity: some cells hold").toBeGreaterThan(0);
  });

  it("a NON-terminal status writes nothing at all", async () => {
    let checked = 0;
    for (const status of ["created", "started"] as const) {
      const g = await readyGame();
      const before = await bridgeOf(g.fixtureId);
      expect(await writeResultFrom(snap(g, { status, winner: null, movesSan: [] }), g.fixtureId)).toEqual({ wrote: "none" });
      expect(await typesOf(g.fixtureId)).toEqual([]);
      expect(await bridgeOf(g.fixtureId), "bridge untouched").toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an UNKNOWN terminal status is held for the organiser, never guessed — and the organiser is told Lichess's word", async () => {
    const g = await readyGame();
    expect(await writeResultFrom(snap(g, { status: "unknownFinish", winner: null }), g.fixtureId)).toEqual({
      wrote: "needs_organiser",
      reason: "provider_error",
    });
    expect((await bridgeOf(g.fixtureId))!.last_error).toMatch(/unknownFinish/);
    const u = await readyGame();
    await writeResultFrom(snap(u, { status: "unrecognised", rawStatus: "brandNewFinish", winner: "white" }), u.fixtureId);
    const b = await bridgeOf(u.fixtureId);
    expect(b).toMatchObject({ status: "needs_organiser", needs_reason: "provider_error" });
    expect(b!.last_error, "the raw word reaches the organiser").toMatch(/brandNewFinish/);
    expect(await typesOf(u.fixtureId), "and nothing is written for it").toEqual([]);
  });

  it("a winner the colours map onto: Black wins with White on the AWAY side ⇒ the HOME entrant won", async () => {
    // The differential for the colour→entrant step: with home = White, the
    // wrong mapping and the right one agree, so this case is the one that
    // can tell them apart.
    const g = await readyGame({ whiteAway: true });
    expect(g.black.entrantId, "premise: Black is the home entrant").toBe(g.home.entrantId);
    expect(await writeResultFrom(snap(g, { status: "mate", winner: "black" }), g.fixtureId)).toEqual({ wrote: "decided" });
    expect((await fixtureOf(g.fixtureId)).outcome!.winner).toBe(g.home.entrantId);
    expect(await typesOf(g.fixtureId)).toEqual(["boardgame.pairing", "core.start", "boardgame.result"]);
  });
});

describe.runIf(HAS_DB)("writeResultFrom — M9: an early resign is an abort with no winner", () => {
  it("status=aborted winner=null records NO game that anyone won", async () => {
    const g = await readyGame();
    const out = await writeResultFrom(snap(g, { status: "aborted", winner: null, movesSan: ["e4"] }), g.fixtureId);
    expect(out).toEqual({ wrote: "aborted" });
    const fx = await fixtureOf(g.fixtureId);
    expect(fx.outcome, "nobody won — not a draw either").toBeNull();
    expect(fx.status).not.toBe("forfeited");
    const b = await bridgeOf(g.fixtureId);
    expect(b!.status).toBe("needs_organiser");
    expect(b!.needs_reason, "the existing V433 reason for exactly this").toBe("aborted");
  });

  it("the SAME resign after two moves DOES decide it — the pair that makes the case above non-vacuous", async () => {
    const g = await readyGame();
    const out = await writeResultFrom(snap(g, { status: "resign", winner: "black", movesSan: ["e4", "e5"] }), g.fixtureId);
    expect(out).toEqual({ wrote: "decided" });
    const fx = await fixtureOf(g.fixtureId);
    expect(fx.outcome!.kind).toBe("win");
    // M9's other half: after TWO moves the same action reports
    // `status=resign winner=black`, so Black WON (White resigned). With
    // white_side = 'home', Black is the away entrant.
    expect(fx.outcome!.winner).toBe(g.away.entrantId);
  });
});

describe.runIf(HAS_DB)("writeResultFrom — a Lichess timeout is a normal win, not a forfeit", () => {
  it("outoftime writes boardgame.result with method 'time' — NEVER core.forfeit", async () => {
    // Spec §3.6: "A Lichess timeout is a normal win, not a forfeit. Only a
    // no-show is a forfeit." The outcome KIND is the same either way, so the
    // assertion has to be on the event TYPE and the method.
    const g = await readyGame();
    await writeResultFrom(
      snap(g, { status: "outoftime", winner: "white", whiteMs: 90_000, blackMs: 0 }),
      g.fixtureId,
    );
    const events = await resultEvents(g.fixtureId);
    expect(events.map((e) => e.type)).toEqual(["boardgame.result"]);
    expect(events.map((e) => e.type)).not.toContain("core.forfeit");
    expect(events[0]!.payload.method).toBe("time");
    expect((await fixtureOf(g.fixtureId)).status, "a flagged game is a played game").not.toBe("forfeited");
  });

  it("outoftime with NO winner is a draw (the side left on the board cannot mate) — never decided", async () => {
    // lila Finisher.outOfTime: `winner = Option(!flagged).ifFalse(
    // opponentHasInsufficientMaterial)`. The wrong answer differs from the
    // case above by having a winner at all.
    const g = await readyGame();
    expect(await writeResultFrom(snap(g, { status: "outoftime", winner: null, whiteMs: 0 }), g.fixtureId)).toEqual({
      wrote: "draw",
    });
    const [ev] = await resultEvents(g.fixtureId);
    expect(ev!.payload).toEqual({ winner: null, method: "insufficient" });
    expect((await fixtureOf(g.fixtureId)).outcome!.kind).toBe("draw");
  });
});

describe.runIf(HAS_DB)("writeResultFrom — the pre→live→done sequence", () => {
  it("a fold still in phase `pre` is STARTED before the result (boardgame refuses a result in `pre`)", async () => {
    // packages/engine/src/sports/boardgame/boardgame.ts:249 —
    // `if (state.phase !== "live") wrongPhase('result not allowed in phase "' + phase + '"')`.
    // Nothing auto-starts: append-event.ts has no implicit core.start, and
    // T10 records moves on the bridge, not the ledger — so a LIVE game's fold
    // is still `pre` here.
    const g = await liveGame();
    expect(await typesOf(g.fixtureId), "premise: a live game has no score event").toEqual([]);
    await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId);
    expect(await typesOf(g.fixtureId)).toEqual(["core.start", "boardgame.result"]);
    expect((await fixtureOf(g.fixtureId)).status).toBe("decided");
  });

  it("a fold already LIVE (the organiser pressed Start) is not started twice", async () => {
    const g = await readyGame();
    const auth = await mintOrgOwnerAuth(g.orgId);
    await scoreEvent(auth, g.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId);
    expect(await typesOf(g.fixtureId)).toEqual(["core.start", "boardgame.result"]);
  });

  it("a SECOND writeResultFrom with the same snapshot adds nothing and answers the same", async () => {
    const g = await readyGame();
    const s = snap(g, { status: "mate", winner: "white" });
    const first = await writeResultFrom(s, g.fixtureId);
    const second = await writeResultFrom(s, g.fixtureId);
    expect(first).toEqual({ wrote: "decided" });
    expect(second, "the replay answers what the first call did").toEqual(first);
    expect(await typesOf(g.fixtureId)).toEqual(["core.start", "boardgame.result"]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events
       where fixture_id = ${g.fixtureId} and idempotency_key = ${resultIdempotencyKey(g.fixtureId, s)}`;
    expect(n, "the ledger holds the key exactly once").toBe(1);
  });

  it("a second call AFTER the organiser voided our result does not write it back", async () => {
    // The ledger key survives the void, so the replay is still recognised —
    // the organiser's correction stands.
    const g = await readyGame();
    const s = snap(g, { status: "mate", winner: "white" });
    await writeResultFrom(s, g.fixtureId);
    const auth = await mintOrgOwnerAuth(g.orgId);
    const [res] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${g.fixtureId} and type = 'boardgame.result'`;
    await scoreEvent(auth, g.fixtureId, { expected_seq: res!.seq, type: "core.void", payload: { event_id: res!.id } });
    expect((await fixtureOf(g.fixtureId)).outcome, "premise: the void undid the result").toBeNull();
    expect(await writeResultFrom(s, g.fixtureId)).toEqual({ wrote: "decided" });
    expect(await typesOf(g.fixtureId)).toEqual(["core.start", "boardgame.result", "core.void"]);
  });

  it("a held outcome is idempotent too: a second knockout draw call holds once and writes nothing", async () => {
    const g = await readyGame({ kind: "knockout" });
    const s = snap(g, { status: "draw", winner: null });
    const held = { wrote: "needs_organiser", reason: "tiebreak_owed" };
    expect(await writeResultFrom(s, g.fixtureId)).toEqual(held);
    expect(await writeResultFrom(s, g.fixtureId)).toEqual(held);
    expect(await typesOf(g.fixtureId)).toEqual([]);
    expect(await bridgeOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "tiebreak_owed" });
  });

  it("a racing writer that STARTS the fold between our read and our write: we re-read once and still write the result", async () => {
    // Staged, not a Promise.all hope: this test holds the fixture's append
    // lock, lets writeResultFrom read phase `pre` and block on its own
    // core.start, then commits a core.start of its own. Our start then meets
    // a moved tip (SEQ_CONFLICT) — the race two reconciles (game_end and the
    // sweep) can really run.
    const g = await readyGame();
    const lockKey = `fixture:${g.fixtureId}`;
    const conn = await sql.reserve();
    try {
      await conn`begin`;
      await conn`select pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const pending = writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId);
      // Wait until our writer is parked on the lock (pg_stat_activity).
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i++) {
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'
             and pid <> pg_backend_pid() and query like '%pg_advisory_xact_lock%'`;
        waiting = n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, "premise: writeResultFrom is parked behind our lock").toBeGreaterThan(0);
      await appendEventInTx(conn as never, g.orgId, g.fixtureId, 0, { type: "core.start", payload: {} });
      await conn`commit`;
      expect(await pending).toEqual({ wrote: "decided" });
    } finally {
      conn.release();
    }
    expect(await typesOf(g.fixtureId), "one start (theirs), one result (ours)").toEqual(["core.start", "boardgame.result"]);
  });

  it("resultIdempotencyKey is stable for one snapshot and differs across games and statuses", () => {
    const base = { gameId: "AAA", status: "mate", winner: "white", movesSan: [], whiteMs: 0, blackMs: 0, increment: 0 } as GameSnapshot;
    expect(resultIdempotencyKey("fx", base)).toBe(resultIdempotencyKey("fx", { ...base }));
    expect(resultIdempotencyKey("fx", base)).not.toBe(resultIdempotencyKey("fx", { ...base, gameId: "BBB" }));
    expect(resultIdempotencyKey("fx", base)).not.toBe(resultIdempotencyKey("fx", { ...base, status: "resign" }));
    expect(resultIdempotencyKey("fx", base)).not.toBe(resultIdempotencyKey("fy", base));
    // The format T11's brief names, verbatim.
    expect(resultIdempotencyKey("fx", base)).toBe("extplay:fx:AAA:mate");
  });

  it("the key is one AppendEventRequest accepts (its idempotency_key cap), even for a long game id", () => {
    // The authority is the request schema itself, not a number typed here.
    const accepts = (k: string) => AppendEventRequest.shape.idempotency_key.safeParse(k).success;
    const fixtureId = randomUUID();
    const long = (c: string) => ({ gameId: c.repeat(300), status: "mate", winner: "white", movesSan: [], whiteMs: 0, blackMs: 0, increment: 0 }) as GameSnapshot;
    expect(accepts("x".repeat(400)), "premise: the schema HAS a cap").toBe(false);
    const a = resultIdempotencyKey(fixtureId, long("a"));
    const b = resultIdempotencyKey(fixtureId, long("b"));
    expect(accepts(a), a).toBe(true);
    expect(accepts(b), b).toBe(true);
    const unrecognised = { ...long("c"), gameId: "AAA", status: "unrecognised", rawStatus: "z".repeat(300) } as GameSnapshot;
    expect(accepts(resultIdempotencyKey(fixtureId, unrecognised)), "a long raw status too").toBe(true);
    expect(a, "still distinct").not.toBe(b);
    expect(a, "still deterministic").toBe(resultIdempotencyKey(fixtureId, long("a")));
  });
});

describe.runIf(HAS_DB)("writeResultFrom — a draw is legal in Swiss and league, held in a bracket", () => {
  // Spec §3.6 and §7: "A knockout draw shows as held — 'winner to be
  // decided' — never as a decided result." On THIS branch the engine has no
  // tie-break phase and `boardgame.supportsDraws` answers true for every
  // stage kind, so the hold is the bridge row: needs_organiser /
  // tiebreak_owed, and NO boardgame.result at all.
  //
  // The bracket kinds are the ENGINE's declaration (BRACKET_STAGE_KINDS,
  // packages/engine/src/competition/progression.ts) and the rest are every
  // other StageKind (schemas.ts) — so a fifth bracket kind moves both lists.
  const DRAWS = [
    { status: "draw" as const, method: "agreement" },
    { status: "stalemate" as const, method: "stalemate" },
  ];
  const BRACKETS = StageKind.options.filter((k) => BRACKET_STAGE_KINDS.has(k));
  const DECIDING = StageKind.options.filter((k) => !BRACKET_STAGE_KINDS.has(k));

  it("premise: both lists are non-empty and cover every stage kind", () => {
    expect(BRACKETS.length).toBeGreaterThan(0);
    expect(DECIDING.length).toBeGreaterThan(0);
    expect(BRACKETS.length + DECIDING.length).toBe(StageKind.options.length);
    expect(DECIDING, "league and swiss are deciding kinds").toEqual(expect.arrayContaining(["league", "swiss"]));
    expect(BRACKETS).toEqual(expect.arrayContaining(["knockout", "double_elim", "stepladder", "page_playoff"]));
  });

  it("a draw in every non-bracket kind is written as a draw", async () => {
    let checked = 0;
    for (const kind of DECIDING) {
      for (const d of DRAWS) {
        const g = await readyGame({ kind });
        const out = await writeResultFrom(snap(g, { status: d.status, winner: null }), g.fixtureId);
        expect(out, `${kind}/${d.status}`).toEqual({ wrote: "draw" });
        const [ev] = await resultEvents(g.fixtureId);
        expect(ev!.type).toBe("boardgame.result");
        expect(ev!.payload.winner).toBeNull();
        expect(ev!.payload.method).toBe(d.method);
        checked++;
      }
    }
    expect(checked, "kind × draw-status combinations checked").toBe(DECIDING.length * DRAWS.length);
  });

  it("the SAME draw in a knockout is held — needs_organiser/tiebreak_owed, no result event, fixture undecided", async () => {
    let checked = 0;
    for (const d of DRAWS) {
      const g = await readyGame({ kind: "knockout" });
      const out = await writeResultFrom(snap(g, { status: d.status, winner: null }), g.fixtureId);
      expect(out, d.status).toEqual({ wrote: "needs_organiser", reason: "tiebreak_owed" });
      expect(await typesOf(g.fixtureId), "a knockout draw writes NOTHING to the ledger").toEqual([]);
      const fx = await fixtureOf(g.fixtureId);
      expect(fx.outcome).toBeNull();
      expect(fx.status).not.toBe("finalized");
      expect(await bridgeOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "tiebreak_owed" });
      checked++;
    }
    expect(checked, "knockout draw statuses checked").toBe(DRAWS.length);
  });

  it("a DECISIVE knockout result is not held — the hold is about draws, not about knockouts", async () => {
    const g = await readyGame({ kind: "knockout" });
    expect(await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId)).toEqual({ wrote: "decided" });
  });

  it("every bracket kind holds a draw — counted", async () => {
    let checked = 0;
    for (const kind of BRACKETS) {
      const g = await readyGame({ kind });
      expect(await writeResultFrom(snap(g, { status: "draw", winner: null }), g.fixtureId), kind).toEqual({
        wrote: "needs_organiser",
        reason: "tiebreak_owed",
      });
      checked++;
    }
    expect(checked, "bracket kinds checked").toBe(BRACKETS.length);
  });
});

describe.runIf(HAS_DB)("Review Focus 1 — the player revoked our token on lichess.org", () => {
  it("a 401 on the first submission sends the fixture to the organiser queue with its OWN reason", async () => {
    const g = await readyGame();
    // T10's real `act`, with a board stub that 401s the way a revoked token
    // does. Its output is the input to `holdForOrganiser` — one seam, two
    // real ends, no fixture in the middle.
    const played = await act(
      { fixtureId: g.fixtureId, personId: g.white.personId, action: { kind: "move", uci: "e2e4" } },
      {
        accessToken: async (u) => `tok-${u}`,
        publish: async () => {},
        submitMove: async () => ({ ok: false, code: "unauthorized", raw: "401 Unauthorized" }),
      },
    );
    expect(played).toEqual({ ok: false, reconcile: true, reason: "unauthorized" });

    const held = await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    expect(held).toEqual({ wrote: "needs_organiser", reason: "token_revoked" });

    const b = await bridgeOf(g.fixtureId);
    expect(b!.status).toBe("needs_organiser");
    expect(b!.needs_reason).toBe("token_revoked");
    // The load-bearing negative. Spec §3.6: "A token revoked or rejected
    // mid-match is not a no-show and must not be recorded as one."
    expect(["no_show_white", "no_show_black", "no_show_both"]).not.toContain(b!.needs_reason);
    expect(await typesOf(g.fixtureId), "no forfeit, no result").toEqual([]);
    expect((await fixtureOf(g.fixtureId)).status).not.toBe("forfeited");
  });

  it("the hold is idempotent and does not overwrite an EARLIER, different reason", async () => {
    const g = await liveGame();
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "provider_error" });
    const b = await bridgeOf(g.fixtureId);
    expect(b!.needs_reason, "the first diagnosis stands until the organiser clears it").toBe("token_revoked");
  });

  it("every reason the union allows actually lands in the column — counted", async () => {
    const REASONS = ["token_revoked", "provider_error", "double_walkover_blocked", "tiebreak_owed"] as const;
    let checked = 0;
    for (const reason of REASONS) {
      const g = await liveGame();
      expect(await holdForOrganiser({ fixtureId: g.fixtureId, reason })).toEqual({ wrote: "needs_organiser", reason });
      expect((await bridgeOf(g.fixtureId))!.needs_reason).toBe(reason);
      checked++;
    }
    expect(checked, "hold reasons checked").toBe(REASONS.length);
  });

  it("a reason OUTSIDE the union is refused before anything is written (a cast cannot smuggle a no-show in)", async () => {
    const g = await readyGame();
    await expect(
      holdForOrganiser({ fixtureId: g.fixtureId, reason: "no_show_both" as never }),
    ).rejects.toMatchObject({ code: "HOLD_REASON_UNKNOWN" });
    expect((await bridgeOf(g.fixtureId))!.status).toBe("ready");
  });

  it("a hold on a game whose result is already recorded (bridge 'finished') changes nothing", async () => {
    const g = await readyGame();
    await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId);
    // Stands for T11, which marks the bridge finished after the write.
    await sql`update fixture_external_play set status = 'finished', finished_at = now() where fixture_id = ${g.fixtureId}`;
    expect(await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" })).toEqual({ wrote: "none" });
    expect(await bridgeOf(g.fixtureId)).toMatchObject({ status: "finished", needs_reason: null });
  });

  it("a hold for a fixture with NO bridge row is a named refusal, not a silent no-op", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });
    expect(await bridgeOf(s.fixtureId), "premise: no bridge row").toBeUndefined();
    await expect(holdForOrganiser({ fixtureId: s.fixtureId, reason: "provider_error" })).rejects.toMatchObject({
      code: "NO_ONLINE_GAME",
    });
  });
});

describe.runIf(HAS_DB)("writeResultFrom — a fixture settled through ANOTHER path is never written over", () => {
  // T10 review carry: a mid-game withdrawal abandons the board, and nothing
  // ends the game at Lichess (withdrawal.ts makes no Lichess call), so the
  // game runs on to its own end and a later reconcile brings its result here.
  it("a mid-game WITHDRAWAL: the Lichess result that arrives later writes nothing", async () => {
    const g = await liveGame();
    await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
    const before = await fixtureOf(g.fixtureId);
    expect(before.status, "premise: the league expunge path abandoned the board").toBe("abandoned");
    const typesBefore = await typesOf(g.fixtureId);
    expect(await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId)).toEqual({ wrote: "none" });
    expect(await typesOf(g.fixtureId), "nothing appended").toEqual(typesBefore);
    expect(await fixtureOf(g.fixtureId)).toEqual(before);
    expect((await bridgeOf(g.fixtureId))!.status, "not held either — the organiser already decided").toBe("live");
  });

  it("…and a withdrawal followed by a DRAW, an abort or an unknown status holds nothing either — counted", async () => {
    let checked = 0;
    for (const over of [
      { status: "draw", winner: null },
      { status: "aborted", winner: null },
      { status: "unknownFinish", winner: null },
    ]) {
      const g = await liveGame();
      await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.white.entrantId);
      expect(await writeResultFrom(snap(g, over), g.fixtureId), over.status).toEqual({ wrote: "none" });
      expect((await bridgeOf(g.fixtureId))!.status, over.status).toBe("live");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the organiser VOIDED the match in the console (core.abandon): writes nothing", async () => {
    const g = await readyGame();
    await scoreEvent(await mintOrgOwnerAuth(g.orgId), g.fixtureId, { expected_seq: 0, type: "core.abandon", payload: { reason: "voided by the organiser" } });
    expect((await fixtureOf(g.fixtureId)).status, "premise").toBe("abandoned");
    expect(await writeResultFrom(snap(g, { status: "resign", winner: "black" }), g.fixtureId)).toEqual({ wrote: "none" });
    expect(await typesOf(g.fixtureId)).toEqual(["core.abandon"]);
  });

  it("the organiser ENTERED a result by hand first: ours is not appended on top", async () => {
    const g = await readyGame();
    const auth = await mintOrgOwnerAuth(g.orgId);
    await scoreEvent(auth, g.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, g.fixtureId, {
      expected_seq: 1,
      type: "boardgame.result",
      payload: { winner: g.away.entrantId, method: "adjudication" },
    });
    expect(await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId)).toEqual({ wrote: "none" });
    expect((await fixtureOf(g.fixtureId)).outcome!.winner, "the organiser's result stands").toBe(g.away.entrantId);
    expect(await typesOf(g.fixtureId)).toEqual(["core.start", "boardgame.result"]);
  });

  it("the differential: the same snapshot on an untouched board IS written", async () => {
    const g = await liveGame();
    expect(await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId)).toEqual({ wrote: "decided" });
  });
});

describe.runIf(HAS_DB)("writeResultFrom — assumptions are guards", () => {
  it("a snapshot of a DIFFERENT game than the one on file is never written onto this fixture", async () => {
    const g = await readyGame();
    expect(await writeResultFrom({ ...snap(g), gameId: "someOtherGame" }, g.fixtureId)).toEqual({ wrote: "none" });
    expect(await typesOf(g.fixtureId)).toEqual([]);
    expect((await bridgeOf(g.fixtureId))!.status).toBe("ready");
  });

  it("a fixture with NO game on file writes nothing", async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });
    expect(await writeResultFrom(snap({ gameId: "nogame01" }), s.fixtureId)).toEqual({ wrote: "none" });
    expect(await typesOf(s.fixtureId)).toEqual([]);
  });

  it("a game on file WITHOUT recorded colours: a decisive result is held, never attributed by guess", async () => {
    // SQL-damaged: T9 writes white_side with the game id in one update, so
    // this stands for no writer.
    const g = await readyGame();
    await sql`update fixture_external_play set white_side = null where fixture_id = ${g.fixtureId}`;
    expect(await writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId)).toEqual({
      wrote: "needs_organiser",
      reason: "provider_error",
    });
    expect(await typesOf(g.fixtureId)).toEqual([]);
    expect((await bridgeOf(g.fixtureId))!.last_error).toMatch(/colour/);
  });

  it("another sport — a non-boardgame fixture with onlinePlay forced into its config and a bridge row — writes nothing", async () => {
    // One case, not a sweep: the guard is the only place a sport enters, and
    // it admits boardgame alone (guard.ts). Built as the guard suite builds it.
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedFutureDivision(auth);
    await sql`
      update divisions
         set config = config || '{"onlinePlay":"lichess","clock":{"base":300,"increment":3}}'::jsonb
       where id = ${division.id}`;
    await startDivision(auth, division.id);
    const [fixture] = fixtures;
    if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side)
      values (${fixture.id}, ${auth.orgId}, now(), 'ready', ${"ot-" + randomUUID().slice(0, 8)}, 'home')`;
    const [b] = await sql<{ challenge_id: string }[]>`select challenge_id from fixture_external_play where fixture_id = ${fixture.id}`;
    expect(await writeResultFrom(snap({ gameId: b!.challenge_id }), fixture.id)).toEqual({ wrote: "none" });
    expect(await typesOf(fixture.id)).toEqual([]);
  });

  it("a fold whose phase contradicts the fixture's status is refused by name, never written through", async () => {
    // SQL-damaged: no writer leaves a playable fixture with a finished fold
    // (append-event.ts derives the status FROM the fold). The guard's reach.
    const g = await readyGame({ whiteAway: true });
    await sql`update match_states set state = jsonb_set(state, '{phase}', '"done"') where fixture_id = ${g.fixtureId}`;
    await expect(writeResultFrom(snap(g, { status: "mate", winner: "white" }), g.fixtureId)).rejects.toMatchObject({
      code: "FOLD_STATUS_MISMATCH",
    });
    expect(await typesOf(g.fixtureId)).toEqual(["boardgame.pairing"]);
  });
});

// ---------------------------------------------------------------------------
// Property (TEST-STRATEGY rule 10): status × winner × stage kind × the
// fixture's state before the game ends × a sequence of repeat and foreign
// calls, against the rulebook above. Stratified: every (fixture state ×
// outcome class) prefix runs exactly FOUR times, once per (bracket?, White
// on away?) cell, so no path's counter rests on draw luck (a first cut drew
// those freely and left `held_aborted` at 0 — measured). The status, winner,
// stage kind within its class, and the call tail are drawn.
// ---------------------------------------------------------------------------
type Pre = "ready" | "live" | "started" | "held" | "withdrawn" | "voided" | "decided_by_hand";
const PRE_STATES: readonly Pre[] = ["ready", "live", "started", "held", "withdrawn", "voided", "decided_by_hand"];
/** The fixture already had its decision before Lichess's result arrived. */
const SETTLED_BEFORE = new Set<Pre>(["withdrawn", "voided", "decided_by_hand"]);

const W = fc.constantFrom<Colour>("white", "black");
const CLASSES = {
  decisive: fc.record({ status: fc.constantFrom("mate", "resign", "outoftime", "timeout"), winner: W }),
  drawn: fc.oneof(
    fc.record({ status: fc.constantFrom("draw", "stalemate", "insufficientMaterialClaim"), winner: fc.constant(null) }),
    fc.record({ status: fc.constantFrom("outoftime", "timeout"), winner: fc.constant(null) }),
  ),
  aborted: fc.record({
    status: fc.constantFrom("aborted", "noStart"),
    winner: fc.constantFrom<Colour | null>("white", "black", null),
  }),
  organiser: fc.oneof(
    fc.record({
      status: fc.constantFrom("cheat", "variantEnd", "unknownFinish", "unrecognised"),
      winner: fc.constantFrom<Colour | null>("white", "black", null),
    }),
    // Shapes Lichess never sends — held, never guessed.
    fc.record({ status: fc.constantFrom("mate", "resign"), winner: fc.constant(null) }),
    fc.record({ status: fc.constantFrom("draw", "stalemate", "insufficientMaterialClaim"), winner: W }),
  ),
  nonterminal: fc.record({
    status: fc.constantFrom("created", "started"),
    winner: fc.constantFrom<Colour | null>(null, "white"),
  }),
} as const;

describe.runIf(HAS_DB)("writeResultFrom — property: status × fixture state × repeat calls against the rulebook", () => {
  // One run per (bracket, whiteAway) cell — see the header.
  const CELLS = [
    { bracket: false, whiteAway: false },
    { bracket: false, whiteAway: true },
    { bracket: true, whiteAway: false },
    { bracket: true, whiteAway: true },
  ] as const;
  const RUNS_PER_PREFIX = CELLS.length;
  const PREFIXES = PRE_STATES.flatMap((pre) => (Object.keys(CLASSES) as (keyof typeof CLASSES)[]).map((cls) => ({ pre, cls })));
  const totals: Record<string, number> = {};
  const bump = (k: string) => (totals[k] = (totals[k] ?? 0) + 1);

  async function snapshotOf(fixtureId: string) {
    const ledger = await sql<{ id: string; type: string }[]>`
      select id, type from score_events where fixture_id = ${fixtureId} order by seq`;
    return { ledger, bridge: await bridgeOf(fixtureId), fixture: await fixtureOf(fixtureId) };
  }

  async function build(pre: Pre, kind: string, whiteAway: boolean): Promise<Game> {
    const g = pre === "live" || pre === "withdrawn" ? await liveGame({ whiteAway }) : await readyGame({ whiteAway });
    const auth = await mintOrgOwnerAuth(g.orgId);
    const tip = async () => (await typesOf(g.fixtureId)).length;
    if (pre === "started") await scoreEvent(auth, g.fixtureId, { expected_seq: await tip(), type: "core.start", payload: {} });
    if (pre === "held") await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    if (pre === "withdrawn") await withdrawEntrantCascade(auth, g.black.entrantId);
    if (pre === "voided") {
      await scoreEvent(auth, g.fixtureId, { expected_seq: await tip(), type: "core.abandon", payload: { reason: "void" } });
    }
    if (pre === "decided_by_hand") {
      await scoreEvent(auth, g.fixtureId, { expected_seq: await tip(), type: "core.start", payload: {} });
      await scoreEvent(auth, g.fixtureId, {
        expected_seq: await tip(),
        type: "boardgame.result",
        payload: { winner: g.home.entrantId, method: "adjudication" },
      });
    }
    // The kind last, so every pre-state is built the way a league builds it
    // (a withdrawal from a bracket fixture in phase `pre` is W2b's).
    await sql`update stages set kind = ${kind} where id = ${g.stageId}`;
    return g;
  }

  it("answers per the rulebook; writes at most one result; never decides a bracket draw; a repeat or foreign call changes nothing", { timeout: 600_000 }, async () => {
    let runs = 0;
    let checks = 0;
    for (const { pre, cls } of PREFIXES) {
      let k = 0; // this prefix's run index → its cell
      await fc.assert(
        fc.asyncProperty(
          CLASSES[cls],
          fc.constantFrom(...BRACKETS_ALL),
          fc.constantFrom(...DECIDING_ALL),
          fc.array(fc.constantFrom("same", "foreign"), { minLength: 0, maxLength: 2 }),
          async (outcome, bracketKind, decidingKind, tail) => {
            runs++;
            const cell = CELLS[k++ % CELLS.length]!;
            const kind = cell.bracket ? bracketKind : decidingKind;
            const whiteAway = cell.whiteAway;
            const g = await build(pre, kind, whiteAway);
            const bracket = BRACKET_STAGE_KINDS.has(kind);
            expect(bracket, "premise: the cell's kind is the cell's class").toBe(cell.bracket);
            const s = snap(g, outcome.status === "unrecognised"
              ? { status: "unrecognised", rawStatus: "laterStatus", winner: outcome.winner }
              : { status: outcome.status, winner: outcome.winner });
            const nonterminal = outcome.status === "created" || outcome.status === "started";
            const e: Expect = nonterminal || !SETTLED_BEFORE.has(pre) ? rulebook(outcome.status, outcome.winner, bracket) : { wrote: "none" };
            const key = resultIdempotencyKey(g.fixtureId, s);
            const before = await snapshotOf(g.fixtureId);
            let afterFirst: Awaited<ReturnType<typeof snapshotOf>> | null = null;

            for (const [i, call] of ["same", ...tail].entries()) {
              const label = `${pre}/${cls}/${outcome.status}/${outcome.winner}/${kind}/${whiteAway ? "wA" : "wH"} call ${i} ${call}`;
              const out = await writeResultFrom(call === "same" ? s : { ...s, gameId: `${g.gameId}-other` }, g.fixtureId);
              const now = await snapshotOf(g.fixtureId);
              // Invariants after EVERY step.
              expect(now.ledger.map((x) => x.type), `${label}: never a forfeit`).not.toContain("core.forfeit");
              expect(now.ledger.filter((x) => x.type === "core.start").length, `${label}: one start at most`).toBeLessThanOrEqual(1);
              const [{ n: keyed }] = await sql<{ n: number }[]>`
                select count(*)::int as n from score_events where fixture_id = ${g.fixtureId} and idempotency_key = ${key}`;
              expect(keyed, `${label}: our result at most once`).toBeLessThanOrEqual(1);
              if (bracket) expect(now.fixture.outcome?.kind, `${label}: a bracket draw is never decided`).not.toBe("draw");
              checks += 4;

              if (call === "foreign") {
                expect(out, `${label}: a foreign game is never written`).toEqual({ wrote: "none" });
                expect(now, `${label}: nothing moved`).toEqual(afterFirst ?? before);
                bump("foreign");
                continue;
              }
              expect(out, label).toEqual(answerOf(e));
              if (afterFirst !== null) {
                expect(now, `${label}: a repeat changes nothing`).toEqual(afterFirst);
                bump("replay_same");
                continue;
              }
              afterFirst = now;
              // Positive obligations of the FIRST call.
              if (e.wrote === "decided" || e.wrote === "draw") {
                expect(keyed, `${label}: the result IS recorded`).toBe(1);
                const [ev] = await sql<{ payload: { winner: string | null; method?: string } }[]>`
                  select payload from score_events where fixture_id = ${g.fixtureId} and idempotency_key = ${key}`;
                const winner = e.wrote === "decided" ? entrantOf(g, outcome.winner!) : null;
                expect(ev!.payload.winner, `${label}: winner entrant`).toBe(winner);
                expect(ev!.payload.method ?? null, `${label}: method`).toBe(e.method);
                expect(now.fixture.outcome?.kind, label).toBe(e.wrote === "decided" ? "win" : "draw");
                expect(now.ledger.map((x) => x.type).slice(0, before.ledger.length), `${label}: appended, nothing rewritten`)
                  .toEqual(before.ledger.map((x) => x.type));
                expect(now.bridge, `${label}: the bridge is T11's to finish`).toEqual(before.bridge);
                bump(e.wrote);
                bump(pre === "started" ? "already_live" : "started_by_us");
                if (e.wrote === "decided" && whiteAway) bump("white_away_written");
                if (e.wrote === "decided" && bracket) bump("bracket_decisive_written");
              } else if (e.wrote === "aborted" || e.wrote === "needs_organiser") {
                expect(now.ledger, `${label}: a hold writes no event`).toEqual(before.ledger);
                expect(now.bridge!.status, label).toBe("needs_organiser");
                const reason = e.wrote === "aborted" ? "aborted" : e.reason;
                expect(now.bridge!.needs_reason, `${label}: hold reason`).toBe(pre === "held" ? "token_revoked" : reason);
                bump(e.wrote === "aborted" ? "held_aborted" : `held_${e.reason}`);
                if (pre === "held") bump("first_diagnosis_kept");
              } else {
                expect(now, `${label}: nothing moved`).toEqual(before);
                bump(nonterminal ? "none_nonterminal" : "none_settled");
              }
            }
          },
        ),
        { numRuns: RUNS_PER_PREFIX, endOnFailure: true },
      );
    }
    expect(runs, "anti-vacuity: the property ran").toBe(RUNS_PER_PREFIX * PREFIXES.length);
    console.info(`[T12 property] runs=${runs} checks=${checks} ${JSON.stringify(totals)}`);
    let checked = 0;
    for (const path of [
      "decided",
      "draw",
      "held_aborted",
      "held_provider_error",
      "held_tiebreak_owed",
      "none_nonterminal",
      "none_settled",
      "replay_same",
      "foreign",
      "started_by_us",
      "already_live",
      "white_away_written",
      "bracket_decisive_written",
      "first_diagnosis_kept",
    ]) {
      expect(totals[path] ?? 0, `anti-vacuity: ${path}`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(14);
    expect(checks).toBeGreaterThan(0);
  });
});
