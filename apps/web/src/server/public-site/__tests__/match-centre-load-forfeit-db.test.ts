// W2b Task 13 (spec §5.5; X-DW-1, X-AB-2) — the match centre's forfeit sentence through its REAL producer: fixtures
// recorded through the console's write (`scoreEvent`, the w2b rig), read back the way the page reads them
// (`public_fixtures_v`) and handed to `loadMatchCentre`. The builder's unit tests (match-centre-forfeit.test.ts) feed
// the two outside words by hand; this file proves the loader reads them: the double walkover's next-round side off
// the next fixture, and an abandon's result in the org's words.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import type { PublicFixture } from "../data";
import { loadMatchCentre, type MatchCentreLoadCtx } from "../match-centre-load";
import { football } from "@seazn/engine/sports/football";

const HAS_DB = !!process.env.DATABASE_URL;
const EN = enPublic as unknown as Dict;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The page's own read of one fixture (`public_fixtures_v`, the columns `getPublicFixture` selects). */
async function publicRow(id: string): Promise<PublicFixture> {
  const [row] = await sql<PublicFixture[]>`
    select id, division_id, stage_id, pool_id, round_no, seq_in_round,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           scheduled_at, venue, court_label, status, outcome, summary, last_seq,
           lane, is_final, third_place, conditional, stream_url
      from public_fixtures_v where id = ${id}`;
  if (!row) throw new Error(`rig: ${id} is not public`);
  return row;
}

async function ctxOf(divisionId: string): Promise<MatchCentreLoadCtx> {
  const [div] = await sql<{ sport_key: string; module_version: string }[]>`
    select sport_key, module_version from divisions where id = ${divisionId}`;
  return {
    orgTz: null,
    division: { sportKey: div!.sport_key, moduleVersion: div!.module_version, formatLabel: "x", tz: null, youth: false, playerNameDisplay: null },
    locale: "en",
    hrefs: { division: "/d", competition: "/c", calendar: null },
    stage: { name: "Cup", roundLabel: null },
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars),
  };
}

const publish = (competitionId: string) => sql`update competitions set visibility = 'public' where id = ${competitionId}`;
const nameOf = async (entrantId: string) =>
  (await sql<{ display_name: string }[]>`select display_name from entrants where id = ${entrantId}`)[0]!.display_name;

describe.skipIf(!HAS_DB)("loadMatchCentre — the forfeit sentence's outside words, read by the loader", () => {
  it("X-DW-1: a semi-final double walkover names the next round's side once the final stands walked over — not before", async () => {
    // single-sport: badminton — the w2b rig's played line (`playBadminton`); the cascade under test is sport-blind.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    await publish(s.competitionId);
    const ctx = await ctxOf(s.divisionId);
    const [a, b] = s.fixtureIds;
    const out = await post(s.auth, a!, "core.forfeit", { by: "both", reason: "walkover" });
    expect([out.status, out.outcome], "rig: the double walkover is recorded").toEqual(["forfeited", { kind: "double_walkover" }]);

    // The final still waits on the other semi: no clause.
    const early = await loadMatchCentre(sql, await publicRow(a!), ctx);
    expect(early.header.statusLine).toEqual({ key: "forfeit.sentence.doubleWalkover" });

    // The other semi is played: the final is walked over to its winner (the cascade's seat arrival).
    const sf2 = await playBadminton(s.auth, b!, true);
    const final = await fixtureRow((await fixtureRow(a!)).winner_to_fixture!);
    expect([final.status, final.outcome?.kind, final.outcome?.winner], "premise: the final stands walked over").toEqual([
      "forfeited", "award", sf2.home_entrant_id,
    ]);
    const late = await loadMatchCentre(sql, await publicRow(a!), ctx);
    const next = await nameOf(sf2.home_entrant_id!);
    expect(late.header.statusLine).toEqual({ key: "forfeit.sentence.doubleWalkoverNext", params: { next } });
    expect(t(EN, late.header.statusLine!.key, late.header.statusLine!.params)).toBe(
      `Neither side showed up — both lose. Next round: walkover for ${next}.`,
    );
  });

  it("X-AB-2: an award-policy abandon reads its reason and its result, in the org's words", async () => {
    // single-sport: football — the goal sports are the ones that declare `abandonPolicy` (FB-AB-1); football is one.
    const variant = football.variants["11-a-side"] as Record<string, unknown>;
    const s = await seedBracket({
      sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2,
      divisionConfig: { ...variant, abandonPolicy: "award" },
    });
    await publish(s.competitionId);
    const ctx = await ctxOf(s.divisionId);
    const id = s.fixtureIds[0]!;
    const row = await fixtureRow(id);
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "football.goal", { by: row.home_entrant_id });
    const done = await post(s.auth, id, "core.abandon", { reason: "floodlights" });
    expect([done.status, done.outcome], "premise: FB-AB-1, the leader wins").toEqual([
      "decided", { kind: "win", winner: row.home_entrant_id, loser: row.away_entrant_id, method: "abandoned" },
    ]);
    const doc = await loadMatchCentre(sql, await publicRow(id), ctx);
    const winner = await nameOf(row.home_entrant_id!);
    const result = t(EN, "matchCentre.result.regulation", { winner });
    expect(doc.header.statusLine).toEqual({ key: "forfeit.sentence.abandoned", params: { reason: "floodlights", result } });
    expect(t(EN, doc.header.statusLine!.key, doc.header.statusLine!.params)).toBe(`Abandoned (floodlights) — ${winner} won.`);
  });
});
