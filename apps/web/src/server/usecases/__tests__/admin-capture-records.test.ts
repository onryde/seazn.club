// Capture record upload §10 (P7, Q5): the staff reads behind /admin/capture-records?ref= and /admin/fixtures?id=. The
// records are produced by the REAL `postCaptureRecord` (never inserted by hand), so the read is proven against what the
// write path actually stores.
//
// Review fix 3 (PR #943): a Next layout does not gate its segments, so each read asks for staff itself. The session is
// the REAL one — createSession signs it into a cookie jar standing in for next/headers, and requireStaff reads it back.
//
// ONE SPORT, on purpose: not applicable — the capture surface reads no sport.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
  headers: async () => new Headers(),
}));

import { createSession } from "@/lib/auth";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import { tokenTag } from "@/server/relay/domain/capture-record";
import { captureRecordByRef, captureRecordsOfFixture, normaliseRecordRef } from "../admin-capture-records";
import { postCaptureRecord } from "../capture-record";
import { captureRig, phoneId } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "admin-capture-records-test";
}
const KEK = randomBytes(32).toString("hex");
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const AT = "2026-10-11T21:19:03.123Z";

/** A fresh user, signed in (the jar holds only their session). `staff` sets users.is_staff. */
async function signInAs(staff: boolean): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${`caprec-admin-${randomUUID()}@example.test`}, 'Capture records reader', true, ${staff}, ${staff ? "support" : null})
    returning id`;
  jar.clear();
  await createSession(id);
  return id;
}
const post = (lines: object[]) => new Request("http://localhost/x", { method: "POST", body: lines.map((l) => JSON.stringify(l)).join("\n") });

describe("normaliseRecordRef (P9)", () => {
  it("the empty case first, then trims and upper-cases; anything off the pattern is null — counted", () => {
    const cases: [string, string | null][] = [
      ["", null], ["   ", null], ["r-7k2q", "R-7K2Q"], ["  R-7K2Q ", "R-7K2Q"], ["R-7K2Q9XZ1", "R-7K2Q9XZ1"],
      ["R-7I2Q", null], ["R-7K2", null], ["7K2Q", null], ["R-7K2Q9XZ12", null],
    ];
    let checked = 0;
    for (const [raw, want] of cases) {
      expect(normaliseRecordRef(raw), JSON.stringify(raw)).toBe(want);
      checked++;
    }
    expect(checked).toBe(9);
  });
});

describe.skipIf(!HAS_DB)("the staff reads (§10)", () => {
  beforeEach(async () => { await signInAs(true); });

  it("review fix 3: both reads ask for staff themselves — no session and a signed-in NON-staff user are each refused, by ref and by fixture; the same reads as staff return the record (the positive pair)", async () => {
    const r = await captureRig();
    const sent = await postCaptureRecord(r.code, r.tok, post([
      { at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(r.tok) },
    ]), r.now());
    const refusals: [who: string, signIn: () => Promise<unknown>, message: string][] = [
      ["no session", async () => { jar.clear(); }, "Not authenticated"],
      ["a non-staff user", () => signInAs(false), "Staff access required"],
    ];
    let refused = 0;
    for (const [who, signIn, message] of refusals) {
      await signIn();
      for (const read of [() => captureRecordByRef(sent.ref), () => captureRecordsOfFixture(r.fixtureId)]) {
        const e = await read().then(() => null, (err: unknown) => err);
        expect(e, who).toBeInstanceOf(AuthError);
        expect((e as Error).message, who).toBe(message);
        refused++;
      }
    }
    expect(refused).toBe(4);
    await signInAs(true);
    expect(await captureRecordByRef(sent.ref)).toMatchObject({ ref: sent.ref, kept: 1 });
    expect((await captureRecordsOfFixture(r.fixtureId)).unlinked.map((x) => x.ref)).toEqual([sent.ref]);
  });

  it("the empty case first: a fixture with no record lists its sessions with none and no unlinked record; an unknown and a malformed ref read null", async () => {
    const r = await captureRig({ credits: 1 });
    const S = await r.start(phoneId("a"));
    expect(await captureRecordsOfFixture(r.fixtureId)).toMatchObject({ sessions: [{ id: S, records: [] }], unlinked: [] });
    expect(await captureRecordByRef("R-0000000Z")).toBeNull();
    expect(await captureRecordByRef("not a ref")).toBeNull();
  });

  it("by ref (any case): the counts, slot, code and the KEPT lines as at / kind / level / sid / key=value — and by fixture: under its session, then the record that names none", async () => {
    const r = await captureRig({ credits: 1 });
    const S = await r.start(phoneId("a"));
    const foreign = `foreign-${randomUUID()}`;
    const linked = await postCaptureRecord(r.code, r.tok, post([
      { at: AT, kind: "thermal", message: foreign },                                      // before any pair: dropped
      { at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(r.tok) },
      { at: AT, kind: "live", level: "warn", sid: S, transport: "srt", attempt: 2, ok: true },
      { at: AT, kind: "x", battery: 1, message: foreign },                                // a bad line (ruling RL): dropped, counted apart
    ]), r.now());
    const unlinked = await postCaptureRecord(r.code, r.tok, post([{ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(r.tok) }]), r.now());
    const got = await captureRecordByRef(linked.ref.toLowerCase());
    const [{ code_id }] = await sql<{ code_id: string }[]>`select id as code_id from fixture_stream_codes where code = ${r.code}`;
    expect(got).toMatchObject({ ref: linked.ref, slot: 0, codeId: code_id, fixtureId: r.fixtureId, orgId: r.auth.orgId, received: 4, kept: 2, dropped: 2, invalid: 1, sessionIds: [S] });
    expect(got!.lines).toEqual([
      { at: AT, kind: "pair", level: null, sid: null, fields: [["claim", "new"], ["slot", "0"], ["tokenTag", tokenTag(r.tok)]] },
      { at: AT, kind: "live", level: "warn", sid: S, fields: [["transport", "srt"], ["attempt", "2"], ["ok", "true"]] },
    ]);
    expect(JSON.stringify(got)).not.toContain(foreign);
    const byFixture = await captureRecordsOfFixture(r.fixtureId);
    expect(byFixture.sessions.map((s) => [s.id, s.records.map((x) => x.ref)])).toEqual([[S, [linked.ref]]]);
    expect(byFixture.unlinked.map((x) => x.ref)).toEqual([unlinked.ref]);
  });

  it("a record whose every line was dropped reads with kept 0 and no lines (P10)", async () => {
    const r = await captureRig();
    const all = await postCaptureRecord(r.code, r.tok, post([{ at: AT, kind: "thermal" }]), r.now());
    expect(await captureRecordByRef(all.ref)).toMatchObject({ kept: 0, dropped: 1, invalid: 0, lines: [], sessionIds: [] });
  });
});
