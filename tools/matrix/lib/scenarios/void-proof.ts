// VOIDPROOF (W1d Task 14, item 15e): the organiser undoes the last entry of a
// match in play — the console's "Void last entry" — and the product is held to
// it. The first scored fixture gets its start and its first score event, then
// the driver voids the newest event (the console's own rule), then two checks
// read what the product holds:
//
//   void-ledger  the ledger grew by exactly one row, a core.void, which names
//                the event voidLast reported; that event is the last one the
//                harness posted, of the type it posted, still in the ledger;
//                and the product's own state is the match still open.
//   void-fold    the engine's fold of the ledger (voids resolved) is the score
//                BEFORE the event — the fold of the stream the harness posted
//                minus its last event — and not the score with it; and that
//                event really moved the score, or the proof proves nothing.
//
// Then the division plays on: the fixture is resumed (Recorder.resumed) — the
// voided event posted AGAIN, then the rest of the match — and every other
// fixture is decided as ever, so the ledger a void left is the one the standings
// and the public table are judged on.
//
// Every expected value is the engine's or the harness's own stream's — never
// what voidLast answered. A void that is "reported" but never written, one that
// takes the wrong event, one whose fold still carries the score: each fails an
// item of its own (void-proof.test.ts mutates each).
import { foldMatchWithStoppage, type StageKind } from "@seazn/engine/core";
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import { VOID_EVENT, type FixtureStateOut, type VoidedOut } from "../driver/types.ts";
import { FOLD_OPTIONS, foldStream, lineupsFor } from "../fold.ts";
import { ledgerEnvelopes, type LedgerEntry } from "../model/ledger-fold.ts";
import type { CheckResult } from "../results.ts";
import { sportModule } from "../sport-cfg.ts";
import { generateStream } from "../streams/index.ts";
import { START, type StreamEvent } from "../streams/types.ts";
import { assertion, builtAsPosted, foldParity, loopBounded, publicStandingsMatch, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, defaultPolicy, playDivision, recordGenerate, recordPosted, seatedOpen, setUpDivision, snapshot, stageDrawsOk, type DivisionSetup } from "./common.ts";
import type { Scenario, ScenarioContext } from "./types.ts";

/** Three entrants, three fixtures: the proof is on the first, the rest is the division playing on. */
export const VOID_PROOF_ENTRANTS = 3;

/** The sport's stream is not one a void can be proven on, or the product held more than the harness posted.
 *  A harness fault, named — not a ScenarioUnsupported (the Q-A guard accepts a deferral only to an open wave). */
export class VoidProofUnfit extends Error {
  readonly sport: string;
  constructor(sport: string, why: string) {
    super(`VOIDPROOF (${sport}): ${why}`);
    this.name = "VoidProofUnfit";
    this.sport = sport;
  }
}

/** The void did not hold AND the division could not then be played on over the ledger it left (the engine or the
 *  product refused the re-recorded events). The two proof checks are carried in the message — a refusal over a
 *  broken ledger must not swallow the evidence that the ledger was broken. */
export class VoidNotHeld extends Error {
  readonly checks: readonly CheckResult[];
  constructor(sport: string, checks: readonly CheckResult[], playOn: unknown) {
    const failed = checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`).join("; ");
    super(`VOIDPROOF (${sport}): the void did not hold (${failed}) and playing the division on over that ledger was refused: ${playOn instanceof Error ? playOn.message : String(playOn)}`);
    this.name = "VoidNotHeld";
    this.checks = checks;
  }
}

const NO_LEDGER = "this driver has no ledger read — no void could be proven (only a driver that reads the ledger can show the row a void left)";

/** What the first fixture held before and after its void. `held`: the events the product kept for the harness's
 *  first post, as it holds them (the pad path's stored rows, else the events sent); `rows`: the ledger after the
 *  void (null: the driver reads none). */
export interface VoidProofObs {
  readonly fixtureId: string;
  readonly home: string;
  readonly away: string;
  readonly held: readonly StreamEvent[];
  readonly rows: readonly LedgerRow[] | null;
  readonly voided: VoidedOut;
  readonly state: FixtureStateOut;
}

/** void-ledger: what the ledger and the product's state say the void did. Every item is derived from the stream
 *  the harness posted (`held`), never from voidLast's own answer except where the two are compared. */
export function voidLedger(obs: VoidProofObs | null): CheckResult {
  if (obs === null) return assertion("void-ledger", []);
  const { rows, held, voided, state } = obs;
  if (rows === null) return assertion("void-ledger", [{ ok: false, note: NO_LEDGER }]);
  const n = held.length;
  const newest = rows.at(-1);
  const posted = held.at(-1);
  const target = rows[n - 1];
  const named = (newest?.payload as { event_id?: unknown } | null)?.event_id;
  const items: Item[] = [
    { ok: rows.length === n + 1, note: `the ledger holds ${rows.length} row(s), ${n + 1} expected (the ${n} the harness posted, and one void)` },
    { ok: newest?.type === VOID_EVENT, note: `the newest row is not a ${VOID_EVENT} (it is ${newest?.type ?? "absent"})` },
    { ok: named === voided.voidedEventId, note: `the void row names ${typeof named === "string" ? named : JSON.stringify(named)}, voidLast reported ${voided.voidedEventId}` },
    { ok: target !== undefined && target.id === voided.voidedEventId, note: `the voided event is not the last one the harness posted (seq ${n}, ${posted?.type ?? "none"}): voidLast reported ${voided.voidedEventId}, the ledger's row ${n} is ${target?.id ?? "absent"}` },
    { ok: target?.type === voided.voidedType && posted?.type === voided.voidedType, note: `type: voidLast reported ${voided.voidedType}, the ledger's row ${n} is ${target?.type ?? "absent"}, the harness posted ${posted?.type ?? "none"}` },
  ];
  const bad: string[] = [];
  if (state.last_seq !== rows.length) bad.push(`last_seq ${state.last_seq}, the ledger holds ${rows.length}`);
  if (state.status !== "in_play") bad.push(`status ${state.status}, not in_play`);
  if (state.outcome !== null) bad.push(`an outcome ${JSON.stringify(state.outcome)}, none expected`);
  items.push({ ok: bad.length === 0, note: `the product's state after the void: ${bad.join("; ")}` });
  return assertion("void-ledger", items);
}

/** The ledger's rows as the fold reads them: a core.void's `payload.event_id` lifted into `voids` (the product's
 *  own lift, usecases/scoring.ts; model/ledger-fold.ts). */
function entriesOf(rows: readonly LedgerRow[]): LedgerEntry[] {
  return rows.map((r) => {
    const target = r.type === VOID_EVENT ? (r.payload as { event_id?: unknown } | null)?.event_id : undefined;
    return { id: r.id, seq: r.seq, type: r.type, payload: r.payload, ...(typeof target === "string" ? { voids: target } : {}) };
  });
}

/** void-fold: the engine's fold of the ledger as the product holds it, against the engine's fold of the harness's
 *  own stream with and without the event. */
export function voidFold(sport: string, cfg: unknown, obs: VoidProofObs | null): CheckResult {
  if (obs === null) return assertion("void-fold", []);
  if (obs.rows === null) return assertion("void-fold", [{ ok: false, note: NO_LEDGER }]);
  const m = sportModule(sport);
  const summaryOf = (state: unknown): string => JSON.stringify(m.summary(state));
  let fromLedger: string;
  try {
    const state: unknown = foldMatchWithStoppage(m, cfg as never, lineupsFor(obs.home, obs.away), ledgerEnvelopes(obs.fixtureId, entriesOf(obs.rows)), FOLD_OPTIONS).state;
    fromLedger = summaryOf(state);
  } catch (e) {
    return assertion("void-fold", [{ ok: false, note: `the ledger does not fold: ${e instanceof Error ? e.message : String(e)}` }]);
  }
  const before = summaryOf(foldStream(m, cfg, obs.home, obs.away, obs.held.slice(0, -1)).state);
  const withEvent = summaryOf(foldStream(m, cfg, obs.home, obs.away, obs.held).state);
  return assertion("void-fold", [
    { ok: fromLedger === before, note: `the ledger folds to ${fromLedger}, the score before the event is ${before}` },
    { ok: withEvent !== before, note: `the event moved nothing (${before} with and without it): its void proves nothing` },
    { ok: fromLedger !== withEvent, note: `the ledger still folds to the score with the event (${withEvent})` },
  ]);
}

const byNo = (a: { fixture_no: number | null }, b: { fixture_no: number | null }) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0);

/** The fixture the proof is on: the lowest fixture number of the lowest round among the seated, open ones — the
 *  first the division would decide. Null when none is seated and open (an empty list has no lowest round: the filter finds nothing). */
export function firstOpenFixture<F extends { round_no: number | null; fixture_no: number | null }>(open: readonly F[]): F | null {
  const round = Math.min(...open.map((f) => f.round_no ?? 0));
  return open.filter((x) => (x.round_no ?? 0) === round).sort(byNo)[0] ?? null;
}

/** A void is proven on a start, a first score event that leaves the match open, and at least one event after it to
 *  re-record into. A stream that is not that — or whose first score event decides the match, which the console offers
 *  no Void last entry on — is refused by name before anything is posted. */
export function assertVoidable(sport: string, outcomeKind: string, generated: readonly StreamEvent[]): void {
  if (generated.length < 3 || generated[0]?.type !== START.type) {
    throw new VoidProofUnfit(sport, `its ${outcomeKind} stream is ${generated.length} event(s) (${generated.map((e) => e.type).join(", ")}) — a void is proven on a start, a first score event that leaves the match open, and at least one event after it`);
  }
}

/** The first fixture the division would decide gets its start and its first score event; the driver voids the
 *  newest; the ledger and the state are read. Leaves the fixture resumable (Recorder.resumed) with the harness's own
 *  stream — the two events and the void, the void naming its target by seq, as fold.ts numbers it. Null when no
 *  fixture is seated and open: nothing was voided, and both checks fail on checked 0. */
export async function postThenVoid(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<VoidProofObs | null> {
  const fixtures = await recordGenerate(ctx, rec, setup.stage.id);
  const f = firstOpenFixture((fixtures ?? []).filter(seatedOpen));
  if (f === null) return null;
  const sport = ctx.spec.sport;
  const home = f.home_entrant_id!;
  const away = f.away_entrant_id!;
  // The outcome playDivision's policy would pick for this fixture: it is the first decided, so ordinal 0 — a guard,
  // because the resumed stream is generated for it, and a policy that moved would be resumed over another stream.
  if (rec.decided !== 0) throw new VoidProofUnfit(sport, `a fixture was already decided (${rec.decided}) — the proof is on the first`);
  const outcome = defaultPolicy(setup, f, stageDrawsOk(ctx, setup.stage), rec.decided);
  const generated = generateStream({ sportKey: sport, cfg: ctx.cfg, stageKind: setup.stage.kind as StageKind, home, away, outcome });
  assertVoidable(sport, outcome.kind, generated);
  const first = generated.slice(0, 2);
  const posted = await ctx.driver.postStream(f.id, first, `${ctx.tag}:${f.id}`);
  const whole = recordPosted(rec, f.id, [], first, posted);
  rec.events += first.length;
  const tip = posted.at(-1);
  if (tip === undefined || tip.seq !== whole.length) {
    throw new VoidProofUnfit(sport, `fixture ${f.id}: the harness holds ${whole.length} event(s), the product's last answer is seq ${tip?.seq ?? "none"} — it holds events the harness never posted, so the first one cannot be said to be the last`);
  }
  if (tip.outcome !== null) {
    throw new VoidProofUnfit(sport, `its first score event (${generated[1].type}) decides the match — the console offers no Void last entry on a decided match, so nothing could be voided from the console`);
  }
  const voided = await ctx.driver.voidLast(f.id);
  const rows = ctx.driver.ledger === undefined ? null : await ctx.driver.ledger(f.id, 0);
  const state = await ctx.driver.fixtureState(f.id);
  // The harness's own record of the void: it meant to void the last event it posted, so that is what it keeps —
  // when the product voided another, the ledger no longer matches this stream and the checks and the parity say so.
  rec.streams.set(f.id, [...whole, { type: VOID_EVENT, payload: { event_id: String(whole.length) } }]);
  rec.events += 1;
  rec.resumed.set(f.id, { outcome, live: whole.length - 1, voidedType: whole[whole.length - 1].type });
  return { fixtureId: f.id, home, away, held: whole, rows, voided, state };
}

export const voidProof: Scenario = {
  key: "VOIDPROOF",
  entrantCount: VOID_PROOF_ENTRANTS,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    // A team sport scores on rosterless team entrants, as PADPROOF does: no lineup is owed (common.ts SetUpOptions).
    const setup = await setUpDivision(ctx, rec, VOID_PROOF_ENTRANTS, { rosterlessTeams: true });
    const proof = await postThenVoid(ctx, rec, setup);
    const proofChecks = [voidLedger(proof), voidFold(ctx.spec.sport, ctx.cfg, proof)];
    let plays: Awaited<ReturnType<typeof playDivision>>;
    try {
      plays = await playDivision(ctx, rec, setup);
    } catch (e) {
      // A refusal over a ledger the void left wrong is the proof's finding, not a second, unrelated error.
      if (proofChecks.some((c) => c.verdict === "fail")) throw new VoidNotHeld(ctx.spec.sport, proofChecks, e);
      throw e;
    }
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        publicStandingsMatch(observed, pub),
        ...proofChecks,
        stageCompleted(observed),
        loopBounded(rec, observed),
      ],
    };
  },
};
