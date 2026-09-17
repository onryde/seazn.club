// Pure helpers for the public dashboard (doc 09, PROMPT-12) — no server
// imports so they unit-test without a DB and can ride into client components.

// ---------------------------------------------------------------------------
// Reserved slugs (doc 09 §1): org slugs must never collide with app routes.
// Build-time list = every top-level route of apps/web/src/app plus platform
// names we want to keep. Runtime guard: the (public)/[orgSlug] layout 404s on
// any of these before touching the DB.
// ---------------------------------------------------------------------------
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // existing top-level app routes
  "admin", "api", "dashboard", "engine", "forgot-password", "join", "legal",
  "login", "onboarding", "orgs", "pricing", "reset-password", "settings",
  "t", "tournaments", "use-cases", "verify-email", "score", "my-matches",
  "competitions", "divisions", "fixtures", "people",
  // metadata / static
  "favicon.ico", "robots.txt", "sitemap.xml", "icons", "images", "_next",
  // future-proofing platform names
  "app", "auth", "blog", "docs", "discover", "help", "signup", "register",
  "status", "support", "terms", "privacy", "www",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

// ---------------------------------------------------------------------------
// ICS calendar feed (doc 09 §2: `.ics` per division/entrant). Hand-rolled —
// the format is 20 lines of RFC 5545, not worth a dependency.
// ---------------------------------------------------------------------------
export type IcsEvent = {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
} & (
  | {
      start: Date;
      /** minutes; feeds default to 90 when the sport gives no better figure */
      durationMinutes: number;
    }
  | {
      /** `YYYY-MM-DD` — an all-day VEVENT (RFC 5545 §3.3.4 DATE value type),
       *  for a fixture that exists but has no time yet. Emitted TENTATIVE so
       *  subscribers see it as provisional; it becomes a timed CONFIRMED event
       *  under the SAME UID once scheduled, and therefore updates in place in
       *  calendars people have already subscribed to. DTSTAMP alone can't be
       *  trusted to order that transition — it's derived from the event's own
       *  date, not wall-clock generation time, so it moves BACKWARD whenever a
       *  fixture is scheduled earlier than the placeholder's anchor date.
       *  SEQUENCE (0 tentative → 1 timed, in buildIcs below) is what a
       *  compliant client actually orders revisions by — deterministic, no
       *  clock involved. */
      allDayOn: string;
    }
);

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsDateOnly(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/** The DATE-typed DTEND is exclusive (RFC 5545 §3.6.1), so a single all-day
 *  event ends on the following day. Same date start and end renders as a
 *  zero-length event that several clients drop entirely. */
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// RFC 5545 §3.3.11 TEXT escaping + §3.1 line folding at 75 octets.
export function icsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const utf8Encoder = new TextEncoder();

function octetLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

/** Splits `s` right before the codepoint that would push its UTF-8 encoding
 *  past `budget` octets. Walks whole codepoints (`Array.from`, which
 *  correctly groups a UTF-16 surrogate pair into one entry) rather than
 *  `String#slice`'s UTF-16 indexing, so a multi-octet character (e.g. an
 *  accented Latin letter, 2 octets) or an astral one (a surrogate pair, up
 *  to 4 octets) is never cut in half. Any single codepoint's UTF-8 encoding
 *  is at most 4 octets, so this always advances by at least one codepoint —
 *  no infinite loop even for a budget as small as 4. */
function splitAtOctetBudget(s: string, budget: number): { head: string; tail: string } {
  const codepoints = Array.from(s);
  let bytes = 0;
  let i = 0;
  for (; i < codepoints.length; i++) {
    const next = bytes + octetLength(codepoints[i]!);
    if (next > budget) break;
    bytes = next;
  }
  return { head: codepoints.slice(0, i).join(""), tail: codepoints.slice(i).join("") };
}

/** RFC 5545 §3.1: a content line SHOULD NOT exceed 75 octets (excluding the
 *  line break); a long line folds into CRLF + a single leading SPACE per
 *  continuation. Budgeted here at 74 octets per physical line, matching the
 *  original ASCII-only implementation's threshold. Counts UTF-8 OCTETS, not
 *  `String#length` (UTF-16 code units) — a non-ASCII competition/entrant
 *  name (French, Dutch, …) is exactly the case `.length` undercounts. */
export function foldLine(line: string): string {
  if (octetLength(line) <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  while (octetLength(rest) > 74) {
    const { head, tail } = splitAtOctetBudget(rest, 74);
    parts.push(head);
    rest = " " + tail;
  }
  parts.push(rest);
  return parts.join("\r\n");
}

export function buildIcs(calendarName: string, events: IcsEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//public-dashboard//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calendarName)}`,
  ];
  for (const ev of events) {
    const timing =
      "allDayOn" in ev
        ? [
            `DTSTAMP:${icsDateOnly(ev.allDayOn)}T000000Z`,
            `DTSTART;VALUE=DATE:${icsDateOnly(ev.allDayOn)}`,
            `DTEND;VALUE=DATE:${icsDateOnly(nextDay(ev.allDayOn))}`,
            "STATUS:TENTATIVE",
            "SEQUENCE:0",
          ]
        : [
            `DTSTAMP:${icsDate(ev.start)}`,
            `DTSTART:${icsDate(ev.start)}`,
            `DTEND:${icsDate(new Date(ev.start.getTime() + ev.durationMinutes * 60_000))}`,
            "STATUS:CONFIRMED",
            "SEQUENCE:1",
          ];
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}@seazn.club`,
      ...timing,
      `SUMMARY:${icsText(ev.summary)}`,
      ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
      ...(ev.description ? [`DESCRIPTION:${icsText(ev.description)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// JSON-LD (SportsEvent on fixture pages — doc 09 §3). Serialised with `<`
// escaped so the payload can never close its own <script> tag.
// ---------------------------------------------------------------------------
export interface SportsEventJsonLd {
  name: string;
  startDate?: string;
  location?: string;
  url: string;
  homeTeam?: string;
  awayTeam?: string;
  eventStatus: "EventScheduled" | "EventCompleted" | "EventCancelled";
}

export function sportsEventJsonLd(input: SportsEventJsonLd): string {
  const payload = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: input.name,
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.location ? { location: { "@type": "Place", name: input.location } } : {}),
    url: input.url,
    ...(input.homeTeam ? { homeTeam: { "@type": "SportsTeam", name: input.homeTeam } } : {}),
    ...(input.awayTeam ? { awayTeam: { "@type": "SportsTeam", name: input.awayTeam } } : {}),
    eventStatus: `https://schema.org/${input.eventStatus}`,
  };
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Standings columns — MetricSpec-driven (doc 09 §2, zero per-sport UI code).
// Structural columns + the module's display metrics + cascade-derived columns.
// A metric column is hidden when no row carries the key (e.g. a Buchholz
// column before the first Swiss ranking ran).
// ---------------------------------------------------------------------------
export interface MetricSpecLike {
  key: string;
  label: string;
  decimals?: number;
  display?: boolean;
}

export interface StandingsRowLike {
  entrantId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics: Record<string, number>;
  rank?: number;
  tieBreak?: { key: string; with: string[] };
}

export interface StandingsColumn {
  key: string; // 'played' | 'won' | … | metric key | derived cascade key
  label: string;
  kind: "structural" | "metric" | "derived";
  decimals?: number;
}

export function standingsColumns(
  metricSpecs: readonly MetricSpecLike[],
  cascade: readonly string[],
  rows: readonly StandingsRowLike[],
  derivedSpecs: readonly { key: string; label: string; decimals: number }[],
): StandingsColumn[] {
  const hasDraws = rows.some((r) => r.drawn > 0);
  const columns: StandingsColumn[] = [
    { key: "played", label: "P", kind: "structural" },
    { key: "won", label: "W", kind: "structural" },
    ...(hasDraws ? [{ key: "drawn", label: "D", kind: "structural" as const }] : []),
    { key: "lost", label: "L", kind: "structural" },
  ];
  for (const spec of metricSpecs) {
    if (spec.display === false) continue;
    if (!rows.some((r) => spec.key in r.metrics)) continue;
    columns.push({
      key: spec.key,
      label: spec.label,
      kind: "metric",
      ...(spec.decimals !== undefined ? { decimals: spec.decimals } : {}),
    });
  }
  columns.push({ key: "points", label: "Pts", kind: "structural" });
  for (const derived of derivedSpecs) {
    if (!cascade.includes(derived.key)) continue;
    columns.push({ key: derived.key, label: derived.label, kind: "derived", decimals: derived.decimals });
  }
  return columns;
}

export function formatMetric(value: number | undefined, decimals?: number): string {
  if (value === undefined) return "—";
  if (decimals !== undefined) return value.toFixed(decimals);
  return `${value}`;
}

// ---------------------------------------------------------------------------
// Set-based per-set breakdown for the public match page. The set-based kernel
// (engine sports/setbased) puts every set's points in ScoreSummary.detail.sets;
// this extracts them render-ready or returns null for non-set-based sports
// (whose detail carries a different shape, or none).
// ---------------------------------------------------------------------------
export interface SetScore {
  home: number;
  away: number;
  closed: boolean;
}

export interface SetBreakdown {
  /**
   * Task 14c — a DICTIONARY-KEY suffix, not a display word: badminton &
   * table tennis are "game", tennis & volleyball are "set" (never "period"
   * — that's `SetsView.unit`'s own third value, in `match-centre-schema.ts`,
   * a different document this function never sees). The renderer resolves
   * it through `matchCentre.col.<unit>` (column labels) and
   * `matchCentre.unit.<unit>` (the bare word in "Score by {unit}") — same
   * `matchCentre.col.*` family `sets-tab.tsx` already reads off the newer
   * `SetsView.unit`, so this and that document share one translated
   * vocabulary instead of two. Used to be the literal English word
   * ("Game"/"Set") rendered straight into the page in every locale.
   */
  unit: "game" | "set";
  sets: SetScore[];
}

/** The sports whose "set" is called a GAME. Exported since W2: the moment layer
 *  picks GAME POINT over SET POINT from this same set, and a second copy of the
 *  membership is how the two surfaces come to disagree. */
export const GAME_UNIT_SPORTS = new Set(["badminton", "tabletennis"]);

/** The kernel headline carries the open set's points — "1 — 0 (14–11)". The
 *  public match page renders those in the per-set scoreboard card instead, so
 *  it strips the suffix to keep the big scoreline sets-only. */
export function stripLiveSetPoints(headline: string): string {
  return headline.replace(/\s*\([^)]*\)\s*$/, "");
}

export function setBreakdown(summary: unknown, sportKey: string): SetBreakdown | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { sets?: unknown }).sets;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sets: SetScore[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { home, away, closed } = entry as Record<string, unknown>;
    if (typeof home !== "number" || typeof away !== "number") return null;
    sets.push({ home, away, closed: closed === true });
  }
  return { unit: GAME_UNIT_SPORTS.has(sportKey) ? "game" : "set", sets };
}

// ---------------------------------------------------------------------------
// Period-kernel breakdowns (v6/00 §5): goals by period, the strength chip
// while suspensions run, the discipline list, and the serving side (tennis).
// All read ScoreSummary.detail and return null when the sport doesn't carry
// that shape — the surfaces stay sport-agnostic.
// ---------------------------------------------------------------------------

export interface PeriodScoreRow {
  phase: string;
  home: number;
  away: number;
}

export function periodBreakdown(summary: unknown): PeriodScoreRow[] | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { periods?: unknown }).periods;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: PeriodScoreRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { phase, home, away } = entry as Record<string, unknown>;
    if (typeof phase !== "string" || typeof home !== "number" || typeof away !== "number") {
      return null;
    }
    rows.push({ phase, home, away });
  }
  return rows;
}

/** The period kernel's own CURRENT phase token — "P1", "H1", "ET_H2",
 *  "SHOOTOUT" (`sports/period/kernel.ts`'s summary `detail.phase`). A raw
 *  token, never copy: callers resolve it through `term.<phase>` the way
 *  `sets-tab.tsx` already does for its column headers.
 *
 *  Read from `detail.phase` rather than off the engine's `headline`, which
 *  appends the same fact as a " · P1" suffix — parsing that prose back apart
 *  would make this a SECOND authority for something `detail` already states
 *  by name. */
export function matchPhase(summary: unknown): string | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const phase = (detail as { phase?: unknown }).phase;
  return typeof phase === "string" && phase !== "" ? phase : null;
}

/** "5v4" / "10v11" while a team-short suspension runs, else null. */
export function matchStrength(summary: unknown): string | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const strength = (detail as { strength?: unknown }).strength;
  return typeof strength === "string" && strength !== "" ? strength : null;
}

export interface DisciplineEntry {
  side: "home" | "away";
  person?: string;
  classKey: string;
}

/**
 * The cards this fixture has shown, or `null` for "no discipline data".
 *
 * A MALFORMED ROW IS SKIPPED, NOT FATAL (product ruling 2026-09-10, F14 —
 * `_THEMES.md` §2a). This used to `return null` on the first entry it could
 * not parse, throwing away the rows it had already accepted: one bad row from
 * the engine showed NO cards at all, which on screen is indistinguishable from
 * a clean match. Showing two of three cards is strictly better than showing
 * none and looking correct.
 *
 * `null` stays reserved for "nothing to show" — no `discipline` key, an empty
 * list, or a list whose every row is unreadable. It is not merely a nicer
 * empty array: `live-score.tsx:175/351` gates the whole discipline panel on
 * `discipline !== null`, so `[]` paints a heading with no rows under it.
 */
export function disciplineList(summary: unknown): DisciplineEntry[] | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { discipline?: unknown }).discipline;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: DisciplineEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { side, person, classKey } = entry as Record<string, unknown>;
    if ((side !== "home" && side !== "away") || typeof classKey !== "string") continue;
    rows.push({
      side,
      classKey,
      ...(typeof person === "string" ? { person } : {}),
    });
  }
  return rows.length > 0 ? rows : null;
}

/** Which side is serving (nested kernel, rally fidelity) — null otherwise. */
export function servingSide(summary: unknown): "home" | "away" | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const serving = (detail as { serving?: unknown }).serving;
  return serving === "home" || serving === "away" ? serving : null;
}

/**
 * The dictionary key for each discipline class's on-air label — `_THEMES.md`
 * §2a's ten classes (product ruling 2026-09-10, review MINOR 9).
 *
 * KEYED OFF THE CLASS, NEVER OFF THE DERIVED ENGLISH. `disciplineLabel` used
 * to build the label from the class key itself (`replace(/_/g," ")` plus title
 * case), so a French, Spanish or Dutch stream rendered "Bench minor" and "Game
 * misconduct" in English — on the overlay AND on the public match page, which
 * share this reader. F13 did not introduce that; it made five more of these
 * classes visually prominent on a broadcast, which is what turned an old
 * omission into a live one.
 *
 * A STATIC MAP, not `` `overlay.card.${classKey}` ``, for two reasons. The
 * dictionary gate (`lib/__tests__/overlay-dict-coverage.test.ts`) scans for
 * key LITERALS; a template literal would instead register `overlay.card.` as a
 * dynamic prefix and excuse every key under it from the orphan check, turning
 * the gate off for exactly the keys it was added for. And the membership is
 * then a fact this file states, which `overlay-model.test.ts` holds against
 * §2a's own table in both directions — so a class the sheet adds reds until
 * its key exists, which is what "a future class is a missing key rather than a
 * silently-anglicised label" has to mean in practice.
 *
 * `second_yellow` is deliberately absent: it is in `DISCIPLINE_CLASS_TONE` as
 * forward-compatible dead code (football is not a period-kernel sport, so
 * `disciplineList` never yields it) and §2a's table does not name it. It falls
 * through to the derivation below like any undeclared class.
 */
export const DISCIPLINE_LABEL_KEYS: Readonly<Record<string, string>> = {
  // hockey — the sport's own three-card ladder
  green: "overlay.card.green",
  yellow: "overlay.card.yellow",
  red: "overlay.card.red",
  // icehockey — the lesser-penalty family, then the serious one
  minor: "overlay.card.minor",
  bench_minor: "overlay.card.benchMinor",
  double_minor: "overlay.card.doubleMinor",
  major: "overlay.card.major",
  misconduct: "overlay.card.misconduct",
  game_misconduct: "overlay.card.gameMisconduct",
  match: "overlay.card.match",
};

/**
 * Human label for a discipline class key, resolved through the caller's
 * dictionary: `"double_minor"` → "Double minor" / "Double mineure" / …
 *
 * `msg` is REQUIRED rather than optional on purpose — an optional resolver
 * would let a new call site fall back to English silently, which is the defect
 * this signature exists to close. Both call sites already have one in hand:
 * `overlay-model.ts` passes `input.msg`, `live-score.tsx` its `activeDict`.
 *
 * A class no key names falls back to the old derivation rather than putting a
 * raw `overlay.card.…` key on a broadcast graphic. That arm should be
 * unreachable for anything §2a declares, and the test that keeps it so is the
 * both-directions check in `overlay-model.test.ts`, not this function.
 */
export function disciplineLabel(classKey: string, msg: (key: string) => string): string {
  const key = DISCIPLINE_LABEL_KEYS[classKey];
  if (key) return msg(key);
  const label = classKey.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The entrant currently batting: the last innings on the public summary that
 * has not closed. Cricket's `summary().detail.innings[]` is the only shape in
 * the engine with this field set (`sports/cricket/cricket.ts:3306-3316`), so
 * every other sport returns null by construction rather than by a sport check.
 *
 * This is the FIRST authority for "who is in" on the public payload — nothing
 * else derives it — and it lives here, beside `servingSide`, so the overlay
 * and any later spectator surface read one implementation (R5).
 */
export function battingEntrantId(summary: unknown): string | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const last = raw[raw.length - 1];
  if (typeof last !== "object" || last === null) return null;
  const { entrantId, closed } = last as Record<string, unknown>;
  if (closed === true) return null;
  return typeof entrantId === "string" ? entrantId : null;
}

/**
 * Runs still needed by the side batting second, or null when there is no chase
 * in progress. A revised target (DLS, `detail.target`) REPLACES the first
 * innings' total; without one the target is that total plus one.
 *
 * The BALLS half of "Need 45 off 45" is `chaseBalls` below, kept separate so a
 * format with no quota still gets its runs line.
 */
export function chaseNeed(summary: unknown): number | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const first = raw[raw.length - 2];
  const current = raw[raw.length - 1];
  if (typeof first !== "object" || first === null) return null;
  if (typeof current !== "object" || current === null) return null;
  if ((current as Record<string, unknown>).closed === true) return null;
  const chased = (current as Record<string, unknown>).runs;
  if (typeof chased !== "number") return null;
  const revised = (detail as { target?: unknown }).target;
  if (typeof revised === "number") return Math.max(0, revised - chased);
  const set = (first as Record<string, unknown>).runs;
  if (typeof set !== "number") return null;
  return Math.max(0, set + 1 - chased);
}

/**
 * Absolute chase target while a second (or later) innings is open, or null.
 * Same gates as `chaseNeed`: revised `detail.target` wins, else first innings
 * runs + 1. Used by the cricket bar/bug compact strip ("Target 49"), not by
 * the "Need X off Y" line (which keeps needing the remainder).
 */
export function chaseTargetRuns(summary: unknown): number | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const first = raw[raw.length - 2];
  const current = raw[raw.length - 1];
  if (typeof first !== "object" || first === null) return null;
  if (typeof current !== "object" || current === null) return null;
  if ((current as Record<string, unknown>).closed === true) return null;
  const revised = (detail as { target?: unknown }).target;
  if (typeof revised === "number") return revised;
  const set = (first as Record<string, unknown>).runs;
  return typeof set === "number" ? set + 1 : null;
}

/**
 * HOW a chase target was set, or null.
 *
 * `_THEMES.md` §3's cricket row (owner ruling 2026-09-10, "add the DLS hint in
 * W1"): a rain-revised chase that shows new numbers with nothing to say why
 * they moved reads, on a broadcast, as the scoreboard being wrong. The data
 * already arrives — cricket's `summary().detail` emits `targetSource` beside
 * `target` (`packages/engine/src/sports/cricket/cricket.ts:3678-3680`) and the
 * overlay projection passes `summary` through whole — so this is a READER, not
 * a derivation. Nothing here recomputes a target or infers a method.
 *
 * The engine's own type is `"dls" | "manual" | null`, THREE cases, and the two
 * non-null ones are not interchangeable: labelling a manually-agreed target as
 * DLS is a false claim about how it was set. So this names the two methods it
 * knows rather than testing for non-null — an unknown token (a future VJD
 * setting, a bespoke league rule) falls through to null and the line stays
 * unmarked, which is short rather than wrong.
 */
export function chaseTargetSource(summary: unknown): "dls" | "manual" | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const source = (detail as { targetSource?: unknown }).targetSource;
  return source === "dls" || source === "manual" ? source : null;
}

/**
 * Balls still available to the side batting second, or null.
 *
 * The denominator of the line `_THEMES.md` §3 draws — "Need 45 off 45". Both
 * numbers come from the SAME innings entry the overlay endpoint projects off
 * the folded state (Task 0, design §3.2: `OverlayLiveData.cricket.innings[]`),
 * so a DLS revision moves them together and nothing here re-derives a quota
 * from a format name. Whether a chase is in progress is `chaseNeed`'s
 * decision over the summary; the model calls this only when it is.
 *
 * `null`, never a guess, where the format declares no quota (`ballsLimit:
 * null` — timed and unlimited formats, cricket.ts:440): the bar then renders
 * the runs-only line, which is correct rather than short.
 */
export function chaseBalls(
  cricket: { innings: { legalBalls: number; ballsLimit: number | null }[] } | null | undefined,
): number | null {
  if (!cricket || !Array.isArray(cricket.innings) || cricket.innings.length < 2) return null;
  const current = cricket.innings[cricket.innings.length - 1]!;
  if (typeof current.ballsLimit !== "number" || typeof current.legalBalls !== "number") return null;
  return Math.max(0, current.ballsLimit - current.legalBalls);
}

// ---------------------------------------------------------------------------
// Row normalization + spectator vocabulary
// ---------------------------------------------------------------------------

/** postgres.js returns timestamptz columns as Date objects, and RSC hands
    them to client components untouched — where string code (localeCompare
    sorts, slicing) crashes. Normalize to ISO string at the query edge. */
export function isoDateTime(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

/** Spectator-language chip over the competition status vocab
    (draft|published|live|completed|archived), and over what is actually
    happening: `inPlay` is how many of the competition's public fixtures are
    `in_play` right now.

    The in-play rung is FIRST (spectator W2, Task 15). A status is an
    organiser's setting and nothing flips it to `live` when a match starts, so
    the org home used to read "Upcoming" on a competition with a match being
    played (W0 block II). A match in play is on now whatever the status says —
    including `completed`, which an organiser can set before the last match
    is scored. Defaults to 0 so a caller with no fixture count keeps the
    status ladder exactly as it was. */
export type CompetitionChip = "on-now" | "finished" | "upcoming";
export function competitionChip(status: string, inPlay = 0): CompetitionChip {
  if (chipShowsCount(inPlay)) return "on-now";
  if (status === "live") return "on-now";
  if (status === "completed" || status === "archived") return "finished";
  return "upcoming";
}

/** Whether a competition's chip COUNTS its matches in play ("2 live now",
 *  `org.live.one`/`.other`) rather than reading its status label. The chip's
 *  first rung, the org home island's label, and the org home's first tier
 *  (`orgHomeTier`) all read this one predicate. */
export function chipShowsCount(inPlay: number): boolean {
  return inPlay > 0;
}

/** The org home's order tier for one competition (owner ruling 2026-09-17),
 *  read off the chip its card shows:
 *   0 — the chip counts matches in play ("2 live now");
 *   1 — the chip says "On now" with no count: marked `live`, nothing in play;
 *   2 — the rest ("Upcoming", "Finished").
 *  Derived from `chipShowsCount` and `competitionChip`, never a second reading
 *  of the status or the count, so a card can never sit above one whose chip is
 *  livelier. */
export type OrgHomeTier = 0 | 1 | 2;
export function orgHomeTier(status: string, inPlay = 0): OrgHomeTier {
  if (chipShowsCount(inPlay)) return 0;
  if (competitionChip(status, inPlay) === "on-now") return 1;
  return 2;
}

/** The org home's list in tier order (`orgHomeTier`), keeping the INCOMING
 *  order within each tier — the caller hands the rows over in date order
 *  (`listOrgHomeCompetitions`: starts_on desc, undated last, newer row first).
 *  The server sorts the page's rows and the poll's with it, and the island
 *  sorts its cards with it after every poll. Returns a new array. */
export function sortOrgHomeCompetitions<T extends { status: string; in_play: number }>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index, tier: orgHomeTier(row.status, row.in_play) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ row }) => row);
}

/** i18n dictionary key for a competition's status chip label (v5 i18n §4). Pure
 *  (no i18n import) so this module stays client-safe; the server page resolves
 *  it via t(dict, chipLabelKey(status)). */
export function chipLabelKey(
  status: string,
  inPlay = 0,
): "chip.onNow" | "chip.finished" | "chip.upcoming" {
  const chip = competitionChip(status, inPlay);
  return chip === "on-now"
    ? "chip.onNow"
    : chip === "finished"
      ? "chip.finished"
      : "chip.upcoming";
}

// ---------------------------------------------------------------------------
// Match-centre entrant abbreviations (R11 fix round, C9). The court card and
// the timeline/sets-tab chips abbreviate each side to a short label. TEAM
// entrants keep the existing "first three compacted letters of the whole
// name" rule unconditionally (it already disambiguates in practice —
// cricket's BLA/COM — and C9 is scoped to person sports only). PERSON
// entrants collided under that same rule ("Player One"/"Player Two" both
// read "PLA"): `personShortCandidates` prefers the surname instead, and
// `disambiguatedShorts` resolves both sides of a fixture TOGETHER, since a
// single side's name never carries enough information on its own to know it
// needs to widen past its first candidate.
// ---------------------------------------------------------------------------

function compactWord(word: string): string {
  return word.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
}

/**
 * How wide a badge label may be. This is the LADDER's own bound, not the chip's
 * — the chips (`timeline-tab.tsx`'s `SideBadge`, `sets-tab.tsx`'s row badge)
 * size to their content and carry `min-w-[24px]` as a FLOOR, so they have no
 * ceiling for this constant to correspond to. An earlier version of this
 * comment said they were fixed 24x24px boxes that a wider label "spills" out
 * of, and that this constant and their classes "move together"; the round that
 * made the chips content-sized left that standing, so it is stated plainly
 * here: nothing in CSS pins this number any more.
 *
 * What forces 4 is the tie-break below (`disambiguatedShorts`): its terminal
 * shape is `${surname.slice(0, 3)}1` / `…2`, three characters plus an ordinal.
 * A ceiling under 4 would truncate that suffix and stop it disambiguating; a
 * ceiling above it buys nothing the earlier rungs do not already provide, and
 * costs legibility at `text-[10px]`. The ladder's own early rungs happen to
 * land on the same width (`surname.slice(0, 4)`, `first.slice(0, 2) +
 * surname.slice(0, 2)`), which is why 4 reads as derived rather than invented.
 *
 * Moving it is a real change, not a tuning knob: `public-site.test.ts`'s
 * "Ann Smith"/"Anna Smith" case reds at 3, 5 and 6.
 */
export const BADGE_MAX_CHARS = 4;

/** The existing team-style rule, unchanged by C9: first three compacted
 *  letters of the whole name ("Blazers" -> "BLA"). */
export function teamShortOf(name: string): string {
  const compact = compactWord(name);
  return compact.length > 0 ? compact.slice(0, 3) : "?";
}

/**
 * Ordered, increasingly specific abbreviations for a PERSON's name — surname
 * first (how a spectator actually tells two players apart), then initial +
 * surname, widening only as far as needed to disambiguate two entrants that
 * would otherwise render identically. Never empty, and never wider than
 * `BADGE_MAX_CHARS` — see the note on `add`.
 */
export function personShortCandidates(name: string): string[] {
  const words = name
    .trim()
    .split(/\s+/)
    .map(compactWord)
    .filter((w) => w.length > 0);
  if (words.length === 0) return ["?"];
  const surname = words[words.length - 1]!;
  const first = words[0]!;
  // Found by driving the real spectator walkthrough (R11 fix round, C9
  // follow-up): its own fixtures name two entrants "Player One <tag>" /
  // "Player Two <tag>" — SAME first word, SAME last word (a per-run unique
  // suffix), differing only in the middle. Every rung above and below this
  // one collides for that pair, so without a middle-word candidate the
  // ladder fell all the way to the full, untruncated name — far past
  // `BADGE_MAX_CHARS`, and so past the width the badge chips in the
  // Timeline/Sets tabs are legible at. A 3+-word name's middle word(s) are
  // exactly where a shared first-and-last-word pair still differs.
  const middle = words.length > 2 ? words.slice(1, -1).join("") : "";
  const out: string[] = [];
  // EVERY RUNG BELOW STATES ITS OWN WIDTH; the clamp inside `add` is a net
  // under them, not the mechanism that shortens them. That distinction is
  // load-bearing in both directions: remove the per-rung `slice` calls trusting
  // the clamp and the ladder still holds, remove the clamp trusting the rungs
  // and it still holds — but do BOTH and the ladder silently uncaps, with the
  // unit suite green, because no test pins a candidate LIST. The pair to watch
  // is `slice(0, 3)`/`slice(0, 4)` on the rungs against `slice(0,
  // BADGE_MAX_CHARS)` here.
  //
  // The bound exists because a candidate wider than the chip does not
  // disambiguate anything — it renders as overflow whatever it says. Before it,
  // "John Andersen" against "John Anderson" resolved to ANDERSEN/ANDERSON,
  // eight characters, which is longer than AND1/AND2 without being clearer. So
  // the ladder ends at `BADGE_MAX_CHARS`, and a pair that collides through
  // every rung inside it falls to `disambiguatedShorts`'s positional tie-break
  // — honest that the two names are indistinguishable at this width.
  const add = (s: string) => {
    const clamped = s.slice(0, BADGE_MAX_CHARS);
    if (clamped.length > 0 && !out.includes(clamped)) out.push(clamped);
  };
  add(surname.slice(0, 3));
  if (words.length > 1) add(`${first.slice(0, 1)}${surname.slice(0, 2)}`);
  if (middle.length > 0) add(middle.slice(0, 3));
  add(surname.slice(0, 4));
  if (words.length > 1) add(`${first.slice(0, 2)}${surname.slice(0, 2)}`);
  if (middle.length > 0) add(middle.slice(0, 4));
  add(words.join("").slice(0, 3));
  // The ladder used to end with three unclamped rungs — the whole surname, the
  // whole middle, the whole compacted name. Clamping `add` made the first two
  // of those exact duplicates of `surname.slice(0, 4)` and `middle.slice(0, 4)`
  // above, so they pushed nothing at all (0 pushes across 300k generated names
  // when the re-review measured it); they are gone rather than left as rungs
  // that read like they still widen something. The third is genuinely distinct
  // — a compacted whole name is not a prefix of any single word — and is kept,
  // written at its real width.
  add(words.join("").slice(0, BADGE_MAX_CHARS));
  return out.length > 0 ? out : ["?"];
}

/**
 * The two sides' court-card abbreviations, resolved TOGETHER: a collision on
 * one side can only be seen — and broken — by comparing both at once. Team
 * sides keep today's fixed rule unconditionally (out of C9's scope: "team
 * entrants keep today's behaviour where it already disambiguates"); a person
 * side widens through its own candidate ladder until it differs from the
 * other side. If every candidate is exhausted and the two sides are STILL
 * equal — the two entrants share the exact same full name, letter for
 * letter — a positional tie-break keeps the invariant "never equal" intact
 * even then (still built from each side's own candidate, just no longer
 * unique to it).
 */
export function disambiguatedShorts(
  a: { name: string; isPerson: boolean },
  b: { name: string; isPerson: boolean },
): [string, string] {
  if (!a.isPerson && !b.isPerson) return [teamShortOf(a.name), teamShortOf(b.name)];
  const candsA = a.isPerson ? personShortCandidates(a.name) : [teamShortOf(a.name)];
  const candsB = b.isPerson ? personShortCandidates(b.name) : [teamShortOf(b.name)];
  const rungs = Math.max(candsA.length, candsB.length);
  for (let i = 0; i < rungs; i++) {
    const candA = candsA[Math.min(i, candsA.length - 1)]!;
    const candB = candsB[Math.min(i, candsB.length - 1)]!;
    if (candA !== candB) return [candA, candB];
  }
  // The tie-break is built from each side's FIRST (shortest) candidate, never
  // its last. The last rung is the full compacted name by construction, so
  // `${last}1` produced a 10-character label like "JOHNSMITH1" for two
  // entrants genuinely called the same thing — a label no badge chip is
  // legible at, and the exact defect the C9 follow-up rung exists to prevent.
  // Every first candidate is at most three characters (`surname.slice(0, 3)`,
  // or `teamShortOf`), so the suffixed label is at most four. THIS SHAPE IS
  // WHAT SETS `BADGE_MAX_CHARS`: three plus an ordinal. The two must move
  // together — a smaller ceiling truncates the ordinal away and the tie-break
  // stops disambiguating.
  const firstA = candsA[0]!;
  const firstB = candsB[0]!;
  return [`${firstA}1`, `${firstB}2`];
}
