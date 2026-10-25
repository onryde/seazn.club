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
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
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

// The invite's email seam: queued on the outbox, sent through its transport, which is replaced exactly as open-round.test.ts
// replaces it. `mail.sent` holds the addresses the provider accepted.
const mail = vi.hoisted(() => ({ sent: [] as string[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
// The invite is queued on the email outbox and sent after commit through its one network seam; the provider's answer is ours.
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverToAddresses(mail, msg) };
});
beforeEach(() => stubOutboxEnv());

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

// The roster's race (fix round 1, m2): `createEntrants` reads the division on the pooled connection, then resolves the
// entrant cap (`getLimit`), then opens its transaction. A one-shot hook on THAT lookup — the per-division entrant cap,
// asked only there — runs between the pre-read and the transaction, which is where a concurrent "turn online on" lands.
// Pass-through otherwise: every other caller, and every other case, sees the real `getLimit`.
const between = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>), ran: 0 }));
vi.mock("@/lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements")>();
  return {
    ...actual,
    getLimit: async (orgId: string, featureKey: string, competitionId?: string) => {
      const hook = featureKey === "entrants.per_division.max" ? between.hook : null;
      if (hook) {
        between.hook = null;
        between.ran++;
        await hook();
      }
      return actual.getLimit(orgId, featureKey, competitionId);
    },
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import type { GameSnapshot } from "@/server/external-play/types";
import { MINT_CLAIM_STALE_MS } from "@/server/external-play/window";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { joinTeamEntry, submitRegistrationGroup } from "../registration-submit";
import { publicRegistrationInfo } from "../registrations";
import { builtinModules } from "@seazn/engine/sports";
import { createGameIfReady } from "../external-play/create-game";
import { resendExternalPlayNotice } from "../external-play/invite";
import { openRound } from "../external-play/open-round";
import { act } from "../external-play/play";
import { writeResultFrom } from "../external-play/result";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import {
  linkWithoutPlayConsent,
  reconnectLichess,
  seedOnlineChessFixture,
  seedOnlineChessRound,
  seedOwner,
  seedPlayer,
  type SeedOnlineChessRoundResult,
} from "./_external-play-seed";
import { PLAY_SCOPES } from "../external-accounts";

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
  between.hook = null;
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
        expect(await opened, s.label).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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
        expect(await resent, s.label).toEqual({ emailed: 2, retrying: 0 });
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
      board.listOngoingGames.mockClear();
      flagIs(s);
      const out = await createGameIfReady(f.fixtureId, { now: NOW, publish: async () => {} });
      if (s.offered) {
        expect(out, s.label).toMatchObject({ created: true });
        expect(board.createChallengeToUser, s.label).toHaveBeenCalledTimes(1);
      } else {
        expect(out, s.label).toEqual({ created: false, reason: "online_chess_disabled" });
        expect(board.createChallengeToUser, `${s.label}: Lichess never called`).not.toHaveBeenCalled();
        // No send on file (fix round 1, m3): nothing to recover, so not even a lookup — refused before any token is read.
        expect(board.listOngoingGames, `${s.label}: no recovery lookup`).not.toHaveBeenCalled();
        expect(await challengeOf(f.fixtureId), `${s.label}: no game recorded`).toBeNull();
        expect(await markerOf(f.fixtureId), `${s.label}: no bridge row claimed or written`).toBeUndefined();
      }
      // A system path: no person asks, so the club is asked as itself.
      expectAsked(f.orgId, f.orgId);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  // Fix round 1, m3 (controller ruling): a create that was SENT but whose outcome was never recorded (the minter died
  // after Lichess answered) may have a game at Lichess already. Looking it up and adopting it FINISHES play, and
  // finishing is never gated — so the recovery runs whatever the flag says; only a brand-new send is refused.
  type MarkerRow = { status: string; challenge_id: string | null; mint_claimed_at: Date | null; create_sent_at: Date | null };
  const markerOf = async (fixtureId: string): Promise<MarkerRow | undefined> =>
    (await sql<MarkerRow[]>`
      select status, challenge_id, mint_claimed_at, create_sent_at from fixture_external_play where fixture_id = ${fixtureId}`)[0];
  /** A minter that claimed, SENT, and died before its commit (T9's I2 shape): a stale claim carrying the sent marker. */
  async function crashedAfterSend(f: { fixtureId: string; orgId: string }): Promise<Date> {
    const stale = new Date(NOW.getTime() - MINT_CLAIM_STALE_MS - 1);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at, create_sent_at)
      values (${f.fixtureId}, ${f.orgId}, ${T}, ${stale}, ${stale})`;
    return stale;
  }
  /** What OUR create makes (T9's N1 verification): unrated, standard, this suite's 10+5, created just after the send. */
  const ourGame = (gameId: string, sentAt: Date) => ({
    gameId,
    rated: false,
    variant: "standard",
    clockInitialSeconds: CLOCK.base,
    clockIncrementSeconds: CLOCK.increment,
    createdAtMs: sentAt.getTime() + 500,
  });

  it("a create sent before a crash, whose game IS at Lichess: every flag state adopts it — never re-sent, never refused", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const f = await openedBoard();
      const sent = await crashedAfterSend(f);
      const theirs = `gm-${randomUUID().slice(0, 12)}`;
      // White (home — the seed's pairing) is playing Black at Lichess: the game the crashed send made.
      board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [{ gameId: theirs, color: "white", opponentId: f.away.lichessId }] });
      board.exportGameMeta.mockImplementation(async (id: string) =>
        id === theirs ? { ok: true, meta: ourGame(theirs, sent) } : UNEXPECTED,
      );
      board.createChallengeToUser.mockClear();
      flagIs(s);
      const publish = vi.fn(async () => undefined);
      expect(await createGameIfReady(f.fixtureId, { now: NOW, publish }), s.label).toEqual({ created: true, gameId: theirs });
      expect(board.createChallengeToUser, `${s.label}: never re-sent`).not.toHaveBeenCalled();
      expect(await markerOf(f.fixtureId), `${s.label}: recorded and ready`).toMatchObject({
        status: "ready",
        challenge_id: theirs,
        mint_claimed_at: null,
        create_sent_at: null,
      });
      expect(publish, `${s.label}: the lobby is told`).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("a create sent before a crash, whose game is NOT at Lichess: flag ON re-creates; flag OFF or PostHog throwing refuses after the lookup — nothing sent, the claim released, the marker kept", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const f = await openedBoard();
      await crashedAfterSend(f);
      // Both lookups read, complete, and empty: proof nothing of ours exists (the beforeEach defaults).
      board.createChallengeToUser.mockClear();
      board.listOngoingGames.mockClear();
      flagIs(s);
      const out = await createGameIfReady(f.fixtureId, { now: NOW, publish: async () => {} });
      expect(board.listOngoingGames, `${s.label}: the recovery looked first`).toHaveBeenCalledTimes(1);
      if (s.offered) {
        expect(out, s.label).toMatchObject({ created: true });
        expect(board.createChallengeToUser, s.label).toHaveBeenCalledTimes(1);
      } else {
        expect(out, s.label).toEqual({ created: false, reason: "online_chess_disabled" });
        expect(board.createChallengeToUser, `${s.label}: a NEW send is a start — refused`).not.toHaveBeenCalled();
        const row = await markerOf(f.fixtureId);
        expect(row, `${s.label}: claim released, still pending, no game`).toMatchObject({
          status: "pending",
          challenge_id: null,
          mint_claimed_at: null,
        });
        expect(row?.create_sent_at, `${s.label}: the marker stays — never re-sent blind later`).not.toBeNull();
      }
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

  // M7 (T16 fix round 1): the entries step states online play from a PUBLIC read that cannot know who is looking — it
  // asks the flag as the club (registrations.ts publicRegistrationInfo). The submit's link demand must ask the SAME
  // way, or under a person-targeted rollout the notice and the LICHESS_LINK_REQUIRED gate disagree. Signed in here.
  it("M7: a SIGNED-IN registrant's submit asks the flag as the club, exactly as the entries step did — never as the person", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const g = await onlineRegistration("individual", "auto");
      const me = await seedPlayer(g.owner.orgId, "Signed In", `si${randomUUID().slice(0, 6)}`, false);
      flagIs(s);
      const submitted = submitRegistrationGroup(
        { orgSlug: g.orgSlug, compSlug: g.compSlug, sessionUserId: me.userId },
        {
          contact: contact(),
          privacy_consent: true,
          entries: [{ division_id: g.divisionId, entrant_kind: "individual", players: [{ full_name: "Solo Player" }], answers: {} }],
        },
      );
      if (s.offered) expect(await refusal(submitted), s.label).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED" });
      else expect((await submitted).entries.map((e) => e.status), s.label).toEqual(["confirmed"]);
      expectAsked(g.owner.orgId, g.owner.orgId);
      expect(
        flags.isServerFeatureEnabled.mock.calls.filter((c) => c[1] === me.userId),
        `${s.label}: never asked as the person`,
      ).toEqual([]);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  // Owner ruling 2026-10-25: a link the seat gate refuses (identity-only, or short of a play scope) is not "linked" for
  // registration either - the player is told to RECONNECT, before they enter. Asked as the club, like the demand above.
  const soloEntry = (divisionId: string) => ({
    division_id: divisionId,
    entrant_kind: "individual" as const,
    registering_self: true,
    players: [{ full_name: "Solo Player" }],
    answers: {},
  });

  it("registration: a signed-in registrant whose link cannot play is refused 422 LICHESS_RECONSENT_REQUIRED with the flag on; flag OFF or PostHog throwing confirms the entry", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      overrideOn();
      const g = await onlineRegistration("individual", "auto");
      const me = await seedPlayer(g.owner.orgId, "Identity Only", `io${randomUUID().slice(0, 6)}`, false);
      await linkWithoutPlayConsent(me, "identity-only");
      flagIs(s);
      const submitted = submitRegistrationGroup(
        { orgSlug: g.orgSlug, compSlug: g.compSlug, sessionUserId: me.userId },
        { contact: contact(), privacy_consent: true, entries: [soloEntry(g.divisionId)] },
      );
      if (s.offered) expect(await refusal(submitted), s.label).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });
      else expect((await submitted).entries.map((e) => e.status), s.label).toEqual(["confirmed"]);
      expectAsked(g.owner.orgId, g.owner.orgId);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("registration: a grant short of ANY one play scope is refused as reconnect (one case per declared scope); a registrant with no link is still told to LINK", async () => {
    let checked = 0;
    for (const dropped of PLAY_SCOPES) {
      overrideOn();
      const g = await onlineRegistration("individual", "auto");
      const me = await seedPlayer(g.owner.orgId, "Narrow", `nw${randomUUID().slice(0, 6)}`, false);
      await linkWithoutPlayConsent(me, { without: dropped });
      flagIs(FLAG_STATES[0]!);
      expect(
        await refusal(submitRegistrationGroup({ orgSlug: g.orgSlug, compSlug: g.compSlug, sessionUserId: me.userId }, { contact: contact(), privacy_consent: true, entries: [soloEntry(g.divisionId)] })),
        dropped,
      ).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });
      checked++;
    }
    expect(checked, "anti-vacuity: every play scope swept").toBe(PLAY_SCOPES.length);
    overrideOn();
    const g = await onlineRegistration("individual", "auto");
    const nobody = await seedPlayer(g.owner.orgId, "No Link", `nl${randomUUID().slice(0, 6)}`, false);
    flagIs(FLAG_STATES[0]!);
    expect(
      await refusal(submitRegistrationGroup({ orgSlug: g.orgSlug, compSlug: g.compSlug, sessionUserId: nobody.userId }, { contact: contact(), privacy_consent: true, entries: [soloEntry(g.divisionId)] })),
    ).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED" });
  });

  it("registration, the sequence: refused as reconnect, the player reconnects, the same submit now confirms", async () => {
    overrideOn();
    const g = await onlineRegistration("individual", "auto");
    const me = await seedPlayer(g.owner.orgId, "Comes Back", `cb${randomUUID().slice(0, 6)}`, false);
    await linkWithoutPlayConsent(me, "identity-only");
    flagIs(FLAG_STATES[0]!);
    const submit = () =>
      submitRegistrationGroup({ orgSlug: g.orgSlug, compSlug: g.compSlug, sessionUserId: me.userId }, { contact: contact(), privacy_consent: true, entries: [soloEntry(g.divisionId)] });

    expect(await refusal(submit())).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });
    await reconnectLichess(me);

    expect((await submit()).entries.map((e) => e.status)).toEqual(["confirmed"]);
  });

  it("the join link: a signed-in joiner whose link cannot play is refused as reconnect, before the next check (privacy consent)", async () => {
    overrideOn();
    const g = await onlineRegistration("team", "manual");
    flagIs(FLAG_STATES[1]!);
    const res = await submitRegistrationGroup(
      { orgSlug: g.orgSlug, compSlug: g.compSlug },
      { contact: contact(), privacy_consent: true, entries: [{ division_id: g.divisionId, entrant_kind: "team", team_name: "Knights", players: [], answers: {} }] },
    );
    const joinCode = res.entries[0]!.join_code!;
    const joiner = await seedPlayer(g.owner.orgId, "Joiner", `jn${randomUUID().slice(0, 6)}`, false);
    await linkWithoutPlayConsent(joiner, "identity-only");
    flagIs(FLAG_STATES[0]!);

    // privacy_consent false: the check that comes AFTER the link demand, so the answer tells the gates apart.
    const err = await joinTeamEntry({ sessionUserId: joiner.userId }, { join_code: joinCode, player: { full_name: "Joiner" }, privacy_consent: false }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });

    await reconnectLichess(joiner);
    const next = await joinTeamEntry({ sessionUserId: joiner.userId }, { join_code: joinCode, player: { full_name: "Joiner" }, privacy_consent: false }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(next, "reconnected: on to the next check").toMatchObject({ status: 422, message: "Please agree to the privacy policy to join" });
  });

  it("the join link: flag ON demands the link; flag OFF or PostHog throwing moves on to the next check (privacy consent)", async () => {
    let checked = 0;
    // M7: signed out, and signed in — the club is asked either way, never the person.
    for (const [s, signedIn] of FLAG_STATES.flatMap((st) => [[st, false], [st, true]] as const)) {
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
      const joiner = signedIn ? (await seedPlayer(g.owner.orgId, "Joiner", `jn${randomUUID().slice(0, 6)}`, false)).userId : null;
      flagIs(s);
      // privacy_consent false: the check that comes AFTER the link demand, so the two answers tell the gates apart.
      const err = await joinTeamEntry(
        { sessionUserId: joiner },
        { join_code: joinCode!, player: { full_name: "Joiner" }, privacy_consent: false },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      const at = `${s.label}${signedIn ? ", signed in" : ""}`;
      expect(err, at).toBeInstanceOf(HttpError);
      if (s.offered) expect(err, at).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
      else expect(err, at).toMatchObject({ status: 422, code: undefined, message: "Please agree to the privacy policy to join" });
      expectAsked(g.owner.orgId, g.owner.orgId);
      if (joiner !== null) expect(flags.isServerFeatureEnabled.mock.calls.filter((c) => c[1] === joiner), at).toEqual([]);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length * 2);
  });

  // Final review M-11: the entries step states online play only for a sport that can be played online
  // (publicRegistrationInfo: supportsOnlinePlay AND onlinePlay 'lichess'); the submit and the join link demanded the
  // link on the stored config alone. Unreachable through the API, which refuses 'lichess' for any other sport — so the
  // stored state is forced by labelled SQL, and the answer must come from the sport check. Registry sweep, flag ON.
  /** What the entries step tells this division's registrants: does it play online? */
  const statedOnline = async (g: { orgSlug: string; compSlug: string; divisionId: string }) =>
    (await publicRegistrationInfo(g.orgSlug, g.compSlug)).divisions.find((d) => d.division_id === g.divisionId)!.online_play;

  it("M-11: the submit demands the link exactly where the entries step states online play — boardgame, and no other sport whatever its stored config (registry sweep)", async () => {
    let checked = 0;
    for (const mod of builtinModules) {
      overrideOn();
      const g = await onlineRegistration("individual", "auto");
      if (mod.key !== "boardgame") await sql`update divisions set sport_key = ${mod.key} where id = ${g.divisionId}`;
      flagIs(FLAG_STATES[0]!);
      const stated = await statedOnline(g);
      expect(stated, `${mod.key}: the entries step`).toBe(mod.key === "boardgame");
      // The entries step's answer is kept per club: forgotten, so the submit asks (or not) on its own.
      forgetOnlineChessFlagCache();
      flags.isServerFeatureEnabled.mockClear();
      const answer = await submitRegistrationGroup(
        { orgSlug: g.orgSlug, compSlug: g.compSlug },
        {
          contact: contact(),
          privacy_consent: true,
          entries: [{ division_id: g.divisionId, entrant_kind: "individual", players: [{ full_name: "Solo Player" }], answers: {} }],
        },
      ).then(
        () => "accepted",
        (e: unknown) => (e instanceof HttpError ? (e.code ?? `${e.status} ${e.message}`) : String(e)),
      );
      // Another sport may refuse this entry for its own reasons; it is never asked for a Lichess link.
      if (stated) expect(answer, mod.key).toBe("LICHESS_LINK_REQUIRED");
      else expect(answer, mod.key).not.toBe("LICHESS_LINK_REQUIRED");
      expect(flags.isServerFeatureEnabled.mock.calls.length > 0, `${mod.key}: the flag asked`).toBe(stated);
      checked++;
    }
    expect(checked, "anti-vacuity: sports swept").toBe(builtinModules.length);
    expect(builtinModules.some((m) => m.key === "boardgame"), "premise: the one online sport is in the registry").toBe(true);
  });

  it("M-11: the join link likewise — a team of another sport with a stored onlinePlay 'lichess' asks no joiner for a link (registry sweep)", async () => {
    let checked = 0;
    for (const mod of builtinModules) {
      overrideOn();
      const g = await onlineRegistration("team", "manual");
      // The team entry is made as chess with the flag OFF (as the join-link test above does); the sport moves after.
      flagIs(FLAG_STATES[1]!);
      const res = await submitRegistrationGroup(
        { orgSlug: g.orgSlug, compSlug: g.compSlug },
        { contact: contact(), privacy_consent: true, entries: [{ division_id: g.divisionId, entrant_kind: "team", team_name: "Knights", players: [], answers: {} }] },
      );
      const joinCode = res.entries[0]!.join_code!;
      if (mod.key !== "boardgame") await sql`update divisions set sport_key = ${mod.key} where id = ${g.divisionId}`;
      flagIs(FLAG_STATES[0]!);
      const stated = await statedOnline(g);
      expect(stated, `${mod.key}: the entries step`).toBe(mod.key === "boardgame");
      // privacy_consent false: the check right AFTER the link demand, so the two answers tell the gates apart.
      const err = await joinTeamEntry({ sessionUserId: null }, { join_code: joinCode, player: { full_name: "Joiner" }, privacy_consent: false }).then(
        () => null,
        (e: unknown) => e,
      );
      if (stated) expect(err, mod.key).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
      else expect(err, mod.key).toMatchObject({ status: 422, message: "Please agree to the privacy policy to join" });
      checked++;
    }
    expect(checked, "anti-vacuity: sports swept").toBe(builtinModules.length);
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

  it("the roster's race: a division the pre-read saw over the board but the transaction sees online demands the link (422) — the flag was never asked, and an unasked answer fails closed", async () => {
    const owner = await seedOwner();
    const competition = await competitionFor(owner);
    const division = await createDivision(owner, competition.id, {
      name: "Turning online",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: CLOCK },
    });
    expect(await storedOnlinePlay(division.id), "premise: over the board when the roster save starts").toBeNull();
    const unlinked = await seedPlayer(owner.orgId, "Unlinked", `u-${randomUUID().slice(0, 8)}`, false);
    // Were it asked, the flag would say ON — so a pass here could only come from treating "never asked" as "off".
    flagIs(FLAG_STATES[0]!);
    // The organiser turns online play on between the roster's pre-read and its transaction (by SQL: the gate on that
    // save is not what is under test here).
    between.hook = async () => {
      await sql`update divisions set config = config || ${sql.json({ onlinePlay: "lichess" })} where id = ${division.id}`;
    };
    between.ran = 0;
    const entered = createEntrants(owner, division.id, [
      { display_name: "Unlinked", kind: "individual", members: [{ person_id: unlinked.personId, is_captain: false, roles: [] }] },
    ]);
    expect(await refusal(entered)).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    // Anti-vacuity: the race really ran, in the window it names — the pre-read saw the division OTB (so the flag was
    // never asked), and the transaction saw it online.
    expect(between.ran, "the turn-on landed between the pre-read and the transaction").toBe(1);
    expect(flags.isServerFeatureEnabled, "the pre-read saw it over the board").not.toHaveBeenCalled();
    expect(await storedOnlinePlay(division.id), "online by the time the transaction read it").toBe("lichess");
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${division.id}`;
    expect(count!.n, "nobody entered").toBe(0);
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
