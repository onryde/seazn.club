// Capacity test 13 (spec §8.1, §5.7.3): the check-in line is FIRST COME, FIRST SERVED - admission follows ARRIVAL, whatever order the
// clients poll in, and the order checkers themselves can fail.
//
// Driven through the real gate (`gateClaim`) against the database, with the bucket refilled ONE TOKEN AT A TIME and the clients
// polling in REVERSED and in SHUFFLED order (never arrival order), so the outcome cannot follow the polling order. The expected
// order is the ARRIVAL order the test itself fixed; the checkers (e2e/load/line-checks.ts, shared with the load harness) read the
// ledger's own facts. Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); the gate does not
// know a sport.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { boardAnchor } from "@/server/external-play/window";
import { endStay, gateClaim, settleDeferral, type GateAnswer, type GateAsk } from "@/server/external-play/seat-line";
import { LINE_RESERVATION } from "@/server/external-play/seat-line";
import { admissionInversions, completionReorders, positionRises, type PositionSample, type StayFacts } from "../../../../e2e/load/line-checks";
import { seedOnlineChessFixture } from "./_external-play-seed";
import { configureRealtimeKit } from "./_external-play-rtk-fake";
import { clearBucket, putStay, setBucket, stayRow, stubBucket } from "./_external-play-line";

const DB = !!process.env.DATABASE_URL;
const T0 = new Date(Date.now() - 60_000);
const ANCHOR = boardAnchor(new Date(T0.getTime() - 5 * 60_000), 0, false);
const at = (ms: number) => new Date(T0.getTime() + ms);

type Seeded = Awaited<ReturnType<typeof seedOnlineChessFixture>>;
const seed = () =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(T0.getTime() + 600_000),
    linked: true,
    roundOpenedAt: new Date(T0.getTime() - 5 * 60_000),
    cameraPolicy: "required",
  });

let key = "";
beforeAll(() => {
  if (!DB) return;
  configureRealtimeKit();
});
beforeEach(() => {
  if (!DB) return;
  configureRealtimeKit();
  key = stubBucket();
});
afterEach(async () => {
  if (DB) await clearBucket(key);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (DB) await sql.end();
});

const ask = (s: Seeded, when: Date, over: Partial<GateAsk> = {}): GateAsk => ({
  fixtureId: s.fixtureId,
  personId: s.home.personId,
  otherPersonId: s.away.personId,
  otherCounted: false,
  budgetKey: key,
  anchor: ANCHOR,
  at: when,
  ...over,
});

/** A tiny seeded shuffle: the order the clients poll in, reproducible, never the arrival order. */
function shuffled<T>(xs: T[], seedN: number): T[] {
  const out = [...xs];
  let x = seedN;
  for (let i = out.length - 1; i > 0; i -= 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function facts(boards: Seeded[]): Promise<StayFacts[]> {
  const out: StayFacts[] = [];
  for (const [i, s] of boards.entries()) {
    const r = await stayRow(s.fixtureId, s.home.personId);
    if (!r) continue;
    out.push({
      id: `p${i}`,
      firstClaimAt: r.first_claim_at.getTime(),
      queuedAt: r.queued_at?.getTime() ?? null,
      admittedAt: r.admitted_at?.getTime() ?? null,
      servedAt: r.served_at?.getTime() ?? null,
    });
  }
  return out;
}

describe.skipIf(!DB)("FIFO admission with tokens one at a time, polled out of order (test 13)", () => {
  const N = 6;

  it("N players arrive in a known order; the bucket refills a token at a time; clients poll reversed then shuffled: admission follows arrival (pairs checked reported)", async () => {
    const boards: Seeded[] = [];
    for (let i = 0; i < N; i += 1) boards.push(await seed());
    await setBucket(key, 0, T0);

    // p0 passes on the empty line (the line is idle: today's path) and its claim is then deferred mid-claim: the budget has held it.
    const first = await gateClaim(ask(boards[0]!, at(0)));
    expect(first, "premise: an empty line lets the first arrival through").toEqual({ kind: "go", decision: "idle" });
    const held0 = await settleDeferral(ask(boards[0]!, at(1)));
    expect(held0.kind, "premise: the deferral queues it").toBe("queued");
    // The rest arrive 10 ms apart, each behind a waiting stay: joined at the tail, nothing spent.
    for (let i = 1; i < N; i += 1) {
      const a = await gateClaim(ask(boards[i]!, at(10 * i)));
      expect(a.kind, `p${i} arrives behind a waiting stay`).toBe("queued");
      if (a.kind === "queued") expect(a.line.position, `p${i}'s place`).toBe(i + 1);
    }

    let admissions = 0;
    let step = 0;
    let tokens = 0;
    const admittedIds: number[] = [];
    // One token a step, a second apart; every client polls each step (nobody lapses: a second is well inside the abandon grace).
    while (admissions < N && step < 40 * N) {
      step += 1;
      tokens += 1;
      const t = 1_000 * step;
      await setBucket(key, tokens, at(t));
      // Only the players still in line poll: a served player does not claim again (their next claim would be a new stay).
      const waiting = [...Array(N).keys()].filter((i) => !admittedIds.includes(i));
      const order = step % 2 === 1 ? [...waiting].reverse() : shuffled(waiting, step);
      for (const [k, i] of order.entries()) {
        const a: GateAnswer = await gateClaim(ask(boards[i]!, at(t + k)));
        if (a.kind === "go" && a.decision === "admit") {
          admissions += 1;
          admittedIds.push(i);
          // The admitted stay is served at the next step's start, spending its reservation from the bucket.
          await endStay({ fixtureId: boards[i]!.fixtureId, personId: boards[i]!.home.personId, how: "served", at: at(t + 500) });
          tokens = Math.max(0, tokens - LINE_RESERVATION);
        }
      }
    }
    expect(admissions, "everyone was admitted").toBe(N);
    expect(admittedIds, "in ARRIVAL order, whatever the polling order was").toEqual([...Array(N).keys()]);

    const inv = admissionInversions(await facts(boards));
    expect(inv.pairs, "anti-vacuity: pairs checked").toBe((N * (N - 1)) / 2);
    expect(inv.inversions, `admission inversions (${JSON.stringify(inv.examples)})`).toBe(0);
  }, 240_000);

  it("completion is not order: X admitted first with a slow camera, Y next with an instant one, is served Y first - 0 inversions and 1 completion reorder, counted apart", async () => {
    const [x, y] = [await seed(), await seed()];
    // A waiting head holds the line active; X and Y are admitted in order and served the other way round.
    const base = at(0);
    await setBucket(key, 0, base);
    await gateClaim(ask(x, at(0)));
    await settleDeferral(ask(x, at(1)));
    await gateClaim(ask(y, at(10)));
    await setBucket(key, LINE_RESERVATION, at(1_000));
    expect((await gateClaim(ask(x, at(1_000)))).kind, "X is admitted").toBe("go");
    await setBucket(key, 2 * LINE_RESERVATION, at(2_000));
    expect((await gateClaim(ask(y, at(2_000)))).kind, "Y is admitted next").toBe("go");
    await endStay({ fixtureId: y.fixtureId, personId: y.home.personId, how: "served", at: at(3_000) });
    await endStay({ fixtureId: x.fixtureId, personId: x.home.personId, how: "served", at: at(13_000) });

    const all = await facts([x, y]);
    const inv = admissionInversions(all);
    const reorder = completionReorders(all);
    expect(inv.pairs, "anti-vacuity: the pair was looked at").toBe(1);
    expect(inv.inversions, "admission followed arrival").toBe(0);
    expect(reorder.pairs, "anti-vacuity: the completion pair was looked at").toBe(1);
    expect(reorder.reorders, "served in the other order: one reorder, not an inversion").toBe(1);
  });
});

describe("the order checkers can fail (test 13, mutation targets)", () => {
  const stay = (id: string, first: number, queued: number | null, admitted: number | null, served: number | null = null): StayFacts => ({
    id,
    firstClaimAt: first,
    queuedAt: queued,
    admittedAt: admitted,
    servedAt: served,
  });

  it("admission inversions: a later arrival admitted first is reported, with the pair named; the in-order case is clean; stays never held are out of the pairs", () => {
    const inverted = admissionInversions([stay("a", 100, 110, 900), stay("b", 200, 210, 500), stay("c", 300, 310, 950)]);
    expect(inverted.pairs).toBe(3);
    expect(inverted.inversions).toBe(1);
    expect(inverted.examples).toEqual([["a", "b"]]);
    const ordered = admissionInversions([stay("a", 100, 110, 500), stay("b", 200, 210, 600), stay("c", 300, 310, 700)]);
    expect([ordered.pairs, ordered.inversions]).toEqual([3, 0]);
    // A stay admitted without ever being held (queuedAt null) is not in line and is not paired.
    expect(admissionInversions([stay("a", 100, null, 900), stay("b", 200, 210, 500)]).pairs).toBe(0);
  });

  it("completion reorders are counted apart: admitted a-then-b and served b-then-a is a reorder and NOT an inversion", () => {
    const pair = [stay("a", 100, 110, 500, 900), stay("b", 200, 210, 600, 700)];
    expect(admissionInversions(pair).inversions).toBe(0);
    expect(completionReorders(pair)).toEqual({ pairs: 1, reorders: 1 });
    expect(completionReorders([stay("a", 100, 110, 500, 700), stay("b", 200, 210, 600, 900)])).toEqual({ pairs: 1, reorders: 0 });
  });

  it("(e) a rise with a cause is EXCUSED and named; a rise nothing explains is UNEXCUSED - the classes are neither empty nor total (1 and 1)", () => {
    // X arrived first and was first held late (800); Y arrived at 200 and was held at 210; Z is ahead of everyone.
    const stays = [stay("X", 100, 800, null), stay("Y", 200, 210, null), stay("Z", 50, 60, null)];
    const samples: PositionSample[] = [
      { id: "Y", at: 400, position: 1 },
      { id: "Y", at: 900, position: 2 }, // X was first held in (400, 900] with an earlier key: excused
      { id: "Z", at: 400, position: 1 },
      { id: "Z", at: 900, position: 2 }, // nothing was first held ahead of Z's key: unexcused
    ];
    const got = positionRises(samples, stays);
    expect(got.looked, "anti-vacuity: consecutive sample pairs looked at").toBe(2);
    expect(got.excused.map((r) => [r.id, r.cause])).toEqual([["Y", "X"]]);
    expect(got.unexcused.map((r) => r.id)).toEqual(["Z"]);
    expect([got.excused.length, got.unexcused.length]).toEqual([1, 1]);
    // A number that falls, or holds, is not a rise at all.
    const flat = positionRises([{ id: "Y", at: 1, position: 3 }, { id: "Y", at: 2, position: 2 }, { id: "Y", at: 3, position: 2 }], stays);
    expect([flat.looked, flat.excused.length, flat.unexcused.length]).toEqual([2, 0, 0]);
  });
});

describe("the order checkers: every boundary (test 13, mutation targets of the edges)", () => {
  const stay = (id: string, first: number, queued: number | null, admitted: number | null, served: number | null = null): StayFacts => ({
    id,
    firstClaimAt: first,
    queuedAt: queued,
    admittedAt: admitted,
    servedAt: served,
  });

  it("admission inversions: a tie in ARRIVAL has no order to invert and is not a pair; admitted in the SAME instant is not inverted (2 cases, pairs reported)", () => {
    const tie = admissionInversions([stay("a", 100, 110, 900), stay("b", 100, 110, 500)]);
    expect(tie.pairs, "a tie in arrival is no pair at all").toBe(0);
    expect(tie.inversions).toBe(0);
    const sameInstant = admissionInversions([stay("a", 100, 110, 500), stay("b", 200, 210, 500)]);
    expect(sameInstant.pairs, "anti-vacuity: the pair was looked at").toBe(1);
    expect(sameInstant.inversions, "admitted in the same instant is in order").toBe(0);
    const oneApart = admissionInversions([stay("a", 100, 110, 501), stay("b", 200, 210, 500)]);
    expect([oneApart.pairs, oneApart.inversions], "one millisecond the wrong way IS an inversion").toEqual([1, 1]);
  });

  it("completion reorders: two stays admitted in the same instant have no admission order to reorder and are not a pair", () => {
    const got = completionReorders([stay("a", 100, 110, 500, 900), stay("b", 200, 210, 500, 700)]);
    expect(got, "same admission instant: no pair").toEqual({ pairs: 0, reorders: 0 });
    expect(completionReorders([stay("a", 100, 110, 500, 900), stay("b", 200, 210, 501, 700)]), "one millisecond apart IS a pair, and a reorder").toEqual({ pairs: 1, reorders: 1 });
  });

  it("a rise is excused only by a stay first held AFTER the previous sample (strictly), up to and INCLUDING this sample, with an EARLIER arrival key (strictly) - each edge, one at a time (4 cases)", () => {
    // Y arrived at 200, was held at 210; samples at 400 then 900: Y's number rose from 1 to 2. X is the candidate cause.
    const rise = (x: StayFacts) =>
      positionRises(
        [
          { id: "Y", at: 400, position: 1 },
          { id: "Y", at: 900, position: 2 },
        ],
        [x, stay("Y", 200, 210, null)],
      );
    const causeOf = (x: StayFacts) => rise(x).excused.map((r) => r.cause);
    expect(causeOf(stay("X", 100, 401, null)), "held one ms after the previous sample: a cause").toEqual(["X"]);
    expect(causeOf(stay("X", 100, 400, null)), "held AT the previous sample: already there, not a cause").toEqual([]);
    expect(causeOf(stay("X", 100, 900, null)), "held AT this sample: a cause (the sample saw it)").toEqual(["X"]);
    expect(causeOf(stay("X", 100, 901, null)), "held after this sample: not yet").toEqual([]);
    expect(causeOf(stay("X", 199, 500, null)), "arrived one ms before: a cause").toEqual(["X"]);
    expect(causeOf(stay("X", 200, 500, null)), "arrived at the SAME instant: no earlier key, not a cause").toEqual([]);
    expect(causeOf(stay("X", 201, 500, null)), "arrived after: not a cause").toEqual([]);
    expect(rise(stay("X", 200, 500, null)).unexcused.map((r) => r.id), "and the rise is then unexcused").toEqual(["Y"]);
  });
});

describe.skipIf(!DB)("the excused rise, through the real gate (test 13 (e), the re-review's N3)", () => {
  it("X passes on an empty line and is never held; Y arrives and is held at 1; X's next claim is deferred, so X is first held AFTER Y with an earlier key: Y's number rises 1 -> 2, once, excused with X as the cause", async () => {
    const [x, y, z] = [await seed(), await seed(), await seed()];
    await setBucket(key, 0, at(0));
    expect((await gateClaim(ask(x, at(0)))).kind, "X passes on the empty line").toBe("go");
    // The line becomes active: another player's stay is ADMITTED and live (not counted in positions).
    await putStay({ fixtureId: z.fixtureId, personId: z.home.personId, budgetKey: key, firstClaimAt: at(5), seenAt: at(5), gate: "passed", queuedAt: at(5), admittedAt: at(6) });
    const samples: PositionSample[] = [];
    const a = await gateClaim(ask(y, at(10)));
    expect(a.kind).toBe("queued");
    if (a.kind === "queued") samples.push({ id: "Y", at: 10, position: a.line.position });
    expect(samples[0]!.position, "Y is first in line").toBe(1);
    // X's next claim meets a dry bucket mid-claim: the budget holds X now, behind nobody - but AHEAD of Y by key.
    const deferred = await settleDeferral(ask(x, at(500)));
    expect(deferred.kind).toBe("queued");
    const b = await gateClaim(ask(y, at(900)));
    expect(b.kind).toBe("queued");
    if (b.kind === "queued") samples.push({ id: "Y", at: 900, position: b.line.position });
    expect(samples[1]!.position, "Y's number rose").toBe(2);

    const stays: StayFacts[] = [];
    for (const [id, s] of [["X", x], ["Y", y]] as const) {
      const r = await stayRow(s.fixtureId, s.home.personId);
      stays.push({ id, firstClaimAt: r!.first_claim_at.getTime(), queuedAt: r!.queued_at?.getTime() ?? null, admittedAt: null, servedAt: null });
    }
    const rises = positionRises(samples.map((smp) => ({ ...smp, at: T0.getTime() + smp.at })), stays);
    expect(rises.looked, "anti-vacuity: a pair of samples looked at").toBe(1);
    expect(rises.excused.map((r) => [r.id, r.from, r.to, r.cause])).toEqual([["Y", 1, 2, "X"]]);
    expect(rises.unexcused, "and nothing unexplained").toEqual([]);
  });
});
