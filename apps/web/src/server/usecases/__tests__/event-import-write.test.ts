import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { importEvents } from "../event-import";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — writes", () => {
  it("appends the stream, decides the fixture and records one receipt", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-ok",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });

    expect(report.results[0]!.status).toBe("imported");
    expect(report.totals).toEqual({ imported: 1, skipped: 0, rejected: 0 });

    // Gapless 1..n, compared against the stream's OWN length — not against an
    // array derived from `seqs` itself, which was the previous shape and made
    // `[] === []` a pass: a run that appended nothing at all satisfied it
    // (final review, minor).
    const seqs = await sql<{ seq: number }[]>`
      select seq from score_events where fixture_id = ${fixtureId} order by seq`;
    expect(seqs.map((r) => r.seq)).toEqual(
      Array.from({ length: decidingStream().length }, (_, i) => i + 1),
    );
    const [fixture] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${fixtureId}`;
    expect(fixture!.outcome).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from event_imports
      where division_id = ${divisionId} and import_id = ${"imp-ok"}`;
    expect(n).toBe(1);
  });

  it("refuses a second import_id into an already-imported fixture, leaving the ledger unchanged", async () => {
    // Renamed (final review, minor): the old title said "rolls the whole
    // fixture back mid-stream", which is not what the body does — the
    // `fixture_started` guard fires BEFORE any write, so there is nothing to
    // roll back. Genuine mid-stream rollback is covered at
    // engine-db/__tests__/append-event-in-tx.test.ts:12.
    //
    // What this asserts: import a stream, then import a DIFFERENT import_id
    // into the same (now started) fixture — the guard rejects it before any
    // write, and the ledger is unchanged.
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await importEvents(auth, divisionId, {
      import_id: "imp-first",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;

    const second = await importEvents(auth, divisionId, {
      import_id: "imp-second",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(second.results[0]!.error?.code).toBe("import.fixture_started");
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("replays the same import_id as skipped_duplicate without appending", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const call = () => importEvents(auth, divisionId, {
      import_id: "imp-replay",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    await call();
    const [{ n: first }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;

    const again = await call();
    expect(again.results[0]!.status).toBe("skipped_duplicate");
    expect(again.results[0]!.eventsAppended).toBe(0);
    const [{ n: second }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(second).toBe(first);
  });
});
