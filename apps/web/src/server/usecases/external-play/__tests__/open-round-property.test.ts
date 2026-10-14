// T19 — a fast-check property over interleavings of the organiser's and the
// players' acts on one online Swiss round, driven through the REAL usecases:
//
//   open       openRound                     (a re-open is the same act again)
//   flaky      the provider refuses one current seat's next invite
//   advance    the clock moves 5 or 25 minutes (25 closes a window: T+20)
//   downgrade  patchDivision camera_policy one step down (required→optional→off)
//   repair     unpairSwissRound + generateStageFixtures, alternating styles
//              (refused 409 ONLINE_GAME_EXISTS while a game stands)
//   seat       seatPlayer for one current player
//   create     T9 createGameIfReady on one board (fix round 1, review M7)
//   held       the same, with Lichess answering "outcome unknown" (a hold)
//   late       addFixture: a board added to the round after the fact
//   reschedule moveFixture: one board's start time moves (T7's reset)
// and the seed itself is 4 or 5 players — 5 puts a BYE in the round.
//
// Invariants, after every step:
//   I1 at most one stamp per (stage, round), at the model's instant
//   I2 no seat before the open (and none outside the window)
//   I3 at most one invite per player, per board, per pairing, per start time
//   I4 opened_at never moves once any seat in the round was invited — read
//      from the DB (a row bound to the open before the step) AND from the
//      model's own ledger of seats reached this pairing
// plus the open's result, the window, the seat and the create outcome
// against a model whose expectation is computed BEFORE each call.
//
// Single-sport by necessity: online play exists only for boardgame.
import { afterAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { sql } from "@/lib/db";
import { DEADLINE_AFTER_MS, roomPhase } from "@/server/external-play/window";

const mail = vi.hoisted(() => ({
  sent: [] as { to: string; fixtureUrl: string }[],
  failOnce: new Set<string>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(
      async (to: string, args: Parameters<typeof actual.sendExternalPlayInviteEmail>[1]) => {
        if (mail.failOnce.has(to)) return false;
        mail.sent.push({ to, fixtureUrl: args.fixtureUrl });
        return true;
      },
    ),
  };
});

// T9's Lichess calls, module-mocked as T9's own suite does.
const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

// RealtimeKit down for EVERY caller — T9 seats both players through
// seatPlayer's default adapter, so the fake must sit at the module.
vi.mock("@/server/external-play/video/realtimekit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/video/realtimekit")>();
  const down = (): never => {
    throw new actual.RealtimeKitError(503, "unavailable", "fake RealtimeKit is down");
  };
  return {
    ...actual,
    ensureMeeting: down,
    addParticipant: down,
    seatCameraEvidence: down,
    refreshParticipantToken: down,
  };
});

import { randomUUID } from "node:crypto";
import { RealtimeKitError } from "@/server/external-play/video/realtimekit";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { HttpError } from "@/lib/errors";
import { openRound } from "../open-round";
import { seatPlayer, type PreflightDeps } from "../preflight";
import { createGameIfReady } from "../create-game";
import { addFixture, generateStageFixtures, unpairSwissRound } from "../../stages";
import { patchDivision } from "../../divisions";
import { moveFixture } from "../../schedule";
import { seedOnlineSwiss, type SeedOnlineSwissResult } from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const RUNS = 30;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

// RealtimeKit down: `optional` still seats (with no video), `required` answers
// video_unavailable. Either way no network is touched.
const down = (): never => {
  throw new RealtimeKitError(503, "unavailable", "fake RealtimeKit is down");
};
const VIDEO: NonNullable<PreflightDeps["video"]> = {
  ensureMeeting: down,
  addParticipant: down,
  seatCameraEvidence: down,
  refreshParticipantToken: down,
};

type Cmd =
  | { t: "open" }
  | { t: "flaky"; pick: number }
  | { t: "advance"; minutes: 5 | 25 }
  | { t: "downgrade" }
  | { t: "repair" }
  | { t: "seat"; pick: number }
  | { t: "create"; pick: number }
  | { t: "held"; pick: number }
  | { t: "late" }
  | { t: "reschedule"; pick: number };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Cmd>({ t: "open" }) },
  { weight: 2, arbitrary: fc.nat(5).map<Cmd>((pick) => ({ t: "flaky", pick })) },
  { weight: 2, arbitrary: fc.constantFrom<Cmd>({ t: "advance", minutes: 5 }, { t: "advance", minutes: 25 }) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ t: "downgrade" }) },
  { weight: 2, arbitrary: fc.constant<Cmd>({ t: "repair" }) },
  { weight: 3, arbitrary: fc.nat(5).map<Cmd>((pick) => ({ t: "seat", pick })) },
  { weight: 2, arbitrary: fc.nat(2).map<Cmd>((pick) => ({ t: "create", pick })) },
  { weight: 1, arbitrary: fc.nat(2).map<Cmd>((pick) => ({ t: "held", pick })) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ t: "late" }) },
  { weight: 2, arbitrary: fc.nat(2).map<Cmd>((pick) => ({ t: "reschedule", pick })) },
);

// Edge prefixes, each ENDING with the claim it exists for, so a random tail
// can never push its path out of reach.
const O: Cmd = { t: "open" };
const OFF: Cmd[] = [{ t: "downgrade" }, { t: "downgrade" }]; // required → off: T9 can seat both
const A25: Cmd = { t: "advance", minutes: 25 };
const PREFIXES: Cmd[][] = [
  [O, O], //                                                     already_open
  [{ t: "flaky", pick: 0 }, O, O], //                            partly invited ⇒ same window
  [{ t: "flaky", pick: 1 }, O, A25, O], //                       window_closed
  [O, { t: "repair" }, O], //                                    re-pair ⇒ fresh window
  [{ t: "seat", pick: 2 }], //                                   seat before the open
  [O, { t: "downgrade" }, { t: "seat", pick: 3 }], //            seated
  [O, A25, { t: "seat", pick: 0 }], //                           seat after the window
  [O, { t: "seat", pick: 1 }], //                                required + video down
  [O, ...OFF, { t: "create", pick: 0 }], //                      a game is made
  [O, ...OFF, { t: "held", pick: 1 }], //                        a hold (outcome unknown)
  [O, ...OFF, { t: "create", pick: 0 }, { t: "repair" }], //     re-pair refused behind a game
  [O, ...OFF, { t: "create", pick: 0 }, A25, { t: "late" }, O], // review I1: late board, neighbour has a game
  [O, A25, { t: "late" }, O], //                                 late board after the window
  [O, { t: "reschedule", pick: 0 }, O], //                       reschedule ⇒ re-invited in the window
  [O, A25, { t: "reschedule", pick: 1 }, O], //                  reschedule after the window
  [],
];

const program = fc
  .tuple(
    fc.constantFrom(4, 5),
    fc.constantFrom(...PREFIXES),
    fc.array(cmd, { minLength: 2, maxLength: 5 }),
  )
  .map(([players, prefix, tail]) => ({ players, cmds: [...prefix, ...tail] }));

type Seat = { fixtureId: string; entrantId: string; email: string; personId: string };
type Model = {
  stampAt: Date | null;
  epoch: number;
  invited: Set<string>; // `${fixtureId}|${email}` holding a stamp NOW
  reached: Set<string>; // ...reached at all this pairing (a reset does not forget it)
  games: Set<string>; // boards a game stands, or may stand, behind
  stale: Set<string>; // rescheduled, game-less, not yet reset
  version: Map<string, number>; // each board's start-time version (I3)
  late: string | null;
  policy: 0 | 1 | 2; // off | optional | required
  clock: Date;
  pairing: "fold" | "rank_adjacent";
};

const POLICIES = ["off", "optional", "required"] as const;
const ROUND_T = Date.parse("2026-10-01T12:10:00.000Z");

async function currentSeats(s: SeedOnlineSwissResult): Promise<Seat[]> {
  const rows = await sql<{ id: string; home: string; away: string }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures
     where stage_id = ${s.stageId} and round_no = 1 and status = 'scheduled'
       and home_entrant_id is not null and away_entrant_id is not null
     order by seq_in_round, id`;
  const by = new Map(s.players.map((p) => [p.entrantId, p]));
  return rows.flatMap((r) =>
    [r.home, r.away].map((e) => ({ fixtureId: r.id, entrantId: e, email: by.get(e)!.email, personId: by.get(e)!.personId })),
  );
}

/** Lichess accepts every create — and any queued one-shot answer is gone. */
function okCreates() {
  board.createChallengeToUser.mockReset();
  board.createChallengeToUser.mockImplementation(async () => ({ ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` }));
}

const boardsOf = (seats: Seat[]) => [...new Set(seats.map((x) => x.fixtureId))];

/** The open's (or T9's) reset of a rescheduled, game-less board: its stamps
 *  go, so its players are invited again — the binding (`reached`) stays. */
function applyReset(m: Model, fixtureId: string) {
  if (!m.stale.delete(fixtureId)) return;
  for (const k of [...m.invited]) if (k.startsWith(`${fixtureId}|`)) m.invited.delete(k);
}

const fixtureOfUrl = (url: string) => url.split("/fixtures/")[1]!.split(/[/?#]/)[0]!;

describe.skipIf(!HAS_DB)("openRound — interleavings property", () => {
  it("holds I1–I4 and the model over random interleavings", async () => {
    const paths = {
      firstOpen: 0,
      alreadyOpen: 0,
      reinvited: 0,
      reopenedFresh: 0,
      windowClosed: 0,
      sendFailed: 0,
      seatBeforeOpen: 0,
      seated: 0,
      seatWindowClosed: 0,
      seatVideoDown: 0,
      repair: 0,
      repairRefused: 0,
      downgrade: 0,
      created: 0,
      held: 0,
      createRefused: 0,
      late: 0,
      reschedule: 0,
      resetReinvited: 0,
      byeRuns: 0,
      i4Guarded: 0,
    };
    let runs = 0;
    let steps = 0;
    let invariantChecks = 0;

    await fc.assert(
      fc.asyncProperty(program, async ({ players, cmds }) => {
        runs += 1;
        mail.sent.length = 0;
        mail.failOnce.clear();
        vi.clearAllMocks();
        __resetCreationQueue();
        okCreates();
        board.acceptChallenge.mockResolvedValue({ ok: true });
        board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
        board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
        board.cancelChallenge.mockResolvedValue({ ok: true });
        board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });

        const s = await seedOnlineSwiss({ players, pairing: "fold", cameraPolicy: "required" });
        let seats = await currentSeats(s);
        expect(seats, `premise: ${players} players ⇒ 2 boards (a bye for the fifth)`).toHaveLength(4);
        if (players === 5) {
          const [bye] = await sql`select 1 from fixtures where stage_id = ${s.stageId} and round_no = 1 and status = 'forfeited'`;
          expect(bye, "premise: the fifth player's bye").toBeDefined();
          paths.byeRuns += 1;
        }
        const m: Model = {
          stampAt: null,
          epoch: 0,
          invited: new Set(),
          reached: new Set(),
          games: new Set(),
          stale: new Set(),
          version: new Map(),
          late: null,
          policy: 2,
          clock: new Date(Date.now() - 3 * 60 * MIN),
          pairing: "fold",
        };
        let reschedules = 0;
        // I3's ledger: every mail ever sent this run.
        const ledger = new Map<string, number>();
        let mailSeen = 0;
        const stampOf = async () =>
          (
            await sql<{ id: string; opened_at: Date }[]>`
              select id, opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`
          )[0] ?? null;

        for (const c of cmds) {
          steps += 1;
          // I4's "before": a row bound to the open, read from the DB.
          const openBefore = await stampOf();
          const boundBefore = openBefore
            ? (
                await sql<{ any: boolean }[]>`
                  select exists (select 1 from fixture_external_play where round_open_id = ${openBefore.id}) as any`
              )[0]!.any
            : false;
          const reachedBefore = m.reached.size > 0;

          if (c.t === "advance") {
            m.clock = new Date(m.clock.getTime() + c.minutes * MIN);
          } else if (c.t === "flaky") {
            mail.failOnce.add(seats[c.pick % seats.length]!.email);
          } else if (c.t === "downgrade") {
            if (m.policy > 0) {
              m.policy = (m.policy - 1) as 0 | 1;
              await patchDivision(s.owner, s.divisionId, { camera_policy: POLICIES[m.policy] });
              paths.downgrade += 1;
            }
          } else if (c.t === "repair") {
            if (m.late !== null) {
              // A re-pair over the late board would leave generate an extra
              // shell to fill — not this property's subject. Skipped, counted.
            } else if (m.games.size > 0) {
              const before = await currentSeats(s);
              const err = await unpairSwissRound(s.owner, s.stageId).then(
                () => null,
                (e: unknown) => e,
              );
              expect(err instanceof HttpError ? [err.status, err.code] : err).toEqual([409, "ONLINE_GAME_EXISTS"]);
              expect(await currentSeats(s), "a refused re-pair changes no seat").toEqual(before);
              paths.repairRefused += 1;
            } else {
              await unpairSwissRound(s.owner, s.stageId);
              m.pairing = m.pairing === "fold" ? "rank_adjacent" : "fold";
              await generateStageFixtures(s.owner, s.stageId, { pairing: m.pairing });
              seats = await currentSeats(s);
              m.epoch += 1;
              m.invited.clear(); // the unpair deleted the game-less rows
              m.reached.clear();
              m.stale.clear();
              m.version.clear();
              paths.repair += 1;
            }
          } else if (c.t === "late") {
            if (m.late === null) {
              // Two players already on OTHER boards: addFixture does not
              // police repeats, and the late board is a board like any other.
              const a = seats[0]!;
              const b = seats.find((x) => x.fixtureId !== a.fixtureId)!;
              const { fixture_id } = await addFixture(s.owner, s.stageId, {
                home_entrant_id: a.entrantId,
                away_entrant_id: b.entrantId,
                round_no: 1,
                scheduled_at: new Date(ROUND_T).toISOString(),
              });
              m.late = fixture_id;
              seats = await currentSeats(s);
              expect(boardsOf(seats)).toContain(fixture_id);
              paths.late += 1;
            }
          } else if (c.t === "reschedule") {
            const f = boardsOf(seats)[c.pick % boardsOf(seats).length]!;
            reschedules += 1;
            await moveFixture(s.owner, f, { scheduled_at: new Date(ROUND_T + reschedules * 60 * MIN).toISOString() });
            // T9-I1: a row with a game behind it is never reset.
            if (!m.games.has(f)) {
              m.stale.add(f);
              m.version.set(f, (m.version.get(f) ?? 0) + 1);
            }
            paths.reschedule += 1;
          } else if (c.t === "create" || c.t === "held") {
            const f = boardsOf(seats)[c.pick % boardsOf(seats).length]!;
            // Expectation BEFORE the call: T9 creates once the round is open,
            // inside its window, on a board with no game, when both players
            // can be seated (RealtimeKit is down: only off/optional seat).
            const eligible =
              m.stampAt !== null && roomPhase(m.clock, m.stampAt) === "open" && !m.games.has(f) && m.policy < 2;
            if (c.t === "held") {
              board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "timeout" });
            }
            const out = await createGameIfReady(f, { publish: async () => undefined, now: m.clock });
            // A refused create never reaches Lichess, so the one-shot answer
            // would linger into a later call: reset it either way.
            if (c.t === "held") okCreates();
            if (!eligible) {
              expect(out.created, `create refused at step ${steps}`).toBe(false);
              paths.createRefused += 1;
            } else {
              applyReset(m, f); // T9 resets a rescheduled row before it claims
              if (c.t === "held") {
                expect(out).toEqual({ created: false, reason: "provider_error" });
                paths.held += 1;
              } else {
                expect(out.created, `create at step ${steps}: ${JSON.stringify(out)}`).toBe(true);
                paths.created += 1;
              }
              m.games.add(f);
            }
          } else if (c.t === "seat") {
            const open = seats.filter((x) => !m.games.has(x.fixtureId));
            if (open.length > 0) {
              const who = open[c.pick % open.length]!;
              // Expectation BEFORE the call.
              const phase = m.stampAt ? roomPhase(m.clock, m.stampAt) : null;
              const want =
                phase === null
                  ? "round_not_open"
                  : phase === "closed"
                    ? "window_closed"
                    : m.policy === 2
                      ? "video_unavailable"
                      : "seated";
              const got = await seatPlayer({ fixtureId: who.fixtureId, personId: who.personId }, { now: m.clock, video: VIDEO });
              // I2: a seat exists only after the open and inside its window.
              expect(got.seated ? "seated" : got.reason).toBe(want);
              if (got.seated) expect(m.stampAt).not.toBeNull();
              if (want === "round_not_open") paths.seatBeforeOpen += 1;
              else if (want === "window_closed") paths.seatWindowClosed += 1;
              else if (want === "video_unavailable") paths.seatVideoDown += 1;
              else paths.seated += 1;
            }
          } else {
            // open — the model's expectation first. The open resets every
            // rescheduled, game-less board before it reads (T7).
            const resetting = [...m.stale];
            for (const f of resetting) applyReset(m, f);
            const pending = seats.filter((x) => !m.games.has(x.fixtureId) && !m.invited.has(`${x.fixtureId}|${x.email}`));
            const failing = pending.filter((x) => mail.failOnce.has(x.email));
            const sendable = pending.filter((x) => !mail.failOnce.has(x.email));
            const failedBoards = [...new Set(failing.map((x) => x.fixtureId))].sort();
            let want: { opened: boolean; reason?: string; invited?: number; skipped: string[] };
            let nextStamp = m.stampAt;
            let path: keyof typeof paths;
            if (m.stampAt === null) {
              want = { opened: true, invited: sendable.length, skipped: failedBoards.map((f) => `${f}:send_failed`) };
              nextStamp = m.clock;
              path = "firstOpen";
            } else if (pending.length === 0) {
              want = { opened: false, reason: "already_open", skipped: [] };
              path = "alreadyOpen";
            } else if (m.reached.size === 0) {
              want = { opened: true, invited: sendable.length, skipped: failedBoards.map((f) => `${f}:send_failed`) };
              nextStamp = m.clock;
              path = "reopenedFresh";
            } else if (m.clock.getTime() > m.stampAt.getTime() + DEADLINE_AFTER_MS) {
              const boards = [...new Set(pending.map((x) => x.fixtureId))].sort();
              want = { opened: false, reason: "already_open", skipped: boards.map((f) => `${f}:window_closed`) };
              path = "windowClosed";
            } else {
              want = { opened: true, invited: sendable.length, skipped: failedBoards.map((f) => `${f}:send_failed`) };
              path = "reinvited";
              if (resetting.some((f) => sendable.some((x) => x.fixtureId === f))) paths.resetReinvited += 1;
            }

            const res = await openRound(
              { stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId },
              { now: m.clock },
            );
            const got = {
              opened: res.opened,
              ...("reason" in res ? { reason: res.reason } : {}),
              ...("invited" in res ? { invited: res.invited } : {}),
              skipped: ("skipped" in res ? res.skipped : []).map((k) => `${k.fixtureId}:${k.reason}`).sort(),
            };
            expect(got, `${path} at step ${steps}`).toEqual(want);
            paths[path] += 1;
            if (want.skipped.some((k) => k.endsWith(":send_failed"))) paths.sendFailed += 1;

            if (want.opened) {
              for (const x of sendable) {
                m.invited.add(`${x.fixtureId}|${x.email}`);
                m.reached.add(`${x.fixtureId}|${x.email}`);
              }
            }
            m.stampAt = nextStamp;
            mail.failOnce.clear(); // flaky is one-shot
          }

          // I1: one stamp per (stage, round), at the model's instant.
          const stamps = await sql<{ opened_at: Date }[]>`
            select opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
          expect(stamps.length).toBeLessThanOrEqual(1);
          expect(stamps[0]?.opened_at.getTime() ?? null).toBe(m.stampAt?.getTime() ?? null);
          // I4: once any seat of this round was invited, the window never
          // moves — from the DB's binding and from the model's own ledger.
          if (boundBefore || reachedBefore) {
            expect(openBefore, "a seat was invited, so the round was opened").not.toBeNull();
            expect(stamps[0]?.opened_at.getTime(), `I4 at step ${steps} (${c.t})`).toBe(openBefore!.opened_at.getTime());
            paths.i4Guarded += 1;
          }
          // I3: one invite per player, per board, per pairing, per start time.
          for (const sent of mail.sent.slice(mailSeen)) {
            const f = fixtureOfUrl(sent.fixtureUrl);
            const key = `${m.epoch}|${f}|v${m.version.get(f) ?? 0}|${sent.to}`;
            ledger.set(key, (ledger.get(key) ?? 0) + 1);
            expect(ledger.get(key), key).toBe(1);
          }
          mailSeen = mail.sent.length;
          invariantChecks += 1;
        }
      }),
      { numRuns: RUNS, seed: 19_2026_10, endOnFailure: true },
    );

    // Anti-vacuity: the property ran, checked, and reached every path.
    expect(runs).toBe(RUNS);
    expect(steps).toBeGreaterThan(0);
    expect(invariantChecks).toBe(steps);
    for (const [path, n] of Object.entries(paths)) expect(n, `path ${path} never reached`).toBeGreaterThan(0);
    console.info(`[T19 property] runs=${runs} steps=${steps} checks=${invariantChecks} paths=${JSON.stringify(paths)}`);
  });
});
