// checker.ts — B04's INDEPENDENT verifier (design §2.3, §3.3).
//
// Pure. No I/O, no clock, no logging, no randomness — a function of its two
// arguments and nothing else. `new Date(ms)` appears only as an argument to
// `Intl.DateTimeFormat.formatToParts`, which is a pure epoch->civil
// conversion; `Date.now()` never appears.
//
// -------------------------------------------------------------------------
// What "independent" costs, and why the cost is the point
// -------------------------------------------------------------------------
//
// NO VALUE IMPORT FROM `@seazn/engine` (design §2.3). In particular:
//
//   * `usableWindows` is NOT imported. The solver consumes it to decide which
//     windows are legal, so a checker that verified containment with the same
//     function would agree with the product BY CONSTRUCTION and the court-hours
//     rule would be a tautology. This module recomputes containment from the
//     raw `court_hours` / `court_exceptions` rows on `BoardCourt`.
//   * `assessCapacity` is NOT imported: it is a pre-flight feasibility
//     estimate, not a verification of a board that was produced.
//
// Recomputing independently is not licence to invent different SEMANTICS. The
// two court-calendar rules `court-windows.ts`'s own header states as decisions
// are reproduced here deliberately, and the tests pin both directions:
//
//   1. "No calendar declared" is a property of the COURT, not of the day. A
//      court with ZERO `court_hours` rows is open all day, every day —
//      calendars strictly SUBTRACT. A court that HAS hours but none for
//      Tuesday is CLOSED on Tuesday.
//   2. A date carries at most ONE exception (the table's primary key), and it
//      either closes the day or REPLACES that day's ranges. It never
//      intersects with the weekly rows.
//
// Type-only imports are wanted, not merely tolerated (design §2.3): they are
// how the bench's vocabulary is stopped from drifting from the product's.
// `ConflictDetailKind` earns its import below as a compile-time pin.
//
// -------------------------------------------------------------------------
// The three conventions every rule here obeys
// -------------------------------------------------------------------------
//
// 1. OCCUPANCY IS `[start, start + matchMinutes)` — HALF-OPEN, AND NEVER
//    `BoardFixture.end` (ruling R12). `end` is T4's derivation of the same
//    number and `schedule.ts` records a `duration_disagreement` when the
//    product contradicts it; a checker that measured against `end` would
//    inherit whichever side T4 preferred, which is the one thing design §4.2
//    refuses to decide silently. `gapMinutes` is NOT part of occupancy: a gap
//    is a spacing preference, design §3.3's rule list carries no gap rule, and
//    `board.ts` reports it as unmodelled rather than letting this file guess.
//
// 2. UNPLACED FIXTURES ARE SKIPPED BY EVERY RULE. `start === undefined` means
//    the product placed nothing, which is Task 4's gate (`unplacedCount`,
//    `judgeDivision`'s fourth trigger), not the checker's. Letting `undefined`
//    coerce to 0 would put the fixture at 1970-01-01 — outside every session
//    window, outside every court's hours and a day before round 1 — and red
//    four rules at once on a board with no scheduling defect at all.
//
// 3. A SCOPED RULE IS APPLIED TO ITS SCOPE, AND THE SCOPE LIVES IN THE TALLY
//    KEY. `constraints.ts:36-50` documents the failure this prevents in the
//    other direction: "no player plays more than 2 matches a day" compiled as
//    a whole-run cap caps a 60-player event at two matches daily.
//    `scopeCoversFixture` answers `true` for both `competition` and
//    `every_entrant` and cannot tell them apart — so `tallyKeys` below returns
//    ONE key for the former and ONE KEY PER MEMBER for the latter, and that
//    difference is what a test pins. Over-applying a scoped rule files a FALSE
//    product defect, which is the worst output a harness like this can produce.

import type { ConflictDetailKind, ConstraintScope } from "@seazn/engine/scheduling";
import type {
  Board,
  BoardCourt,
  BoardFixture,
  CheckerFinding,
  CheckerFindingKind,
  CheckerReport,
  EncodedConstraints,
  EncodedHardRule,
} from "./board.ts";

// ---------------------------------------------------------------------------
// The vocabulary pin
// ---------------------------------------------------------------------------

/** Seven of `CheckerFindingKind`'s members are the PRODUCT'S OWN conflict
 *  tokens, spelled identically (`conflict-detail.ts:70`). That is deliberate —
 *  a bench finding and the `/validate` row it disagrees with should cite one
 *  string — and it is only true for as long as nobody renames one.
 *
 *  So the overlap is asserted at COMPILE TIME rather than left as a comment.
 *  `tsconfig.scripts.json` includes `scripts/**\/*.ts` (and excludes only
 *  `*.test.ts`), so `npm run typecheck:scripts` is what enforces this; a
 *  product rename of, say, `inside_blackout` reds the typecheck here instead
 *  of silently giving the bench a private vocabulary. */
type Assert<T extends true> = T;
type SharedWithProduct =
  | "court_double_booking"
  | "inside_blackout"
  | "outside_session_windows"
  | "outside_court_hours"
  | "entrant_below_rest"
  | "round_order_day"
  | "round_order_same_day";
type _KindsExistInProduct = Assert<SharedWithProduct extends ConflictDetailKind ? true : false>;
type _KindsExistInBench = Assert<SharedWithProduct extends CheckerFindingKind ? true : false>;

// ---------------------------------------------------------------------------
// Placed fixtures — computed once, per board
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

/** A placed fixture with its occupancy interval and its LOCAL civil clock
 *  already resolved, so no rule re-derives either and no pairwise loop pays
 *  for a timezone conversion per comparison. */
interface Placed {
  readonly fixture: BoardFixture;
  /** epoch ms. */
  readonly start: number;
  /** epoch ms, `start + matchMinutes` — convention 1. */
  readonly end: number;
  /** `YYYY-MM-DD` in the BOARD's zone. */
  readonly ymd: string;
  /** Minutes from local midnight, in the board's zone. */
  readonly startMinutes: number;
  /** 0 = Sunday, matching `CourtHoursRow.weekday`. */
  readonly weekday: number;
  /** Position in `board.fixtures`, so every finding order is the board's. */
  readonly index: number;
}

/** Epoch ms -> civil date and minutes-from-midnight in `tz`.
 *
 *  `Intl.DateTimeFormat` rather than any arithmetic on the epoch: a fixed
 *  offset is wrong twice a year, and the bench's own packs schedule in
 *  `Europe/London`, which is +00:00 for half the year and +01:00 for the
 *  other half. Reading the parts is also what makes this deterministic
 *  regardless of the HOST zone — the failure `board.ts`'s `epochMs` refuses
 *  one layer up. */
function civil(ms: number, tz: string): { ymd: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));

  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = read("hour");
  const minute = read("minute");
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return {
    ymd: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    minutes: hour * 60 + minute,
    // `Date.UTC` on the CIVIL date, so the weekday is the local one and never
    // the UTC instant's — they differ for any fixture whose zone shift crosses
    // midnight, which is every evening fixture in a +12 zone.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function placedFixtures(board: Board, constraints: EncodedConstraints): Placed[] {
  const out: Placed[] = [];
  board.fixtures.forEach((fixture, index) => {
    const start = fixture.start;
    // Convention 2. `typeof` rather than `!= null`, so a NaN or a string that
    // reached a `number` field at runtime is skipped rather than silently
    // compared — a NaN compares false against every bound and would make every
    // containment rule pass vacuously for that fixture.
    if (typeof start !== "number" || !Number.isFinite(start)) return;
    const { ymd, minutes, weekday } = civil(start, board.tz);
    out.push({
      fixture,
      start,
      end: start + constraints.matchMinutes * MS_PER_MINUTE,
      ymd,
      startMinutes: minutes,
      weekday,
      index,
    });
  });
  return out;
}

/** Half-open interval overlap. `<` on both sides, so two fixtures that ABUT —
 *  09:00-09:30 then 09:30-10:00 — do not collide. */
function overlaps(a: Placed, b: Placed): boolean {
  return a.start < b.end && b.start < a.end;
}

function finding(
  kind: CheckerFindingKind,
  constraints: EncodedConstraints,
  fixtureIds: readonly string[],
  detail: string,
  measured?: number,
  required?: number,
): CheckerFinding {
  return {
    kind,
    divisionRef: constraints.divisionRef,
    fixtureIds,
    detail,
    ...(measured === undefined ? {} : { measured }),
    ...(required === undefined ? {} : { required }),
  };
}

/** `2027-06-07T09:00` in the board's zone — every `detail` string quotes the
 *  LOCAL clock, because "09:00" is the number a reader can act on and
 *  1811833200000 is not. */
function localLabel(p: Placed): string {
  const h = Math.floor(p.startMinutes / 60);
  const m = p.startMinutes % 60;
  return `${p.ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Scope — convention 3
// ---------------------------------------------------------------------------

/** The keys ONE fixture increments under ONE scope. Empty means the rule does
 *  not cover this fixture at all.
 *
 *  The whole distinction `constraints.ts:36-50` warns about lives in the
 *  arity: `competition` returns ONE key for every covered fixture, so its
 *  tally is a whole-run count; `every_entrant` returns one key PER ENTRANT, so
 *  a single fixture increments several tallies and no entrant's cap is spent
 *  by another entrant's match. A checker that collapsed the universal scopes
 *  onto the competition key would cap a 60-player event at two matches a day
 *  and file it as a product defect. */
function tallyKeys(fixture: BoardFixture, scope: ConstraintScope): string[] {
  switch (scope.kind) {
    case "competition":
      return ["competition"];
    case "division":
      return fixture.divisionId === scope.divisionId ? [`division:${scope.divisionId}`] : [];
    case "entrant":
      return fixture.entrantIds.includes(scope.entrantId) ? [`entrant:${scope.entrantId}`] : [];
    case "person":
      return fixture.personIds.includes(scope.personKey) ? [`person:${scope.personKey}`] : [];
    case "pool":
      return fixture.divisionId === scope.divisionId && fixture.poolId === scope.pool
        ? [`pool:${scope.divisionId}:${scope.pool}`]
        : [];
    case "every_entrant":
      return fixture.entrantIds.map((id) => `entrant:${id}`);
    case "every_person":
      return fixture.personIds.map((id) => `person:${id}`);
  }
}

/** The keys a REST rule measures a series along.
 *
 *  Same idea as `tallyKeys`, with one difference that matters: the three
 *  FAMILY scopes (`competition`, `division`, `pool`) name a set of fixtures
 *  rather than a subject, so the subject has to come from `rest_scope`
 *  instead — a competition-wide "60 minutes between matches" is a rule about
 *  each PERSON, not about the competition as a single series. The entity and
 *  universal scopes already name their subject and keep it.
 *
 *  `feeder_to_dependent` produces NO series here and is recorded as a gap in
 *  the task report: it needs the bracket's `feeds` edges, and a `Board`
 *  carries none. It is not silently folded into the per-person reading, which
 *  would measure a rule nobody wrote. */
type MinRestRule = Extract<EncodedHardRule, { type: "min_rest_minutes" }>;

function restSeriesKeys(
  fixture: BoardFixture,
  scope: ConstraintScope,
  restScope: MinRestRule["restScope"],
): string[] {
  if (restScope === "feeder_to_dependent") return [];
  switch (scope.kind) {
    case "competition":
    case "division":
    case "pool":
      return tallyKeys(fixture, scope).length === 0
        ? []
        : fixture.personIds.map((id) => `person:${id}`);
    default:
      return tallyKeys(fixture, scope);
  }
}

/** Groups placed fixtures by key, preserving FIRST-APPEARANCE order of the
 *  keys and board order within each group — so every finding list this module
 *  emits is deterministic without sorting ids, which
 *  `conflict-detail.ts`'s own note forbids for the product's arrays. */
function groupBy(placed: readonly Placed[], keysOf: (p: Placed) => readonly string[]): Map<string, Placed[]> {
  const groups = new Map<string, Placed[]>();
  for (const p of placed) {
    for (const key of keysOf(p)) {
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [p]);
      else bucket.push(p);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Rule 1 — court double-booking
// ---------------------------------------------------------------------------

function courtDoubleBooking(
  placed: readonly Placed[],
  constraints: EncodedConstraints,
): CheckerFinding[] {
  const out: CheckerFinding[] = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      const court = a.fixture.courtId;
      // An unplaced-on-a-court fixture cannot double-book: `undefined ===
      // undefined` would pair every court-less fixture with every other.
      if (court === undefined || court !== b.fixture.courtId) continue;
      if (!overlaps(a, b)) continue;
      out.push(
        finding(
          "court_double_booking",
          constraints,
          [a.fixture.fixtureId, b.fixture.fixtureId],
          `court ${court} is occupied by ${a.fixture.fixtureId} (${localLabel(a)}) and ${b.fixture.fixtureId} (${localLabel(b)}) at the same time, for ${constraints.matchMinutes} minutes each`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2 — window / blackout containment
// ---------------------------------------------------------------------------

/** The court's usable minute-ranges on ONE local date, recomputed from raw
 *  rows. See the module header for the two semantics this reproduces. */
function courtRangesOn(
  court: BoardCourt,
  ymd: string,
  weekday: number,
): readonly { openMin: number; closeMin: number }[] | "open_all_day" {
  const exception = court.exceptions.find((e) => e.date === ymd);
  if (exception !== undefined) {
    if (exception.closed) return [];
    // A ranged exception REPLACES the weekly rows for that date; it never
    // intersects with them.
    if (typeof exception.openMin === "number" && typeof exception.closeMin === "number") {
      return [{ openMin: exception.openMin, closeMin: exception.closeMin }];
    }
    // `closed: false` with no range is unrepresentable in the table (the CHECK
    // constraint makes them mutually exclusive), so it means the exception row
    // says nothing about the ranges: fall through to the weekly calendar
    // rather than inventing a closure.
  }
  // Note 1: no calendar declared AT ALL is a property of the court.
  if (court.hours.length === 0) return "open_all_day";
  return court.hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ openMin: h.openMin, closeMin: h.closeMin }));
}

function windowContainment(
  placed: readonly Placed[],
  board: Board,
  constraints: EncodedConstraints,
): CheckerFinding[] {
  const out: CheckerFinding[] = [];
  const courtById = new Map(board.courts.map((c) => [c.courtId, c]));
  const durationMinutes = constraints.matchMinutes;

  for (const p of placed) {
    const id = p.fixture.fixtureId;

    // --- blackouts -------------------------------------------------------
    // An entry with no `courtId` is GLOBAL — the semantics `board.ts` and
    // `court-windows.ts` both state — so the court test is a MATCH, never a
    // requirement.
    for (const blackout of constraints.blackouts) {
      const applies =
        blackout.courtId === undefined || blackout.courtId === p.fixture.courtId;
      if (!applies) continue;
      if (!(p.start < blackout.to && blackout.from < p.end)) continue;
      out.push(
        finding(
          "inside_blackout",
          constraints,
          [id],
          `${id} at ${localLabel(p)} runs inside a blackout on ${blackout.courtId ?? "every court"}`,
        ),
      );
    }

    // --- session windows -------------------------------------------------
    // Empty = UNRESTRICTED, the same rule the placer and `court-windows.ts`
    // already apply. Containment is TOTAL: a fixture that starts inside a
    // window and finishes after it is outside it.
    if (constraints.sessionWindows.length > 0) {
      const inside = constraints.sessionWindows.some((w) => w.from <= p.start && p.end <= w.to);
      if (!inside) {
        out.push(
          finding(
            "outside_session_windows",
            constraints,
            [id],
            `${id} at ${localLabel(p)} (+${durationMinutes}m) is not wholly inside any of the ${constraints.sessionWindows.length} session window(s)`,
          ),
        );
      }
    }

    // --- the court's own calendar ----------------------------------------
    const court = p.fixture.courtId === undefined ? undefined : courtById.get(p.fixture.courtId);
    if (court !== undefined) {
      const ranges = courtRangesOn(court, p.ymd, p.weekday);
      if (ranges !== "open_all_day") {
        const endMinutes = p.startMinutes + durationMinutes;
        const inside = ranges.some((r) => r.openMin <= p.startMinutes && endMinutes <= r.closeMin);
        if (!inside) {
          const declared =
            ranges.length === 0
              ? "no usable range"
              : ranges.map((r) => `${r.openMin}-${r.closeMin}`).join(", ");
          out.push(
            finding(
              "outside_court_hours",
              constraints,
              [id],
              `${id} occupies ${p.startMinutes}-${endMinutes} minutes into ${p.ymd} on court ${court.courtId}, which declares ${declared} (minutes from local midnight, ${board.tz})`,
            ),
          );
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 3 — rest minima
// ---------------------------------------------------------------------------

/** Consecutive-pair gaps along one series, in minutes. A series is sorted by
 *  start; the gap is `next.start - previous.end`, so it is REST and not the
 *  start-to-start distance — a 30-minute match 40 minutes after another gives
 *  10 minutes of rest, not 40. */
function restBreaches(
  series: readonly Placed[],
  requiredMinutes: number,
  kindDetail: (a: Placed, b: Placed, measured: number) => string,
  constraints: EncodedConstraints,
): CheckerFinding[] {
  if (requiredMinutes <= 0) return [];
  const ordered = [...series].sort((a, b) => a.start - b.start || a.index - b.index);
  const out: CheckerFinding[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const next = ordered[i];
    const measured = Math.round((next.start - previous.end) / MS_PER_MINUTE);
    // `<`, so a gap EXACTLY at the floor passes — a minimum is satisfied by
    // its own value.
    if (measured >= requiredMinutes) continue;
    out.push(
      finding(
        "entrant_below_rest",
        constraints,
        [previous.fixture.fixtureId, next.fixture.fixtureId],
        kindDetail(previous, next, measured),
        measured,
        requiredMinutes,
      ),
    );
  }
  return out;
}

function restMinima(
  placed: readonly Placed[],
  constraints: EncodedConstraints,
): CheckerFinding[] {
  const out: CheckerFinding[] = [];

  // The top-level floor: per ENTRANT, unscoped — it is a division knob
  // (`schemas.ts:1303`), not a `HardConstraint`.
  const byEntrant = groupBy(placed, (p) => p.fixture.entrantIds);
  for (const [entrantId, series] of byEntrant) {
    out.push(
      ...restBreaches(
        series,
        constraints.perEntrantMinRest,
        (a, b, measured) =>
          `entrant ${entrantId} rests ${measured}m between ${a.fixture.fixtureId} (${localLabel(a)}) and ${b.fixture.fixtureId} (${localLabel(b)}), below perEntrantMinRest`,
        constraints,
      ),
    );
  }

  // The scoped rules.
  for (const rule of constraints.hard) {
    if (rule.type !== "min_rest_minutes") continue;
    const series = groupBy(placed, (p) => restSeriesKeys(p.fixture, rule.scope, rule.restScope));
    for (const [key, group] of series) {
      out.push(
        ...restBreaches(
          group,
          rule.minutes,
          (a, b, measured) =>
            `${key} rests ${measured}m between ${a.fixture.fixtureId} (${localLabel(a)}) and ${b.fixture.fixtureId} (${localLabel(b)}), below a min_rest_minutes rule scoped ${rule.scope.kind} (rest_scope ${rule.restScope})`,
          constraints,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 4 — day caps
// ---------------------------------------------------------------------------

function dayCaps(placed: readonly Placed[], constraints: EncodedConstraints): CheckerFinding[] {
  const out: CheckerFinding[] = [];
  for (const rule of constraints.hard) {
    if (rule.type !== "max_fixtures_per_day") continue;
    // The day is the LOCAL civil date, not a rolling 24 hours: "two matches a
    // day" is a calendar claim, and a rolling window would red a legal
    // Monday-evening / Tuesday-morning pair.
    const buckets = groupBy(placed, (p) => tallyKeys(p.fixture, rule.scope).map((k) => `${k}@${p.ymd}`));
    for (const [bucket, group] of buckets) {
      if (group.length <= rule.count) continue;
      out.push(
        finding(
          "day_cap_exceeded",
          constraints,
          group.map((p) => p.fixture.fixtureId),
          `${bucket} carries ${group.length} fixtures against a max_fixtures_per_day of ${rule.count} scoped ${rule.scope.kind}`,
          group.length,
          rule.count,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 5 — pin integrity
// ---------------------------------------------------------------------------

function pinIntegrity(board: Board, constraints: EncodedConstraints): CheckerFinding[] {
  const out: CheckerFinding[] = [];
  const byId = new Map(board.fixtures.map((f) => [f.fixtureId, f]));
  for (const pin of constraints.pins) {
    const fixture = byId.get(pin.fixtureId);
    if (fixture === undefined) {
      // A pinned fixture that is not on the board at all is the strongest
      // form of "the pin did not hold", not a reason to skip the check.
      out.push(
        finding(
          "pin_moved",
          constraints,
          [pin.fixtureId],
          `${pin.fixtureId} was locked before apply but is not on the fetched board at all`,
        ),
      );
      continue;
    }
    // BOTH halves, reported together so a pin that moved court AND time is one
    // finding — but each half can red on its own, which is what makes deleting
    // either one visible.
    const startHeld = fixture.start === pin.start;
    const courtHeld = fixture.courtId === pin.courtId;
    if (startHeld && courtHeld) continue;
    const moved = [
      startHeld ? undefined : `start ${String(pin.start)} -> ${String(fixture.start)}`,
      courtHeld ? undefined : `court ${pin.courtId} -> ${String(fixture.courtId)}`,
    ].filter((x): x is string => x !== undefined);
    out.push(
      finding(
        "pin_moved",
        constraints,
        [pin.fixtureId],
        `${pin.fixtureId} was locked before apply and moved: ${moved.join("; ")}`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 6 — officials
// ---------------------------------------------------------------------------

/** `Fixture.officials` is `z.array(z.unknown())` on the wire
 *  (design §4.3), so `BoardFixture.officialIds`'s `readonly string[]` is a
 *  TYPE claim that no runtime check stands behind. Shape-guarding here is what
 *  stops a `[{ person_id: … }]` element from being compared as an id and
 *  matching nothing — a silent pass. */
function readableOfficials(fixture: BoardFixture): { ids: string[]; unreadable: boolean } {
  const raw: unknown = fixture.officialIds;
  if (!Array.isArray(raw)) return { ids: [], unreadable: true };
  const ids: string[] = [];
  let unreadable = false;
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry === "string" && entry.length > 0) ids.push(entry);
    else unreadable = true;
  }
  return { ids, unreadable };
}

function officials(placed: readonly Placed[], constraints: EncodedConstraints): CheckerFinding[] {
  const out: CheckerFinding[] = [];
  const readable = new Map<string, string[]>();

  for (const p of placed) {
    const { ids, unreadable } = readableOfficials(p.fixture);
    readable.set(p.fixture.fixtureId, ids);
    if (unreadable) {
      out.push(
        finding(
          "officials_unreadable",
          constraints,
          [p.fixture.fixtureId],
          `${p.fixture.fixtureId} carries an official this checker cannot read as an id — Fixture.officials is z.array(z.unknown()) and the element is not a non-empty string`,
        ),
      );
    }
  }

  // Design §4.3's other half, and the reason this rule can fail at all: a
  // division whose PACK declared officials and whose board fetched none is not
  // a division with no officials — it is a fetch that returned nothing, and an
  // empty array makes every "no official is double-booked" test below pass
  // forever. Only red when something WAS placed: a division with no placed
  // fixtures is Task 4's unplaced gate, not this one's.
  if (constraints.declaresOfficials && placed.length > 0) {
    const anyOfficial = placed.some((p) => (readable.get(p.fixture.fixtureId) ?? []).length > 0);
    if (!anyOfficial) {
      out.push(
        finding(
          "officials_unreadable",
          constraints,
          placed.map((p) => p.fixture.fixtureId),
          `the pack declared officials for ${constraints.divisionRef} but not one of the ${placed.length} placed fixtures came back with any — the officials rules below would pass vacuously`,
        ),
      );
    }
  }

  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      if (!overlaps(a, b)) continue;
      const aIds = readable.get(a.fixture.fixtureId) ?? [];
      const bIds = readable.get(b.fixture.fixtureId) ?? [];
      const shared = aIds.filter((id) => bIds.includes(id));
      if (shared.length === 0) continue;
      out.push(
        finding(
          "official_double_booking",
          constraints,
          [a.fixture.fixtureId, b.fixture.fixtureId],
          `official(s) ${shared.join(", ")} are on ${a.fixture.fixtureId} (${localLabel(a)}) and ${b.fixture.fixtureId} (${localLabel(b)}), which overlap`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 7 — round order
// ---------------------------------------------------------------------------

/** Round-robin ONLY. `ConstraintScope` deliberately carries no `round` member
 *  (`constraints.ts`'s note): an elimination bracket numbers sparsely
 *  (1,2,3 winners / 7-10 losers / 14 grand final), so ordering rounds there
 *  would address the wrong fixtures. `isRoundRobin` is the gate, and a test
 *  runs the disordered board through it with the flag off. */
function roundOrder(placed: readonly Placed[], constraints: EncodedConstraints): CheckerFinding[] {
  if (!constraints.isRoundRobin) return [];
  const out: CheckerFinding[] = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = 0; j < placed.length; j += 1) {
      if (i === j) continue;
      const earlier = placed[i];
      const later = placed[j];
      const r = earlier.fixture.roundNo;
      const rPrime = later.fixture.roundNo;
      if (typeof r !== "number" || typeof rPrime !== "number") continue;
      if (!(r < rPrime)) continue;
      // day(r) <= day(r'). ISO dates compare correctly as strings.
      if (earlier.ymd > later.ymd) {
        out.push(
          finding(
            "round_order_day",
            constraints,
            [earlier.fixture.fixtureId, later.fixture.fixtureId],
            `round ${r} (${earlier.fixture.fixtureId}) is on ${earlier.ymd}, after round ${rPrime} (${later.fixture.fixtureId}) on ${later.ymd}`,
          ),
        );
        continue;
      }
      // ...and on the same day, start(r) <= start(r'). `>` and not `>=`, so
      // two rounds sharing a start are legal.
      if (earlier.ymd === later.ymd && earlier.start > later.start) {
        out.push(
          finding(
            "round_order_same_day",
            constraints,
            [earlier.fixture.fixtureId, later.fixture.fixtureId],
            `round ${r} (${earlier.fixture.fixtureId}) starts at ${localLabel(earlier)}, after round ${rPrime} (${later.fixture.fixtureId}) at ${localLabel(later)} on the same day`,
          ),
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// checkBoard
// ---------------------------------------------------------------------------

/** Judges one division's board against the oracle `board.ts` encoded from its
 *  pack. Pure; the same two arguments always give the same report.
 *
 *  `unchecked` is `constraints.unmodelled` FORWARDED — never a second list
 *  composed here. `board.ts` is the one authority on what this build does not
 *  model, and a checker that composed its own would let the two disagree
 *  exactly where a reader most needs them to agree. It never makes a report
 *  dirty: it is rendered BESIDE the verdict so "checker clean" cannot be read
 *  as "every declared constraint was verified" (design §1.4/§3.3).
 *
 *  `clean` is this module's own verdict and `judgeDivision` never re-derives
 *  it, so it is set from the findings here and nowhere else. */
export function checkBoard(board: Board, constraints: EncodedConstraints): CheckerReport {
  const placed = placedFixtures(board, constraints);

  const findings: CheckerFinding[] = [
    ...courtDoubleBooking(placed, constraints),
    ...windowContainment(placed, board, constraints),
    ...restMinima(placed, constraints),
    ...dayCaps(placed, constraints),
    ...pinIntegrity(board, constraints),
    ...officials(placed, constraints),
    ...roundOrder(placed, constraints),
  ];

  return {
    findings,
    unchecked: constraints.unmodelled,
    clean: findings.length === 0,
  };
}
