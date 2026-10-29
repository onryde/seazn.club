// W2e Task 2 (spec 2026-10-28 §5.2, D13; rules X-SE-3, X-SE-1, VB-SE-1) — the D13 scorer exception, and the ending
// refusal on the scoring route, driven through the real scoring door.
//
// D13: `core.forfeit` is organiser-only (X-ST-2), with ONE exception. A scorer — a device link or an official scorer
// (controller ruling T0 #4: both) — may append `forfeit{reason:"disqualified"}` when the ledger's last live event is an
// end-level sanction against the same side (badminton black card, tennis default), and `forfeit{reason:"retired"}` when
// it is a prompt-level one (volleyball expulsion or disqualification, D12). Every other scorer forfeit stays 403. `D13`
// below is that text, typed from the spec (the rulebook); a premise test pins it equal to the engine's own declarations,
// so a declaration that drifts reds here rather than silently moving what the route admits.
//
// Authorities, as the real doors produce them: a device link minted by an editor and resolved through the `dl_` door,
// posting to the real POST /api/v1/fixtures/{id}/events route; an official scorer as organiser-only-events.test.ts seeds
// one (an accepted fixture_officials row — the AuthCtx its session door yields), and the organiser (the seeded owner
// session). A session door needs a cookie, so the two session actors go through the route's own body instead: the same
// `parseBody` schema, `scoreEvent` and `v1` wire mapping, with the door's AuthCtx handed in.
//
// A pre-W2e ledger is written by raw SQL, the one way such a row can exist now: the shape an earlier build left behind.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ForfeitReason } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { POST as eventsRoute } from "@/app/api/v1/fixtures/[id]/events/route";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { reply, v1 } from "@/server/api-v1/http";
import { AppendEventRequest } from "@/server/api-v1/schemas";
import { foldFixture } from "@/server/engine-db/fold";
import { createDeviceLink } from "@/server/usecases/device-links";
import { scoreEvent } from "@/server/usecases/scoring";
import { seedBracket, type SeededBracket } from "./helpers/seed-bracket";

// Every mint seals (scorer sheets §4.1): a throwaway key of this file's own, never an ambient .env.local one.
vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------
// The rulebook: D13's text (spec 2026-10-28 §3, D13; §5.2), one row per sanction level that a scorer's forfeit may end.
type Reason = Extract<ForfeitReason, "disqualified" | "retired">; // tsc: both are members of the engine's FORFEIT_REASONS
interface D13Row { sport: string; variant: string; level: string; reason: Reason }
const D13: readonly D13Row[] = [
  { sport: "badminton", variant: "bwf", level: "disqualification", reason: "disqualified" }, // the black card
  { sport: "tennis", variant: "tour", level: "default", reason: "disqualified" },
  { sport: "volleyball", variant: "indoor", level: "expulsion", reason: "retired" }, // D12: "can the team still field six?" — no
  { sport: "volleyball", variant: "indoor", level: "disqualification", reason: "retired" },
];
/** The forfeit reasons a writer may send (X-RS-1; `withdrew` is the cascade's alone, PF-2). */
const WRITER_REASONS = ["walkover", "retired", "disqualified"] as const satisfies readonly ForfeitReason[];
/** A sanction level each declaring sport records that is neither an end nor a prompt level, and a sport that declares
 *  no ending at all with the level that ends badminton: a scorer's forfeit after either is an ordinary organiser-only
 *  forfeit. */
const NOT_AN_ENDING: readonly { sport: string; variant: string; level: string }[] = [
  { sport: "badminton", variant: "bwf", level: "warning" },
  { sport: "tennis", variant: "tour", level: "warning" },
  { sport: "volleyball", variant: "indoor", level: "warning" },
  { sport: "tabletennis", variant: Object.keys(builtinModules.find((m) => m.key === "tabletennis")!.variants)[0]!, level: "disqualification" },
];

/** One point/rally to `side`, in each sport's own event. Test input, not an expected value. */
const PLAY: Readonly<Record<string, (side: string) => { type: string; payload: unknown }>> = {
  badminton: (side) => ({ type: "badminton.rally", payload: { wonBy: side } }),
  volleyball: (side) => ({ type: "volleyball.rally", payload: { wonBy: side } }),
  tabletennis: (side) => ({ type: "tabletennis.rally", payload: { wonBy: side } }),
  tennis: (side) => ({ type: "tennis.point", payload: { by: side } }),
};

// ---------------------------------------------------------------------------------------------------------------
// The rig.
const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const fixtureStatus = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true) returning id`;
  return id;
}

/** A fresh fixture of `sport`, both seats filled, its division started. Seeded as a league of seven (21 fixtures) and
 *  handed out one at a time, so the table below does not pay a division per row. */
const pools = new Map<string, { s: SeededBracket; free: string[] }>();
async function freshFixture(sport: string, variant: string) {
  const key = `${sport}/${variant}`;
  let pool = pools.get(key);
  if (pool === undefined || pool.free.length === 0) {
    const s = await seedBracket({ sport, variant, stageKind: "league", entrants: 7 });
    pool = { s, free: [...s.fixtureIds] };
    pools.set(key, pool);
  }
  const id = pool.free.shift()!;
  const [f] = await sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`;
  return { s: pool.s, id, home: f!.home, away: f!.away };
}

type Who = "device_link" | "official" | "organiser";
interface Answer { status: number; code: string | null; data: { seq: number; status: string; event_id: string } | null }
interface Actor { who: Who; send(type: string, payload: unknown, extra?: { expected_seq?: number; idempotency_key?: string }): Promise<Answer> }

const answerOf = async (res: Response): Promise<Answer> => {
  const body = (await res.json()) as { ok: boolean; data?: Answer["data"]; error?: { code: string } };
  return { status: res.status, code: body.ok ? null : body.error!.code, data: body.ok ? body.data! : null };
};

/** The actor `who` on fixture `id`, holding the AuthCtx its real door yields. */
async function actorOn(s: SeededBracket, id: string, who: Who): Promise<Actor> {
  const body = async (type: string, payload: unknown, extra: { expected_seq?: number; idempotency_key?: string } = {}) => ({
    expected_seq: extra.expected_seq ?? (await tip(id)),
    type,
    payload,
    ...(extra.idempotency_key !== undefined ? { idempotency_key: extra.idempotency_key } : {}),
  });
  if (who === "device_link") {
    // Minted by an editor session (issued_by), then resolved through the dl_ door — the producer's own AuthCtx.
    const issuer = await makeUser("issuer");
    await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${issuer}, 'owner')`;
    const link = await createDeviceLink({ ...s.auth, via: "session", userId: issuer, role: "owner" }, id, "Court phone");
    const headers = { authorization: `Bearer ${link.secret}`, "content-type": "application/json" };
    const auth = await requireFixtureActor(new Request("http://test.local/api/v1", { headers }), id, "score");
    expect(auth.via, "the rig: a real device-link AuthCtx").toBe("device_link");
    return {
      who,
      send: async (type, payload, extra) =>
        answerOf(
          await eventsRoute(
            new Request(`http://test.local/api/v1/fixtures/${id}/events`, { method: "POST", headers, body: JSON.stringify(await body(type, payload, extra)) }),
            { params: Promise.resolve({ id }) },
          ),
        ),
    };
  }
  let auth: AuthCtx = s.auth;
  if (who === "official") {
    // scorers.test.ts's acceptOfficial: a person → official → ACCEPTED assignment on this fixture, no org role.
    const userId = await makeUser("official");
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id) values (${s.auth.orgId}, 'Official', ${userId}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${s.auth.orgId}, ${person!.id}, 'Official', ${sql.json(["referee"])}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${s.auth.orgId}, ${id}, ${official!.id}, 'referee', 'accepted')`;
    auth = { orgId: s.auth.orgId, via: "session", userId, role: null, keyId: null };
  }
  return {
    who,
    send: async (type, payload, extra) => {
      const b = await body(type, payload, extra);
      return answerOf(await v1(async () => reply(201, await scoreEvent(auth, id, AppendEventRequest.parse(b)))));
    },
  };
}

/** Raw SQL: an event written by a build before W2e (the strict write path would refuse it now). */
async function insertLegacy(id: string, type: string, payload: unknown): Promise<string> {
  const eventId = randomUUID();
  await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
            values (${eventId}, ${id}, ${(await tip(id)) + 1}, ${type}, ${sql.json(payload as never)}, now())`;
  return eventId;
}

const SCORERS = ["device_link", "official"] as const;
const sanctionType = (sport: string) => `${sport}.sanction`;

// ---------------------------------------------------------------------------------------------------------------
describe("X-SE-3 (D13) — the rulebook table is the engine's declarations", () => {
  it("X-SE-3 every D13 row is a declared end level (disqualified) or prompt level (retired), and every declared level is a D13 row", () => {
    const declared: string[] = [];
    for (const m of builtinModules) {
      const decl = m.sanctionEnding;
      if (decl === undefined) continue;
      expect(decl.eventType, m.key).toBe(sanctionType(m.key));
      for (const level of decl.endLevels) declared.push(`${m.key}/${level}/disqualified`);
      for (const level of decl.promptLevels) declared.push(`${m.key}/${level}/retired`);
    }
    expect(declared.length, "the engine declares endings (zero = nothing to check)").toBeGreaterThan(0);
    expect(declared.sort()).toEqual(D13.map((r) => `${r.sport}/${r.level}/${r.reason}`).sort());
    for (const r of NOT_AN_ENDING) {
      const decl = builtinModules.find((m) => m.key === r.sport)!.sanctionEnding;
      expect([...(decl?.endLevels ?? []), ...(decl?.promptLevels ?? [])], `${r.sport}/${r.level}`).not.toContain(r.level);
    }
  });
});

describe.runIf(HAS_DB)("X-SE-3 (D13) — a scorer's forfeit through the scoring door", () => {
  it("X-SE-3 D13 scorer forfeit is refused unless it is the ending of the side's own ending sanction: the other side and every wrong reason 403 on the very ledger where the ending is then 201; a voided sanction and an event between 403", async () => {
    let admitted = 0;
    let refused = 0;
    for (const row of D13)
      for (const who of SCORERS) {
        const label = `${row.sport}/${row.level} ${who}`;
        const sanction = (by: string) => ({ by, level: row.level });

        // 1. The positive, and on the same ledger first: the other side, then each wrong reason. Each 403 writes nothing.
        {
          const { s, id, home, away } = await freshFixture(row.sport, row.variant);
          const a = await actorOn(s, id, who);
          expect((await a.send("core.start", {})).status, `${label} start`).toBe(201);
          const p = PLAY[row.sport]!(home);
          expect((await a.send(p.type, p.payload)).status, `${label} play`).toBe(201);
          expect((await a.send(sanctionType(row.sport), sanction(away))).status, `${label} sanction`).toBe(201);
          const before = await tip(id);
          for (const attempt of [
            { by: home, reason: row.reason, why: "against the other side" },
            ...WRITER_REASONS.filter((r) => r !== row.reason).map((reason) => ({ by: away, reason, why: `wrong reason ${reason}` })),
          ]) {
            const out = await a.send("core.forfeit", { by: attempt.by, reason: attempt.reason });
            expect([out.status, out.code], `${label} ${attempt.why}`).toEqual([403, "FORBIDDEN"]);
            expect(await tip(id), `${label} ${attempt.why}: nothing written`).toBe(before);
            refused++;
          }
          const ending = await a.send("core.forfeit", { by: away, reason: row.reason });
          expect([ending.status, ending.data?.status, ending.data?.seq], `${label} the ending`).toEqual([201, "forfeited", before + 1]);
          admitted++;
        }

        // 2. The sanction was voided: the ending of nothing.
        {
          const { s, id, home, away } = await freshFixture(row.sport, row.variant);
          const a = await actorOn(s, id, who);
          await a.send("core.start", {});
          const p = PLAY[row.sport]!(home);
          await a.send(p.type, p.payload);
          const card = await a.send(sanctionType(row.sport), sanction(away));
          expect((await a.send("core.void", { event_id: card.data!.event_id })).status, `${label} void`).toBe(201);
          const before = await tip(id);
          const out = await a.send("core.forfeit", { by: away, reason: row.reason });
          expect([out.status, out.code], `${label} after a voided sanction`).toEqual([403, "FORBIDDEN"]);
          expect(await tip(id), `${label} voided: nothing written`).toBe(before);
          refused++;
        }

        // 3. Another event between the sanction and the forfeit. After a prompt level play goes on, so the scorer's own
        //    next rally is the event; after an end level the write path refuses every rally (X-SE-1), so the event between
        //    is the shape a pre-W2e build wrote — a rally after the card, by raw SQL.
        {
          const { s, id, home, away } = await freshFixture(row.sport, row.variant);
          const a = await actorOn(s, id, who);
          await a.send("core.start", {});
          const p = PLAY[row.sport]!(home);
          await a.send(p.type, p.payload);
          await a.send(sanctionType(row.sport), sanction(away));
          if (row.reason === "retired") expect((await a.send(p.type, p.payload)).status, `${label} play goes on`).toBe(201);
          else await insertLegacy(id, p.type, p.payload);
          const before = await tip(id);
          const out = await a.send("core.forfeit", { by: away, reason: row.reason });
          expect([out.status, out.code], `${label} with an event between`).toEqual([403, "FORBIDDEN"]);
          expect(await tip(id), `${label} between: nothing written`).toBe(before);
          refused++;
        }
      }
    // Per (row, scorer): one ending admitted; the other side, two wrong reasons, a voided sanction, an event between.
    expect({ admitted, refused }).toEqual({ admitted: D13.length * SCORERS.length, refused: D13.length * SCORERS.length * 5 });
  });

  it("X-SE-3 a scorer's forfeit after a sanction that ends nothing — a lower level, or a sport that declares no ending — is 403 for both reasons", async () => {
    let refused = 0;
    for (const row of NOT_AN_ENDING)
      for (const who of SCORERS) {
        const { s, id, home, away } = await freshFixture(row.sport, row.variant);
        const a = await actorOn(s, id, who);
        await a.send("core.start", {});
        const p = PLAY[row.sport]!(home);
        await a.send(p.type, p.payload);
        expect((await a.send(sanctionType(row.sport), { by: away, level: row.level })).status, `${row.sport}/${row.level} ${who}`).toBe(201);
        const before = await tip(id);
        for (const reason of ["disqualified", "retired"] as const) {
          const out = await a.send("core.forfeit", { by: away, reason });
          expect([out.status, out.code], `${row.sport}/${row.level} ${who} ${reason}`).toEqual([403, "FORBIDDEN"]);
          refused++;
        }
        expect(await tip(id), `${row.sport}/${row.level} ${who}: nothing written`).toBe(before);
      }
    expect(refused).toBe(NOT_AN_ENDING.length * SCORERS.length * 2);
  });

  it("VB-SE-1 X-SE-3 a volleyball expulsion or disqualification is a record: play goes on after it, and the scorer's forfeit{retired} right after it (the team cannot field six) is 201 for a device link and an official scorer, never forfeit{disqualified}", async () => {
    // single-sport: VB-SE-1 is volleyball's own row (D12); the D13 table above sweeps every declaring sport.
    let checked = 0;
    for (const level of D13.filter((r) => r.sport === "volleyball").map((r) => r.level))
      for (const who of SCORERS) {
        const label = `${level} ${who}`;
        const { s, id, home, away } = await freshFixture("volleyball", "indoor");
        const a = await actorOn(s, id, who);
        await a.send("core.start", {});
        await a.send("volleyball.rally", { wonBy: home });
        await a.send("volleyball.sanction", { by: away, level });
        // The sanction ends nothing: the next rally lands (no ENDING_SANCTION_PENDING) and the match stays in play.
        const rally = await a.send("volleyball.rally", { wonBy: away });
        expect([rally.status, rally.data?.status], `${label} a rally after the sanction`).toEqual([201, "in_play"]);
        // The answer to "can they field six?" comes after a rally here, so the sanction is no longer the last live event.
        expect((await a.send("core.forfeit", { by: away, reason: "retired" })).status, `${label} not right after it`).toBe(403);
        // A second sanction at the level, then the ending right after it.
        await a.send("volleyball.sanction", { by: away, level });
        const wrong = await a.send("core.forfeit", { by: away, reason: "disqualified" });
        expect([wrong.status, wrong.code], `${label} forfeit{disqualified}`).toEqual([403, "FORBIDDEN"]);
        const ending = await a.send("core.forfeit", { by: away, reason: "retired" });
        expect([ending.status, ending.data?.status], `${label} forfeit{retired}`).toEqual([201, "forfeited"]);
        checked++;
      }
    expect(checked).toBe(2 * SCORERS.length);
  });

  it("X-SE-3 D13 organiser forfeit is unchanged: 201 with no sanction, for both reasons", async () => {
    // single-sport: the organiser's door reads no ledger; badminton is the sport the X-RS-3 matrix already uses.
    let checked = 0;
    for (const reason of ["disqualified", "retired"] as const) {
      const { s, id, home, away } = await freshFixture("badminton", "bwf");
      const a = await actorOn(s, id, "organiser");
      await a.send("core.start", {});
      await a.send("badminton.rally", { wonBy: home });
      const out = await a.send("core.forfeit", { by: away, reason });
      expect([out.status, out.data?.status], reason).toEqual([201, "forfeited"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-SE-3 the exception judges the ledger the request names (its expected_seq): a keyed retry of the ending gets its original answer, a stale request is a 409 and then a 403 once it resyncs, a request ahead of the ledger is a 403", async () => {
    // single-sport: the seq handling is the route's, not a sport's; the D13 table sweeps the sports.
    const { s, id, home, away } = await freshFixture("badminton", "bwf");
    const a = await actorOn(s, id, "device_link");
    await a.send("core.start", {});
    await a.send("badminton.rally", { wonBy: home });
    await a.send("badminton.sanction", { by: away, level: "disqualification" });
    const atCard = await tip(id);

    // Ahead: the ledger it names does not exist. Nothing is written.
    const ahead = await a.send("core.forfeit", { by: away, reason: "disqualified" }, { expected_seq: atCard + 1 });
    expect([ahead.status, ahead.code], "ahead of the ledger").toEqual([403, "FORBIDDEN"]);
    expect(await tip(id)).toBe(atCard);

    // A keyed ending, then its lost-ack retry (no Redis here: the cache is cold, so the ledger answers).
    const key = `d13-${randomUUID()}`;
    const first = await a.send("core.forfeit", { by: away, reason: "disqualified" }, { expected_seq: atCard, idempotency_key: key });
    expect([first.status, first.data?.status], "the ending").toEqual([201, "forfeited"]);
    const retry = await a.send("core.forfeit", { by: away, reason: "disqualified" }, { expected_seq: atCard, idempotency_key: key });
    expect([retry.status, retry.data?.event_id, retry.data?.seq], "the retry is the original answer").toEqual([201, first.data!.event_id, first.data!.seq]);
    expect(await tip(id), "one forfeit in the ledger").toBe(atCard + 1);

    // Stale: a second fixture whose sanction the organiser voids while the scorer's ending is in flight.
    const g = await freshFixture("badminton", "bwf");
    const scorer = await actorOn(g.s, g.id, "device_link");
    const organiser = await actorOn(g.s, g.id, "organiser");
    await scorer.send("core.start", {});
    await scorer.send("badminton.rally", { wonBy: g.home });
    const card = await scorer.send("badminton.sanction", { by: g.away, level: "disqualification" });
    const seen = await tip(g.id);
    expect((await organiser.send("core.void", { event_id: card.data!.event_id })).status, "the organiser voids the card").toBe(201);
    const stale = await scorer.send("core.forfeit", { by: g.away, reason: "disqualified" }, { expected_seq: seen });
    expect([stale.status, stale.code], "stale: resync").toEqual([409, "SEQ_CONFLICT"]);
    const resynced = await scorer.send("core.forfeit", { by: g.away, reason: "disqualified" });
    expect([resynced.status, resynced.code], "resynced: the sanction is voided").toEqual([403, "FORBIDDEN"]);
    expect(await tip(g.id), "neither wrote").toBe(seen + 1);
  });

  it("X-SE-3 X-SE-1 the sequence through the door: the scorer voids its own ending, the ending is pending again and it may confirm it again; voiding the sanction then leaves the match ended; voiding that ending too lets play resume", async () => {
    // single-sport: the void sequences are core's (Task 1 sweeps them in the engine); this is their route.
    const { s, id, home, away } = await freshFixture("badminton", "bwf");
    const a = await actorOn(s, id, "device_link");
    await a.send("core.start", {});
    await a.send("badminton.rally", { wonBy: home });
    const card = await a.send("badminton.sanction", { by: away, level: "disqualification" });
    const first = await a.send("core.forfeit", { by: away, reason: "disqualified" });
    expect(first.data?.status).toBe("forfeited");

    expect((await a.send("core.void", { event_id: first.data!.event_id })).data?.status, "the ending voided").toBe("in_play");
    const rally = await a.send("badminton.rally", { wonBy: home });
    expect([rally.status, rally.code], "pending again").toEqual([422, "ENDING_SANCTION_PENDING"]);
    const again = await a.send("core.forfeit", { by: away, reason: "disqualified" });
    expect([again.status, again.data?.status], "confirmed again").toEqual([201, "forfeited"]);

    expect((await a.send("core.void", { event_id: card.data!.event_id })).data?.status, "the sanction voided, the ending stands").toBe("forfeited");
    expect((await a.send("core.void", { event_id: again.data!.event_id })).data?.status, "the ending voided too").toBe("in_play");
    const resumed = await a.send("badminton.rally", { wonBy: home });
    expect([resumed.status, resumed.data?.status], "play resumes").toEqual([201, "in_play"]);
  });
});

describe.runIf(HAS_DB)("X-SE-1 — the scoring route refuses play while an ending is pending", () => {
  it("X-SE-1 a rally after a black card is 422 ENDING_SANCTION_PENDING through the route, and writes nothing — every declared end level", async () => {
    const ends = D13.filter((r) => r.reason === "disqualified");
    let checked = 0;
    for (const row of ends) {
      const { s, id, home, away } = await freshFixture(row.sport, row.variant);
      const a = await actorOn(s, id, "device_link");
      await a.send("core.start", {});
      const p = PLAY[row.sport]!(home);
      await a.send(p.type, p.payload);
      await a.send(sanctionType(row.sport), { by: away, level: row.level });
      const before = await tip(id);
      for (const [what, type, payload] of [
        ["a rally", p.type, p.payload],
        ["another sanction", sanctionType(row.sport), { by: home, level: "warning" }],
        ["a note", "core.note", { text: "x" }],
      ] as const) {
        const out = await a.send(type, payload);
        expect([out.status, out.code], `${row.sport} ${what}`).toEqual([422, "ENDING_SANCTION_PENDING"]);
        checked++;
      }
      expect(await tip(id), `${row.sport}: nothing written`).toBe(before);
      expect(await fixtureStatus(id), `${row.sport}: still in play`).toBe("in_play");
    }
    expect(checked).toBe(ends.length * 3);
    expect(ends.length).toBeGreaterThan(0);
  });

  it("X-SE-1 a legacy ledger (raw SQL insert of black card then rallies) still reads its recorded outcome and refuses its next rally", async () => {
    // single-sport: badminton's black card (BD-SE-1); tennis's default runs the same core refusal (Task 4's engine sweep).
    // In progress: a rally, the card against home, then two rallies to away — what a pre-W2e build accepted.
    {
      const { s, id, home, away } = await freshFixture("badminton", "bwf");
      const organiser = await actorOn(s, id, "organiser");
      const scorer = await actorOn(s, id, "device_link");
      await organiser.send("core.start", {});
      await insertLegacy(id, "badminton.rally", { wonBy: home });
      await insertLegacy(id, "badminton.sanction", { by: home, level: "disqualification" });
      await insertLegacy(id, "badminton.rally", { wonBy: away });
      await insertLegacy(id, "badminton.rally", { wonBy: away });
      const folded = await withTenant(s.auth.orgId, (tx) => foldFixture(tx, id));
      expect(folded!.outcome, "replay is lenient: the match is still in progress").toBeNull();
      // BWF Law 7: each rally is a point to its winner — the two after the card count as they were recorded.
      expect((folded!.summary.detail as { points?: unknown }).points, "the rallies after the card count").toEqual({ home: 1, away: 2 });
      const before = await tip(id);
      const next = await scorer.send("badminton.rally", { wonBy: away });
      expect([next.status, next.code], "the next rally").toEqual([422, "ENDING_SANCTION_PENDING"]);
      // The ending: not the scorer's (a rally sits between the card and it), the organiser's.
      const scorerEnding = await scorer.send("core.forfeit", { by: home, reason: "disqualified" });
      expect([scorerEnding.status, scorerEnding.code], "the scorer's ending").toEqual([403, "FORBIDDEN"]);
      expect(await tip(id), "neither wrote").toBe(before);
      const ending = await organiser.send("core.forfeit", { by: home, reason: "disqualified" });
      expect([ending.status, ending.data?.status], "the organiser's ending").toEqual([201, "forfeited"]);
    }
    // Finished: the card against home, then away wins 21-0, 21-0 — the result a pre-W2e build recorded.
    {
      const { s, id, home, away } = await freshFixture("badminton", "bwf");
      const organiser = await actorOn(s, id, "organiser");
      await organiser.send("core.start", {});
      await insertLegacy(id, "badminton.sanction", { by: home, level: "disqualification" });
      for (let i = 0; i < 42; i++) await insertLegacy(id, "badminton.rally", { wonBy: away });
      const folded = await withTenant(s.auth.orgId, (tx) => foldFixture(tx, id));
      // BWF Laws 7.1–7.3: two games to 21 win a best-of-three match.
      expect(folded!.outcome, "the recorded result").toMatchObject({ kind: "win", winner: away, loser: home });
      const before = await tip(id);
      const next = await organiser.send("badminton.rally", { wonBy: home });
      expect([next.status, next.code], "a decided match: guarantee 4, not the pending ending").toEqual([422, "ALREADY_DECIDED"]);
      expect(await tip(id)).toBe(before);
    }
  });

  it("X-SE-1 X-SE-3 a legacy [sanction, suspend] ledger: the suspend is the last live event, so the scorer cannot record the ending and its resume is refused; the organiser resolves it", async () => {
    // single-sport: the stoppage is core's (Task 1 M-6); badminton is the declaring sport this file seeds first.
    const legacy = async () => {
      const f = await freshFixture("badminton", "bwf");
      const organiser = await actorOn(f.s, f.id, "organiser");
      await organiser.send("core.start", {});
      await insertLegacy(f.id, "badminton.rally", { wonBy: f.home });
      await insertLegacy(f.id, "badminton.sanction", { by: f.away, level: "disqualification" });
      const suspend = await insertLegacy(f.id, "core.suspend", { reason: "rain" });
      return { ...f, organiser, suspend };
    };

    // Both scorers: the ending 403, the resume 422; a device link may not void a suspend it did not record.
    const f = await legacy();
    const before = await tip(f.id);
    for (const who of SCORERS) {
      const a = await actorOn(f.s, f.id, who);
      const ending = await a.send("core.forfeit", { by: f.away, reason: "disqualified" });
      expect([ending.status, ending.code], `${who} ending`).toEqual([403, "FORBIDDEN"]);
      const resume = await a.send("core.resume", {});
      expect([resume.status, resume.code], `${who} resume`).toEqual([422, "ENDING_SANCTION_PENDING"]);
      if (who === "device_link") {
        const v = await a.send("core.void", { event_id: f.suspend });
        expect([v.status, v.code], "a device link voids only its own events").toEqual([403, "FORBIDDEN"]);
      }
    }
    expect(await tip(f.id), "no scorer wrote").toBe(before);
    // The organiser's ending lands mid-stoppage and decides the match.
    const ending = await f.organiser.send("core.forfeit", { by: f.away, reason: "disqualified" });
    expect([ending.status, ending.data?.status], "the organiser's ending").toEqual([201, "forfeited"]);

    // The organiser's abandon resolves it too.
    const g = await legacy();
    const abandon = await g.organiser.send("core.abandon", { reason: "rain" });
    expect([abandon.status, abandon.data?.status], "the organiser's abandon").toEqual([201, "abandoned"]);

    // An official scorer may void any event of its fixture before finalize (its existing power, unchanged): voiding the
    // stoppage makes the sanction the last live event again, and then the ending is the scorer's to record (D13).
    const h = await legacy();
    const official = await actorOn(h.s, h.id, "official");
    expect((await official.send("core.void", { event_id: h.suspend })).status, "the official voids the stoppage").toBe(201);
    const after = await official.send("core.forfeit", { by: h.away, reason: "disqualified" });
    expect([after.status, after.data?.status], "then records the ending").toEqual([201, "forfeited"]);
  });
});
