/**
 * Zone-split fixture instants for competition-desk.spec.ts.
 *
 * Not a spec — Playwright's default `testMatch` only collects
 * `**\/*.@(spec|test).?(c|m)[jt]s?(x)`, so this is an ordinary module a spec
 * may import. It lives outside the spec so its totality can be SWEPT: see
 * `sweepZoneSplitFinders` below, which the desk spec runs as a test of its own.
 *
 * ── J1 (fix round F, Critical) ────────────────────────────────────────────
 * Round E's `findBucketSplitInstant` PINNED one ordering — org `Europe/London`,
 * venue `Asia/Kolkata` — and asked for an instant that is "still today at the
 * venue but a different calendar day for the org". With the VENUE ahead, the
 * venue's midnight always arrives first, so that instant exists only between
 * the org's midnight and the venue's: a ~4.5h window (18:30Z–22:59Z in BST).
 * Swept hourly across 2026, 7145 of 8760 samples returned nothing and the
 * helper threw. The desk e2e was 9 passed / 1 failed for ~81% of the day, and
 * a green run inside the window was reported as a fact about the suite.
 *
 * A test whose fixture can only be CONSTRUCTED during part of the day is a
 * scheduled outage, not a test. So the ordering is chosen at RUNTIME: the
 * search runs over BOTH orderings of the same two zones and takes the first
 * that yields an instant. That is total by construction, not by luck —
 * writing A for the zone whose next local midnight comes sooner in UTC, the
 * bucket property holds exactly when org = A, and A is one of the two zones
 * at every instant. (The one shape that could still fail is two zones whose
 * next midnights coincide, i.e. equal UTC offsets — London and Kolkata are
 * 4.5h/5.5h apart and never coincide.) `sweepZoneSplitFinders` proves it
 * rather than asserting it.
 */

const MINUTE_MS = 60_000;

/** Intl formatters are expensive to construct and immutable once built; the
 *  sweep makes millions of calls, so they are cached per zone. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD in a zone — matches division-phase.ts's own `localDateKey`. */
export function zoneDateKey(date: Date, tz: string): string {
  let fmt = FORMATTERS.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    FORMATTERS.set(tz, fmt);
  }
  return fmt.format(date);
}

export interface ZoneSplit {
  /** The fixture instant to seed. */
  at: Date;
  /** `organizations.timezone` to seed for the split to exist. */
  orgTz: string;
  /** `schedule_settings.tz` (the venue/display zone) to seed. */
  venueTz: string;
}

/** Both orderings of one pair of zones, so whichever way round the property
 *  needs them today, one of these is it. Kolkata is UTC+5:30 year-round and
 *  London is +0/+1, so their local midnights are 4.5h or 5.5h apart in UTC
 *  and never coincide — which is the condition totality rests on. */
const BUCKET_PAIRS: readonly { orgTz: string; venueTz: string }[] = [
  { orgTz: "Europe/London", venueTz: "Asia/Kolkata" },
  { orgTz: "Asia/Kolkata", venueTz: "Europe/London" },
];

/** Same, for the print split. New York is UTC-5/-4, London +0/+1 — 4h or 5h
 *  apart, and likewise never coincident. */
const PRINT_PAIRS: readonly { orgTz: string; venueTz: string }[] = [
  { orgTz: "Europe/London", venueTz: "America/New_York" },
  { orgTz: "America/New_York", venueTz: "Europe/London" },
];

/**
 * An instant that is STILL TODAY at the venue but a DIFFERENT day for the org
 * — the shape H1's bucketing fix needs: `match_day` must key off the venue's
 * calendar day, not the org's. Picking `at` equal to `now` itself cannot
 * discriminate (any instant trivially agrees with itself in every zone), so
 * this searches forward from `now` for a genuinely divergent one.
 */
function searchBucketSplit(from: Date, orgTz: string, venueTz: string): Date | null {
  const todayOrg = zoneDateKey(from, orgTz);
  const todayVenue = zoneDateKey(from, venueTz);
  for (let mins = 5; mins <= 60 * 24 * 2; mins += 5) {
    const candidate = new Date(from.getTime() + mins * MINUTE_MS);
    // The venue's calendar day only ever moves FORWARD, so once a candidate
    // has left `todayVenue` no later one returns to it: the scan is finished,
    // not merely unlucky. Bailing here is what makes the dead ordering cheap
    // enough for `sweepZoneSplitFinders` to cover a whole year — and it is a
    // provable equivalence, not a heuristic cutoff.
    if (zoneDateKey(candidate, venueTz) !== todayVenue) return null;
    if (zoneDateKey(candidate, orgTz) !== todayOrg) return candidate;
  }
  return null;
}

/**
 * A future instant where org and venue format to DIFFERENT calendar days —
 * the shape H1's printing fix (G2) needs, masthead and row both reading the
 * venue's day.
 *
 * Two conditions, not one. The obvious search — "first instant where the two
 * zones disagree on the day" — returns something a few hours out, which is
 * TODAY at the venue, and the ladder answers `match_day` before it ever
 * reaches its date step. The masthead then reads "Match day" and the test
 * fails against correct code. Existence is not behaviour when branch ORDER
 * decides the outcome: the instant must also be on a LATER venue day, so the
 * date step is the branch under test.
 */
function searchPrintSplit(from: Date, orgTz: string, venueTz: string): Date | null {
  const venueToday = zoneDateKey(from, venueTz);
  for (let mins = 15; mins <= 60 * 24 * 8; mins += 15) {
    const candidate = new Date(from.getTime() + mins * MINUTE_MS);
    const venueKey = zoneDateKey(candidate, venueTz);
    const splits = zoneDateKey(candidate, orgTz) !== venueKey;
    const notToday = venueKey !== venueToday;
    if (splits && notToday) return candidate;
  }
  return null;
}

function firstSplit(
  from: Date,
  pairs: readonly { orgTz: string; venueTz: string }[],
  search: (from: Date, orgTz: string, venueTz: string) => Date | null,
  what: string,
): ZoneSplit {
  for (const { orgTz, venueTz } of pairs) {
    const at = search(from, orgTz, venueTz);
    if (at !== null) return { at, orgTz, venueTz };
  }
  throw new Error(
    `${what}: no zone split found from ${from.toISOString()} in EITHER ordering of ` +
      pairs.map((p) => `${p.orgTz}/${p.venueTz}`).join(" or ") +
      " — see zone-split.ts's totality argument, which this contradicts",
  );
}

/** The bucketing fixture: which zone pair, and the instant, for `from`. */
export function findBucketSplit(from: Date): ZoneSplit {
  return firstSplit(from, BUCKET_PAIRS, searchBucketSplit, "findBucketSplit");
}

/** The printing fixture: which zone pair, and the instant, for `from`. */
export function findPrintSplit(from: Date): ZoneSplit {
  return firstSplit(from, PRINT_PAIRS, searchPrintSplit, "findPrintSplit");
}

export interface SweepResult {
  samples: number;
  failures: { at: string }[];
}

/**
 * Walk `from` in `stepMinutes` increments to `to` and call every finder at
 * each one. A finder that throws for ANY sample is a suite that only works
 * part of the day — the exact defect J1 records. Returns the failures rather
 * than asserting, so the caller can print them.
 */
export function sweepZoneSplitFinders(from: Date, to: Date, stepMinutes: number): Record<string, SweepResult> {
  const out: Record<string, SweepResult> = {};
  for (const [name, find] of Object.entries({ findBucketSplit, findPrintSplit })) {
    const failures: { at: string }[] = [];
    let samples = 0;
    for (let t = from.getTime(); t < to.getTime(); t += stepMinutes * MINUTE_MS) {
      samples++;
      const now = new Date(t);
      try {
        const split = find(now);
        // A finder that returns an instant it was not asked for is worse than
        // one that returns none: the test would seed a fixture that does not
        // exhibit the property and pass for the wrong reason.
        if (split.at.getTime() <= now.getTime()) failures.push({ at: now.toISOString() });
      } catch {
        failures.push({ at: now.toISOString() });
      }
    }
    out[name] = { samples, failures };
  }
  return out;
}
