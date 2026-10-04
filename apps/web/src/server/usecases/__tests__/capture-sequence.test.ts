// Capture QR v2 — the phone's routes as a SEQUENCE (TEST-STRATEGY rule 10). Drawn orderings of claim, beat, start, the
// ingest connecting, the phone's Stop and the organiser's reissue, two phones, a fresh fixture per run, through the
// REAL use-cases (postBeat, postStart, tickSession, reissueStreamCode) on fake drivers. After every step the answer is
// checked against a MODEL written from the spec, never from capture-phone.ts:
//   - C1b (§6.3): an ENDED code refuses a claim and a start 401 code_ended — even for its open session's phone — and
//     serves a beat only to the open session's phone;
//   - §5.5, first row wins, for a `new` claim on the current code against the HOLDER (the open session's phone while
//     its pairing stands, across a reissue; else the code's current pairing): T1 nobody or itself → accepted; T3 the
//     slot is live (the open session has ingested) → taken; T2 otherwise → takeover (the holder's pairing ends, and an
//     open session moves to the claimer). T4 (a dead holder) is out of reach by construction: the clock moves at most
//     4 s a step, never the 60 s A14 asks for;
//   - T12 → T13 → T15 (§6.3.4, in that order): a phone that is not the HOLDER (the same C a claim is judged against —
//     across a reissue, the open session's phone: C-2) is `replaced`; then a running session answers already_live
//     naming its sid and `operator`; else 200 {sid} starts one;
//   - T21 (§6.5): the session's phone's `ended` naming its sid is the operator's Stop — its pairing ends.
// And the invariants, after every step: at most ONE open session on the fixture; one session row per 200; every row
// started by `operator`, attributed to the code's issuer, carrying a pairing (T6 m-2).
//
// The tally reports every outcome it reached; a zero is a FAILURE (anti-vacuity) — a property that never drew a 401 on
// an ended code proved nothing about C1b. The seed is fixed so the tally is reproducible; FC_SEED overrides it.
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
import { tickSession } from "../stream-sessions";
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
  | { kind: "start"; phone: 0 | 1; via: Via }
  | { kind: "ingest" }
  | { kind: "stop" }
  | { kind: "reissue" };
const RUNS = 100;
/** Two hand-written orderings, run FIRST and inside RUNS (fast-check's examples), so the rarest rows are reached on
 *  every seed: T3 (a live slot is taken) and T13 (already_live, on a running and then an ending session), then a
 *  claim while the Stop drains; and a reissue under an open session (C1b on the old code for its phone's start and
 *  claim, its beat still served) followed by a takeover on the new code. The drawn runs supply the rest. */
const EXAMPLES: Act[][] = [
  [
    { kind: "claim", phone: 0, via: "current" }, { kind: "start", phone: 0, via: "current" }, { kind: "ingest" },
    { kind: "claim", phone: 1, via: "current" }, { kind: "start", phone: 0, via: "current" }, { kind: "stop" },
    { kind: "claim", phone: 1, via: "current" }, { kind: "start", phone: 1, via: "current" },
  ],
  [
    { kind: "claim", phone: 0, via: "current" }, { kind: "start", phone: 0, via: "current" }, { kind: "reissue" },
    { kind: "start", phone: 0, via: "old" }, { kind: "claim", phone: 0, via: "old" }, { kind: "beat", phone: 0 },
    { kind: "claim", phone: 1, via: "current" }, { kind: "beat", phone: 0 }, { kind: "start", phone: 1, via: "current" },
  ],
];
const phoneArb = fc.constantFrom<0 | 1>(0, 1);
const viaArb = fc.constantFrom<Via>("current", "current", "old");
const actArb: fc.Arbitrary<Act> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("claim" as const), phone: phoneArb, via: viaArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("beat" as const), phone: phoneArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("start" as const), phone: phoneArb, via: viaArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("ingest" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stop" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reissue" as const) }) },
);

/** The outcomes the model can name. Every one must be reached at least once. */
const OUTCOMES = [
  "claim:accepted", "claim:takeover", "claim:taken", "claim:ended-401",
  "beat:answered", "beat:ended-401",
  "start:200", "start:already_live", "start:replaced", "start:ended-401",
  "ingest:live", "stop:applied", "reissue:applied",
] as const;
type Outcome = (typeof OUTCOMES)[number];

/** The refusal a call threw, or null when it answered. */
async function outcomeOf<T>(p: Promise<T>): Promise<{ ok: T } | { refused: CaptureRefusalError }> {
  try {
    return { ok: await p };
  } catch (e) {
    if (e instanceof CaptureRefusalError) return { refused: e };
    throw e;
  }
}

describe.skipIf(!HAS_DB)("the phone's routes as a SEQUENCE — drawn orderings of claim, beat, start, Stop and reissue (rule 10)", () => {
  it("every answer matches the spec's model (C1b, T1–T8, T12→T13→T15, T21); at most one open session; one row per 200, each operator, by the issuer, with a pairing; every outcome reached", async () => {
    const tally = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]));
    const count = (o: Outcome) => tally.set(o, tally.get(o)! + 1);
    let runs = 0;
    let steps = 0;
    let skipped = 0;
    let invariantChecks = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(actArb, { minLength: 3, maxLength: 12 }), async (acts) => {
        runs++;
        const r: CaptureRig = await captureRig({ credits: 5 });
        await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
        const issuer = (await sql<{ issued_by: string }[]>`select issued_by from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`)[0]!.issued_by;
        const phones = [phoneId("a"), phoneId("b")] as const;

        // ---- the model ----
        const codes: { code: string; tok: string }[] = [{ code: r.code, tok: r.tok }];
        const currentIdx = () => codes.length - 1;
        /** phone → the code index it is the current pairing on (slot 0), while that pairing has not ended. */
        const pairedOn = new Map<string, number>();
        /** The open session: its sid; its phone while that phone's pairing stands (null once T21 ended it); whether it
         *  has ingested (the slot is live); whether a Stop has moved it to `ending` (still open). */
        // `as`, not an annotation: `step` reassigns it, and an annotated `= null` narrows to null outside the closure.
        let open = null as { sid: string; phone: string | null; ingested: boolean; ending: boolean } | null;
        let started = 0;
        const viaCode = (via: Via) => (via === "current" || codes.length === 1 ? currentIdx() : currentIdx() - 1);
        const pairedPhoneOn = (idx: number) => [...pairedOn].find(([, i]) => i === idx)?.[0] ?? null;

        const beatBody = (code: string, phone: string, over: Record<string, unknown> = {}) => CaptureBeat.parse({
          code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
          cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
          delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
          appVersion: "capture-test/1", ...over,
        });

        const step = async (a: Act): Promise<boolean> => {
          switch (a.kind) {
            case "claim": {
              const X = phones[a.phone];
              const idx = viaCode(a.via);
              const c = codes[idx]!;
              const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(c.code, X, { claim: "new" }), r.deps, r.now()));
              if (idx !== currentIdx()) {
                expect("refused" in got && got.refused.status === 401 && got.refused.code === "code_ended", "C1b: a claim on an ended code").toBe(true);
                count("claim:ended-401");
                return true;
              }
              expect("ok" in got, `a claim on the current code answers: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
              const answer = CaptureBeatAnswer.parse((got as { ok: unknown }).ok);
              const holder = open?.phone ?? pairedPhoneOn(idx);
              if (holder === null || holder === X) {
                // T1: the phone holds the slot now. A re-claim by the holder is process death: nothing moves, its
                // pairing stays where it is (across a reissue, on the old code — C-2); nobody held it → a new pairing here.
                expect(["taken", "replaced"], "T1: accepted").not.toContain(answer.state);
                if (holder === null) pairedOn.set(X, idx);
                count("claim:accepted");
              } else if (open?.ingested) {
                expect(answer.state, "T3: the slot is live and its phone is not dead").toBe("taken");
                count("claim:taken");
              } else {
                expect(["taken", "replaced"], "T2: a takeover seats the claimer").not.toContain(answer.state);
                // The holder's pairing on the code it held the slot through: the open session's (any code, C-2), else
                // this one. A pairing on an older code is untouched (T30: old pairings are unaffected until they call).
                const heldOn = open?.phone === holder ? pairedOn.get(holder)! : idx;
                const [held] = await sql<{ n: number }[]>`
                  select count(*)::int as n from fixture_stream_pairings p join fixture_stream_codes k on k.id = p.code_id
                   where k.code = ${codes[heldOn]!.code} and p.phone = ${holder} and p.ended_at is null`;
                expect(held!.n, "T2: the holder's pairing ended").toBe(0);
                pairedOn.delete(holder);
                pairedOn.set(X, idx);
                if (open && open.phone === holder) open = { ...open, phone: X };
                count("claim:takeover");
              }
              return true;
            }
            case "beat": {
              const X = phones[a.phone];
              const idx = pairedOn.get(X);
              if (idx === undefined) return false;   // only a seated phone beats here
              const c = codes[idx]!;
              const servesIt = idx === currentIdx() || (open !== null && open.phone === X);
              const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(c.code, X), r.deps, r.now()));
              if (!servesIt) {
                expect("refused" in got && got.refused.status === 401 && got.refused.code === "code_ended", "C1b/C3: an ended code serves only its open session's phone").toBe(true);
                count("beat:ended-401");
                return true;
              }
              expect("ok" in got, `the current phone's beat answers: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
              const answer = CaptureBeatAnswer.parse((got as { ok: unknown }).ok);
              expect(["taken", "replaced"], "a seated phone's beat is never taken or replaced (no clock moves, no takeover)").not.toContain(answer.state);
              count("beat:answered");
              return true;
            }
            case "start": {
              const X = phones[a.phone];
              const idx = viaCode(a.via);
              const c = codes[idx]!;
              const got = await outcomeOf(postStart(c.code, c.tok, { phone: X }, r.deps, r.now()));
              if (idx !== currentIdx()) {
                expect("refused" in got && got.refused.status === 401 && got.refused.code === "code_ended", "C1b: an ended code starts nothing").toBe(true);
                count("start:ended-401");
              } else if ((open?.phone ?? pairedPhoneOn(idx)) !== X) {
                // T12 first: a phone that is not the holder is never told a sid.
                expect("refused" in got ? [got.refused.status, got.refused.code, got.refused.extras] : got, "T12").toEqual([409, "replaced", undefined]);
                count("start:replaced");
              } else if (open !== null) {
                expect("refused" in got ? [got.refused.status, got.refused.code, got.refused.extras] : got, "T13").toEqual([409, "already_live", { sid: open.sid, startedBy: "operator" }]);
                count("start:already_live");
              } else {
                expect("ok" in got, `T15: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
                const ok = CaptureStartOk.parse((got as { ok: unknown }).ok);
                open = { sid: ok.sid, phone: X, ingested: false, ending: false };
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
              if (open === null || open.ending || open.phone === null) return false;
              const holder = open.phone;
              const idx = pairedOn.get(holder);
              expect(idx, "the session's phone is seated").toBeDefined();
              if (idx === undefined) return false;
              const c = codes[idx]!;
              const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(c.code, holder, { state: "ended", sid: open.sid, endReason: "operator-stopped" }), r.deps, r.now()));
              expect("ok" in got, `T21: the session's phone's Stop answers: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
              pairedOn.delete(holder);   // T21: the operator's Stop ends the phone's pairing
              const [row] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${open.sid}`;
              open = (ACTIVE_STATES as readonly string[]).includes(row!.state) ? { ...open, phone: null, ending: true } : null;
              count("stop:applied");
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
          invariantChecks++;
        }
      }),
      { numRuns: RUNS, seed: Number(process.env.FC_SEED ?? 20261004), endOnFailure: true, examples: EXAMPLES.map((e) => [e]) },
    );

    // Anti-vacuity: every outcome reached, every run stepped.
    const zero = OUTCOMES.filter((o) => tally.get(o) === 0);
    const report = `runs=${runs} steps=${steps} skipped=${skipped} invariantChecks=${invariantChecks} ${OUTCOMES.map((o) => `${o}=${tally.get(o)}`).join(" ")}`;
    writeFileSync(`${tmpdir()}/capture-sequence-tally.txt`, report);
    expect(zero, `outcomes the drawn sequences never reached — ${report}`).toEqual([]);
    expect(runs).toBe(RUNS);
    expect(invariantChecks).toBe(steps + skipped);
    expect(steps).toBeGreaterThan(runs);
  }, 600_000);
});
