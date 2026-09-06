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

const GAME_UNIT_SPORTS = new Set(["badminton", "tabletennis"]);

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

export function disciplineList(summary: unknown): DisciplineEntry[] | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { discipline?: unknown }).discipline;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: DisciplineEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { side, person, classKey } = entry as Record<string, unknown>;
    if ((side !== "home" && side !== "away") || typeof classKey !== "string") return null;
    rows.push({
      side,
      classKey,
      ...(typeof person === "string" ? { person } : {}),
    });
  }
  return rows;
}

/** Which side is serving (nested kernel, rally fidelity) — null otherwise. */
export function servingSide(summary: unknown): "home" | "away" | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const serving = (detail as { serving?: unknown }).serving;
  return serving === "home" || serving === "away" ? serving : null;
}

/** Human label for a discipline class key: "double_minor" → "Double minor". */
export function disciplineLabel(classKey: string): string {
  const label = classKey.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
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
    (draft|published|live|completed|archived). */
export type CompetitionChip = "on-now" | "finished" | "upcoming";
export function competitionChip(status: string): CompetitionChip {
  if (status === "live") return "on-now";
  if (status === "completed" || status === "archived") return "finished";
  return "upcoming";
}

/** i18n dictionary key for a competition's status chip label (v5 i18n §4). Pure
 *  (no i18n import) so this module stays client-safe; the server page resolves
 *  it via t(dict, chipLabelKey(status)). */
export function chipLabelKey(
  status: string,
): "chip.onNow" | "chip.finished" | "chip.upcoming" {
  const chip = competitionChip(status);
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
 * would otherwise render identically. Never empty.
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
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length > 0 && !out.includes(s)) out.push(s);
  };
  add(surname.slice(0, 3));
  if (words.length > 1) add(`${first.slice(0, 1)}${surname.slice(0, 2)}`);
  add(surname.slice(0, 4));
  if (words.length > 1) add(`${first.slice(0, 2)}${surname.slice(0, 2)}`);
  add(words.join("").slice(0, 3));
  add(surname);
  add(words.join(""));
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
  const lastA = candsA[candsA.length - 1]!;
  const lastB = candsB[candsB.length - 1]!;
  return [`${lastA}1`, `${lastB}2`];
}
