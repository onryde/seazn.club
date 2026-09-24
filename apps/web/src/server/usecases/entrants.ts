import "server-only";
// Entrant use-cases (doc 08 §3): registration (single + bulk), withdraw/seed/
// member management. Cross-org person references die at the RLS boundary — a
// person the tenant can't see doesn't exist.
import type postgres from "postgres";
import { createHash } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertWithinLimit, getLimit } from "@/lib/entitlements";
import { resolveModule } from "@/server/engine-db/registry";
import {
  effectiveEntrantModel,
  entrantKindCap,
  type EffectiveEntrantModel,
  type EntrantKind,
} from "@seazn/engine/sport";
import { loadTeamSquad } from "./teams";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { z } from "zod";
import type {
  CreateEntrant,
  CreateEntrantMemberInput,
  PatchEntrant,
  EntrantMemberInput,
  EligibilityOverride,
} from "@/server/api-v1/schemas";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { gateRosterEligibility, type EligibilityIssue } from "./registration-eligibility";
// One-way edge (stages.ts does not import this module): a status flip has to
// reach the seed proposals that were computed over the old field, and a
// pre-Start DELETE has to leave the swiss rounds it was seated in coherent.
import {
  deleteRestByesHeldBy,
  markFieldChangeSeedProposalsStale,
  reconcileDivisionRestByes,
  unseatSwissRoundsSeatingEntrant,
} from "./stages";
import { followRosterEdit, type RosterNamePerson } from "@/lib/entrant-roster-name";
import { dropNamedPublicDocuments, fireScoreRevalidate } from "@/server/public-site/revalidate";
import { retireCompetitionPlayerMatches } from "@/server/public-site/player-matches-cache-keys";
import { log } from "@/server/logger";

type Tx = postgres.TransactionSql;
type MemberInput = z.infer<typeof EntrantMemberInput>;
type CreateMemberInput = z.infer<typeof CreateEntrantMemberInput>;

/** PROMPT-60 §2 — resolve inline `new_person` members into persons rows
 *  (created in THIS transaction) so the linker only ever sees person_id
 *  members. Inline persons are never merged with existing org persons.
 *  RS011: `dob`/`gender` are optional on `new_person` — an organiser typing
 *  a name alone still creates the person, just with nothing to evaluate an
 *  age/gender rule against (the MISSING_DOB/MISSING_GENDER warning state at
 *  the gate below, not a bug). */
async function resolveInlineMembers(
  tx: Tx,
  orgId: string,
  members: readonly CreateMemberInput[],
): Promise<MemberInput[]> {
  const out: MemberInput[] = [];
  for (const m of members) {
    if ("new_person" in m) {
      // G1 (bench B03 product-gaps): registering a coach/staff member AS
      // PART OF THE SQUAD — V356's own motivating scenario ("a team official
      // is IN the squad so a card can be shown to him, but never in a
      // playing projection").
      const [person] = await tx<{ id: string }[]>`
        insert into persons (org_id, full_name, dob, gender, consent, lane)
        values (${orgId}, ${m.new_person.full_name}, ${m.new_person.dob ?? null},
                ${m.new_person.gender ?? null}, ${tx.json({} as never)}, ${m.new_person.lane ?? "player"})
        returning id`;
      out.push({
        person_id: person!.id,
        squad_number: m.squad_number ?? null,
        default_position_key: m.default_position_key ?? null,
        is_captain: m.is_captain,
        roles: m.roles,
      });
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Drop position/role keys the target division's sport doesn't define, keeping
 *  the member. Returns the cleaned roster plus a count of dropped keys so the
 *  caller can tell the organiser "N settings didn't carry over". */
function filterRosterForSport(
  members: MemberInput[],
  sportKey: string,
  moduleVersion: string,
): { members: MemberInput[]; dropped: number } {
  const mod = resolveModule(sportKey, moduleVersion);
  const positions = new Set((mod.positions?.groups ?? []).map((g) => g.key));
  const roles = new Set((mod.positions?.roles ?? []).map((r) => r.key));
  let dropped = 0;
  const cleaned = members.map((m) => {
    let position = m.default_position_key ?? null;
    if (position != null && !positions.has(position)) {
      position = null;
      dropped += 1;
    }
    const src = m.roles ?? [];
    const keptRoles = src.filter((r) => roles.has(r));
    dropped += src.length - keptRoles.length;
    return { ...m, default_position_key: position, roles: keptRoles };
  });
  return { members: cleaned, dropped };
}

/** Entrant-shape gate (spec 2026-07-18): resolve the division's EFFECTIVE
 *  entrant model — the pinned module's declaration merged with the division's
 *  `config.entrants` override. Sports with no model (generic legacy) fall back
 *  to "all kinds, no cap" so existing divisions accept exactly what they do
 *  today. Load ONCE per write call, not per row. */
async function loadEntrantShape(tx: Tx, divisionId: string): Promise<EffectiveEntrantModel> {
  const [d] = await tx<{ sport_key: string; module_version: string; config: unknown }[]>`
    select sport_key, module_version, config from divisions where id = ${divisionId}`;
  if (!d) throw new HttpError(404, "division not found");
  let model = null;
  try {
    model = resolveModule(d.sport_key, d.module_version).entrantModel ?? null;
  } catch {
    // Retired module build — no declaration to resolve; treat as legacy shape.
  }
  return effectiveEntrantModel(model, d.config);
}

/** Roster cap is structural (individual = 1, pair = 2, team = the model's
 *  maxMembers or unbounded). Throws 422 ENTRANT_ROSTER_TOO_BIG when exceeded. */
function assertRosterFits(eff: EffectiveEntrantModel, kind: string, memberCount: number): void {
  const cap = entrantKindCap(kind, eff);
  if (memberCount > cap) {
    throw new HttpError(
      422,
      `a ${kind} entrant holds at most ${cap} ${cap === 1 ? "person" : "people"}`,
      "ENTRANT_ROSTER_TOO_BIG",
    );
  }
}

/** Load an entrant's roster in the CreateEntrant member shape, for copying. */
async function loadRosterForCopy(tx: Tx, entrantId: string): Promise<MemberInput[]> {
  const rows = await tx<MemberInput[]>`
    select person_id, squad_number, default_position_key, is_captain, roles
    from entrant_members where entrant_id = ${entrantId}`;
  return rows;
}

export interface EntrantRow {
  id: string;
  division_id: string;
  kind: string;
  team_id: string | null;
  display_name: string;
  seed: number | null;
  status: string;
  created_at: string;
  /** PROMPT-60: crest/badge/flag — external URL or assets-bucket path. */
  badge_url: string | null;
}

export interface EntrantWithMembers extends EntrantRow {
  members: unknown[];
}

/** A created entrant, plus (response-only) how many roster keys were dropped
 *  because the target sport doesn't define them. Not a persisted column.
 *  RS011: `eligibility_warnings` — the MISSING_DOB/MISSING_GENDER warnings
 *  `gateRosterEligibility` returned for this roster, present only when
 *  non-empty (same "only present when it happened" convention as
 *  `roster_keys_dropped`). */
export interface CreatedEntrant extends EntrantRow {
  roster_keys_dropped?: number;
  eligibility_warnings?: EligibilityIssue[];
}

const COLS = [
  "id", "division_id", "kind", "team_id", "display_name", "seed", "status", "created_at",
  "badge_url",
] as const;

/** RS011: shared by every organiser roster-write path (`createEntrants`,
 *  `patchEntrant`, `syncEntrantRosterFromSquad`) — gating HERE, once, covers
 *  all three call sites (createEntrants/insertMembers/patchEntrant/
 *  syncEntrantRosterFromSquad are one physical gate call, not four separate
 *  ones) rather than duplicating the same `gateRosterEligibility` call at
 *  each. Returns the MISSING_DOB/MISSING_GENDER warnings so a caller can
 *  surface them even on a clean write. */
interface InsertMembersOptions {
  divisionId: string;
  override?: EligibilityOverride | null;
  actorId: string | null;
  context: string;
}

async function insertMembers(
  tx: Tx,
  entrantId: string,
  members: MemberInput[],
  opts: InsertMembersOptions,
): Promise<EligibilityIssue[]> {
  if (members.length === 0) return [];
  // Every referenced person must be visible under this tenant's RLS, and #404
  // adds: not a merge tombstone. The ids come from the client, so a stale picker
  // would otherwise roster a person who has already been absorbed.
  const ids = [...new Set(members.map((m) => m.person_id))];
  if (ids.length !== members.length) {
    throw new HttpError(422, "duplicate person(s) in roster", "ENTRANT_ROSTER_DUPLICATE_MEMBER");
  }
  const visible = await tx<{ id: string }[]>`
    select id from persons where id in ${tx(ids)} and merged_into is null`;
  if (visible.length !== ids.length) {
    const seen = new Set(visible.map((r) => r.id));
    const missing = ids.filter((id) => !seen.has(id));
    throw new HttpError(422, `unknown person(s): ${missing.join(", ")}`);
  }
  const warnings = await gateRosterEligibility(tx, {
    divisionId: opts.divisionId,
    personIds: ids,
    context: opts.context,
    override: opts.override,
    actorId: opts.actorId,
  });
  for (const m of members) {
    await tx`
      insert into entrant_members (entrant_id, person_id, squad_number,
                                   default_position_key, is_captain, roles)
      values (${entrantId}, ${m.person_id}, ${m.squad_number ?? null},
              ${m.default_position_key ?? null}, ${m.is_captain},
              ${tx.json(m.roles as never)})`;
  }
  return warnings;
}

async function withMembers(tx: Tx, entrant: EntrantRow): Promise<EntrantWithMembers> {
  // RS011: dob/gender ride along so the console (entrants-panel.tsx) can
  // render an amber MISSING_DOB/MISSING_GENDER chip per row against the
  // division's own requiresDob/requiresGender — never exposed publicly,
  // same organiser-only surface every other dob/gender read is.
  const members = await tx<Record<string, unknown>[]>`
    select em.person_id, p.full_name, p.dob::text as dob, p.gender,
           em.squad_number, em.default_position_key, em.is_captain, em.roles
    from entrant_members em join persons p on p.id = em.person_id
    where em.entrant_id = ${entrant.id}
    order by em.squad_number nulls last, p.full_name`;
  return { ...entrant, members };
}

export async function listEntrants(
  auth: AuthCtx,
  divisionId: string,
  filter: { clubId?: string; teamId?: string } = {},
): Promise<EntrantRow[]> {
  const { clubId, teamId } = filter;
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // ?club_id= facet (Jul3/01 §6): a read-side grouping over teams.club_id.
    // ?team_id= narrows to a single team (used by the enroll-existing flow).
    return tx<EntrantRow[]>`
      select ${tx(COLS)} from entrants
      where division_id = ${divisionId}
      ${clubId ? tx`and team_id in (select id from teams where club_id = ${clubId})` : tx``}
      ${teamId ? tx`and team_id = ${teamId}` : tx``}
      order by seed nulls last, created_at, id`;
  });
}

/** Register one entrant or a bulk batch (doc 08 §3 "+ bulk import").
 *  Enrolling an existing team (team_id set) snapshots the display name from the
 *  team, enforces one-entry-per-division (409), and can copy a prior roster. */
export async function createEntrants(
  auth: AuthCtx,
  divisionId: string,
  inputs: CreateEntrant[],
): Promise<CreatedEntrant[]> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  // The competition id, ahead of the transaction, ONLY to scope the plan lookup
  // below — an Event Pass lifts this cap for one competition, so dropping the
  // scope would change the answer. Authorisation is unaffected: the division is
  // read under RLS inside the transaction, which 404s for a foreign org.
  const [ref] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  const entrantCap = await getLimit(
    auth.orgId,
    "entrants.per_division.max",
    ref?.competition_id,
  );
  const { rows, competitionId } = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<
      { status: string; competition_id: string; sport_key: string; module_version: string }[]
    >`select status, competition_id, sport_key, module_version
      from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    assertNotFrozen(frozen, division.competition_id);

    // A started tournament's field is closed — fixtures were generated from
    // it, and a latecomer would never receive matches (or would corrupt a
    // bracket). Open-window formats are the exception: ladders and americano
    // sessions take late joiners by design (Jul3/08 §6). Withdrawals stay
    // available in every state.
    if (division.status === "active" || division.status === "completed") {
      const [openFormat] = await tx`
        select 1 from stages
        where division_id = ${divisionId} and kind in ('ladder', 'americano')
        limit 1`;
      if (!openFormat) {
        throw new HttpError(
          422,
          "This tournament has started — the entrant list is locked. Withdrawing entrants still works.",
        );
      }
    }

    // Doc 10 §1: `entrants.per_division.max` (V311: 32/64/256/∞) — the whole batch
    // must fit; count in the same tx as the inserts (doc 10 §2 rule 1).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${divisionId}`;
    assertWithinLimit(entrantCap, "entrants.per_division.max", n + inputs.length);

    // Entrant-shape gate (spec 2026-07-18): every input in the batch must match
    // the division's effective model BEFORE any insert — the whole batch fails
    // atomically (this runs inside withTenant's transaction).
    const eff = await loadEntrantShape(tx, divisionId);
    for (const input of inputs) {
      const kind = input.kind ?? eff.defaultKind;
      if (!eff.kinds.includes(kind as EntrantKind)) {
        throw new HttpError(
          422,
          `this division doesn't take '${kind}' entrants`,
          "ENTRANT_KIND_NOT_ALLOWED",
        );
      }
      assertRosterFits(eff, kind, input.members?.length ?? 0);
    }

    const rows: CreatedEntrant[] = [];
    for (const input of inputs) {
      // Snapshot the name from the team so a later rename never rewrites
      // historical standings (which read entrants.display_name / snapshots).
      let displayName = input.display_name ?? null;
      if (input.team_id) {
        const [team] = await tx<{ name: string }[]>`
          select name from teams where id = ${input.team_id}`;
        if (!team) throw new HttpError(404, "team not found");
        displayName = team.name;
      }
      if (displayName == null) throw new HttpError(422, "display_name is required");

      // Resolve the roster to store, in precedence order: members supplied on
      // the request → a copied prior entrant → the team's persistent squad.
      // Copied/seeded rosters are filtered to the target sport. Inline
      // new_person members become persons rows first (same tx, PROMPT-60 §2).
      let members = await resolveInlineMembers(tx, auth.orgId, input.members);
      let dropped = 0;
      if (input.copy_roster_from_entrant_id) {
        const [source] = await tx<{ team_id: string | null }[]>`
          select team_id from entrants where id = ${input.copy_roster_from_entrant_id}`;
        if (!source) throw new HttpError(404, "roster source entrant not found");
        if (!input.team_id || source.team_id !== input.team_id) {
          throw new HttpError(422, "roster source must be an entrant of the same team");
        }
        const raw = await loadRosterForCopy(tx, input.copy_roster_from_entrant_id);
        const filtered = filterRosterForSport(raw, division.sport_key, division.module_version);
        members = filtered.members;
        dropped = filtered.dropped;
      } else if (input.team_id && members.length === 0) {
        // No explicit roster and no copy source → seed from the team's squad.
        const squad = await loadTeamSquad(tx, input.team_id);
        if (squad.length > 0) {
          const filtered = filterRosterForSport(squad, division.sport_key, division.module_version);
          members = filtered.members;
          dropped = filtered.dropped;
        }
      }

      // Backstop: the FINAL resolved roster must fit the structural cap. The
      // early check only saw explicit `input.members`; a copied prior roster or
      // a squad-seeded team can carry a squad-sized roster onto an individual
      // (cap 1) or pair (cap 2). Reuse the already-loaded `eff` (loaded once for
      // the batch) — same 422 ENTRANT_ROSTER_TOO_BIG as the early check.
      assertRosterFits(eff, input.kind ?? eff.defaultKind, members.length);

      let row: EntrantRow;
      try {
        [row] = await tx<EntrantRow[]>`
          insert into entrants (division_id, kind, team_id, display_name, seed, badge_url)
          values (${divisionId}, ${input.kind}, ${input.team_id ?? null},
                  ${displayName}, ${input.seed ?? null}, ${input.badge_url ?? null})
          returning ${tx(COLS)}`;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, "this team is already entered in this division");
        }
        throw err;
      }
      // RS011: gates the FINAL resolved roster (explicit members / copied
      // roster / squad seed alike) against the division's eligibility rules
      // — one call, inside `insertMembers`, covers copy_roster and squad
      // seed the same as an explicit member list. `input.eligibility_override`
      // is per-entrant, matching `CreateEntrant`'s own per-entrant shape (a
      // bulk create batch can override some rows and not others).
      const warnings = await insertMembers(tx, row.id, members, {
        divisionId,
        override: input.eligibility_override,
        actorId: auth.userId,
        context: "roster_add",
      });
      rows.push({
        ...row,
        ...(dropped > 0 ? { roster_keys_dropped: dropped } : {}),
        ...(warnings.length > 0 ? { eligibility_warnings: warnings } : {}),
      });
    }
    return { rows, competitionId: division.competition_id };
  });
  // A new entrant sits in no fixture yet; its name joins the division's lists.
  refreshEntrantPublicPages(
    { divisionId, competitionId, fixtureIds: [] },
    { division: divisionId, created: rows.length },
  );
  return rows;
}

export interface DivisionRosterRow {
  person_id: string;
  entrant_id: string;
  entrant_name: string;
}

/** Every (person → team entrant) membership in a division. Powers the
 *  same-division double-roster warning: a person on two teams here is flagged
 *  (advisory, not blocked). */
export async function divisionRoster(
  auth: AuthCtx,
  divisionId: string,
): Promise<DivisionRosterRow[]> {
  return withTenant(auth.orgId, (tx) => tx<DivisionRosterRow[]>`
    select em.person_id, e.id as entrant_id, e.display_name as entrant_name
    from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId}
      and e.status in ('registered','confirmed')`);
}

export async function getEntrant(auth: AuthCtx, id: string): Promise<EntrantWithMembers> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
    if (!row) throw new HttpError(404, "entrant not found");
    return withMembers(tx, row);
  });
}

/** Hard delete — only while the division is still `setup` (mirrors the
 *  division-delete guard, divisions.ts:445): once scheduling has produced
 *  fixtures there is something to unwind, and `withdrawEntrantCascade`
 *  (withdrawal.ts) is the reversible tool for that. Cascades on
 *  entrant_members/lineups do the rest, and registrations/suspensions/
 *  officials set the FK null rather than block.
 *
 *  FIXTURES ARE THE EXCEPTION, and this comment used to say otherwise — it
 *  claimed "none of those rows can exist yet", which is false and was the
 *  defect (2026-09-22, reported live from production). A swiss stage mints its
 *  shells AND pairs its first round while the division is still `setup`, so
 *  `fixtures.home_entrant_id`'s `on delete set null` left the departing
 *  player's board half filled — one null slot beside neighbours still fully
 *  seated. That round then refused every control on the page: the reconcile
 *  refuses a partly seated round, and Unpair required a wholly seated one.
 *
 *  So the swiss rounds this entrant sits in are put back onto their shells
 *  FIRST, in this same transaction — see `unseatSwissRoundsSeatingEntrant` for
 *  the shape, the guards, and why the whole round moves rather than one board.
 *  Order matters twice over: the round is read while the entrant is still
 *  seated (a live bye is exempt from the played-result guard only while its
 *  seat is filled), and once the seats are cleared the FK below has nothing
 *  left to null. */
export async function deleteEntrant(auth: AuthCtx, id: string): Promise<void> {
  const refresh = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
    if (!row) throw new HttpError(404, "entrant not found");
    // This is now a FIXTURE write as well as a roster one, so it takes the
    // same division lock `generateStageFixturesWrite` and `unpairSwissRound`
    // take — stages.ts's stated convention is that a destructive swiss write
    // reads `existing` UNDER the lock. Taken before the status read so a
    // concurrent Start cannot slip between the guard and the write. Same key
    // and the same acquire-then-write order as the sibling paths, so there is
    // no lock-ordering inversion to deadlock on.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + row.division_id}))`;
    const [division] = await tx<{ status: string }[]>`
      select status from divisions where id = ${row.division_id}`;
    if (!division) throw new HttpError(404, "division not found");
    if (division.status !== "setup") {
      throw new HttpError(
        409,
        "This division has started — withdraw the entrant instead of deleting",
        "ENTRANT_DIVISION_STARTED",
        { withdraw: true },
      );
    }
    await unseatSwissRoundsSeatingEntrant(tx, id);
    // Read BEFORE the delete: `on delete set null` leaves nothing to find the
    // fixtures this entrant sat in by afterwards.
    const where = await entrantPublicScope(tx, row);
    // #850: a round-robin rest bye names only this entrant, so it goes with
    // them rather than surviving as a seatless award (see the helper). After
    // the scope read, so the removed row's public page is refreshed too.
    await deleteRestByesHeldBy(tx, id);
    await tx`delete from entrants where id = ${id}`;
    return where;
  });
  refreshEntrantPublicPages(refresh, { entrantId: id, deleted: true });
}

/** `entrants.status` values that mean "no longer in the field" — the
 *  complement of the house `status in ('registered','confirmed')` predicate.
 *
 *  Exported because this is the ONE place the departed vocabulary is spelled
 *  on the server side. Callers that need "who has left" must read it from
 *  here rather than restating the pair: three pages each spelling it out, and
 *  each getting half of it, is precisely the C1 defect that left a
 *  disqualified entrant unmarked in the public standings. The presentation
 *  half lives in `DEPARTED_STATUS_CHIPS` (standings-table.tsx) and is pinned
 *  to this set by `departed-vocabulary-is-single-sourced.test.ts`. */
export const DEPARTED_STATUSES = new Set(["withdrawn", "disqualified"]);

/** An ad-hoc entrant's name and roster, read BEFORE a write that changes who
 *  its people are or what they are called. */
export interface PendingRosterName {
  readonly id: string;
  readonly display_name: string;
  readonly prior: readonly RosterNamePerson[];
}

/** An entrant whose derived name a person write moved, from what to what. */
export interface FollowedRosterName {
  readonly id: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Step one of a person write that a derived entrant name must follow. The
 * two writes are:
 * - `patchPerson` renaming a player (owner ruling 2026-09-22, review item 10);
 * - `mergePersons` moving an absorbed record's roster seats onto the
 *   survivor (review item 13).
 *
 * This step reads every AD-HOC entrant this person is rostered on, with its
 * whole roster under the names it has now, before anything moves. A
 * team-linked entrant carries its team's name, never one derived from a
 * roster, so it is not read (`createEntrants`).
 *
 * It LOCKS what it reads, until the caller commits (review 2, R2-2). Two
 * renames of the two players of one pair used to read the pair at the same
 * moment. The second then derived from the first player's OLD name, its
 * guarded write found the name already moved, and the pair kept a name that
 * named nobody's current name, for good. Locked, the second waits here and
 * reads the pair, and its roster's names, only once the first has committed.
 *
 * The lock order is persons, then entrants in id order, the order
 * `mergePersons` takes them (its `persons ... for update` comes first). A
 * rename that took the entrants first could hold a pair while a merge of one
 * of its players held that player and wanted the pair. The person lock is
 * `for no key update`, what the `update persons` that follows would take
 * anyway, so it never blocks a roster insert's foreign-key check
 * (`for key share`) on this person.
 */
export async function entrantNamesFollowing(tx: Tx, personId: string): Promise<PendingRosterName[]> {
  await tx`select id from persons where id = ${personId} for no key update`;
  const entrants = await tx<{ id: string; display_name: string }[]>`
    select e.id, e.display_name
    from entrants e join entrant_members em on em.entrant_id = e.id
    where em.person_id = ${personId} and e.team_id is null
    order by e.id
    for update of e`;
  if (entrants.length === 0) return [];
  const members = await rosterNamesOf(tx, entrants.map((e) => e.id));
  return entrants.map((e) => ({
    id: e.id,
    display_name: e.display_name,
    prior: members.filter((m) => m.entrant_id === e.id),
  }));
}

/**
 * Step two, after the write, in the same transaction. For each entrant read in
 * step one, its roster is re-read and the name is followed with
 * `followRosterEdit`, the roster editor's own rule. So:
 * - a renamed player's token changes in its own seat;
 * - a merged-away record's token becomes the survivor's in the same seat;
 * - when both records were on one roster, the absorbed record's seat goes.
 *
 * A custom name is never touched. Each rename is guarded on the name step one
 * read, like `patchEntrant`'s. Step one's lock already stops anything moving
 * the name in between for the two callers here; the guard keeps the promise
 * for a caller whose read was not held, so an explicit rename that landed
 * after the read stands. Returns what moved, so a merge can record it for its
 * undo.
 *
 * Refreshing the public pages after the commit is the caller's job.
 * `firePersonRevalidate`, which both callers already fire, expires every
 * division the person is rostered in, and that covers every entrant renamed
 * here.
 */
export async function followRosterNames(
  tx: Tx,
  pending: readonly PendingRosterName[],
): Promise<FollowedRosterName[]> {
  if (pending.length === 0) return [];
  const members = await rosterNamesOf(tx, pending.map((e) => e.id));
  const moved: FollowedRosterName[] = [];
  for (const entrant of pending) {
    const next = members.filter((m) => m.entrant_id === entrant.id);
    const renamed = followRosterEdit(entrant.display_name, entrant.prior, next);
    if (renamed === null) continue;
    const [updated] = await tx<{ id: string }[]>`
      update entrants set display_name = ${renamed}
      where id = ${entrant.id} and display_name = ${entrant.display_name}
      returning id`;
    if (updated) moved.push({ id: entrant.id, before: entrant.display_name, after: renamed });
  }
  return moved;
}

async function rosterNamesOf(
  tx: Tx,
  entrantIds: readonly string[],
): Promise<(RosterNamePerson & { entrant_id: string })[]> {
  return tx<(RosterNamePerson & { entrant_id: string })[]>`
    select em.entrant_id, em.person_id, p.full_name
    from entrant_members em join persons p on p.id = em.person_id
    where em.entrant_id in ${tx(entrantIds as string[])}`;
}


/** Where an entrant write's public refresh must reach: its division, that
 *  division's competition, and every fixture the entrant plays (whose
 *  match-centre documents print its name). Read inside the write's own
 *  transaction, so a delete can read it before the rows go. */
interface EntrantPublicScope {
  divisionId: string;
  competitionId: string | null;
  fixtureIds: readonly string[];
}

async function entrantPublicScope(
  tx: Tx,
  row: Pick<EntrantRow, "id" | "division_id">,
): Promise<EntrantPublicScope> {
  const [division] = await tx<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${row.division_id}`;
  const fixtures = await tx<{ id: string }[]>`
    select id from fixtures where home_entrant_id = ${row.id} or away_entrant_id = ${row.id}`;
  return {
    divisionId: row.division_id,
    competitionId: division?.competition_id ?? null,
    fixtureIds: fixtures.map((f) => f.id),
  };
}

/**
 * After an entrant write COMMITS, bring its public pages up to date. Used by
 * every entrant write: create, patch, delete, and squad sync.
 *
 * Call it synchronously inside the request, never behind a `void`. Next
 * flushes a request's revalidations once, when the handler resolves, and
 * silently drops any that arrive later.
 *
 * It follows the NAME-change pattern that `patchDivision` uses for a
 * name-policy change, not `fireDivisionRevalidate`:
 * - `fireDivisionRevalidate` marks the division 'max' (stale-while-
 *   revalidate), so the organiser's first look at the public page after a
 *   rename would still show the OLD name.
 * - `fireScoreRevalidate` EXPIRES the division tag; the competition stays
 *   'max'.
 * - The public Redis documents that print the name are dropped: the hub, the
 *   division's schedule, standings and entrants, and the entrant's own
 *   match-centre documents.
 * - So is the player page's poll document, which prints the entrant as an
 *   opponent (`retireCompetitionPlayerMatches`).
 * Without these drops, a poll would bake the old name straight back in for
 * their 15–30s TTL.
 *
 * It never throws. The write has already committed, so an error here would
 * report a failure for a change that happened, and the organiser's retry
 * would write it again. A failure is logged; the pages catch up at their TTL.
 */
function refreshEntrantPublicPages(scope: EntrantPublicScope, context: Record<string, unknown>): void {
  if (!scope.competitionId) return;
  try {
    retireCompetitionPlayerMatches(scope.competitionId, context);
    const peersExpired = fireScoreRevalidate(scope.divisionId, scope.competitionId);
    dropNamedPublicDocuments(
      { competitionIds: [scope.competitionId], divisionIds: [scope.divisionId], fixtureIds: scope.fixtureIds },
      context,
      peersExpired,
    );
  } catch (err) {
    log.error({ err, ...context }, "entrants: public cache invalidation failed (the write stands)");
  }
}

export async function patchEntrant(
  auth: AuthCtx,
  id: string,
  patch: PatchEntrant,
): Promise<EntrantWithMembers> {
  const { out, fieldChanged, refresh } = await withTenant(auth.orgId, async (tx) => {
    // RS011: `eligibility_override` is request metadata for the gate below,
    // never an `entrants` column — destructured out alongside `members` so
    // it never reaches the `update entrants set ...` below.
    const { members, eligibility_override, ...fields } = patch;
    // Read the status BEFORE the update, so "did this patch move the entrant
    // in or out of the field?" is answerable below. A patch that re-asserts
    // the status it already had must NOT count as a field change — it would
    // stale and recompute a seed proposal for nothing.
    const [prior] = await tx<{ status: string; division_id: string }[]>`
      select status, division_id from entrants where id = ${id}`;
    // LOCK ORDER (#850 review round 3): a patch that writes `status` can move
    // the entrant across the field boundary, and that crossing reconciles the
    // division's rest byes under the division lock (below). Take the lock
    // BEFORE this entrant row's update — the order `deleteEntrant` and
    // `withdrawCore` (registrations.ts) take them in. Taken after it, a
    // withdrawal and a delete of the same entrant each held what the other
    // waited for: a deadlock (40P01). `entrant-lock-order.test.ts`.
    const statusWrite = prior !== undefined && fields.status !== undefined;
    if (statusWrite) {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + prior.division_id}))`;
      // Re-read under the lock (#850 review round 4): a concurrent withdraw or
      // reinstate of this entrant may have committed while we waited, and the
      // crossing test below must judge against the status it left, or a
      // reinstate racing a withdrawal sees "registered → registered" and never
      // gives the rest bye back. `entrant-lock-order.test.ts`.
      const [locked] = await tx<{ status: string }[]>`
        select status from entrants where id = ${id}`;
      if (locked) prior.status = locked.status;
    }
    let row: EntrantRow | undefined;
    if (Object.keys(fields).length > 0) {
      const cols = Object.keys(fields);
      [row] = await tx<EntrantRow[]>`
        update entrants set ${tx(fields as never, ...(cols as never[]))}
        where id = ${id} returning ${tx(COLS)}`;
    } else {
      [row] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
    }
    if (!row) throw new HttpError(404, "entrant not found");
    // Crossing the field boundary in EITHER direction: a withdrawal removes a
    // qualifier a draft proposal may already name, and an un-withdrawal makes
    // one offerable again. Both are field changes; a move between two departed
    // statuses, or between two active ones, is not. Only THIS patch's own
    // status write counts — which is also what guarantees the division lock
    // above is held whenever the reconcile below runs.
    const fieldChanged =
      statusWrite && DEPARTED_STATUSES.has(prior.status) !== DEPARTED_STATUSES.has(row.status);
    // #850 review, finding 8: an entrant leaving the field (a withdrawal — the
    // cascade's last step lands here — or a disqualification) no longer sits
    // out anything, so the rest-bye rows they hold in rounds not yet under way
    // go; rows of a round already under way stay, the sit-out happened. And
    // back into the field (an un-withdrawal) brings them back. The ONE
    // reconciler decides both (`reconcileRestByes`, stages.ts), under the
    // division lock every other fixture writer takes — taken above.
    const byeRows: string[] = [];
    if (fieldChanged) {
      const byes = await reconcileDivisionRestByes(tx, row.division_id);
      byeRows.push(...byes.inserted, ...byes.deleted);
    }
    if (members) {
      // Full roster replacement — recheck the count against THIS entrant's kind
      // (kind itself isn't patchable, so only the roster is being written).
      const eff = await loadEntrantShape(tx, row.division_id);
      assertRosterFits(eff, row.kind, members.length);
      // The name follows the roster (2026-09-22, reported from production:
      // "Sankar & Ritwik" kept that name after Ritwik was swapped out) — but
      // only an AD-HOC entrant's, and only when this patch does not name it
      // itself. A team-linked entrant's name is the team's snapshot, which
      // must never be rewritten from a roster (createEntrants above). The
      // people the name was derived from are read HERE, before the delete
      // below takes them away.
      const followName = fields.display_name === undefined && row.team_id === null;
      const priorPeople = followName
        ? await tx<RosterNamePerson[]>`
            select em.person_id, p.full_name
            from entrant_members em join persons p on p.id = em.person_id
            where em.entrant_id = ${id}`
        : [];
      await tx`delete from entrant_members where entrant_id = ${id}`;
      await insertMembers(tx, id, members, {
        divisionId: row.division_id,
        override: eligibility_override,
        actorId: auth.userId,
        context: "patch_entrant",
      });
      if (followName) {
        // `insertMembers` has already proved every id visible and distinct. An
        // emptied roster reads no one, and `followRosterEdit` then keeps the
        // name rather than empty it.
        const people = await tx<RosterNamePerson[]>`
          select id as person_id, full_name from persons
          where id in ${tx(members.map((m) => m.person_id))}`;
        const byId = new Map(people.map((p) => [p.person_id, p]));
        // SUBMITTED order — newcomers take vacated seats in the order given.
        const next = members.flatMap((m) => byId.get(m.person_id) ?? []);
        const renamed = followRosterEdit(row.display_name, priorPeople, next);
        if (renamed !== null) {
          // Only over the name this patch READ. `row` was read without a lock,
          // so an explicit rename (the console's Name field, sent alongside a
          // roster save) can commit in between; under READ COMMITTED this
          // update then re-checks the row it waited on and matches nothing,
          // and the organiser's own name stands.
          const [updated] = await tx<EntrantRow[]>`
            update entrants set display_name = ${renamed}
            where id = ${id} and display_name = ${row.display_name}
            returning ${tx(COLS)}`;
          if (updated) {
            row = updated;
          } else {
            const [current] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
            if (current) row = current;
          }
        }
      }
    }
    const scope = await entrantPublicScope(tx, row);
    return {
      out: await withMembers(tx, row),
      fieldChanged,
      // A deleted bye row no longer seats this entrant, so the scope read
      // cannot find it; its match-centre document goes all the same.
      refresh: { ...scope, fixtureIds: [...new Set([...scope.fixtureIds, ...byeRows])] },
    };
  });
  // Before this, an entrant patch refreshed nothing, so a rename (or a roster,
  // seed, status or badge edit) reached the public pages only when their 30s
  // cache ran out.
  refreshEntrantPublicPages(refresh, { entrantId: id });
  // AFTER the transaction commits: the recompute opens its own transaction
  // and takes the division advisory lock, which would deadlock against the
  // one above. Best-effort — a proposal that cannot be recomputed is left
  // stale, which is still what puts Recompute in front of the organiser.
  if (fieldChanged) {
    // In its OWN try/catch (review finding, 2026-09-21): the entrant patch has
    // already COMMITTED by the time we get here, and `confirmSeedProposal`
    // refuses a departed qualifier regardless, so a failure in this refresh
    // must not turn a withdrawal that succeeded into a 500 for the caller.
    // The cost of swallowing it is an un-staled draft — the behaviour before
    // this hook existed, not a new hazard.
    try {
      await markFieldChangeSeedProposalsStale(auth.orgId, refresh.divisionId);
    } catch {
      // see above
    }
  }
  return out;
}

/** Replace an entrant's roster with its team's CURRENT squad. Enrollment
 *  snapshots the squad once (createEntrants) and never syncs after — deliberate,
 *  since discipline/lineups hang off entrant_members. This is the explicit
 *  organiser action for "the squad changed since we enrolled". Same sport
 *  filter and kind-cap rules as the enrollment seed. */
export async function syncEntrantRosterFromSquad(
  auth: AuthCtx,
  id: string,
  override?: EligibilityOverride | null,
): Promise<CreatedEntrant & { members: unknown[] }> {
  const { out, refresh } = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
    if (!row) throw new HttpError(404, "entrant not found");
    if (!row.team_id) {
      throw new HttpError(422, "This entrant has no linked team — there is no squad to sync from.");
    }
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${row.division_id}`;
    if (!division) throw new HttpError(404, "division not found");
    const squad = await loadTeamSquad(tx, row.team_id);
    const { members, dropped } = filterRosterForSport(
      squad,
      division.sport_key,
      division.module_version,
    );
    const eff = await loadEntrantShape(tx, row.division_id);
    assertRosterFits(eff, row.kind, members.length);
    await tx`delete from entrant_members where entrant_id = ${id}`;
    const warnings = await insertMembers(tx, id, members, {
      divisionId: row.division_id,
      override,
      actorId: auth.userId,
      context: "roster_sync",
    });
    const synced = await withMembers(tx, row);
    return {
      out: {
        ...synced,
        ...(dropped > 0 ? { roster_keys_dropped: dropped } : {}),
        ...(warnings.length > 0 ? { eligibility_warnings: warnings } : {}),
      },
      refresh: await entrantPublicScope(tx, row),
    };
  });
  refreshEntrantPublicPages(refresh, { entrantId: id, synced: true });
  return out;
}

// ---------------------------------------------------------------------------
// Entrant badge upload (PROMPT-60): multipart bytes → assets bucket →
// entrants.badge_url stores the storage path (content-hash name, mirroring
// setPersonPhoto). null clears the badge. External URLs skip this entirely —
// the PATCH route accepts badge_url directly.
// ---------------------------------------------------------------------------

const BADGE_BUCKET = "assets";
const BADGE_MIME = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
]);

export async function setEntrantBadge(
  auth: AuthCtx,
  id: string,
  file: { contentType: string; bytes: Buffer } | null,
): Promise<EntrantRow> {
  if (file === null) {
    return withTenant(auth.orgId, async (tx) => {
      const [row] = await tx<EntrantRow[]>`
        update entrants set badge_url = null where id = ${id} returning ${tx(COLS)}`;
      if (!row) throw new HttpError(404, "entrant not found");
      return row;
    });
  }
  const ext = BADGE_MIME.get(file.contentType);
  if (!ext) throw new HttpError(415, `unsupported image type '${file.contentType}'`);
  return withTenant(auth.orgId, async (tx) => {
    const [entrant] = await tx<{ id: string }[]>`select id from entrants where id = ${id}`;
    if (!entrant) throw new HttpError(404, "entrant not found");
    const hash = createHash("sha256").update(file.bytes).digest("hex").slice(0, 32);
    const path = `orgs/${auth.orgId}/entrant-badges/${hash}.${ext}`;
    const { error } = await supabaseAdmin()
      .storage.from(BADGE_BUCKET)
      .upload(path, file.bytes, { contentType: file.contentType, upsert: true });
    if (error) throw new HttpError(502, `badge upload failed: ${error.message}`);
    const [row] = await tx<EntrantRow[]>`
      update entrants set badge_url = ${path} where id = ${id} returning ${tx(COLS)}`;
    return row!;
  });
}
