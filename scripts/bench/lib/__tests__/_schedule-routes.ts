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
}

interface FakeCourtRow {
  id: string;
  name: string;
  venue_id: string;
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
}

export interface FakeScheduleWorld {
  readonly options: FakeScheduleOptions;
  readonly fixtures: Map<string, FakeFixtureRow>;
  readonly settingsByDivisionId: Map<string, { config: Record<string, unknown>; tz: string }>;
  addVenue(id: string): void;
  addCourt(venueId: string, id: string, name: string): void;
  addStage(stageId: string, divisionId: string): void;
  addEntrants(divisionId: string, entrantIds: readonly string[]): void;
  /** Called from the fake's own `/generate` handler with what it returned. */
  addFixtures(stageId: string, rows: readonly { id: string; ext_key: string }[]): void;
  setOfficials(fixtureId: string, set: unknown[]): void;
  /** `undefined` means "not one of my routes" — the caller falls through to
   *  its own handlers. */
  handle(method: string, routePath: string, body: unknown): unknown | undefined;
}

const MINUTE_MS = 60_000;

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
      venue.courts.push({ id, name, venue_id: venueId });
    },
    addStage(stageId, divisionId) {
      divisionIdByStageId.set(stageId, divisionId);
    },
    addEntrants(divisionId, entrantIds) {
      entrantsByDivisionId.set(divisionId, [...entrantIds]);
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
    setOfficials(fixtureId, set) {
      const row = fixtures.get(fixtureId);
      if (row !== undefined) row.officials = set;
    },

    handle(method, routePath, body) {
      // ---- GET /api/v1/orgs/{id}/venues ---------------------------------
      if (method === "GET" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(routePath)) {
        return [...venues.values()].map((v) => ({
          id: v.id,
          // NO `hours`, NO `exceptions`: a court with no declared calendar is
          // "open all day" (checker.ts's own note 1), which is what a bench
          // court created through `POST /courts` genuinely is.
          courts: v.courts.map((c) => ({ id: c.id, name: c.name, venue_id: c.venue_id })),
        }));
      }

      // ---- PUT /api/v1/divisions/{id}/schedule-settings -----------------
      const settingsMatch = /^\/api\/v1\/divisions\/([^/]+)\/schedule-settings$/.exec(routePath);
      if (method === "PUT" && settingsMatch !== null) {
        const divisionId = settingsMatch[1]!;
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
        const row = fixtures.get(patchMatch[1]!);
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
        const divisionId = listMatch[1]!;
        return [...fixtures.values()]
          .filter((f) => f.division_id === divisionId)
          .sort((a, b) => a.round_no - b.round_no || a.id.localeCompare(b.id))
          .map((f) => ({ ...f }));
      }

      // ---- POST /api/v1/stages/{id}/schedule/auto -----------------------
      const autoMatch = /^\/api\/v1\/stages\/([^/]+)\/schedule\/auto$/.exec(routePath);
      if (method === "POST" && autoMatch !== null) {
        return autoResponse(autoMatch[1]!);
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

    const assignments: { fixture_id: string; scheduled_at: string; court_id: string }[] = [];
    if (!(options.proposeNothing === true)) {
      const placeable = rows.slice(0, rows.length - (options.leaveUnplaced ?? 0));
      placeable.forEach((row, slot) => {
        // A LOCKED fixture keeps the slot it already holds — a lock is
        // honoured on every mode, unconditionally.
        if (row.schedule_locked && row.scheduled_at !== null && row.court_id !== null) {
          assignments.push({
            fixture_id: row.id,
            scheduled_at: row.scheduled_at,
            court_id: row.court_id,
          });
          return;
        }
        const court = courts.length === 0 ? "court-unset" : courts[options.doubleBookCourt === true ? 0 : slot % courts.length]!;
        const at = options.doubleBookCourt === true ? startMs : startMs + slot * matchMinutes * MINUTE_MS;
        assignments.push({
          fixture_id: row.id,
          scheduled_at: new Date(at).toISOString(),
          court_id: court,
        });
      });
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

    return {
      assignments,
      conflicts: [],
      ...(options.omitMetrics === true ? {} : { metrics }),
      ...(options.omitSolver === true
        ? {}
        : {
            solver: {
              engine: options.solverEngine ?? "optimized",
              status: options.solverStatus ?? "ok",
              mode: "build",
            },
          }),
    };
  }

  return world;
}
