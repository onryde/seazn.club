// T20 — online chess behind the PostHog flag `online-chess` (owner 2026-10-11). Every gate that STARTS online play is
// driven here through its REAL usecase, against the real database, with the flag on, off, and PostHog throwing (=
// off): turning online play on for a division (create and patch), opening a round, creating a game, re-sending an
// invite, and demanding a Lichess link at sign-up (registration, the join link, the organiser's roster). Expected
// answers come from the brief (task-20-brief.md: 403 ONLINE_CHESS_DISABLED, fallback off), never from the gates.
//
// And the one safety test the owner kept (2026-10-11, "we don't switch off mid round" — no kill switch, nothing
// more): a game created with the flag ON keeps working once it is OFF — the player still moves and the result still
// lands — while a NEW game and a NEW round are refused.
//
// Seeding runs with ONLINE_CHESS_ALWAYS=1 (the override vitest.config sets for every suite); each case then removes
// the override and answers on the flag alone, through `isServerFeatureEnabled` doubled at its module boundary.
//
// Single-sport by construction: online play exists only for `boardgame` (online-play.ts `supportsOnlinePlay`).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const flags = vi.hoisted(() => ({
  isServerFeatureEnabled: vi.fn<(flag: string, distinctId: string, opts?: { orgId?: string; fallback?: boolean }) => Promise<boolean>>(),
}));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return {
    ...actual,
    isServerFeatureEnabled: (flag: string, distinctId: string, opts?: { orgId?: string; fallback?: boolean }) =>
      flags.isServerFeatureEnabled(flag, distinctId, opts),
  };
});

// The invite sender: the real `send` no-ops without RESEND_API_KEY (vitest.config strips it), which would report every
// invite as failed — replaced exactly as open-round.test.ts replaces it.
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(async (to: string) => {
      mail.sent.push(to);
      return true;
    }),
  };
});

// The Lichess Board API, module-mocked at its boundary as T9's and T12's suites do. Every default REFUSES, so a case
// that reaches Lichess without saying what Lichess answers fails loudly.
const UNEXPECTED = { ok: false, code: "unavailable", raw: "unexpected Board API call" } as const;
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

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import type { GameSnapshot } from "@/server/external-play/types";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { joinTeamEntry, submitRegistrationGroup } from "../registration-submit";
import { createGameIfReady } from "../external-play/create-game";
import { resendExternalPlayNotice } from "../external-play/invite";
import { openRound } from "../external-play/open-round";
import { act } from "../external-play/play";
import { writeResultFrom } from "../external-play/result";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import {
  seedOnlineChessFixture,
  seedOnlineChessRound,
  seedOwner,
  seedPlayer,
  type SeedOnlineChessRoundResult,
} from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DISABLED = { status: 403, code: "ONLINE_CHESS_DISABLED" } as const;
const ORIGIN = "https://seazn.test";
const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");
/** 10+5 — a ship-1 control: createDivision refuses an online clock outside the catalogue (T6). */
const CLOCK = { base: 600, increment: 5 };

type FlagState = { label: string; offered: boolean; arm: () => void };
/** The three states the brief names for every start gate. PostHog THROWING is the evaluator rejecting outright — past
 *  posthog-server's own catch — so the gate's off-on-error is proven, not inherited. */
const FLAG_STATES: readonly FlagState[] = [
  { label: "flag ON", offered: true, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(true) },
  { label: "flag OFF", offered: false, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(false) },
  {
    label: "PostHog throws",
    offered: false,
    arm: () => flags.isServerFeatureEnabled.mockRejectedValue(new Error("posthog unreachable")),
  },
];

/** Seeding runs as local / CI do: the override on, and a flag that must not be asked meanwhile. */
function overrideOn(): void {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
}
/** From here on the gate answers on the flag alone: no override, no kept answer. */
function flagIs(s: FlagState): void {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset();
  s.arm();
}
/** The flag was asked for THIS club (the org group) by THIS distinct id, falling back to off. */
function expectAsked(orgId: string, distinctId: string): void {
  expect(flags.isServerFeatureEnabled).toHaveBeenCalledWith("online-chess", distinctId, { orgId, fallback: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  overrideOn();
  mail.sent.length = 0;
  __resetCreationQueue();
  board.createChallengeToUser.mockImplementation(async () => ({ ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` }));
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue(UNEXPECTED);
  board.submitMove.mockResolvedValue(UNEXPECTED);
  board.resignGame.mockResolvedValue(UNEXPECTED);
  board.offerOrAcceptDraw.mockResolvedValue(UNEXPECTED);
  board.abortGame.mockResolvedValue(UNEXPECTED);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string | undefined }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected a refusal, got a resolve");
}

async function competitionFor(owner: AuthCtx) {
  return createCompetition(owner, {
    name: `Flag Cup ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
}

async function divisionsOf(competitionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from divisions where competition_id = ${competitionId}`;
  return rows.map((r) => r.id);
}

async function storedOnlinePlay(divisionId: string): Promise<unknown> {
  const [row] = await sql<{ online: unknown }[]>`select config->'onlinePlay' as online from divisions where id = ${divisionId}`;
  return row?.online ?? null;
}

// ---------------------------------------------------------------------------
// The organiser turning online play ON.

describe.skipIf(!HAS_DB)("gate: creating a division played online", () => {
  it("flag ON creates it online; flag OFF or PostHog throwing refuses 403 ONLINE_CHESS_DISABLED and writes no division", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const owner = await seedOwner();
      const competition = await competitionFor(owner);
      flagIs(s);
      const made = createDivision(owner, competition.id, {
        name: "Online",
        sport_key: "boardgame",
        variant_key: "classical",
        config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
      });
      if (s.offered) {
        const division = await made;
        expect(await storedOnlinePlay(division.id), s.label).toBe("lichess");
      } else {
        expect(await refusal(made), s.label).toEqual(DISABLED);
        expect(await divisionsOf(competition.id), `${s.label}: nothing written`).toEqual([]);
      }
      expectAsked(owner.orgId, owner.userId!);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("flag OFF: an over-the-board chess division is still created — and the flag is not even asked", async () => {
    const owner = await seedOwner();
    const competition = await competitionFor(owner);
    flagIs(FLAG_STATES[1]!);
    let checked = 0;
    for (const config of [{ variant: "classical" }, { variant: "classical", onlinePlay: "off" }]) {
      const division = await createDivision(owner, competition.id, {
        name: `OTB ${checked}`,
        sport_key: "boardgame",
        variant_key: "classical",
        config,
      });
      expect(await storedOnlinePlay(division.id), JSON.stringify(config)).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("gate: patching a division's online play on", () => {
  async function otbDivision() {
    const owner = await seedOwner();
    const competition = await competitionFor(owner);
    const division = await createDivision(owner, competition.id, {
      name: "Open",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: CLOCK },
    });
    return { owner, division };
  }

  it("off → lichess: flag ON turns it on; flag OFF or PostHog throwing refuses 403 and the division stays off", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const { owner, division } = await otbDivision();
      flagIs(s);
      const patched = patchDivision(owner, division.id, {
        config: { ...(division.config as Record<string, unknown>), onlinePlay: "lichess" },
      });
      if (s.offered) {
        await patched;
        expect(await storedOnlinePlay(division.id), s.label).toBe("lichess");
      } else {
        expect(await refusal(patched), s.label).toEqual(DISABLED);
        expect(await storedOnlinePlay(division.id), `${s.label}: still off`).toBeNull();
      }
      expectAsked(owner.orgId, owner.userId!);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("flag OFF never refuses what does not turn it on: a re-send of 'lichess' on a division already online, turning it off, and an OTB save", async () => {
    const owner = await seedOwner();
    const competition = await competitionFor(owner);
    // Online while the flag was on (the override): what a club whose flag later went off still has.
    const online = await createDivision(owner, competition.id, {
      name: "Online",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
    });
    const otb = await createDivision(owner, competition.id, {
      name: "OTB",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: CLOCK },
    });
    flagIs(FLAG_STATES[1]!);
    let checked = 0;
    // The Entrants / format save re-sends the whole stored config, onlinePlay included.
    await patchDivision(owner, online.id, { config: { ...(online.config as Record<string, unknown>) } });
    expect(await storedOnlinePlay(online.id), "a re-send keeps it online").toBe("lichess");
    checked++;
    await patchDivision(owner, otb.id, { config: { ...(otb.config as Record<string, unknown>), onlinePlay: "off" } });
    expect(await storedOnlinePlay(otb.id), "an OTB save").toBeNull();
    checked++;
    await patchDivision(owner, online.id, { config: { ...(online.config as Record<string, unknown>), onlinePlay: "off" } });
    expect(await storedOnlinePlay(online.id), "turning it OFF is never gated").toBeNull();
    checked++;
    expect(checked).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Opening a round, and re-sending an invite.

describe.skipIf(!HAS_DB)("gate: opening a round", () => {
  async function stampCount(r: SeedOnlineChessRoundResult, roundNo = 1): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from stage_round_opens where stage_id = ${r.stageId} and round_no = ${roundNo}`;
    return row!.n;
  }

  it("flag ON opens and invites; flag OFF or PostHog throwing refuses 403 — no stamp, no invite", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      flagIs(s);
      const opened = openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId });
      if (s.offered) {
        expect(await opened, s.label).toEqual({ opened: true, invited: 2, skipped: [] });
        expect(await stampCount(r), s.label).toBe(1);
        expect(mail.sent.length, s.label).toBe(2);
      } else {
        expect(await refusal(opened), s.label).toEqual(DISABLED);
        expect(await stampCount(r), `${s.label}: no stamp`).toBe(0);
        expect(mail.sent, `${s.label}: nobody mailed`).toEqual([]);
      }
      expectAsked(r.orgId, r.ownerUserId);
      mail.sent.length = 0;
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("flag OFF keeps the refusals that come first: a non-organiser is OPEN_ROUND_FORBIDDEN, an offline round ROUND_NOT_ONLINE — neither asks the flag", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const offline = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, onlinePlay: "off" });
    flagIs(FLAG_STATES[1]!);
    const stranger = await seedPlayer(r.orgId, "Stranger", `x-${randomUUID().slice(0, 8)}`, true);
    expect(await refusal(openRound({ stageId: r.stageId, roundNo: 1, actorUserId: stranger.userId }))).toEqual({
      status: 403,
      code: "OPEN_ROUND_FORBIDDEN",
    });
    expect(await refusal(openRound({ stageId: offline.stageId, roundNo: 1, actorUserId: offline.ownerUserId }))).toEqual({
      status: 422,
      code: "ROUND_NOT_ONLINE",
    });
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("gate: re-sending a board's invite", () => {
  it("flag ON re-sends to both seats; flag OFF or PostHog throwing refuses 403 and mails nobody", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      const b = r.boards[0]!;
      expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }), "premise: opened while on").toMatchObject({ opened: true });
      mail.sent.length = 0;
      flagIs(s);
      const resent = resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN);
      if (s.offered) {
        expect(await resent, s.label).toEqual({ emailed: 2 });
        expect(mail.sent.sort(), s.label).toEqual([b.home.email, b.away.email].sort());
      } else {
        expect(await refusal(resent), s.label).toEqual(DISABLED);
        expect(mail.sent, `${s.label}: nobody mailed`).toEqual([]);
      }
      expectAsked(r.orgId, r.ownerUserId);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });
});

// ---------------------------------------------------------------------------
// Creating a game (T9).

describe.skipIf(!HAS_DB)("gate: creating a game", () => {
  async function openedBoard() {
    return seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      roundOpenedAt: OPENED,
      clock: CLOCK,
    });
  }
  async function challengeOf(fixtureId: string): Promise<string | null> {
    const [row] = await sql<{ challenge_id: string | null }[]>`
      select challenge_id from fixture_external_play where fixture_id = ${fixtureId}`;
    return row?.challenge_id ?? null;
  }

  it("flag ON creates it; flag OFF or PostHog throwing answers online_chess_disabled and never reaches Lichess", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const f = await openedBoard();
      board.createChallengeToUser.mockClear();
      flagIs(s);
      const out = await createGameIfReady(f.fixtureId, { now: NOW, publish: async () => {} });
      if (s.offered) {
        expect(out, s.label).toMatchObject({ created: true });
        expect(board.createChallengeToUser, s.label).toHaveBeenCalledTimes(1);
      } else {
        expect(out, s.label).toEqual({ created: false, reason: "online_chess_disabled" });
        expect(board.createChallengeToUser, `${s.label}: Lichess never called`).not.toHaveBeenCalled();
        expect(await challengeOf(f.fixtureId), `${s.label}: no game recorded`).toBeNull();
      }
      // A system path: no person asks, so the club is asked as itself.
      expectAsked(f.orgId, f.orgId);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("flag OFF: a game already on file still answers `already` — never 'disabled' — and the flag is not asked", async () => {
    const f = await openedBoard();
    const made = await createGameIfReady(f.fixtureId, { now: NOW, publish: async () => {} });
    expect(made, "premise: created while on").toMatchObject({ created: true });
    flagIs(FLAG_STATES[1]!);
    expect(await createGameIfReady(f.fixtureId, { now: NOW, publish: async () => {} })).toEqual({ created: false, reason: "already" });
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

  it("flag OFF: a board whose round was never opened is `not_ready` — the flag is asked only of a board ready to create", async () => {
    const f = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true, clock: CLOCK });
    flagIs(FLAG_STATES[1]!);
    expect(await createGameIfReady(f.fixtureId, { now: NOW, publish: async () => {} })).toEqual({ created: false, reason: "not_ready" });
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Demanding a Lichess link at sign-up: with the flag off, nobody is asked to link.

describe.skipIf(!HAS_DB)("gate: the Lichess link demanded at sign-up", () => {
  async function onlineRegistration(entrantKind: "individual" | "team", approval: "auto" | "manual") {
    const owner = await seedOwner();
    const competition = await competitionFor(owner);
    const division = await createDivision(owner, competition.id, {
      name: "Online",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
    });
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents,
         opens_at, closes_at, form_fields)
      values (${division.id}, true, ${entrantKind}, 0, null, 'offline', ${approval}, false, null, null, ${sql.json([])})`;
    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${owner.orgId}`;
    return { owner, orgSlug: org!.slug, compSlug: competition.slug, divisionId: division.id };
  }
  const contact = () => ({ name: "Alex Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` });

  it("registration: flag ON demands the link (422 LICHESS_LINK_REQUIRED); flag OFF or PostHog throwing does not, and the entry confirms", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const g = await onlineRegistration("individual", "auto");
      flagIs(s);
      const submitted = submitRegistrationGroup(
        { orgSlug: g.orgSlug, compSlug: g.compSlug },
        {
          contact: contact(),
          privacy_consent: true,
          entries: [{ division_id: g.divisionId, entrant_kind: "individual", players: [{ full_name: "Solo Player" }], answers: {} }],
        },
      );
      if (s.offered) {
        expect(await refusal(submitted), s.label).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED" });
      } else {
        const res = await submitted;
        expect(res.entries.map((e) => e.status), s.label).toEqual(["confirmed"]);
      }
      // No session: the club is asked as itself.
      expectAsked(g.owner.orgId, g.owner.orgId);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("the join link: flag ON demands the link; flag OFF or PostHog throwing moves on to the next check (privacy consent)", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const g = await onlineRegistration("team", "manual");
      // The team entry is made with the flag OFF, so its own submit is not what is under test here.
      flagIs(FLAG_STATES[1]!);
      const res = await submitRegistrationGroup(
        { orgSlug: g.orgSlug, compSlug: g.compSlug },
        {
          contact: contact(),
          privacy_consent: true,
          entries: [
            // No player of its own: a chess roster holds one (boardgame's lineup), so the joiner's is the free slot.
            { division_id: g.divisionId, entrant_kind: "team", team_name: "Knights", players: [], answers: {} },
          ],
        },
      );
      const joinCode = res.entries[0]!.join_code;
      expect(joinCode, "premise: a team entry carries a join code").toEqual(expect.any(String));
      flagIs(s);
      // privacy_consent false: the check that comes AFTER the link demand, so the two answers tell the gates apart.
      const err = await joinTeamEntry({}, { join_code: joinCode!, player: { full_name: "Joiner" }, privacy_consent: false }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, s.label).toBeInstanceOf(HttpError);
      if (s.offered) expect(err, s.label).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
      else expect(err, s.label).toMatchObject({ status: 422, code: undefined, message: "Please agree to the privacy policy to join" });
      expectAsked(g.owner.orgId, g.owner.orgId);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("the organiser's roster: flag ON refuses an unlinked player; flag OFF or PostHog throwing enters them", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const owner = await seedOwner();
      const competition = await competitionFor(owner);
      const division = await createDivision(owner, competition.id, {
        name: "Online",
        sport_key: "boardgame",
        variant_key: "classical",
        config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
      });
      const unlinked = await seedPlayer(owner.orgId, "Unlinked", `u-${randomUUID().slice(0, 8)}`, false);
      flagIs(s);
      const entered = createEntrants(owner, division.id, [
        { display_name: "Unlinked", kind: "individual", members: [{ person_id: unlinked.personId, is_captain: false, roles: [] }] },
      ]);
      if (s.offered) {
        expect(await refusal(entered), s.label).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED" });
      } else {
        expect((await entered).length, s.label).toBe(1);
      }
      expectAsked(owner.orgId, owner.userId!);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });
});

// ---------------------------------------------------------------------------
// The one safety test the owner kept: the flag going off mid-round strands no live game.

describe.skipIf(!HAS_DB)("flip-off mid-round: what started keeps finishing; nothing new starts", () => {
  it("a game created with the flag ON: the player still moves and the result still lands once it is OFF; a new game and a new round are refused", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [live, fresh] = r.boards as [SeedOnlineChessRoundResult["boards"][number], SeedOnlineChessRoundResult["boards"][number]];
    // Flag ON (the override): the round opens and the first board's game is created.
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: OPENED })).toMatchObject({ opened: true });
    const gameId = `gm-${randomUUID().slice(0, 12)}`;
    board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: gameId });
    expect(await createGameIfReady(live.fixtureId, { now: NOW, publish: async () => {} })).toEqual({ created: true, gameId });

    // The club's flag goes OFF.
    flagIs(FLAG_STATES[1]!);
    let checked = 0;

    // T10: White (home — the seed's pairing gives White to home) still moves.
    const moved = await act(
      { fixtureId: live.fixtureId, personId: live.home.personId, action: { kind: "move", uci: "e2e4" } },
      { accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: async () => ({ ok: true }) },
    );
    expect(moved, "the move is played").toEqual({ ok: true, applied: true });
    checked++;

    // T12: the result still lands — mate, White wins, so the White seat's entrant (home) is the winner.
    const snapshot = { gameId, status: "mate", winner: "white", movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 } as GameSnapshot;
    expect(await writeResultFrom(snapshot, live.fixtureId), "the result is written").toEqual({ wrote: "decided" });
    const events = await sql<{ type: string; winner: string | null }[]>`
      select type, payload->>'winner' as winner from score_events
       where fixture_id = ${live.fixtureId} and type = 'boardgame.result'`;
    expect(events, "one result event, for White's entrant").toEqual([{ type: "boardgame.result", winner: live.home.entrantId }]);
    checked++;

    // A NEW game — the other board of the same opened round — is refused, and Lichess is never asked.
    board.createChallengeToUser.mockClear();
    expect(await createGameIfReady(fresh.fixtureId, { now: NOW, publish: async () => {} })).toEqual({
      created: false,
      reason: "online_chess_disabled",
    });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
    checked++;

    // A NEW round is refused.
    expect(await refusal(openRound({ stageId: r.stageId, roundNo: 2, actorUserId: r.ownerUserId }))).toEqual(DISABLED);
    checked++;

    // The flag was really consulted, as this club, and really answered off — the refusals above are its doing.
    expectAsked(r.orgId, r.ownerUserId);
    expect(checked).toBe(4);
  });
});
