// T19 — a fast-check property over interleavings of the organiser's and the
// players' acts on one online Swiss round, driven through the REAL usecases:
//
//   open      openRound                     (a re-open is the same act again)
//   flaky     the provider refuses one current seat's next invite
//   advance   the clock moves 5 or 25 minutes (25 closes a window: T+20)
//   downgrade patchDivision camera_policy one step down (required→optional→off)
//   repair    unpairSwissRound + generateStageFixtures, alternating styles
//   seat      seatPlayer for one current player
//
// Invariants, after every step:
//   I1 at most one stamp per (stage, round)
//   I2 no seat before the open (and none outside the window)
//   I3 at most one invite per player, per board, per pairing
// plus the open's result, the window and the seat outcome against a model
// whose expectation is computed BEFORE each call.
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

import { RealtimeKitError } from "@/server/external-play/video/realtimekit";
import { openRound } from "../open-round";
import { seatPlayer, type PreflightDeps } from "../preflight";
import { generateStageFixtures, unpairSwissRound } from "../../stages";
import { patchDivision } from "../../divisions";
import { seedOnlineSwiss, type SeedOnlineSwissResult } from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const RUNS = 25;

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
  hasLiveVideoPublisher: down,
  refreshParticipantToken: down,
};

type Cmd =
  | { t: "open" }
  | { t: "flaky"; pick: number }
  | { t: "advance"; minutes: 5 | 25 }
  | { t: "downgrade" }
  | { t: "repair" }
  | { t: "seat"; pick: number };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Cmd>({ t: "open" }) },
  { weight: 2, arbitrary: fc.nat(3).map<Cmd>((pick) => ({ t: "flaky", pick })) },
  { weight: 2, arbitrary: fc.constantFrom<Cmd>({ t: "advance", minutes: 5 }, { t: "advance", minutes: 25 }) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ t: "downgrade" }) },
  { weight: 2, arbitrary: fc.constant<Cmd>({ t: "repair" }) },
  { weight: 3, arbitrary: fc.nat(3).map<Cmd>((pick) => ({ t: "seat", pick })) },
);

// Edge prefixes, each ENDING with the claim it exists for, so a random tail
// can never push its path out of reach.
const O: Cmd = { t: "open" };
const PREFIXES: Cmd[][] = [
  [O, O], //                                                     already_open
  [{ t: "flaky", pick: 0 }, O, O], //                            partly invited ⇒ same window
  [{ t: "flaky", pick: 1 }, O, { t: "advance", minutes: 25 }, O], // window_closed
  [O, { t: "repair" }, O], //                                    re-pair ⇒ fresh window
  [{ t: "seat", pick: 2 }], //                                   seat before the open
  [O, { t: "downgrade" }, { t: "seat", pick: 3 }], //            seated
  [O, { t: "advance", minutes: 25 }, { t: "seat", pick: 0 }], // seat after the window
  [O, { t: "seat", pick: 1 }], //                                required + video down
  [],
];

const program = fc
  .tuple(fc.constantFrom(...PREFIXES), fc.array(cmd, { minLength: 2, maxLength: 5 }))
  .map(([prefix, tail]) => [...prefix, ...tail]);

type Seat = { fixtureId: string; entrantId: string; email: string; personId: string };
type Model = {
  stampAt: Date | null;
  epoch: number;
  invited: Set<string>; // `${fixtureId}|${email}` for the CURRENT pairing
  policy: 0 | 1 | 2; // off | optional | required
  clock: Date;
  pairing: "fold" | "rank_adjacent";
};

const POLICIES = ["off", "optional", "required"] as const;

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

const fixtureOfUrl = (url: string) => url.split("/fixtures/")[1]!.split(/[/?#]/)[0]!;

describe.skipIf(!HAS_DB)("openRound — interleavings property", () => {
  it("holds I1–I3 and the model over random interleavings", { timeout: 600_000 }, async () => {
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
      downgrade: 0,
    };
    let runs = 0;
    let steps = 0;
    let invariantChecks = 0;

    await fc.assert(
      fc.asyncProperty(program, async (cmds) => {
        runs += 1;
        mail.sent.length = 0;
        mail.failOnce.clear();
        const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "required" });
        let seats = await currentSeats(s);
        expect(seats, "premise: 4 players ⇒ 2 boards").toHaveLength(4);
        const m: Model = {
          stampAt: null,
          epoch: 0,
          invited: new Set(),
          policy: 2,
          clock: new Date(Date.now() - 3 * 60 * MIN),
          pairing: "fold",
        };
        // I3's ledger: every mail ever sent this run, keyed by pairing epoch.
        const ledger = new Map<string, number>();
        let mailSeen = 0;

        for (const c of cmds) {
          steps += 1;
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
            await unpairSwissRound(s.owner, s.stageId);
            m.pairing = m.pairing === "fold" ? "rank_adjacent" : "fold";
            await generateStageFixtures(s.owner, s.stageId, { pairing: m.pairing });
            seats = await currentSeats(s);
            m.epoch += 1;
            m.invited.clear(); // the unpair deleted the game-less rows
            paths.repair += 1;
          } else if (c.t === "seat") {
            const who = seats[c.pick % seats.length]!;
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
          } else {
            // open — the model's expectation first.
            const pending = seats.filter((x) => !m.invited.has(`${x.fixtureId}|${x.email}`));
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
            } else if (m.invited.size === 0) {
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

            if (want.opened) for (const x of sendable) m.invited.add(`${x.fixtureId}|${x.email}`);
            m.stampAt = nextStamp;
            mail.failOnce.clear(); // flaky is one-shot
          }

          // I1: one stamp per (stage, round), at the model's instant.
          const stamps = await sql<{ opened_at: Date }[]>`
            select opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
          expect(stamps.length).toBeLessThanOrEqual(1);
          expect(stamps[0]?.opened_at.getTime() ?? null).toBe(m.stampAt?.getTime() ?? null);
          // I3: one invite per player, per board, per pairing.
          for (const sent of mail.sent.slice(mailSeen)) {
            const key = `${m.epoch}|${fixtureOfUrl(sent.fixtureUrl)}|${sent.to}`;
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
