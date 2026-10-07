// Capture QR v2 §5.1 / §6.1 (T5): the stable stream code over a REAL database — ensure, reissue, resolve, and the
// destination pre-pick (§6.7.3). The rules under test are the spec's, never this module's own constants:
//   - C1 / C1b: a code answers only when its tok verifies; an ENDED code still serves its open session's phone a `get`
//     and a `beat`, and nothing else; anything refused is 401 `code_ended` — unknown code and wrong tok alike, both
//     through ONE constant-time compare (the unknown one against the spec's dummy hash);
//   - C2: expiry is evaluated lazily and WRITTEN by the first evaluation that finds it due; an open session defers it;
//   - C3: reissue ends the old code at once; C4: no mint on a finished fixture, but a FINISHING code is re-shown;
//   - C5: a reverted result lets the organiser mint again; an expired code stays ended;
//   - §6.1 Mint: sealed BEFORE any write, so a missing RELAY_KEK writes nothing.
// This file never names the sealed tok column (enc-boundary claim 2 holds every file outside server/relay/** to that):
// the tamper case and "the sealed tok is wiped" live in server/relay/__tests__/stream-code-tok.test.ts (A5).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): a stream code never reads the fixture's sport — nothing in the module
// joins `sports` — so every rig rides `_rig`'s generic division.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Spies on the two crypto calls the rules are about, pass-through by default: `timingSafeEqual` (C1's one compare per
// resolve) and `randomInt` (the code draw, so the collision-retry case can force a draw).
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    default: actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
    randomInt: vi.fn(actual.randomInt as (max: number) => number),
  };
});
// Pass-through spies on the sealed-column writers: "sealed BEFORE any write" is observable only as "no writer was ever
// called" — a write inside a transaction that later throws rolls back, so a row count alone cannot see the order.
vi.mock("@/server/relay/secret-columns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/relay/secret-columns")>();
  return { ...actual, insertStreamCode: vi.fn(actual.insertStreamCode), wipeStreamCodeTok: vi.fn(actual.wipeStreamCodeTok) };
});

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { CaptureQrV2 } from "@/lib/capture-qr";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CODE_GRACE_AFTER_FINISH_MINUTES } from "@/server/relay/config";
import { insertStreamCode, wipeStreamCodeTok } from "@/server/relay/secret-columns";
import { rigTarget, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { createStreamTarget } from "../stream-targets";
import { deltaText, stripSqlComments } from "@/server/relay/__tests__/_stream-migration";
import { ensureStreamCode, fixtureStreamTarget, reissueStreamCode, resolveStreamCode, saveStreamSettings, writeStreamSettings } from "../stream-codes";
import { seedOrg } from "./_seed";
import { startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (secret-columns.test.ts precedent): CI supplies no RELAY_KEK. The developer's is put back
// afterwards, or removed when there was none — never assigned `undefined`, which Node stores as the string. Never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});
beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
  vi.mocked(insertStreamCode).mockClear();
  vi.mocked(wipeStreamCodeTok).mockClear();
});

/** The spec's alphabet (§6.1: lowercase Crockford base32) — typed from the spec, never imported from the module. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
/** The brief's dummy hash, computed here from its definition (never imported). */
const DUMMY = createHash("sha256").update("capture-dummy-tok", "utf8").digest();
const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const GRACE_MS = CODE_GRACE_AFTER_FINISH_MINUTES * 60_000;

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'stream codes')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

async function rig(opts: { relay?: boolean } = {}) {
  const { auth } = await seedOrg("pro");
  const d = await startedDivisionWithFixture(auth, { fixtures: 2 });
  await override(auth.orgId, "streaming.relay", opts.relay ?? true);
  return { auth, fixtureId: d.fixtureId, other: d.fixtureIds.find((f) => f !== d.fixtureId)! };
}

interface CodeRow {
  id: string; org_id: string; fixture_id: string; code: string; tok_hash: string; issued_by: string; created_at: Date;
  first_shown_at: Date | null; shown_count: number; ended_at: Date | null; end_cause: string | null; ended_by: string | null;
}
const codes = (fixtureId: string) => sql<CodeRow[]>`
  select id, org_id, fixture_id, code, tok_hash, issued_by, created_at, first_shown_at, shown_count, ended_at, end_cause, ended_by
    from fixture_stream_codes where fixture_id = ${fixtureId} order by created_at, id`;
const active = async (fixtureId: string) => (await codes(fixtureId)).filter((c) => c.ended_at === null);

/** Finish the fixture the way every writer does — by its status, which V430's trigger stamps. Returns the undo. */
async function finish(fixtureId: string): Promise<() => Promise<void>> {
  const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  await sql`update fixtures set status = 'cancelled' where id = ${fixtureId}`;
  return async () => { await sql`update fixtures set status = ${status} where id = ${fixtureId}`; };
}
/** Move the finish stamp into the past WITHOUT naming `status` (the trigger fires only on a status write). */
const finishedAgo = (fixtureId: string, ms: number) =>
  sql`update fixtures set finished_at = now() - ${`${ms} milliseconds`}::interval where id = ${fixtureId}`;

const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

/** Runs `body` with `vars` set (undefined deletes one), then puts each back exactly as it was — removed when it was
 *  absent, never assigned `undefined` (which Node stores as the string). */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  for (const [k, v] of Object.entries(vars)) put(k, v);
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) put(k, v);
  }
}

describe.skipIf(!HAS_DB)("stream codes — ensure (§6.1, C4)", () => {
  it("EMPTY first: a fixture with no code mints one — a v2 QR on slot 0 whose tok hashes to the row, shown once, the org written from the fixture's org, issued by the organiser", async () => {
    const r = await rig();
    expect(await codes(r.fixtureId)).toEqual([]);
    const shown = await ensureStreamCode(r.auth, r.fixtureId);
    expect(CaptureQrV2.parse(shown.qr)).toEqual(shown.qr);
    expect(shown.qr).toMatchObject({ v: 2, slot: 0 });
    expect(Object.keys(shown.qr).sort()).toEqual(["code", "slot", "tok", "v"]);   // A1: never `exp`
    const rows = await codes(r.fixtureId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.code).toBe(shown.qr.code);
    expect([...row!.code].every((c) => CROCKFORD.includes(c))).toBe(true);
    expect(row!.tok_hash).toBe(sha256Hex(shown.qr.tok));
    expect(row!).toMatchObject({ org_id: r.auth.orgId, issued_by: r.auth.userId, shown_count: 1, ended_at: null, end_cause: null });
    expect(row!.first_shown_at).toBeInstanceOf(Date);
    expect(shown.issuedAt).toBe(row!.created_at.toISOString());
  });

  it("a SECOND ensure re-shows the same code and tok — no new row, shown_count 2, first_shown_at kept; a THIRD makes 3", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    const [before] = await codes(r.fixtureId);
    const second = await ensureStreamCode(r.auth, r.fixtureId);
    expect(second).toEqual(first);
    let rows = await codes(r.fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shown_count).toBe(2);
    expect(rows[0]!.first_shown_at).toEqual(before!.first_shown_at);
    expect(vi.mocked(insertStreamCode)).toHaveBeenCalledTimes(1);   // the re-show wrote no code
    await ensureStreamCode(r.auth, r.fixtureId);
    rows = await codes(r.fixtureId);
    expect(rows.map((c) => c.shown_count)).toEqual([3]);
  });

  it("two fixtures hold two codes: an ensure on one never re-shows or ends the other's", async () => {
    const r = await rig();
    const a = await ensureStreamCode(r.auth, r.fixtureId);
    const b = await ensureStreamCode(r.auth, r.other);
    expect(b.qr.code).not.toBe(a.qr.code);
    expect((await active(r.fixtureId)).map((c) => c.code)).toEqual([a.qr.code]);
    expect((await active(r.other)).map((c) => c.code)).toEqual([b.qr.code]);
  });

  it("§6.1: a MISSING or MALFORMED RELAY_KEK is 503 RELAY_KEK_MISSING and writes NO row — no sealed-column writer is even called; the KEK back, the same call mints", async () => {
    const r = await rig();
    const saved = process.env.RELAY_KEK;
    let checked = 0;
    try {
      for (const kek of [undefined, "not-hex"] as const) {
        if (kek === undefined) delete process.env.RELAY_KEK;
        else process.env.RELAY_KEK = kek;
        const before = (await codes(r.fixtureId)).length;
        const err = await refusalOf(ensureStreamCode(r.auth, r.fixtureId));
        expect(err, `KEK ${kek ?? "unset"}`).toBeInstanceOf(HttpError);
        expect(err).toMatchObject({ status: 503, code: "RELAY_KEK_MISSING" });
        expect((await codes(r.fixtureId)).length).toBe(before);
        expect(before).toBe(0);
        checked++;
      }
    } finally {
      process.env.RELAY_KEK = saved;
    }
    expect(checked).toBe(2);
    expect(vi.mocked(insertStreamCode)).not.toHaveBeenCalled();
    expect(vi.mocked(wipeStreamCodeTok)).not.toHaveBeenCalled();
    await ensureStreamCode(r.auth, r.fixtureId);
    expect(await codes(r.fixtureId)).toHaveLength(1);
  });

  it("a missing KEK with a code ALREADY active is 503 too, and the re-show writes nothing (shown_count unchanged)", async () => {
    const r = await rig();
    await ensureStreamCode(r.auth, r.fixtureId);
    const saved = process.env.RELAY_KEK;
    try {
      delete process.env.RELAY_KEK;
      expect(await refusalOf(ensureStreamCode(r.auth, r.fixtureId))).toMatchObject({ status: 503, code: "RELAY_KEK_MISSING" });
    } finally {
      process.env.RELAY_KEK = saved;
    }
    expect((await codes(r.fixtureId)).map((c) => c.shown_count)).toEqual([1]);
  });

  it("C4: a finished fixture with no code refuses the mint — 422 fixture_finished, no row", async () => {
    const r = await rig();
    await finish(r.fixtureId);
    expect(await refusalOf(ensureStreamCode(r.auth, r.fixtureId))).toMatchObject({ status: 422, code: "fixture_finished" });
    expect(await codes(r.fixtureId)).toEqual([]);
    expect(vi.mocked(insertStreamCode)).not.toHaveBeenCalled();
  });

  it("C4 + C2 + C5 in SEQUENCE: an ACTIVE·FINISHING code inside the grace is re-shown; one ms past the grace (no open session) the ensure WRITES the expiry and refuses 422; the result reverted, the organiser mints a NEW code and the expired one stays ended", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    const undo = await finish(r.fixtureId);
    // Inside the grace: re-shown, same code.
    await finishedAgo(r.fixtureId, GRACE_MS - 60_000);
    expect((await ensureStreamCode(r.auth, r.fixtureId)).qr).toEqual(first.qr);
    // Past it: the evaluation that finds it due writes ENDED(expired) — and COMMITS it — then C4 refuses the mint.
    await finishedAgo(r.fixtureId, GRACE_MS + 1_000);
    expect(await refusalOf(ensureStreamCode(r.auth, r.fixtureId))).toMatchObject({ status: 422, code: "fixture_finished" });
    let rows = await codes(r.fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ end_cause: "expired", ended_by: null });
    expect(rows[0]!.ended_at).toBeInstanceOf(Date);
    // C5: the result reverted clears finished_at; the expired code stays ended and a NEW one is minted.
    await undo();
    const minted = await ensureStreamCode(r.auth, r.fixtureId);
    expect(minted.qr.code).not.toBe(first.qr.code);
    rows = await codes(r.fixtureId);
    expect(rows.map((c) => c.end_cause)).toEqual(["expired", null]);
  });

  it("C2: an OPEN session defers the expiry — past the grace the code is still FINISHING and re-shown, never ended", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    await sessionOnTarget(r.auth.orgId, r.fixtureId, await rigTarget(r.auth.orgId), "live");
    await finish(r.fixtureId);
    await finishedAgo(r.fixtureId, GRACE_MS * 3);
    expect((await ensureStreamCode(r.auth, r.fixtureId)).qr).toEqual(first.qr);
    expect((await codes(r.fixtureId)).map((c) => c.end_cause)).toEqual([null]);
  });

  it("who: an API key and a signed-out caller are 403, another org's fixture is 404, an org without streaming.relay is 402 — and none writes a row", async () => {
    const r = await rig();
    const key = { ...r.auth, via: "api_key" as const, userId: null, keyId: randomUUID() };
    const link = { ...r.auth, via: "device_link" as const };
    const anon = { ...r.auth, userId: null };
    let checked = 0;
    for (const [label, auth] of [["api key", key], ["device link", link], ["no user", anon]] as const) {
      for (const call of [ensureStreamCode, reissueStreamCode]) {
        expect(await refusalOf(call(auth, r.fixtureId)), label).toMatchObject({ status: 403 });
        checked++;
      }
    }
    const foreign = await rig();
    for (const call of [ensureStreamCode, reissueStreamCode]) {
      expect(await refusalOf(call(r.auth, foreign.fixtureId))).toMatchObject({ status: 404 });
      checked++;
    }
    const unpaid = await rig({ relay: false });
    for (const call of [ensureStreamCode, reissueStreamCode]) {
      const err = await refusalOf(call(unpaid.auth, unpaid.fixtureId));
      expect(err).toBeInstanceOf(PaymentRequiredError);
      expect(err).toMatchObject({ status: 402, featureKey: "streaming.relay" });
      checked++;
    }
    expect(checked).toBe(10);
    for (const f of [r.fixtureId, foreign.fixtureId, unpaid.fixtureId]) expect(await codes(f)).toEqual([]);
  });

  it("a drawn code that COLLIDES with another fixture's is redrawn — at most 3 retries; a 4th collision is the database's refusal", async () => {
    const r = await rig();
    const spent = await rig();   // seeded BEFORE the draws are forced, so its own setup draws nothing forced
    const taken = (await ensureStreamCode(r.auth, r.other)).qr.code;
    const real = (max: number) => Math.floor(Math.random() * max);
    const draws = (n: number) => {
      const seq = Array.from({ length: n }, () => [...taken].map((c) => CROCKFORD.indexOf(c))).flat();
      vi.mocked(randomInt).mockImplementation(((max: number) => (seq.length > 0 ? seq.shift()! : real(max))) as never);
    };
    try {
      vi.mocked(insertStreamCode).mockClear();
      draws(3);   // three colliding draws, then a free one
      const shown = await ensureStreamCode(r.auth, r.fixtureId);
      expect(shown.qr.code).not.toBe(taken);
      expect(vi.mocked(insertStreamCode)).toHaveBeenCalledTimes(4);   // 3 collisions + the one that lands
      expect(await active(r.fixtureId)).toHaveLength(1);
      vi.mocked(insertStreamCode).mockClear();
      draws(4);   // four colliding draws: the three retries are spent and the 4th collision is the answer
      const err = await refusalOf(ensureStreamCode(spent.auth, spent.fixtureId));
      expect(err).toMatchObject({ code: "23505", constraint_name: "fixture_stream_codes_code_key" });
      expect(vi.mocked(insertStreamCode)).toHaveBeenCalledTimes(4);
      expect(await codes(spent.fixtureId)).toEqual([]);
    } finally {
      vi.mocked(randomInt).mockImplementation((await vi.importActual<typeof import("node:crypto")>("node:crypto")).randomInt as never);
    }
  });
});

describe.skipIf(!HAS_DB)("stream codes — reissue (C3)", () => {
  it("EMPTY: a reissue with no code at all mints one and ends nothing", async () => {
    const r = await rig();
    const shown = await reissueStreamCode(r.auth, r.fixtureId);
    expect(await codes(r.fixtureId)).toHaveLength(1);
    expect(vi.mocked(wipeStreamCodeTok)).not.toHaveBeenCalled();
    expect((await codes(r.fixtureId))[0]!.code).toBe(shown.qr.code);
  });

  it("reissue AFTER reissue: each ends the code before it as ENDED(reissued) by the organiser and mints a different one; exactly one is active; the old toks no longer resolve", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    const second = await reissueStreamCode(r.auth, r.fixtureId);
    const third = await reissueStreamCode(r.auth, r.fixtureId);
    const all = [first, second, third];
    expect(new Set(all.map((s) => s.qr.code)).size).toBe(3);
    expect(new Set(all.map((s) => s.qr.tok)).size).toBe(3);
    const rows = await codes(r.fixtureId);
    expect(rows.map((c) => [c.code, c.end_cause, c.ended_by])).toEqual([
      [first.qr.code, "reissued", r.auth.userId],
      [second.qr.code, "reissued", r.auth.userId],
      [third.qr.code, null, null],
    ]);
    expect(await active(r.fixtureId)).toHaveLength(1);
    const now = new Date();
    let checked = 0;
    for (const old of [first, second]) {
      expect(await refusalOf(resolveStreamCode(old.qr.code, old.qr.tok, "get", null, now))).toMatchObject({ status: 401, code: "code_ended" });
      checked++;
    }
    expect(checked).toBe(2);
    expect(await resolveStreamCode(third.qr.code, third.qr.tok, "get", null, now)).toMatchObject({ status: "active" });
    // The next ensure re-shows the reissued code — never the ended one.
    expect((await ensureStreamCode(r.auth, r.fixtureId)).qr).toEqual(third.qr);
  });

  it("reissue with a MISSING KEK is 503 and the old code stays ACTIVE — no writer called (sealed before the old code is ended)", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    vi.mocked(insertStreamCode).mockClear();
    const saved = process.env.RELAY_KEK;
    try {
      delete process.env.RELAY_KEK;
      expect(await refusalOf(reissueStreamCode(r.auth, r.fixtureId))).toMatchObject({ status: 503, code: "RELAY_KEK_MISSING" });
    } finally {
      process.env.RELAY_KEK = saved;
    }
    expect(vi.mocked(wipeStreamCodeTok)).not.toHaveBeenCalled();
    expect(vi.mocked(insertStreamCode)).not.toHaveBeenCalled();
    expect((await active(r.fixtureId)).map((c) => c.code)).toEqual([first.qr.code]);
  });

  it("C4: a reissue on a finished fixture is 422 fixture_finished and the code it would have ended is untouched", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    await finish(r.fixtureId);
    expect(await refusalOf(reissueStreamCode(r.auth, r.fixtureId))).toMatchObject({ status: 422, code: "fixture_finished" });
    expect((await active(r.fixtureId)).map((c) => c.code)).toEqual([first.qr.code]);
  });

  it("CONCURRENCY: two ensures at once on a code-less fixture, both staged behind the fixture's lock, leave exactly ONE active code and both answers show it", async () => {
    const r = await rig();
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let staged!: () => void;
    const isStaged = new Promise<void>((res) => (staged = res));
    // The holder takes the SAME advisory lock the module names in §6.1 (`stream_code:{fixtureId}`).
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"stream_code:" + r.fixtureId}))`;
      staged();
      await held;
    });
    holder.catch(() => {});
    await isStaged;
    const racing = Promise.all([ensureStreamCode(r.auth, r.fixtureId), ensureStreamCode(r.auth, r.fixtureId)]);
    racing.catch(() => {});
    await waitForBlockedLocks(2);
    release();
    await holder;
    const [a, b] = await racing;
    expect(a.qr).toEqual(b.qr);
    const rows = await codes(r.fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shown_count).toBe(2);
  });
});

/** Poll pg_locks for REAL blocked waiters (registration-concurrency.test.ts's technique) rather than a guessed sleep. */
async function waitForBlockedLocks(count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where not granted`;
    if (row!.n >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${row!.n}/${count} blocked locks appeared — race not staged`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe.skipIf(!HAS_DB)("stream codes — resolve (C1, C1b, C2)", () => {
  it("a MALFORMED code is 404 not_a_stream_code before any query (statementCount unchanged) and before any compare", async () => {
    let checked = 0;
    for (const raw of ["", "short", "0123456789ab0", "0123456789ai", "0123456789a!"]) {
      const q = statementCount();
      const err = await refusalOf(resolveStreamCode(raw, "x".repeat(22), "get", null, new Date()));
      expect(err, JSON.stringify(raw)).toBeInstanceOf(CaptureRefusalError);
      expect(err).toMatchObject({ status: 404, code: "not_a_stream_code" });
      expect(statementCount() - q, JSON.stringify(raw)).toBe(0);
      checked++;
    }
    expect(checked).toBe(5);
    expect(vi.mocked(timingSafeEqual)).not.toHaveBeenCalled();
  });

  it("normaliseCode runs FIRST (Review Focus 1): the code upper-cased and padded with whitespace resolves to the same row", async () => {
    const r = await rig();
    const { qr } = await ensureStreamCode(r.auth, r.fixtureId);
    const resolved = await resolveStreamCode(`  ${qr.code.toUpperCase()}\n`, qr.tok, "get", null, new Date());
    expect(resolved.codeId).toBe((await codes(r.fixtureId))[0]!.id);
  });

  it("C1: the right tok resolves {codeId, orgId, fixtureId, status, issuedBy} from the CODE ROW; a wrong tok and an unknown code are both 401 code_ended — and each of the three runs timingSafeEqual exactly once, the unknown code against the dummy hash", async () => {
    const r = await rig();
    const { qr } = await ensureStreamCode(r.auth, r.fixtureId);
    const [row] = await codes(r.fixtureId);
    const now = new Date();
    const calls = () => vi.mocked(timingSafeEqual).mock.calls as unknown as [Buffer, Buffer][];

    vi.mocked(timingSafeEqual).mockClear();
    expect(await resolveStreamCode(qr.code, qr.tok, "claim", "phone-0123456789abcdef", now)).toEqual({
      codeId: row!.id, orgId: r.auth.orgId, fixtureId: r.fixtureId, status: "active", issuedBy: r.auth.userId,
    });
    expect(calls()).toHaveLength(1);
    expect(Buffer.from(calls()[0]![1]).toString("hex")).toBe(row!.tok_hash);

    vi.mocked(timingSafeEqual).mockClear();
    const wrongTok = randomBytes(16).toString("base64url");
    expect(await refusalOf(resolveStreamCode(qr.code, wrongTok, "get", null, now))).toMatchObject({ status: 401, code: "code_ended" });
    expect(calls()).toHaveLength(1);
    expect(Buffer.from(calls()[0]![0]).toString("hex")).toBe(sha256Hex(wrongTok));

    vi.mocked(timingSafeEqual).mockClear();
    // An unknown code of the right shape — drawn until it is not this test's own.
    let unknown = qr.code;
    while (unknown === qr.code) unknown = Array.from({ length: 12 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("");
    const err = await refusalOf(resolveStreamCode(unknown, qr.tok, "get", null, now));
    expect(err).toBeInstanceOf(CaptureRefusalError);
    expect(err).toMatchObject({ status: 401, code: "code_ended" });
    expect(calls()).toHaveLength(1);
    expect(Buffer.from(calls()[0]![1]).equals(DUMMY)).toBe(true);
    expect(Buffer.from(calls()[0]![0]).toString("hex")).toBe(sha256Hex(qr.tok));
  });

  it("C1b / C3: a REISSUED code serves its open session's phone a get and a beat — and refuses that phone a claim and a start, another phone anything, and a caller with no phone (401 code_ended)", async () => {
    const r = await rig();
    const old = await ensureStreamCode(r.auth, r.fixtureId);
    const [oldRow] = await codes(r.fixtureId);
    const phone = `phone-${randomUUID()}`;
    const sessionId = await sessionOnTarget(r.auth.orgId, r.fixtureId, await rigTarget(r.auth.orgId), "live");
    await pairSession(r.auth.orgId, oldRow!.id, sessionId, phone);
    await reissueStreamCode(r.auth, r.fixtureId);
    const now = new Date();
    const verdicts: [string, string | null, string][] = [];
    for (const call of ["get", "beat", "claim", "start"] as const) {
      for (const who of [phone, `phone-${randomUUID()}`, null]) {
        const out = await resolveStreamCode(old.qr.code, old.qr.tok, call, who, now).then(
          (v) => `served:${v.status}`, (e: { status?: number; code?: string }) => `${e.status}:${e.code}`);
        verdicts.push([call, who === phone ? "own" : who === null ? "none" : "other", out]);
      }
    }
    expect(verdicts).toEqual([
      ["get", "own", "served:ended"], ["get", "other", "401:code_ended"], ["get", "none", "401:code_ended"],
      ["beat", "own", "served:ended"], ["beat", "other", "401:code_ended"], ["beat", "none", "401:code_ended"],
      ["claim", "own", "401:code_ended"], ["claim", "other", "401:code_ended"], ["claim", "none", "401:code_ended"],
      ["start", "own", "401:code_ended"], ["start", "other", "401:code_ended"], ["start", "none", "401:code_ended"],
    ]);
  });

  it("C1b: a session created AFTER the code ended is not that code's — its phone is refused even a get; and once the session ends, the old code's own phone is refused too", async () => {
    const r = await rig();
    const old = await ensureStreamCode(r.auth, r.fixtureId);
    const [oldRow] = await codes(r.fixtureId);
    await reissueStreamCode(r.auth, r.fixtureId);
    const phone = `phone-${randomUUID()}`;
    const late = await sessionOnTarget(r.auth.orgId, r.fixtureId, await rigTarget(r.auth.orgId), "live");
    await pairSession(r.auth.orgId, oldRow!.id, late, phone);
    expect(await refusalOf(resolveStreamCode(old.qr.code, old.qr.tok, "get", phone, new Date()))).toMatchObject({ status: 401, code: "code_ended" });
    // Its positive pair: the same phone on a session created BEFORE the end is served — then the session completes.
    const r2 = await rig();
    const old2 = await ensureStreamCode(r2.auth, r2.fixtureId);
    const [old2Row] = await codes(r2.fixtureId);
    const s2 = await sessionOnTarget(r2.auth.orgId, r2.fixtureId, await rigTarget(r2.auth.orgId), "live");
    await pairSession(r2.auth.orgId, old2Row!.id, s2, phone);
    await reissueStreamCode(r2.auth, r2.fixtureId);
    expect(await resolveStreamCode(old2.qr.code, old2.qr.tok, "beat", phone, new Date())).toMatchObject({ status: "ended" });
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${s2}`;
    expect(await refusalOf(resolveStreamCode(old2.qr.code, old2.qr.tok, "beat", phone, new Date()))).toMatchObject({ status: 401, code: "code_ended" });
  });

  it("C2: expiry is WRITTEN lazily by the first resolve that finds it due — that call is 401 and the row is ENDED(expired); the next resolve finds it already ended (no second write); one ms inside the grace it was still served as finishing", async () => {
    const r = await rig();
    const { qr } = await ensureStreamCode(r.auth, r.fixtureId);
    await finish(r.fixtureId);
    const [{ finished_at }] = await sql<{ finished_at: Date }[]>`select finished_at from fixtures where id = ${r.fixtureId}`;
    const inside = new Date(finished_at.getTime() + GRACE_MS - 1);
    expect(await resolveStreamCode(qr.code, qr.tok, "get", null, inside)).toMatchObject({ status: "finishing" });
    expect((await codes(r.fixtureId))[0]!.ended_at).toBeNull();
    vi.mocked(wipeStreamCodeTok).mockClear();
    const due = new Date(finished_at.getTime() + GRACE_MS);
    expect(await refusalOf(resolveStreamCode(qr.code, qr.tok, "get", null, due))).toMatchObject({ status: 401, code: "code_ended" });
    expect(vi.mocked(wipeStreamCodeTok)).toHaveBeenCalledTimes(1);
    const [row] = await codes(r.fixtureId);
    expect(row).toMatchObject({ end_cause: "expired", ended_by: null });
    const endedAt = row!.ended_at;
    expect(endedAt).toBeInstanceOf(Date);
    expect(await refusalOf(resolveStreamCode(qr.code, qr.tok, "get", null, due))).toMatchObject({ status: 401, code: "code_ended" });
    expect(vi.mocked(wipeStreamCodeTok)).toHaveBeenCalledTimes(1);
    expect((await codes(r.fixtureId))[0]!.ended_at).toEqual(endedAt);
  });

  it("§6.15 (D1): CODE_GRACE_AFTER_FINISH_MINUTES is the grace resolve AND ensure read — under ENV_NAME=ci a SHORTENED grace ends the code at its own boundary, well inside the default; with the variable unset the same instant is still finishing (the positive pair)", async () => {
    const SHORT_MINUTES = 10;
    expect(SHORT_MINUTES, "the shortened grace sits inside the default one").toBeLessThan(CODE_GRACE_AFTER_FINISH_MINUTES);
    const shortened = { ENV_NAME: "ci", CODE_GRACE_AFTER_FINISH_MINUTES: String(SHORT_MINUTES) };
    const unset = { CODE_GRACE_AFTER_FINISH_MINUTES: undefined };
    const r = await rig();
    // resolve: on the caller's clock, exactly at the shortened boundary.
    const { qr } = await ensureStreamCode(r.auth, r.fixtureId);
    await finish(r.fixtureId);
    const [{ finished_at }] = await sql<{ finished_at: Date }[]>`select finished_at from fixtures where id = ${r.fixtureId}`;
    const due = new Date(finished_at.getTime() + SHORT_MINUTES * 60_000);
    await withEnv(unset, async () => {
      expect(await resolveStreamCode(qr.code, qr.tok, "get", null, due)).toMatchObject({ status: "finishing" });
    });
    await withEnv(shortened, async () => {
      expect(await resolveStreamCode(qr.code, qr.tok, "get", null, new Date(due.getTime() - 1))).toMatchObject({ status: "finishing" });
      expect(await refusalOf(resolveStreamCode(qr.code, qr.tok, "get", null, due))).toMatchObject({ status: 401, code: "code_ended" });
    });
    expect((await codes(r.fixtureId))[0]).toMatchObject({ end_cause: "expired" });
    // ensure: on the wall clock, a minute past the shortened boundary.
    const shown = await ensureStreamCode(r.auth, r.other);
    await finish(r.other);
    await finishedAgo(r.other, (SHORT_MINUTES + 1) * 60_000);
    await withEnv(unset, async () => {
      expect(await ensureStreamCode(r.auth, r.other), "re-shown: still finishing").toEqual(shown);
    });
    await withEnv(shortened, async () => {
      expect(await refusalOf(ensureStreamCode(r.auth, r.other))).toMatchObject({ status: 422, code: "fixture_finished" });
    });
    expect((await codes(r.other))[0]).toMatchObject({ end_cause: "expired" });
  });

  it("C2: an open session DEFERS the expiry on resolve too — past the grace the code is finishing and served", async () => {
    const r = await rig();
    const { qr } = await ensureStreamCode(r.auth, r.fixtureId);
    await sessionOnTarget(r.auth.orgId, r.fixtureId, await rigTarget(r.auth.orgId), "warming");
    await finish(r.fixtureId);
    const far = new Date(Date.now() + GRACE_MS * 10);
    expect(await resolveStreamCode(qr.code, qr.tok, "claim", null, far)).toMatchObject({ status: "finishing" });
    expect((await codes(r.fixtureId))[0]!.ended_at).toBeNull();
  });
});

/** The phone of a session (T8b's claim writes this for real; here only the READ of "the open session's phone" is under
 *  test): a current pairing on `codeId`'s slot 0, named on the session. */
async function pairSession(orgId: string, codeId: string, sessionId: string, phone: string): Promise<void> {
  const [p] = await sql<{ id: string }[]>`
    insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
    values (${orgId}, ${codeId}, 0, ${phone}, 'new', now(), now(), 60) returning id`;
  await sql`update fixture_stream_sessions set code_id = ${codeId}, pairing_id = ${p!.id} where id = ${sessionId}`;
}

describe.skipIf(!HAS_DB)("stream settings — the destination pre-pick (§6.7.3)", () => {
  const settingsOf = async (fixtureId: string) =>
    (await sql<{ target_id: string | null; org_id: string; updated_by: string | null }[]>`
      select target_id, org_id, updated_by from fixture_stream_settings where fixture_id = ${fixtureId}`)[0] ?? null;

  it("EMPTY: no settings row until the first save; a save writes the org's own live target, a second save replaces it, null clears it", async () => {
    const r = await rig();
    expect(await settingsOf(r.fixtureId)).toBeNull();
    const t1 = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Court 1", streamKey: `k-${randomUUID().slice(0, 8)}` });
    const t2 = await createStreamTarget(r.auth, r.auth.orgId, { kind: "twitch", label: "Court 2", streamKey: `k-${randomUUID().slice(0, 8)}` });
    expect(await saveStreamSettings(r.auth, r.fixtureId, { targetId: t1.id })).toEqual({ targetId: t1.id });
    expect(await settingsOf(r.fixtureId)).toEqual({ target_id: t1.id, org_id: r.auth.orgId, updated_by: r.auth.userId });
    expect(await saveStreamSettings(r.auth, r.fixtureId, { targetId: t2.id })).toEqual({ targetId: t2.id });
    expect((await settingsOf(r.fixtureId))!.target_id).toBe(t2.id);
    expect(await saveStreamSettings(r.auth, r.fixtureId, { targetId: null })).toEqual({ targetId: null });
    expect((await settingsOf(r.fixtureId))!.target_id).toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect(n).toBe(1);
  });

  it("another org's target, an ARCHIVED target, an unknown id and another org's fixture are all 404 — and the saved pick is untouched", async () => {
    const r = await rig();
    const mine = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Mine", streamKey: `k-${randomUUID().slice(0, 8)}` });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: mine.id });
    const foreign = await rig();
    const theirs = await createStreamTarget(foreign.auth, foreign.auth.orgId, { kind: "youtube", label: "Theirs", streamKey: `k-${randomUUID().slice(0, 8)}` });
    const archived = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Gone", streamKey: `k-${randomUUID().slice(0, 8)}` });
    await sql`update org_stream_targets set archived_at = now() where id = ${archived.id}`;
    let checked = 0;
    for (const [label, fixtureId, targetId] of [
      ["another org's target", r.fixtureId, theirs.id], ["an archived target", r.fixtureId, archived.id],
      ["an unknown id", r.fixtureId, randomUUID()], ["another org's fixture", foreign.fixtureId, mine.id],
    ] as const) {
      expect(await refusalOf(saveStreamSettings(r.auth, fixtureId, { targetId })), label).toMatchObject({ status: 404 });
      checked++;
    }
    expect(checked).toBe(4);
    expect(await settingsOf(r.fixtureId)).toMatchObject({ target_id: mine.id });
    expect(await settingsOf(foreign.fixtureId)).toBeNull();
  });

  it("an API key is 403 on the settings write too", async () => {
    const r = await rig();
    const key = { ...r.auth, via: "api_key" as const, userId: null, keyId: randomUUID() };
    expect(await refusalOf(saveStreamSettings(key, r.fixtureId, { targetId: null }))).toMatchObject({ status: 403 });
    expect(await settingsOf(r.fixtureId)).toBeNull();
  });
});

// Plan R-1 (FP1, owner-accepted 2026-10-07). V430 read "a settings row exists" as "the organiser chose a destination", and
// `target_id` null as "the organiser cleared it". PR-2's switch (and the A12 Stop stamp) creates rows that chose NOTHING,
// so V431 adds `target_chosen`: only a destination write sets it, and `fixtureStreamTarget` reads THAT, not the row.
describe.skipIf(!HAS_DB)("stream settings — a row records whether the organiser CHOSE a destination (plan R-1, V431)", () => {
  const dest = (r: Awaited<ReturnType<typeof rig>>, label: string) =>
    createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label, streamKey: `k-${randomUUID().slice(0, 8)}` });
  const pickOf = (r: Awaited<ReturnType<typeof rig>>) => fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId: r.fixtureId });
  const rowOf = async (fixtureId: string) =>
    (await sql<{ target_chosen: boolean; target_id: string | null }[]>`
      select target_chosen, target_id from fixture_stream_settings where fixture_id = ${fixtureId}`)[0] ?? null;
  /** A row the switch (or the A12 Stop stamp) would create: a fixture and an org, and NO destination write. */
  const switchRow = (r: Awaited<ReturnType<typeof rig>>) =>
    sql`insert into fixture_stream_settings (fixture_id, org_id) values (${r.fixtureId}, ${r.auth.orgId})`;
  /** V431's OWN backfill statement, read out of the migration text and scoped to one fixture: a shared test database's
   *  other rows are not rewritten, and a migration without the statement fails here by name. */
  async function runBackfill(fixtureId: string): Promise<void> {
    // The whole statement up to its `;`, so a WHERE added to it (a backfill that skips the cleared rows) is not hidden by the
    // scoping below: it no longer matches, and the extraction fails by name.
    const stmt = /update fixture_stream_settings set target_chosen = true(?=\s*;)/.exec(stripSqlComments(deltaText(431)))?.[0];
    expect(stmt, "V431 carries an UNCONDITIONAL target_chosen backfill").toBeDefined();
    await sql.unsafe(`${stmt} where fixture_id = $1`, [fixtureId]);
  }
  /** Two live destinations; the OLDEST is `old` (the default), `fresh` is the newer — so "default" and "saved fresh" differ. */
  async function twoDestinations(r: Awaited<ReturnType<typeof rig>>) {
    const old = await dest(r, "Old feed");
    const fresh = await dest(r, "Fresh feed");
    await sql`update org_stream_targets set created_at = now() - interval '3 hours' where id = ${old.id}`;
    await sql`update org_stream_targets set created_at = now() - interval '1 hour' where id = ${fresh.id}`;
    return { old, fresh };
  }

  it("a settings row that never chose a destination still resolves the org's oldest live destination (the empty-row case, R-1)", async () => {
    const r = await rig();
    const { old } = await twoDestinations(r);
    expect(await pickOf(r), "no row at all: the default").toMatchObject({ id: old.id, source: "default" });
    await switchRow(r);
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: false, target_id: null });
    expect(await pickOf(r), "a row that chose nothing: still the default, exactly as before the toggle").toMatchObject({ id: old.id, label: "Old feed", source: "default" });
  });

  it("a chosen null (the organiser cleared it) still resolves none — the same org, the same destinations, only the flag differs (positive pair)", async () => {
    const r = await rig();
    await twoDestinations(r);
    await sql.begin((tx) => writeStreamSettings(tx, { orgId: r.auth.orgId, fixtureId: r.fixtureId, targetId: null, updatedBy: null }));
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: null });
    expect(await pickOf(r)).toBeNull();
  });

  it("the SEQUENCE: switch row (default) → pick the newer (saved) → clear (none) → pick again (saved); every destination write records the choice, a second write too", async () => {
    const r = await rig();
    const { old, fresh } = await twoDestinations(r);
    await switchRow(r);
    expect(await pickOf(r)).toMatchObject({ id: old.id, source: "default" });
    const pick = (targetId: string | null) => sql.begin((tx) => writeStreamSettings(tx, { orgId: r.auth.orgId, fixtureId: r.fixtureId, targetId, updatedBy: r.auth.userId }));
    await pick(fresh.id);
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: fresh.id });
    expect(await pickOf(r)).toMatchObject({ id: fresh.id, source: "saved" });   // differs from the default's answer
    await pick(null);
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: null });
    expect(await pickOf(r)).toBeNull();
    await pick(fresh.id);
    await pick(fresh.id);   // a second identical write: still chosen, still saved
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: fresh.id });
    expect(await pickOf(r)).toMatchObject({ id: fresh.id, source: "saved" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect(n).toBe(1);
  });

  it("saveStreamSettings (the organiser's PUT) records the choice too — through the real entry point, not only the writer", async () => {
    const r = await rig();
    const { fresh } = await twoDestinations(r);
    await switchRow(r);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: fresh.id });
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: fresh.id });
    expect(await pickOf(r)).toMatchObject({ id: fresh.id, source: "saved" });
  });

  it("a V430-shaped row (a destination WAS picked, target_chosen is the column default) reads as chosen only after V431's backfill — saved, not the default", async () => {
    const r = await rig();
    const { old, fresh } = await twoDestinations(r);
    // What V430's writer left behind: target_id set. The V431 column default (false) is what a pre-V431 row has before the backfill.
    await sql`insert into fixture_stream_settings (fixture_id, org_id, target_id) values (${r.fixtureId}, ${r.auth.orgId}, ${fresh.id})`;
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: false, target_id: fresh.id });
    expect(await pickOf(r), "before the backfill the pick is not seen").toMatchObject({ id: old.id, source: "default" });
    await runBackfill(r.fixtureId);
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: fresh.id });
    expect(await pickOf(r), "after the backfill the saved pick stands").toMatchObject({ id: fresh.id, source: "saved" });
  });

  it("a V430-shaped CLEARED row (target_id null, written by a destination write) stays cleared after the backfill — none, never the default", async () => {
    const r = await rig();
    await twoDestinations(r);
    await sql`insert into fixture_stream_settings (fixture_id, org_id, target_id) values (${r.fixtureId}, ${r.auth.orgId}, ${null})`;
    expect(await pickOf(r), "before the backfill it reads as unchosen").not.toBeNull();
    await runBackfill(r.fixtureId);
    expect(await rowOf(r.fixtureId)).toEqual({ target_chosen: true, target_id: null });
    expect(await pickOf(r)).toBeNull();
  });
});
