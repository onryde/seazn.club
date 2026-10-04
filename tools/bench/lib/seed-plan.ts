// seed-plan.ts — the PURE pack -> seed-plan mapping.
//
// `buildSeedPlan` is a pure function of its `Pack` argument: no `fetch`, no
// `postgres`, no `process.env`, no `Date.now()`, no `randomUUID`. Every REST
// call the (not-yet-written) HTTP driver will make is resolved here in
// advance, in order, down to the exact request-body field names — with ONE
// deliberate exception: a pack ref (`p-ana`, `e-alpha`, ...) is never a real
// database id, and this module does no network, so it cannot mint one. A
// `*Ref` field below is the placeholder the HTTP driver resolves once the
// real create-call returns an id, the same way `suites/tiny.ts`'s
// `runTinySuite` already does for court/division/stage ids returned mid-run
// (`lib/suites/tiny.ts:238-281`) — this file just extends that pattern to
// persons and entrant rosters, which `tinyPlan` never needed to resolve.
//
// No run-tag parameter, on purpose. `tinyPlan` (`lib/suites/tiny.ts:100`)
// resolves `pack.competition.name` LITERALLY and lets `runTinySuite` append
// its `runTag` at HTTP-call time (`lib/suites/tiny.ts:255`); this file keeps
// that same split. A run tag is exactly the kind of "run-varying" value the
// B03 brief says must be a caller-supplied parameter rather than something
// this module invents — and the existing precedent is that it is not this
// layer's parameter at all, it is the HTTP driver's.
//
// ---------------------------------------------------------------------------
// The coach/staff/official ruling (owner decision, B03 brief)
// ---------------------------------------------------------------------------
// `PackPerson.lane` is `"player" | "official" | "coach" | "staff"`
// (`pack-schema.ts:195`), and every lane a `persons` row can hold is now sent
// as itself:
//
//   - "player"/"coach"/"staff" -> `CreatePerson.lane`, explicitly, always.
//     `PersonLane` is `z.enum(["player","coach","staff"])` and `createPerson`
//     writes `${input.lane ?? "player"}`.
//
// This module's FIRST cut could not do that, and the note it carried here is
// worth keeping as history because it is the shape of a mistake this bench
// exists to prevent. `persons.lane` admitted 'coach'/'staff' from V356 while
// no write path in `apps/web/src` set either, and `CreatePerson` had no
// `lane` field at all — so the lane was mapped onto the nearest REACHABLE
// surface instead: a coach's ROSTER membership gained "coach" in
// `entrant_members.roles`, appended to whatever the pack declared.
//
// That was the right call while the gap was open and it is the wrong one now.
// It made the bench synthesise a role the pack never declared, which is the
// bench proving itself rather than the product. The gap was raised as G1 of
// `docs/superpowers/specs/2026-09-02-product-gaps-from-bench-b03-prompt.md`
// and closed by PR #706: `CreatePerson.lane` exists, is optional, and is
// persisted. So the lane goes in the lane column and a roster member's
// `roles` are now the pack's declared roles VERBATIM.
//
// `LineupSlotInput.role` (`schemas.ts`) remains the PER-FIXTURE lineup-slot
// surface the same S3/#426 ruling governs, and still belongs to the
// event-import driver that reads `PackStream.lineups` — out of scope here,
// since streams are not one of this module's six resolve targets.
//   - "official" -> NOT an entrant-roster person at all. `CreateOfficial`
//     (`schemas.ts:3069-3077`) takes `person_id` as OPTIONAL, so an official
//     needs no `persons` row from this plan either — excluded from `persons`
//     entirely and surfaced only as a ref in `officialPersonRefs`.
//     `pack.officials[]` itself IS resolved by this module as of B03 T6 (see
//     `SeedPlanOfficial` below) — but resolving an official's ROW is not the
//     same as resolving its `person` field to a real id: see that type's own
//     header comment for why `PackOfficial.person` stays informational only.
//
// `checkRosters` (`pack-schema.ts:1497`) does not forbid an official-lane
// person from appearing in `entrants[].roster[]` — it only counts
// lane==="player" members for the pair/individual minimums — so a
// schema-legal pack could still author that mistake. `buildSeedPlan` refuses
// it rather than silently building a roster member whose person was never
// added to `persons` (see the throw in `buildRosterMember` below): a plan
// that did NOT refuse would hand the HTTP driver a `personRef` with nothing
// in `plan.persons` to resolve it against.
//
// ---------------------------------------------------------------------------
// Divisions/stages carry ONLY what CreateDivision/CreateStage accept
// ---------------------------------------------------------------------------
// `PackDivision.moduleVersion` (the offline-fold engine pin), `.entry` (B03r
// reservation) and `.scheduleConfig` (B04 reservation) are deliberately left
// off `SeedPlanDivision` — none of those three is a `CreateDivision` field
// (`schemas.ts:225-250`), and `scheduleConfig` is explicitly chartered to B04
// by the pack schema's own comment on that field.
//
// `.tiebreakers` was in that list and did not belong there: it IS a real
// `CreateDivision` field (`schemas.ts:233`, `z.array(TiebreakerKeyS).nullish()`)
// and it is now threaded through. The claim was wrong in the most expensive
// way available — `_tiny.json` declares `"tiebreakers": ["points", "diff"]`,
// so the only pack in existence was silently losing its tie order, and the
// pack's own `expected.tables` rank assertions would have failed against the
// PRODUCT for a value the BENCH never sent. The two vocabularies are
// identical (19 keys, same order) and the pack's side is bidirectionally
// compile-checked against the engine's own `TiebreakerKey` union
// (`pack-schema.ts:317-318`), so the array passes straight through.
//
// `PackStage.progression` is likewise a real `CreateStage` field
// (`schemas.ts:819`) and was being dropped for the same reason. Note the
// asymmetry when sending these: `CreateStage` is `.strict()`
// (`schemas.ts:821`) so an undeclared key is REJECTED, while `CreateDivision`
// is non-strict and silently DROPS one — the RS007/V380 comment at
// `schemas.ts:233` records a division-creation wizard that lost its entire
// eligibility block exactly that way. Both are therefore omitted as absent
// KEYS rather than sent as `undefined`.
//
// Runtime constraints (GLOBAL.md, unchanged from B02): no TS `enum`, no
// `namespace`, no emit-dependent syntax — this runs under `node
// --experimental-strip-types`. Every relative import carries `.ts`. Nothing
// here imports from `apps/web` — every product field name below is a hand
// mirror, verified against the cited schemas.ts lines, never an import.
import { expectedFixtureCount } from "./pack-io.ts";
import type {
  Pack,
  PackClaimInvite,
  PackJsonValue,
  PackPersonLane,
  PackRosterMember,
} from "./pack-schema.ts";

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface SeedPlanOrg {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
}

export interface SeedPlanCompetition {
  readonly name: string;
  readonly slug?: string;
  readonly startsOn?: string;
  readonly endsOn: string;
  readonly description?: string;
}

export interface SeedPlanStage {
  readonly ref: string;
  readonly seq: number;
  readonly kind: string;
  readonly name: string;
  readonly config: Record<string, PackJsonValue>;
  /** `CreateStage.progression` (`schemas.ts:819`), carried opaque and verbatim
   *  for the same reason `config` is: the authority is the product's own
   *  `ProgressionSchema`, and a second copy of that vocabulary here is how two
   *  shapes of one fact drift apart. Absent when the pack declares none —
   *  `CreateStage` is `.strict()`, so a key present-but-undefined is a
   *  rejection rather than a no-op. */
  readonly progression?: Record<string, PackJsonValue>;
}

export interface SeedPlanDivision {
  readonly ref: string;
  readonly name: string;
  /** Spelled as `CreateDivision` spells it (`schemas.ts:229-230`) — like every
   *  other body field on this plan. The pack's own camelCase stops at this
   *  boundary; carrying it further is how a rename gets forgotten at the one
   *  call site that has to do it. */
  readonly sport_key: string;
  readonly variant_key: string;
  /** `pack.divisions[].cfgOverrides`, carried opaque and verbatim — the
   *  server merges it over the variant preset and validates it, exactly as
   *  `createDivision` does (pack-schema.ts's own comment on this field). */
  readonly config: Record<string, PackJsonValue>;
  /** `CreateDivision.tiebreakers` (`schemas.ts:233`). Absent when the pack
   *  declares none — see the header note; this field was dropped entirely by
   *  the first cut of this module and `_tiny` was losing its tie order. */
  readonly tiebreakers?: readonly string[];
  readonly stages: readonly SeedPlanStage[];
}

/** `POST /persons` body fields (`CreatePerson`, `schemas.ts:488-495`).
 *
 *  `external_ref` is omitted — nothing in a pack maps onto it (header note 4
 *  on `PackSchema`: a pack ref is stored nowhere). `consent` is NOT omitted,
 *  and the reason is on the field itself: leaving it to the server default is
 *  legal, silent, and wrong for a bench seed. `lane` is set for the same
 *  reason — see its own doc. */
export interface SeedPlanPerson {
  readonly ref: string;
  readonly full_name: string;
  readonly dob?: string;
  /** `"x"` included because the PRODUCT accepts it — `CreatePerson.gender` is
   *  `z.enum(["m","f","x"]).nullish()` (`api-v1/schemas.ts:502`), as are every
   *  other person-shaped schema there. This interface was narrower than the
   *  API it writes to, so a bench pack could never seed a non-binary person
   *  even though the product has supported one since RS002 — and the product's
   *  own "x never blocks a category gate" exemption
   *  (`lib/registration-rules.ts:172-190`) was therefore unreachable from any
   *  bench run. Widened with `PackPerson.gender` in B03r. */
  readonly gender?: "m" | "f" | "x";
  /**
   * The pack's own lane, sent EXPLICITLY — including `"player"`, which is
   * also the column default. Same reasoning as `consent` below: relying on a
   * server default is legal and silent, and a bench that leans on one cannot
   * tell "the product defaulted correctly" from "the bench forgot to ask".
   *
   * `"official"` is absent by construction, not by omission: `PersonLane` is
   * `z.enum(["player","coach","staff"])` and an official's `persons` row is
   * minted by `inviteOfficial`, not by this plan — see `officialPersonRefs`.
   */
  readonly lane: "player" | "coach" | "staff";
  /**
   * ALWAYS `{ public_name: true }` — seeded deliberately, never omitted.
   *
   * `CreatePerson.consent` is `Consent` (`schemas.ts:480-485`), which carries
   * `.default({})`, so leaving it off is legal and lands `{}`. That is the
   * trap: the two consent gates in this product have OPPOSITE polarity.
   * Public entrant/roster name display is opt-OUT (`anyOptedOut`, hiding only
   * on an explicit `public_name === false`), but the player card is opt-IN —
   * `public_players_v`'s predicate is
   * `where coalesce((p.consent->>'public_name')::boolean, false)`, identical
   * across all three versions of the view (V237 -> V307 -> V350). A person
   * seeded with `{}` therefore has a visible name on the entrant list and NO
   * player card, which is the shape that looks fine until an oracle reads it.
   *
   * The cost lands in B05, not here: bench design §4 names
   * "stats/leaderboards/player cards/standings/news" as the browsable payoff
   * the suites assert against. An un-consented seed would make the
   * player-card oracle read an empty view and report the product as broken
   * for a state the BENCH created — an oracle asserting against its own
   * omission, which is the inert-seam failure wearing a different hat.
   *
   * Not invented, and not a pack field: this is what the product's own
   * primary registration path writes on its INSERT branch
   * (`usecases/registrations.ts:670` — "consent defaults to public_name=true
   * on the INSERT branch only (ruling 5)"). A bench-seeded person is the
   * admin-side analogue of that registrant, so it takes the same default. No
   * `PackSchema` field was added for it, because nothing in any pack needs to
   * vary it and the schema freezes at the end of B06 — a knob with no
   * consumer is exactly what that freeze exists to keep out.
   */
  readonly consent: { readonly public_name: true };
}

/** One `entrant_members` row-to-be. `personRef` is a placeholder, not a
 *  `person_id` — see the header comment on refs vs. ids. The other four
 *  fields are the exact `EntrantMemberInput` field names
 *  (`schemas.ts:365-370`), fully resolved and ready to spread into the real
 *  request once the driver has a real `person_id` for `personRef`. */
export interface SeedPlanRosterMember {
  readonly personRef: string;
  readonly squad_number?: number;
  readonly default_position_key?: string;
  readonly is_captain: boolean;
  readonly roles: readonly string[];
}

export interface SeedPlanEntrant {
  readonly ref: string;
  readonly divisionRef: string;
  readonly kind: string;
  readonly display_name: string;
  readonly seed?: number;
  readonly members: readonly SeedPlanRosterMember[];
}

export interface SeedPlanExpectedFixtureCount {
  readonly divisionRef: string;
  readonly stageRef: string;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Officials + claim invites (B03 T6)
// ---------------------------------------------------------------------------
// `PackOfficial.person` — THE FINDING, recorded here rather than papered
// over: it CANNOT be resolved to a real `person_id` by this plan (or by the
// HTTP driver that consumes it). `POST /officials` takes `person_id` as
// OPTIONAL (pack-schema.ts's own doc on `PackOfficial`), and the only writer
// that ever mints a `persons` row for an official is `POST /officials/{id}/
// invite` (`inviteOfficial`, usecases/officials.ts:183) — which requires an
// EMAIL `PackOfficial` does not declare, and which mints an (unrequested)
// claim invite as a side effect the moment it is called. There is no way to
// honour "this official IS person p-dee" without either fabricating an email
// the pack never authored or silently inviting a claim nobody asked for —
// both worse than the alternative. So `SeedPlanOfficial.personRef` below is
// carried through for TRACEABILITY ONLY (so a report can say which pack
// person an official's row was meant to represent); the HTTP driver never
// sends it as `person_id`, and `POST /officials` is always called with that
// field omitted. `checkReservations` (pack-schema.ts:2093-2099) still
// requires the ref to resolve to a lane="official" person — that rule stays
// meaningful as pack-authoring hygiene (an official-shaped person is
// declared, even though this layer cannot yet wire the two together), it
// just is not a rule this module or `seed.ts` can act on.
export interface SeedPlanOfficialBlackout {
  readonly date: string;
  readonly note?: string;
}

/** `PackOfficialAssignment`, resolved to nothing more than the plan can
 *  offer offline — `fixtureExtKey`/`divisionRef` still need a real fixture
 *  id, which only the HTTP driver has (post-`/generate`). */
export interface SeedPlanOfficialAssignment {
  readonly divisionRef: string;
  readonly fixtureExtKey: string;
  readonly roleKey?: string;
}

/** `POST /officials` body fields (`CreateOfficial`), plus the pack's own
 *  blackouts/assignments carried through verbatim. An official with a
 *  non-empty `assignments` is MANUAL (the driver PATCHes it onto its named
 *  fixture); one with none is left to `autoAssignOfficials` — the pack's own
 *  rule (pack-schema.ts:768-769), not a switch this plan invents. */
export interface SeedPlanOfficial {
  readonly ref: string;
  /** See the header comment above — informational only, never sent as
   *  `person_id`. */
  readonly personRef: string;
  readonly display_name: string;
  readonly role_keys: readonly string[];
  readonly max_per_day?: number;
  readonly unavailable: readonly SeedPlanOfficialBlackout[];
  readonly assignments: readonly SeedPlanOfficialAssignment[];
}

/** `POST /persons/{id}/claim-invites` body is just `{email}` — `personRef`
 *  is what the HTTP driver resolves to the real `person_id` in the path. */
export interface SeedPlanClaimInvite {
  readonly personRef: string;
  readonly email: string;
}

export interface SeedPlan {
  readonly org: SeedPlanOrg;
  readonly competition: SeedPlanCompetition;
  readonly divisions: readonly SeedPlanDivision[];
  readonly persons: readonly SeedPlanPerson[];
  readonly entrants: readonly SeedPlanEntrant[];
  /** Lane "official" persons, refs only — see the header comment. A later
   *  task cross-references `pack.persons`/`pack.officials` by ref itself;
   *  this plan does not restate either. */
  readonly officialPersonRefs: readonly string[];
  /** `pack.officials`, resolved. Empty when the pack declares none —
   *  `PackSchema.officials` is `.optional()`. */
  readonly officials: readonly SeedPlanOfficial[];
  /** `pack.claimInvites`, resolved. Empty when the pack declares none. */
  readonly claimInvites: readonly SeedPlanClaimInvite[];
  /** One entry per LEAGUE stage only — `expectedFixtureCount`
   *  (`pack-io.ts:154`) itself refuses a non-league stage rather than
   *  answer a number it cannot derive, so a bracket/group/swiss/etc. stage
   *  simply has no entry here, not a wrong one. */
  readonly expectedFixtureCounts: readonly SeedPlanExpectedFixtureCount[];
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

function buildRosterMember(
  m: PackRosterMember,
  laneByRef: ReadonlyMap<string, PackPersonLane>,
  entrantRef: string,
): SeedPlanRosterMember {
  const lane = laneByRef.get(m.person);
  if (lane === undefined) {
    // Belt and suspenders: `checkRosters` (pack-schema.ts:1497) already
    // reports an unknown person ref on a pack that fails to parse, so a
    // caller handing this function an already-validated `Pack` cannot reach
    // this branch. Kept for a caller that builds a `Pack` by hand (a test,
    // or a future one) bypassing `PackSchema.parse`.
    throw new Error(`entrant "${entrantRef}" rosters unknown person ref "${m.person}"`);
  }
  if (lane === "official") {
    throw new Error(
      `entrant "${entrantRef}" rosters person "${m.person}", whose lane is "official" — officials are not ` +
        `entrant-roster members (the coach/staff/official ruling, B03 brief): they belong in ` +
        `officialPersonRefs, not in a division's roster`,
    );
  }
  return {
    personRef: m.person,
    ...(m.squadNumber === undefined ? {} : { squad_number: m.squadNumber }),
    ...(m.positionKey === undefined ? {} : { default_position_key: m.positionKey }),
    is_captain: m.captain,
    // VERBATIM. A coach's lane used to be appended here because `persons.lane`
    // had no writer; it does now (`CreatePerson.lane`, PR #706), so the lane
    // travels as the lane and this carries only what the pack declared.
    roles: m.roles,
  };
}

/** Mirrors `buildRosterMember`'s own official-lane guard: `checkReservations`
 *  (pack-schema.ts:2107-2123) does not forbid a claim invite naming an
 *  official-lane person — it only checks the ref is known — so a
 *  schema-legal pack could still author that mistake. An official-lane
 *  person gets no `persons` row from THIS plan (the header comment above),
 *  so there is no `person_id` for `POST /persons/{id}/claim-invites` to
 *  target; refused here rather than handed to the HTTP driver as a
 *  `personRef` with nothing in `plan.persons` to resolve it against. */
function buildClaimInvite(
  c: PackClaimInvite,
  laneByRef: ReadonlyMap<string, PackPersonLane>,
): SeedPlanClaimInvite {
  const lane = laneByRef.get(c.person);
  if (lane === undefined) {
    throw new Error(`claim invite references unknown person ref "${c.person}"`);
  }
  if (lane === "official") {
    throw new Error(
      `claim invite references person "${c.person}", whose lane is "official" — an official-lane person gets ` +
        `no "persons" row from this plan (see SeedPlanOfficial's header comment), so there is no person_id for ` +
        `POST /persons/{id}/claim-invites to target`,
    );
  }
  return { personRef: c.person, email: c.email };
}

/**
 * The pack, resolved into every REST call the seeder will make, in order,
 * with nothing left to decide at network time except the real ids a create
 * call returns (see the header comment on `*Ref` fields).
 *
 * Handles N divisions and N stages — the generalisation `tinyPlan`
 * (`lib/suites/tiny.ts:100`) deliberately refuses, since `_tiny` is the
 * one-division prototype this function grows into.
 */
export function buildSeedPlan(pack: Pack): SeedPlan {
  const org: SeedPlanOrg = {
    name: pack.org.name,
    slug: pack.org.slug,
    timezone: pack.org.timezone,
  };

  const competition: SeedPlanCompetition = {
    name: pack.competition.name,
    ...(pack.competition.slug === undefined ? {} : { slug: pack.competition.slug }),
    ...(pack.competition.startsOn === undefined ? {} : { startsOn: pack.competition.startsOn }),
    endsOn: pack.competition.endsOn,
    ...(pack.competition.description === undefined ? {} : { description: pack.competition.description }),
  };

  const divisions: SeedPlanDivision[] = pack.divisions.map((d) => ({
    ref: d.ref,
    name: d.name,
    sport_key: d.sportKey,
    variant_key: d.variantKey,
    config: d.cfgOverrides,
    ...(d.tiebreakers === undefined ? {} : { tiebreakers: d.tiebreakers }),
    stages: d.stages.map((s) => ({
      ref: s.ref,
      seq: s.seq,
      kind: s.kind,
      name: s.name,
      config: s.config,
      ...(s.progression === undefined ? {} : { progression: s.progression }),
    })),
  }));

  // Every player/coach/staff person becomes a `persons` row; officials do
  // not (see the header comment — `CreateOfficial.person_id` is optional).
  const persons: SeedPlanPerson[] = pack.persons
    .filter((p): p is typeof p & { lane: "player" | "coach" | "staff" } => p.lane !== "official")
    .map((p) => ({
      ref: p.ref,
      full_name: p.fullName,
      lane: p.lane,
      ...(p.dob === undefined ? {} : { dob: p.dob }),
      ...(p.gender === undefined ? {} : { gender: p.gender }),
      // Every lane that gets a `persons` row gets the consent too — a coach
      // has a player card exactly like a player does. See the field's doc.
      consent: { public_name: true } as const,
    }));

  const officialPersonRefs = pack.persons.filter((p) => p.lane === "official").map((p) => p.ref);

  const laneByRef = new Map(pack.persons.map((p) => [p.ref, p.lane] as const));
  const entrants: SeedPlanEntrant[] = pack.entrants.map((e) => ({
    ref: e.ref,
    divisionRef: e.divisionRef,
    kind: e.kind,
    display_name: e.displayName,
    ...(e.seed === undefined ? {} : { seed: e.seed }),
    members: e.roster.map((m) => buildRosterMember(m, laneByRef, e.ref)),
  }));

  const expectedFixtureCounts: SeedPlanExpectedFixtureCount[] = [];
  for (const d of pack.divisions) {
    for (const s of d.stages) {
      if (s.kind !== "league") continue;
      expectedFixtureCounts.push({
        divisionRef: d.ref,
        stageRef: s.ref,
        count: expectedFixtureCount(pack, d.ref, s.ref),
      });
    }
  }

  // `pack.officials`/`pack.claimInvites` are `.optional()` on `PackSchema`
  // (the pre-freeze reservations) — `?? []` is the "declares none" case,
  // matching every other optional pack block this module resolves.
  const officials: SeedPlanOfficial[] = (pack.officials ?? []).map((o) => ({
    ref: o.ref,
    personRef: o.person,
    display_name: o.displayName,
    role_keys: o.roleKeys,
    ...(o.maxPerDay === undefined ? {} : { max_per_day: o.maxPerDay }),
    unavailable: o.unavailable.map((u) => ({
      date: u.date,
      ...(u.note === undefined ? {} : { note: u.note }),
    })),
    assignments: o.assignments.map((a) => ({
      divisionRef: a.divisionRef,
      fixtureExtKey: a.fixtureExtKey,
      ...(a.roleKey === undefined ? {} : { roleKey: a.roleKey }),
    })),
  }));

  const claimInvites: SeedPlanClaimInvite[] = (pack.claimInvites ?? []).map((c) =>
    buildClaimInvite(c, laneByRef),
  );

  return {
    org,
    competition,
    divisions,
    persons,
    entrants,
    officialPersonRefs,
    officials,
    claimInvites,
    expectedFixtureCounts,
  };
}
