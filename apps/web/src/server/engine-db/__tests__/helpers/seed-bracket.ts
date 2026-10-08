// W2a (Tasks 6–9) — seeds a real division through the usecases (pad-cfg-resolution.test.ts's own pattern), with
// ONE stage of the asked kind and its generated fixtures, STARTED so `scoreEvent` accepts writes. Real Postgres;
// callers skip without DATABASE_URL.
import { randomUUID } from "node:crypto";
import type { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";

/** Preflight C14: a variant key the sport DECLARES in `module.variants` (an engine declaration), never a guessed
 *  literal — "fide"/"fifa" are not declared keys; boardgame declares classical/rapid/blitz, football "11-a-side",
 *  generic win_loss/score, carrom icf/"club-29", badminton bwf/short. */
export function declaredVariant(sport: string, key: string): string {
  const m = builtinModules.find((x) => x.key === sport);
  if (m === undefined || !Object.hasOwn(m.variants, key)) {
    throw new Error(
      `seedBracket: ${sport} declares no variant "${key}" (declared: ${m === undefined ? "no such sport" : Object.keys(m.variants).join(", ")})`,
    );
  }
  return key;
}

export interface SeededBracket {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** Every generated fixture with BOTH seats filled, in `fixture_no` order. */
  fixtureIds: string[];
}

export async function seedBracket(opts: {
  sport: string;
  variant: string;
  stageKind: StageKind;
  entrants: number;
  divisionConfig?: Record<string, unknown>;
}): Promise<SeededBracket> {
  const variant = declaredVariant(opts.sport, opts.variant);
  const sportModule = builtinModules.find((x) => x.key === opts.sport)!;
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Bo " + suffix}, ${"bo-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Bo Cup " + suffix, visibility: "private", branding: {} });
  // The variant's own declared config unless the caller names one: generic, for one, has no all-default cfg.
  const config = opts.divisionConfig ?? (sportModule.variants[variant] as Record<string, unknown>);
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: opts.sport,
    variant_key: variant,
    config,
  });
  // The entrant kind the sport DECLARES as its default (engine `entrantModel`), never a typed list of team sports.
  const kind = sportModule.entrantModel?.defaultKind ?? "individual";
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.entrants }, (_, i) => ({ kind, display_name: `B${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: opts.stageKind, name: "S1", config: {}, progression: null });
  await generateStageFixtures(auth, stage!.id);
  // `scoreEvent` refuses a division that has not started (division-phase.ts); appendEvent does not ask.
  await startDivision(auth, division.id);
  const rows = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stage!.id}
       and home_entrant_id is not null and away_entrant_id is not null
     order by fixture_no`;
  if (rows.length === 0) throw new Error(`seedBracket: ${opts.stageKind} generated no seated fixture`); // R13
  return { auth, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, fixtureIds: rows.map((r) => r.id) };
}

/** Events written by raw SQL with config_snapshot left NULL: the pre-V347 shape, the one shape in which a READ
 *  path resolves LIVE cfg for a fixture with history — so it is where a read caller's overlay is observable. */
export async function insertLegacyEvents(fixtureId: string, events: readonly { type: string; payload: unknown }[]): Promise<void> {
  let seq = 0;
  for (const e of events) {
    seq++;
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
              values (${randomUUID()}, ${fixtureId}, ${seq}, ${e.type}, ${sql.json(e.payload as never)}, now())`;
  }
}
