// Capture QR v2 — the phone's routes as a SEQUENCE (TEST-STRATEGY rule 10). Drawn orderings of claim, beat, start, the
// ingest connecting, the phone's Stop, the ORGANISER's Stop and the organiser's reissue, two phones, a fresh fixture per
// run, through the REAL use-cases (postBeat, postStart, tickSession, stopSession, reissueStreamCode) on fake drivers.
// A phone's beats and starts go through the code it LAST SCANNED (a claim is a scan; a 401 makes it forget the code),
// never through its pairing's code (B6 review I-2). After every step the answer is checked against a MODEL written from
// the spec, never from capture-phone.ts:
//   - C1b (§6.3): an ENDED code refuses a claim and a start 401 code_ended — even for its open session's phone — and
//     serves a beat only to the open session's phone (the session's pairing's phone, the session created before the
//     code ended);
//   - §5.2 (M-6): a call C1 refuses ENDS the caller's pairing on that code `code_ended`, lazily; the C1b phone's
//     refused claim or start ends nothing;
//   - §5.5, first row wins, for a `new` claim on the current code against the HOLDER (the open session's phone while
//     its pairing stands, across a reissue; else the code's current pairing): T1 nobody or itself → accepted, and the
//     holder's claim from another code RE-SEATS it — its pairing and the open session move onto the code it scanned
//     (I-2); T3 the slot is live (the open session has ingested) → taken; T2 otherwise → takeover (the holder's pairing
//     ends, and an open session moves to the claimer). T4 (a dead holder) is out of reach by construction: the clock
//     moves at most 4 s a step, never the 60 s A14 asks for;
//   - a beat (T7/T8): the holder hears the state machine, anyone else `replaced`;
//   - T12 → T13 → T15 (§6.3.4, in that order): a phone that is not the HOLDER is `replaced`; then a running session
//     answers already_live naming its sid and `operator`; else 200 {sid} starts one;
//   - T21 (§6.5): the session's phone's `ended` naming its sid is the operator's Stop — its pairing ends;
//   - T20 (M-7): the organiser's Stop never touches a pairing; the phone that rescanned before it is still the code's
//     current phone afterwards (I-2: never `replaced`).
// And the invariants, after every step: at most ONE open session on the fixture; one session row per 200; every row
// started by `operator`, attributed to the code's issuer, carrying a pairing (T6 m-2); the fixture's CURRENT pairings
// are exactly the model's; the open session's pairing is the model's (phone, code, standing).
//
// The tally reports every outcome it reached, and in how many DRAWN runs (the hand-written examples excluded); a zero
// is a FAILURE (anti-vacuity) — a property that never drew a 401 on an ended code proved nothing about C1b. The seed is
// fixed so the tally is reproducible; FC_SEED overrides it.
//
// ONE SPORT, on purpose (rule 6): nothing here reads the sport (capture-start.test.ts pins the cricket row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { sql } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureBeatAnswer, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { postBeat, postStart } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { stopSession, tickSession } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "capture-sequence-test-secret";
});
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Via = "current" | "old";
type Act =
  | { kind: "claim"; phone: 0 | 1; via: Via }
  | { kind: "beat"; phone: 0 | 1 }
  | { kind: "start"; phone: 0 | 1 }
  | { kind: "ingest" }
  | { kind: "stop" }
  | { kind: "orgStop" }
  | { kind: "rescan" }
  | { kind: "reissue" };
const RUNS = 300;
const c0 = { kind: "claim", phone: 0, via: "current" } as const;
const c1 = { kind: "claim", phone: 1, via: "current" } as const;
/** Three hand-written orderings, run FIRST and inside RUNS (fast-check's examples), so the rarest rows are reached on
 *  every seed: (1) T3 (a live slot is taken, the taken phone's beat `replaced`) and T13 (already_live, on a running and
 *  then an ending session), then a claim while the Stop drains; (2) a reissue under an open session — its phone's beat
 *  still served on the old code, its start and claim there 401 with its pairing KEPT — then its rescan of the new QR
 *  (I-2) and a takeover there; (3) M-6 (a pairing on an ended code ends `code_ended` when its call is refused), then a
 *  session, a reissue, the holder's rescan, the ORGANISER's Stop, the rescanned phone's beat (never `replaced`) and its
 *  fresh start. The drawn runs supply the rest. */
const EXAMPLES: Act[][] = [
  [c0, { kind: "start", phone: 0 }, { kind: "ingest" }, c1, { kind: "beat", phone: 1 }, { kind: "start", phone: 0 }, { kind: "stop" }, c1, { kind: "start", phone: 1 }],
  [
    c0, { kind: "start", phone: 0 }, { kind: "reissue" }, { kind: "beat", phone: 0 }, { kind: "start", phone: 0 },
    { kind: "claim", phone: 0, via: "old" }, c0, { kind: "beat", phone: 0 }, c1, { kind: "beat", phone: 0 }, { kind: "start", phone: 1 },
  ],
  [
    c0, { kind: "reissue" }, c1, { kind: "beat", phone: 0 }, { kind: "start", phone: 1 }, { kind: "reissue" }, c1,
    { kind: "orgStop" }, { kind: "beat", phone: 1 }, { kind: "start", phone: 1 },
  ],
];
const phoneArb = fc.constantFrom<0 | 1>(0, 1);
const viaArb = fc.constantFrom<Via>("current", "current", "old");
const actArb: fc.Arbitrary<Act> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("claim" as const), phone: phoneArb, via: viaArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("beat" as const), phone: phoneArb }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("start" as const), phone: phoneArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("ingest" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stop" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("orgStop" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("rescan" as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("reissue" as const) }) },
);

/** The outcomes the model can name. Every one must be reached at least once. */
const OUTCOMES = [
  "claim:accepted", "claim:rescan", "claim:takeover", "claim:taken", "claim:ended-401",
  "beat:answered", "beat:replaced", "beat:ended-401", "beat:after-rescan-and-organiser-stop",
  "start:200", "start:already_live", "start:replaced", "start:ended-401",
  "ingest:live", "stop:applied", "orgStop:applied", "reissue:applied",
  "refused:pairing-ended-code_ended", "refused:c1b-pairing-kept",
] as const;
type Outcome = (typeof OUTCOMES)[number];
/** The I-2 / M-7 / M-6 actions whose DRAWN reach is reported (and, for the two the controller named, required). */
const DRAWN_REPORTED: readonly Outcome[] = ["claim:rescan", "orgStop:applied", "beat:after-rescan-and-organiser-stop", "refused:pairing-ended-code_ended"];
const DRAWN_REQUIRED: readonly Outcome[] = ["claim:rescan", "orgStop:applied"];

/** The refusal a call threw, or null when it answered. */
async function outcomeOf<T>(p: Promise<T>): Promise<{ ok: T } | { refused: CaptureRefusalError }> {
  try {
    return { ok: await p };
  } catch (e) {
    if (e instanceof CaptureRefusalError) return { refused: e };
    throw e;
  }
}

describe.skipIf(!HAS_DB)("the phone's routes as a SEQUENCE — drawn orderings of claim, beat, start, both Stops and reissue (rule 10)", () => {
  it("every answer matches the spec's model (C1b, M-6, T1–T8 with the I-2 re-seat, T12→T13→T15, T20, T21); at most one open session; one row per 200, each operator, by the issuer, with a pairing; the current pairings are the model's; every outcome reached", async () => {
    const tally = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]));
    const drawnRuns = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]));
    let reached = new Set<Outcome>();
    const count = (o: Outcome) => { tally.set(o, tally.get(o)! + 1); reached.add(o); };
    let runs = 0;
    let steps = 0;
    let skipped = 0;
    let invariantChecks = 0;
    let pairingsCompared = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(actArb, { minLength: 3, maxLength: 16 }), async (acts) => {
        const runIndex = runs++;
        reached = new Set<Outcome>();
        const r: CaptureRig = await captureRig({ credits: 5 });
        await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
        const issuer = (await sql<{ issued_by: string }[]>`select issued_by from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`)[0]!.issued_by;
        const phones = [phoneId("a"), phoneId("b")] as const;

        // ---- the model ----
        const codes: { code: string; tok: string }[] = [{ code: r.code, tok: r.tok }];
        const currentIdx = () => codes.length - 1;
        /** The CURRENT pairings, `phone@codeIndex` (slot 0). A reissue ends none (T30); a phone can hold one on an old
         *  code and one on the current code at once. */
        const pairs = new Set<string>();
        const at = (phone: string, idx: number) => `${phone}@${idx}`;
        const pairedPhoneOn = (idx: number) => phones.find((p) => pairs.has(at(p, idx))) ?? null;
        /** phone → the index of the code it last scanned (a claim); forgotten when a call through it is refused 401. */
        const scanned = new Map<string, number>();
        /** The open session: its sid; the phone and code of its pairing — what the server reads as "the open session's
         *  phone" even after that pairing ended (C1b) — and whether that pairing still stands; the code current when it
         *  was created (C1b serves only codes that ended AFTER it); whether it has ingested; whether a Stop has moved
         *  it to `ending` (still open). */
        // `as`, not an annotation: `step` reassigns it, and an annotated `= null` narrows to null outside the closure.
        let open = null as { sid: string; pairPhone: string; pairIdx: number; holdAlive: boolean; bornIdx: number; ingested: boolean; ending: boolean } | null;
        /** Phones whose claim re-seated the open session (I-2), and those whose session the ORGANISER then stopped. */
        const rescanned = new Set<string>();
        const stoppedAfterRescan = new Set<string>();
        let started = 0;
        const viaCode = (via: Via) => (via === "current" || codes.length === 1 ? currentIdx() : currentIdx() - 1);
        const holderOn = (idx: number) => (open !== null && open.holdAlive ? open.pairPhone : pairedPhoneOn(idx));
        /** C1(a)/C1(b): whether code `idx` serves phone X a beat (a claim and a start on an ended code: never, C3). */
        const servesBeat = (X: string, idx: number) => idx === currentIdx() || (open !== null && open.pairPhone === X && idx >= open.bornIdx);
        /** Phone X's pairings on code `idx`: how many are current, and how many have ended `code_ended`. */
        type PairCounts = { current: number; codeEnded: number };
        const pairCounts = async (X: string, idx: number): Promise<PairCounts> => (await sql<PairCounts[]>`
          select count(*) filter (where p.ended_at is null)::int as current, count(*) filter (where p.end_cause = 'code_ended')::int as "codeEnded"
            from fixture_stream_pairings p join fixture_stream_codes k on k.id = p.code_id
           where k.code = ${codes[idx]!.code} and p.phone = ${X}`)[0]!;
        const currentOn = async (X: string, idx: number) => (await pairCounts(X, idx)).current;

        const beatBody = (code: string, phone: string, over: Record<string, unknown> = {}) => CaptureBeat.parse({
          code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
          cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
          delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
          appVersion: "capture-test/1", ...over,
        });

        /** A call through code `idx` that the model says is refused 401 code_ended: check the refusal, then M-6 — the
         *  caller's pairing on that code is ENDED(code_ended), unless the caller is the C1b phone (served by C1; C3 only
         *  narrows its calls), whose pairing is kept. The phone forgets the code. */
        const refused401 = async (X: string, idx: number, got: { ok: unknown } | { refused: CaptureRefusalError }, before: PairCounts, label: string) => {
          expect("refused" in got && got.refused.status === 401 && got.refused.code === "code_ended", label).toBe(true);
          const c1b = open !== null && open.pairPhone === X && idx >= open.bornIdx;
          const after = await pairCounts(X, idx);
          if (c1b) {
            expect(after, `${label}: the C1b phone's pairing is kept`).toEqual(before);
            if (before.current > 0) count("refused:c1b-pairing-kept");
          } else {
            expect(after, `${label}: M-6, the refused pairing is ENDED(code_ended)`).toEqual({ current: 0, codeEnded: before.codeEnded + before.current });
            if (before.current > 0) count("refused:pairing-ended-code_ended");
            pairs.delete(at(X, idx));
          }
          scanned.delete(X);
        };

        const step = async (a: Act): Promise<boolean> => {
          switch (a.kind) {
            case "rescan": {
              // I-2: the organiser revokes the QR under a running session — unless one was already reissued since the
              // session's phone paired — and that phone scans the new one, as the Revoke copy tells it to: a `new`
              // claim like any other, by the phone that most needs it.
              if (open === null || !open.holdAlive) return false;
              const X = open.pairPhone as (typeof phones)[number];
              if (open.pairIdx === currentIdx()) await step({ kind: "reissue" });
              return step({ kind: "claim", phone: phones.indexOf(X) as 0 | 1, via: "current" });
            }
            case "claim": {
              const X = phones[a.phone];
              const idx = viaCode(a.via);
              const c = codes[idx]!;
              const before = await pairCounts(X, idx);
              const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(c.code, X, { claim: "new" }), r.deps, r.now()));
              if (idx !== currentIdx()) {
                await refused401(X, idx, got, before, "C1b/C3: a claim on an ended code");
                count("claim:ended-401");
                return true;
              }
              expect("ok" in got, `a claim on the current code answers: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
              scanned.set(X, idx);
              const answer = CaptureBeatAnswer.parse((got as { ok: unknown }).ok);
              const holder = holderOn(idx);
              if (holder === null || holder === X) {
                // T1: the phone holds the slot now. Nobody held it → a new pairing here. The holder re-claiming through
                // the code its pairing is on is process death: nothing moves. The open session's phone claiming through
                // ANOTHER code (it rescanned the new QR after a reissue) is re-seated there, session and all (I-2).
                expect(["taken", "replaced"], "T1: accepted").not.toContain(answer.state);
                if (holder === null) {
                  pairs.add(at(X, idx));
                  count("claim:accepted");
                } else if (open !== null && open.holdAlive && open.pairPhone === X && open.pairIdx !== idx) {
                  pairs.delete(at(X, open.pairIdx));
                  pairs.add(at(X, idx));
                  open = { ...open, pairIdx: idx };
                  rescanned.add(X);
                  count("claim:rescan");
                } else {
                  count("claim:accepted");
                }
              } else if (open?.ingested) {
                expect(answer.state, "T3: the slot is live and its phone is not dead").toBe("taken");
                count("claim:taken");
              } else {
                expect(["taken", "replaced"], "T2: a takeover seats the claimer").not.toContain(answer.state);
                // The holder's pairing on the code it held the slot through: the open session's (any code, C-2), else
                // this one. A pairing on an older code is untouched (T30: old pairings are unaffected until they call).
                const viaSession = open !== null && open.holdAlive && open.pairPhone === holder;
                const heldOn = viaSession ? open!.pairIdx : idx;
                expect(await currentOn(holder, heldOn), "T2: the holder's pairing ended").toBe(0);
                pairs.delete(at(holder, heldOn));
                pairs.add(at(X, idx));
                if (viaSession) open = { ...open!, pairPhone: X, pairIdx: idx };
                rescanned.delete(holder);
                count("claim:takeover");
              }
              return true;
            }
            case "beat": {
              const X = phones[a.phone];
              const idx = scanned.get(X);
              if (idx === undefined) return false;   // a phone beats only through a code it scanned
              const c = codes[idx]!;
              const before = await pairCounts(X, idx);
              const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(c.code, X), r.deps, r.now()));
              if (!servesBeat(X, idx)) {
                await refused401(X, idx, got, before, "C1b/C3: an ended code serves only its open session's phone");
                count("beat:ended-401");
                return true;
              }
              expect("ok" in got, `a served beat answers: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
              const answer = CaptureBeatAnswer.parse((got as { ok: unknown }).ok);
              if (holderOn(idx) === X) {
                expect(["taken", "replaced"], "T8: the holder's beat is the state machine, never taken or replaced").not.toContain(answer.state);
                count("beat:answered");
                if (open === null && stoppedAfterRescan.has(X)) {
                  // I-2 × T20: the phone that rescanned, after the ORGANISER's Stop closed its session, is still the
                  // current phone of the code it scanned.
                  stoppedAfterRescan.delete(X);
                  count("beat:after-rescan-and-organiser-stop");
                }
              } else {
                expect(answer.state, "T7: a phone that is not the holder is replaced").toBe("replaced");
                count("beat:replaced");
              }
              return true;
            }
            case "start": {
              const X = phones[a.phone];
              const idx = scanned.get(X);
              if (idx === undefined) return false;   // a phone starts only through a code it scanned
              const c = codes[idx]!;
              const before = await pairCounts(X, idx);
              const got = await outcomeOf(postStart(c.code, c.tok, { phone: X }, r.deps, r.now()));
              if (idx !== currentIdx()) {
                await refused401(X, idx, got, before, "C1b/C3: an ended code starts nothing");
                count("start:ended-401");
              } else if (holderOn(idx) !== X) {
                // T12 first: a phone that is not the holder is never told a sid.
                expect("refused" in got ? [got.refused.status, got.refused.code, got.refused.extras] : got, "T12").toEqual([409, "replaced", undefined]);
                count("start:replaced");
              } else if (open !== null) {
                expect("refused" in got ? [got.refused.status, got.refused.code, got.refused.extras] : got, "T13").toEqual([409, "already_live", { sid: open.sid, startedBy: "operator" }]);
                count("start:already_live");
              } else {
                expect("ok" in got, `T15: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
                const ok = CaptureStartOk.parse((got as { ok: unknown }).ok);
                open = { sid: ok.sid, pairPhone: X, pairIdx: idx, holdAlive: true, bornIdx: idx, ingested: false, ending: false };
                rescanned.clear();
                stoppedAfterRescan.clear();
                started++;
                count("start:200");
              }
              return true;
            }
            case "ingest": {
              // The phone's video reaches the ingest: the fake connects CONNECT_MS after the input exists. Not a
              // decision under test here, so the session's own row says whether it ingested.
              if (open === null || open.ending) return false;
              r.tick(4_000);
              await tickSession(open.sid, r.deps, "beat");
              const [row] = await sql<{ first_ingest_at: Date | null }[]>`select first_ingest_at from fixture_stream_sessions where id = ${open.sid}`;
              expect(row!.first_ingest_at, "the fake ingest connected").not.toBeNull();
              open = { ...open, ingested: true };
              count("ingest:live");
              return true;
            }
            case "stop": {
              // T21: the session's phone presses Stop — an `ended` beat naming its sid, through the code it scanned.
              if (open === null || open.ending || !open.holdAlive) return false;
              const holder = open.pairPhone;
              const idx = scanned.get(holder);
              if (idx === undefined) return false;
              expect(servesBeat(holder, idx), "the session's phone's scanned code serves it").toBe(true);
              const c = codes[idx]!;
              const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(c.code, holder, { state: "ended", sid: open.sid, endReason: "operator-stopped" }), r.deps, r.now()));
              expect("ok" in got, `T21: the session's phone's Stop answers: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
              pairs.delete(at(holder, open.pairIdx));   // T21: the operator's Stop ends the phone's pairing
              rescanned.delete(holder);
              const [row] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${open.sid}`;
              open = (ACTIVE_STATES as readonly string[]).includes(row!.state) ? { ...open, holdAlive: false, ending: true } : null;
              count("stop:applied");
              return true;
            }
            case "orgStop": {
              // T20 (M-7): the organiser stops the broadcast from the console. No pairing is touched.
              if (open === null || open.ending) return false;
              if (open.holdAlive && rescanned.has(open.pairPhone)) stoppedAfterRescan.add(open.pairPhone);
              await stopSession(r.auth, r.fixtureId, open.sid, r.deps);
              const [row] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${open.sid}`;
              open = (ACTIVE_STATES as readonly string[]).includes(row!.state) ? { ...open, ending: true } : null;
              count("orgStop:applied");
              return true;
            }
            case "reissue": {
              const shown = await reissueStreamCode(r.auth, r.fixtureId);
              codes.push({ code: shown.qr.code, tok: shown.qr.tok });
              count("reissue:applied");
              return true;
            }
          }
        };

        for (const a of acts) {
          if (await step(a)) steps++;
          else skipped++;
          // The invariants, after EVERY step.
          const rows = await sql<{ id: string; state: string; start_cause: string; created_by: string; pairing_id: string | null }[]>`
            select id, state, start_cause, created_by, pairing_id from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
          const openRows = rows.filter((s) => (ACTIVE_STATES as readonly string[]).includes(s.state));
          expect(openRows.length, "at most ONE open session on the fixture").toBeLessThanOrEqual(1);
          expect(openRows.map((s) => s.id), "the model's open session is the fixture's").toEqual(open ? [open.sid] : []);
          expect(rows.length, "one session row per 200").toBe(started);
          for (const s of rows) {
            expect([s.start_cause, s.created_by, s.pairing_id !== null], "T15/T6 m-2").toEqual(["operator", issuer, true]);
          }
          const live = await sql<{ phone: string; code: string }[]>`
            select p.phone, k.code from fixture_stream_pairings p join fixture_stream_codes k on k.id = p.code_id
             where k.fixture_id = ${r.fixtureId} and p.ended_at is null`;
          const dbPairs = live.map((p) => at(p.phone, codes.findIndex((c) => c.code === p.code))).sort();
          expect(dbPairs, "the fixture's CURRENT pairings are the model's").toEqual([...pairs].sort());
          pairingsCompared += dbPairs.length;
          if (open !== null) {
            const [sp] = await sql<{ phone: string; code: string; standing: boolean }[]>`
              select p.phone, k.code, p.ended_at is null as standing
                from fixture_stream_sessions s join fixture_stream_pairings p on p.id = s.pairing_id
                join fixture_stream_codes k on k.id = p.code_id where s.id = ${open.sid}`;
            expect([sp!.phone, sp!.code, sp!.standing], "the open session's pairing is the model's").toEqual([open.pairPhone, codes[open.pairIdx]!.code, open.holdAlive]);
          }
          invariantChecks++;
        }
        if (runIndex >= EXAMPLES.length) for (const o of reached) drawnRuns.set(o, drawnRuns.get(o)! + 1);
      }),
      { numRuns: RUNS, seed: Number(process.env.FC_SEED ?? 20261004), endOnFailure: true, examples: EXAMPLES.map((e) => [e]) },
    );

    // Anti-vacuity: every outcome reached, every run stepped; the I-2 / M-7 actions reached by DRAWN runs too.
    const zero = OUTCOMES.filter((o) => tally.get(o) === 0);
    const drawnZero = DRAWN_REQUIRED.filter((o) => drawnRuns.get(o) === 0);
    const report = `runs=${runs} drawnRuns=${runs - EXAMPLES.length} steps=${steps} skipped=${skipped} invariantChecks=${invariantChecks} pairingsCompared=${pairingsCompared} `
      + `${OUTCOMES.map((o) => `${o}=${tally.get(o)}`).join(" ")} | drawn runs reaching: ${DRAWN_REPORTED.map((o) => `${o}=${drawnRuns.get(o)}`).join(" ")}`;
    writeFileSync(`${tmpdir()}/capture-sequence-tally.txt`, report);
    expect(zero, `outcomes the sequences never reached — ${report}`).toEqual([]);
    expect(drawnZero, `I-2 / M-7 actions no DRAWN run reached — ${report}`).toEqual([]);
    expect(runs).toBe(RUNS);
    expect(invariantChecks).toBe(steps + skipped);
    expect(steps).toBeGreaterThan(runs);
    expect(pairingsCompared).toBeGreaterThan(0);
  }, 900_000);
});
