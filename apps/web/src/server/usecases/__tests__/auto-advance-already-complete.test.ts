// W5 T17 review (X-BD-4): scoring's auto-advance logs `stage_auto_advanced` after the completion it asked for. When the stage completed
// between its `ready` read and that call (an organiser's Complete from another tab), `completeStage` answers `already_complete` - a
// call that did nothing - and the ledger must not say the stage advanced. The race itself is not reproducible in one process, so the
// answer is injected at the `completeStage` seam (the real function wraps it for every other call); the positive pair (a real
// completion IS logged) runs through the same seam. Real Postgres required; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const answer = vi.hoisted(() => ({ next: { completed: true, events: [] } as Record<string, unknown> }));
vi.mock("../stages", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stages")>();
  return { ...real, completeStage: async () => answer.next };
});

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

beforeEach(() => {
  answer.next = { completed: true, events: [] };
});

/** A two-entrant league with auto-progress on; deciding its one line is the write that asks auto-advance. */
async function decideOneLine() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "AA " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  await createEntrants(auth, division.id, [1, 2].map((n) => ({ kind: "individual" as const, display_name: `E${n}`, seed: n, members: [] })));
  await patchDivision(auth, division.id, { auto_progress: true });
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "league", name: "League", config: {} }]);
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  await scoreEvent(auth, fixtures[0]!.id, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, fixtures[0]!.id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${division.id} and type = 'stage_auto_advanced'`;
  return n;
}

describe.skipIf(!HAS_DB)("X-BD-4: auto-advance logs only a completion it made", () => {
  it("a real completion is logged once (the positive pair)", async () => {
    answer.next = { completed: true, events: [] };
    expect(await decideOneLine()).toBe(1);
  }, 60_000);

  it("an already_complete answer logs nothing", async () => {
    // differential: before the guard the event was written for a call that did nothing.
    answer.next = { completed: false, already_complete: true, events: [], seed_proposal: null };
    expect(await decideOneLine()).toBe(0);
  }, 60_000);
});
