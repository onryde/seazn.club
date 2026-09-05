// W2 — the OTHER half of R4's three import ceilings.
//
// WHAT WAS ALREADY THERE. `assertWithinCaps` (event-import.ts:89, called from
// `runImport` before any read, any lock work and any write) enforces exactly
// the "total events in the request" bound this wave went looking for:
// `IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000, eventsPerCall: 10_000 }`,
// 413 `import.too_large` carrying `cap`, `limit` and `actual`. Three tests in
// `event-import-dryrun.test.ts` cover it — and all three are OVER the cap.
//
// WHY THAT IS NOT ENOUGH. A one-sided boundary is satisfied by a guard that
// refuses everything, which this repo has shipped twice. Concretely: flip
// `>` to `>=` in `assertWithinCaps` and the whole branch stays green for two
// of the three ceilings —
//
//   * streams:          nothing imports exactly 50 streams;
//   * eventsPerCall:    nothing imports exactly 10,000 events;
//   * eventsPerFixture: killed by the per-CALL test alone, and only by
//                       accident — it builds streams of exactly 1,000 so the
//                       per-fixture branch must NOT fire, and asserts
//                       `cap: "eventsPerCall"`. Pinned here on purpose so it
//                       survives that test being rewritten.
//
// WHY THE AT-CAP CALLS ARE CHEAP. `appendEventInTx` re-folds the whole prior
// stream on every append (O(n²) per fixture), so importing 10,000 events for
// real is not a test, it is a hang. It does not need to be: `runStream`
// resolves the fixture FIRST (event-import.ts:191) and returns
// `import.fixture_unknown` before it looks at the events, so a stream whose
// `ext_key` matches nothing carries its full event array past
// `assertWithinCaps` and no further. The events still count — the cap reads
// `stream.events.length` — which is the whole point. The streams case does
// include one stream that genuinely writes, so "accepted" is not proven by
// rejections alone.
//
// Every number here is DERIVED from `IMPORT_CAPS`. Moving a ceiling moves
// these tests with it instead of leaving them asserting yesterday's numbers.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { importEvents, IMPORT_CAPS } from "../event-import";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

type Stream = {
  fixture: { id: string } | { ext_key: string };
  events: Array<{ type: string; payload: Record<string, unknown> }>;
};

/** Streams whose ext_keys resolve to no fixture in the division, carrying
 *  `total` events between them and never more than `per` in any one. */
function unresolvableStreams(total: number, per: number, tag: string): Stream[] {
  const out: Stream[] = [];
  for (let left = total, i = 0; left > 0; i++) {
    const n = Math.min(per, left);
    out.push({
      fixture: { ext_key: `${tag}-${i}` },
      events: Array.from({ length: n }, () => ({ type: "core.start", payload: {} })),
    });
    left -= n;
  }
  return out;
}

const totalEvents = (streams: Stream[]) => streams.reduce((n, s) => n + s.events.length, 0);

describe.skipIf(!HAS_DB)("importEvents — the import ceilings are inclusive", () => {
  it("accepts a call with exactly IMPORT_CAPS.streams streams, and imports through it", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const tag = randomUUID().slice(0, 8);

    // One real stream so this proves ACCEPTANCE, not just "no 413": at the
    // ceiling the call still writes. The remaining fillers resolve to nothing.
    const streams: Stream[] = [
      { fixture: { id: fixtureId }, events: decidingStream() },
      ...unresolvableStreams(IMPORT_CAPS.streams - 1, 1, tag),
    ];
    expect(streams).toHaveLength(IMPORT_CAPS.streams);
    // The other two ceilings must not be able to answer for this one.
    expect(totalEvents(streams)).toBeLessThanOrEqual(IMPORT_CAPS.eventsPerCall);

    const report = await importEvents(auth, divisionId, {
      import_id: `imp-at-streams-${tag}`,
      streams,
    });
    expect(report.results).toHaveLength(IMPORT_CAPS.streams);
    expect(report.totals.imported).toBe(1);
    expect(report.results[0]!.status).toBe("imported");
  });

  it("accepts a stream carrying exactly IMPORT_CAPS.eventsPerFixture events", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await startedDivisionWithFixture(auth);
    const tag = randomUUID().slice(0, 8);

    const streams = unresolvableStreams(
      IMPORT_CAPS.eventsPerFixture,
      IMPORT_CAPS.eventsPerFixture,
      tag,
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]!.events).toHaveLength(IMPORT_CAPS.eventsPerFixture);

    const report = await importEvents(auth, divisionId, {
      import_id: `imp-at-fixture-${tag}`,
      streams,
    });
    // The call executed — the stream got as far as fixture resolution, which
    // is one step PAST the ceiling that would have thrown 413.
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.error?.code).toBe("import.fixture_unknown");
  });

  it("accepts a call carrying exactly IMPORT_CAPS.eventsPerCall events", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await startedDivisionWithFixture(auth);
    const tag = randomUUID().slice(0, 8);

    const streams = unresolvableStreams(
      IMPORT_CAPS.eventsPerCall,
      IMPORT_CAPS.eventsPerFixture,
      tag,
    );
    // Both of the earlier ceilings are clear, so the per-CALL one is the only
    // branch that could refuse this — without these two the test could pass
    // while proving something about a different cap.
    expect(streams.length).toBeLessThanOrEqual(IMPORT_CAPS.streams);
    for (const s of streams) {
      expect(s.events.length).toBeLessThanOrEqual(IMPORT_CAPS.eventsPerFixture);
    }
    expect(totalEvents(streams)).toBe(IMPORT_CAPS.eventsPerCall);

    const report = await importEvents(auth, divisionId, {
      import_id: `imp-at-call-${tag}`,
      streams,
    });
    expect(report.results).toHaveLength(streams.length);
    expect(report.totals.rejected).toBe(streams.length);
  });
});
