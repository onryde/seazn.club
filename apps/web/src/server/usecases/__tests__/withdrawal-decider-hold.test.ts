// W2a loop R I-1 (ruling D-R1, option a). A chess knockout game drawn into its tie-break is `in_play` with no outcome
// (the module's phase "tiebreak"). The withdrawal cascade used to read it as a pending fixture and walk the opponent
// over with `core.forfeit` — which boardgame refuses outside phase "live" — so the withdrawal 422'd WRONG_PHASE and the
// entrant was never withdrawn. A fixture whose decider is still owed (the engine's `deciderPending`) is a HOLD, the
// C17 shape: nobody is walked over on it, and the organiser settles it for the remaining entrant.
// Ruling D-R7: the held decider must not seat the withdrawn entrant by the OTHER door either — a scorer recording the
// decider event itself (`boardgame.tiebreak {winner}`) is refused exactly as C17 refuses the settle.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS, deciderPending, type StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { scoreEvent } from "@/server/usecases/scoring";
import { BRACKET_WALKOVER_KINDS, createStages, generateStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Row = {
  status: string;
  outcome: { kind: string; winner?: string } | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
};
const row = async (id: string) =>
  (
    await sql<Row[]>`select status, outcome, home_entrant_id, away_entrant_id, winner_to_fixture
                     from fixtures where id = ${id}`
  )[0]!;
const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: Parameters<typeof scoreEvent>[0], id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);
const entrantStatus = async (id: string) =>
  (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;
const seated = async (fixtureId: string) => {
  const r = await row(fixtureId);
  return [r.home_entrant_id, r.away_entrant_id].filter((x) => x !== null);
};
const moduleOf = (sport: string): AnySportModule => builtinModules.find((m) => m.key === sport)!;
/** The engine's own verdict on the stored fold. An `in_play` row carries no active settle (a settle folds to
 *  `decided`), so the settlement is null — asserted by the caller's status check, not assumed. */
const pendingDecider = async (sport: string, fixtureId: string): Promise<boolean> => {
  const [m] = await sql<{ state: unknown }[]>`select state from match_states where fixture_id = ${fixtureId}`;
  return deciderPending(moduleOf(sport) as never, { state: (m?.state ?? null) as never, settlement: null });
};

/** How each sport that DECLARES a decider (`awaitingDecider`) is driven into it. Derived set check below: a new
 *  decider sport fails the sweep until it names its driver here. */
const DECIDER_DRIVERS: Record<string, (auth: Parameters<typeof scoreEvent>[0], id: string) => Promise<unknown>> = {
  // A drawn game in a bracket opens the tie-break (bracketDeciders → cfg.tiebreak), outcome null.
  boardgame: (auth, id) => post(auth, id, "boardgame.result", { winner: null, method: "agreement" }),
};

/** A started bracket fixture of `sport` (its first declared variant, or `variant`), both seats filled. */
async function started(sport: string, stageKind: StageKind, variant?: string) {
  const m = moduleOf(sport);
  const s = await seedBracket({
    sport,
    variant: declaredVariant(sport, variant ?? Object.keys(m.variants)[0]!),
    stageKind,
    entrants: 4,
  });
  const id = s.fixtureIds[0]!;
  await post(s.auth, id, "core.start");
  const r = await row(id);
  return { ...s, id, home: r.home_entrant_id!, away: r.away_entrant_id!, next: r.winner_to_fixture };
}

describe.skipIf(!HAS_DB)("I-1 (ruling D-R1): a withdrawal never walks over a fixture whose decider is pending", () => {
  it("I-1: chess knockout — a drawn game in its tie-break HOLDS on a withdrawal: the entrant is withdrawn, nobody is walked over, and the organiser's settle seats the remaining entrant", async () => {
    const t = await started("boardgame", "knockout", "classical");
    await DECIDER_DRIVERS.boardgame!(t.auth, t.id);
    expect((await row(t.id)).status, "the rig: a drawn KO game is in_play").toBe("in_play");
    expect(await pendingDecider("boardgame", t.id), "the rig: the engine owes a decider").toBe(true);
    const before = await seq(t.id);

    const out = await withdrawEntrantCascade(t.auth, t.away);

    expect(await entrantStatus(t.away)).toBe("withdrawn");
    expect(out.walkovers).toBe(0);
    expect(await seq(t.id), "nothing was written on the held fixture").toBe(before);
    expect((await row(t.id)).status).toBe("in_play");
    expect(await pendingDecider("boardgame", t.id), "the decider is still owed").toBe(true);
    expect(await seated(t.next!)).toEqual([]);
    // The second call: the withdrawal already happened, so it is refused and writes nothing.
    await expect(withdrawEntrantCascade(t.auth, t.away)).rejects.toMatchObject({ status: 409 });
    expect(await seq(t.id)).toBe(before);
    // The C17 settle: never for the withdrawn entrant, then for the remaining one — which seats them.
    await expect(post(t.auth, t.id, "core.settle", { winner: t.away, method: "organiser" })).rejects.toMatchObject({
      code: "SETTLE_NOT_APPLICABLE",
      data: { reason: "withdrawn" },
    });
    expect(await seq(t.id)).toBe(before);
    await post(t.auth, t.id, "core.settle", { winner: t.home, method: "organiser" });
    expect((await row(t.id)).status).toBe("decided");
    expect(await seated(t.next!)).toEqual([t.home]);
  });

  it("I-1 positive pair: chess knockout — a LIVE, undrawn game is walked over to the remaining entrant as today", async () => {
    const t = await started("boardgame", "knockout", "classical");
    expect(await pendingDecider("boardgame", t.id), "the rig: no decider owed while live").toBe(false);

    const out = await withdrawEntrantCascade(t.auth, t.away);

    expect(await entrantStatus(t.away)).toBe("withdrawn");
    expect(out.walkovers).toBe(1);
    const r = await row(t.id);
    expect(r.status).toBe("forfeited");
    expect(r.outcome).toMatchObject({ kind: "win", winner: t.home });
    expect(await seated(t.next!)).toEqual([t.home]);
  });

  it("I-1 (partial cascade): pending league games AND a drawn knockout decider — the whole cascade completes: the league games void, the decider holds, the entrant is withdrawn", async () => {
    // Before D-R1 the plan voided the league games (each its own committed write) and THEN 422'd on the knockout
    // walkover, leaving the games abandoned and the entrant still registered. Single sport: the decider is chess's.
    const s = await seedBracket({ sport: "boardgame", variant: declaredVariant("boardgame", "classical"), stageKind: "league", entrants: 4 });
    const [ko] = await createStages(s.auth, s.divisionId, { seq: 2, kind: "knockout", name: "S2", config: {}, progression: null } as never);
    await generateStageFixtures(s.auth, ko!.id);
    const [sf] = await sql<{ id: string; away: string }[]>`
      select id, away_entrant_id as away from fixtures
       where stage_id = ${ko!.id} and home_entrant_id is not null and away_entrant_id is not null
       order by fixture_no limit 1`;
    await post(s.auth, sf!.id, "core.start");
    await DECIDER_DRIVERS.boardgame!(s.auth, sf!.id);
    expect(await pendingDecider("boardgame", sf!.id), "the rig owes a decider").toBe(true);
    const league = async () =>
      sql<{ status: string }[]>`select status from fixtures where stage_id = ${s.stageId}
                                  and (home_entrant_id = ${sf!.away} or away_entrant_id = ${sf!.away})`;
    const before = await league();
    expect(before.length, "the entrant has league games").toBeGreaterThan(0);
    expect(before.every((r) => r.status === "scheduled"), "none played yet").toBe(true);
    const koSeq = await seq(sf!.id);

    const out = await withdrawEntrantCascade(s.auth, sf!.away);

    expect(await entrantStatus(sf!.away)).toBe("withdrawn");
    // Spec 05 §5: played < 50% of their table games ⇒ expunge — every one of them voids.
    expect(out.policy).toBe("expunge");
    expect(out.voided).toBe(before.length);
    expect((await league()).map((r) => r.status)).toEqual(before.map(() => "abandoned"));
    expect(out.walkovers).toBe(0);
    expect((await row(sf!.id)).status).toBe("in_play");
    expect(await seq(sf!.id)).toBe(koSeq);
  });

  it("I-1 sweep: every sport × every engine bracket kind — a live fixture is walked over (walkover kinds) or voided (the others); only a pending decider holds", async () => {
    // The decider sports, from the engine's declarations — never a typed list.
    const deciderSports = builtinModules.filter((m) => typeof m.awaitingDecider === "function").map((m) => m.key);
    expect(deciderSports.length, "the engine declares at least one decider sport").toBeGreaterThan(0);
    expect(Object.keys(DECIDER_DRIVERS).sort(), "every decider sport names its driver").toEqual([...deciderSports].sort());
    const kinds = [...BRACKET_KINDS];
    let live = 0;
    let held = 0;
    for (const kind of kinds)
      for (const m of builtinModules) {
        for (const drive of [false, true]) {
          if (drive && !deciderSports.includes(m.key)) continue;
          const label = `${m.key} ${kind}${drive ? " (decider pending)" : " (live)"}`;
          const t = await started(m.key, kind);
          if (drive) {
            await DECIDER_DRIVERS[m.key]!(t.auth, t.id);
            expect(await pendingDecider(m.key, t.id), `${label}: the rig owes a decider`).toBe(true);
          } else {
            expect(await pendingDecider(m.key, t.id), `${label}: the rig owes no decider`).toBe(false);
          }
          const before = await seq(t.id);
          await expect(withdrawEntrantCascade(t.auth, t.away), label).resolves.toMatchObject({ status: "withdrawn" });
          expect(await entrantStatus(t.away), label).toBe("withdrawn");
          const r = await row(t.id);
          if (!BRACKET_WALKOVER_KINDS.has(kind)) {
            // Open formats (page playoff, ladder): the remaining game voids, decider or not (header ruling).
            expect(r.status, label).toBe("abandoned");
          } else if (drive) {
            expect(r.status, label).toBe("in_play");
            expect(await seq(t.id), `${label}: nothing written`).toBe(before);
            expect(await pendingDecider(m.key, t.id), `${label}: still owed`).toBe(true);
          } else {
            expect(r.status, label).toBe("forfeited");
            // A walkover outcome is a `win` or an `award` (spec 03 §3, sport's choice); both name the winner.
            expect(r.outcome?.winner, label).toBe(t.home);
          }
          if (drive) held++;
          else live++;
        }
      }
    expect(live).toBe(kinds.length * builtinModules.length);
    expect(held).toBe(kinds.length * deciderSports.length);
    expect(held).toBeGreaterThan(0);
  }, 600_000);
});

/** Each decider EVENT type the engine declares (`deciderTypes`), with the payload naming its winner. Derived set check
 *  below: a new decider type fails until it names its payload here. */
const DECIDER_EVENT_PAYLOADS: Record<string, (winner: string) => unknown> = {
  "boardgame.tiebreak": (winner) => ({ rung: "armageddon", winner }),
};

/** scorers.test.ts's acceptOfficial (as organiser-only-events.test.ts copies it): a user with NO org role, accepted
 *  as an official on this fixture — a scorer, who may record a tie-break (it is not organiser-only). */
async function scorerOn(orgId: string, fixtureId: string): Promise<AuthCtx> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`scorer-${randomUUID().slice(0, 8)}@test.local`}, 'Scorer', true) returning id`;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${orgId}, 'Scorer', ${user!.id}) returning id`;
  const [official] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${orgId}, ${person!.id}, 'Scorer', ${sql.json(["referee"])}) returning id`;
  await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
            values (${orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;
  return { orgId, via: "session", userId: user!.id, role: null, keyId: null };
}

describe.skipIf(!HAS_DB)("D-R7: a held decider cannot seat a withdrawn entrant through the decider event", () => {
  it("D-R7: every engine decider event naming the withdrawn entrant is refused SETTLE_NOT_APPLICABLE (withdrawn) and writes nothing; naming the remaining entrant is accepted and seats them — for a scorer and for the organiser", async () => {
    const deciders = builtinModules.flatMap((m) => (m.deciderTypes ?? []).map((type) => ({ sport: m.key, type })));
    expect(deciders.length, "the engine declares at least one decider event").toBeGreaterThan(0);
    expect(Object.keys(DECIDER_EVENT_PAYLOADS).sort(), "every decider type names its payload").toEqual(
      deciders.map((d) => d.type).sort(),
    );
    const WHO = ["scorer", "organiser"] as const;
    let checked = 0;
    for (const d of deciders)
      for (const who of WHO) {
        const label = `${d.type} as ${who}`;
        const t = await started(d.sport, "knockout");
        await DECIDER_DRIVERS[d.sport]!(t.auth, t.id);
        await withdrawEntrantCascade(t.auth, t.away);
        expect(await pendingDecider(d.sport, t.id), `${label}: the rig holds an owed decider`).toBe(true);
        const auth = who === "scorer" ? await scorerOn(t.auth.orgId, t.id) : t.auth;
        const before = await seq(t.id);
        await expect(post(auth, t.id, d.type, DECIDER_EVENT_PAYLOADS[d.type]!(t.away)), label).rejects.toMatchObject({
          code: "SETTLE_NOT_APPLICABLE",
          data: { reason: "withdrawn", winner: t.away },
        });
        expect(await seq(t.id), `${label}: the refusal wrote nothing`).toBe(before);
        expect(await seated(t.next!), label).toEqual([]);
        expect(await pendingDecider(d.sport, t.id), `${label}: still owed`).toBe(true);
        // The positive pair: the remaining entrant's decider is recorded and seats them.
        await post(auth, t.id, d.type, DECIDER_EVENT_PAYLOADS[d.type]!(t.home));
        expect((await row(t.id)).status, label).toBe("decided");
        expect(await seated(t.next!), label).toEqual([t.home]);
        checked++;
      }
    expect(checked).toBe(deciders.length * WHO.length);
  }, 120_000);

  it("D-R7 negative pair: with nobody withdrawn, a scorer's decider naming either entrant is accepted (the refusal is the withdrawal's, not the decider's)", async () => {
    const t = await started("boardgame", "knockout", "classical");
    await DECIDER_DRIVERS.boardgame!(t.auth, t.id);
    const scorer = await scorerOn(t.auth.orgId, t.id);
    await post(scorer, t.id, "boardgame.tiebreak", DECIDER_EVENT_PAYLOADS["boardgame.tiebreak"]!(t.away));
    expect((await row(t.id)).status).toBe("decided");
    expect(await seated(t.next!)).toEqual([t.away]);
  });
});
