// Final review I-4, second half. Validating `at` at the schema (schemas.ts)
// closes the ONE trigger that was found; this closes the class. Design doc §4
// promises "200 whenever the call executed — per-stream outcomes are data, not
// transport errors", and an unexpected throw out of `runStream` broke that
// promise in the worst possible way: it discarded the whole report, including
// the streams that had ALREADY COMMITTED, so the operator was told nothing
// happened while some fixtures were fully imported.
//
// The trigger used here is the real one the review found, reached the way a
// non-HTTP caller reaches it: `importEvents` is a usecase, and a usecase called
// directly never sees the route's `.parse()`. A malformed `at` survives the
// engine envelope (`.min(1)`) and the dry-run fold (which never reads it), and
// dies inside the write transaction. Observed here it does not even get as far
// as Postgres 22007, which is what the review predicted: postgres.js serialises
// a timestamptz parameter with `new Date(v).toISOString()`, so the driver
// itself throws `RangeError: Invalid time value` client-side. Same class, same
// consequence — neither a unique violation nor an EngineError, so it reached
// `runStream`'s final `throw err` and took the whole report with it.
import { describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { importEvents } from "../event-import";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

// Narrow seam for the post-commit case below: `refreshNews` is the LAST of the
// three side effects `runStream` fires after its transaction commits, so
// forcing it to throw leaves the write itself completely untouched and proves
// the guard, not the writer. Everything else in the module stays real —
// `invalidatePublicCache`, `requiresDlsEntitlement`, `onDecided` and
// `refreshDiscipline` are all still the production functions.
const hoisted = vi.hoisted(() => ({ failRefreshNews: false }));

vi.mock("../scoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scoring")>();
  return {
    ...actual,
    refreshNews: async (...args: Parameters<typeof actual.refreshNews>) => {
      if (hoisted.failRefreshNews) throw new Error("simulated post-commit side-effect failure");
      return actual.refreshNews(...args);
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — an unexpected per-stream throw (I-4)", () => {
  it("reports the failing stream as rejected and still runs its siblings", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    const [bad, good] = fixtureIds;

    // The failing stream goes FIRST: what has to be proven is that the loop
    // carries on, not merely that a throw is swallowed at the end of it.
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-stream-throw",
      streams: [
        {
          fixture: { id: bad! },
          events: decidingStream().map((e) => ({ ...e, at: "not-a-timestamp" })),
        },
        { fixture: { id: good! }, events: decidingStream() },
      ],
    });

    expect(report.results[0]).toMatchObject({
      fixture: bad,
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.stream_failed" },
    });
    // The sibling still imported — the call is a 200 carrying data, exactly
    // what §4 promises, instead of a 500 that loses the whole report.
    expect(report.results[1]).toMatchObject({ fixture: good, status: "imported" });
    expect(report.totals).toEqual({ imported: 1, skipped: 0, rejected: 1 });

    // And the failed stream's own transaction rolled back to zero rows: the
    // catch-all reports the failure, it does not paper over a partial write.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${bad!}`;
    expect(n).toBe(0);
    const [{ receipts }] = await sql<{ receipts: number }[]>`
      select count(*)::int as receipts from event_imports
      where division_id = ${divisionId} and fixture_id = ${bad!}`;
    expect(receipts).toBe(0);
  });

  // The catch-all must NOT swallow the CALL-level refusals — those are
  // transport errors on purpose (413/402/409) and mean no stream ran at all.
  // Wrapping them would turn a rejected call into a 200 full of rejected rows,
  // which is a different and worse contract.
  it("does not swallow the call-level 413 caps", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const events = Array.from({ length: 1_001 }, () => ({ type: "core.start", payload: {} }));

    await expect(
      importEvents(auth, divisionId, {
        import_id: "imp-still-413",
        streams: [{ fixture: { id: fixtureId }, events }],
      }),
    ).rejects.toMatchObject({ status: 413, code: "import.too_large" });
  });

  // Re-review finding 1. The catch-all above is deliberately broad, and step 8
  // — `onDecided` / `refreshDiscipline` / `refreshNews` / `captureServer` —
  // runs AFTER the transaction commits. Neither `onDecided` nor
  // `refreshDiscipline` swallows its own failures, so without the guard around
  // that block a throw there is caught by the catch-all and a fully durable
  // import is reported `rejected / eventsAppended: 0`. That is worse than a
  // wrong label: the totals under-count, the audit trail disagrees with the
  // ledger, and the help copy this branch ships tells the operator "nothing was
  // written — resend just this one".
  it("still reports imported when a POST-COMMIT side effect throws", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const events = decidingStream();

    hoisted.failRefreshNews = true;
    let report;
    try {
      report = await importEvents(auth, divisionId, {
        import_id: "imp-post-commit-throw",
        streams: [{ fixture: { id: fixtureId }, events }],
      });
    } finally {
      hoisted.failRefreshNews = false;
    }

    expect(report.results[0]).toMatchObject({
      fixture: fixtureId,
      status: "imported",
      eventsAppended: events.length,
    });
    expect(report.totals).toEqual({ imported: 1, skipped: 0, rejected: 0 });

    // The report is not merely optimistic — the rows really are there. Compared
    // against the stream's own length rather than a self-derived array, so an
    // empty ledger cannot satisfy it.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(events.length);
    const [{ receipts }] = await sql<{ receipts: number }[]>`
      select count(*)::int as receipts from event_imports
      where division_id = ${divisionId} and fixture_id = ${fixtureId}`;
    expect(receipts).toBe(1);
  });
});
