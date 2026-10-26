// Phase 3 wave 1, Task 6 (spec §7): a void cancels the round's queued invites. When the thing a chess invite was about is gone - the
// round unpaired, the board walked over or voided, its fixture deleted - the row the outbox still holds must end, or the worker
// keeps retrying a mail that names a board that no longer exists (or never will be played).
//
// Driven through the product's own producers and consumers (AGENTS.md class 1): `openRound` writes the invites (the transport answers
// 503, so every row stays `queued` and retrying), the REAL `unpairSwissRound`, `withdrawEntrantCascade`, `rebuildStageFixtures`,
// `deleteStage` and `deleteCompetition` are the voids, `runOutboxTick` is the worker, `loadArbiterRound` is the reader a person sees.
// Nothing here calls `cancelQueuedEmails` except the unit case that is about it. Only `transport.deliver` is replaced.
//
// Expected values: the reasons are the spec's words (`round_voided`, `board_settled`) and this task's (`fixture_deleted`), typed
// below; the invite words are `inviteWordOf`'s status map, written out here; which board a player sits on comes from the fixtures'
// own rows, never from the code under test. Single-sport by construction: online play exists only for `boardgame`
// (`supportsOnlinePlay`), and the emails do not vary by sport (spec, test strategy 4).
//
// C6 (pre-flight): the spec's "deleting a seated entrant unseats the round and ends its invites" cannot be reached - `deleteEntrant`
// refuses once the division has started and an open refuses a division that has not. The case below pins that REFUSAL instead.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { randomUUID } from "node:crypto";
import { sql, withTenant, type Tx } from "@/lib/db";
import { log } from "@/server/logger";
import { CANCELLED_REASONS, cancelQueuedEmails } from "@/server/email-outbox/cancel";
import { ENDED_BADLY_STATUSES } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import type { EndedRow } from "@/server/email-outbox/hooks";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type InviteMail } from "../../__tests__/_invite-mail";
import {
  seedOnlineChessRound,
  seedOnlineSwiss,
  seedOwner,
  seedPlayer,
  type SeedOnlineChessRoundResult,
  type SeedOnlineSwissResult,
  type SeedSide,
} from "../../__tests__/_external-play-seed";

const mail = vi.hoisted(() => ({
  sent: [] as unknown[],
  fail: new Set<string>(),
  retry: new Set<string>(),
  rateLimit: new Set<string>(),
}));
const transport = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("../../__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("../../__tests__/_invite-mail");
  return {
    deliver: (msg: DeliverMessage) => {
      transport.calls += 1;
      return h.deliverForTest(mail as unknown as InviteMail, msg);
    },
  };
});
// The scoring write the withdrawal cascade settles a board with, wrapped so one test can make it fail on a chosen board.
const scoring = vi.hoisted(() => ({ failOnFixture: null as string | null }));
vi.mock("../../scoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scoring")>();
  return {
    ...actual,
    scoreEvent: vi.fn((...args: Parameters<typeof actual.scoreEvent>) => {
      if (scoring.failOnFixture !== null && args[1] === scoring.failOnFixture) throw new Error("scoring exploded (test)");
      return actual.scoreEvent(...args);
    }),
  };
});

// The cancel the usecases call, wrapped so one test can make it fail (a withdrawal must survive a cancel that cannot be written).
// `probe`, when set, is asked from INSIDE the cancel's own transaction just before the cancel runs (what the delete has already done).
const cancelling = vi.hoisted(() => ({
  fail: false,
  probe: null as null | ((tx: unknown, fixtureIds: readonly string[], reason: string) => Promise<void>),
}));
vi.mock("../cancel-invites", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cancel-invites")>();
  return {
    ...actual,
    cancelBoardInvites: vi.fn(async (...args: Parameters<typeof actual.cancelBoardInvites>) => {
      if (cancelling.fail) throw new Error("cancel exploded (test)");
      if (cancelling.probe) await cancelling.probe(args[0], args[1], args[2]);
      return actual.cancelBoardInvites(...args);
    }),
  };
});

import { chessInviteEndedBadly, findUnappliedChessEndings } from "../invite-outbox-hook";
import { loadArbiterRound } from "../arbiter";
import { openRound } from "../open-round";
import { CHESS_SEAT_REF_TYPE, chessSeatRef, type Colour } from "../seat-stamp";
import { createCompetition, deleteCompetition } from "../../competitions";
import { archiveDivision, createDivision, deleteDivision } from "../../divisions";
import { createEntrants, deleteEntrant, patchEntrant } from "../../entrants";
import { undoDivision } from "../../history";
import { startDivision } from "../../schedule";
import { scoreEvent } from "../../scoring";
import { createStages, deleteStage, generateStageFixtures, rebuildStageFixtures, replaceStages, unpairSwissRound } from "../../stages";
import { withdrawEntrantCascade } from "../../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  mail.sent.length = 0;
  for (const set of [mail.fail, mail.retry, mail.rateLimit]) set.clear();
  transport.calls = 0;
  scoring.failOnFixture = null;
  cancelling.fail = false;
  cancelling.probe = null;
  stubOutboxEnv();
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The words the spec and this task write, typed here and never read back from the code under test.
const ROUND_VOIDED = "round_voided";
const BOARD_SETTLED = "board_settled";
const FIXTURE_DELETED = "fixture_deleted";

type Row = {
  id: string;
  ref_id: string;
  recipient: string;
  status: string;
  attempts: number;
  last_error: string | null;
  has_body: boolean;
  has_lease: boolean;
};
/** Every chess-invite row of an organisation, oldest first. Each seed owns its organisation, so the org is the scope. */
const rowsOf = (orgId: string) =>
  sql<Row[]>`
    select id, ref_id, recipient, status, attempts, last_error, body_sealed is not null as has_body, lease_until is not null as has_lease
      from email_outbox
     where org_id = ${orgId} and kind = 'chess_invite' and ref_type = ${CHESS_SEAT_REF_TYPE}
     order by created_at, ref_id, id`;
const fixtureOf = (row: Row): string => row.ref_id.split(":")[0]!;

/** An online Swiss round, paired through the real generator and OPENED through the real open; the provider answers 503 for every
 *  player, so each invite is attempted once and stays `queued` for a retry. */
async function openedSwiss(players = 4): Promise<SeedOnlineSwissResult> {
  const s = await seedOnlineSwiss({ players, pairing: "fold" });
  for (const p of s.players) mail.retry.add(p.email);
  const out = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId });
  expect(out, "premise: the real open invited the round").toMatchObject({ opened: true });
  return s;
}
/** An opened league round of raw boards (no Swiss): the shape the stage rebuild, the stage delete and the competition delete meet. */
async function openedLeague(fixtures: number): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures });
  for (const b of r.boards) {
    mail.retry.add(b.home.email);
    mail.retry.add(b.away.email);
  }
  const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
  expect(out, "premise: the real open invited the round").toMatchObject({ opened: true });
  return r;
}
/** The premise every case starts from: the open left `n` rows, every one still queued after a 503, each with its body. */
async function expectQueuedRows(orgId: string, atLeast: number): Promise<Row[]> {
  const rows = await rowsOf(orgId);
  expect(rows.length, "premise: the open wrote the round's invites").toBeGreaterThanOrEqual(atLeast);
  for (const row of rows) {
    expect(row.status, `premise: ${row.ref_id} is queued, retrying after the 503`).toBe("queued");
    expect(row.attempts, `premise: ${row.ref_id} was attempted once`).toBe(1);
    expect(row.has_body, `premise: ${row.ref_id} still holds its body`).toBe(true);
  }
  return rows;
}
/** Every row is ended by the void: `expired`, the reason in `last_error`, no body, no lease. Returns how many it checked. */
function expectVoided(rows: readonly Row[], reason: string): number {
  let checked = 0;
  for (const row of rows) {
    expect(row.status, `${row.ref_id} ends expired`).toBe("expired");
    expect(row.last_error, `${row.ref_id} names why`).toBe(reason);
    expect(row.has_body, `${row.ref_id} holds no body`).toBe(false);
    expect(row.has_lease, `${row.ref_id} holds no lease`).toBe(false);
    checked += 1;
  }
  return checked;
}
/** Make the rows due for the worker: older than the first-attempt window, retry time past. */
async function makeDue(ids: readonly string[]): Promise<void> {
  await sql`
    update email_outbox
       set created_at = created_at - interval '10 minutes', next_attempt_at = now() - interval '1 second'
     where id = any(${ids as string[]}::uuid[]) and status = 'queued'`;
}
const tick = (ids: readonly string[]) => runOutboxTick({ onlyIds: [...ids], sleep: async () => undefined });
const stampsOf = async (fixtureIds: readonly string[]) =>
  sql<{ fixture_id: string; white: Date | null; black: Date | null }[]>`
    select fixture_id, white_emailed_at as white, black_emailed_at as black from fixture_external_play
     where fixture_id = any(${fixtureIds as string[]}::uuid[]) order by fixture_id`;
const bridgeCount = async (fixtureIds: readonly string[]): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_external_play where fixture_id = any(${fixtureIds as string[]}::uuid[])`)[0]!.n;
const fixtureIdsOfStage = async (stageId: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} order by id`).map((r) => r.id);
/** An online SINGLE-ELIMINATION stage of `players` entrants through the public usecases (entrants, the generator, Start), round 1
 *  opened through the real open with the provider answering 503. The shape a bracket's double walkover (`departSeat`) meets. */
async function openedKnockout(players: number): Promise<{ owner: SeedOnlineSwissResult["owner"]; orgId: string; stageId: string; entrants: SeedSide[] }> {
  const owner = await seedOwner();
  const competition = await createCompetition(owner, { name: "T6 KO", visibility: "public", branding: {}, starts_on: "2026-10-01", ends_on: "2026-10-02" });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
  });
  const entrants: SeedSide[] = [];
  for (let i = 0; i < players; i++) {
    const p = await seedPlayer(owner.orgId, `K${i + 1}`, `k-${randomUUID().slice(0, 10)}`, true);
    const [e] = await createEntrants(owner, division.id, [
      { display_name: `K${i + 1}`, kind: "individual", seed: i + 1, members: [{ person_id: p.personId, is_captain: false, roles: [] }] },
    ]);
    const [u] = await sql<{ email: string }[]>`select email from users where id = ${p.userId}`;
    entrants.push({ ...p, entrantId: e!.id, email: u!.email });
    mail.retry.add(u!.email);
  }
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
  await generateStageFixtures(owner, stage!.id);
  await sql`update fixtures set scheduled_at = ${new Date("2026-10-01T12:10:00.000Z")} where stage_id = ${stage!.id}`;
  await startDivision(owner, division.id);
  const out = await openRound({ stageId: stage!.id, roundNo: 1, actorUserId: owner.userId! });
  expect(out, "premise: the real open invited the bracket's first round").toMatchObject({ opened: true });
  return { owner, orgId: owner.orgId, stageId: stage!.id, entrants };
}
const endedRowOf = async (row: Row): Promise<EndedRow> => {
  const [r] = await sql<{ meta: Record<string, string>; ref_type: string }[]>`select meta, ref_type from email_outbox where id = ${row.id}`;
  return { id: row.id, kind: "chess_invite", refType: r!.ref_type, refId: row.ref_id, status: "expired", meta: r!.meta };
};

// ---------------------------------------------------------------------------------------------------------------------------
describe("cancelQueuedEmails: its guards (no database)", () => {
  // The empty case. A stub handle that records every statement: a cancel with nothing to cancel must not touch the database.
  it("with no refs it issues no statement and answers []", async () => {
    const tx = vi.fn(() => Promise.reject(new Error("a statement was issued")));
    const out = await cancelQueuedEmails(tx as unknown as Tx, { kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refIds: [], reason: ROUND_VOIDED });
    expect(out).toEqual([]);
    expect(tx).not.toHaveBeenCalled();
  });

  it("refuses a reason the readers do not know, even with no refs (a typo cannot write a row they would read as a failed send)", async () => {
    const tx = vi.fn(() => Promise.reject(new Error("a statement was issued")));
    for (const reason of ["round_voide", "", "Round_Voided", "expired", "no_api_key"]) {
      await expect(
        cancelQueuedEmails(tx as unknown as Tx, { kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refIds: [], reason }),
        `"${reason}"`,
      ).rejects.toThrow(/not a cancel reason/);
    }
    expect(tx).not.toHaveBeenCalled();
  });

  it("the reasons it knows are the three the spec and this task write, and wave 3's superseded email change", () => {
    // The fourth is not a board's: an email-change request ends the user's older queued confirmation (phase-3 spec §5, wave-3 plan
    // P-W3-4); email-outbox/__tests__/email-change-cancel.test.ts drives it.
    expect([...CANCELLED_REASONS].sort()).toEqual([BOARD_SETTLED, FIXTURE_DELETED, ROUND_VOIDED, "email_change_superseded"].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cancelQueuedEmails against the database (the function's rows, and whose rows it may end)", () => {
  it("answers the rows it ended as ended rows - id, kind, ref and meta from the row, status expired - and a second call answers none", async () => {
    const r = await openedLeague(1);
    const board = r.boards[0]!;
    const rows = await expectQueuedRows(r.orgId, 2);
    const refs = [chessSeatRef(board.fixtureId, "white"), chessSeatRef(board.fixtureId, "black")];
    const metaOf = async (id: string) => (await sql<{ meta: Record<string, string> }[]>`select meta from email_outbox where id = ${id}`)[0]!.meta;

    const ended = await withTenant(r.orgId, (tx) => cancelQueuedEmails(tx, { kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refIds: refs, reason: BOARD_SETTLED }));

    expect(ended.map((e) => e.id).sort(), "exactly the board's two queued rows").toEqual(rows.map((x) => x.id).sort());
    let checked = 0;
    for (const e of ended) {
      expect(e.kind).toBe("chess_invite");
      expect(e.refType).toBe(CHESS_SEAT_REF_TYPE);
      expect(refs).toContain(e.refId);
      expect(e.status, "the status the hook is handed").toBe("expired");
      expect(ENDED_BADLY_STATUSES).toContain(e.status);
      expect(e.meta, "the row's own meta (what the hook reads)").toEqual(await metaOf(e.id));
      expect(e.meta.fixtureId, "and it names the board").toBe(board.fixtureId);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both rows were checked").toBe(2);
    expect(expectVoided(await rowsOf(r.orgId), BOARD_SETTLED)).toBe(2);

    const again = await withTenant(r.orgId, (tx) => cancelQueuedEmails(tx, { kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refIds: refs, reason: BOARD_SETTLED }));
    expect(again, "a second call ends nothing: only queued rows are ended").toEqual([]);
  });

  it("G-7: on the pooled client it matches only rows with no organisation, never an organisation's, and the same call in the tenant does", async () => {
    const r = await openedLeague(1);
    const board = r.boards[0]!;
    await expectQueuedRows(r.orgId, 2);
    const ref = chessSeatRef(board.fixtureId, "white");
    // An org-less row on the very same ref, queued: the only row the pooled call may end.
    const orgLessId = randomUUID();
    await sql`
      insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at)
      values (${orgLessId}, 'chess_invite', ${CHESS_SEAT_REF_TYPE}, ${ref}, null, ${`orgless-${randomUUID().slice(0, 8)}@test.local`}, 'g7', true, 'queued', now() + interval '1 hour')`;
    const ask = { kind: "chess_invite" as const, refType: CHESS_SEAT_REF_TYPE, refIds: [ref], reason: BOARD_SETTLED };

    const pooled = await sql.begin((tx) => cancelQueuedEmails(tx, ask));
    expect(pooled.map((e) => e.id), "the pooled call ended the org-less row and nothing of the organisation's").toEqual([orgLessId]);
    const mine = (await rowsOf(r.orgId)).filter((x) => x.ref_id === ref);
    expect(mine.length, "premise: the organisation has a row on that ref").toBe(1);
    expect(mine[0]!.status, "and it is untouched").toBe("queued");

    const tenant = await withTenant(r.orgId, (tx) => cancelQueuedEmails(tx, ask));
    expect(tenant.map((e) => e.id), "in the tenant the organisation's row ends (the org-less one is not its row, and was ended already)").toEqual([mine[0]!.id]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("an Unpair ends the round's queued invites (spec §7)", () => {
  it("unpair ends every queued invite of the round round_voided, with no body; a worker tick afterwards makes no transport call", async () => {
    const s = await openedSwiss(4);
    const before = await expectQueuedRows(s.orgId, 4);
    // Due for the worker NOW: were they still queued, the tick below would send them (the control is test 5's tick).
    await makeDue(before.map((r) => r.id));

    await unpairSwissRound(s.owner, s.stageId);

    const after = await rowsOf(s.orgId);
    expect(after.map((r) => r.id), "the same rows, none added and none lost").toEqual(before.map((r) => r.id));
    const checked = expectVoided(after, ROUND_VOIDED);
    expect(checked, "anti-vacuity: every row of the round was checked").toBe(before.length);
    expect(checked).toBeGreaterThanOrEqual(4);

    transport.calls = 0;
    const report = await tick(after.map((r) => r.id));
    expect(transport.calls, "a voided invite is never sent").toBe(0);
    expect(report.claimed).toBe(0);
  });

  it("a row already sending is left to finish", async () => {
    const s = await openedSwiss(4);
    const before = await expectQueuedRows(s.orgId, 4);
    const sending = before[0]!;
    await sql`update email_outbox set status = 'sending', lease_until = now() + interval '2 minutes' where id = ${sending.id}`;

    await unpairSwissRound(s.owner, s.stageId);

    const after = await rowsOf(s.orgId);
    const mine = after.find((r) => r.id === sending.id)!;
    expect(mine.status, "the row on the wire is not ended").toBe("sending");
    expect(mine.has_lease && mine.has_body, "and keeps its lease and its body").toBe(true);
    expect(mine.last_error).not.toBe(ROUND_VOIDED);
    const others = after.filter((r) => r.id !== sending.id);
    expect(others.length, "anti-vacuity: the other rows exist").toBe(before.length - 1);
    expect(expectVoided(others, ROUND_VOIDED)).toBe(before.length - 1);
  });

  it("deleting a seated entrant is refused once the division has started, so no entrant is ever deleted under a queued invite (C6)", async () => {
    const s = await openedSwiss(4);
    const before = await expectQueuedRows(s.orgId, 4);
    const victim = s.players[0]!;

    // Unconditional on the claim: it is the refusal the spec's "unseat" premise ran into. `deleteEntrant` guards on
    // `division.status !== 'setup'`, and an open refuses a division in `setup`: the two cannot both hold.
    await expect(deleteEntrant(s.owner, victim.entrantId)).rejects.toMatchObject({ status: 409, code: "ENTRANT_DIVISION_STARTED" });

    const [still] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where id = ${victim.entrantId}`;
    expect(still!.n, "the entrant is still on the roster").toBe(1);
    const after = await rowsOf(s.orgId);
    expect(after.map((r) => `${r.id}:${r.status}`), "nothing was touched: every row is still queued").toEqual(before.map((r) => `${r.id}:queued`));
  });

  it("the chess hook does nothing once the bridge row is gone, and the finder reports none of the voided rows", async () => {
    const s = await openedSwiss(4);
    const before = await expectQueuedRows(s.orgId, 4);
    const fixtures = [...new Set(before.map(fixtureOf))];

    // The bridge rows (and their stamps) are what the hook and the finder judge a seat by.
    expect(await bridgeCount(fixtures), "premise: the open bound every board").toBe(fixtures.length);
    await unpairSwissRound(s.owner, s.stageId);
    expect(await bridgeCount(fixtures), "the unpair deleted the bridge rows").toBe(0);

    const voided = await rowsOf(s.orgId);
    expect(expectVoided(voided, ROUND_VOIDED)).toBe(before.length);
    for (const row of voided) {
      expect(ENDED_BADLY_STATUSES, `premise: ${row.status} is a status the hook acts on`).toContain(row.status);
    }

    // The hook: resolves, writes nothing, logs no error.
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      let checked = 0;
      for (const row of voided) {
        await expect(chessInviteEndedBadly(await endedRowOf(row))).resolves.toBeUndefined();
        checked += 1;
      }
      expect(checked, "anti-vacuity: the hook was driven for every voided row").toBe(before.length);
      expect(error, "and logged no error").not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(await bridgeCount(fixtures), "and wrote no bridge row").toBe(0);
    expect((await rowsOf(s.orgId)).map((r) => `${r.id}:${r.status}:${r.last_error}`), "nor touched an email").toEqual(
      voided.map((r) => `${r.id}:${r.status}:${r.last_error}`),
    );

    // The finder: none of the voided rows (its join to the bridge row finds nothing). `limit` is large so the DB's other rows, which
    // this suite shares with the rest, cannot hide one of ours past the cut.
    const ids = new Set(voided.map((r) => r.id));
    const found = await findUnappliedChessEndings(100_000);
    expect(found.filter((r) => ids.has(r.id)).map((r) => r.id)).toEqual([]);

    // The control: the same rows WOULD be reported, and the hook WOULD release the seat, had a stamped bridge row survived. This is
    // what makes the absence above the bridge row's doing and not a finder that finds nothing. The row is forged and removed.
    const target = voided[0]!;
    const meta = (await endedRowOf(target)).meta;
    const colour = meta.colour as Colour;
    const [open] = await sql<{ id: string }[]>`select id from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
    try {
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, round_open_id, white_emailed_at, black_emailed_at)
        values (${meta.fixtureId!}, ${s.orgId}, now(), ${open!.id},
                ${colour === "white" ? meta.stampedAt! : null}, ${colour === "black" ? meta.stampedAt! : null})`;
      const withBridge = await findUnappliedChessEndings(100_000);
      expect(withBridge.map((r) => r.id), "control: with a stamped bridge row the finder reports the voided row").toContain(target.id);
      await chessInviteEndedBadly(await endedRowOf(target));
      const [stamps] = await stampsOf([meta.fixtureId!]);
      expect(stamps![colour], "control: and the hook releases that seat's stamp").toBeNull();
    } finally {
      await sql`delete from fixture_external_play where fixture_id = ${meta.fixtureId!}`;
    }
  });

  it("re-opening after Unpair and a re-pair queues fresh invites that stay queued, beside the voided rows", async () => {
    const s = await openedSwiss(4);
    const first = await expectQueuedRows(s.orgId, 4);

    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "fold" });
    const second = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId });
    expect(second, "the second call is a real open of the re-paired round").toMatchObject({ opened: true });

    const all = await rowsOf(s.orgId);
    const voidedRows = all.filter((r) => first.some((f) => f.id === r.id));
    const fresh = all.filter((r) => !first.some((f) => f.id === r.id));
    expect(voidedRows.length, "anti-vacuity: the first open's rows are all still there").toBe(first.length);
    expect(expectVoided(voidedRows, ROUND_VOIDED), "and the re-open did not turn a voided row into a replaced one").toBe(first.length);
    expect(fresh.length, "the re-open wrote a fresh invite for every seat").toBe(first.length);
    for (const row of fresh) {
      expect(row.status, `${row.ref_id}: the fresh invite is queued`).toBe("queued");
      expect(row.last_error, "and carries no cancel reason").not.toBe(ROUND_VOIDED);
    }

    // The control that these are live rows the worker would send: once the provider answers, the tick sends the fresh ones and
    // only them.
    mail.retry.clear();
    await makeDue(fresh.map((r) => r.id));
    transport.calls = 0;
    const report = await tick(all.map((r) => r.id));
    expect(transport.calls, "the tick sends the four fresh invites").toBe(fresh.length);
    expect(report.sent).toBe(fresh.length);
    const end = await rowsOf(s.orgId);
    expect(end.filter((r) => fresh.some((f) => f.id === r.id)).every((r) => r.status === "sent")).toBe(true);
    expect(expectVoided(end.filter((r) => first.some((f) => f.id === r.id)), ROUND_VOIDED), "the voided rows are untouched by it").toBe(first.length);
  });

  it("after Unpair and the same re-pair, the arbiter reads the seats as Not invited, where the invites in flight read Delayed (P8)", async () => {
    const s = await openedSwiss(4);
    const first = await expectQueuedRows(s.orgId, 4);
    const fixtures = [...new Set(first.map(fixtureOf))];
    const seatWords = async () => {
      const view = await loadArbiterRound(s.owner, s.divisionId);
      expect(view, "premise: the opened round is in view").not.toBeNull();
      const out = new Map<string, string[]>();
      for (const board of view!.boards) {
        expect(board.seats, `premise: board ${board.fixtureId} is in check-in`).not.toBeNull();
        for (const colour of ["white", "black"] as const) out.set(chessSeatRef(board.fixtureId, colour), board.seats![colour].invites);
      }
      return out;
    };

    // The positive pair: with the invites in flight, every seat reads the word for a queued mail (inviteWordOf: queued -> delayed).
    const flying = await seatWords();
    expect(flying.size, "premise: four seats").toBe(4);
    for (const [ref, words] of flying) expect(words, `${ref} while its invite is retrying`).toEqual(["delayed"]);

    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "fold" });

    // The same pairing, so each seat has its same player back. The voided mail is not a mail the seat has: no row, no stamp.
    const seats = await seatWords();
    expect(seats.size).toBe(4);
    let checked = 0;
    for (const [ref, words] of seats) {
      expect(fixtures, `${ref} is a board of the first pairing`).toContain(ref.split(":")[0]);
      expect(words, `${ref} after the void`).toEqual(["not_invited"]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: all four seats were read").toBe(4);

    // And the raw read the loader stands on agrees (the brief's form of the assertion).
    const { latestEmailStatus } = await import("@/server/email-outbox/status");
    const raw = await latestEmailStatus(s.orgId, CHESS_SEAT_REF_TYPE, [...seats.keys()], "chess_invite");
    expect(raw, "no voided row is a seat's latest status").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("a withdrawal that settles an opened board ends its queued invites (board-level cancel)", () => {
  /** The board an entrant sits on in a one-round Swiss, and the other boards. */
  async function boardsOfSwiss(s: SeedOnlineSwissResult, entrantId: string): Promise<{ mine: string; others: string[] }> {
    const rows = await sql<{ id: string; mine: boolean }[]>`
      select id, (home_entrant_id = ${entrantId} or away_entrant_id = ${entrantId}) as mine
        from fixtures where stage_id = ${s.stageId} and round_no = 1 and home_entrant_id is not null and away_entrant_id is not null
        order by seq_in_round`;
    expect(rows.filter((r) => r.mine), "premise: the entrant sits on exactly one board").toHaveLength(1);
    return { mine: rows.find((r) => r.mine)!.id, others: rows.filter((r) => !r.mine).map((r) => r.id) };
  }
  const rowsOfBoards = (all: readonly Row[], ids: readonly string[]) => all.filter((r) => ids.includes(fixtureOf(r)));

  it("withdrawing a player ends their board's queued invites board_settled and leaves the other boards' queued; one tick then releases the settled board's stamps and no other", async () => {
    const s = await openedSwiss(4);
    const before = await expectQueuedRows(s.orgId, 4);
    const who = s.players[0]!;
    const { mine, others } = await boardsOfSwiss(s, who.entrantId);
    expect(others.length, "premise: another board stands beside it").toBeGreaterThanOrEqual(1);

    const out = await withdrawEntrantCascade(s.owner, who.entrantId);
    expect(out.walkovers, "premise: the cascade walked the board over").toBe(1);

    const after = await rowsOf(s.orgId);
    const settled = rowsOfBoards(after, [mine]);
    const standing = rowsOfBoards(after, others);
    expect(settled.length, "anti-vacuity: both seats of the settled board had an invite").toBe(2);
    expect(standing.length, "and the other boards' too").toBe(before.length - 2);
    expect(expectVoided(settled, BOARD_SETTLED)).toBe(2);
    for (const row of standing) {
      expect(row.status, `${row.ref_id} on another board stays queued`).toBe("queued");
      expect(row.has_body).toBe(true);
    }

    // G-4: the cancel leaves the bridge row stamped; the worker's re-drive (`findUnappliedChessEndings`) releases a stamp whose every
    // email has ended badly. One tick does it for the settled board, and for no other: the others' rows are live and hold their seats.
    const stampsBefore = await stampsOf([mine, ...others]);
    expect(stampsBefore.every((x) => x.white !== null && x.black !== null), "premise: every seat is stamped before the tick").toBe(true);
    await tick(after.map((r) => r.id));
    const stampsAfter = new Map((await stampsOf([mine, ...others])).map((x) => [x.fixture_id, x]));
    expect(stampsAfter.get(mine), "the settled board's bridge row survives (the sweep closes it)").toBeDefined();
    expect(stampsAfter.get(mine)!.white, "its white stamp is released").toBeNull();
    expect(stampsAfter.get(mine)!.black, "its black stamp is released").toBeNull();
    for (const id of others) {
      expect(stampsAfter.get(id)!.white, `${id}: white still held`).not.toBeNull();
      expect(stampsAfter.get(id)!.black, `${id}: black still held`).not.toBeNull();
    }
  });

  it("a double walkover (the opponent had already left) ends the board's invites too", async () => {
    const s = await openedSwiss(4);
    await expectQueuedRows(s.orgId, 4);
    const a = s.players[0]!;
    const { mine, others } = await boardsOfSwiss(s, a.entrantId);
    const [boardRow] = await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${mine}`;
    const opponent = boardRow!.home === a.entrantId ? boardRow!.away : boardRow!.home;

    // The opponent leaves by a bare status write (ruling 111's self-withdrawal: no cascade), then `a` is withdrawn through the cascade.
    await patchEntrant(s.owner, opponent, { status: "withdrawn" });
    const mid = await rowsOf(s.orgId);
    expect(rowsOfBoards(mid, [mine]).every((r) => r.status === "queued"), "premise: the bare status write ended nothing").toBe(true);
    const out = await withdrawEntrantCascade(s.owner, a.entrantId);
    expect(out.walkovers, "premise: the cascade recorded the double walkover").toBe(1);

    const after = await rowsOf(s.orgId);
    expect(expectVoided(rowsOfBoards(after, [mine]), BOARD_SETTLED)).toBe(2);
    expect(rowsOfBoards(after, others).every((r) => r.status === "queued")).toBe(true);
  });

  it("a cascade that fails part-way still ends the invites of the boards it had already settled, and not the board it failed on", async () => {
    // One player on two boards of a league: the cascade settles them one after the other. Board 2's write is made to fail.
    const r = await openedLeague(2);
    const [one, two] = r.boards;
    const shared = one!.home;
    await sql`update fixtures set home_entrant_id = ${shared.entrantId} where id = ${two!.fixtureId}`;
    // The open invited board 2 with its old home; the rewiring changes only who the CASCADE finds on it.
    const before = await expectQueuedRows(r.orgId, 4);
    scoring.failOnFixture = two!.fixtureId;

    await expect(withdrawEntrantCascade(r.owner, shared.entrantId)).rejects.toThrow(/scoring exploded/);

    const after = await rowsOf(r.orgId);
    const first = rowsOfBoards(after, [one!.fixtureId]);
    const failed = rowsOfBoards(after, [two!.fixtureId]);
    expect(first.length + failed.length, "anti-vacuity: every row is accounted for").toBe(before.length);
    expect(first.length, "board 1 had its two invites").toBe(2);
    expect(expectVoided(first, BOARD_SETTLED), "board 1 was settled before the failure, so its invites ended").toBe(2);
    expect(failed.every((x) => x.status === "queued"), "board 2 was not settled, so its invites stand").toBe(true);
  });

  it("a bracket's double walkover (the no-event write) ends the board's invites too", async () => {
    const k = await openedKnockout(4);
    const before = await expectQueuedRows(k.orgId, 4);
    const [semi] = await sql<{ id: string; home: string; away: string }[]>`
      select id, home_entrant_id as home, away_entrant_id as away from fixtures
       where stage_id = ${k.stageId} and round_no = 1 and home_entrant_id is not null and away_entrant_id is not null order by seq_in_round limit 1`;
    const others = before.filter((r) => fixtureOf(r) !== semi!.id);
    expect(others.length, "premise: the other semi-final was invited too").toBe(2);

    // The opponent leaves by a bare status write; withdrawing the other through the cascade is then a bracket double walkover on a
    // line that feeds the final, written as a bye is (`departSeat`), not through the scoring ledger.
    await patchEntrant(k.owner, semi!.away, { status: "withdrawn" });
    const out = await withdrawEntrantCascade(k.owner, semi!.home);
    expect(out.walkovers, "premise: the cascade wrote the double walkover").toBe(1);
    const [events] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${semi!.id}`;
    expect(events!.n, "premise: it went through the no-event write (departSeat), not a scoring event").toBe(0);

    const after = await rowsOf(k.orgId);
    expect(expectVoided(rowsOfBoards(after, [semi!.id]), BOARD_SETTLED)).toBe(2);
    expect(rowsOfBoards(after, others.map(fixtureOf)).every((r) => r.status === "queued")).toBe(true);
  });

  it("a cancel that cannot be written does not fail the withdrawal: the walkover stands, the entrant is withdrawn, the failure is logged", async () => {
    const s = await openedSwiss(4);
    await expectQueuedRows(s.orgId, 4);
    const who = s.players[0]!;
    // The board the withdrawn player sits on, from the fixtures' own rows: what the log must name (T6 review m2).
    const mine = await sql<{ id: string }[]>`
      select id from fixtures
       where stage_id = ${s.stageId} and round_no = 1 and (home_entrant_id = ${who.entrantId} or away_entrant_id = ${who.entrantId})`;
    expect(mine, "premise: the player sits on exactly one board").toHaveLength(1);
    cancelling.fail = true;
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const out = await withdrawEntrantCascade(s.owner, who.entrantId);
      expect(out.walkovers, "the walkover was written").toBe(1);
      const logged = error.mock.calls.filter((c) => /could not be ended/.test(String(c[1])));
      expect(logged, "and the failed cancel was logged, once, at error level").toHaveLength(1);
      expect(logged[0]![0], "naming the board whose invites are left, and how many boards").toMatchObject({ fixtureIds: [mine[0]!.id], boards: 1 });
    } finally {
      error.mockRestore();
    }
    const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${who.entrantId}`;
    expect(e!.status, "the entrant is withdrawn").toBe("withdrawn");
    expect((await rowsOf(s.orgId)).every((r) => r.status === "queued"), "premise: nothing was cancelled").toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("a deleted fixture takes its queued invites with it (G-1)", () => {
  it("the stage rebuild ends the stage's queued invites fixture_deleted, and only that stage's", async () => {
    const r = await openedLeague(2);
    const other = await openedLeague(2); // a different club's opened round: the fence is not this one's
    const before = await expectQueuedRows(r.orgId, 4);
    const otherBefore = await expectQueuedRows(other.orgId, 4);
    const fixtures = await fixtureIdsOfStage(r.stageId);
    expect(await bridgeCount(fixtures), "premise: the open bound the boards").toBeGreaterThan(0);

    await rebuildStageFixtures(r.owner, r.stageId);

    const after = await rowsOf(r.orgId);
    expect(after.map((x) => x.id), "the same rows").toEqual(before.map((x) => x.id));
    expect(expectVoided(after, FIXTURE_DELETED)).toBe(before.length);
    expect(await fixtureIdsOfStage(r.stageId), "premise: the old boards are gone (the rebuild minted new ones)").not.toEqual(expect.arrayContaining(fixtures));
    const otherAfter = await rowsOf(other.orgId);
    expect(otherAfter.map((x) => `${x.id}:${x.status}`), "another club's opened round is untouched").toEqual(otherBefore.map((x) => `${x.id}:queued`));
  });

  it("deleting a stage ends its queued invites fixture_deleted", async () => {
    const r = await openedLeague(2);
    const before = await expectQueuedRows(r.orgId, 4);

    await deleteStage(r.owner, r.stageId);

    const after = await rowsOf(r.orgId);
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(expectVoided(after, FIXTURE_DELETED)).toBe(before.length);
    expect(await fixtureIdsOfStage(r.stageId), "premise: the boards are gone").toEqual([]);
  });

  it("undoing the generation (the history step that deletes the boards) ends the round's queued invites fixture_deleted", async () => {
    const s = await openedSwiss(4);
    const before = await expectQueuedRows(s.orgId, 4);
    const boards = async () => (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${s.stageId}`)[0]!.n;
    const shells = await boards();
    expect(shells, "premise: the round's shells exist").toBeGreaterThan(0);

    // The ledger is: shells minted, the round seated, the schedule published, the division started. Undo walks it back; the step
    // that DELETES the boards is the second generation's (the first one only unseats).
    let steps = 0;
    while ((await boards()) === shells && steps < 5) {
      await undoDivision(s.owner, s.divisionId);
      steps += 1;
      if ((await boards()) === shells) {
        expect((await rowsOf(s.orgId)).every((r) => r.status === "queued"), `step ${steps} deleted no board, so no invite ended`).toBe(true);
      }
    }
    expect(await boards(), "premise: an undo step deleted the boards").toBeLessThan(shells);
    const after = await rowsOf(s.orgId);
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(expectVoided(after, FIXTURE_DELETED)).toBe(before.length);
  });

  it("deleting a competition ends the queued invites of its boards fixture_deleted, after its delete and in the same transaction, naming boards read before it (T6 review m3)", async () => {
    const r = await openedLeague(2);
    const before = await expectQueuedRows(r.orgId, 4);
    const boardIds = r.boards.map((b) => b.fixtureId);

    // Asked from INSIDE the cancel's own handle: the competition (and with it the bridge rows) is already gone THERE, yet the cancel
    // still names every board, so the ids were read before the delete. Outside that transaction the competition is still visible
    // until it commits, which is how the probe knows it is looking through the cancel's handle.
    const seen: { competitionsLeft: number; bridgesLeft: number; named: string[]; reason: string }[] = [];
    cancelling.probe = async (tx, fixtureIds, reason) => {
      const h = tx as Tx;
      const [c] = await h<{ n: number }[]>`select count(*)::int as n from competitions where id = ${r.competitionId}`;
      const [b] = await h<{ n: number }[]>`select count(*)::int as n from fixture_external_play where fixture_id = any(${boardIds}::uuid[])`;
      seen.push({ competitionsLeft: c!.n, bridgesLeft: b!.n, named: [...fixtureIds], reason });
    };

    await deleteCompetition(r.owner, r.competitionId);

    expect(seen, "the cancel ran once").toHaveLength(1);
    expect(seen[0]!.competitionsLeft, "after the delete, in the same transaction").toBe(0);
    expect(seen[0]!.bridgesLeft, "the cascade had already taken the bridge rows").toBe(0);
    expect([...seen[0]!.named].sort(), "and it still named every board").toEqual([...boardIds].sort());
    expect(seen[0]!.reason).toBe(FIXTURE_DELETED);

    const after = await rowsOf(r.orgId);
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(expectVoided(after, FIXTURE_DELETED)).toBe(before.length);
    expect(await bridgeCount(r.boards.map((b) => b.fixtureId)), "premise: the boards are gone").toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// T6 review m1. Three paths that WOULD delete the fixtures of an opened, invited round were found unreachable and are not patched
// (no cancel is wired there). That holds only while each one refuses, so each refusal is pinned here over a round the real open
// invited: the refusal itself, and that nothing it guards moved - the invites, the boards, the bridge rows.
describe.skipIf(!HAS_DB)("the paths that would delete an opened, invited round's boards refuse it, and leave its invites alone (T6 review m1)", () => {
  /** Everything a refused delete must leave as it found it. */
  async function stateOf(s: SeedOnlineSwissResult) {
    const rows = await rowsOf(s.orgId);
    const fixtures = (await sql<{ id: string }[]>`select id from fixtures where division_id = ${s.divisionId} order by id`).map((r) => r.id);
    return {
      invites: rows.map((r) => `${r.id}|${r.status}|${r.attempts}|${r.last_error}|${r.has_body}|${r.has_lease}`),
      fixtures,
      bridges: await bridgeCount(fixtures),
      stages: (await sql<{ id: string }[]>`select id from stages where division_id = ${s.divisionId} order by id`).map((r) => r.id),
    };
  }

  it("replacing the stage graph is refused FORMAT_LOCKED once the round's boards exist", async () => {
    const s = await openedSwiss(4);
    await expectQueuedRows(s.orgId, 4);
    const before = await stateOf(s);
    expect(before.bridges, "premise: the open bound the round's boards").toBeGreaterThan(0);

    await expect(
      replaceStages(s.owner, s.divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null }),
    ).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });

    expect(await stateOf(s), "no invite, board, bridge row or stage moved").toEqual(before);
  });

  it("Pair next while the opened round's boards are undecided is refused STAGE_NOT_READY and moves nothing (the entry refusal, ahead of the shell reconcile)", async () => {
    const s = await openedSwiss(4);
    await expectQueuedRows(s.orgId, 4);
    const before = await stateOf(s);

    let thrown: unknown;
    await generateStageFixtures(s.owner, s.stageId).catch((e: unknown) => (thrown = e));
    expect(EngineError.is(thrown, "STAGE_NOT_READY"), `refused with STAGE_NOT_READY (got ${String(thrown)})`).toBe(true);

    expect(await stateOf(s), "no invite, board, bridge row or stage moved").toEqual(before);
  });

  // The path that RUNS the shell reconcile's delete (`reconcileSwissRoundShells`, the `doomed` shells): the target is the next
  // unseated round (`nextUnseatedSwissRound`), so with round 1 opened, invited and decided it is round 2, and a shrunk field makes
  // round 2's shells too many. Round 1 holds the invites and the bridge rows; the reconcile may remove round 2's shells and nothing of
  // round 1's. What keeps round 1 out of it is the scope (`round_no === target`); the reconcile's own seated, played and evidence
  // guards would each refuse if the scope slipped, and each is dead code for round 2 as long as it holds.
  it("Pair next with round 1 opened, invited and decided and the field shrunk reshapes round 2's unseated shells, and round 1's invites, boards and bridge rows are exactly as found", async () => {
    const s = await openedSwiss(4); // 4 players: 2 boards a round, 3 rounds of shells
    await expectQueuedRows(s.orgId, 4);

    // Decide round 1 through the scorer's quick result (home wins by resignation), the way the swiss chess walkover tests do.
    const boards = await sql<{ id: string; home_entrant_id: string }[]>`
      select id, home_entrant_id from fixtures where stage_id = ${s.stageId} and round_no = 1 and away_entrant_id is not null order by seq_in_round`;
    expect(boards, "premise: round 1 has two seated boards").toHaveLength(2);
    for (const b of boards) {
      await scoreEvent(s.owner, b.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(s.owner, b.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: b.home_entrant_id, method: "resign" } });
    }
    const undecided = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${s.stageId} and round_no = 1 and status not in ('decided', 'finalized')`;
    expect(undecided[0]!.n, "premise: round 1 is decided").toBe(0);

    // Shrink the field: a round-1 player withdraws (the board is decided, so the cascade writes no walkover). 3 active entrants are
    // 1 board and a bye, where round 2's shells were minted for 4 (2 boards): one shell too many.
    await withdrawEntrantCascade(s.owner, s.players[3]!.entrantId);

    const round1 = async () => {
      const f = await sql<{ id: string; status: string; home: string | null; away: string | null; outcome: unknown }[]>`
        select id, status, home_entrant_id as home, away_entrant_id as away, outcome from fixtures where stage_id = ${s.stageId} and round_no = 1 order by id`;
      return { fixtures: f, bridges: await bridgeCount(f.map((x) => x.id)), invites: (await stateOf(s)).invites };
    };
    const round2 = async () =>
      (await sql<{ id: string; home: string | null; away: string | null; ext_key: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away, ext_key from fixtures where stage_id = ${s.stageId} and round_no = 2 order by seq_in_round`);
    const r1Before = await round1();
    const r2Before = await round2();
    expect(r1Before.bridges, "premise: round 1's boards are bridged").toBe(2);
    expect(r2Before, "premise: round 2 holds 2 unseated board shells").toHaveLength(2);
    expect(r2Before.every((f) => f.home === null && f.away === null), "premise: unseated").toBe(true);

    await generateStageFixtures(s.owner, s.stageId); // Pair next: target round 2

    const r2After = await round2();
    const gone = r2Before.filter((f) => !r2After.some((g) => g.id === f.id));
    expect(gone, "the delete ran: round 2 lost exactly the one shell the shrunk field no longer needs (2 boards -> 1 board and a bye)").toHaveLength(1);
    expect(r2After.some((f) => f.ext_key?.endsWith("-bye")), "and the reconcile minted the bye").toBe(true);
    expect(await round1(), "round 1's boards, bridge rows and invites are exactly as found").toEqual(r1Before);
  });

  it("deleting the division is refused while it is started and for 30 days after it is archived; the 30th day is the only way through", async () => {
    const s = await openedSwiss(4);
    await expectQueuedRows(s.orgId, 4);
    const before = await stateOf(s);

    await expect(deleteDivision(s.owner, s.divisionId)).rejects.toMatchObject({ status: 409, code: "DIVISION_HAS_RESULTS" });
    expect(await stateOf(s), "started: nothing moved").toEqual(before);

    await archiveDivision(s.owner, s.divisionId);
    await expect(deleteDivision(s.owner, s.divisionId)).rejects.toMatchObject({ status: 409, code: "ARCHIVE_COOL_OFF" });
    expect(await stateOf(s), "archived today: nothing moved").toEqual(before);

    // The control: the refusals above are the guard, not a broken fixture. Thirty-one days on, the same call goes through (an invite
    // that old is long past its own expiry, under a day, so no cancel is owed there).
    await sql`update divisions set archived_at = now() - interval '31 days' where id = ${s.divisionId}`;
    await deleteDivision(s.owner, s.divisionId);
    const [gone] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where id = ${s.divisionId}`;
    expect(gone!.n, "archived 31 days: the division is purged").toBe(0);
  });
});
