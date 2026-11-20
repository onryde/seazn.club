// Match Day online (Task 4, spec docs/superpowers/specs/2026-11-05-match-day-all-in-one-design.md section 5.4): the competition desk raises one
// attention PER BOARD for the held and the flagged boards of its online chess divisions - `board_held` (red) and `board_flagged` (amber) -
// read from the two listers the division page's queue and Match Day read (owner O2). The producer is `onlineBoardAttentions`
// (competition-desk.ts); the consumers are `needsYouItems` (the Needs-you rows) and the Match Day view.
//
// Real Postgres, the product's own writers wherever one reaches the state: `openRound` for a link hold (a player with no Lichess link),
// `reconnectLichess` + `openRound` for the re-open that clears it, `closeExternalPlayFlags` for a settled flag, `setOrgPlan` + the
// competition quota for the billing freeze. Where no writer reaches the state without a network (a no-show hold, a camera flag) the row
// the writer would leave is seeded (`_match-day-online-seed.ts` names which). Every expected value is a seed value or a rule's own word:
// a board's number is the fixture's `seq_in_round`, a round's key is `stageId:roundNo`, a name is the person's `full_name`.
//
// The held-board premise the brief carried ("a held board on a `needs_decision` fixture raises BOTH rows") is false and is pinned as it is:
// the held lister lists only a board still to be played (`isPlayableFixtureStatus`: scheduled, in_play), so a held bridge row on a fixture
// the engine moved to `needs_decision` is the DESK's `needs_decision` row and nothing else.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { builtinModules } from "@seazn/engine/sports";
import { stubOutboxEnv } from "./_invite-mail";

// The real open (the link-hold case) invites by mail: nothing here may reach the network.
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: () => Promise.resolve({ ok: false as const, reason: "http" as const, status: 422, errorName: "validation_error", detail: "refused" }),
}));
// The two listers, wrapped so a test can make one throw or hand the desk a row it cannot name; every other call is the real one.
vi.mock("../external-play/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-play/queue")>();
  return { ...actual, listNeedsOrganiserExternalPlay: vi.fn(actual.listNeedsOrganiserExternalPlay) };
});
vi.mock("../external-play/arbiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-play/arbiter")>();
  return { ...actual, listFlaggedExternalPlay: vi.fn(actual.listFlaggedExternalPlay) };
});
// The club's online-chess flag: the override (vitest.config) is on; a test that needs the flag asked takes it off and answers here.
const flag = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn<(f: string, id: string, o?: { orgId?: string; fallback?: boolean }) => Promise<boolean>>() }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: (f: string, id: string, o?: { orgId?: string; fallback?: boolean }) => flag.isServerFeatureEnabled(f, id, o) };
});

import en from "@/dictionaries/en/ui.json";
import type { Attention } from "@/lib/division-phase";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n";
import { HELD_TITLE_KEYS } from "@/components/v2/external-play-held-copy";
import { needsYouItems } from "@/components/v2/desk/needs-you";
import { MatchDayView } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { isLinkHold, NEEDS_REASONS } from "@/server/external-play/types";
import { getCompetitionDesk, type CompetitionDesk } from "../competition-desk";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { closeExternalPlayFlags } from "../external-play/flags";
import { listFlaggedExternalPlay } from "../external-play/arbiter";
import { listNeedsOrganiserExternalPlay } from "../external-play/queue";
import { openRound } from "../external-play/open-round";
import { getMatchDay } from "../match-day";
import { readOnlineRounds } from "../match-day-online";
import { createDivision } from "../divisions";
import { createStages } from "../stages";
import { reconnectLichess, seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";
import { MIN, NOW, bridgeRow, openFlag, setFixtureStatus } from "./_match-day-online-seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "");
  stubOutboxEnv();
  forgetOnlineChessFlagCache();
});
afterEach(() => vi.unstubAllEnvs());

type Held = Extract<Attention, { kind: "board_held" }>;
type Flagged = Extract<Attention, { kind: "board_flagged" }>;

/** The desk of the competition, read as `auth`. */
const deskOf = (auth: AuthCtx, competitionId: string): Promise<CompetitionDesk> => getCompetitionDesk(auth, competitionId, NOW);
const attentionsOf = (desk: CompetitionDesk, divisionId: string): Attention[] => {
  const d = desk.divisions.get(divisionId);
  if (!d) throw new Error(`test: division ${divisionId} is not on the desk`);
  return d.attention;
};
const heldOf = (list: Attention[]): Held[] => list.filter((a): a is Held => a.kind === "board_held");
const flaggedOf = (list: Attention[]): Flagged[] => list.filter((a): a is Flagged => a.kind === "board_flagged");
const kindsOf = (list: Attention[]): string[] => list.map((a) => a.kind);
const heldIds = (list: Attention[]): string[] => heldOf(list).map((a) => a.fixtureId).sort();
const flaggedIds = (list: Attention[]): string[] => flaggedOf(list).map((a) => a.fixtureId).sort();

/** The person's name, as the seed wrote it: the lister names a player by `persons.full_name`. */
async function nameOf(personId: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`select full_name as name from persons where id = ${personId}`;
  if (!row) throw new Error(`test: person ${personId} not found`);
  return row.name;
}
/** The Needs-you rows the desk's own list builds from the desk read, for the division of `r`. */
function rowsOf(desk: CompetitionDesk, r: Pick<SeedOnlineChessRoundResult, "divisionId">) {
  return needsYouItems(en as unknown as Dict, desk, [{ id: r.divisionId, name: "Open", slug: "open" }], "acme", "spring", "en");
}

/** A round of `n` boards, the round NOT yet opened (the bridge rows these tests seed stand for what the open and the sweep leave). */
const round = (n: number): Promise<SeedOnlineChessRoundResult> => seedOnlineChessRound({ fixtures: n, scheduledAt: null });
const hold = (r: Pick<SeedOnlineChessRoundResult, "orgId">, b: SeedRoundBoard, reason: (typeof NEEDS_REASONS)[number] = "no_show_white") =>
  bridgeRow(b.fixtureId, r.orgId, { status: "needs_organiser", reason });
/** A board played to the end with an OPEN camera flag on it (a report lands after the game). */
async function flaggedBoard(r: Pick<SeedOnlineChessRoundResult, "orgId">, b: SeedRoundBoard, flags = 1): Promise<string[]> {
  await bridgeRow(b.fixtureId, r.orgId, { status: "finished", moves: 10 });
  await setFixtureStatus(b.fixtureId, "decided");
  const kinds = ["out_of_band_play", "camera_lost", "multiple_devices"] as const;
  const ids: string[] = [];
  for (let i = 0; i < flags; i++) ids.push(await openFlag(r.orgId, b.fixtureId, { kind: kinds[i]! }));
  return ids;
}

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("the desk's per-board attentions: the empty case, then one row per held or flagged board", () => {
  it("EMPTY CASE FIRST: an online division with boards and nothing held or flagged raises neither kind (the rest of its desk is unchanged)", async () => {
    const r = await round(2);

    const desk = await deskOf(r.owner, r.competitionId);
    const list = attentionsOf(desk, r.divisionId);

    expect(kindsOf(list)).not.toContain("board_held");
    expect(kindsOf(list)).not.toContain("board_flagged");
    expect(list.length, "premise: the division's own attention is still read (its undated boards)").toBeGreaterThan(0);
    expect(kindsOf(list)).toContain("unscheduled");
    expect(rowsOf(desk, r).map((i) => i.kind)).not.toContain("board_held");
  });

  it("a held board is ONE board_held row naming its fixture, stage, round, board, players and reason - and no needs_decision beside it", async () => {
    const r = await round(2);
    const [held] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await hold(r, held, "no_show_white");

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(heldOf(list)).toEqual([
      {
        kind: "board_held",
        fixtureId: held.fixtureId,
        stageId: r.stageId,
        roundNo: 1,
        boardNo: 1,
        home: await nameOf(held.home.personId),
        away: await nameOf(held.away.personId),
        reason: "no_show_white",
        reopen: false,
      },
    ]);
    expect(kindsOf(list), "a bridge hold is no fixture status: the desk's own held-fixture row is not raised for it").not.toContain("needs_decision");
    expect(flaggedOf(list)).toEqual([]);
  });

  it("a held board is raised once per read: a second read of the same state is the same list (second poll)", async () => {
    const r = await round(2);
    await hold(r, r.boards[0]!);

    const first = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);
    const second = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(heldOf(first), "premise: one row").toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("a held board and a fixture the ENGINE holds (needs_decision) are two rows of two kinds, nothing dropped, the red kind ahead of the held board", async () => {
    const r = await round(3);
    const [held, decided] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await hold(r, held);
    await setFixtureStatus(decided.fixtureId, "needs_decision");

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(list.filter((a) => a.kind === "needs_decision")).toEqual([{ kind: "needs_decision", count: 1, fixtureIds: [decided.fixtureId] }]);
    expect(heldIds(list)).toEqual([held.fixtureId]);
    const order = kindsOf(list);
    expect(order.indexOf("needs_decision"), "needs_decision ranks before board_held (KIND_ORDER)").toBeLessThan(order.indexOf("board_held"));
    expect(order.indexOf("board_held"), "board_held is red: ahead of every amber").toBeLessThan(order.indexOf("unscheduled"));
  });

  it("brief premise, corrected: a held bridge row on a fixture the engine moved to needs_decision raises ONLY needs_decision (the lister reads a board still to be played)", async () => {
    const r = await round(2);
    const [b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await hold(r, b);
    await setFixtureStatus(b.fixtureId, "needs_decision");
    // The premise, read through the real lister: it no longer lists the board.
    expect((await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).map((x) => x.fixtureId), "premise: not listed").toEqual([]);

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(list.filter((a) => a.kind === "needs_decision")).toEqual([{ kind: "needs_decision", count: 1, fixtureIds: [b.fixtureId] }]);
    expect(heldOf(list), "not counted twice").toEqual([]);
  });

  it("a flagged board is ONE board_flagged row with its open-flag count; two flags on one board are one row, flags: 2", async () => {
    const r = await round(3);
    const [one, two] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await flaggedBoard(r, one, 1);
    await flaggedBoard(r, two, 2);

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    const byFixture = new Map(flaggedOf(list).map((a) => [a.fixtureId, a]));
    expect(byFixture.size, "one row per board").toBe(2);
    expect(byFixture.get(one.fixtureId)).toEqual({
      kind: "board_flagged",
      fixtureId: one.fixtureId,
      roundNo: 1,
      boardNo: 1,
      home: await nameOf(one.home.personId),
      away: await nameOf(one.away.personId),
      flags: 1,
    });
    expect(byFixture.get(two.fixtureId)).toMatchObject({ boardNo: 2, flags: 2 });
    expect(heldOf(list)).toEqual([]);
  });

  it("a flagged board names its players by SEAT, home first, whichever colour each plays (the lister speaks in colours): white on the away seat, and on the home seat", async () => {
    const r = await round(3);
    const [homeWhite, awayWhite] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await flaggedBoard(r, homeWhite, 1);
    await flaggedBoard(r, awayWhite, 1);
    await sql`update fixture_external_play set white_side = 'away' where fixture_id = ${awayWhite.fixtureId}`;
    const [colours] = await sql<{ n: number }[]>`select count(distinct white_side)::int as n from fixture_external_play where fixture_id in ${sql([homeWhite.fixtureId, awayWhite.fixtureId])}`;
    expect(colours!.n, "premise: the two boards seat white differently").toBe(2);

    const byFixture = new Map(flaggedOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId)).map((a) => [a.fixtureId, a]));

    for (const b of [homeWhite, awayWhite]) {
      expect(byFixture.get(b.fixtureId), b.fixtureId).toMatchObject({ home: await nameOf(b.home.personId), away: await nameOf(b.away.personId) });
    }
    expect(byFixture.size).toBe(2);
  });

  it("a board both held and flagged is one row of each kind, the same fixture", async () => {
    const r = await round(2);
    const [b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await hold(r, b, "fair_play");
    await openFlag(r.orgId, b.fixtureId, { kind: "camera_lost" });

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(heldIds(list)).toEqual([b.fixtureId]);
    expect(flaggedIds(list)).toEqual([b.fixtureId]);
    const rows = rowsOf(await deskOf(r.owner, r.competitionId), r).filter((i) => i.fixture_id === b.fixtureId);
    expect(rows.map((i) => i.kind).sort(), "two Needs-you rows, one per kind").toEqual(["board_flagged", "board_held"]);
    expect(new Set(rows.map((i) => i.key)).size, "distinct keys").toBe(2);
  });

  it("two held boards are two rows with two distinct Needs-you keys, each opening its own board", async () => {
    const r = await round(3);
    const [a, b] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await hold(r, a);
    await hold(r, b, "no_show_both");

    const desk = await deskOf(r.owner, r.competitionId);
    const rows = rowsOf(desk, r).filter((i) => i.kind === "board_held");

    expect(heldOf(attentionsOf(desk, r.divisionId)).map((x) => x.boardNo).sort()).toEqual([1, 2]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((i) => i.key)).size).toBe(2);
    expect(rows.map((i) => i.action.href).sort()).toEqual(
      [a.fixtureId, b.fixtureId].map((id) => `/o/acme/c/spring/match-day?board=${encodeURIComponent(id)}`).sort(),
    );
  });

  it("a board the viewer plays on raises nothing for them (held and flagged), while the other boards still do - and another organiser sees it", async () => {
    const r = await round(3);
    const [mine, other, third] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    for (const b of [mine, other]) await hold(r, b);
    await flaggedBoard(r, third, 1);
    await openFlag(r.orgId, mine.fixtureId, { kind: "camera_lost" });
    // The organiser who is also the home player of the first board: the lister's own seating rule (`fixturesSeating`) says so.
    const playing: AuthCtx = { ...r.owner, userId: mine.home.userId };

    const seen = attentionsOf(await deskOf(playing, r.competitionId), r.divisionId);
    const elsewhere = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(heldIds(seen), "the board they play on is another organiser's").toEqual([other.fixtureId]);
    expect(flaggedIds(seen), "and its flag too").toEqual([third.fixtureId]);
    expect(heldIds(elsewhere), "positive pair: the same boards for an organiser who does not play").toEqual([mine.fixtureId, other.fixtureId].sort());
    expect(flaggedIds(elsewhere)).toEqual([mine.fixtureId, third.fixtureId].sort());
  });

  it("owner O2: the desk's board rows are the two listers' boards - the same ids, as sets, and not an empty set", async () => {
    const r = await round(4);
    const [a, b, c, d] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await hold(r, a);
    await hold(r, b, "provider_error");
    await flaggedBoard(r, c, 1);
    await openFlag(r.orgId, d.fixtureId, { kind: "multiple_devices" });

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);
    const queue = (await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).filter((x) => !x.seated).map((x) => x.fixtureId).sort();
    const flagged = (await listFlaggedExternalPlay(r.owner, r.divisionId)).boards.map((x) => x.fixtureId).sort();

    expect(heldIds(list)).toEqual([a.fixtureId, b.fixtureId].sort());
    expect(flaggedIds(list)).toEqual([c.fixtureId, d.fixtureId].sort());
    expect(heldIds(list), "the held lister's boards").toEqual(queue);
    expect(flaggedIds(list), "the flagged lister's boards").toEqual(flagged);
    expect(queue.length + flagged.length, "anti-vacuity: both listers are non-empty").toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("owner O1: a cancelled board is listed only while a flag is open (the sequence through the product's own close)", () => {
  it("a cancelled board with an open flag is one board_flagged row; once its flag is settled it is nowhere; a cancelled board with no flag never was", async () => {
    const r = await round(3);
    const [flaggedCancelled, quietCancelled] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await setFixtureStatus(flaggedCancelled.fixtureId, "cancelled");
    await setFixtureStatus(quietCancelled.fixtureId, "cancelled");
    const flagId = await openFlag(r.orgId, flaggedCancelled.fixtureId);

    const before = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);
    expect(flaggedIds(before), "only the one with an open flag").toEqual([flaggedCancelled.fixtureId]);
    expect(heldOf(before)).toEqual([]);

    expect(await closeExternalPlayFlags(r.owner, flaggedCancelled.fixtureId, [flagId])).toEqual({ closed: 1, stillOpen: 0 });

    const after = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);
    expect(flaggedOf(after), "settled: gone from the next read").toEqual([]);
  });

  it("a held board that is then voided or settled another way (the fixture leaves scheduled/in_play) is no longer a board_held row", async () => {
    const r = await round(2);
    const [b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await hold(r, b);
    expect(heldIds(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId)), "premise: held").toEqual([b.fixtureId]);

    for (const status of ["cancelled", "decided", "forfeited", "abandoned"]) {
      await setFixtureStatus(b.fixtureId, status);
      expect(heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId)), status).toEqual([]);
    }
    await setFixtureStatus(b.fixtureId, "scheduled");
    expect(heldIds(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId)), "back to be played: held again").toEqual([b.fixtureId]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The seam, producer to consumer (the lesson of the inert seams): a link hold written by the product's OWN `openRound` for a player with no
// Lichess link, read through the desk and the Needs-you row builder, whose action must open the ROUND that `readOnlineRounds` lists - and the
// re-open the product offers (the player links, the organiser opens again) must clear it.
describe.runIf(HAS_DB)("MD-R2: a link hold from the REAL open points at the round's Open round, and the re-open clears it", () => {
  const MIN_AGO = (n: number): Date => new Date(Date.now() - n * MIN);

  async function linkHeldRound(): Promise<{ r: SeedOnlineChessRoundResult; unlinked: SeedRoundBoard; fine: SeedRoundBoard }> {
    const r = await round(2);
    const [unlinked, fine] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await sql`delete from user_external_accounts where user_id = ${unlinked.away.userId} and provider = 'lichess'`;
    const opened = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: MIN_AGO(2) });
    // The mail transport above refuses every send, so the invited board is `send_failed` beside the held one: the hold is what this reads.
    expect(opened, "premise: the real open stamped the round and held the board").toMatchObject({
      opened: true,
      skipped: expect.arrayContaining([{ fixtureId: unlinked.fixtureId, reason: "lichess_unlinked" }]),
    });
    const [row] = await sql<{ status: string; reason: string | null }[]>`
      select status, needs_reason as reason from fixture_external_play where fixture_id = ${unlinked.fixtureId}`;
    expect(row, "premise: the hold row the open wrote").toEqual({ status: "needs_organiser", reason: "lichess_unlinked" });
    return { r, unlinked, fine };
  }

  it("the editor's row opens the ROUND (?round=, the very key readOnlineRounds lists), 'Open round 1 again', carrying round_key AND the board's fixture id", async () => {
    const { r, unlinked } = await linkHeldRound();

    const desk = await deskOf(r.owner, r.competitionId);
    const held = heldOf(attentionsOf(desk, r.divisionId));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ fixtureId: unlinked.fixtureId, reason: "lichess_unlinked", reopen: true, stageId: r.stageId, roundNo: 1 });

    const [item] = rowsOf(desk, r).filter((i) => i.kind === "board_held");
    // The consumer's own key for the round: the Match Day round row `readOnlineRounds` produces (the T2 reader), never a string built here.
    const rounds = await readOnlineRounds(r.owner, r.competitionId, new Date());
    expect(rounds.map((x) => x.key), "premise: the round is listed (a hold keeps it in the day)").toContain(`${r.stageId}:1`);
    const roundKey = rounds.find((x) => x.division_id === r.divisionId)!.key;
    expect(item!.round_key).toBe(roundKey);
    expect(item!.action).toEqual({ label: "Open round 1 again", href: `/o/acme/c/spring/match-day?round=${encodeURIComponent(roundKey)}` });
    expect(item!.fixture_id).toBe(unlinked.fixtureId);
    expect(item!.sub, "the chip word of the reason, the held-copy table's own").toBe(t(en as unknown as Dict, HELD_TITLE_KEYS.lichess_unlinked));
  });

  it("SEQUENCE: the player links and the organiser opens again - the board is invited, the hold row is gone, and the NEXT read has no board_held row (twice: a second poll too)", async () => {
    const { r, unlinked, fine } = await linkHeldRound();
    expect(heldIds(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId)), "premise: held before").toEqual([unlinked.fixtureId]);

    await reconnectLichess(unlinked.away);
    const again = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: MIN_AGO(1) });
    const stillHeld = "skipped" in again ? again.skipped.filter((x) => x.reason === "lichess_unlinked" || x.reason === "lichess_reconnect") : [];
    expect(stillHeld, "premise: the re-open no longer reports the board held").toEqual([]);
    const [after] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${unlinked.fixtureId}`;
    expect(after?.status, "premise: the hold row was replaced by the invite's own row").not.toBe("needs_organiser");

    const read1 = await deskOf(r.owner, r.competitionId);
    const read2 = await deskOf(r.owner, r.competitionId);
    expect(heldOf(attentionsOf(read1, r.divisionId)), "cleared").toEqual([]);
    expect(rowsOf(read1, r).map((i) => i.kind)).not.toContain("board_held");
    expect(attentionsOf(read2, r.divisionId), "a second poll of the cleared state is the same").toEqual(attentionsOf(read1, r.divisionId));
    expect(fine.fixtureId, "premise: the other board was never held").not.toBe(unlinked.fixtureId);
  });

  it("lichess_reconnect (a grant short of a play scope) is a link hold too: the same ROUND action", async () => {
    const r = await round(2);
    const [b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await hold(r, b, "lichess_reconnect");

    const desk = await deskOf(r.owner, r.competitionId);

    expect(heldOf(attentionsOf(desk, r.divisionId))[0]).toMatchObject({ reason: "lichess_reconnect", reopen: true });
    expect(rowsOf(desk, r).find((i) => i.kind === "board_held")!.action.href).toBe(`/o/acme/c/spring/match-day?round=${encodeURIComponent(`${r.stageId}:1`)}`);
  });

  it("EVERY other reason keeps the generic 'Review board N' -> the board panel (the vocabulary swept; the link reasons are the two the table names)", async () => {
    const reasons = NEEDS_REASONS.filter((x) => !isLinkHold(x));
    expect(reasons.length, "premise: the vocabulary has non-link reasons").toBeGreaterThanOrEqual(14);
    expect(NEEDS_REASONS.filter(isLinkHold), "premise: exactly the two link reasons").toEqual(["lichess_unlinked", "lichess_reconnect"]);
    let checked = 0;
    for (const reason of reasons) {
      const r = await round(1);
      await hold(r, r.boards[0]!, reason);
      const desk = await deskOf(r.owner, r.competitionId);
      expect(heldOf(attentionsOf(desk, r.divisionId)), reason).toEqual([expect.objectContaining({ reason, reopen: false })]);
      const item = rowsOf(desk, r).find((i) => i.kind === "board_held")!;
      expect(item.action, reason).toEqual({ label: "Review board 1", href: `/o/acme/c/spring/match-day?board=${encodeURIComponent(r.boards[0]!.fixtureId)}` });
      expect(item.round_key, reason).toBeUndefined();
      checked++;
    }
    expect(checked, "reasons checked").toBe(reasons.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("MD-R2 / MD-R13: what a link hold opens and what a reason says depend on WHO reads (the desk is served to viewers and keys too)", () => {
  async function linkHeld(): Promise<SeedOnlineChessRoundResult> {
    const r = await round(2);
    await hold(r, r.boards[0]!, "lichess_unlinked");
    return r;
  }
  const boardHref = (r: SeedOnlineChessRoundResult): string => `/o/acme/c/spring/match-day?board=${encodeURIComponent(r.boards[0]!.fixtureId)}`;

  it("positive pair: an editor of a club offered online chess, the competition not frozen, is routed to the round", async () => {
    const r = await linkHeld();
    expect(heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId))[0]).toMatchObject({ reopen: true, reason: "lichess_unlinked" });
  });

  it("a viewer (not an editor) sees the board's row but no reason, and is routed to the board, not the round's Open round", async () => {
    const r = await linkHeld();
    const viewer: AuthCtx = { ...r.owner, role: "viewer" };

    const desk = await deskOf(viewer, r.competitionId);

    expect(heldOf(attentionsOf(desk, r.divisionId)), "the row is there; what it says is an editor's").toEqual([
      expect.objectContaining({ fixtureId: r.boards[0]!.fixtureId, reason: null, reopen: false }),
    ]);
    const item = rowsOf(desk, r).find((i) => i.kind === "board_held")!;
    expect(item.action.href).toBe(boardHref(r));
    expect(item.round_key).toBeUndefined();
    expect(item.sub, "the generic sentence, never a reason's").toBe(en["desk.needsYou.board_held.sub" as keyof typeof en]);
  });

  it("an API key (no role) is no editor either: no reason, the board route", async () => {
    const r = await linkHeld();
    const key: AuthCtx = { ...r.owner, via: "api_key", userId: null, role: null, keyId: randomUUID(), keyScopes: ["read", "write"] };

    const held = heldOf(attentionsOf(await deskOf(key, r.competitionId), r.divisionId));

    expect(held).toEqual([expect.objectContaining({ fixtureId: r.boards[0]!.fixtureId, reason: null, reopen: false })]);
  });

  it("MD-R13: an accusation (fair_play) is the editor's to read: a viewer's and a key's rows carry no reason at all, whatever the reason is", async () => {
    const r = await round(2);
    await hold(r, r.boards[0]!, "fair_play");
    const editor = heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId));
    const viewer = heldOf(attentionsOf(await deskOf({ ...r.owner, role: "viewer" }, r.competitionId), r.divisionId));
    const key = heldOf(attentionsOf(await deskOf({ ...r.owner, via: "api_key", userId: null, role: null, keyId: randomUUID() }, r.competitionId), r.divisionId));

    expect(editor[0]!.reason, "positive pair").toBe("fair_play");
    expect(viewer[0]!.reason).toBeNull();
    expect(key[0]!.reason).toBeNull();
    // Nothing else of the row names why: the whole serialised attention carries no reason word for the non-editors.
    expect(JSON.stringify(viewer)).not.toContain("fair_play");
    expect(JSON.stringify(key)).not.toContain("fair_play");
  });

  it("the club not offered online chess: the editor is routed to the board (the round's press is not on offer), the reason still shown", async () => {
    const r = await linkHeld();
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    flag.isServerFeatureEnabled.mockReset().mockResolvedValue(false);

    const held = heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId));

    expect(flag.isServerFeatureEnabled, "premise: the club's answer was asked").toHaveBeenCalled();
    expect(held).toEqual([expect.objectContaining({ reopen: false, reason: "lichess_unlinked" })]);
    // The same read with the club offered it: the round again (so the answer above is the flag's, not the seed's).
    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    expect(heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId))[0]!.reopen).toBe(true);
  });

  it("a billing-FROZEN competition (the real downgrade) routes the editor to the board: the freeze guards every START press, and the board's own decisions finish play", async () => {
    const r = await linkHeld();
    expect(heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId))[0]!.reopen, "premise: before the downgrade").toBe(true);
    // Over quota = a DOWNGRADE, so raw SQL fillers (createCompetition enforces the quota itself); nothing has scored, so the OLDEST freezes.
    await setOrgPlan(r.orgId, "community");
    await invalidateOrgEntitlements(r.orgId);
    const limit = await getLimit(r.orgId, "competitions.max_active");
    expect(limit, "premise: the community plan has a competitions ceiling").not.toBeNull();
    for (let i = 0; i < (limit as number); i++) {
      const suffix = randomUUID().slice(0, 8);
      await sql`insert into competitions (org_id, name, slug, status) values (${r.orgId}, ${"Filler " + suffix}, ${"filler-" + suffix}, 'draft')`;
    }
    expect([...(await frozenCompetitionIds(r.orgId))], "premise: exactly this competition is frozen").toEqual([r.competitionId]);

    const desk = await deskOf(r.owner, r.competitionId);

    expect(heldOf(attentionsOf(desk, r.divisionId))).toEqual([expect.objectContaining({ reopen: false, reason: "lichess_unlinked" })]);
    expect(rowsOf(desk, r).find((i) => i.kind === "board_held")!.action.href).toBe(boardHref(r));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("the chess read is ISOLATED from the desk (the rule MD-R9 gave Match Day's own online read)", () => {
  it("a held lister that throws: no board rows for that division, logged at error, and the rest of the desk is exactly the desk without any hold", async () => {
    const r = await round(2);
    const baseline = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);
    await hold(r, r.boards[0]!);
    expect(heldOf(attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId)), "premise: the hold is raised when the lister answers").toHaveLength(1);
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      vi.mocked(listNeedsOrganiserExternalPlay).mockClear();
      vi.mocked(listNeedsOrganiserExternalPlay).mockRejectedValueOnce(new Error("boom: the queue is down"));

      const desk = await deskOf(r.owner, r.competitionId);

      expect(vi.mocked(listNeedsOrganiserExternalPlay), "premise: the forced throw was reached").toHaveBeenCalledTimes(1);
      expect(attentionsOf(desk, r.divisionId), "the desk answers without the boards, the rest whole").toEqual(baseline);
      const events = logged.mock.calls.map((c) => (c[0] as { event?: string }).event);
      expect(events).toEqual(["competition_desk_boards_failed"]);
      expect((logged.mock.calls[0]![0] as { competitionId: string; divisionId: string }).divisionId).toBe(r.divisionId);
    } finally {
      logged.mockRestore();
    }
  });

  it("a flagged lister that throws takes the division's held rows with it (one read per division), never the competition", async () => {
    const r = await round(2);
    const baseline = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);
    await hold(r, r.boards[0]!);
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      vi.mocked(listFlaggedExternalPlay).mockRejectedValueOnce(new Error("boom: the flags are down"));

      const desk = await deskOf(r.owner, r.competitionId);

      expect(attentionsOf(desk, r.divisionId)).toEqual(baseline);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("a division whose board cannot be NAMED (a lister row without its board number) is logged and left out; another division of the competition keeps its rows", async () => {
    const r = await round(2);
    const other = await createDivisionWithHold(r);
    await hold(r, r.boards[0]!);
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const real = await listNeedsOrganiserExternalPlay(r.owner, r.divisionId);
      expect(real, "premise: one held board").toHaveLength(1);
      // The first division read gets a row with no board number (V214: `seq_in_round` is NOT NULL, so only a drifted lister can say so).
      vi.mocked(listNeedsOrganiserExternalPlay).mockImplementationOnce(async () => real.map((x) => ({ ...x, boardNo: null })));

      const desk = await deskOf(r.owner, r.competitionId);

      const events = logged.mock.calls.map((c) => (c[0] as { event?: string }).event);
      expect(events, "the guard was reached and said so").toEqual(["competition_desk_boards_failed"]);
      const failed = [r.divisionId, other.divisionId].filter((id) => heldOf(attentionsOf(desk, id)).length === 0);
      const kept = [r.divisionId, other.divisionId].filter((id) => heldOf(attentionsOf(desk, id)).length === 1);
      expect(failed.length, "exactly one division lost its rows").toBe(1);
      expect(kept.length, "and the other kept its own").toBe(1);
    } finally {
      logged.mockRestore();
    }
  });
});

/** A second online chess division in the competition of `r`, with one held board of its own. */
async function createDivisionWithHold(r: SeedOnlineChessRoundResult): Promise<{ divisionId: string }> {
  const division = await createDivision(r.owner, r.competitionId, {
    name: "Second",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
  });
  const [stage] = await createStages(r.owner, division.id, { seq: 1, kind: "league", name: "RR2", config: {} });
  const [fx] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${stage!.id}, ${division.id}, ${r.orgId}, 1, 1, ${`t4-${randomUUID().slice(0, 8)}`}, 'scheduled')
    returning id`;
  await bridgeRow(fx!.id, r.orgId, { status: "needs_organiser", reason: "no_show_black" });
  return { divisionId: division.id };
}

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("who gets board rows: online divisions only (ruling MD-R11 pinned, and every other sport of the registry)", () => {
  it("MD-R11 pinned: a chess division with online play OFF keeps its old held boards on the division page alone - the desk raises none for it", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, scheduledAt: null, onlinePlay: "off" });
    await hold(r, r.boards[0]!);
    // The gap is real (the division page's lister still lists the board), so "none on the desk" is not an empty premise.
    expect((await listNeedsOrganiserExternalPlay(r.owner, r.divisionId)).map((x) => x.fixtureId), "premise: the division page lists it").toEqual([r.boards[0]!.fixtureId]);

    const list = attentionsOf(await deskOf(r.owner, r.competitionId), r.divisionId);

    expect(heldOf(list)).toEqual([]);
    expect(flaggedOf(list)).toEqual([]);
  });

  it("every other sport of the registry, even with online play stored as lichess and a held board on file: no board rows; the chess division's own is the one row (sports swept reported)", async () => {
    const r = await round(2);
    await hold(r, r.boards[0]!);
    const keys = builtinModules.map((m) => m.key);
    expect(keys, "the registry names boardgame (the one online sport) and others").toContain("boardgame");
    const others: string[] = [];
    for (const key of keys.filter((k) => k !== "boardgame")) {
      const [variant] = await sql<{ key: string }[]>`select key from sport_variants where sport_key = ${key} order by is_system desc, key limit 1`;
      expect(variant, `a system variant of ${key}`).toBeDefined();
      const division = await createDivision(r.owner, r.competitionId, { name: `Other ${key}`, sport_key: key, variant_key: variant!.key, config: {} });
      // A stored `lichess` on a sport that cannot play online is possible only below the doors; the producer must still refuse it.
      await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${division.id}`;
      const [stage] = await createStages(r.owner, division.id, { seq: 1, kind: "league", name: `S ${key}`, config: {} });
      const [fx] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
        values (${stage!.id}, ${division.id}, ${r.orgId}, 1, 1, ${`t4-${randomUUID().slice(0, 8)}`}, 'scheduled') returning id`;
      await bridgeRow(fx!.id, r.orgId, { status: "needs_organiser", reason: "no_show_white" });
      await openFlag(r.orgId, fx!.id);
      others.push(division.id);
    }
    expect(others.length, "sports swept (the registry minus boardgame)").toBe(keys.length - 1);
    expect(others.length, "anti-vacuity: at least one other sport").toBeGreaterThan(0);

    const desk = await deskOf(r.owner, r.competitionId);

    for (const id of others) {
      expect(kindsOf(attentionsOf(desk, id)).filter((k) => k === "board_held" || k === "board_flagged"), id).toEqual([]);
    }
    expect(heldIds(attentionsOf(desk, r.divisionId)), "the chess division's own board").toEqual([r.boards[0]!.fixtureId]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The wire: Match Day carries the desk's Needs-you rows, and its zod schema is the consumer the poll body must pass. A plain z.object strips an
// undeclared key on parse, so `fixture_id` and `round_key` - what the shell needs to open a board or a round in place - survive only if declared.
describe.runIf(HAS_DB)("the wire: the per-board Needs-you rows survive Match Day's schema parse with their fixture id and round key", () => {
  it("a link hold and a flagged board on a match day: both rows, fixture_id on each, round_key only on the round's row, field for field after the parse", async () => {
    // The boards are planned for NOW's day, so the competition is on a match day and Match Day carries the Needs-you list (`needsYouHome`).
    const r = await seedOnlineChessRound({ fixtures: 2, scheduledAt: new Date(NOW.getTime() + 30 * MIN) });
    const [heldBoard, flagged] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await hold(r, heldBoard, "lichess_unlinked");
    await flaggedBoard(r, flagged, 1);

    const view = await getMatchDay(r.owner, r.competitionId, NOW);
    const wire = MatchDayView.parse(JSON.parse(JSON.stringify(view)));

    const rows = wire.needs_you.filter((i) => i.kind === "board_held" || i.kind === "board_flagged");
    expect(rows.map((i) => i.kind).sort(), "both rows reached the wire").toEqual(["board_flagged", "board_held"]);
    expect(view.needs_you.filter((i) => i.kind === "board_held" || i.kind === "board_flagged"), "the schema neither dropped a field nor invented one").toEqual(rows);
    const heldRow = rows.find((i) => i.kind === "board_held")!;
    const flaggedRow = rows.find((i) => i.kind === "board_flagged")!;
    expect(heldRow.fixture_id).toBe(heldBoard.fixtureId);
    expect(heldRow.round_key).toBe(`${r.stageId}:1`);
    expect(flaggedRow.fixture_id).toBe(flagged.fixtureId);
    expect(flaggedRow.round_key, "a flagged board opens its board, never a round").toBeUndefined();
  });
});
