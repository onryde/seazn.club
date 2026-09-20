// Owner ruling (2026-09-20): starting a division promotes its parent
// competition from `published` to `live`.
//
// Before this, `startDivision` moved `divisions.status` to 'active' and left
// `competitions.status` wherever it was — so a tournament whose play had
// begun still read `published` everywhere the competition row is the source
// of truth, and `COMPETITION_STARTED` only ever fired from the competition
// PATCH (an organiser flipping the status by hand).
//
// The promotion is upward-only and NARROW, and this file exists to pin the
// narrowness rather than the happy path:
//
//   * never from `draft` — `PUBLIC_DASHBOARD_STATUSES` is
//     ["published", "live"], so promoting a draft would PUBLISH a competition
//     nobody published. A visibility change is not a side effect.
//   * never downward from `completed`/`archived` — restarting a division
//     inside a wrapped-up competition must not reopen it.
//   * already `live` ⇒ no write and, crucially, NO SECOND EVENT. The event is
//     the transition, not the state.
//
// A status change without its event would be worse than leaving this alone:
// the column would look maintained while the signal stayed missing. So every
// status assertion below is paired with a call-count assertion on
// `captureServer`, and vice versa.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { startDivision } from "../schedule";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

/** Every `CompetitionStatus` member the promotion must refuse, and the one it
 *  must accept. Derived from `schemas.ts`'s enum rather than a hand-typed
 *  subset, so a new status shows up here as a compile-time choice. */
type Status = "draft" | "published" | "live" | "completed" | "archived";

interface Started {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
}

/** A division whose first stage already has fixtures (so `startDivision`
 *  generates nothing) and whose board is UNSCHEDULED — no times, no courts.
 *  An empty assignment set yields no conflicts, so the publish gate that
 *  `startDivision` runs on the way through has nothing to refuse. */
async function seedDivision(
  status: Status,
  opts: { divisions?: number } = {},
): Promise<{ auth: AuthCtx; competitionId: string; divisionIds: string[] }> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Promote ${tag}`,
    ends_on: "2030-12-31",
    visibility: "private",
    branding: {},
  });
  const divisionIds: string[] = [];
  for (let d = 0; d < (opts.divisions ?? 1); d++) {
    const division = await createDivision(auth, comp.id, {
      name: `Div ${tag}-${d}`,
      slug: `promote-${tag}-${d}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      division.id,
      [1, 2].map((n) => ({
        kind: "individual" as const,
        display_name: `E${n}`,
        seed: n,
        members: [],
      })),
    );
    const entrants = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${division.id} order by seed`;
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "RR",
      config: {},
    });
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id)
      values (${stage!.id}, ${division.id}, ${auth.orgId}, 1, 0, ${"f0"},
              'scheduled', ${entrants[0]!.id}, ${entrants[1]!.id})`;
    divisionIds.push(division.id);
  }
  // Set LAST and by hand. Not through the PATCH — that fires lifecycle events
  // of its own and carries publish gates this file is not testing. And after
  // the divisions exist, because `createDivision`'s own
  // `assertCompetitionNotEnded` refuses to add one to a completed/archived
  // competition, which is the state half these cases need.
  await sql`update competitions set status = ${status} where id = ${comp.id}`;
  return { auth, competitionId: comp.id, divisionIds };
}

async function seedAndStart(status: Status): Promise<Started> {
  const { auth, competitionId, divisionIds } = await seedDivision(status);
  vi.mocked(captureServer).mockClear(); // drop the seed's own CREATED events
  await startDivision(auth, divisionIds[0]!);
  return { auth, competitionId, divisionId: divisionIds[0]! };
}

async function competitionStatus(id: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from competitions where id = ${id}`;
  return row!.status;
}

function startedEvents(): { properties?: Record<string, unknown> }[] {
  return vi
    .mocked(captureServer)
    .mock.calls.map(([args]) => args)
    .filter((c) => c.event === EVENTS.COMPETITION_STARTED);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("startDivision — competition promotion", () => {
  beforeEach(() => {
    vi.mocked(captureServer).mockClear();
  });

  it("promotes a published competition to live", async () => {
    const { competitionId } = await seedAndStart("published");
    expect(await competitionStatus(competitionId)).toBe("live");
  });

  it("fires COMPETITION_STARTED exactly once, naming the competition", async () => {
    const { competitionId } = await seedAndStart("published");
    const fired = startedEvents();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ properties: { competition_id: competitionId } });
  });

  it("leaves a draft competition in draft — a start must not publish it", async () => {
    const { competitionId } = await seedAndStart("draft");
    expect(await competitionStatus(competitionId)).toBe("draft");
    expect(startedEvents()).toHaveLength(0);
  });

  it("leaves a completed competition completed — restarting must not reopen it", async () => {
    const { competitionId } = await seedAndStart("completed");
    expect(await competitionStatus(competitionId)).toBe("completed");
    expect(startedEvents()).toHaveLength(0);
  });

  it("leaves an archived competition archived", async () => {
    const { competitionId } = await seedAndStart("archived");
    expect(await competitionStatus(competitionId)).toBe("archived");
    expect(startedEvents()).toHaveLength(0);
  });

  it("an already-live competition is not written again and fires NO second event", async () => {
    const { competitionId } = await seedAndStart("live");
    expect(await competitionStatus(competitionId)).toBe("live");
    expect(startedEvents()).toHaveLength(0);
  });

  it("two divisions of one competition fire COMPETITION_STARTED ONCE — on the transition only", async () => {
    const { auth, competitionId, divisionIds } = await seedDivision("published", { divisions: 2 });
    vi.mocked(captureServer).mockClear();
    await startDivision(auth, divisionIds[0]!);
    await startDivision(auth, divisionIds[1]!);
    expect(await competitionStatus(competitionId)).toBe("live");
    expect(startedEvents()).toHaveLength(1);
  });

  it("starting the SAME division twice fires COMPETITION_STARTED once", async () => {
    const { auth, competitionId, divisionId } = await seedAndStart("published");
    await startDivision(auth, divisionId);
    expect(await competitionStatus(competitionId)).toBe("live");
    expect(startedEvents()).toHaveLength(1);
  });
});
