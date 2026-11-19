// T17B fix 2, D3 — an arbiter's re-open killed their own watch (stg Sentry: duplicate key
// fixture_video_participants_fixture_id_participant_id_key). Measured live: RealtimeKit's add-participant is
// IDEMPOTENT on custom_participant_id within a meeting — the same custom id answers the SAME participant id. The
// arbiter minted with `subject: userId`, so a second open got the first open's participant back, the record refused
// it, and the catch deleted that participant at the vendor: every open tab of that organiser lost its watch, and the
// record still said it was live.
//
// The ruling: every open is its own participant (`${userId}:${nonce}`); closing one tab removes only that tab's; the
// catch path's vendor delete also stamps the record. The player path was checked for the same class (below): it
// cannot meet a removed participant, and the schema guard that makes it so is pinned.
//
// Driven through the REAL usecases and the REAL adapter against the e2e RealtimeKit fixture server, which answers
// add-participant idempotently as the vendor does. Single sport, deliberately: online play exists only for boardgame
// (supportsOnlinePlay); the guard refuses every other sport before a meeting is reached.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { sql } from "@/lib/db";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { ensureMeeting, refreshParticipantToken, removeParticipant } from "@/server/external-play/video/realtimekit";
import { joinAsArbiter, leaveAsArbiter } from "../external-play/arbiter";
import { stampFixtureCheckIn } from "../me";
import { seatPlayer } from "../external-play/preflight";
import { putVideoParticipant, seedOnlineChessFixture, seedOnlineChessRound, type SeedOnlineChessRoundResult } from "./_external-play-seed";

const DB = !!process.env.DATABASE_URL;

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (DB) await sql.end();
});
beforeEach(() => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function watchable(): Promise<{ r: SeedOnlineChessRoundResult; fixtureId: string }> {
  const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
  // The open-round usecase's stamp (T19's writer), without its invites.
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
    values (${r.stageId}, ${r.orgId}, ${r.roundNo}, ${new Date(Date.now() - 5 * 60_000)}, ${r.ownerUserId})`;
  const fixtureId = r.boards[0]!.fixtureId;
  // D16: an arbiter joins a player's EXISTING meeting and never makes one; the home player's has been made by their arrival - and a room
  // alone is no arrival (check-in capacity plan 2 Task 10: the pre-mint job makes rooms before anyone comes), so their participant is on file.
  await ensureMeeting(fixtureId, "home");
  await putVideoParticipant({ fixtureId, side: "home", personId: r.boards[0]!.home.personId });
  // ... and a COUNTED check-in (check-in capacity plan 3, flag off): inside the window the round's open (5 minutes ago) made.
  await stampFixtureCheckIn(r.boards[0]!.home.personId, fixtureId, r.orgId, { at: new Date(Date.now() - 4 * 60_000) });
  return { r, fixtureId };
}

async function arbiterRows(fixtureId: string) {
  return sql<{ participant_id: string; removed_at: Date | null }[]>`
    select participant_id, removed_at from fixture_video_participants
     where fixture_id = ${fixtureId} and preset = 'arbiter' order by created_at, participant_id`;
}

describe.skipIf(!DB)("each arbiter OPEN is its own participant (T17B fix 2, D3)", () => {
  it("the organiser opening a board twice holds ONE watch: the second open refreshes its token at the vendor (one call), mints nothing and the participant stays alive", async () => {
    const { r, fixtureId } = await watchable();
    const first = await joinAsArbiter(r.owner, fixtureId, "home");
    const again = await joinAsArbiter(r.owner, fixtureId, "home");
    expect(again.participantId, "the same participant").toBe(first.participantId);
    expect([first.reused, again.reused]).toEqual([false, true]);
    expect(again.authToken, "a fresh token, not the first one").not.toBe(first.authToken);
    const rows = await arbiterRows(fixtureId);
    expect(rows.map((x) => [x.participant_id, x.removed_at]), "one watch on file, live").toEqual([[first.participantId, null]]);
    expect(fx.participant(first.participantId)?.deleted, "alive at the vendor").toBe(false);
  });

  it("an explicit revocation removes the watch at the vendor and on file; the next open makes a NEW participant (the removed one is never refreshed)", async () => {
    const { r, fixtureId } = await watchable();
    const a = await joinAsArbiter(r.owner, fixtureId, "home");
    expect(await leaveAsArbiter(r.owner, fixtureId, a.participantId)).toEqual({ removed: true });
    expect(fx.participant(a.participantId)?.deleted).toBe(true);
    const b = await joinAsArbiter(r.owner, fixtureId, "home");
    expect([b.reused, b.participantId === a.participantId]).toEqual([false, false]);
    const rows = new Map((await arbiterRows(fixtureId)).map((x) => [x.participant_id, x.removed_at]));
    expect(rows.get(a.participantId)).not.toBeNull();
    expect(rows.get(b.participantId)).toBeNull();
    expect(fx.participant(b.participantId)?.deleted).toBe(false);
  });

  it("the custom id is internal ids only — the organiser's user id and a nonce, never an email or a name — and differs per MINT (a removal between)", async () => {
    const { r, fixtureId } = await watchable();
    const a = await joinAsArbiter(r.owner, fixtureId, "home");
    await leaveAsArbiter(r.owner, fixtureId, a.participantId);
    const b = await joinAsArbiter(r.owner, fixtureId, "home");
    const subjects = [fx.participant(a.participantId)!.subject, fx.participant(b.participantId)!.subject];
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    let checked = 0;
    for (const s of subjects) {
      expect(s).toMatch(new RegExp(`^${r.ownerUserId}:${UUID}$`));
      expect(s).not.toMatch(/@/);
      checked++;
    }
    expect(checked).toBe(2);
    expect(subjects[0]).not.toBe(subjects[1]);
  });

  it("a mint the record refuses (the vendor answers an id a REMOVED row holds): the vendor's participant is removed, nothing is refreshed, and no row's removed_at moves", async () => {
    const { r, fixtureId } = await watchable();
    const held = await joinAsArbiter(r.owner, fixtureId, "home");
    // The row is removed (an explicit revocation), so the find misses it; the vendor then answers its id again (its idempotency, or
    // anything else) and V451's (fixture_id, participant_id) key refuses the insert: not a racing tab, so no refresh.
    await leaveAsArbiter(r.owner, fixtureId, held.participantId);
    const [before] = await arbiterRows(fixtureId);
    const refreshed: string[] = [];
    const video = {
      addParticipant: async () => ({ participantId: held.participantId, authToken: "tok-dup" }),
      removeParticipant: (a: { meetingId: string; participantId: string }) => removeParticipant(a),
      refreshParticipantToken: async (a: { meetingId: string; participantId: string }) => {
        refreshed.push(a.participantId);
        return refreshParticipantToken(a);
      },
    };
    await expect(joinAsArbiter(r.owner, fixtureId, "home", { video })).rejects.toMatchObject({ code: "23505" });
    expect(refreshed, "no refresh: it was not a racing tab").toEqual([]);
    expect(fx.participant(held.participantId)?.deleted, "the vendor's participant is gone").toBe(true);
    const rows = await arbiterRows(fixtureId);
    expect(rows.map((x) => x.participant_id)).toEqual([held.participantId]);
    expect(rows[0]!.removed_at, "the stamp is a no-op").toEqual(before!.removed_at);
    expect(await leaveAsArbiter(r.owner, fixtureId, held.participantId)).toEqual({ removed: false });
  });
});

describe.skipIf(!DB)("the player path, the same class (T17B fix 2, D3)", () => {
  // Reasoned, not fixed: the reuse path (storedPlayerParticipant → refreshParticipantToken) cannot meet a removed
  // participant. No writer removes a player's participant (the sweep and leaveAsArbiter remove arbiters only;
  // endMeeting kicks and deactivates, deleting nobody), a retired meeting's rows cascade away with it (R2-2), and
  // V454 refuses a removed player row outright. That refusal is the guard this assumption rests on — pinned here, so a
  // future removal writer for players reds and must revisit the reuse path.
  it("a player participant can never be on file as removed: the CHECK refuses it, by name — and an arbiter's may be (the positive pair)", async () => {
    const opened = new Date(Date.now() - 5 * 60_000);
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date(opened.getTime() + 10 * 60_000),
      linked: true,
      roundOpenedAt: opened,
      cameraPolicy: "required",
    });
    const first = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: new Date() });
    const pid = "participant" in first && first.participant ? first.participant.participantId : null;
    expect(pid, "premise: the claim stored a player participant").not.toBeNull();
    const refused = await sql`update fixture_video_participants set removed_at = now() where participant_id = ${pid}`.then(
      () => null,
      (err: { code?: string; constraint_name?: string }) => ({ code: err.code, constraint: err.constraint_name }),
    );
    expect(refused).toEqual({ code: "23514", constraint: "fixture_video_participants_removed_check" });
    // The positive pair: the same update on an arbiter's row is accepted.
    await sql`insert into fixture_video_participants (fixture_id, side, preset, participant_id, user_id)
              values (${s.fixtureId}, 'home', 'arbiter', ${`arb-${pid}`}, ${s.ownerUserId})`;
    const ok = await sql`update fixture_video_participants set removed_at = now() where participant_id = ${`arb-${pid}`} returning 1`;
    expect(ok.length).toBe(1);
  });
});
