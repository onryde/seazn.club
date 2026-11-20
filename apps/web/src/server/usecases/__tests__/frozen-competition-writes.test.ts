// Match Day PB2 (owner 2026-11-02, "apply rec", option A): a billing-frozen competition still SCORES, and NOTHING ELSE the freeze
// guards moves with it. This is the behavioural witness for the guard sites that had none of their own — the schedule's writes
// (a move, its settings, an apply, publish, Start), entrants, a new stage, deleting a stage, the competition-wide apply, the
// competition AI preview — and for a few that had one elsewhere and cost nothing to sweep here too (a new division, a rename, a
// match's own format). The ledger of every site and its witness is freeze-guard-sites.test.ts.
//
// Each write is asked twice, through its REAL usecase against real Postgres:
//   - on a competition that is NOT frozen (its own seed): whatever it answers, it is never the freeze's 402 — so the refusal
//     below is the freeze, not the write;
//   - on a frozen one: the guard's own 402 (`competitions.max_active`), and nothing is written.
// Then the frozen competition's match scores (PB2's ruling, scoring-frozen-competition.test.ts proves the door itself).
//
// The freeze is the override pin (pool-nesting-tripwire.test.ts, registration-approval.test.ts): the org keeps Pro, so a write
// that also asks a Pro capability (the AI preview's `scheduling.ai`, the competition apply's `scheduling.multi_division`) reaches
// the freeze rather than a plan gate.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): no guard here reads the sport — each reads the competition's id.
//
// Match Day O4 (owner 2026-11-17): the START writes of an online chess round — open a round, resend an invite, +5 on a board, +5 to
// the round — obey the same freeze, so the second half of this file drives those four sites through their real usecases, each as
// unfrozen -> frozen -> unfrozen -> frozen on ONE competition, and the FINISH decisions (resync, let the game go on, settle, let play
// without video) on a frozen competition: they write or unblock a RESULT, which is scoring, and stay accepted. That half is
// boardgame-only for the one reason online play exists for no other sport (`supportsOnlinePlay`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv } from "./_invite-mail";

// The AI preview's own doors before the freeze: its PostHog flag (fail-open, but never a live call from a test) — and the model,
// present only to prove it is never reached (a preview that got past the freeze would spend a credit).
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled: async () => true, captureServer: () => {} }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = {
      parse: () => {
        throw new Error("the model was reached");
      },
    };
  },
}));

// The invite is rendered, queued on the email outbox in the open's transaction and sent after commit through the outbox's one network
// seam, which is replaced here (as open-round.test.ts does): `mail.sent` holds the addresses the "provider" accepted.
const mail = vi.hoisted(() => ({ sent: [] as string[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("./_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("./_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverToAddresses(mail, msg) };
});
beforeEach(() => {
  stubOutboxEnv();
  mail.sent.length = 0;
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import { CreateStage } from "@/server/api-v1/schemas";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { applyCompetitionSchedule } from "../competition-schedule-apply";
import { createCompetition, patchCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { previewScheduleAi } from "../schedule-ai-preview";
import { applySchedule, getScheduleSettings, moveFixture, publishSchedule, putScheduleSettings, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, deleteStage } from "../stages";
import { CHECKIN_EXTEND_STEP_MS } from "@/server/external-play/window";
import { overrideVideoAsOrganiser, resyncExternalPlay } from "../external-play/arbiter";
import { extendCheckin, extendRoundCheckin } from "../external-play/checkin-extend";
import { closeExternalPlayFlags } from "../external-play/flags";
import { resendExternalPlayNotice } from "../external-play/invite";
import { openRound } from "../external-play/open-round";
import { resolveExternalPlay } from "../external-play/resolve";
import { holdForOrganiser } from "../external-play/result";
import { chessSeatRef } from "../external-play/seat-stamp";
import { seedLinkedPair, seedOnlineChessRound, type SeedOnlineChessRoundResult } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const seed = () => seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });

/** Every guarded write, as the site it reaches (`file#function`, the ledger's key) and a call against `s`'s own ids. Deleting the
 *  stage is LAST: on the unfrozen seed it really deletes, and the writes before it need the stage. */
function writes(s: SeededBracket): Array<[site: string, attempt: () => Promise<unknown>]> {
  const fixtureId = s.fixtureIds[0]!;
  return [
    ["schedule/move.ts#moveFixture", () => moveFixture(s.auth, fixtureId, { scheduled_at: "2030-06-01T10:00:00.000Z" })],
    [
      "schedule/settings.ts#putScheduleSettings",
      async () => putScheduleSettings(s.auth, s.divisionId, { config: (await getScheduleSettings(s.auth, s.divisionId)).config }),
    ],
    [
      "schedule/apply.ts#applySchedule",
      () =>
        applySchedule(s.auth, s.stageId, {
          source: "auto",
          assignments: [{ fixture_id: fixtureId, scheduled_at: "2030-06-01T10:00:00.000Z", court_id: randomUUID() }],
        }),
    ],
    ["schedule/publish.ts#publishSchedule", () => publishSchedule(s.auth, s.divisionId)],
    ["schedule/publish.ts#startDivision", () => startDivision(s.auth, s.divisionId)],
    ["entrants.ts#createEntrants", () => createEntrants(s.auth, s.divisionId, [{ kind: "individual", display_name: "Late Entry", members: [] }])],
    [
      "stages/stage-graph.ts#insertStageBatch",
      () => createStages(s.auth, s.divisionId, CreateStage.parse({ seq: 2, kind: "knockout", name: "Plate", config: {} })),
    ],
    [
      "competition-schedule-apply.ts#applyCompetitionSchedule",
      () => applyCompetitionSchedule(s.auth, s.competitionId, { source: "ai", divisions: [{ division_id: s.divisionId, expected_seq: 0, assignments: [] }] }),
    ],
    [
      "schedule-ai-preview.ts#resolveCompetitionScope",
      () =>
        previewScheduleAi(s.auth, { kind: "competition", id: s.competitionId }, {
          instruction: "Finish by six",
          division_ids: [s.divisionId, randomUUID()],
        }),
    ],
    [
      "divisions.ts#createDivision",
      () =>
        createDivision(s.auth, s.competitionId, {
          name: "Plate",
          slug: "plate-" + randomUUID().slice(0, 8),
          sport_key: "badminton",
          variant_key: "bwf",
          config: {},
        }),
    ],
    ["competitions.ts#patchCompetition", () => patchCompetition(s.auth, s.competitionId, { name: "Renamed Cup" })],
    ["fixture-rules.ts#writeFixtureRulesOverride", () => writeFixtureRulesOverride(s.auth, [fixtureId], { bestOf: 5 })],
    ["stages/stage-graph.ts#deleteStage", () => deleteStage(s.auth, s.stageId)],
  ];
}

/** The freeze's own refusal: a PaymentRequiredError naming the active-competition ceiling — never a plan gate that shares 402. */
const isFreeze = (e: unknown): boolean => e instanceof PaymentRequiredError && e.featureKey === "competitions.max_active";

/** What the writes above would change, read straight off the rows. */
async function snapshot(s: SeededBracket) {
  const [row] = await sql<
    { name: string; divisions: number; stages: number; entrants: number; scheduled: string | null; division_status: string; overrides: number }[]
  >`
    select c.name,
           (select count(*)::int from divisions d where d.competition_id = c.id) as divisions,
           (select count(*)::int from stages s where s.division_id = ${s.divisionId}) as stages,
           (select count(*)::int from entrants e where e.division_id = ${s.divisionId}) as entrants,
           (select f.scheduled_at::text from fixtures f where f.id = ${s.fixtureIds[0]!}) as scheduled,
           (select d.status from divisions d where d.id = ${s.divisionId}) as division_status,
           (select count(*)::int from fixtures f where f.division_id = ${s.divisionId} and f.rules_override is not null) as overrides
      from competitions c where c.id = ${s.competitionId}`;
  return row!;
}

describe.skipIf(!HAS_DB)("PB2 — every write the billing freeze guards still answers its 402, while the same competition scores", () => {
  it("EMPTY CASE FIRST: on a competition that is NOT frozen, no guarded write answers the freeze's 402", async () => {
    const u = await seed();
    expect([...(await frozenCompetitionIds(u.auth.orgId))], "premise: nothing frozen").toEqual([]);
    let checked = 0;
    for (const [site, attempt] of writes(u)) {
      const outcome = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(isFreeze(outcome), `${site}: ${String(outcome)}`).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: writes checked").toBe(writes(u).length);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it("frozen: each write is refused with the freeze's own 402 and writes nothing; the competition's match still scores", async () => {
    const s = await seed();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${s.auth.orgId}, 'competitions.max_active', 0)
      on conflict (org_id, feature_key) do update set int_value = 0, bool_value = null`;
    await invalidateOrgEntitlements(s.auth.orgId);
    expect([...(await frozenCompetitionIds(s.auth.orgId))], "premise: exactly this competition is frozen").toEqual([s.competitionId]);

    const before = await snapshot(s);
    let refused = 0;
    for (const [site, attempt] of writes(s)) {
      const err = await attempt().then(
        () => new Error(`${site}: accepted on a frozen competition`),
        (e: unknown) => e,
      );
      expect(isFreeze(err), `${site}: ${String(err)}`).toBe(true);
      expect((err as PaymentRequiredError).status, site).toBe(402);
      refused++;
    }
    expect(refused, "anti-vacuity: refusals checked").toBe(writes(s).length);
    expect(await snapshot(s), "a refused write wrote nothing").toEqual(before);

    // PB2: the one write a frozen competition keeps.
    const started = await scoreEvent(s.auth, s.fixtureIds[0]!, { expected_seq: 0, type: "core.start", payload: {} });
    expect(started.seq).toBe(1);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Match Day O4 (owner 2026-11-17) — the online round's START writes obey the billing freeze; its FINISH decisions do not.
//
// Match Day's rule (PB2): a frozen competition keeps every write the freeze guards EXCEPT scoring. Online play is the same rule in the
// same place: what STARTS play (open a round, resend an invite, +5 on a board, +5 to the round) is refused 402, and what FINISHES it
// (a resync, a flag closed so the game goes on, a settle, a board let play without video) writes or unblocks a RESULT and stays.
// The expected answers below are the owner's ruling and the seeds' own players and boards, never read off the usecases.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
type Rig = SeedOnlineChessRoundResult;

/** The round's open: batch 0 starts here, so a press one minute later is inside the check-in window. */
const OPEN_AT = new Date("2026-10-01T12:00:00.000Z");
const PRESS_AT = new Date(OPEN_AT.getTime() + 60_000);
const ORIGIN = "https://seazn.test";

/** Pin the org's `competitions.max_active` to `limit` (the override the PB2 sweep above uses): 0 puts every active competition over it. */
async function setLimit(orgId: string, limit: number): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value)
    values (${orgId}, 'competitions.max_active', ${limit})
    on conflict (org_id, feature_key) do update set int_value = ${limit}, bool_value = null`;
  await invalidateOrgEntitlements(orgId);
}
async function freeze(r: Pick<Rig, "orgId" | "competitionId">): Promise<void> {
  await setLimit(r.orgId, 0);
  expect([...(await frozenCompetitionIds(r.orgId))], "premise: exactly this competition is frozen").toEqual([r.competitionId]);
}
/** Room appears (a bigger limit): the stored mark is let go on the next read (`reconcileFrozen`), and the same competition writes again. */
async function thaw(r: Pick<Rig, "orgId">): Promise<void> {
  await setLimit(r.orgId, 50);
  expect([...(await frozenCompetitionIds(r.orgId))], "premise: nothing is frozen any more").toEqual([]);
}

/** Everything a START write could change, read straight off the rows (and the mail the provider accepted). */
type Snapshot = {
  opens: number;
  bridges: number;
  holds: number;
  stamps: number;
  /** Bridge rows whose basis is an OLDER start time than their fixture's: what `resetStaleBridge` (a write) starts over. */
  stale: number;
  extensions: number;
  extraMs: number;
  outbox: number;
  audits: number;
  events: number;
  mailed: number;
};
const ZERO: Snapshot = { opens: 0, bridges: 0, holds: 0, stamps: 0, stale: 0, extensions: 0, extraMs: 0, outbox: 0, audits: 0, events: 0, mailed: 0 };

async function startRows(r: Rig): Promise<Snapshot> {
  const ids = r.boards.map((b) => b.fixtureId);
  const refs = ids.flatMap((id) => [chessSeatRef(id, "white"), chessSeatRef(id, "black")]);
  const [row] = await sql<Omit<Snapshot, "mailed">[]>`
    select (select count(*)::int from stage_round_opens where stage_id = ${r.stageId}) as opens,
           (select count(*)::int from fixture_external_play where fixture_id = any(${ids}::uuid[])) as bridges,
           (select count(*)::int from fixture_external_play where fixture_id = any(${ids}::uuid[]) and status = 'needs_organiser') as holds,
           (select count(*)::int from fixture_external_play where fixture_id = any(${ids}::uuid[]) and white_emailed_at is not null)
             + (select count(*)::int from fixture_external_play where fixture_id = any(${ids}::uuid[]) and black_emailed_at is not null) as stamps,
           (select count(*)::int from fixture_external_play ep join fixtures f on f.id = ep.fixture_id
             where ep.fixture_id = any(${ids}::uuid[]) and ep.scheduled_at_basis <> f.scheduled_at) as stale,
           (select coalesce(sum(checkin_extensions), 0)::int from fixture_external_play where fixture_id = any(${ids}::uuid[])) as extensions,
           (select coalesce(sum(checkin_extra_ms), 0)::int from fixture_external_play where fixture_id = any(${ids}::uuid[])) as "extraMs",
           (select count(*)::int from email_outbox where ref_type = 'fixture_seat' and ref_id = any(${refs}::text[])) as outbox,
           (select count(*)::int from online_chess_audit where fixture_id = any(${ids}::uuid[])) as audits,
           (select count(*)::int from competition_events where competition_id = ${r.competitionId}) as events`;
  return { ...row!, mailed: mail.sent.length };
}
const change = (before: Snapshot, after: Snapshot): Snapshot =>
  Object.fromEntries((Object.keys(ZERO) as (keyof Snapshot)[]).map((k) => [k, after[k] - before[k]])) as Snapshot;

type StartSite = {
  /** The ledger's key (freeze-guard-sites.test.ts): `file#function`, the function the guard sits in. */
  site: string;
  /** A fresh round, with whatever the write needs before it (an opened round for a resend and a +5). Built UNFROZEN. */
  arrange: () => Promise<Rig>;
  attempt: (r: Rig) => Promise<unknown>;
  /** What the write answers when it lands, and what it changes: the owner's words for the seeds, typed here. */
  lands: (r: Rig) => { answer: unknown; changes: Partial<Snapshot> };
};

/** A round of `fixtures` boards, opened through the product's own `openRound` at OPEN_AT (before any freeze), every board invited. */
async function openedRound(fixtures: number): Promise<Rig> {
  const r = await seedOnlineChessRound({ fixtures });
  const opened = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: OPEN_AT });
  expect(opened, "premise: the round was opened while nothing was frozen").toMatchObject({ opened: true, invited: 2 * fixtures });
  return r;
}
const quiet = async (): Promise<void> => {};

const START_SITES: StartSite[] = [
  {
    site: "external-play/open-round.ts#openRound",
    // Two boards. The second board's home player has no Lichess link, so the open HOLDS that board for the organiser (a
    // `needs_organiser` row, reason `lichess_unlinked`) and invites the first: a frozen open must write neither. The first board also
    // carries a RESCHEDULED game-less row (its basis an hour before its start), which an open starts over (`resetStaleBridge`): the
    // earliest write the open makes, ahead of the transaction, and a frozen one must not make it either.
    arrange: async () => {
      const r = await seedOnlineChessRound({ fixtures: 2 });
      await sql`delete from user_external_accounts where user_id = ${r.boards[1]!.home.userId} and provider = 'lichess'`;
      await sql`
        insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
        select f.id, f.org_id, 'pending', f.scheduled_at - interval '1 hour' from fixtures f where f.id = ${r.boards[0]!.fixtureId}`;
      return r;
    },
    attempt: (r) => openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: OPEN_AT }),
    lands: (r) => ({
      answer: { opened: true, invited: 2, retrying: 0, skipped: [{ fixtureId: r.boards[1]!.fixtureId, reason: "lichess_unlinked" }] },
      // the round's stamp; the held board's new row (the invited board's row stood already); the one hold; the stale row started over; the
      // invited board's two seat stamps, outbox rows and mails; and the open's ledger event
      changes: { opens: 1, bridges: 1, holds: 1, stale: -1, stamps: 2, outbox: 2, mailed: 2, events: 1 },
    }),
  },
  {
    site: "external-play/invite.ts#resendExternalPlayNotice",
    // The opened board's row is then RESCHEDULED (its basis an hour before its start), which a resend starts over
    // (`resetStaleBridge`) before it writes anything else: a frozen resend must not make that write either.
    arrange: async () => {
      const r = await openedRound(1);
      await sql`update fixture_external_play set scheduled_at_basis = scheduled_at_basis - interval '1 hour' where fixture_id = ${r.boards[0]!.fixtureId}`;
      return r;
    },
    attempt: (r) => resendExternalPlayNotice(r.owner, r.boards[0]!.fixtureId, ORIGIN, { now: PRESS_AT }),
    // the stale row started over, both seats re-mailed: one new outbox row and one mail each (their stamps stand again after the reset)
    lands: () => ({ answer: { emailed: 2, retrying: 0 }, changes: { stale: -1, outbox: 2, mailed: 2 } }),
  },
  {
    site: "external-play/checkin-extend.ts#extendCheckin",
    arrange: () => openedRound(1),
    attempt: (r) => extendCheckin(r.owner, r.boards[0]!.fixtureId, { now: () => PRESS_AT, publish: quiet }),
    lands: (r) => ({
      answer: expect.objectContaining({ fixtureId: r.boards[0]!.fixtureId, extensions: 1 }),
      changes: { extensions: 1, extraMs: CHECKIN_EXTEND_STEP_MS, audits: 1 },
    }),
  },
  {
    site: "external-play/checkin-extend.ts#extendRoundCheckin",
    arrange: () => openedRound(2),
    attempt: (r) => extendRoundCheckin(r.owner, { stageId: r.stageId, roundNo: 1 }, { now: () => PRESS_AT, publish: quiet }),
    lands: () => ({
      answer: expect.objectContaining({ extended: 2, failed: 0 }),
      changes: { extensions: 2, extraMs: 2 * CHECKIN_EXTEND_STEP_MS, audits: 2 },
    }),
  },
];

describe.skipIf(!HAS_DB)("Match Day O4 — an online round's START writes obey the billing freeze (and are accepted again when the freeze lifts)", () => {
  it("each START write on ONE competition: frozen is the freeze's own 402 and writes NOTHING; once the freeze lifts the same write lands; frozen again, a second call is refused and writes nothing more", async () => {
    let driven = 0;
    for (const s of START_SITES) {
      const r = await s.arrange();
      expect([...(await frozenCompetitionIds(r.orgId))], `${s.site}: premise, nothing frozen to start with`).toEqual([]);
      const start = await startRows(r);
      const refusedAt = async (when: string, still: Snapshot): Promise<void> => {
        const err = await s.attempt(r).then(
          () => new Error(`${s.site}: accepted on a frozen competition (${when})`),
          (e: unknown) => e,
        );
        expect(isFreeze(err), `${s.site} (${when}): ${String(err)}`).toBe(true);
        expect((err as PaymentRequiredError).status, `${s.site} (${when})`).toBe(402);
        expect(await startRows(r), `${s.site} (${when}): a refused START wrote nothing`).toEqual(still);
      };

      // frozen BEFORE the first write: nothing lands, and every row the write would have made is still absent
      await freeze(r);
      await refusedAt("frozen first", start);

      // the same competition, room appears: the write lands, and moves exactly what the owner says it moves
      await thaw(r);
      const expected = s.lands(r);
      expect(await s.attempt(r), `${s.site}: the answer once unfrozen`).toEqual(expected.answer);
      const landed = await startRows(r);
      expect(change(start, landed), `${s.site}: what the write changed`).toEqual({ ...ZERO, ...expected.changes });
      expect(Object.values(change(start, landed)).some((n) => n !== 0), `${s.site}: anti-vacuity, the write changed something`).toBe(true);

      // and frozen AGAIN, after it landed: a second call is the freeze's 402 too, and writes nothing beyond what already stood
      await freeze(r);
      await refusedAt("frozen again", landed);
      driven++;
    }
    expect(driven, "anti-vacuity: START sites driven").toBe(START_SITES.length);
    expect(driven).toBe(4);
  }, 240_000);

  it("the freeze is per COMPETITION: while one competition of the org is frozen, another competition of the same org still opens its round", async () => {
    const a = await seedOnlineChessRound({ fixtures: 1 });
    // A second competition of the SAME org, with an online division and a started round of its own, built before any limit applies.
    const competition = await createCompetition(a.owner, {
      name: "Second Cup",
      visibility: "public",
      branding: {},
      starts_on: "2026-10-01",
      ends_on: "2026-10-02",
    });
    const division = await createDivision(a.owner, competition.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 8),
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
    });
    const pair = await seedLinkedPair(a.owner, division.id);
    const [stage] = await createStages(a.owner, division.id, { seq: 1, kind: "league", name: "RR", config: {} });
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${a.orgId}, 1, 1, ${"o4-" + randomUUID().slice(0, 8)}, 'scheduled', ${pair.home.entrantId}, ${pair.away.entrantId}, ${OPEN_AT})`;
    await startDivision(a.owner, division.id);

    // One active competition too many: the OLDEST (a's, which nothing has scored in) is the one frozen, b's is not.
    await setLimit(a.orgId, 1);
    expect([...(await frozenCompetitionIds(a.orgId))], "premise: exactly the first competition is frozen").toEqual([a.competitionId]);

    const frozen = await openRound({ stageId: a.stageId, roundNo: 1, actorUserId: a.ownerUserId }, { now: OPEN_AT }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isFreeze(frozen), String(frozen)).toBe(true);
    expect(await sql`select 1 from stage_round_opens where stage_id = ${a.stageId}`, "the frozen competition's round was not opened").toHaveLength(0);

    const other = await openRound({ stageId: stage!.id, roundNo: 1, actorUserId: a.ownerUserId }, { now: OPEN_AT });
    expect(other, "the competition that is not frozen opens as ever").toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect(await sql`select 1 from stage_round_opens where stage_id = ${stage!.id}`).toHaveLength(1);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("Match Day O4 — the FINISH decisions are scoring: a billing-frozen competition still resyncs, lets the game go on, settles and lets play without video", () => {
  /** A game on file, as the create's writer leaves it (home White): the bridge a resync reads. */
  async function liveGame(r: Rig): Promise<void> {
    const b = r.boards[0]!;
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id)
      values (${b.fixtureId}, ${r.orgId}, 'live', now() - interval '5 minutes', ${`gm-${randomUUID().slice(0, 12)}`}, 'home', ${b.home.lichessId}, ${b.away.lichessId})`;
  }

  it("each is accepted on a frozen competition and does its own work; the sweep counts the exempt calls it drove", async () => {
    let driven = 0;

    // Resync from Lichess: reconcile's organiser trigger reads the game once.
    {
      const r = await seedOnlineChessRound({ fixtures: 1 });
      await liveGame(r);
      await freeze(r);
      const reads: string[] = [];
      const out = await resyncExternalPlay(r.owner, r.boards[0]!.fixtureId, { exportGame: async (id: string) => (reads.push(id), null) });
      expect(reads, "resync: Lichess was read").toHaveLength(1);
      expect(out.adopted, "resync: nothing to adopt from an empty read").toBe(0);
      driven++;
    }

    // "Let the game go on": the flags closed, so the held game plays.
    {
      const r = await seedOnlineChessRound({ fixtures: 1 });
      const b = r.boards[0]!;
      const [flag] = await sql<{ id: string }[]>`
        insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note)
        values (${b.fixtureId}, ${r.orgId}, 'camera_lost', ${b.home.personId}, null) returning id`;
      await freeze(r);
      expect(await closeExternalPlayFlags(r.owner, b.fixtureId, [flag!.id]), "flags: closed").toEqual({ closed: 1, stillOpen: 0 });
      driven++;
    }

    // Settle a held board: the organiser's result, written to the ledger.
    {
      const r = await seedOnlineChessRound({ fixtures: 1, scheduledAt: new Date(Date.now() - 5 * 60_000) });
      const b = r.boards[0]!;
      await sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
        values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, now() - interval '5 minutes')`;
      await sql`
        insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
        values (${b.fixtureId}, ${r.orgId}, 'pending', now() - interval '5 minutes')`;
      await holdForOrganiser({ fixtureId: b.fixtureId, reason: "provider_error", detail: "lichess 502 (TEST)" });
      await freeze(r);
      expect(await resolveExternalPlay(r.owner, b.fixtureId, "draw"), "settle: accepted").toEqual({ status: "finished" });
      const [row] = await sql<{ status: string; outcome: { kind?: string } | null }[]>`select status, outcome from fixtures where id = ${b.fixtureId}`;
      expect(row?.outcome, "settle: the draw is on the fixture").toMatchObject({ kind: "draw" });
      driven++;
    }

    // Let a board play without video (policy `required`, the vendor down): one record, under the organiser.
    {
      const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
      const b = r.boards[0]!;
      await freeze(r);
      expect(await overrideVideoAsOrganiser(r.owner, b.fixtureId, "video down"), "override: accepted").toEqual({ overridden: true });
      expect(
        await sql`select actor_user_id, note from online_chess_audit where fixture_id = ${b.fixtureId} and kind = 'video_override'`,
        "override: the record names the organiser",
      ).toEqual([{ actor_user_id: r.ownerUserId, note: "video down" }]);
      driven++;
    }

    expect(driven, "anti-vacuity: exempt calls driven").toBe(4);
    expect(driven).toBeGreaterThan(0);
  }, 240_000);
});
