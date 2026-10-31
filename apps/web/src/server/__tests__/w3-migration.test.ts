// W3 Task 3 (SW-M13; X-SW-29, RB3-23) — the W3 delta that takes the slot off every Swiss bye shell placed before the
// deploy. The delta is read by GLOB, never by number (it is renumbered at merge), and its OWN statement runs here, inside
// a rolled-back transaction on a dedicated client: it acts on the whole shared test DB, and a committed run would
// rewrite sibling suites' rows. Every assertion reads this test's own stage, so a sibling suite's rows cannot answer it.
//
// "Holds a slot" is the branch's ONE predicate (`holdsSlot`, lib/rebuild-slots.ts): time, court, venue or pin.
//
// single-sport: badminton — the delta reads `ext_key` and the slot columns, no sport field.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { connectionOptions, sql } from "@/lib/db";
import { holdsSlot } from "@/lib/rebuild-slots";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createCourt, createVenue } from "@/server/usecases/venues";
import { seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w3_bye_shells_off_court\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a check meant for the SQL. */
const code = text.replace(/--.*$/gm, "").trim();

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema } });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

interface Slot {
  id: string;
  ext_key: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

describe("W3 delta: the file", () => {
  it("exactly one delta carries the name, it is LOUD, and it is one UPDATE of fixtures", () => {
    expect(files, "one delta named *__w3_bye_shells_off_court.sql").toHaveLength(1);
    expect(text, "the header announces the data change").toMatch(/DATA CHANGE \(LOUD\)/);
    expect(code.split(";").filter((s) => s.trim() !== "").length, "one statement").toBe(1);
    expect(code).toMatch(/^update fixtures\b/);
  });
});

describe.runIf(HAS_DB)("W3 delta: bye shells come off the court", () => {
  it("two placed bye shells lose every slot field; a placed board is untouched; a second run changes nothing", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W3 delta " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 5 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
    await generateStageFixtures(auth, stage!.id); // mint the shells
    const venue = await createVenue(auth, { name: "Hall", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const rows = await sql<Slot[]>`
      select id, ext_key, scheduled_at, court_id, venue_id, schedule_locked from fixtures
      where stage_id = ${stage!.id} order by round_no, seq_in_round`;
    const byes = rows.filter((r) => r.ext_key !== null && /^sw-r\d+-bye$/.test(r.ext_key));
    const board = rows.find((r) => r.ext_key === "sw-r1-b1");
    expect(byes.length, "rig: an odd field mints two bye shells").toBe(2);
    expect(board, "rig: and round 1's first board").toBeDefined();
    const mine = [...byes.map((b) => b.id), board!.id];

    const verdict = await rolledBack(async (tx) => {
      // The pre-deploy state: both byes placed the two ways a writer did it (a full auto placement, and a pin alone),
      // and the board placed like the byes.
      await tx`
        update fixtures set scheduled_at = '2030-08-01T09:00:00Z', court_id = ${court.id}, venue_id = ${venue.id}, schedule_locked = true
        where id in ${tx([byes[0]!.id, board!.id])}`;
      await tx`update fixtures set schedule_locked = true where id = ${byes[1]!.id}`;
      const read = () =>
        tx<Slot[]>`select id, ext_key, scheduled_at, court_id, venue_id, schedule_locked from fixtures where id in ${tx(mine)}`;
      const before = await read();
      const first = await tx.unsafe<{ id: string }[]>(code);
      const after = await read();
      const second = await tx.unsafe(code);
      const again = await read();
      return { before, firstCount: first.count, after, secondCount: second.count, again };
    });
    const by = (list: Slot[], id: string) => list.find((r) => r.id === id)!;

    expect(byes.map((b) => holdsSlot(by(verdict.before, b.id))), "premise: both byes hold a slot before").toEqual([true, true]);
    expect(holdsSlot(by(verdict.before, board!.id)), "premise: the board holds one too").toBe(true);
    expect(verdict.firstCount, "the first run changed at least this test's two byes").toBeGreaterThanOrEqual(2);
    for (const b of byes) {
      const r = by(verdict.after, b.id);
      expect({ at: r.scheduled_at, court: r.court_id, venue: r.venue_id, pin: r.schedule_locked }, `bye ${b.ext_key} is slotless`).toEqual({
        at: null,
        court: null,
        venue: null,
        pin: false,
      });
    }
    expect(by(verdict.after, board!.id), "the board is untouched").toEqual(by(verdict.before, board!.id));
    expect(verdict.secondCount, "a second run changes 0 rows").toBe(0);
    expect(verdict.again, "… and moves nothing").toEqual(verdict.after);
  }, 120_000);
});
