// W2c X-AB-5 / N2 (fix round 2, ruling): a TABLE stage does not complete while a match is held for the organiser's
// settle. A scorer's plain abandon that decided nobody is stored `abandoned` and used to read as a VOID to the
// completion predicate (`engineFixtureStatus`), so the explicit `POST /stages/{id}/complete` closed the stage - seeding the
// next one, or completing the division - while the desk showed the match held. Ruling 105 closed only a withdrawal's
// EXPUNGE abandon (`expunge: true`: the match left the table); an organiser's plain abandon still holds, as before.
// Real Postgres, real doors (scoreEvent, completeStage, withdrawEntrantCascade); the expected rows come from the engine's
// own kind sets and settle vocabulary, never from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { DRAW_KINDS, SETTLE_METHODS, type StageKind } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { classifyActError } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
import { v1 } from "@/server/api-v1/http";
import { patchDivision } from "../divisions";
import { scoreEvent } from "../scoring";
import { completeStage } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The engine's own settle vocabulary; a rename there reds here by name. */
const SETTLE_BY_ORGANISER = SETTLE_METHODS.find((m) => m === "organiser")!;

// single-sport: generic/score - the sport whose abandon folds to no result in a table stage (so it is HELD), and whose
// table kinds (league, group, americano) the sweep below covers; the predicate itself is sport-blind (rowAwaitsSettle).
type Kind = Extract<StageKind, "league" | "group" | "swiss" | "americano">;
const KINDS: readonly Kind[] = ["league", "group", "swiss", "americano"];

async function rig(kind: Kind) {
  const s = await seedBracket({
    sport: "generic",
    variant: declaredVariant("generic", "score"),
    stageKind: kind,
    entrants: kind === "americano" ? 8 : 4,
    ...(kind === "americano" ? { stageConfig: { mode: "americano", courtCount: 2, rounds: 3 } } : {}),
    // swiss: one round, so "every match played" IS the stage's end (completion is by rounds).
    ...(kind === "swiss" ? { stageConfig: { rounds: 1 } } : {}),
  });
  const rows = await sql<{ id: string; round_no: number; seq_in_round: number; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id from fixtures
     where stage_id = ${s.stageId} and home_entrant_id is not null and away_entrant_id is not null
     order by round_no, seq_in_round`;
  return { ...s, rows };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: AuthCtx, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;
const stageStatus = async (stageId: string) => (await sql<{ status: string }[]>`select status from stages where id = ${stageId}`)[0]!.status;
const divisionStatus = async (divisionId: string) => (await sql<{ status: string }[]>`select status from divisions where id = ${divisionId}`)[0]!.status;

/** Decide a fixture for home by the away side's forfeit: a core event every module folds. */
async function walkoverForHome(t: Rig, id: string): Promise<void> {
  const r = t.rows.find((x) => x.id === id)!;
  await post(t.auth, id, "core.start");
  await post(t.auth, id, "core.forfeit", { by: r.away_entrant_id, reason: "disqualified" });
}
/** A scorer's abandon, the shape the console's "Abandon..." writes: started, then abandoned. */
async function scorerAbandon(t: Rig, id: string): Promise<void> {
  await post(t.auth, id, "core.start");
  await post(t.auth, id, "core.abandon", { reason: "rain" });
  expect(await statusOf(id), "the rig must actually record the abandon").toBe("abandoned");
}
async function playOutExcept(t: Rig, skip: ReadonlySet<string>): Promise<number> {
  let played = 0;
  for (const r of t.rows) {
    if (skip.has(r.id)) continue;
    await walkoverForHome(t, r.id);
    played++;
  }
  return played;
}
type Outcome = { completed: boolean } | { refused: string; data: { reason?: string; abandoned?: { fixtureId: string; round: number; board: number }[] } };
async function tryComplete(t: Rig): Promise<Outcome> {
  try {
    const r = await completeStage(t.auth, t.stageId);
    return { completed: r.completed };
  } catch (e) {
    const err = e as { code?: string; data?: unknown };
    return { refused: err.code ?? String(e), data: (err.data ?? {}) as never };
  }
}
const named = (t: Rig, ids: string[]) =>
  ids.map((id) => {
    const r = t.rows.find((x) => x.id === id)!;
    return { fixtureId: id, round: r.round_no, board: r.seq_in_round };
  });

describe.skipIf(!HAS_DB)("a table stage does not complete while a match is held for settle (X-AB-5 / N2)", () => {
  it("the swept kinds are every draw kind the engine declares (counted)", () => {
    expect(new Set(KINDS).size).toBe(DRAW_KINDS.size);
    for (const k of KINDS) expect(DRAW_KINDS.has(k), k).toBe(true);
  });

  it("empty case first: with nothing abandoned, a stage whose every match is played completes (the rig reaches completion)", async () => {
    let checked = 0;
    for (const kind of KINDS) {
      const t = await rig(kind);
      expect(t.rows.length, `${kind}: the rig has matches`).toBeGreaterThan(1);
      await playOutExcept(t, new Set());
      expect(await tryComplete(t), `${kind}: completes`).toEqual({ completed: true });
      expect(await stageStatus(t.stageId), kind).toBe("complete");
      checked++;
    }
    expect(checked).toBe(KINDS.length);
  }, 240_000);

  it("a plain abandon holds the explicit Complete: it is REFUSED naming the match, and nothing moves; after the settle it completes", async () => {
    let checked = 0;
    for (const kind of KINDS) {
      const t = await rig(kind);
      const held = t.rows[0]!.id;
      await scorerAbandon(t, held);
      const played = await playOutExcept(t, new Set([held]));
      expect(played, `${kind}: every other match is played`).toBe(t.rows.length - 1);
      const refused = await tryComplete(t);
      expect(refused, `${kind}: refused by name`).toEqual({
        refused: "STAGE_NOT_READY",
        data: { stageId: t.stageId, reason: "abandoned_matches", abandoned: named(t, [held]) },
      });
      expect(await stageStatus(t.stageId), `${kind}: the stage is still open`).toBe("active");
      expect(await divisionStatus(t.divisionId), `${kind}: the division is not completed`).not.toBe("completed");
      const [{ events }] = await sql<{ events: number }[]>`
        select count(*)::int as events from division_events where division_id = ${t.divisionId} and type = 'stage_completed'`;
      expect(events, `${kind}: no stage_completed event`).toBe(0);
      // The settle is the way out (a table stage takes it, X-AB-5), and then the stage completes.
      await post(t.auth, held, "core.settle", { winner: t.rows[0]!.home_entrant_id, method: SETTLE_BY_ORGANISER });
      expect(await statusOf(held), `${kind}: the settle decided it`).toBe("decided");
      expect(await tryComplete(t), `${kind}: completes after the settle`).toEqual({ completed: true });
      expect(await stageStatus(t.stageId), kind).toBe("complete");
      checked++;
    }
    expect(checked).toBe(KINDS.length);
  }, 300_000);

  it("sequence: two held matches are named in order; settling one still refuses, naming the other; the void of an abandon is an ordinary open match", async () => {
    const t = await rig("league");
    const [a, b, c] = [t.rows[0]!.id, t.rows[1]!.id, t.rows[2]!.id];
    await scorerAbandon(t, a);
    await scorerAbandon(t, b);
    await playOutExcept(t, new Set([a, b]));
    // Premise: the second match's number in its round differs from its round, so a refusal that named the round twice
    // (or the number twice) cannot pass for the right one.
    expect(named(t, [b])[0]!.board, "rig: round and number differ").not.toBe(named(t, [b])[0]!.round);
    expect(await tryComplete(t), "both named").toMatchObject({ refused: "STAGE_NOT_READY", data: { reason: "abandoned_matches", abandoned: named(t, [a, b]) } });
    await post(t.auth, a, "core.settle", { winner: t.rows[0]!.away_entrant_id, method: SETTLE_BY_ORGANISER });
    expect(await tryComplete(t), "only the second is named now").toMatchObject({ refused: "STAGE_NOT_READY", data: { abandoned: named(t, [b]) } });
    // Voiding the abandon puts the match back in play: nothing is held, but it is not finished either - the soft
    // "not ready" (completed: false), never the by-name refusal.
    const [ev] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${b} and type = 'core.abandon' order by seq desc limit 1`;
    await post(t.auth, b, "core.void", { event_id: ev!.id });
    expect(await statusOf(b), "the void put it back in play").toBe("in_play");
    expect(await tryComplete(t), "an in-play match is not a held one").toEqual({ completed: false });
    expect(c, "rig: a third match exists and was played").toBeTruthy();
  }, 240_000);

  it("a held match beside an UNPLAYED one is the soft not-ready (play it first) - the by-name refusal only when the held match is the sole blocker", async () => {
    let checked = 0;
    for (const kind of KINDS) {
      const t = await rig(kind);
      const [held, open] = [t.rows[0]!.id, t.rows[1]!.id];
      await scorerAbandon(t, held);
      await playOutExcept(t, new Set([held, open]));
      expect(await tryComplete(t), `${kind}: an unplayed match is still open - not ready, and not a by-name refusal`).toEqual({ completed: false });
      await walkoverForHome(t, open);
      expect(await tryComplete(t), `${kind}: now the held match is the only blocker - named`).toMatchObject({
        refused: "STAGE_NOT_READY",
        data: { reason: "abandoned_matches", abandoned: named(t, [held]) },
      });
      checked++;
    }
    expect(checked).toBe(KINDS.length);
  }, 300_000);

  it("a withdrawal's EXPUNGE closes its matches for good: the stage completes with no settle owed (ruling 105)", async () => {
    // league and group: the withdrawal cascade expunges an early leaver's matches (each an abandon with `expunge: true`,
    // stored `abandoned` with an active abandon and no outcome - the same row shape as a scorer's abandon).
    let checked = 0;
    for (const kind of ["league", "group"] as const) {
      const t = await rig(kind);
      const leaver = t.rows[0]!.home_entrant_id;
      const w = await withdrawEntrantCascade(t.auth, leaver);
      expect(w.policy, `${kind}: premise: an early withdrawal expunges`).toBe("expunge");
      const expunged = await sql<{ id: string }[]>`
        select f.id from fixtures f where f.stage_id = ${t.stageId} and f.status = 'abandoned'
           and exists (select 1 from score_events a where a.fixture_id = f.id and a.type = 'core.abandon' and a.payload ->> 'expunge' = 'true')`;
      expect(expunged.length, `${kind}: the leaver's boards are expunged`).toBeGreaterThan(0);
      const left = new Set(expunged.map((r) => r.id));
      const rest = t.rows.filter((r) => !left.has(r.id));
      expect(rest.length, `${kind}: matches remain to play`).toBeGreaterThan(0);
      for (const r of rest) await walkoverForHome(t, r.id);
      expect(await tryComplete(t), `${kind}: completes - an expunge is not a held match`).toEqual({ completed: true });
      checked++;
    }
    expect(checked).toBe(2);
  }, 240_000);

  it("a scorer's abandon beside an expunge: only the scorer's is named (the two rows look alike but for the payload)", async () => {
    const t = await rig("league");
    const leaver = t.rows[3]!.home_entrant_id; // not in the first fixture
    const rained = t.rows.find((r) => r.home_entrant_id !== leaver && r.away_entrant_id !== leaver)!.id;
    await scorerAbandon(t, rained);
    const w = await withdrawEntrantCascade(t.auth, leaver);
    expect(w.policy, "premise: the leaver played nothing, so her boards are expunged").toBe("expunge");
    const gone = new Set(
      (await sql<{ id: string }[]>`
        select f.id from fixtures f where f.stage_id = ${t.stageId} and (f.home_entrant_id = ${leaver} or f.away_entrant_id = ${leaver})`).map((r) => r.id),
    );
    await playOutExcept(t, new Set([rained, ...gone]));
    expect(await tryComplete(t), "only the scorer's abandon is named").toMatchObject({
      refused: "STAGE_NOT_READY",
      data: { reason: "abandoned_matches", abandoned: named(t, [rained]) },
    });
  }, 240_000);

  it("the REAL refusal reaches the organiser: producer (completeStage) -> v1 wire body -> the panel's classifier, naming the players (league and group)", async () => {
    let checked = 0;
    for (const kind of ["league", "group"] as const) {
      const t = await rig(kind);
      const held = t.rows[0]!;
      await scorerAbandon(t, held.id);
      await playOutExcept(t, new Set([held.id]));
      const res = await v1(async () => completeStage(t.auth, t.stageId));
      expect(res.status, kind).toBe(422);
      const { code, message, ...extra } = ((await res.json()) as { error: { code: string; message: string } & Record<string, unknown> }).error;
      expect(code, kind).toBe("STAGE_NOT_READY");
      expect(extra, `${kind}: the wire names the reason and the match`).toEqual({
        reason: "abandoned_matches",
        abandoned: named(t, [held.id]),
      });
      const [home, away] = await Promise.all(
        [held.home_entrant_id, held.away_entrant_id].map(async (id) => (await sql<{ display_name: string }[]>`select display_name from entrants where id = ${id}`)[0]!.display_name),
      );
      const shown = classifyActError(new ApiV1Error(message, res.status, code, extra), msg, "en", undefined, (id) => (id === held.id ? `${home} – ${away}` : undefined));
      expect(shown.tone, `${kind}: amber`).toBe("warning");
      expect(shown.text, `${kind}: the localized sentence, not the server's English`).toBe(msg("schedule.error.completeHeldOne", { matches: `${home} – ${away}` }));
      expect(shown.text).not.toBe(message);
      checked++;
    }
    expect(checked).toBe(2);
  }, 240_000);

  it("auto-advance is unchanged: with auto_progress on the last played match does NOT complete a stage that holds an abandon, and the settle then does", async () => {
    const t = await rig("league");
    await patchDivision(t.auth, t.divisionId, { auto_progress: true });
    const held = t.rows[0]!.id;
    await scorerAbandon(t, held);
    await playOutExcept(t, new Set([held]));
    expect(await stageStatus(t.stageId), "the last result did not close the stage around the held match").toBe("active");
    await post(t.auth, held, "core.settle", { winner: t.rows[0]!.home_entrant_id, method: SETTLE_BY_ORGANISER });
    expect(await stageStatus(t.stageId), "the settle is the last thing owed: auto-advance completes the stage").toBe("complete");
  }, 240_000);
});
