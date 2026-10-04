// A fake of the SEVEN endpoints B04's scheduling layer walks (design §3.2),
// shared by every fake server in this directory.
//
// NOT a `.test.ts`, so vitest never collects it — the same convention
// `_board-fixtures.ts` beside it already uses.
//
// Why shared rather than four copies: `runScheduleLayer` now touches
// `schedule-settings`, `PATCH /fixtures/{id}`, `GET /divisions/{id}/fixtures`,
// `schedule/auto`, `schedule/apply`, `schedule/validate` and
// `GET /orgs/{id}/venues` on every division of every run, and four independent
// hand-rolled versions of that would disagree about exactly the things the
// checker measures — which court a fixture landed on, whether a lock survived,
// whether the settings PUT came back intact. One implementation, four callers.
//
// This fake models three product behaviours ON PURPOSE, because a fake that
// accepts what the product refuses is how this wave has already shipped four
// defects offline:
//
//  * `schedule-settings` RETURNS the persisted config (`putScheduleSettings`
//    returns the usecase's own row and the route forwards it unmapped), which
//    is what makes `crossCheckSettings`' round-trip check possible at all. The
//    `dropSettingsKey` knob drives the other half — `ScheduleConfig` is a
//    plain `z.object`, so an unknown key is STRIPPED and the 200 means nothing.
//  * A `schedule_locked` fixture keeps its slot through `auto`
//    (#pins-in-build: "a lock is honoured on every mode now,
//    unconditionally"), so a pin that moves here is the bench's own bug.
//  * `/validate` returns conflicts, and by default returns NONE — which is the
//    point of design §1.2: a board layer 1 calls clean is not a clean board,
//    and the checker is what says so.

/** One `S.Fixture` row as `GET /api/v1/divisions/{id}/fixtures` returns it. */
export interface FakeFixtureRow {
  id: string;
  division_id: string;
  stage_id: string;
  ext_key: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  court_id: string | null;
  officials: unknown[];
  schedule_locked: boolean;
  /** B06b — a bracket BYE is born `forfeited` (`stages.ts:1351`) and is never
   *  scheduled. Absent means `scheduled`, which is the strict side, so every
   *  test written before byes existed keeps its old meaning. */
  status?: string;
}

/** T7a: a court's weekly hours and dated exceptions, snake_case exactly as
 *  the real `PUT .../calendar` body and the real `GET .../venues` response
 *  both spell them (`usecases/venues.ts`) — this row is what both routes
 *  below read and write, so there is one shape and one rename site, same as
 *  the product's. Empty by default: a court `POST /courts` creates has no
 *  calendar rows at all, which `checker.ts`'s own note 1 reads as "open all
 *  day, every day". */
interface FakeCourtRow {
  id: string;
  name: string;
  venue_id: string;
  hours: { weekday: number; open_min: number; close_min: number }[];
  exceptions: { date: string; closed: boolean; open_min: number | null; close_min: number | null }[];
}

interface FakeVenueRow {
  id: string;
  courts: FakeCourtRow[];
}

/** Every deviation a test can ask this fake for. All of them default to the
 *  well-behaved product: a fake whose interesting behaviour is the default is
 *  a fake nobody can write a clean-path test against. */
export interface FakeScheduleOptions {
  /** `solver.engine` in the `auto` response — what ACTUALLY ran. `--engine`
   *  asserts against this, so a test drives the mismatch by disagreeing with
   *  the `engine` it passes to `runTinySuite`. */
  solverEngine?: "greedy" | "optimized";
  solverStatus?: string;
  /** Per-STAGE override of `solverEngine`/`solverStatus`, keyed by the stage
   *  id the fake's `/generate` route minted (e.g. `"stage-badminton-league"`).
   *  T7d: the live bench proved one leg's divisions can legitimately DISAGREE
   *  about which engine actually ran — a one-fixture division proves
   *  `already_optimal` and comes back `greedy` while its sibling in the SAME
   *  leg runs the full solver. The uniform `solverEngine`/`solverStatus`
   *  knobs above answer every stage identically and cannot reproduce that
   *  shape. Falls back to them for any stage not named here. */
  solverOverrideByStageId?: Readonly<Record<string, { engine?: "greedy" | "optimized"; status?: string }>>;
  /** Drop this key from the config `schedule-settings` echoes back, modelling
   *  a product build that does not have the knob the pack declared. */
  dropSettingsKey?: string;
  /** What `/validate` reports. Default: none. */
  validateConflicts?: readonly unknown[];
  /** Omit `metrics` from the `auto` response — the "the solver said nothing"
   *  state, which is NOT the same as "the solver placed nothing". */
  omitMetrics?: boolean;
  /** Omit `solver` entirely — a wire contract break, since
   *  `AutoScheduleResult.solver` is non-optional. */
  omitSolver?: boolean;
  /** Propose no assignments at all. */
  proposeNothing?: boolean;
  /** Put every fixture of a stage on the FIRST court at the SAME instant — a
   *  real court double-booking that `/validate` (this fake's, and by design
   *  §1.2 the product's too for several rule kinds) reports nothing about. */
  doubleBookCourt?: boolean;
  /** Leave the last N fixtures of a stage unplaced. */
  leaveUnplaced?: number;
  /** Merged OVER the computed metrics, so a test can make the solver's
   *  PROPOSAL disagree with the board it actually produced. */
  metricsOverride?: Partial<{
    makespan_minutes: number;
    worst_idle_gap_minutes: number;
    court_imbalance_minutes: number;
    placed: number;
    total: number;
  }>;
  /** Move a pinned fixture during `apply`, so pin integrity has something to
   *  catch. Keyed by fixture id. */
  movePinnedTo?: { fixtureId: string; scheduledAt: string; courtId: string };
  /** Place this stage as though no OTHER division had booked the courts —
   *  i.e. exactly what this fake did before it modelled `siblingAssignments`.
   *
   *  The product does NOT behave this way: `siblingAssignments`
   *  (`usecases/schedule.ts:839-884`) selects every already-placed fixture of
   *  the same COMPETITION and hands it to the placer and the verifier as fixed
   *  occupancy, so a real `auto` cannot land on a court another division is
   *  already using. This knob restores the blind behaviour on purpose, and for
   *  one purpose: it is the only way to produce a board where each division is
   *  internally clean and the run-level cross-division court check is the ONLY
   *  thing that can fire. */
  ignoreSiblingOccupancy?: boolean;
}

export interface FakeScheduleWorld {
  readonly options: FakeScheduleOptions;
  readonly fixtures: Map<string, FakeFixtureRow>;
  readonly settingsByDivisionId: Map<string, { config: Record<string, unknown>; tz: string }>;
  addVenue(id: string): void;
  addCourt(venueId: string, id: string, name: string): void;
  addStage(stageId: string, divisionId: string): void;
  addEntrants(divisionId: string, entrantIds: readonly string[]): void;
  /** B05 T3 — read-only access to what `addEntrants` recorded, IN CREATION
   *  ORDER. Shared here for the same "one implementation" reason as
   *  everything else in this file: `_advance-routes.ts`'s fake seed-proposal
   *  needs a division's own entrant ids to answer qualifiers/finalRanks with,
   *  and this is the one place that already tracks them. Empty array, never
   *  undefined, for a division `addEntrants` never saw. */
  entrantsOfDivision(divisionId: string): readonly string[];
  /** Called from the fake's own `/generate` handler with what it returned. */
  addFixtures(stageId: string, rows: readonly { id: string; ext_key: string }[]): void;
  setStatus(fixtureId: string, status: string): void;
  setOfficials(fixtureId: string, set: unknown[]): void;
  /** T7a: `PUT /orgs/{id}/courts/{courtId}/calendar` — a FULL replace, same
   *  as the product's. Exposed so a test can populate a court's calendar
   *  directly (bypassing HTTP) as well as through the route below. */
  setCourtCalendar(
    courtId: string,
    hours: readonly { weekday: number; open_min: number; close_min: number }[],
    exceptions: readonly { date: string; closed: boolean; open_min: number | null; close_min: number | null }[],
  ): void;
  /** `undefined` means "not one of my routes" — the caller falls through to
   *  its own handlers. Spelled `unknown` rather than `unknown | undefined`:
   *  `unknown` already admits `undefined`, and the union form is a lint error
   *  (`no-redundant-type-constituents`) precisely because it reads as a
   *  narrowing that is not one. The convention lives in this comment, which
   *  is the only place it can live. */
  handle(method: string, routePath: string, body: unknown): unknown;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `rr-r{round}-c{court}` is the product's own round-robin ext-key format
 *  (`packages/engine/src/scheduling/roundrobin.ts:138`). Read rather than
 *  counted, so a stage whose fixtures arrive out of order still gets the round
 *  the key names — and so a fixture with no parseable key lands at round 1
 *  rather than at an invented one. */
function roundOf(extKey: string, fallback: number): number {
  const match = /^(?:p[A-Z]-)?rr-r(\d+)-c\d+$/.exec(extKey);
  return match === undefined || match === null ? fallback : Number(match[1]);
}

export function makeScheduleWorld(options: FakeScheduleOptions = {}): FakeScheduleWorld {
  const fixtures = new Map<string, FakeFixtureRow>();
  const settingsByDivisionId = new Map<string, { config: Record<string, unknown>; tz: string }>();
  const divisionIdByStageId = new Map<string, string>();
  const entrantsByDivisionId = new Map<string, string[]>();
  const venues = new Map<string, FakeVenueRow>();

  const world: FakeScheduleWorld = {
    options,
    fixtures,
    settingsByDivisionId,

    addVenue(id) {
      venues.set(id, { id, courts: [] });
    },
    addCourt(venueId, id, name) {
      const venue = venues.get(venueId);
      if (venue === undefined) throw new Error(`fake schedule world: no venue ${venueId}`);
      venue.courts.push({ id, name, venue_id: venueId, hours: [], exceptions: [] });
    },
    addStage(stageId, divisionId) {
      divisionIdByStageId.set(stageId, divisionId);
    },
    addEntrants(divisionId, entrantIds) {
      entrantsByDivisionId.set(divisionId, [...entrantIds]);
    },
    entrantsOfDivision(divisionId) {
      return entrantsByDivisionId.get(divisionId) ?? [];
    },
    addFixtures(stageId, rows) {
      const divisionId = divisionIdByStageId.get(stageId);
      if (divisionId === undefined) {
        throw new Error(`fake schedule world: /generate on unknown stage ${stageId}`);
      }
      const entrants = entrantsByDivisionId.get(divisionId) ?? [];
      rows.forEach((row, i) => {
        const round = roundOf(row.ext_key, i + 1);
        // Sides MIRROR on even legs, exactly as the product's round robin
        // does (`scheduling/roundrobin.ts`) — believability's home/away
        // alternation reads them, and a fake that never swaps would score a
        // perfect alternation nothing earned.
        const swap = round % 2 === 0;
        fixtures.set(row.id, {
          id: row.id,
          division_id: divisionId,
          stage_id: stageId,
          ext_key: row.ext_key,
          round_no: round,
          home_entrant_id: (swap ? entrants[1] : entrants[0]) ?? null,
          away_entrant_id: (swap ? entrants[0] : entrants[1]) ?? null,
          scheduled_at: null,
          court_id: null,
          officials: [],
          schedule_locked: false,
        });
      });
    },
    setStatus(fixtureId: string, status: string) {
      const row = fixtures.get(fixtureId);
      if (row !== undefined) row.status = status;
    },
    setOfficials(fixtureId, set) {
      const row = fixtures.get(fixtureId);
      if (row !== undefined) row.officials = set;
    },
    setCourtCalendar(courtId, hours, exceptions) {
      for (const venue of venues.values()) {
        const court = venue.courts.find((c) => c.id === courtId);
        if (court === undefined) continue;
        court.hours = [...hours];
        court.exceptions = [...exceptions];
        return;
      }
      throw new Error(`fake schedule world: calendar PUT for unknown court ${courtId}`);
    },

    handle(method, routePath, body) {
      // ---- GET /api/v1/orgs/{id}/venues ---------------------------------
      if (method === "GET" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(routePath)) {
        return [...venues.values()].map((v) => ({
          id: v.id,
          // A court that never took a calendar PUT still carries its
          // `addCourt`-time `hours: []`/`exceptions: []` — "open all day"
          // (checker.ts's own note 1), same as a real freshly-`POST`ed court.
          // T7a: a court `setCourtCalendar` DID touch echoes what was PUT,
          // because `board.ts`'s `toBoardCourt` reads hours/exceptions off
          // exactly this response — a fake that kept accepting the PUT but
          // never fed it back here would leave the checker's oracle believing
          // every court is open all day regardless of what the pack declared.
          courts: v.courts.map((c) => ({
            id: c.id,
            name: c.name,
            venue_id: c.venue_id,
            hours: c.hours,
            exceptions: c.exceptions,
          })),
        }));
      }

      // ---- PUT /api/v1/orgs/{id}/courts/{courtId}/calendar --------------
      const calendarMatch = /^\/api\/v1\/orgs\/[^/]+\/courts\/([^/]+)\/calendar$/.exec(routePath);
      if (method === "PUT" && calendarMatch !== null) {
        const courtId = calendarMatch[1];
        const hours = isRecord(body) && Array.isArray(body.hours) ? body.hours : [];
        const exceptions = isRecord(body) && Array.isArray(body.exceptions) ? body.exceptions : [];
        world.setCourtCalendar(
          courtId,
          hours as { weekday: number; open_min: number; close_min: number }[],
          exceptions as { date: string; closed: boolean; open_min: number | null; close_min: number | null }[],
        );
        return { hours, exceptions };
      }

      // ---- PUT /api/v1/divisions/{id}/schedule-settings -----------------
      const settingsMatch = /^\/api\/v1\/divisions\/([^/]+)\/schedule-settings$/.exec(routePath);
      if (method === "PUT" && settingsMatch !== null) {
        const divisionId = settingsMatch[1];
        const sent = isRecord(body) && isRecord(body.config) ? body.config : {};
        const tz = isRecord(body) && typeof body.tz === "string" ? body.tz : "UTC";
        const persisted: Record<string, unknown> = { ...sent };
        if (options.dropSettingsKey !== undefined) delete persisted[options.dropSettingsKey];
        settingsByDivisionId.set(divisionId, { config: persisted, tz });
        return { config: persisted, tz };
      }

      // ---- PATCH /api/v1/fixtures/{id} ----------------------------------
      // Anchored, so `PATCH /fixtures/{id}/officials` (a DIFFERENT route,
      // owned by each caller) never falls in here.
      const patchMatch = /^\/api\/v1\/fixtures\/([^/]+)$/.exec(routePath);
      if (method === "PATCH" && patchMatch !== null) {
        const row = fixtures.get(patchMatch[1]);
        if (row === undefined) throw new Error(`fake schedule world: PATCH unknown fixture ${patchMatch[1]}`);
        if (isRecord(body)) {
          if (typeof body.scheduled_at === "string") row.scheduled_at = body.scheduled_at;
          if (typeof body.court_id === "string") row.court_id = body.court_id;
          if (typeof body.schedule_locked === "boolean") row.schedule_locked = body.schedule_locked;
        }
        return { ...row, conflicts: [] };
      }

      // ---- GET /api/v1/divisions/{id}/fixtures --------------------------
      const listMatch = /^\/api\/v1\/divisions\/([^/]+)\/fixtures$/.exec(routePath);
      if (method === "GET" && listMatch !== null) {
        const divisionId = listMatch[1];
        return [...fixtures.values()]
          .filter((f) => f.division_id === divisionId)
          .sort((a, b) => a.round_no - b.round_no || a.id.localeCompare(b.id))
          .map((f) => ({ ...f }));
      }

      // ---- POST /api/v1/stages/{id}/schedule/auto -----------------------
      const autoMatch = /^\/api\/v1\/stages\/([^/]+)\/schedule\/auto$/.exec(routePath);
      if (method === "POST" && autoMatch !== null) {
        return autoResponse(autoMatch[1]);
      }

      // ---- POST /api/v1/stages/{id}/schedule/apply ----------------------
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/schedule\/apply$/.test(routePath)) {
        const rows = isRecord(body) && Array.isArray(body.assignments) ? body.assignments : [];
        for (const raw of rows as readonly unknown[]) {
          if (!isRecord(raw)) continue;
          const row = fixtures.get(String(raw.fixture_id));
          if (row === undefined) continue;
          const move = options.movePinnedTo;
          if (move !== undefined && move.fixtureId === row.id) {
            // The pin-integrity mutant: apply lands the fixture somewhere the
            // lock said it would not go.
            row.scheduled_at = move.scheduledAt;
            row.court_id = move.courtId;
            continue;
          }
          if (typeof raw.scheduled_at === "string") row.scheduled_at = raw.scheduled_at;
          if (typeof raw.court_id === "string") row.court_id = raw.court_id;
        }
        return { applied: rows.length };
      }

      // ---- POST /api/v1/divisions/{id}/schedule/validate ----------------
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/schedule\/validate$/.test(routePath)) {
        return { conflicts: options.validateConflicts ?? [] };
      }

      return undefined;
    },
  };

  function autoResponse(stageId: string): unknown {
    const divisionId = divisionIdByStageId.get(stageId);
    const rows = [...fixtures.values()]
      .filter((f) => f.stage_id === stageId)
      .sort((a, b) => a.round_no - b.round_no || a.id.localeCompare(b.id));
    const settings = divisionId === undefined ? undefined : settingsByDivisionId.get(divisionId);
    const cfg = settings?.config ?? {};
    const startMs = typeof cfg.startAt === "string" ? Date.parse(cfg.startAt) : Date.parse("2099-01-01T09:00:00.000Z");
    const matchMinutes = typeof cfg.matchMinutes === "number" ? cfg.matchMinutes : 30;
    const courts: string[] = Array.isArray(cfg.courts)
      ? (cfg.courts as readonly unknown[]).filter((c): c is string => typeof c === "string")
      : [];

    // T7a: a declared `perEntrantMinRest` is baked into the SLOT PITCH, not
    // just recorded. This fake has no solver — it cannot re-plan around a
    // rest floor the way the real placer does — so the only way its output
    // can satisfy a floor the pack actually declares is to space every
    // consecutive slot by at least it. That is not a general fix (a stage
    // with several INDEPENDENT entrant pairs would not need every slot
    // spaced, only same-entrant ones), but it is exact for every stage this
    // bench schedules today: every fixture in a `_tiny` stage shares the
    // same one or two entrants, so spacing consecutive slots by the floor
    // spaces each entrant's own series by it too. `restFloor` is 0 on every
    // config that does not declare one, so the pitch is `matchMinutes`
    // unchanged wherever nothing asked for rest — this cannot move a slot
    // for a caller that predates T7a.
    const restFloor = typeof cfg.perEntrantMinRest === "number" ? cfg.perEntrantMinRest : 0;
    const pitchMinutes = matchMinutes + restFloor;

    // WHAT ANOTHER DIVISION HAS ALREADY BOOKED.
    //
    // Modelled because the product models it: `siblingAssignments`
    // (`usecases/schedule.ts:839-884`) selects every placed fixture of the same
    // COMPETITION outside this division and feeds it to the placer AND to
    // `validateAssignments` as `existing` — where the court-clash rule runs
    // over `board = [...existing, ...assignments]` (`calendar.ts:1719`). So a
    // real `auto` cannot put this stage on a court another division of the same
    // competition is already using, and a fake that could would be accepting
    // what the product refuses.
    //
    // Keyed by `courtId` + start instant, which is enough here because every
    // slot this fake emits is exactly `matchMinutes` long and aligned to
    // `startAt`.
    const occupied = new Set<string>();
    if (options.ignoreSiblingOccupancy !== true) {
      for (const other of fixtures.values()) {
        if (other.stage_id === stageId) continue;
        if (other.scheduled_at === null || other.court_id === null) continue;
        occupied.add(`${other.court_id}@${Date.parse(other.scheduled_at)}`);
      }
    }
    // T7a fix round 1: a declared `max_fixtures_per_day` (scoped
    // `every_entrant` — the only scope `_tiny` declares) is honoured by
    // spilling the OFFENDING fixture onto the next calendar day, never by
    // ignoring the cap. Without this, the moment `_tiny` declared a real cap
    // the DEFAULT ("well-behaved product") scenario would itself breach its
    // own declared constraint — a false product defect of exactly the kind
    // `perEntrantMinRest`'s rest-aware pitch (above) already exists to avoid.
    // Only `every_entrant`/`competition` scopes are modelled (the two this
    // bench ever declares); any other scope is read as "no cap", matching
    // this fake's existing default-to-well-behaved stance.
    const hardRules: readonly unknown[] =
      isRecord(cfg.constraints) && Array.isArray(cfg.constraints.hard) ? cfg.constraints.hard : [];
    const dayCap = hardRules
      .filter(isRecord)
      .find(
        (r) =>
          r.type === "max_fixtures_per_day" &&
          typeof r.count === "number" &&
          isRecord(r.scope) &&
          (r.scope.kind === "every_entrant" || r.scope.kind === "competition"),
      )?.count as number | undefined;

    function entrantsOf(row: FakeFixtureRow): string[] {
      return [row.home_entrant_id, row.away_entrant_id].filter((e): e is string => e !== null);
    }
    // Per-entrant, per calendar-day count — LOCAL to this call, because
    // `checkBoard` (and therefore this cap) only ever sees one division's own
    // fixtures. `dayIdx` is `Math.floor((at - startMs) / DAY_MS)`, which is
    // exact because `_tiny`'s org zone is UTC — a real multi-timezone fake
    // would need `checker.ts`'s own `civil()`, not raw epoch arithmetic.
    const dayCountByEntrant = new Map<string, Map<number, number>>();
    function dayCapBlocks(row: FakeFixtureRow, dayIdx: number): boolean {
      if (dayCap === undefined) return false;
      return entrantsOf(row).some((e) => (dayCountByEntrant.get(e)?.get(dayIdx) ?? 0) + 1 > dayCap);
    }
    function recordDay(row: FakeFixtureRow, dayIdx: number): void {
      for (const e of entrantsOf(row)) {
        const byDay = dayCountByEntrant.get(e) ?? new Map<number, number>();
        byDay.set(dayIdx, (byDay.get(dayIdx) ?? 0) + 1);
        dayCountByEntrant.set(e, byDay);
      }
    }

    // T7a fix round 1: a declared `blackouts[]` entry is honoured by walking
    // PAST it, the same way this fake already walks past a sibling's
    // occupied slot — never by placing into it and letting the checker
    // discover the breach on the default scenario. `court` is already the
    // REAL resolved court id here (`resolvedConfig` in `schedule.ts` rewrites
    // every `@`-ref before this config is PUT), matching `chosen.court`
    // directly. An entry with no `court` key is GLOBAL, same semantics as
    // `board.ts`'s own reading of it.
    const blackouts: { court?: string; from: number; to: number }[] = Array.isArray(cfg.blackouts)
      ? (cfg.blackouts as readonly unknown[])
          .filter(isRecord)
          .map((b) => ({
            court: typeof b.court === "string" ? b.court : undefined,
            from: typeof b.from === "string" ? Date.parse(b.from) : Number.NaN,
            to: typeof b.to === "string" ? Date.parse(b.to) : Number.NaN,
          }))
          .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to))
      : [];
    function isBlackedOut(court: string, at: number): boolean {
      const end = at + matchMinutes * MINUTE_MS;
      return blackouts.some((b) => (b.court === undefined || b.court === court) && at < b.to && b.from < end);
    }

    // `dayIndex`/`slotInDay` replace the old single `slot` counter: TIME and
    // COURT both reset to the pack's own daily opening slot at the start of
    // each calendar day, rather than drifting through the clock as `slot`
    // climbs — which is what let a spilled-over fixture land at local
    // midnight, outside every declared court-hours/session-window range, in
    // an earlier draft of this change. `doubleBookCourt` still forces every
    // candidate to the fixed `startMs`/`courts[0]` regardless of either
    // counter, unchanged from before.
    function candidateAt(dayIdx: number, slotInDay: number): { at: number; court: string } {
      return {
        at:
          options.doubleBookCourt === true
            ? startMs
            : startMs + dayIdx * DAY_MS + slotInDay * pitchMinutes * MINUTE_MS,
        court:
          courts.length === 0
            ? "court-unset"
            : courts[options.doubleBookCourt === true ? 0 : slotInDay % courts.length],
      };
    }

    const assignments: { fixture_id: string; scheduled_at: string; court_id: string }[] = [];
    if (!(options.proposeNothing === true)) {
      const placeable = rows.slice(0, rows.length - (options.leaveUnplaced ?? 0));
      let dayIndex = 0;
      let slotInDay = 0;
      for (const row of placeable) {
        // A LOCKED fixture keeps the slot it already holds — a lock is
        // honoured on every mode, unconditionally. It is deliberately NOT
        // added to `occupied`: an unlocked row in the SAME stage must still
        // be able to land on the identical slot (the `doubleBookCourt`
        // court-double-booking test depends on exactly that), and only
        // OTHER stages' persisted fixtures populate `occupied` at all. It
        // still counts toward the day cap, because the real cap counts every
        // placed fixture, locked or not.
        if (row.schedule_locked && row.scheduled_at !== null && row.court_id !== null) {
          recordDay(row, Math.floor((Date.parse(row.scheduled_at) - startMs) / DAY_MS));
          assignments.push({
            fixture_id: row.id,
            scheduled_at: row.scheduled_at,
            court_id: row.court_id,
          });
          slotInDay += 1;
          continue;
        }
        // Walk past anything a sibling division already holds, anything
        // inside a declared blackout, or anything the day cap would breach —
        // a day-cap block jumps straight to day+1 (nothing on the REST of
        // today's slots can help), the other two just try the next slot
        // today. Bounded, so a fully-booked venue proposes fewer assignments
        // rather than looping — which is the honest answer and reaches the
        // driver's own "auto proposed 0 assignments" refusal.
        let chosen = candidateAt(dayIndex, slotInDay);
        let guard = 0;
        const blocked = (): boolean =>
          dayCapBlocks(row, dayIndex) ||
          occupied.has(`${chosen.court}@${chosen.at}`) ||
          isBlackedOut(chosen.court, chosen.at);
        while (blocked() && guard < 200) {
          if (dayCapBlocks(row, dayIndex)) {
            dayIndex += 1;
            slotInDay = 0;
          } else {
            slotInDay += 1;
          }
          chosen = candidateAt(dayIndex, slotInDay);
          guard += 1;
        }
        if (blocked()) continue;
        occupied.add(`${chosen.court}@${chosen.at}`);
        recordDay(row, dayIndex);
        assignments.push({
          fixture_id: row.id,
          scheduled_at: new Date(chosen.at).toISOString(),
          court_id: chosen.court,
        });
        slotInDay += 1;
      }
    }

    const starts = assignments.map((a) => Date.parse(a.scheduled_at));
    const makespan =
      starts.length === 0
        ? 0
        : (Math.max(...starts) + matchMinutes * MINUTE_MS - Math.min(...starts)) / MINUTE_MS;
    const metrics = {
      makespan_minutes: makespan,
      worst_idle_gap_minutes: 0,
      court_imbalance_minutes: 0,
      placed: assignments.length,
      total: rows.length,
      ...(options.metricsOverride ?? {}),
    };

    const solverOverride = options.solverOverrideByStageId?.[stageId];
    return {
      assignments,
      conflicts: [],
      ...(options.omitMetrics === true ? {} : { metrics }),
      ...(options.omitSolver === true
        ? {}
        : {
            solver: {
              engine: solverOverride?.engine ?? options.solverEngine ?? "optimized",
              status: solverOverride?.status ?? options.solverStatus ?? "ok",
              mode: "build",
            },
          }),
    };
  }

  return world;
}
