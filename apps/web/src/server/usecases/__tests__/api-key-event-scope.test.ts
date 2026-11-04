// SEC1 (owner OK 2026-11-03) — an API key's scope gates the EVENT it sends, not only the route it hits. Before this, a
// `score` key (the scoreboard integration's credential) could POST `core.finalize` — whose own door is `manage` — to
// /fixtures/:id/events, and settle, forfeit or abandon a match the same way, or import a stream that finalizes. Real
// Postgres, real keys minted by createApiKey, through the real route handlers and the real key door (apiKeyAuth); the
// pure half (the table, per engine core type) is api-v1/__tests__/key-event-scope.test.ts.
//
// single-sport: generic — the gate reads the event TYPE (key-scopes.ts `keyScopeForEvent`), never the sport; the
// per-sport sweep of sport events is the pure half's. The D13 case is badminton's black card, the rulebook row
// w2e-ending-sanction.test.ts sweeps for every declaring sport.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CORE_EVENT_SCHEMAS } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { POST as eventsRoute } from "@/app/api/v1/fixtures/[id]/events/route";
import { POST as finalizeRoute } from "@/app/api/v1/fixtures/[id]/finalize/route";
import { POST as importRoute } from "@/app/api/v1/divisions/[id]/events/import/route";
import type { AuthCtx } from "@/server/api-v1/auth";
import { keyScopeForEvent } from "@/server/api-v1/key-scopes";
import { RESULT_CARRIED_FORWARD, RESULT_CARRIED_FORWARD_MESSAGE } from "@/server/usecases/carried-forward";
import { createApiKey } from "@/server/usecases/api-keys";
import { importEvents } from "@/server/usecases/event-import";
import { scoreEvent } from "@/server/usecases/scoring";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------
// The rig.
interface Answer {
  status: number;
  code: string | null;
  message: string | null;
  data: { seq?: number; status?: string; totals?: { imported: number; skipped: number; rejected: number } } | null;
}
const answerOf = async (res: Response): Promise<Answer> => {
  const body = (await res.json()) as { ok: boolean; data?: Answer["data"]; error?: { code: string; message: string } };
  return body.ok
    ? { status: res.status, code: null, message: null, data: body.data ?? null }
    : { status: res.status, code: body.error!.code, message: body.error!.message, data: null };
};

const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;
const lastType = async (id: string) =>
  (await sql<{ type: string }[]>`select type from score_events where fixture_id = ${id} order by seq desc limit 1`)[0]?.type ?? null;
/** The id of the latest `type` row on the fixture's ledger — what a `core.void` names. */
const eventIdOf = async (id: string, type: string) =>
  (await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = ${type} order by seq desc limit 1`)[0]!.id;

/** A started generic knockout of `entrants` (entrants / 2 seated first-round fixtures), and a `score` and a `manage` key
 *  minted for its org the way a club mints them (createApiKey). api.write is Pro Plus (V290): granted by override here —
 *  this suite is about the event gate, not the entitlement one (api-key-scopes.test.ts's reasoning). */
async function rig(entrants = 2, sport = "generic", variant = "score", stageKind: "knockout" | "league" = "knockout") {
  const s = await seedBracket({ sport, variant, stageKind, entrants });
  for (const feature of ["api.access", "api.write"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${s.auth.orgId}, ${feature}, true, 'SEC1 test')
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(s.auth.orgId);
  const score = (await createApiKey(s.auth, { name: "scoreboard", scopes: ["score"] })).secret;
  const manage = (await createApiKey(s.auth, { name: "manager", scopes: ["manage"] })).secret;
  return { s, score, manage };
}

const seats = async (id: string) =>
  (await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;

const keyed = (secret: string) => ({ authorization: `Bearer ${secret}`, "content-type": "application/json" });

/** POST /fixtures/:id/events with `secret`, at the ledger's tip unless told otherwise. */
async function send(secret: string, id: string, type: string, payload: unknown, expectedSeq?: number): Promise<Answer> {
  const body = { expected_seq: expectedSeq ?? (await tip(id)), type, payload };
  return answerOf(
    await eventsRoute(
      new Request(`http://test.local/api/v1/fixtures/${id}/events`, { method: "POST", headers: keyed(secret), body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function importAs(secret: string, divisionId: string, body: unknown): Promise<Answer> {
  return answerOf(
    await importRoute(
      new Request(`http://test.local/api/v1/divisions/${divisionId}/events/import`, { method: "POST", headers: keyed(secret), body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: divisionId }) },
    ),
  );
}

/** Per manage-level type: what the fixture needs first (written by the organiser session) and the event itself, posted
 *  where it is recordable — finalize after a result, settle after an abandon (X-ST-1), forfeit and abandon after the
 *  start. Test input, not an expected value; a type with no row here fails the sweep by name. */
const SWEEP: Readonly<Record<string, { prep: (f: { home: string; away: string }) => { type: string; payload: unknown }[]; payload: (f: { home: string; away: string }) => unknown }>> = {
  "core.finalize": {
    prep: () => [{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }],
    payload: () => ({}),
  },
  "core.settle": {
    prep: () => [{ type: "core.start", payload: {} }, { type: "core.abandon", payload: { reason: "rain" } }],
    payload: (f) => ({ winner: f.home, method: "lot" }),
  },
  // `payload` before `prep`: forfeit-vocabulary-scan.test.ts reads a forfeit's reason only when no other quoted event type
  // sits between it and the literal, so this order lets X-RS-1 check "disqualified" against FORFEIT_REASONS.
  "core.forfeit": { payload: (f) => ({ by: f.away, reason: "disqualified" }), prep: () => [{ type: "core.start", payload: {} }] },
  "core.abandon": { prep: () => [{ type: "core.start", payload: {} }], payload: () => ({ reason: "rain" }) },
};

async function prepare(s: SeededBracket, id: string, events: { type: string; payload: unknown }[]): Promise<void> {
  for (const e of events) await scoreEvent(s.auth, id, { expected_seq: await tip(id), type: e.type, payload: e.payload });
}

/** m3 — the sweeps iterate the ENGINE's declared core types, never the set under test: the types swept are the engine's
 *  that have a SWEEP row (the spec, typed above), and the code's manage set is asserted EQUAL to them. So a type dropped
 *  from the table is still swept (and its score key's 201 reds), a type added without a row reds the equality, and a row
 *  whose type the engine lost reds as stale. Zero swept is a failure. */
function manageTypesSwept(): string[] {
  const core = Object.keys(CORE_EVENT_SCHEMAS);
  expect(core.length, "the engine declares core types").toBeGreaterThan(0);
  expect(Object.keys(SWEEP).filter((t) => !core.includes(t)), "a SWEEP row the engine does not declare").toEqual([]);
  const swept = core.filter((t) => Object.hasOwn(SWEEP, t));
  expect(swept.length, `manage-level core types swept: ${swept.length} of ${core.length}`).toBeGreaterThan(0);
  expect(core.filter((t) => keyScopeForEvent(t, {}) === "manage").sort(), "the code's manage set is the SWEEP's").toEqual([...swept].sort());
  return swept;
}

// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("SEC1: a key's scope gates the event at POST /fixtures/:id/events", () => {
  it("a score key scores and decides a match, is refused core.finalize (nothing written), and the manage key then finalizes it", async () => {
    const { s, score, manage } = await rig();
    const id = s.fixtureIds[0]!;
    // The positive pair first: ordinary scoring through the score key is untouched.
    expect((await send(score, id, "core.start", {})).status, "score key: core.start").toBe(201);
    const result = await send(score, id, "generic.result", { p1Score: 3, p2Score: 1 });
    expect([result.status, result.data?.status], "score key: the deciding result").toEqual([201, "decided"]);

    const before = await tip(id);
    const refused = await send(score, id, "core.finalize", {});
    expect([refused.status, refused.code], "score key: core.finalize").toEqual([403, "FORBIDDEN"]);
    expect(refused.message).toBe(
      "This key is limited to 'score' — sending core.finalize needs the 'manage' scope. Create a key with the right scope in org settings.",
    );
    expect(await tip(id), "nothing written").toBe(before);
    expect(await statusOf(id), "the fixture is NOT finalized").toBe("decided");

    // Its own door refuses the same key at the same scope — the equality the event gate exists to restore.
    const door = await answerOf(
      await finalizeRoute(
        new Request(`http://test.local/api/v1/fixtures/${id}/finalize`, { method: "POST", headers: keyed(score), body: JSON.stringify({ expected_seq: before }) }),
        { params: Promise.resolve({ id }) },
      ),
    );
    expect([door.status, door.code], "score key: POST /finalize").toEqual([403, "FORBIDDEN"]);
    expect(await tip(id)).toBe(before);

    // A second call, by the manage key, on the very ledger the refusal left: it finalizes.
    const ok = await send(manage, id, "core.finalize", {});
    expect([ok.status, ok.data?.status, ok.data?.seq], "manage key: core.finalize").toEqual([201, "finalized", before + 1]);
    expect(await statusOf(id)).toBe("finalized");
  });

  it("every manage-level event in the table is refused to a score key and nothing is written; the manage key records it on the same ledger", async () => {
    const types = manageTypesSwept();
    const { s, score, manage } = await rig(types.length * 2);
    expect(s.fixtureIds.length, "one seated fixture per manage type").toBeGreaterThanOrEqual(types.length);
    let refused = 0;
    let accepted = 0;
    for (const [i, type] of types.entries()) {
      const row = SWEEP[type];
      expect(row, `${type}: no sweep row — add how it is recorded`).toBeDefined();
      const id = s.fixtureIds[i]!;
      const f = await seats(id);
      await prepare(s, id, row!.prep(f));
      const before = await tip(id);
      const statusBefore = await statusOf(id);

      const out = await send(score, id, type, row!.payload(f));
      expect([out.status, out.code], `${type}: score key`).toEqual([403, "FORBIDDEN"]);
      expect(out.message, `${type}: names the event and the scope`).toContain(`sending ${type} needs the 'manage' scope`);
      expect(await tip(id), `${type}: nothing written`).toBe(before);
      expect(await statusOf(id), `${type}: status unchanged`).toBe(statusBefore);
      refused++;

      const ok = await send(manage, id, type, row!.payload(f));
      expect([ok.status, ok.data?.seq], `${type}: manage key`).toEqual([201, before + 1]);
      expect(await lastType(id), `${type}: the manage key's row`).toBe(type);
      accepted++;
    }
    expect({ refused, accepted }).toEqual({ refused: types.length, accepted: types.length });
  });

  it("D13: the score key — the scorer-level key — may record the forfeit that ends its side's own black card, and only that one", async () => {
    // single-sport: badminton — the exception is the engine's (`scorerMayForfeit`), swept per sport in
    // w2e-ending-sanction.test.ts; here only that the key door reaches it, bounded on both sides.
    const { s, score } = await rig(2, "badminton", "bwf");
    const id = s.fixtureIds[0]!;
    const { home, away } = await seats(id);
    expect((await send(score, id, "core.start", {})).status).toBe(201);
    expect((await send(score, id, "badminton.rally", { wonBy: home })).status).toBe(201);
    // Before any sanction, a score key's forfeit is the organiser's act: refused.
    const early = await send(score, id, "core.forfeit", { by: away, reason: "disqualified" });
    expect([early.status, early.code], "a forfeit with no sanction before it").toEqual([403, "FORBIDDEN"]);
    // m4 — WHICH gate: the key-scope gate, not any other 403 (FORBIDDEN is every bare HttpError's code).
    expect(early.message, "refused by the key-scope gate").toContain("sending core.forfeit needs the 'manage' scope");
    expect((await send(score, id, "badminton.sanction", { by: away, level: "disqualification" })).status, "the black card").toBe(201);
    const before = await tip(id);
    const other = await send(score, id, "core.forfeit", { by: home, reason: "disqualified" });
    expect([other.status, other.code], "against the OTHER side").toEqual([403, "FORBIDDEN"]);
    expect(other.message, "refused by the key-scope gate").toContain("sending core.forfeit needs the 'manage' scope");
    expect(await tip(id)).toBe(before);
    const ending = await send(score, id, "core.forfeit", { by: away, reason: "disqualified" });
    expect([ending.status, ending.data?.status, ending.data?.seq], "the ending").toEqual([201, "forfeited", before + 1]);
    // The sequence after it: the ending is a forfeit, so taking it back is a void OF a forfeit — the organiser's (fix
    // round 1, ruling 1), even for the key that recorded it.
    const undo = await send(score, id, "core.void", { event_id: await eventIdOf(id, "core.forfeit") });
    expect([undo.status, undo.code], "the score key's void of its own ending").toEqual([403, "FORBIDDEN"]);
    expect(undo.message).toContain("voiding a core.forfeit needs the 'manage' scope");
    expect(await tip(id), "nothing written").toBe(before + 1);
  });

  it("an api_key AuthCtx that carries no scopes is refused every event, not trusted (no producer builds one for scoring)", async () => {
    // stages.ts's system ctx (markFieldChangeSeedProposalsStale) is via "api_key" with no scopes; it never scores. If a
    // caller ever hands one to the ledger, it fails closed rather than writing as an organiser.
    const { s } = await rig();
    const id = s.fixtureIds[0]!;
    const bare: AuthCtx = { orgId: s.auth.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    for (const type of ["core.start", "core.abandon"]) {
      await expect(scoreEvent(bare, id, { expected_seq: await tip(id), type, payload: type === "core.abandon" ? { reason: "rain" } : {} }), type).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining(`This key has no scope — sending ${type} needs`),
      });
    }
    expect(await tip(id), "nothing written").toBe(0);
  });

  it("m1: a scope-less api_key ctx is refused even the forfeit that ends a black card — D13 is the scorer-level key's, and it holds no scope", async () => {
    // single-sport: badminton — the D13 rulebook row the live door reaches (see the D13 case above).
    const { s, score } = await rig(2, "badminton", "bwf");
    const id = s.fixtureIds[0]!;
    const { home, away } = await seats(id);
    await prepare(s, id, [
      { type: "core.start", payload: {} },
      { type: "badminton.rally", payload: { wonBy: home } },
      { type: "badminton.sanction", payload: { by: away, level: "disqualification" } },
    ]);
    const before = await tip(id);
    const bare: AuthCtx = { orgId: s.auth.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    await expect(scoreEvent(bare, id, { expected_seq: before, type: "core.forfeit", payload: { by: away, reason: "disqualified" } })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("This key has no scope — sending core.forfeit needs the 'manage' scope"),
    });
    expect(await tip(id), "nothing written").toBe(before);
    // The positive pair, on the same ledger: the score key records exactly that ending.
    const ending = await send(score, id, "core.forfeit", { by: away, reason: "disqualified" });
    expect([ending.status, ending.data?.status], "the score key's ending").toEqual([201, "forfeited"]);
  });
});

describe.skipIf(!HAS_DB)("SEC1 fix round 1: a key's core.void is judged by what it undoes", () => {
  it("ruling 1: a score key may not void an organiser's settle, forfeit or abandon; the manage key may; a score-level target stays the score key's", async () => {
    // core.finalize is not swept here: nothing appends to a finalized fixture (the next case).
    const targets = manageTypesSwept().filter((t) => t !== "core.finalize");
    expect(targets.length, `void targets swept: ${targets.length}`).toBeGreaterThan(0);
    // A league: no feed and an open stage, so a decided fixture is never carried forward and only the target is asked.
    const { s, score, manage } = await rig(4, "generic", "score", "league");
    expect(s.fixtureIds.length, "one fixture per target, and one for the positive pair").toBeGreaterThan(targets.length);
    let refused = 0;
    for (const [i, type] of targets.entries()) {
      const id = s.fixtureIds[i]!;
      const f = await seats(id);
      await prepare(s, id, [...SWEEP[type]!.prep(f), { type, payload: SWEEP[type]!.payload(f) }]);
      const target = await eventIdOf(id, type);
      const before = await tip(id);
      const statusBefore = await statusOf(id);
      const out = await send(score, id, "core.void", { event_id: target });
      expect([out.status, out.code], `${type}: the score key's void`).toEqual([403, "FORBIDDEN"]);
      expect(out.message, type).toBe(
        `This key is limited to 'score' — voiding a ${type} needs the 'manage' scope. Create a key with the right scope in org settings.`,
      );
      expect(await tip(id), `${type}: nothing written`).toBe(before);
      expect(await statusOf(id), `${type}: status unchanged`).toBe(statusBefore);
      refused++;
      const ok = await send(manage, id, "core.void", { event_id: target });
      expect([ok.status, ok.data?.seq], `${type}: the manage key's void`).toEqual([201, before + 1]);
    }
    expect(refused).toBe(targets.length);

    // The positive pair: the score key voids its own deciding result (a score-level target) on a fixture not carried.
    const id = s.fixtureIds[targets.length]!;
    expect((await send(score, id, "core.start", {})).status).toBe(201);
    expect((await send(score, id, "generic.result", { p1Score: 3, p2Score: 1 })).data?.status).toBe("decided");
    const undo = await send(score, id, "core.void", { event_id: await eventIdOf(id, "generic.result") });
    expect(undo.status, "score key: void of a score-level target").toBe(201);
  });

  it("void after finalize: the score key's void of the finalized result is still refused, and nothing is written", async () => {
    const { s, score, manage } = await rig();
    const id = s.fixtureIds[0]!;
    expect((await send(score, id, "core.start", {})).status).toBe(201);
    expect((await send(score, id, "generic.result", { p1Score: 3, p2Score: 1 })).status).toBe(201);
    expect((await send(manage, id, "core.finalize", {})).data?.status).toBe("finalized");
    const before = await tip(id);
    const out = await send(score, id, "core.void", { event_id: await eventIdOf(id, "generic.result") });
    expect([out.status, out.code], "a void on a finalized ledger").toEqual([422, "ALREADY_DECIDED"]);
    expect(await tip(id), "nothing written").toBe(before);
    expect(await statusOf(id)).toBe("finalized");
  });

  it("m7: once the result is carried forward, the score key gets the device link's refusal for any void; the manage key does not", async () => {
    // A knockout SF is carried the instant it is decided: the winner's seat in the final fills (carried-forward-scoring.test.ts P5).
    const { s, score, manage } = await rig(4);
    const id = s.fixtureIds[0]!;
    expect((await send(score, id, "core.start", {})).status).toBe(201);
    expect((await send(score, id, "generic.result", { p1Score: 3, p2Score: 1 })).data?.status).toBe("decided");
    const [feed] = await sql<{ filled: boolean }[]>`
      select case f.winner_to_slot when 1 then w.home_entrant_id is not null else w.away_entrant_id is not null end as filled
      from fixtures f join fixtures w on w.id = f.winner_to_fixture where f.id = ${id}`;
    expect(feed?.filled, "the final's seat is filled: the result is carried").toBe(true);
    const before = await tip(id);
    let refused = 0;
    // The deciding event, and an earlier one: voiding either re-folds the carried result.
    for (const type of ["generic.result", "core.start"]) {
      const out = await send(score, id, "core.void", { event_id: await eventIdOf(id, type) });
      expect([out.status, out.code, out.message], `void of ${type}`).toEqual([403, RESULT_CARRIED_FORWARD, RESULT_CARRIED_FORWARD_MESSAGE]);
      refused++;
    }
    expect(refused).toBe(2);
    expect(await tip(id), "nothing written").toBe(before);
    expect(await statusOf(id)).toBe("decided");
    // The organiser-level key corrects it, as the organiser's session does.
    const ok = await send(manage, id, "core.void", { event_id: await eventIdOf(id, "generic.result") });
    expect([ok.status, ok.data?.seq], "the manage key's void").toEqual([201, before + 1]);
  });
});

describe.skipIf(!HAS_DB)("SEC1: a key's scope gates the events at POST /divisions/:id/events/import", () => {
  it("a score key's import with a core.finalize in ANY stream is refused 403 and writes nothing — no events, no receipt, no lock — and the manage key then imports the same body", async () => {
    const { s, score, manage } = await rig(4);
    const [a, b] = s.fixtureIds as [string, string];
    const body = {
      import_id: `sec1-${randomUUID().slice(0, 8)}`,
      streams: [
        { fixture: { id: a }, events: [{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }] },
        {
          fixture: { id: b },
          events: [{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } }, { type: "core.finalize", payload: {} }],
        },
      ],
    };
    const refused = await importAs(score, s.divisionId, body);
    expect([refused.status, refused.code], "score key: a stream that finalizes").toEqual([403, "FORBIDDEN"]);
    expect(refused.message).toContain("sending core.finalize needs the 'manage' scope");
    // Atomic: the clean stream before it is not imported either.
    for (const id of [a, b]) {
      expect(await tip(id), `${id}: no events`).toBe(0);
      expect(await statusOf(id), `${id}: still scheduled`).toBe("scheduled");
    }
    const [{ receipts }] = await sql<{ receipts: number }[]>`
      select count(*)::int as receipts from event_imports where division_id = ${s.divisionId}`;
    const [{ locks }] = await sql<{ locks: number }[]>`
      select count(*)::int as locks from import_locks where division_id = ${s.divisionId}`;
    expect({ receipts, locks }, "no receipt, and the import lock was never taken").toEqual({ receipts: 0, locks: 0 });

    // A second call, by the manage key, with the same import_id: the refusal consumed nothing, so it imports both.
    const ok = await importAs(manage, s.divisionId, body);
    expect([ok.status, ok.data?.totals], "manage key").toEqual([200, { imported: 2, skipped: 0, rejected: 0 }]);
    expect([await statusOf(a), await statusOf(b)]).toEqual(["decided", "finalized"]);
  });

  it("every manage-level event in the table, in a stream, refuses a score key's import and writes nothing; a stream with none imports", async () => {
    const types = manageTypesSwept();
    const { s, score } = await rig(4);
    const [id, clean] = s.fixtureIds as [string, string];
    const f = await seats(id);
    let refused = 0;
    for (const type of types) {
      const row = SWEEP[type];
      expect(row, `${type}: no sweep row`).toBeDefined();
      // The stream is the start and the one manage-level event alone (a prep would bring a second one — settle's abandon —
      // and the refusal names the first it meets): the gate is asked before the fold, so recordability is not its question.
      const out = await importAs(score, s.divisionId, {
        import_id: `sec1-${type}`,
        streams: [{ fixture: { id }, events: [{ type: "core.start", payload: {} }, { type, payload: row!.payload(f) }] }],
      });
      expect([out.status, out.code], `${type}: score key import`).toEqual([403, "FORBIDDEN"]);
      expect(out.message, type).toContain(`sending ${type} needs the 'manage' scope`);
      refused++;
    }
    expect(refused).toBe(types.length);
    expect(await tip(id), "nothing written by any refused import").toBe(0);

    // The positive pair: a decided stream with no manage-level event imports through the score key.
    const ok = await importAs(score, s.divisionId, {
      import_id: "sec1-clean",
      streams: [{ fixture: { id: clean }, events: [{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }] }],
    });
    expect([ok.status, ok.data?.totals], "score key: a stream that only scores").toEqual([200, { imported: 1, skipped: 0, rejected: 0 }]);
    expect(await statusOf(clean)).toBe("decided");
  });

  it("an api_key AuthCtx that carries no scopes is refused an import, not trusted", async () => {
    const { s } = await rig(2);
    const id = s.fixtureIds[0]!;
    const bare: AuthCtx = { orgId: s.auth.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    await expect(
      importEvents(bare, s.divisionId, {
        import_id: "sec1-bare",
        streams: [{ fixture: { id }, events: [{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }] }],
      }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("This key has no scope") });
    expect(await tip(id)).toBe(0);
  });
});
