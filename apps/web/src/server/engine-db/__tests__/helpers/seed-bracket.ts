// W2a (Tasks 6–9) — seeds a real division through the usecases (pad-cfg-resolution.test.ts's own pattern), with
// ONE stage of the asked kind and its generated fixtures, STARTED so `scoreEvent` accepts writes. Real Postgres;
// callers skip without DATABASE_URL.
import { randomUUID } from "node:crypto";
import type { StageKind } from "@seazn/engine/core";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { decidersOffRules, stageRulesOverlay } from "@/lib/stage-decider-off";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createPerson } from "@/server/usecases/persons";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures, issueChallenge } from "@/server/usecases/stages";

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

/** Key-order-blind JSON, so a parsed division value and a builder's value compare by content. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

/** Review M-4 — the deciders a stage with NO rules of its own still plays because its DIVISION plays them: each decider
 *  key at which every-decider-off (`decidersOffRules`, through the product's one mapping) differs from the division's
 *  own value. Empty for every football and cricket variant (their divisions play none); ice hockey iihf and hockey
 *  fih-shootout play theirs. A decider the stage cannot switch off (boardgame's rungs, inherited) never appears. */
export function divisionPlayedDeciders(sport: string, variant: string, kind: StageKind, divisionConfig?: Record<string, unknown>): string[] {
  const m = builtinModules.find((x) => x.key === sport) as AnySportModule | undefined;
  if (m === undefined) throw new Error(`seedBracket: no sport ${sport}`);
  const raw = divisionConfig ?? (m.variants[declaredVariant(sport, variant)] as Record<string, unknown>);
  const parsed = m.configSchema.safeParse(raw);
  const division = (parsed.success ? parsed.data : raw) as Record<string, unknown>;
  const off = stageRulesOverlay(m, division, decidersOffRules(m, variant, kind));
  return deciderKeysFor(m, kind, variant).filter((k) => Object.hasOwn(off, k) && canonical(off[k]) !== canonical(division[k]));
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
  /** The stage's own config; a swiss stage must declare `rounds` (assertSwissRoundsDeclared). */
  stageConfig?: Record<string, unknown>;
  /** W2c — the stage's own match rules (`stages.config.rules`), written straight onto the row AFTER `createStages`
   *  and before the fixtures are generated, REPLACING what the create stored: since Task 12 a new bracket stage stores
   *  its sport's preset (football's extra time and penalties, ice hockey's overtime and shoot-out, the super over).
   *  - absent: that preset;
   *  - `{}`: no stage rules at all, so the stage plays its division's config. This is the HELD rig's shorthand (every
   *    preset decider off), and it holds only where the division plays no decider of its own: every football and
   *    cricket variant. Where the division DOES play one (ice hockey iihf, hockey fih-shootout), `{}` is refused by
   *    name before anything is written (review M-4). Pass `decidersOffRules(sport, variant, kind)` for a held rig there;
   *  - `"division"`: no stage rules, the division's own deciders kept on purpose (unchecked);
   *  - anything else: exactly those rules.
   *  Raw SQL on purpose: a test may seed rules the endpoint would refuse. */
  stageRules?: Record<string, unknown> | "division";
  /** W2d T9 — the stage's own points rule (`stages.config.points`), written straight onto the row AFTER `createStages` and
   *  BEFORE the fixtures are generated, so the pin written at activation (spec §5.4, OC2) carries it. Raw SQL on purpose:
   *  a test may seed a rule the stage door would refuse (a set sport's walkover `awardScore`, an ot/so split W2c could
   *  not express). A rule written after the generate would never reach the table: the stage is pinned by then. */
  stagePoints?: Record<string, unknown>;
}): Promise<SeededBracket> {
  const variant = declaredVariant(opts.sport, opts.variant);
  const sportModule = builtinModules.find((x) => x.key === opts.sport)!;
  if (opts.stageRules !== undefined && opts.stageRules !== "division" && Object.keys(opts.stageRules).length === 0) {
    const played = divisionPlayedDeciders(opts.sport, variant, opts.stageKind, opts.divisionConfig);
    if (played.length > 0) {
      throw new Error(
        `seedBracket: stageRules {} is not every decider off for ${opts.sport}/${variant} — its division plays ${played.join(", ")}. ` +
          `Pass decidersOffRules(sport, variant, kind) for a held rig, or "division" to keep the division's deciders on purpose.`,
      );
    }
  }
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
  // americano pairs individuals on the fly, and only individuals with a linked person (stages.ts americanoGen).
  const member = async (name: string) =>
    opts.stageKind !== "americano"
      ? []
      : [
          {
            person_id: (await createPerson(auth, { full_name: name, consent: {}, dob: null, gender: null, external_ref: null })).id,
            is_captain: false,
            roles: [],
            default_position_key: null,
            squad_number: null,
          },
        ];
  await createEntrants(
    auth,
    division.id,
    await Promise.all(
      Array.from({ length: opts.entrants }, async (_, i) => ({
        kind,
        display_name: `B${i + 1}`,
        seed: i + 1,
        members: await member(`B${i + 1}`),
      })),
    ),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: opts.stageKind, name: "S1", config: opts.stageConfig ?? {}, progression: null });
  if (opts.stageRules !== undefined) {
    const n =
      opts.stageRules === "division" || Object.keys(opts.stageRules).length === 0
        ? await sql`update stages set config = config - 'rules' where id = ${stage!.id}`
        : await sql`update stages set config = config || ${sql.json({ rules: opts.stageRules } as never)} where id = ${stage!.id}`;
    if (n.count !== 1) throw new Error("seedBracket: the stage rules were not written"); // R13
  }
  if (opts.stagePoints !== undefined) {
    const n = await sql`update stages set config = config || ${sql.json({ points: opts.stagePoints } as never)} where id = ${stage!.id}`;
    if (n.count !== 1) throw new Error("seedBracket: the stage points were not written");
  }
  await generateStageFixtures(auth, stage!.id);
  // swiss: the first generate plants empty round shells; the second pairs round 1 (stages.ts swissGen).
  if (opts.stageKind === "swiss") await generateStageFixtures(auth, stage!.id);
  // `scoreEvent` refuses a division that has not started (division-phase.ts); appendEvent does not ask.
  await startDivision(auth, division.id);
  // A ladder generates no fixture — a challenge is how one exists. Seed 2 challenges seed 1 (adjacent rungs, inside
  // any reach), so the contract below (a seated fixture) holds for a ladder too (W2a loop R I-1's bracket-kind sweep).
  if (opts.stageKind === "ladder") {
    const [one, two] = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${division.id} order by seed limit 2`;
    await issueChallenge(auth, stage!.id, { challenger_id: two!.id, opponent_id: one!.id });
  }
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
