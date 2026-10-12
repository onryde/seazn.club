// Capture record upload (spec 2026-10-12-capture-record-upload-design.md, approved by the owner 2026-10-12) —
// `postCaptureRecord` against real Postgres, through the REAL code (ensureStreamCode), the REAL organiser start, the REAL
// reissue and the REAL lazy expiry, on the capture rig.
//
// The state transitions under test: the code ACTIVE → FINISHING → ENDED(expired), and ACTIVE → ENDED(reissued) with
// its session open, then ended, then 24 h on (§4 C1(a), C1(b), C1(c)); a second upload after a first; the session's
// pairing moved by a takeover (R4) and the null-pairing session (Q9). The empty cases: an empty body (422) and a
// record whose every line is dropped (201, kept 0 — P10).
//
// Expected values come from the spec (§4, §6's rules, §9's shape and P6's 30 days) and capture's token-tag vectors;
// tags are computed by the module's tokenTag only where the tok is the rig's random one, and that function is pinned
// to capture's vectors in domain/__tests__/capture-record.test.ts.
//
// ONE SPORT, on purpose: not applicable — the capture surface reads no sport (spec §13.2 "Another sport").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CAPTURE_RECORD_REF_RE } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { CAPTURE_RECORD_RETENTION_DAYS, CODE_GRACE_AFTER_FINISH_MINUTES } from "@/server/relay/config";
import { tokenTag } from "@/server/relay/domain/capture-record";
import { postCaptureRecord } from "../capture-record";
import { reissueStreamCode, resolveStreamCode } from "../stream-codes";
import { captureRig as rawRig, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every tok a test minted, so the log check can prove none was ever written. */
const toks: string[] = [];
async function captureRig(opts: Parameters<typeof rawRig>[0] = {}): Promise<CaptureRig> {
  const r = await rawRig(opts);
  toks.push(r.tok);
  return r;
}

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "CODE_GRACE_AFTER_FINISH_MINUTES"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-record-test-secret";
}
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

const H = 3_600_000;
const SPEC_TAIL_MS = 24 * H;                   // §4 C1(c)
const SPEC_RETENTION_DAYS = 30;                // §9 P6
const AT = "2026-10-11T21:19:03.123Z";
const URL_ = "http://localhost/api/v1/capture/codes/x/records";
const post = (body: string, headers: Record<string, string> = {}) => new Request(URL_, { method: "POST", body, headers });
const ndjson = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Lines as capture writes them. A `note` rides in `message` (a text key) so a test can find the line again. */
const pairLine = (tok: string, note = "pair") => ({ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(tok), message: note });
const deviceLine = (note: string) => ({ at: AT, kind: "thermal", level: "warn", status: 3, message: note });
const sidLine = (sid: string, note: string) => ({ at: AT, kind: "live", sid, transport: "srt", message: note });
const unpairedLine = (note = "unpaired") => ({ at: AT, kind: "unpaired", message: note });

const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
async function records(fixtureId: string) {
  return sql<{ id: string; ref: string; org_id: string; competition_id: string; code_id: string; slot: number; received_lines: number;
    kept_lines: number; dropped_lines: number; body_bytes: number; lines: string; created_at: Date; expires_at: Date }[]>`
    select id, ref, org_id, competition_id, code_id, slot, received_lines, kept_lines, dropped_lines, body_bytes, lines, created_at, expires_at
      from capture_records where fixture_id = ${fixtureId} order by created_at, ref`;
}
const linksOf = async (recordId: string) =>
  (await sql<{ session_id: string }[]>`select session_id from capture_record_sessions where record_id = ${recordId} order by session_id`).map((r) => r.session_id);
const codeIdOf = async (code: string) => (await sql<{ id: string }[]>`select id from fixture_stream_codes where code = ${code}`)[0]!.id;
const endSession = (id: string, at: Date) =>
  sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = ${at} where id = ${id}`;

describe.skipIf(!HAS_DB)("postCaptureRecord (spec 2026-10-12)", () => {
  let logged: string[] = [];
  beforeEach(() => {
    logged = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);
    }
  });
  afterEach(() => {
    // §10.2 / §11: whatever path a test drove, no log line holds a tok or a line's text.
    for (const entry of logged) {
      expect(entry).not.toContain("2026-10-11T21:19:03");   // every line here carries this `at`
      for (const tok of toks) expect(entry).not.toContain(tok);
    }
    vi.restoreAllMocks();
  });

  it("the empty case first: an empty body and a blank one are 422 invalid, and nothing is stored", async () => {
    const r = await captureRig();
    let checked = 0;
    for (const body of ["", "\n\n"]) {
      expect(await refusalOf(postCaptureRecord(r.code, r.tok, post(body), r.now()))).toMatchObject({ status: 422, code: "invalid" });
      checked++;
    }
    expect(checked).toBe(2);
    expect(await records(r.fixtureId)).toEqual([]);
  });

  it("201: the kept lines are stored verbatim with their counts, the code's slot, the org and competition, 30 days' expiry and the session link — then a SECOND upload stores a second record with a new ref (not idempotent)", async () => {
    const r = await captureRig({ credits: 1 });
    const S = await r.start(phoneId("a"));
    const lines = [pairLine(r.tok), deviceLine("inside"), sidLine(S, "own session"), unpairedLine()];
    const text = ndjson(lines);
    const first = await postCaptureRecord(r.code, r.tok, post(text), r.now());
    expect(first).toMatchObject({ kept: 4, dropped: 0 });
    expect(first.ref).toMatch(CAPTURE_RECORD_REF_RE);
    const [row] = await records(r.fixtureId);
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${r.fixtureId}`;
    expect(row).toMatchObject({
      ref: first.ref, org_id: r.auth.orgId, competition_id, code_id: await codeIdOf(r.code), slot: 0,
      received_lines: 4, kept_lines: 4, dropped_lines: 0, body_bytes: Buffer.byteLength(text),
      lines: lines.map((l) => JSON.stringify(l)).join("\n"),
    });
    expect(row!.expires_at.getTime() - row!.created_at.getTime()).toBe(SPEC_RETENTION_DAYS * 24 * H);
    expect(CAPTURE_RECORD_RETENTION_DAYS).toBe(SPEC_RETENTION_DAYS);
    expect(await linksOf(row!.id)).toEqual([S]);
    // The second tap.
    r.tick(60_000);
    const second = await postCaptureRecord(r.code, r.tok, post(text), r.now());
    expect(second.ref).not.toBe(first.ref);
    const both = await records(r.fixtureId);
    expect(both).toHaveLength(2);
    expect(both.map((x) => x.ref).sort()).toEqual([first.ref, second.ref].sort());
    // The log names ids and counts — never a line.
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) expect(entry).not.toContain("own session");
  });

  it("CROSS-CODE across two orgs: club X's lines (its pair, its device lines, its session) sent under club Y's tok are DROPPED — never stored, never logged — and Y's are kept (§6's worked example)", async () => {
    const x = await captureRig({ credits: 1 });
    const y = await captureRig({ credits: 1 });
    const SX = await x.start(phoneId("x"));
    const SY = await y.start(phoneId("y"));
    const secretX = `club-x-${randomUUID()}`;
    const lines = [
      deviceLine(`${secretX}-1`),           // before the first pair
      pairLine(x.tok, `${secretX}-2`),      // X's window opens
      sidLine(SX, `${secretX}-3`),          // A1: X's session
      deviceLine(`${secretX}-4`),           // inside X's window
      unpairedLine(`${secretX}-5`),         // closes X's window
      pairLine(y.tok, "y-pair"),            // Y's window
      deviceLine("y-thermal"),
      sidLine(SY, "y-live"),
    ];
    const answer = await postCaptureRecord(y.code, y.tok, post(ndjson(lines)), y.now());
    expect(answer).toMatchObject({ kept: 3, dropped: 5 });
    const [row] = await records(y.fixtureId);
    expect(row!.lines).toBe(lines.slice(5).map((l) => JSON.stringify(l)).join("\n"));
    expect(row!.lines).not.toContain(secretX);
    expect(await linksOf(row!.id)).toEqual([SY]);
    for (const entry of logged) expect(entry).not.toContain(secretX);
    expect(await records(x.fixtureId)).toEqual([]);
    // The positive pair: the same X lines under X's own tok keep X's window and X's session.
    const own = await postCaptureRecord(x.code, x.tok, post(ndjson(lines.slice(0, 5))), x.now());
    expect(own).toMatchObject({ kept: 4, dropped: 1 });
  });

  it("every line dropped is still 201 with kept 0, stored as counts with no lines and no link (P10)", async () => {
    const r = await captureRig();
    const answer = await postCaptureRecord(r.code, r.tok, post(ndjson([deviceLine("before any pair"), sidLine(randomUUID(), "unknown")])), r.now());
    expect(answer).toMatchObject({ kept: 0, dropped: 2 });
    const [row] = await records(r.fixtureId);
    expect(row).toMatchObject({ received_lines: 2, kept_lines: 0, dropped_lines: 2, lines: "" });
    expect(await linksOf(row!.id)).toEqual([]);
  });

  it("R4: after a takeover the session's pairing is the NEW phone's pairing of the same code, and its lines are still kept; a session with NO pairing (an organiser start with no phone, Q9) is dropped", async () => {
    const r = await captureRig({ credits: 1 });
    const S = await r.start(phoneId("old"));
    const taken = await r.pair(phoneId("new"));
    await sql`update fixture_stream_sessions set pairing_id = ${taken.pairingId} where id = ${S}`;
    const kept = await postCaptureRecord(r.code, r.tok, post(ndjson([sidLine(S, "after takeover")])), r.now());
    expect(kept).toMatchObject({ kept: 1, dropped: 0 });
    await sql`update fixture_stream_sessions set pairing_id = null where id = ${S}`;
    const dropped = await postCaptureRecord(r.code, r.tok, post(ndjson([sidLine(S, "no pairing")])), r.now());
    expect(dropped).toMatchObject({ kept: 0, dropped: 1 });
  });

  it("401 code_ended for a wrong tok and an unknown code, 404 for a malformed code — and the body of a refused caller is never READ", async () => {
    const r = await captureRig();
    let pulled = 0;
    const unread = () => new Request(URL_, {
      method: "POST", duplex: "half",
      body: new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode(ndjson([deviceLine("x")]))); c.close(); } }, { highWaterMark: 0 }),
    } as RequestInit);
    const cases: [string, string, string, object][] = [
      ["wrong tok", r.code, "Zq9rT4mW2xK7pL1vN8cB3d", { status: 401, code: "code_ended" }],
      ["unknown code", "0000000000zz", r.tok, { status: 401, code: "code_ended" }],
      ["malformed code", "not-a-code!", r.tok, { status: 404, code: "not_a_stream_code" }],
    ];
    let checked = 0;
    for (const [name, code, tok, want] of cases) {
      const e = await refusalOf(postCaptureRecord(code, tok, unread(), r.now()));
      expect(e, name).toBeInstanceOf(CaptureRefusalError);
      expect(e, name).toMatchObject(want);
      checked++;
    }
    expect(checked).toBe(3);
    expect(pulled, "a refused caller's body is never read").toBe(0);
    // The positive pair: the right tok reads it.
    await postCaptureRecord(r.code, r.tok, unread(), r.now());
    expect(pulled).toBe(1);
  });

  it("413 too_large and 422 invalid (a secret-shaped value, a key off the allow-list) store nothing; the 422 names the line, key and rule, never the value", async () => {
    const r = await captureRig();
    const many = Array.from({ length: 1001 }, (_, i) => deviceLine(`n${i}`));
    expect(await refusalOf(postCaptureRecord(r.code, r.tok, post(ndjson(many)), r.now()))).toMatchObject({ status: 413, code: "too_large" });
    const secret = { at: AT, kind: "vendor-log", message: "publish failed for rtmps://live.cloudflare.com:443/live/FAKE-STREAM-KEY" };
    const e = await refusalOf(postCaptureRecord(r.code, r.tok, post(ndjson([pairLine(r.tok), secret])), r.now()));
    expect(e).toMatchObject({ status: 422, code: "invalid", message: "line 2: message is secret-shaped (S2)" });
    // S1: the SENDING Bearer itself, in a plain word.
    const s1 = await refusalOf(postCaptureRecord(r.code, r.tok, post(ndjson([{ at: AT, kind: "pair-refused", message: `tok=${r.tok}` }])), r.now()));
    expect(s1).toMatchObject({ status: 422, message: "line 1: message is secret-shaped (S1)" });
    expect(await refusalOf(postCaptureRecord(r.code, r.tok, post(ndjson([{ at: AT, kind: "x", battery: 42 }])), r.now())))
      .toMatchObject({ status: 422, message: "line 1: key battery is not on the allow-list" });
    expect(await records(r.fixtureId)).toEqual([]);
    for (const entry of logged) expect(entry).not.toContain("FAKE-STREAM-KEY");
  });

  it("P11: a REISSUED code's tok still sends while its session is open — from any phone, where a `get` without the session's phone is refused — then for 24 h after the session ends, and is refused 1 ms past that", async () => {
    const r = await captureRig({ credits: 1 });
    const oldCode = r.code, oldTok = r.tok;
    const S = await r.start(phoneId("a"));
    await reissueStreamCode(r.auth, r.fixtureId);
    const line = () => post(ndjson([sidLine(S, "old code, open session")]));
    expect(await postCaptureRecord(oldCode, oldTok, line(), new Date())).toMatchObject({ kept: 1, dropped: 0 });
    expect(await refusalOf(resolveStreamCode(oldCode, oldTok, "get", null, new Date()))).toMatchObject({ status: 401 });
    // The session ends: the tail runs from ITS end, not the code's (which was earlier).
    const sessionEnd = new Date(Date.now() + 2 * H);
    await endSession(S, sessionEnd);
    expect(await postCaptureRecord(oldCode, oldTok, line(), new Date(sessionEnd.getTime() + SPEC_TAIL_MS))).toMatchObject({ kept: 1 });
    expect(await refusalOf(postCaptureRecord(oldCode, oldTok, line(), new Date(sessionEnd.getTime() + SPEC_TAIL_MS + 1))))
      .toMatchObject({ status: 401, code: "code_ended" });
  });

  it("C1(c) with no session: a reissued code is served through ended_at + 24 h exactly and refused 1 ms past it", async () => {
    const r = await captureRig();
    const oldCode = r.code, oldTok = r.tok;
    await reissueStreamCode(r.auth, r.fixtureId);
    const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_codes where code = ${oldCode}`;
    const at = (ms: number) => postCaptureRecord(oldCode, oldTok, post(ndjson([pairLine(oldTok)])), new Date(ended_at.getTime() + ms));
    expect(await at(SPEC_TAIL_MS)).toMatchObject({ kept: 1 });
    expect(await refusalOf(at(SPEC_TAIL_MS + 1))).toMatchObject({ status: 401, code: "code_ended" });
  });

  it("C1(c) for an expiry runs from finished_at + the grace, NOT the lazily written ended_at: finished 3 days ago → 401 on the first call (which writes the expiry); finished grace + 1 h ago → 201", async () => {
    const GRACE_MS = CODE_GRACE_AFTER_FINISH_MINUTES * 60_000;
    const finishAgo = async (r: CaptureRig, ms: number) => {
      await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
      await sql`update fixtures set finished_at = ${new Date(r.now().getTime() - ms)} where id = ${r.fixtureId}`;
    };
    const late = await captureRig();
    await finishAgo(late, 72 * H);
    expect(await refusalOf(postCaptureRecord(late.code, late.tok, post(ndjson([pairLine(late.tok)])), late.now())))
      .toMatchObject({ status: 401, code: "code_ended" });
    expect((await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where code = ${late.code}`)[0]!.end_cause).toBe("expired");
    const recent = await captureRig();
    await finishAgo(recent, GRACE_MS + H);
    expect(await postCaptureRecord(recent.code, recent.tok, post(ndjson([pairLine(recent.tok)])), recent.now())).toMatchObject({ kept: 1 });
    expect((await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where code = ${recent.code}`)[0]!.end_cause).toBe("expired");
  });

  it("a session that ENDED or FAILED still has its lines kept (A1 reads the pairing, not the state); a finished fixture is served inside the grace, and past it while a session is open", async () => {
    const r = await captureRig({ credits: 2 });
    const S = await r.start(phoneId("a"));
    await endSession(S, r.now());
    expect(await postCaptureRecord(r.code, r.tok, post(ndjson([sidLine(S, "completed")])), r.now())).toMatchObject({ kept: 1 });
    await sql`update fixture_stream_sessions set state = 'failed', end_reason = null where id = ${S}`;
    expect(await postCaptureRecord(r.code, r.tok, post(ndjson([sidLine(S, "failed")])), r.now())).toMatchObject({ kept: 1 });
    // Finished: inside the grace the code is FINISHING and serves.
    const f = await captureRig({ credits: 1 });
    await sql`update fixtures set status = 'cancelled' where id = ${f.fixtureId}`;
    expect(await postCaptureRecord(f.code, f.tok, post(ndjson([pairLine(f.tok)])), f.now())).toMatchObject({ kept: 1 });
    // Past the grace with a session open: C2 defers the expiry, so it is still FINISHING and serves.
    const g = await captureRig({ credits: 1 });
    await g.start(phoneId("g"));
    await sql`update fixtures set status = 'cancelled' where id = ${g.fixtureId}`;
    await sql`update fixtures set finished_at = ${new Date(g.now().getTime() - CODE_GRACE_AFTER_FINISH_MINUTES * 60_000 - H)} where id = ${g.fixtureId}`;
    expect(await postCaptureRecord(g.code, g.tok, post(ndjson([pairLine(g.tok)])), g.now())).toMatchObject({ kept: 1 });
    expect((await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_stream_codes where code = ${g.code}`)[0]!.ended_at).toBeNull();
  });

  it("review fix 1 + §0.1, as a regression: capture's scrubbed output (every near-miss fixture) and lines exactly as its writers write them, sent whole after a pair, are 201 with every line kept", async () => {
    const r = await captureRig();
    const dir = resolve(import.meta.dirname, "../../../../../../docs/contracts/fixtures/capture-record.v1");
    const near = readdirSync(dir).filter((f) => /^line-valid-(scrubbed|prose)-.+\.json$/.test(f)).sort();
    expect(near).toHaveLength(12);   // the nine near misses, capture's cases 21/24, and the two SRT prose strings (Q4)
    const lines = [pairLine(r.tok), ...near.map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as object),
      { at: AT, kind: "code.error", field_kind: "surface.unavailable", failure: "***", status: 503 }];
    expect(await postCaptureRecord(r.code, r.tok, post(ndjson(lines)), r.now())).toMatchObject({ kept: lines.length, dropped: 0 });
  });

  it("P9: a ref collision draws again (the stored ref is the second draw); a draw that always collides gives up with the unique violation", async () => {
    const r = await captureRig();
    const first = await postCaptureRecord(r.code, r.tok, post(ndjson([pairLine(r.tok)])), r.now());
    const fresh = `R-${randomBytes(3).toString("hex").toUpperCase().replace(/[^0-9A-F]/g, "0").slice(0, 6)}`;
    const draws = [first.ref, fresh];
    let drawn = 0;
    const second = await postCaptureRecord(r.code, r.tok, post(ndjson([pairLine(r.tok)])), r.now(), { drawRef: () => draws[drawn++]! });
    expect(drawn).toBe(2);
    expect(second.ref).toBe(fresh);
    const stuck = await refusalOf(postCaptureRecord(r.code, r.tok, post(ndjson([pairLine(r.tok)])), r.now(), { drawRef: () => first.ref }));
    expect(stuck).toMatchObject({ code: "23505", constraint_name: "capture_records_ref_key" });
    expect(await records(r.fixtureId)).toHaveLength(2);
  });
});
