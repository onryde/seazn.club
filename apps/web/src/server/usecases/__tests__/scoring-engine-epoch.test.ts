// Engine-split batch 1f, Task 1f-1 (D15, D26, D31) — THE server minimum-epoch gate at the scoring door.
//
// A native client sends `engine_epoch`: the fold epoch of ITS engine for the fixture's sport. The server refuses (426
// ENGINE_OUTDATED) a write whose epoch is LOWER than `foldEpochOf(sport)` — that phone would fold the ledger it writes to
// differently from the server. Absent is accepted (the web pad is the server's own build and never sends it; D31 — no
// `engine_epoch_missing`, the server cannot tell a capture phone from the web pad). HIGHER is accepted (owner, 2026-10-15:
// "we maintain 2-3 backward version support with release discipline"). Only the `events` route is gated; a `core.void` goes
// through it, so an outdated phone's undo is refused too.
//
// MOCKING. Every epoch is 1 today and the schema's minimum is 1, so no real client can be BEHIND and the refusal branch is
// unreachable with the real table. `foldEpochOf` is therefore wrapped (a partial `vi.mock`, `importOriginal`): it answers
// the real table's value plus a per-sport bump this file sets, and nothing else changes. Every expectation below is derived
// from `foldEpochOf` (the engine's own declaration), never a typed number.
//
// THE CACHE. `@/lib/cache`'s idempotency keys (`idemv2:*`) are served from an in-memory fake here, because case 7 must pin
// BOTH the warm and the cold path of a retry; every other key delegates to the real module (no REDIS_URL, so a no-op).
// `scoring-durable-idempotency.test.ts` stays the no-cache witness for the database guarantee itself.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { foldEpochOf } from "@seazn/engine/sport";
import { forEachSportAsync } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import { divisionScoringClosed } from "@/lib/division-phase";
import { v1 } from "@/server/api-v1/http";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";

const bump = vi.hoisted(() => new Map<string, number>());
const idemCache = vi.hoisted(() => ({ store: new Map<string, unknown>(), hits: 0, misses: 0 }));

vi.mock("@seazn/engine/sport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/sport")>();
  return { ...actual, foldEpochOf: (sport: string) => actual.foldEpochOf(sport) + (bump.get(sport) ?? 0) };
});

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  const isIdem = (k: string) => k.startsWith("idemv2:");
  return {
    ...actual,
    cacheGet: async (k: string) => {
      if (!isIdem(k)) return actual.cacheGet(k);
      if (idemCache.store.has(k)) {
        idemCache.hits++;
        return idemCache.store.get(k);
      }
      idemCache.misses++;
      return null;
    },
    cacheSet: async (k: string, v: unknown, ttl: number) => {
      if (!isIdem(k)) return actual.cacheSet(k, v, ttl);
      idemCache.store.set(k, v);
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

// The table's own value for a sport, with the bump stripped (the mock above adds it back).
const realEpoch = (sport: string) => foldEpochOf(sport) - (bump.get(sport) ?? 0);

beforeEach(() => {
  bump.clear();
  idemCache.store.clear();
  idemCache.hits = 0;
  idemCache.misses = 0;
});
afterEach(() => bump.clear());
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Seeded { auth: AuthCtx; fixtureId: string; fixtureIds: string[]; divisionId: string; entrants: [string, string] }

/** A started division of `sport` with a seated fixture, through the usecases. The variant is the sport's FIRST declared
 *  one — an engine declaration, never a guessed key. */
async function seed(sport: string): Promise<Seeded> {
  const sportModule = builtinModules.find((m) => m.key === sport);
  if (sportModule === undefined) throw new Error(`no builtin sport ${sport}`);
  const variant = Object.keys(sportModule.variants)[0];
  if (variant === undefined) throw new Error(`${sport} declares no variant`);
  const s = await seedBracket({ sport, variant: declaredVariant(sport, variant), stageKind: "knockout", entrants: 4 });
  const fixtureId = s.fixtureIds[0]!;
  const [row] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
    select home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
  return { auth: s.auth, fixtureId, fixtureIds: s.fixtureIds, divisionId: s.divisionId, entrants: [row!.home_entrant_id, row!.away_entrant_id] };
}

const start = (s: Seeded, extra: Record<string, unknown> = {}) =>
  scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {}, ...extra });

async function rows(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e;
  }
  throw new Error("expected the write to be refused, but it was accepted");
}

const BADMINTON = "badminton";

describe.skipIf(!HAS_DB)("scoreEvent — the engine-epoch gate (D31)", () => {
  it("1. an ABSENT engine_epoch is accepted and written — even when the sport's epoch has moved (the web pad path)", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const out = await start(s);
    expect(out.seq).toBe(1);
    expect(await rows(s.fixtureId)).toBe(1);
  });

  it("2. an engine_epoch EQUAL to foldEpochOf(sport) is accepted and written", async () => {
    const s = await seed(BADMINTON);
    const out = await start(s, { engine_epoch: foldEpochOf(BADMINTON) });
    expect(out.seq).toBe(1);
    expect(await rows(s.fixtureId)).toBe(1);
  });

  it("2b. EQUAL still holds after the epoch has moved: a phone at the NEW epoch is written", async () => {
    // The positive pair of case 4 at a number other than 1, so `got === required` cannot be a coincidence of the seed.
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 2);
    const out = await start(s, { engine_epoch: foldEpochOf(BADMINTON) });
    expect(out.seq).toBe(1);
    expect(foldEpochOf(BADMINTON)).toBe(realEpoch(BADMINTON) + 2);
  });

  it("3. a HIGHER engine_epoch is accepted and written (a phone ahead of the server; owner ruling 2026-10-15)", async () => {
    const s = await seed(BADMINTON);
    const out = await start(s, { engine_epoch: foldEpochOf(BADMINTON) + 1 });
    expect(out.seq).toBe(1);
    expect(await rows(s.fixtureId)).toBe(1);
  });

  it("4. a LOWER engine_epoch is refused 426 ENGINE_OUTDATED with { sport, required, got } and NO row is written", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const got = realEpoch(BADMINTON);
    const before = await rows(s.fixtureId);
    const err = await refusal(start(s, { engine_epoch: got }));
    expect(err.status).toBe(426);
    expect(err.code).toBe("ENGINE_OUTDATED");
    expect(err.extra).toEqual({ sport: BADMINTON, required: foldEpochOf(BADMINTON), got });
    expect(err.message).toContain(BADMINTON);
    expect(foldEpochOf(BADMINTON), "the bump made the phone genuinely behind").toBeGreaterThan(got);
    expect(await rows(s.fixtureId)).toBe(before);
  });

  it("4b. the wire body is { ok:false, error:{ code, message, sport, required, got }, requestId } at status 426", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const got = realEpoch(BADMINTON);
    const res = await v1(() => start(s, { engine_epoch: got }));
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      ok: false,
      error: {
        code: "ENGINE_OUTDATED",
        message: expect.any(String),
        sport: BADMINTON,
        required: foldEpochOf(BADMINTON),
        got,
      },
      requestId: expect.any(String),
    });
  });

  it("5. only the MOVED sport is refused: cricket is behind, badminton is not", async () => {
    bump.set("cricket", 1);
    const shuttle = await seed(BADMINTON);
    const ball = await seed("cricket");

    const ok = await start(shuttle, { engine_epoch: foldEpochOf(BADMINTON) });
    expect(ok.seq, "badminton at its own epoch is written").toBe(1);

    const err = await refusal(start(ball, { engine_epoch: realEpoch("cricket") }));
    expect(err.status).toBe(426);
    expect(err.extra).toEqual({ sport: "cricket", required: foldEpochOf("cricket"), got: realEpoch("cricket") });
    expect(await rows(ball.fixtureId)).toBe(0);

    // The positive pair on the SAME fixture: the refusal burned nothing, and cricket at its moved epoch is written.
    const after = await start(ball, { engine_epoch: foldEpochOf("cricket") });
    expect(after.seq).toBe(1);
  });

  it("6. the key is NOT burned: lower with key K → 426; the same K at the current epoch → 201 and exactly one row", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const key = `epoch-${randomUUID()}`;
    await refusal(start(s, { engine_epoch: realEpoch(BADMINTON), idempotency_key: key }));
    expect([...idemCache.store.keys()].filter((k) => k.includes(key)), "a refusal caches nothing under the key").toEqual([]);
    expect(await rows(s.fixtureId)).toBe(0);

    const out = await start(s, { engine_epoch: foldEpochOf(BADMINTON), idempotency_key: key });
    expect(out.seq).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${s.fixtureId} and idempotency_key = ${key}`;
    expect(n).toBe(1);
    expect(await rows(s.fixtureId)).toBe(1);
  });

  it("7. an ACCEPTED key whose epoch moved since still answers 201 with the ORIGINAL event — cache warm AND cache cold", async () => {
    const s = await seed(BADMINTON);
    const key = `epoch-${randomUUID()}`;
    const phoneEpoch = foldEpochOf(BADMINTON);
    const first = await start(s, { engine_epoch: phoneEpoch, idempotency_key: key });
    expect(first.seq).toBe(1);
    expect(idemCache.store.size, "premise: the first write warmed the fast path").toBeGreaterThan(0);

    // The epoch moves: the same phone is now BEHIND. A NEW write from it is refused — this is the control that makes the
    // two replays below non-vacuous (without it they would also pass if the gate were off).
    bump.set(BADMINTON, 1);
    await refusal(
      scoreEvent(s.auth, s.fixtureId, {
        expected_seq: 1,
        type: "core.note",
        payload: { text: "a new write from the now-outdated phone" },
        engine_epoch: phoneEpoch,
        idempotency_key: `epoch-${randomUUID()}`,
      }),
    );

    // WARM: the retry (same expected_seq, same key) is served by the cache before the gate is reached.
    const hits = idemCache.hits;
    const warm = await start(s, { engine_epoch: phoneEpoch, idempotency_key: key });
    expect(idemCache.hits, "the warm retry was answered from the cache").toBe(hits + 1);
    expect(warm).toEqual(first);

    // COLD: the cache is gone (TTL, Redis down, a restart). Only the durable lookup can answer, and it must run BEFORE the gate.
    idemCache.store.clear();
    const misses = idemCache.misses;
    const cold = await start(s, { engine_epoch: phoneEpoch, idempotency_key: key });
    expect(idemCache.misses, "the cold retry missed the cache").toBe(misses + 1);
    expect(cold).toEqual(first);
    expect(cold.event_id).toBe(first.event_id);
    expect(await rows(s.fixtureId), "one row: the retry wrote nothing").toBe(1);
  });

  it("8. a second call: two lower calls are two 426s and zero rows", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const a = await refusal(start(s, { engine_epoch: realEpoch(BADMINTON) }));
    const b = await refusal(start(s, { engine_epoch: realEpoch(BADMINTON) }));
    expect([a.status, b.status]).toEqual([426, 426]);
    expect(await rows(s.fixtureId)).toBe(0);
  });

  it("9. every sport: a lower epoch is refused for each, naming that sport, and the same phone at the moved epoch is written", async () => {
    let refused = 0;
    let written = 0;
    const checked = await forEachSportAsync(async ({ key }) => {
      const s = await seed(key);
      bump.clear();
      bump.set(key, 1);
      const got = realEpoch(key);
      const err = await refusal(start(s, { engine_epoch: got }));
      expect(err.status, key).toBe(426);
      expect(err.extra, key).toEqual({ sport: key, required: foldEpochOf(key), got });
      expect(await rows(s.fixtureId), key).toBe(0);
      refused++;
      const out = await start(s, { engine_epoch: foldEpochOf(key) });
      expect(out.seq, key).toBe(1);
      written++;
    });
    expect(checked, "the sweep visited every builtin sport").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    expect([refused, written]).toEqual([checked, checked]);
  }, 180_000);

  it("10. the withdrawal cascade passes no epoch and still writes, even when the sport's epoch has moved", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const before = await rows(s.fixtureId);
    const out = await withdrawEntrantCascade(s.auth, s.entrants[0]);
    expect(out.walkovers, "premise: the cascade walked a fixture over").toBeGreaterThan(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${s.fixtureId} and type = 'core.forfeit'`;
    expect(n, "the cascade's own scoreEvent call wrote the forfeit").toBe(1);
    expect(await rows(s.fixtureId)).toBeGreaterThan(before);
  }, 60_000);

  it("11. a core.void from an outdated phone is refused too; the same undo with no epoch is written", async () => {
    const s = await seed(BADMINTON);
    const started = await start(s);
    bump.set(BADMINTON, 1);
    const undo = (extra: Record<string, unknown>) =>
      scoreEvent(s.auth, s.fixtureId, { expected_seq: 1, type: "core.void", payload: { event_id: started.event_id }, ...extra });
    const err = await refusal(undo({ engine_epoch: realEpoch(BADMINTON) }));
    expect(err.status).toBe(426);
    expect(await rows(s.fixtureId), "the undo wrote nothing").toBe(1);
    const ok = await undo({});
    expect(ok.seq).toBe(2);
    expect(await rows(s.fixtureId)).toBe(2);
  });

  it("11b. the void gate sits BEFORE the undo-target checks: a behind phone's undo of a voided / missing / malformed target is a 426, not an UNDO_* 409", async () => {
    const s = await seed(BADMINTON);
    const started = await start(s);
    const voided = await scoreEvent(s.auth, s.fixtureId, {
      expected_seq: 1,
      type: "core.void",
      payload: { event_id: started.event_id },
    });
    expect(voided.seq, "premise: the target is already undone").toBe(2);
    bump.set(BADMINTON, 1);

    // [what the undo points at, the UNDO_* code the target check answers when it is reached]
    const targets: [string, unknown, string][] = [
      ["already voided", started.event_id, "UNDO_ALREADY_VOIDED"],
      ["missing", randomUUID(), "UNDO_TARGET_MISSING"],
      ["malformed", "not-a-uuid", "UNDO_NOOP"],
    ];
    let checked = 0;
    for (const [what, eventId, undoCode] of targets) {
      const undo = (extra: Record<string, unknown>) =>
        scoreEvent(s.auth, s.fixtureId, { expected_seq: 2, type: "core.void", payload: { event_id: eventId }, ...extra });
      // The control that makes the 426 below mean something: with no epoch the SAME undo reaches the target check and is refused by it.
      const control = await refusal(undo({}));
      expect([what, control.status, control.code], `${what}: control`).toEqual([what, 409, undoCode]);
      const behind = await refusal(undo({ engine_epoch: realEpoch(BADMINTON) }));
      expect([what, behind.status, behind.code], `${what}: behind phone`).toEqual([what, 426, "ENGINE_OUTDATED"]);
      checked++;
    }
    expect(checked, "every undo-target refusal was checked").toBe(targets.length);
    expect(checked).toBeGreaterThan(0);
    expect(await rows(s.fixtureId), "no undo wrote anything").toBe(2);
  });

  it("12. an unregistered sport is a typed MODULE_NOT_FOUND (422), never a plain Error / 500 from foldEpochOf", async () => {
    const s = await seed(BADMINTON);
    const key = `epoch-unknown-${randomUUID().slice(0, 8)}`;
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${key}, 'Unknown', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})`;
    try {
      await sql`update divisions set sport_key = ${key} where id = ${s.divisionId}`;
      // The premise: the real foldEpochOf would throw a PLAIN Error for this sport, which is what a server that asked it
      // before resolving the sport would surface as a 500.
      expect(() => foldEpochOf(key)).toThrow(/no FOLD_EPOCH for sport/);
      const res = await v1(() => start(s, { engine_epoch: 1 }));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("MODULE_NOT_FOUND");
      expect(await rows(s.fixtureId)).toBe(0);
    } finally {
      await sql`update divisions set sport_key = ${BADMINTON} where id = ${s.divisionId}`;
      await sql`delete from sports where key = ${key}`;
    }
  });

  // NOT a witness for the gate: with the gate deleted, appendEvent raises the same MODULE_NOT_FOUND for the same division, so this
  // passes either way (review 1f-1). Case 12 is the witness (the real foldEpochOf would throw a PLAIN Error there). Kept as a pin
  // of the door's behaviour for an unshipped pinned version, whoever raises it.
  it("12b. (appendEvent's own behaviour, not the gate's) a division pinned to an unshipped module version is MODULE_NOT_FOUND", async () => {
    const s = await seed(BADMINTON);
    await sql`update divisions set module_version = '0.0.0-unshipped' where id = ${s.divisionId}`;
    const err = await start(s, { engine_epoch: foldEpochOf(BADMINTON) }).catch((e: unknown) => e);
    expect(EngineError.is(err, "MODULE_NOT_FOUND")).toBe(true);
    expect(await rows(s.fixtureId)).toBe(0);
  });

  it("13. authorisation outranks the epoch: a device link refused for an organiser-only event gets 403, not 426", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const device: AuthCtx = { ...s.auth, via: "device_link", deviceLinkId: randomUUID() };
    const err = await refusal(
      scoreEvent(device, s.fixtureId, {
        expected_seq: 0,
        type: "core.abandon",
        payload: { reason: "rain" },
        engine_epoch: realEpoch(BADMINTON),
      }),
    );
    expect(err.status).toBe(403);
    expect(err.code).not.toBe("ENGINE_OUTDATED");
  });

  it("13b. the division phase outranks the epoch: a behind phone on a division not yet started gets WRONG_PHASE, not 426", async () => {
    const s = await seed(BADMINTON);
    const original = await sql<{ status: string }[]>`select status from divisions where id = ${s.divisionId}`;
    const startedStatus = original[0]!.status;
    bump.set(BADMINTON, 1);
    const behind = () => start(s, { engine_epoch: realEpoch(BADMINTON) }).catch((e: unknown) => e);
    // The positive pair: on the STARTED division the same behind write is the 426, so the refusals below are not the epoch gate being broken.
    const live = await behind();
    expect((live as HttpError).status, "premise: started division, behind phone").toBe(426);

    let checked = 0;
    for (const closed of ["setup", "scheduled"]) {
      expect(divisionScoringClosed(closed), `premise: ${closed} is a scoring-closed phase`).toBe(true);
      await sql`update divisions set status = ${closed} where id = ${s.divisionId}`;
      try {
        const noEpoch = await start(s).catch((e: unknown) => e);
        expect(EngineError.is(noEpoch, "WRONG_PHASE"), `${closed}: the control, with no epoch`).toBe(true);
        const err = await behind();
        expect(EngineError.is(err, "WRONG_PHASE"), `${closed}: a behind phone is told the division is closed, got ${String(err)}`).toBe(true);
        expect(err).not.toBeInstanceOf(HttpError);
        checked++;
      } finally {
        await sql`update divisions set status = ${startedStatus} where id = ${s.divisionId}`;
      }
    }
    expect(checked, "both scoring-closed phases were checked").toBe(2);
    expect(await rows(s.fixtureId)).toBe(0);
  });

  it("13c. a frozen (over-quota) competition outranks the epoch: a behind phone gets the 402 paywall, not 426", async () => {
    const s = await seed(BADMINTON);
    bump.set(BADMINTON, 1);
    const behind = () => refusal(start(s, { engine_epoch: realEpoch(BADMINTON) }));
    // The positive pair, BEFORE the freeze: the same behind write on the same fixture is the 426.
    expect((await behind()).status, "premise: not frozen, behind phone").toBe(426);

    // Over quota = a DOWNGRADE, so it is raw SQL (createCompetition enforces the quota itself): `limit` fillers created AFTER the
    // seeded competition, which has no events, make it the least recently active and so the one that freezes (event-import-freeze.test.ts).
    await setOrgPlan(s.auth.orgId, "community");
    await invalidateOrgEntitlements(s.auth.orgId);
    const limit = await getLimit(s.auth.orgId, "competitions.max_active");
    expect(limit, "premise: the community plan has a competitions ceiling").not.toBeNull();
    for (let i = 0; i < (limit as number); i++) {
      const suffix = randomUUID().slice(0, 8);
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${s.auth.orgId}, ${"Filler " + suffix}, ${"filler-" + suffix}, 'draft')`;
    }
    const control = await refusal(start(s));
    expect(control, "the control: with no epoch the frozen competition refuses").toBeInstanceOf(PaymentRequiredError);
    const err = await behind();
    expect(err, "a behind phone gets the freeze, not the epoch refusal").toBeInstanceOf(PaymentRequiredError);
    expect([err.status, err.code]).toEqual([402, control.code]);
    expect(await rows(s.fixtureId)).toBe(0);
  });

  it("13d. ledger-level refusals come AFTER the gate: a behind phone with a stale expected_seq is told to update (426), not SEQ_CONFLICT", async () => {
    const s = await seed(BADMINTON);
    await start(s);
    bump.set(BADMINTON, 1);
    const stale = (extra: Record<string, unknown>) =>
      scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {}, ...extra }).catch((e: unknown) => e);
    // The control: at the current epoch the same stale write reaches appendEvent and is refused by it.
    const control = await stale({ engine_epoch: foldEpochOf(BADMINTON) });
    expect(EngineError.is(control, "SEQ_CONFLICT"), `control, got ${String(control)}`).toBe(true);
    const behind = await stale({ engine_epoch: realEpoch(BADMINTON) });
    expect((behind as HttpError).status).toBe(426);
    expect(await rows(s.fixtureId)).toBe(1);
  });

  it("14. a fixture that does not exist answers appendEvent's own refusal, with or without an engine_epoch (no sport to compare)", async () => {
    const s = await seed(BADMINTON);
    const missing = randomUUID();
    const attempt = (extra: Record<string, unknown>) =>
      scoreEvent(s.auth, missing, { expected_seq: 0, type: "core.start", payload: {}, ...extra }).then(
        () => {
          throw new Error("a write to a fixture that does not exist was accepted");
        },
        (e: unknown) => e,
      );
    const without = await attempt({});
    const withEpoch = await attempt({ engine_epoch: 1 });
    expect(withEpoch, "not a TypeError from reading a sport that was never loaded").not.toBeInstanceOf(TypeError);
    expect(withEpoch).toBeInstanceOf(Error);
    expect([(withEpoch as Error).constructor.name, (withEpoch as Error).message]).toEqual([
      (without as Error).constructor.name,
      (without as Error).message,
    ]);
  });

  it("15. the durable replay is FIXTURE-scoped: a key accepted on fixture A never answers a behind phone's NEW write on fixture B", async () => {
    // Same seed, same org: seedBracket makes a fresh org per call and RLS would mask a cross-org probe (review 1f-1).
    const s = await seed(BADMINTON);
    const fixtureA = s.fixtureId;
    const fixtureB = s.fixtureIds[1];
    expect(fixtureB, "premise: the bracket seats a second fixture").toBeDefined();
    expect(fixtureB).not.toBe(fixtureA);
    const phoneEpoch = foldEpochOf(BADMINTON);
    const key = `epoch-${randomUUID()}`;

    const onA = await scoreEvent(s.auth, fixtureA, { expected_seq: 0, type: "core.start", payload: {}, engine_epoch: phoneEpoch, idempotency_key: key });
    expect(onA.seq).toBe(1);
    // B has a ledger of its own (a fixture with NO events makes the lookup's fold return null and hides a leaked row).
    await scoreEvent(s.auth, fixtureB!, { expected_seq: 0, type: "core.start", payload: {} });
    expect(await rows(fixtureB!), "premise: fixture B holds an event").toBe(1);

    bump.set(BADMINTON, 1);
    const err = await refusal(
      scoreEvent(s.auth, fixtureB!, {
        expected_seq: 1,
        type: "core.note",
        payload: { text: "a NEW write from the now-outdated phone, on the other fixture" },
        engine_epoch: phoneEpoch,
        idempotency_key: key,
      }),
    );
    expect(err.status, "a NEW write on B is refused; fixture A's event is not B's answer").toBe(426);
    expect(await rows(fixtureB!), "nothing was written to B").toBe(1);
    expect(await rows(fixtureA), "A is untouched").toBe(1);

    // The positive pair: the same key K at the current epoch IS a new write on B (the unique index is per fixture), and it is B's own event.
    const okB = await scoreEvent(s.auth, fixtureB!, {
      expected_seq: 1,
      type: "core.note",
      payload: { text: "the same key, on B, after the app updated" },
      engine_epoch: foldEpochOf(BADMINTON),
      idempotency_key: key,
    });
    expect(okB.seq).toBe(2);
    expect(okB.event_id).not.toBe(onA.event_id);
    expect(await rows(fixtureB!)).toBe(2);
  });
});
