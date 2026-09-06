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
// `not_before_breached` / `not_after_breached` are deliberately ABSENT from
// this list: the product collapses both into one `instruction_time` kind with
// a `ruleType` field (`calendar.ts:1531`), so there is no token to share and
// pinning them here would assert a correspondence that does not exist.
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
// T7b — the modelled-but-unexercised direction (`CheckerReport.unexercised`)
//
// `RuleResult` is what every rule below returns instead of a bare
// `CheckerFinding[]`: `exercised` travels WITH the findings, set from inside
// the SAME loop that decides them, never from a table of preconditions read
// beside the rule (`board.ts`'s own note on this — a second copy of "is this
// input non-empty" drifts from what the rule actually iterates the moment
// either one changes). Rule 2 returns three flags instead of one, because its
// three operands (session windows, blackouts, court hours) can each be
// vacuous independently — task brief's own granularity requirement.
// ---------------------------------------------------------------------------

interface RuleResult {
  findings: CheckerFinding[];
  /** True iff the rule's own loop reached at least one genuine candidate
   *  comparison — a real declared constraint measured against a real placed
   *  fixture — regardless of whether that comparison produced a finding. */
  exercised: boolean;
}

// ---------------------------------------------------------------------------
// Rule 1 — court double-booking
// ---------------------------------------------------------------------------

function courtDoubleBooking(
  placed: readonly Placed[],
  constraints: EncodedConstraints,
): RuleResult {
  const out: CheckerFinding[] = [];
  let exercised = false;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      const court = a.fixture.courtId;
      // An unplaced-on-a-court fixture cannot double-book: `undefined ===
      // undefined` would pair every court-less fixture with every other.
      if (court === undefined || court !== b.fixture.courtId) continue;
      // Reaching here IS the candidate: two placed fixtures genuinely share a
      // court, so this pair is a real occupancy comparison whether or not it
      // turns out to overlap.
      exercised = true;
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
  return { findings: out, exercised };
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

/** `windowContainment`'s three operands, each independently exercisable —
 *  never collapsed into one flag (task T7b's granularity requirement: all
 *  three were independently vacuous on `_tiny` before the sibling task, and a
 *  single verdict for "rule 2" would have reported it exercised because ONE
 *  of the three had input). */
interface WindowResult {
  findings: CheckerFinding[];
  sessionWindowsExercised: boolean;
  blackoutsExercised: boolean;
  courtHoursExercised: boolean;
}

function windowContainment(
  placed: readonly Placed[],
  board: Board,
  constraints: EncodedConstraints,
): WindowResult {
  const out: CheckerFinding[] = [];
  const courtById = new Map(board.courts.map((c) => [c.courtId, c]));
  const durationMinutes = constraints.matchMinutes;
  let sessionWindowsExercised = false;
  let blackoutsExercised = false;
  let courtHoursExercised = false;

  for (const p of placed) {
    const id = p.fixture.fixtureId;

    // --- blackouts -------------------------------------------------------
    // An entry with no `courtId` is GLOBAL — the semantics `board.ts` and
    // `court-windows.ts` both state — so the court test is a MATCH, never a
    // requirement.
    for (const blackout of constraints.blackouts) {
      // Reaching this line at all means `constraints.blackouts` is non-empty
      // AND a fixture was placed to test it against — the genuine candidate,
      // regardless of whether it turns out to apply to THIS fixture's court.
      blackoutsExercised = true;
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
      // The SAME condition that already gates this rule's own findings —
      // reused, not restated, so the two cannot drift apart.
      sessionWindowsExercised = true;
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
    //
    // The two ways a fixture can arrive here with no calendar are DIFFERENT
    // facts and are answered differently, which is why they are separate
    // branches rather than one `court !== undefined` gate. They used to be
    // one, and it silently skipped the entire rule for both.
    //
    //   * NO `courtId` at all -> skip, deliberately. `board.ts` sets the
    //     field only when the product's `fixture.court_id` is a string, so a
    //     fixture given a time and no court is an answer the product
    //     genuinely returns. There is no calendar to judge it against and
    //     inventing a breach here would file a FALSE product defect — the
    //     worst output a harness like this can produce.
    //   * A `courtId` naming no `BoardCourt` -> a FINDING. Both sides of this
    //     reference came from the product, as two separate fetches that must
    //     agree, so a fixture pointing outside the venue set is an
    //     inconsistency in the answer itself. Skipping it was design §1.4's
    //     forbidden outcome reached with no malformed input at all: the
    //     fixture was measured against no calendar and the division still
    //     came back clean. It matters more here than anywhere else in this
    //     function because court-hours containment is a rule the product's
    //     own `/validate` does not block on, so the bench is its only gate.
    const courtId = p.fixture.courtId;
    if (courtId !== undefined && courtById.get(courtId) === undefined) {
      out.push(
        finding(
          "court_not_declared",
          constraints,
          [id],
          `${id} at ${localLabel(p)} is placed on court ${courtId}, which is in none of the ${board.courts.length} court(s) this board declares — its hours could not be checked at all`,
        ),
      );
    }
    const court = courtId === undefined ? undefined : courtById.get(courtId);
    if (court !== undefined) {
      const ranges = courtRangesOn(court, p.ymd, p.weekday);
      if (ranges !== "open_all_day") {
        // "open_all_day" IS "a court with no hours [for this date]" — exactly
        // the zero-candidate case task T7b names. Reaching past it means a
        // real calendar (weekly hours or a dated exception) was found and
        // genuinely measured against this fixture.
        courtHoursExercised = true;
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
  return { findings: out, sessionWindowsExercised, blackoutsExercised, courtHoursExercised };
}

// ---------------------------------------------------------------------------
// Rule 3 — rest minima
//
// ONE rest rule, not two. `perEntrantMinRest` is a division knob
// (`schemas.ts:1303`) keyed on `entrantIds`, which the product's `Fixture`
// genuinely carries (`home_entrant_id` / `away_entrant_id`) — so it is
// measurable and it is checked here. The `min_rest_minutes` HARD rule is a
// different constraint keyed on PERSONS or on feeder edges, neither of which
// reaches a `Board`; `board.ts` reports every one of them in `unmodelled[]`
// and none reaches `EncodedHardRule`, so there is deliberately no branch for
// it here. Neither rule stands in for the other, and substituting the entrant
// series for the person one would measure something nobody declared.
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
): RuleResult {
  // The SAME guard that already gates this rule's findings — reused for
  // `exercised` rather than restated, so the two cannot drift.
  if (requiredMinutes <= 0) return { findings: [], exercised: false };
  const ordered = [...series].sort((a, b) => a.start - b.start || a.index - b.index);
  const out: CheckerFinding[] = [];
  let exercised = false;
  for (let i = 1; i < ordered.length; i += 1) {
    // A real floor AND a genuine consecutive pair to measure it against — the
    // candidate, whether or not the gap turns out to be short.
    exercised = true;
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
  return { findings: out, exercised };
}

function restMinima(placed: readonly Placed[], constraints: EncodedConstraints): RuleResult {
  const out: CheckerFinding[] = [];
  let exercised = false;

  // The top-level floor: per ENTRANT, unscoped — it is a division knob
  // (`schemas.ts:1303`), not a `HardConstraint`.
  const byEntrant = groupBy(placed, (p) => p.fixture.entrantIds);
  for (const [entrantId, series] of byEntrant) {
    const r = restBreaches(
      series,
      constraints.perEntrantMinRest,
      (a, b, measured) =>
        `entrant ${entrantId} rests ${measured}m between ${a.fixture.fixtureId} (${localLabel(a)}) and ${b.fixture.fixtureId} (${localLabel(b)}), below perEntrantMinRest`,
      constraints,
    );
    out.push(...r.findings);
    if (r.exercised) exercised = true;
  }

  return { findings: out, exercised };
}

// ---------------------------------------------------------------------------
// Rule 4 — day caps
// ---------------------------------------------------------------------------

function dayCaps(placed: readonly Placed[], constraints: EncodedConstraints): RuleResult {
  const out: CheckerFinding[] = [];
  let exercised = false;
  for (const rule of constraints.hard) {
    if (rule.type !== "max_fixtures_per_day") continue;
    // The day is the LOCAL civil date, not a rolling 24 hours: "two matches a
    // day" is a calendar claim, and a rolling window would red a legal
    // Monday-evening / Tuesday-morning pair.
    const buckets = groupBy(placed, (p) => tallyKeys(p.fixture, rule.scope).map((k) => `${k}@${p.ymd}`));
    for (const [bucket, group] of buckets) {
      // A bucket existing at all means a real `max_fixtures_per_day` rule
      // matched a placed fixture's scope on some day — the candidate,
      // whether or not the count is actually over.
      exercised = true;
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
  return { findings: out, exercised };
}

// ---------------------------------------------------------------------------
// Rule 5 — wall-clock bounds (`not_before` / `not_after`)
// ---------------------------------------------------------------------------

/** The two `HardConstraint` members that bound a fixture's LOCAL START.
 *
 *  Three semantics taken from the product rather than invented, because a
 *  checker that disagrees with the placer here reds boards the product's own
 *  gate accepts — and `calendar.ts:747-750` says so in as many words ("an
 *  off-by-one here would place boards the gate then refuses"):
 *
 *   1. BOTH BOUNDS ARE ON THE START, never the end (`calendar.ts:1527-1531`
 *      reads `hhmmInTz(a.startAt, tz)` and compares that alone). A 30-minute
 *      match starting exactly at a `not_after` of 11:00 finishes at 11:30 and
 *      is LEGAL. That is not an oversight to fix here.
 *   2. THE COMPARISON IS STRICT — `start < time` and `start > time` — so a
 *      start landing exactly ON the bound is legal to both the placer and the
 *      verifier.
 *   3. THE CLOCK IS A WALL CLOCK IN THE BOARD'S ZONE, never the instant and
 *      never the host's zone (`constraints.ts:56`; `board.ts`'s convention 1).
 *      `EncodedHardRule` already carries `minutesIntoDay`, so the units match
 *      by construction and the only remaining job is to read the fixture's own
 *      local clock — which `civil()` does through `Intl` with the board's zone,
 *      DST included.
 *
 *  Scope goes through `tallyKeys`, NOT a second hand-rolled predicate. These
 *  rules count nothing, so coverage is "the fixture produces at least one key"
 *  — which is exactly `scopeCoversFixture`'s answer — and routing it through
 *  the same function is what stops the universal/entity distinction being lost
 *  in a place where it is easy to write `scope.kind === "competition"` and mean
 *  it. One finding per covered fixture, never one per key: `every_entrant`
 *  yields a key per entrant and the fixture still breaches only once. */
function wallClockBounds(placed: readonly Placed[], constraints: EncodedConstraints): RuleResult {
  const out: CheckerFinding[] = [];
  let exercised = false;
  for (const rule of constraints.hard) {
    if (rule.type !== "not_before" && rule.type !== "not_after") continue;
    for (const p of placed) {
      if (tallyKeys(p.fixture, rule.scope).length === 0) continue;
      // A real not_before/not_after rule covers this placed fixture — the
      // candidate, whether or not its start actually breaches the bound.
      exercised = true;
      const breached =
        rule.type === "not_before"
          ? p.startMinutes < rule.minutesIntoDay
          : p.startMinutes > rule.minutesIntoDay;
      if (!breached) continue;
      out.push(
        finding(
          rule.type === "not_before" ? "not_before_breached" : "not_after_breached",
          constraints,
          [p.fixture.fixtureId],
          `${p.fixture.fixtureId} starts at ${localLabel(p)} (${p.startMinutes} minutes into the day, ${p.ymd}), breaching a ${rule.type} of ${rule.minutesIntoDay} minutes scoped ${rule.scope.kind}`,
          p.startMinutes,
          rule.minutesIntoDay,
        ),
      );
    }
  }
  return { findings: out, exercised };
}

// ---------------------------------------------------------------------------
// Rule 6 — pin integrity
// ---------------------------------------------------------------------------

function pinIntegrity(board: Board, constraints: EncodedConstraints): RuleResult {
  const out: CheckerFinding[] = [];
  let exercised = false;
  const byId = new Map(board.fixtures.map((f) => [f.fixtureId, f]));
  for (const pin of constraints.pins) {
    // A declared pin IS the candidate: the rule's whole job is to verify each
    // one, whether or not it moved.
    exercised = true;
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
  return { findings: out, exercised };
}

// ---------------------------------------------------------------------------
// Rule 7 — officials
// ---------------------------------------------------------------------------

/** NO PER-ELEMENT SHAPE GUARD, deliberately (ruling R21).
 *
 *  `Fixture.officials` is `z.array(z.unknown())` at the WIRE, and that is
 *  `schedule.ts`'s side of the boundary: by the time a `BoardFixture` exists
 *  the field is `readonly string[]`, produced by bench code and consumed by
 *  bench code. A per-element `typeof entry === "string"` check here could only
 *  ever be witnessed by a test that casts a number into the array itself — a
 *  guard nothing real can kill, with a test implying it fires. It was written,
 *  reviewed, and removed; the shape work belongs where the `unknown[]` is.
 *
 *  What survives is the check that CAN fail on a real board: a division whose
 *  pack declared officials and whose fetch returned none. */
function officials(placed: readonly Placed[], constraints: EncodedConstraints): RuleResult {
  const out: CheckerFinding[] = [];

  // Design §4.3's other half, and the reason this rule can fail at all: a
  // division whose PACK declared officials and whose board fetched none is not
  // a division with no officials — it is a fetch that returned nothing, and an
  // empty array makes every "no official is double-booked" test below pass
  // forever. Only red when something WAS placed: a division with no placed
  // fixtures is Task 4's unplaced gate, not this one's.
  //
  // The SAME boolean also settles `exercised` (T7b) — reused, not restated:
  // officials input is genuine only when the pack declared some AND
  // something was placed to check them against, which is exactly what this
  // rule's own findings-gate already reads.
  const hasOfficialsInput = constraints.declaresOfficials && placed.length > 0;
  if (hasOfficialsInput) {
    const anyOfficial = placed.some((p) => p.fixture.officialIds.length > 0);
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
      const shared = a.fixture.officialIds.filter((id) => b.fixture.officialIds.includes(id));
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
  return { findings: out, exercised: hasOfficialsInput };
}

// ---------------------------------------------------------------------------
// Rule 8 — round order
// ---------------------------------------------------------------------------

/** Round-robin ONLY. `ConstraintScope` deliberately carries no `round` member
 *  (`constraints.ts`'s note): an elimination bracket numbers sparsely
 *  (1,2,3 winners / 7-10 losers / 14 grand final), so ordering rounds there
 *  would address the wrong fixtures. `isRoundRobin` is the gate, and a test
 *  runs the disordered board through it with the flag off. */
function roundOrder(placed: readonly Placed[], constraints: EncodedConstraints): RuleResult {
  if (!constraints.isRoundRobin) return { findings: [], exercised: false };
  const out: CheckerFinding[] = [];
  let exercised = false;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = 0; j < placed.length; j += 1) {
      if (i === j) continue;
      const earlier = placed[i];
      const later = placed[j];
      const r = earlier.fixture.roundNo;
      const rPrime = later.fixture.roundNo;
      if (typeof r !== "number" || typeof rPrime !== "number") continue;
      if (!(r < rPrime)) continue;
      // A genuine, comparable round pair — the candidate this rule judges,
      // whether or not the two ever land out of order.
      exercised = true;
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
  return { findings: out, exercised };
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
 *  `unexercised` (task T7b) is the opposite direction, and IS composed here —
 *  it is a CHECK-time fact (did this run's board give a MODELLED rule any
 *  candidate to judge?), not an encode-time one, so `board.ts` has nothing to
 *  forward. Every rule function above returns its own `exercised` flag,
 *  derived from its own loop rather than from a restated precondition, and
 *  this function only collects them under the label a reader can match to
 *  this file's own section headers. Rule 2's three operands are collected
 *  separately (2a/2b/2c) for the same reason they are checked separately: a
 *  single verdict for "rule 2" would report it exercised because ONE operand
 *  had input.
 *
 *  `clean` is this module's own verdict and `judgeDivision` never re-derives
 *  it, so it is set from the findings here and nowhere else. `unexercised`
 *  never touches it, for the same reason `unchecked` does not: a rule with
 *  nothing to judge is not a violation. */
export function checkBoard(board: Board, constraints: EncodedConstraints): CheckerReport {
  const placed = placedFixtures(board, constraints);

  const rule1 = courtDoubleBooking(placed, constraints);
  const rule2 = windowContainment(placed, board, constraints);
  const rule3 = restMinima(placed, constraints);
  const rule4 = dayCaps(placed, constraints);
  const rule5 = wallClockBounds(placed, constraints);
  const rule6 = pinIntegrity(board, constraints);
  const rule7 = officials(placed, constraints);
  const rule8 = roundOrder(placed, constraints);

  const findings: CheckerFinding[] = [
    ...rule1.findings,
    ...rule2.findings,
    ...rule3.findings,
    ...rule4.findings,
    ...rule5.findings,
    ...rule6.findings,
    ...rule7.findings,
    ...rule8.findings,
  ];

  const unexercised: { rule: string; reason: string }[] = [];
  const note = (exercised: boolean, rule: string, reason: string): void => {
    if (!exercised) unexercised.push({ rule, reason });
  };
  note(
    rule1.exercised,
    "Rule 1 — court double-booking",
    "no two placed fixtures share a court to compare for overlap",
  );
  note(
    rule2.sessionWindowsExercised,
    "Rule 2a — session windows",
    "sessionWindows is empty, or nothing was placed — no window was available to contain a fixture within",
  );
  note(
    rule2.blackoutsExercised,
    "Rule 2b — blackouts",
    "blackouts is empty, or nothing was placed — no blackout was available to test a placed fixture against",
  );
  note(
    rule2.courtHoursExercised,
    "Rule 2c — court hours",
    "every placed fixture's court declared no hours or exceptions for its date (or nothing was placed) — every court read as open all day",
  );
  note(
    rule3.exercised,
    "Rule 3 — rest minima",
    "perEntrantMinRest is 0, or no entrant played two or more placed fixtures to measure a gap between",
  );
  note(
    rule4.exercised,
    "Rule 4 — day caps",
    "no max_fixtures_per_day hard rule matched a placed fixture's scope on any day",
  );
  note(
    rule5.exercised,
    "Rule 5 — not_before / not_after",
    "no not_before/not_after hard rule matched a placed fixture's scope",
  );
  note(
    rule6.exercised,
    "Rule 6 — pin integrity",
    "pins is empty — no pin was declared for this rule to verify",
  );
  note(
    rule7.exercised,
    "Rule 7 — officials",
    "the pack did not declare officials for this division, or nothing was placed",
  );
  note(
    rule8.exercised,
    "Rule 8 — round order",
    "isRoundRobin is false, or no two placed fixtures had a comparable round number",
  );

  return {
    findings,
    unchecked: constraints.unmodelled,
    unexercised,
    clean: findings.length === 0,
  };
}
