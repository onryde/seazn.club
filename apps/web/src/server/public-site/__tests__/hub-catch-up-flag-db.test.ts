// W5 follow-ups C, review C2: the hub's round planner must never read a late entrant's catch-up round as the season's frontier, so
// the hub document has to SAY which lines are catch-ups (`HubMatch.catchUp`). Driven through the real producer (the organiser's
// late add on a started league, `createEntrants`: the `rr-cu-` lines) and the real consumer (`loadCompetitionHub` parsed by the
// wire schema). Expected: exactly the lines stored with a `rr-cu-` ext key carry the flag (read from the table, never from the
// predicate under test) - the empty case (no late add) first. Single-sport (badminton): the flag is the ext key's, sport-blind.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));

import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages } from "@/server/usecases/stages";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.runIf(HAS_DB)("C2: the hub marks a late entrant's catch-up lines (real producer, real consumer)", () => {
  it("no late add: no line is a catch-up; a late add after round 2 started: exactly the rr-cu lines are", async () => {
    const mod = builtinModules.find((x) => x.key === "badminton")!;
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 C2 " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: Object.keys(mod.variants)[0]!, config: {} });
    await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
    await startDivision(auth, d.id);
    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const matches = async () => CompetitionHubDoc.parse(await loadCompetitionHub(orgSlug!, comp.slug, new Date(), { uncached: true })).matches;

    const before = await matches();
    expect(before.length, "premise: the four-player league's six matches are on the hub").toBe(6);
    expect(before.filter((x) => x.catchUp === true)).toEqual([]);

    // Rounds 1 and 2 under way, so a fifth player cannot be drawn into them: her matches there are owed as catch-ups.
    const rows = await sql<{ id: string; round_no: number }[]>`select id, round_no from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
    for (const r of [1, 2]) {
      const id = rows.find((x) => x.round_no === r)!.id;
      await scoreEvent(auth, id, { expected_seq: 0, type: "core.start", payload: {} } as never);
    }
    await createEntrants(auth, d.id, [{ kind: "individual", display_name: "P5", seed: null, members: [] } as never]);

    const stored = await sql<{ id: string; ext_key: string | null }[]>`select id, ext_key from fixtures where stage_id = ${stage!.id}`;
    const catchUpIds = stored.filter((x) => /rr-cu-/.test(x.ext_key ?? "")).map((x) => x.id).sort();
    expect(catchUpIds.length, "premise: the late add appended catch-up lines").toBeGreaterThan(0);
    const after = await matches();
    expect(after.filter((x) => x.catchUp === true).map((x) => x.fixtureId).sort()).toEqual(catchUpIds);
    expect(after.length).toBe(stored.length);
  });
});
