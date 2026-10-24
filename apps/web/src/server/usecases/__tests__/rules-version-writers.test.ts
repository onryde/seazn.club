// W2c Task 15 (X-SR-7, review C2, finding 32) — the server's OWN writers are never blocked by a correction.
//
// `rules_version` is checked only when the sender includes it (P-1). The scoring pads send it; the withdrawal cascade,
// `finalizeFixture` and the organiser's settle call the append path WITHOUT it, so a correction that bumped the version
// must never refuse them. Each case corrects a started match first (`writeFixtureRulesOverride`, the version is then 1)
// and then runs the writer through its own usecase.
//
// The importer (finding 38) only writes into a fixture that holds no `score_events` row and is still `scheduled`
// (`event-import.ts`). Until fix round 1 a correction bumped nothing on such a match, so "import after a correction"
// could not happen; since I-1 a correction made BEFORE kickoff bumps it, so the importer is a case now: it sends no
// version, and an import into a match corrected before kickoff is taken under the corrected format.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, post, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { importEvents } from "../event-import";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { loadFixturePadCfg } from "../fixtures";
import { finalizeFixture } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const rowsAfter = async (id: string, seq: number) =>
  sql<{ type: string; payload: Record<string, unknown> }[]>`
    select type, payload from score_events where fixture_id = ${id} and seq > ${seq} order by seq`;

/** A correction of a started match: the version is 1 afterwards (the premise every case below stands on). */
async function corrected(auth: Parameters<typeof loadFixturePadCfg>[0], id: string, fragment: Record<string, unknown>) {
  await writeFixtureRulesOverride(auth, [id], fragment);
  expect((await loadFixturePadCfg(auth, id)).rulesVersion, "premise: the correction bumped the version").toBe(1);
}

const ran: string[] = [];

describe.skipIf(!HAS_DB)("X-SR-7 C2: the server's own writers are never blocked by a correction", () => {
  it("withdrawal: the cascade writes its forfeit into a corrected live match", async () => {
    // single-sport: badminton league — the cascade's in-play arm is sport-agnostic (withdrawal.ts); the version check is
    // in the one append path every sport shares.
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await post(b.auth, id, "core.start");
    await corrected(b.auth, id, { bestOf: 5 });
    const at = await tip(id);
    const r = await fixtureRow(id);
    await withdrawEntrantCascade(b.auth, r.away_entrant_id!);
    const written = await rowsAfter(id, at);
    // The set of rows the cascade wrote after the correction, matched by type: a forfeit, or an expunging abandon.
    expect(
      written.filter((e) => e.type === "core.forfeit" || (e.type === "core.abandon" && e.payload.expunge === true)).length,
      `the cascade wrote into the corrected match: ${JSON.stringify(written.map((e) => e.type))}`,
    ).toBeGreaterThan(0);
    ran.push("withdrawal");
  });

  it("finalize: a corrected match played to decided is finalized", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await post(b.auth, id, "core.start");
    await post(b.auth, id, "badminton.game.summary", { home: 11, away: 5 });
    // Corrected before the second game: best of five, so two more games decide it (3-0).
    await corrected(b.auth, id, { bestOf: 5 });
    await post(b.auth, id, "badminton.game.summary", { home: 11, away: 6 });
    await post(b.auth, id, "badminton.game.summary", { home: 11, away: 7 });
    expect((await fixtureRow(id)).status, "premise: decided under the corrected format").toBe("decided");
    await expect(finalizeFixture(b.auth, id, await tip(id))).resolves.toMatchObject({ status: "finalized", rules_version: 1 });
    expect((await fixtureRow(id)).status).toBe("finalized");
    ran.push("finalize");
  });

  it("settle: the organiser's settle of a corrected held match is applied", async () => {
    // A football knockout semi with every preset decider off (seedBracket's held rig): 0-0 at FT is held.
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 4, stageRules: {} });
    const id = b.fixtureIds[0]!;
    await post(b.auth, id, "core.start");
    await post(b.auth, id, "football.period", { phase: "HT" });
    await corrected(b.auth, id, { halfMinutes: 40 });
    await post(b.auth, id, "football.period", { phase: "FT" });
    const held = await fixtureRow(id);
    expect(held.status, "premise: the level result is held").toBe("needs_decision");
    await expect(post(b.auth, id, "core.settle", { winner: held.away_entrant_id, method: "organiser" })).resolves.toMatchObject({
      status: "decided",
      rules_version: 1,
    });
    ran.push("settle");
  });

  it("import (fix round 1): a stream imported into a match corrected before kickoff is taken under the corrected format", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 }); // unstarted: a pre-kickoff correction
    expect((await loadFixturePadCfg(b.auth, id)).rulesVersion, "premise: the pre-kickoff correction bumped the version").toBe(1);
    // Best of five: three games decide it; under the old best of three the third would land on a decided match.
    const game = { type: "badminton.game.summary", payload: { home: 11, away: 5 } };
    const report = await importEvents(b.auth, b.divisionId, {
      import_id: `imp-t15-${id}`,
      streams: [{ fixture: { id }, events: [{ type: "core.start", payload: {} }, game, game, game] }],
    });
    expect(report.results[0], JSON.stringify(report.results[0])).toMatchObject({ status: "imported" });
    const [{ s }] = await sql<{ s: { bestOf: number } }[]>`select config_snapshot s from fixtures where id = ${id}`;
    expect(s.bestOf, "the import froze the corrected format").toBe(5);
    ran.push("import");
  });

  it("counted: exactly the four writers ran", () => {
    expect(ran).toEqual(["withdrawal", "finalize", "settle", "import"]);
  });
});
