// W5 app PR A, Task 8 fix round 1 (m2): a Reinstate is many score writes (each its own transaction, as the cascade's are),
// so it cannot share the status write's transaction. It is all-or-retry instead: a reverse that throws part-way puts the
// status BACK (the PATCH changed nothing a client can see), and the reverse is idempotent, so a retry finishes it and writes
// nothing twice. The throw is forced on the cascade's SECOND re-record (its voids and one re-recorded event have landed), so
// the retry must pick up exactly where it stopped.
// Its own file: the throw is a module mock of `../scoring`, which every other suite needs real.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const arm = { throwOnRerecord: false, seen: 0, thrown: 0 };
vi.mock("../scoring", async (importOriginal) => {
  const real = await importOriginal<typeof import("../scoring")>();
  return {
    ...real,
    scoreEvent: async (...a: Parameters<typeof real.scoreEvent>) => {
      const [, , input, opts] = a;
      if (arm.throwOnRerecord && opts?.writer === "withdrawal_cascade" && input.type !== "core.void" && ++arm.seen === 2) {
        arm.throwOnRerecord = false;
        arm.thrown++;
        throw new Error("forced: the re-record fails part-way");
      }
      return real.scoreEvent(...a);
    },
  };
});

import { sql } from "@/lib/db";
import { playBadminton, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant, writeEntrantPatch } from "../entrants";
import { startDivision } from "../schedule";
import { finalizeFixture } from "../scoring";
import { createStages } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A line's status, outcome and active events (type + payload, in order). */
async function lineState(id: string) {
  const [l] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${id}`;
  const evs = await sql<{ id: string; type: string; payload: unknown; voids_event_id: string | null }[]>`
    select id, type, payload, voids_event_id from score_events where fixture_id = ${id} order by seq`;
  const voided = new Set(evs.map((e) => e.voids_event_id).filter(Boolean));
  return { status: l!.status, outcome: l!.outcome, events: evs.filter((e) => e.type !== "core.void" && !voided.has(e.id)).map((e) => [e.type, JSON.stringify(e.payload)]) };
}

async function rig() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T8 m2 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} } as never);
  const es = await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `P${i + 1}`, seed: i + 1, members: [] })) as never);
  const [p1, p2] = [es[0]!.id, es[1]!.id];
  const [stage] = await createStages(auth, d.id, [{ seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null }] as never);
  await startDivision(auth, d.id);
  const lines = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}`;
  const mine = lines.filter((l) => l.home_entrant_id === p1 || l.away_entrant_id === p1);
  const signed = mine.find((l) => l.home_entrant_id === p2 || l.away_entrant_id === p2)!;
  await playBadminton(auth, signed.id, true);
  await finalizeFixture(auth, signed.id, await tip(signed.id));
  const pre = Object.fromEntries(await Promise.all(mine.map(async (l) => [l.id, await lineState(l.id)] as const)));
  return { auth, p1, mine, signed, pre };
}

describe.skipIf(!HAS_DB)("m2: a Reinstate that fails part-way changes nothing, and its retry finishes the job", () => {
  // Round 2 (m2): the process died after the status write committed — she reads `registered` with her lines still out. The
  // next PATCH finishes the reverse: it is asked of any write that leaves her in the field, never gated on the prior status.
  // differential: round 1 gated on a departed prior status, so this PATCH did nothing.
  it("a PATCH after a reverse cut off by the process dying finishes it", async () => {
    const { auth, p1, mine, signed, pre } = await rig();
    await withdrawEntrantCascade(auth, p1);
    await writeEntrantPatch(auth, p1, { status: "registered" });
    expect((await lineState(signed.id)).status, "rig: registered, the line still out").toBe("abandoned");
    await patchEntrant(auth, p1, { status: "registered" });
    let checked = 0;
    for (const l of mine) {
      expect(await lineState(l.id), "finished: the line as before the withdrawal").toEqual(pre[l.id]);
      checked++;
    }
    expect(checked).toBe(3);
  }, 180_000);

  it("a forced throw part-way through the re-record leaves her withdrawn; the retry restores every line exactly once", async () => {
    const { auth, p1, mine, signed, pre } = await rig();
    await withdrawEntrantCascade(auth, p1);
    expect((await lineState(signed.id)).status, "rig: expunged").toBe("abandoned");

    arm.throwOnRerecord = true;
    await expect(patchEntrant(auth, p1, { status: "registered" })).rejects.toThrow(/forced/);
    expect(arm.thrown, "rig: the throw fired after one re-record landed").toBe(1);
    const [me] = await sql<{ status: string }[]>`select status from entrants where id = ${p1}`;
    expect(me!.status, "the failed Reinstate left her withdrawn").toBe("withdrawn");

    await patchEntrant(auth, p1, { status: "registered" });
    let checked = 0;
    for (const l of mine) {
      expect(await lineState(l.id), "the retry restores the line exactly, nothing written twice").toEqual(pre[l.id]);
      checked++;
    }
    expect(checked).toBe(3);
  }, 180_000);
});
