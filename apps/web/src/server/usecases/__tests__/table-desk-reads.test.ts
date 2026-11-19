// W5 app-A Task 23 (X-CU-8, X-CU-11): the desk's two reads for a late player joining a running ROOT league or group, on a real
// database.
//   readTableLatePools  the add form's / the strip's Group field: each pool's size and what a newcomer owes there, and the pool
//                       the server joins when none is named. The oracle for the default is the SERVER's own answer: an add with no
//                       `late_entry_pool` lands in the pool the read named (two code paths that must agree, the add being the truth);
//                       the sizes are counted off the stored lines here.
//   listTableWaiting    the "Waiting to join the table" strip: exactly the players the desk's `late_players_waiting` row counts,
//                       so the row's "Open fixtures" never lands on an empty strip — the same set across arrive / place / withdraw.
// Sequence: empty (before Start), a second add, after a placement, after a withdrawal, a finished table. Sports: badminton singles
// and chess (boardgame), each from the engine registry by key; the pools rows run on badminton (the read reads lines, never a
// sport field), the waiting rows sweep both.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { confirmRegistration } from "../registrations";
import { placeWaitingTableEntrant } from "../roundrobin-late-entry";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages } from "../stages";
import { listTableWaiting, readTableLatePools } from "../table-desk";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

function sport(key: string) {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  return { key, variant, kind: (m.entrantModel?.defaultKind ?? "individual") as "individual" };
}
const BADMINTON = sport("badminton");
const CHESS = sport("boardgame");

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  status: () => Promise<string>;
}
async function rig(o: { n: number; group?: number; legs?: number; start?: boolean; s?: ReturnType<typeof sport> }): Promise<Rig> {
  const s = o.s ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T23 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: s.key, variant_key: s.variant, config: {} });
  await createEntrants(auth, division.id, Array.from({ length: o.n }, (_, i) => ({ kind: s.kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const legs = o.legs ?? 1;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: o.group ? "group" : "league",
    name: "Table",
    config: o.group ? { legs, pools: { count: o.group } } : { legs },
    progression: null,
  });
  if (o.start !== false) await startDivision(auth, division.id);
  const status = async () => (await sql<{ status: string }[]>`select status from divisions where id = ${division.id}`)[0]!.status;
  return { auth, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, status };
}

/** Each pool key -> the distinct entrants seated on its stored lines, counted here (not by the read). */
async function seatedByPool(stageId: string): Promise<Map<string, number>> {
  const rows = await sql<{ key: string; n: number }[]>`
    select p.key, count(distinct e.id)::int as n from pools p
      join fixtures f on f.pool_id = p.id
      join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
     where p.stage_id = ${stageId}
     group by p.key order by p.key`;
  return new Map(rows.map((r) => [r.key, r.n]));
}

async function arrive(r: Rig, name: string): Promise<string> {
  const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: name });
  const confirmed = await confirmRegistration(r.auth, registration.id);
  expect(confirmed.entrant_id, `rig: ${name}'s confirmation made an entrant`).toBeTruthy();
  return confirmed.entrant_id!;
}
const deskCount = async (r: Rig) =>
  ((await getCompetitionDesk(r.auth, r.competitionId)).divisions.get(r.divisionId)?.attention ?? [])
    .filter((a) => a.kind === "late_players_waiting")
    .reduce((n, a) => n + (a as { count: number }).count, 0);

describe.skipIf(!HAS_DB)("X-CU-11 readTableLatePools: the Group field's pools and default", () => {
  it("the empty case first: before Start there is no table late entry (null)", async () => {
    const r = await rig({ n: 6, group: 2, start: false });
    expect(await readTableLatePools(r.auth, r.divisionId, await r.status())).toBeNull();
  });

  it("a running group of three pools: sizes off the lines, owes per leg, and the default is where an unnamed add lands (twice)", async () => {
    const r = await rig({ n: 10, group: 3, legs: 2 });
    const seated = await seatedByPool(r.stageId);
    expect([...seated.values()].reduce((a, b) => a + b, 0), "premise: all ten seated").toBe(10);
    const first = await readTableLatePools(r.auth, r.divisionId, await r.status());
    expect(first?.kind).toBe("group");
    expect(first?.stageId).toBe(r.stageId);
    expect(first!.pools).toEqual([...seated].map(([key, size]) => ({ key, size, owes: size * 2 })));
    const smallest = Math.min(...seated.values());
    expect(seated.get(first!.defaultKey!), "the default is a smallest pool").toBe(smallest);

    // The server's own answer: an add naming no pool joins the read's default.
    const [a] = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Late One", seed: null, members: [] }]);
    expect((a!.late_entry as { pool_key?: string } | undefined)?.pool_key).toBe(first!.defaultKey);

    // A second read after it: that pool grew by one, and the default is again where the next unnamed add lands.
    const second = await readTableLatePools(r.auth, r.divisionId, await r.status());
    expect(second!.pools.find((p) => p.key === first!.defaultKey)!.size).toBe(smallest + 1);
    const [b] = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Late Two", seed: null, members: [] }]);
    expect((b!.late_entry as { pool_key?: string } | undefined)?.pool_key).toBe(second!.defaultKey);
  });

  it("a league has no pools and no default; a finished table offers nothing (null)", async () => {
    const r = await rig({ n: 5 });
    expect(await readTableLatePools(r.auth, r.divisionId, await r.status())).toEqual({ stageId: r.stageId, kind: "league", pools: [], defaultKey: null, rebuildable: true });
    // rig: a finished table (how it finished is the completion path's business, not this read's).
    await sql`update stages set status = 'complete' where id = ${r.stageId}`;
    expect(await readTableLatePools(r.auth, r.divisionId, await r.status())).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("X-CU-8 listTableWaiting: the strip lists exactly whom the desk row counts", () => {
  it("arrive -> listed and counted; place -> gone from both; a second arrival withdrawn -> gone from both (badminton, chess)", async () => {
    let checked = 0;
    for (const s of [BADMINTON, CHESS]) {
      const r = await rig({ n: 5, s });
      expect(await listTableWaiting(r.auth, r.divisionId), `${s.key}: the empty case`).toEqual([]);
      const ana = await arrive(r, "Ana Late");
      const listed = await listTableWaiting(r.auth, r.divisionId);
      expect(listed, s.key).toEqual([{ entrantId: ana, stageId: r.stageId, name: "Ana Late", paid: false }]);
      expect(await deskCount(r), `${s.key}: the desk row counts the same one`).toBe(1);

      const placed = await placeWaitingTableEntrant(r.auth, r.stageId, ana);
      expect(placed.case, `${s.key}: premise, the tap placed her`).not.toBe("refused");
      expect(await listTableWaiting(r.auth, r.divisionId), `${s.key}: placed, not listed`).toEqual([]);
      expect(await deskCount(r)).toBe(0);

      const bo = await arrive(r, "Bo Late");
      expect((await listTableWaiting(r.auth, r.divisionId)).map((w) => w.entrantId)).toEqual([bo]);
      await withdrawEntrantCascade(r.auth, bo);
      expect(await listTableWaiting(r.auth, r.divisionId), `${s.key}: withdrawn, not listed`).toEqual([]);
      expect(await deskCount(r)).toBe(0);

      // A row whose marker outlived its status (written before the status write cleared it, entrants.ts): the strip and the
      // desk row still agree — neither lists a player who has left.
      const cy = await arrive(r, "Cy Late");
      await sql`update entrants set status = 'withdrawn' where id = ${cy}`;
      expect((await sql<{ w: string | null }[]>`select table_waiting_stage_id as w from entrants where id = ${cy}`)[0]!.w, "rig: the marker stayed").toBe(r.stageId);
      expect(await listTableWaiting(r.auth, r.divisionId), `${s.key}: a departed marker is not listed`).toEqual([]);
      expect(await deskCount(r), `${s.key}: nor counted`).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ─── Fix round 1 I1 (R24 7A made true): the strip's Rebuild exit, before any match has started ────────────────────────────────
// The exit shows only while Rebuild would take (`rebuildable`, the decision's own "nothing started" predicate) and it is the tap
// with `prefer_rebuild`: Rebuild's own body, the newcomer drawn in, no catch-up line. Once a line has started the read says no, and
// a stale tap asking to rebuild is refused by Rebuild's own code with NOTHING moved (never silently turned into catch-up lines,
// which cannot be undone). Expected values: the rulebook (RB5-L7: nothing started -> Rebuild offered; a redraw seats every active
// entrant once per opponent per leg) and the rows before the tap.
describe.skipIf(!HAS_DB)("I1 the waiting strip's Rebuild exit (prefer_rebuild on the tap)", () => {
  const startLine = async (r: Rig) => {
    const [first] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} order by round_no, id limit 1`;
    await scoreEvent(r.auth, first!.id, { expected_seq: 0, type: "core.start", payload: {} });
  };
  const linesOf = (stageId: string) =>
    sql<{ ext_key: string | null; home: string | null; away: string | null }[]>`
      select ext_key, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId}`;

  it("rebuildable: yes while nothing has started (league and group), no once a line starts", async () => {
    let checked = 0;
    for (const o of [{ n: 5 }, { n: 8, group: 2 }]) {
      const r = await rig(o);
      expect((await readTableLatePools(r.auth, r.divisionId, await r.status()))?.rebuildable, JSON.stringify(o)).toBe(true);
      await startLine(r);
      expect((await readTableLatePools(r.auth, r.divisionId, await r.status()))?.rebuildable, `${JSON.stringify(o)} started`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the tap with prefer_rebuild redraws the stage with her in it: no catch-up line, marker and strip cleared, answer 'rebuilt'", async () => {
    const r = await rig({ n: 5 });
    const ana = await arrive(r, "Ana Late");
    const out = await placeWaitingTableEntrant(r.auth, r.stageId, ana, undefined, { preferRebuild: true });
    expect({ case: out.case, reason: out.reason }).toEqual({ case: "rebuild_offered", reason: "rebuilt" });
    const lines = await linesOf(r.stageId);
    expect(lines.filter((l) => /^rr-(cu|by)-/.test(l.ext_key ?? "")), "no catch-up line").toEqual([]);
    // RB5-L7: a single round robin of six: 15 lines, she plays the five others once.
    expect(lines.length).toBe(15);
    expect(lines.filter((l) => l.home === ana || l.away === ana).length).toBe(5);
    expect(await listTableWaiting(r.auth, r.divisionId)).toEqual([]);
    expect(await deskCount(r)).toBe(0);
  });

  it("a stale Rebuild tap after a line started is refused by Rebuild's own code and moves nothing; Place still places", async () => {
    const r = await rig({ n: 5 });
    const ana = await arrive(r, "Ana Late");
    await startLine(r);
    const before = await linesOf(r.stageId);
    await expect(placeWaitingTableEntrant(r.auth, r.stageId, ana, undefined, { preferRebuild: true })).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
    expect((await linesOf(r.stageId)).length, "nothing written").toBe(before.length);
    expect((await listTableWaiting(r.auth, r.divisionId)).map((w) => w.entrantId), "she still waits").toEqual([ana]);
    expect((await placeWaitingTableEntrant(r.auth, r.stageId, ana)).case).toBe("catch_up");
  });
});
