import "server-only";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import { fixtureHasResultSql } from "../fixture-results-sql";
import { isSwissByeShellExtKey } from "@/lib/swiss-shell";
import { isByeLine } from "@/lib/bye-line";
import { swissRefusal } from "../swiss-refusal";
import { knockoutRefusal } from "../knockout-refusal";
import { requireFeature } from "@/lib/entitlements";
import {
  roundOrderConflicts,
  validateAssignments,
  type Assignment,
} from "@seazn/engine/scheduling";
import { appendDivisionEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import { officialAssignmentChangedEmail } from "@/lib/email";
import { deferred } from "@/lib/deferred";
import { msgFor } from "@/lib/messages-i18n";
import { dispatchNow, enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { resolveSlotLabel } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { assertNotFrozen, frozenCompetitionIds } from "../entitlement-freeze";
import type { FixtureLite } from "./types";
import { MS_PER_MIN, ms, iso } from "./helpers";
import { afterScheduleWrite } from "./after-write";
import {
  MOVABLE_STATUS,
  PLAYED_MOVE_MESSAGE,
  divisionLockState,
  divisionFixtures,
  courtNamesById,
  venueNamesById,
  courtVenueIds,
  peopleByEntrant,
  peopleOf,
  assertFreshSeq,
} from "./board";
import { loadSettings } from "./settings";
import {
  roundRobinStageIds,
  roundFieldsOf,
  roundRobinSequenceKey,
  roundRobinSequenceSiblings,
} from "./rounds";
import {
  toAssignment,
  feedDependencies,
  siblingAssignments,
  verifyConfigForDivision,
} from "./engine-inputs";
import { mapConflicts, assertNoNewBlocking } from "./conflicts";

// ---------------------------------------------------------------------------
// Single move (fixture PATCH, doc 12 §4) — used by the drag-and-drop board
// ---------------------------------------------------------------------------

export interface MoveInput {
  scheduled_at?: string | null;
  // P9 pass 3a: court_id/venue_id — see PatchFixture (schemas.ts). Mirrors
  // that schema's post-`.strict()`/`.partial()` shape structurally:
  // fixtures.ts's `patchFixture` destructures `{ officials, ...move }` off
  // an already-parsed `PatchFixture` and hands `move` straight to
  // `moveFixture` — no field-by-field mapping, so this interface has to
  // stay structurally assignable from `Omit<PatchFixture, "officials">` or
  // that call breaks.
  court_id?: string | null;
  venue_id?: string | null;
  schedule_locked?: boolean;
  expected_seq?: number;
}

/**
 * Schedule-aware single-fixture move: blocks on conflict.court / direct
 * warn.order (409 with the conflicts), otherwise persists and appends
 * `schedule_edited {fixture, from, to}` (doc 12 §2).
 *
 * RETURNS the conflict report it judged the destination by (#461). It always
 * computed one — the blocking gate needs it — and used to drop it, so the
 * WARN-level half was invisible to every caller: a drag that put a card into a
 * rest shortfall, past a stored typed rule or outside the competition's days
 * wrote silently and said nothing. The blocking half still throws, so anything
 * returned here is by construction non-blocking (or pre-existing, which the
 * delta gate deliberately allows). `[]` when the patch touched no timetable
 * field, so absence and emptiness are the same answer rather than two.
 *
 * These are THIS MOVE's conflicts, not the board's: `validateAssignments` is run
 * over the single proposed card. The whole-board report is `validateSchedule`,
 * and the console board refreshes from it after every drop.
 */
export async function moveFixture(
  auth: AuthCtx,
  fixtureId: string,
  patch: MoveInput,
): Promise<ScheduleConflict[]> {
  if (patch.schedule_locked !== undefined) {
    await requireFeature(auth.orgId, "scheduling.board");
  }
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const out = await withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      (FixtureLite & { competition_id: string })[]
    >`
      select f.id, f.stage_id, f.division_id, f.round_no, f.ext_key, f.home_entrant_id,
             f.away_entrant_id, f.outcome, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id, f.venue_id,
             f.court_label, f.venue, f.pool_id,
             f.status, f.schedule_locked, f.winner_to_fixture, f.loser_to_fixture,
             d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + fixture.division_id}))`;
    await assertFreshSeq(tx, fixture.division_id, patch.expected_seq);
    assertNotFrozen(frozen, fixture.competition_id);

    // Single-fixture moves are board edits too — the whole-division freeze
    // must hold here exactly as it does for applySchedule (this is the route
    // the board's drag/keyboard move actually uses). Scope locks deliberately
    // do NOT bite on single moves (see history.test.ts — the board apply path
    // enforces them; a targeted move is the escape hatch).
    const lockState = await divisionLockState(tx, fixture.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }

    const movesTimetable = patch.scheduled_at !== undefined || patch.court_id !== undefined;
    // W3 T3 (SW-M13, X-SW-29): a Swiss bye is not played, so it takes no court, no time and no pin — seated or not, and
    // named, ahead of the status gate below (a seated bye is `forfeited`, which would refuse it with the generic
    // sentence). Taking a legacy slot OFF one (a bye placed before V485) is not placing it, and stays open.
    const places = (patch.scheduled_at !== undefined && patch.scheduled_at !== null)
      || (patch.court_id !== undefined && patch.court_id !== null)
      || (patch.venue_id !== undefined && patch.venue_id !== null)
      || patch.schedule_locked === true;
    if (places && isSwissByeShellExtKey(fixture.ext_key)) throw swissRefusal("SWISS_BYE_NOT_PLACEABLE");
    // W4 T3 (K2, X-SD-5): every other bye line — a bracket's, before or after its award — likewise, by its own name.
    if (places && isByeLine(fixture)) throw knockoutRefusal("BYE_LINE_NOT_PLACEABLE");
    if (movesTimetable && fixture.status !== MOVABLE_STATUS) {
      throw new HttpError(422, `fixture is ${fixture.status} — decided fixtures are immutable`);
    }
    // A fixture holding a result stays where it is, pin included: history
    // refuses any step that touches one (`fixtureHasResultSql`), so an edit
    // written here would leave an Undo that nothing can get past. The status
    // gate above cannot see it: a start taken back leaves `scheduled` behind.
    // A pin is REFUSED rather than written without its ledger step: a played
    // row is never moved by the solver, so its pin changes nothing, and a
    // board edit that Undo cannot see would be a second kind of edit.
    if (movesTimetable || patch.schedule_locked !== undefined) {
      const [held] = await tx<{ id: string }[]>`
        select f.id from fixtures f where f.id = ${fixture.id} and ${fixtureHasResultSql(tx)}`;
      if (held) throw new HttpError(422, PLAYED_MOVE_MESSAGE, PLAYED_REFUSAL_CODE);
    }

    const settings = await loadSettings(tx, fixture.division_id);
    // P9 pass 3a: resolved once, used for the conflict mapping below AND
    // (court/venue both) for the officials change notice queued further
    // down in this transaction.
    const courtNames = await courtNamesById(tx);
    const venueNames = await venueNamesById(tx);
    // #5 fix — resolved once, used to DERIVE venue_id from the target
    // court_id below.
    const courtVenues = await courtVenueIds(tx);
    const nextAt = patch.scheduled_at !== undefined ? patch.scheduled_at : (fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null);
    const nextCourtId = patch.court_id !== undefined ? patch.court_id : fixture.court_id;

    let conflicts: ScheduleConflict[] = [];
    if (movesTimetable && nextAt !== null && nextCourtId !== null) {
      const all = await divisionFixtures(tx, fixture.division_id);
      const entrantIds = [
        ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
      ].filter((e): e is string => e !== null);
      const people = await peopleByEntrant(tx, entrantIds);
      // C1 (2026-08-12 round-order design). Same reason `applySchedule` reads
      // it: round order has to be judged HERE, on the write gate — see
      // `toAssignment`'s own doc comment.
      const roundRobin = await roundRobinStageIds(tx, fixture.division_id, settings);
      const start = ms(nextAt);
      const proposed: Assignment = {
        fixtureId: fixture.id,
        court: nextCourtId,
        startAt: start,
        endAt: start + settings.config.matchMinutes * MS_PER_MIN,
        entrants: [fixture.home_entrant_id, fixture.away_entrant_id].filter(
          (e): e is string => e !== null,
        ),
        people: peopleOf(fixture, people),
        // #446 — this is the drag/keyboard move the issue describes: without
        // these two the dragged card resolves its rest to `perEntrantMinRest`
        // and its start bound to (-inf, +inf), so a pool rule the auto pass
        // honoured is silently absent at exactly the moment a human overrides it.
        ...(fixture.pool_id !== null ? { poolId: fixture.pool_id } : {}),
        divisionId: fixture.division_id,
        // C1 fix-loop (G2/3rd instance). Same shape as `applySchedule`'s own
        // `proposed` — `stageId` unconditional (`fixtures.stage_id` is NOT
        // NULL), `roundNo` gated on stage kind, `movable: true`
        // unconditionally because this call is actively choosing this
        // position, whatever lock state it ends up carrying. Without these
        // three, `proposed` could never enter `calendar.ts`'s round-order
        // `bySequence` grouping at all — a fixture with no `roundNo` is
        // skipped outright — so widening the sibling set below would still
        // catch nothing.
        stageId: fixture.stage_id,
        ...roundFieldsOf(roundRobin, fixture),
        movable: true,
      };
      // C1 fix-loop (G2/3rd instance, re-scoped by the round-order-widening
      // fix-loop below). This fixture's own round-robin sequence siblings —
      // same (division, stage, pool), already placed. They exist ONLY so
      // `roundOrderConflicts` (the round-order-only pass below) can pair this
      // move against an untouched sibling — its scan is scoped to the set
      // it's handed, and the checked side here is always exactly one
      // fixture: `[proposed]` or `currentSlot`. A one-element array can never
      // contain a same-sequence PAIR, so no amount of correct `roundNo`/
      // `stageId` wiring on `proposed` ALONE would ever flag a violation
      // against an untouched sibling — the sibling has to be pulled into
      // round order's OWN checked set. See `roundRobinSequenceSiblings`'s own
      // comment for the full mechanism and why symmetry (both sides of the
      // delta, not just the proposed one) is what keeps a pre-existing
      // violation among siblings from reading as a false "new" block on a
      // move that never touched them.
      //
      // They deliberately do NOT move into `assignments`/out of `others` for
      // the CORE gate below — that was the original, too-blunt fix: pulling a
      // sibling out of `existing` made it FOCAL for every rule family, not
      // just round order, silently changing what rest/court/person judged a
      // pre-existing board against. Those families see the siblings exactly
      // as they always did — fixed CONTEXT via `board`/`existing` below.
      const roundRobinSiblings = roundRobinSequenceSiblings(
        all,
        roundRobin.has(fixture.stage_id) ? new Set([roundRobinSequenceKey(fixture)]) : new Set(),
        new Set([fixture.id]),
      );
      const siblingIds = new Set(roundRobinSiblings.map((f) => f.id));
      // ORIGINAL composition — `siblingIds` stays IN here, matching every
      // rule family's pre-round-order behaviour (and origin/main's, byte for
      // byte).
      const others = all
        .filter((f) => f.id !== fixture.id && f.scheduled_at !== null && f.court_id !== null)
        .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
      // Round-order-only checked set: this fixture's siblings, added to BOTH
      // delta sides below so a pre-existing round-order violation among them
      // reads as pre-existing rather than newly introduced by a move that
      // never touched them.
      const widenedSiblings = roundRobinSiblings.map((f) =>
        toAssignment(f, settings.config.matchMinutes, people, roundRobin),
      );
      const siblings = await siblingAssignments(
        tx,
        fixture.division_id,
        fixture.competition_id,
        settings.config.matchMinutes,
      );
      // #447: the dragged card is judged against the durable typed rules too.
        // Same as the apply gate: a card DRAGGED onto a court that is closed at
      // that time is flagged at the drag, not silently accepted and then
      // reported by the next /validate.
      // P10 (§3): routed through the ONE builder so a card dragged onto a
      // since-archived court is flagged the same way one dragged onto a
      // closed court already is — hand-assembly at five sites is how
      // person-merge.ts ended up with neither signal.
      // Review fix (finding 1): `all` alone only ever names courts a STORED
      // fixture already occupies — never `nextCourtId`, the drag TARGET
      // itself. So dragging a card onto an archived court no other fixture
      // currently sits on produced NO stranded_fixture conflict, despite the
      // comment above claiming this move is judged against the durable
      // typed rules "too". Unioning `nextCourtId` in is what actually makes
      // that true.
      const assignedCourtIds = [
        ...new Set(
          [...all.map((f) => f.court_id), nextCourtId].filter((c): c is string => c !== null),
        ),
      ];
      const slotConfig = await verifyConfigForDivision(
        tx,
        settings,
        all,
        0,
        siblings.ruleFixtures,
        fixture.division_id,
        assignedCourtIds,
      );
      const deps = feedDependencies(all);
      const board = [...others, ...siblings.assignments];
      // Where this card sits right now (#399). An unscheduled fixture has no
      // baseline, so every blocking conflict its first placement causes is
      // introduced — which is exactly what it is.
      const currentSlot =
        fixture.scheduled_at !== null && fixture.court_id !== null
          ? [toAssignment(fixture, settings.config.matchMinutes, people, roundRobin)]
          : [];
      // CORE families: `includeRoundOrder=false` — this call is
      // byte-identical in shape to the pre-round-order gate, so its verdict
      // is too. Round order is judged SEPARATELY, over the widened set —
      // merging only its `"order"` conflicts back in keeps every other
      // family blind to the siblings, exactly as it always was.
      const baseline = [
        ...validateAssignments(currentSlot, slotConfig, board, deps, false),
        ...roundOrderConflicts(currentSlot.concat(widenedSiblings), slotConfig.tz),
      ];
      const found = [
        ...validateAssignments([proposed], slotConfig, board, deps, false),
        ...roundOrderConflicts([proposed, ...widenedSiblings], slotConfig.tz),
      ];
      assertNoNewBlocking(baseline, found, courtNames);
      // Scoped to the fixture THIS move actually names (#461's contract) —
      // the widened siblings above exist so the round-order GATE can see
      // them, not so their own (possibly pre-existing and entirely
      // unrelated) conflicts leak into a response about a card the caller
      // never touched.
      conflicts = mapConflicts(found.filter((c) => !siblingIds.has(c.fixtureId)), courtNames);
    }

    // #5 fix (P9 review): venue_id is DERIVED from the court, server side —
    // never trusted from client input, which must never be able to disagree
    // with the court's own venue (courts.venue_id, composite-FK-guaranteed
    // to agree with org). `patch.venue_id` is intentionally never read
    // below; keeping it in MoveInput/PatchFixture's own type is harmless — a
    // caller sending it just has it silently ignored. Untouched (`fixture.
    // venue_id`) when court_id itself is untouched; derived from the target
    // court when set; cleared to null alongside a cleared court_id — there
    // is nothing left to derive a venue from once there is no court.
    const nextVenueId =
      patch.court_id !== undefined
        ? patch.court_id !== null
          ? (courtVenues.get(patch.court_id) ?? null)
          : null
        : fixture.venue_id;
    const values: Record<string, unknown> = {};
    if (patch.scheduled_at !== undefined) values.scheduled_at = patch.scheduled_at;
    if (patch.court_id !== undefined) {
      values.court_id = patch.court_id;
      values.venue_id = nextVenueId;
    }
    if (patch.schedule_locked !== undefined) values.schedule_locked = patch.schedule_locked;
    if (movesTimetable) values.schedule_source = "manual";
    if (Object.keys(values).length > 0) {
      await tx`
        update fixtures set ${tx(values as never, ...(Object.keys(values) as never[]))}
        where id = ${fixture.id}`;
    }

    // v11: officials who agreed to a slot must hear when it moves. Only real
    // timetable/venue changes notify, only non-declined assignments, only
    // officials with an email. Queued on the email outbox in THIS transaction
    // (phase 3 wave 4, kind `official_assignment_changed`), one row per
    // assignment role; the request makes the first attempt after commit.
    //
    // #5 fix: the OLD second disjunct (`patch.venue_id !== undefined &&
    // patch.venue_id !== fixture.venue_id`) is now dead code, deliberately
    // removed rather than left misleading — venue_id can no longer change
    // independently of court_id (see nextVenueId's own comment above), and
    // any court_id change is already covered by the `fixture.court_id !==
    // nextCourtId` clause below.
    const timetableChanged =
      movesTimetable &&
      ((fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null) !== nextAt ||
        fixture.court_id !== nextCourtId);
    const emailIds: string[] = [];
    if (timetableChanged) {
      const notices = await tx<{
        official_id: string; email: string; display_name: string; role_key: string; user_id: string | null;
        org_name: string; default_locale: string | null;
        home_name: string | null; away_name: string | null; venue_tz: string | null;
        home_slot_label: SlotLabel | null; away_slot_label: SlotLabel | null;
      }[]>`
        select o.id as official_id, o.email, o.display_name, fo.role_key, p.user_id,
               org.name as org_name, org.default_locale,
               h.display_name as home_name, a.display_name as away_name,
               f.home_slot_label, f.away_slot_label,
               -- venue lane (V305): division override → org timezone → UTC
               coalesce(ss.tz, org.timezone, 'UTC') as venue_tz
        from fixture_officials fo
        join fixtures f on f.id = fo.fixture_id
        join officials o on o.id = fo.official_id
        left join persons p on p.id = o.person_id
        join organizations org on org.id = o.org_id
        left join entrants h on h.id = ${fixture.home_entrant_id}
        left join entrants a on a.id = ${fixture.away_entrant_id}
        left join schedule_settings ss on ss.division_id = ${fixture.division_id}
        where fo.fixture_id = ${fixture.id}
          and fo.response <> 'declined' and o.email is not null`;
      // P9 pass 3a: the email renders human text, so it carries RESOLVED
      // court/venue NAMES, not ids, unlike the ledger event below.
      const prevAt = fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null;
      const court = nextCourtId !== null ? (courtNames.get(nextCourtId) ?? null) : null;
      const venue = nextVenueId !== null ? (venueNames.get(nextVenueId) ?? null) : null;
      for (const n of notices) {
        // F5 (D4): the official's language — a claimed official's account,
        // then the org's default, then en — for the label and the email alike.
        const locale = await recipientLocale(tx, { pick: null, userId: n.user_id, orgDefault: n.default_locale });
        const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
          msgFor(locale, k, v);
        emailIds.push(
          await enqueueEmail(tx, {
            kind: "official_assignment_changed",
            // Per role (P-W4-2): an official holding two roles on the fixture gets one notice for each, and neither ends the
            // other; a later move of this fixture supersedes a notice still waiting for the same role (the replace rule).
            refType: "fixture_official",
            refId: `${fixture.id}:${n.official_id}:${n.role_key}`,
            orgId: auth.orgId,
            to: n.email,
            ...(await officialAssignmentChangedEmail(
              {
                orgName: n.org_name,
                officialName: n.display_name,
                roleKey: n.role_key,
                // Design review M-7: the join word is the dictionary's (fr "contre"), as officials.ts's assignment notice says it.
                label: `${n.home_name ?? resolveSlotLabel(n.home_slot_label, lookup, "schedule.tbd")} ${lookup("schedule.vs")} ${n.away_name ?? resolveSlotLabel(n.away_slot_label, lookup, "schedule.tbd")}`,
                prevAt,
                nextAt,
                venueTz: n.venue_tz,
                court,
                venue,
              },
              locale,
            )),
            transactional: true,
            // Worthless once the match has started at its new time; `null` (unscheduled) falls to the bound.
            expiresAt: expiryWithin(nextAt === null ? null : new Date(nextAt)),
          }),
        );
      }
    }

    if (movesTimetable || patch.schedule_locked !== undefined) {
      // P9 pass 3a: `court` in this ledger payload is a `courts.id`
      // (previously a free-text `court_label`) — `execute()` in history.ts
      // replays this event straight back into `fixtures.court_id` on
      // undo/redo, so it has to be the id, not a display name, or restore
      // would write a label into an id column.
      const seq = await appendDivisionEvent(tx, fixture.division_id, "schedule_edited", {
        fixture: fixture.id,
        // `venue` rides along (review 3 of #857, m5): see `applySchedule`'s
        // identical note. Undo of a venue-only fixture dragged onto a court
        // has no court left to derive the venue from.
        from: {
          at: fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null,
          court: fixture.court_id,
          venue: fixture.venue_id,
          locked: fixture.schedule_locked,
        },
        to: {
          at: nextAt,
          court: nextCourtId,
          venue: nextVenueId,
          locked: patch.schedule_locked ?? fixture.schedule_locked,
        },
      });
      await tx`update divisions set seq = ${seq} where id = ${fixture.division_id}`;
    }

    return {
      divisionId: fixture.division_id,
      competitionId: fixture.competition_id,
      // R10d n2: the one fixture this move wrote.
      fixtureId: fixture.id,
      conflicts,
      emailIds,
    };
  });
  // The request makes the first attempt, after commit (R5); a failed attempt is the outbox's retry, never the move's.
  if (out.emailIds.length > 0) deferred(() => dispatchNow(out.emailIds));
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule", [out.fixtureId]);
  return out.conflicts;
}
