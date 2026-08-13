// SPEC-2 / PROMPT-82 — auto-draft body templates. PURE functions (no DB, no
// I/O): the decided-seam hook in org-posts.ts extracts the fixture/standings
// data and calls these to build the {title, bodyMd} of a draft post. Post
// CONTENT is org-authored and never machine-translated (SPEC-2 gotcha), so
// these render once in the org's locale AT DRAFT TIME and the strings freeze
// into body_md — hence a small inline locale table here rather than a live UI
// dictionary namespace (that belongs to PROMPT-83's console strings).
//
// P3 (D7 news enrichment + weekly digest) deliberately does NOT follow that
// precedent for its NEW strings. The design ruling asks for a 4-locale
// dictionary regression gate over `news.enrich.*`/`news.recap.*`/
// `news.digest.*` (event-copy-gate lesson: a gate that reads its own
// expected list off the dictionaries cannot fail), which only works if the
// keys actually live in the dictionaries. `msgFor` (lib/messages-i18n) is
// the existing, already-tested primitive for exactly this — a pure,
// synchronous, parameter-interpolating lookup against the SAME statically
// bundled JSON the rest of the app reads, used the same way from
// player-stats.ts's personCareerStats. The five pre-existing inline strings
// (scorers/results/standings/movesTo/tbc) are UNTOUCHED — this is additive,
// not a migration of the old table.
import type { Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";

/**
 * Every `news.enrich.*` / `news.recap.*` / `news.digest.*` dictionary key
 * these templates read, hand-maintained here rather than derived from the
 * dictionaries — the regression test in draft-templates.test.ts checks all
 * four locales against THIS list, so a key this file starts using without
 * being added here is a gap the gate would otherwise be blind to.
 */
export const ENRICHMENT_DICT_KEYS = [
  "news.enrich.sectionTitle",
  "news.enrich.performer_line",
  "news.enrich.leader_move",
  "news.enrich.streak.win",
  "news.enrich.streak.unbeaten",
  "news.recap.leadersTitle",
  "news.recap.leader",
  "news.recap.biggest",
  "news.recap.standingsMovesTitle",
  "news.recap.standingsMove",
  "news.digest.title",
  "news.digest.section.standings",
  "news.digest.standings.row",
  "news.digest.standings.climber",
  "news.digest.section.leaders",
  "news.digest.leaders.row",
  "news.digest.section.upcoming",
  "news.digest.upcoming.line",
  "news.digest.upcoming.more",
  "news.digest.section.claimed",
  "news.digest.claimed.line",
] as const;

// En dash between the two scores (SPEC-2 title: "Riverside 3–1 Northside").
// Exported so enrichment.ts's biggestMargin label uses the same glyph.
export const DASH = "–";

// BCP-47 tag per app locale for Intl date formatting (venue-tz date line).
const BCP47: Record<Locale, string> = {
  en: "en-GB",
  fr: "fr-FR",
  es: "es-ES",
  nl: "nl-NL",
};

interface LocaleStrings {
  scorers: string;
  results: string;
  standings: string;
  points: string; // short "pts" suffix in the standings block
  roundRecapTitle: (round: number, division: string) => string;
  movesTo: (team: string, position: number) => string;
  tbc: string;
}

const STRINGS: Record<Locale, LocaleStrings> = {
  en: {
    scorers: "Scorers",
    results: "Results",
    standings: "Standings",
    points: "pts",
    roundRecapTitle: (r, d) => `Round ${r} recap: ${d}`,
    movesTo: (team, p) => `${team} moves up to ${ordinalEn(p)}.`,
    tbc: "TBC",
  },
  fr: {
    scorers: "Buteurs",
    results: "Résultats",
    standings: "Classement",
    points: "pts",
    roundRecapTitle: (r, d) => `Résumé de la journée ${r} : ${d}`,
    movesTo: (team, p) => `${team} monte à la ${p}e place.`,
    tbc: "À confirmer",
  },
  es: {
    scorers: "Goleadores",
    results: "Resultados",
    standings: "Clasificación",
    points: "pts",
    roundRecapTitle: (r, d) => `Resumen de la jornada ${r}: ${d}`,
    movesTo: (team, p) => `${team} sube al puesto ${p}.`,
    tbc: "Por confirmar",
  },
  nl: {
    scorers: "Doelpuntenmakers",
    results: "Uitslagen",
    standings: "Stand",
    points: "ptn",
    roundRecapTitle: (r, d) => `Samenvatting ronde ${r}: ${d}`,
    movesTo: (team, p) => `${team} klimt naar plek ${p}.`,
    tbc: "Nog te bevestigen",
  },
};

function ordinalEn(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Venue-zone datetime with the zone labelled (v12 fixtureWhen shape, localized
 *  tag). Returns the locale's "TBC" when unscheduled. Pure/deterministic given
 *  (at, tz) — Node ICU renders the same string on CI. */
export function draftWhen(at: string | null, tz: string | null, locale: Locale): string {
  const s = STRINGS[locale];
  if (!at) return s.tbc;
  const zone = tz ?? "UTC";
  try {
    const formatted = new Date(at).toLocaleString(BCP47[locale], {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${formatted} (${zone})`;
  } catch {
    return `${new Date(at).toISOString()} (UTC)`;
  }
}

/** P3 enrichment for a result draft — all optional, all independently
 *  absent-able (Failure matrix: a source erroring drops ONLY its own
 *  section, never the whole draft). */
export interface ResultEnrichment {
  /** From the match summary/fold — capped by the caller, not here. */
  topPerformers?: { personName: string; statLine: string }[];
  /** Rank-before/after for scorers whose credit in THIS fixture moved their
   *  division leaderboard position (enrichment.ts's computeLeaderboardMoves). */
  leaderboardMoves?: { personName: string; metric: string; from: number; to: number }[];
  /** The winning entrant's current win/unbeaten run (enrichment.ts's
   *  computeStreak) — absent when there is no winner or no streak ≥ 2. */
  streak?: { entrantName: string; kind: "win" | "unbeaten"; length: number };
}

export interface ResultDraftInput {
  locale: Locale;
  homeName: string;
  awayName: string;
  /** Per-side summary line (SideSummary.line) — "3", "252/8 (50)", etc. */
  homeScore: string;
  awayScore: string;
  competitionName: string;
  divisionName: string;
  venue?: string | null;
  scheduledAt?: string | null;
  venueTz?: string | null;
  /** Only when the sport has playerStats AND events are attributed (SPEC-2). */
  scorers?: { name: string; count?: number }[];
  /** Only for league-stage fixtures: the winner's post-result position. */
  movement?: { team: string; position: number } | null;
  /** P3 — optional. Absent (or every field within it absent) must produce
   *  BYTE-IDENTICAL output to a call with no `enrichment` key at all. */
  enrichment?: ResultEnrichment;
}

/** Result post: title "Home s–s Away", body = competition line, venue+date,
 *  optional scorers list, optional standings-movement line. */
export function resultDraft(input: ResultDraftInput): { title: string; bodyMd: string } {
  const s = STRINGS[input.locale];
  const title = `${input.homeName} ${input.homeScore}${DASH}${input.awayScore} ${input.awayName}`;

  const lines: string[] = [];
  lines.push(`**${input.competitionName}** · ${input.divisionName}`);
  const whenLine = draftWhen(input.scheduledAt ?? null, input.venueTz ?? null, input.locale);
  lines.push(input.venue ? `${input.venue} · ${whenLine}` : whenLine);

  if (input.scorers && input.scorers.length > 0) {
    lines.push("");
    lines.push(`**${s.scorers}**`);
    for (const sc of input.scorers) {
      lines.push(`- ${sc.name}${sc.count && sc.count > 1 ? ` (${sc.count})` : ""}`);
    }
  }
  if (input.movement) {
    lines.push("");
    lines.push(s.movesTo(input.movement.team, input.movement.position));
  }

  const e = input.enrichment;
  if (e?.topPerformers && e.topPerformers.length > 0) {
    lines.push("");
    lines.push(`**${msgFor(input.locale, "news.enrich.sectionTitle")}**`);
    for (const p of e.topPerformers) {
      lines.push(
        `- ${msgFor(input.locale, "news.enrich.performer_line", { name: p.personName, statLine: p.statLine })}`,
      );
    }
  }
  if (e?.leaderboardMoves && e.leaderboardMoves.length > 0) {
    lines.push("");
    for (const m of e.leaderboardMoves) {
      lines.push(
        msgFor(input.locale, "news.enrich.leader_move", {
          name: m.personName,
          metric: m.metric,
          from: m.from,
          to: m.to,
        }),
      );
    }
  }
  if (e?.streak) {
    lines.push("");
    lines.push(
      msgFor(
        input.locale,
        e.streak.kind === "win" ? "news.enrich.streak.win" : "news.enrich.streak.unbeaten",
        { entrant: e.streak.entrantName, length: e.streak.length },
      ),
    );
  }

  return { title, bodyMd: lines.join("\n") };
}

/** P3 enrichment for a round-recap draft — same absent-ability contract as
 *  ResultEnrichment. */
export interface RecapEnrichment {
  /** Top scorer etc., ALREADY the values `divisionPlayerStats` emits —
   *  never derived ad hoc (design ruling). */
  leaders?: { metric: string; personName: string; value: number }[];
  /** Largest-margin result of the round (enrichment.ts's biggestMargin) —
   *  absent when no result in the round has a comparable numeric margin. */
  biggestResult?: { label: string };
  /** Standings movers this round (enrichment.ts's biggestClimber, possibly
   *  called once per pool). */
  standingsMoves?: { entrantName: string; from: number; to: number }[];
}

export interface RoundRecapDraftInput {
  locale: Locale;
  competitionName: string;
  divisionName: string;
  /** 1-based (v13 lesson). */
  roundNo: number;
  results: { homeName: string; homeScore: string; awayName: string; awayScore: string }[];
  /** Top of the table (caller slices top-N). */
  standings: { position: number; name: string; played: number; points: number }[];
  /** P3 — optional, same byte-identical-when-absent contract as
   *  ResultDraftInput.enrichment. */
  enrichment?: RecapEnrichment;
}

/** Round recap post: title "Round N recap: Division", body = results grid +
 *  top-of-standings block. */
export function roundRecapDraft(input: RoundRecapDraftInput): { title: string; bodyMd: string } {
  const s = STRINGS[input.locale];
  const title = s.roundRecapTitle(input.roundNo, input.divisionName);

  const lines: string[] = [];
  lines.push(`**${input.competitionName}** · ${input.divisionName}`);
  lines.push("");
  lines.push(`**${s.results}**`);
  for (const r of input.results) {
    lines.push(`- ${r.homeName} ${r.homeScore}${DASH}${r.awayScore} ${r.awayName}`);
  }
  if (input.standings.length > 0) {
    lines.push("");
    lines.push(`**${s.standings}**`);
    for (const row of input.standings) {
      lines.push(`${row.position}. ${row.name} — ${row.points} ${s.points} (${row.played})`);
    }
  }

  const e = input.enrichment;
  if (e?.leaders && e.leaders.length > 0) {
    lines.push("");
    lines.push(`**${msgFor(input.locale, "news.recap.leadersTitle")}**`);
    for (const l of e.leaders) {
      lines.push(
        `- ${msgFor(input.locale, "news.recap.leader", { metric: l.metric, name: l.personName, value: l.value })}`,
      );
    }
  }
  if (e?.biggestResult) {
    lines.push("");
    lines.push(msgFor(input.locale, "news.recap.biggest", { label: e.biggestResult.label }));
  }
  if (e?.standingsMoves && e.standingsMoves.length > 0) {
    lines.push("");
    lines.push(`**${msgFor(input.locale, "news.recap.standingsMovesTitle")}**`);
    for (const m of e.standingsMoves) {
      lines.push(
        `- ${msgFor(input.locale, "news.recap.standingsMove", { entrant: m.entrantName, from: m.from, to: m.to })}`,
      );
    }
  }

  return { title, bodyMd: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Weekly digest (P3 / D7) — new draft kind, no legacy byte-identical
// constraint (nothing rendered this before). Sections render ONLY when their
// data exists (design ruling: absent section ≠ empty section, no "no data"
// filler line) — an org whose week was quiet gets a short digest, not a
// digest full of placeholders.
// ---------------------------------------------------------------------------

export interface DigestStandingsSection {
  divisionName: string;
  /** Caller slices top-N (design: top 3). */
  top3: { position: number; name: string; points: number }[];
  /** Largest positive rank delta window-over-window (enrichment.ts's
   *  biggestClimber) — absent when nobody climbed, there is no prior
   *  snapshot, or the climb was tied and therefore ambiguous. */
  climber?: { entrantName: string; from: number; to: number };
}

export interface DigestLeaderLine {
  divisionName: string;
  metricLabel: string;
  personName: string;
  value: number;
}

export interface DigestUpcomingDay {
  /** "YYYY-MM-DD" in org tz (enrichment.ts's groupUpcomingByDay). */
  dayYmd: string;
  lines: { homeName: string; awayName: string; timeLabel: string }[];
}

export interface DigestClaimedHighlight {
  personName: string;
  statLine: string;
}

export interface WeeklyDigestDraftInput {
  locale: Locale;
  orgName: string;
  /** The org-local calendar date the window starts on
   *  (enrichment.ts's digestWindow().weekOfYmd). */
  weekOfYmd: string;
  standings: DigestStandingsSection[];
  leaders: DigestLeaderLine[];
  upcoming: DigestUpcomingDay[];
  /** Fixtures beyond the cap (design: cap at 10 + "and N more" tail). */
  upcomingOverflow: number;
  claimedHighlight?: DigestClaimedHighlight;
}

function formatWeekOf(ymd: string, locale: Locale): string {
  try {
    return new Date(`${ymd}T00:00:00Z`).toLocaleDateString(BCP47[locale], {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC", // ymd is already the org-local calendar date — render it as-is
    });
  } catch {
    return ymd;
  }
}

function formatDayHeading(ymd: string, locale: Locale): string {
  try {
    return new Date(`${ymd}T00:00:00Z`).toLocaleDateString(BCP47[locale], {
      weekday: "long",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  } catch {
    return ymd;
  }
}

/** Weekly digest post: title + up to 4 sections (standings movement, stat
 *  leaders, next 7 days, claimed-player highlight), each independently
 *  absent-able. */
export function weeklyDigestDraft(input: WeeklyDigestDraftInput): { title: string; bodyMd: string } {
  const title = msgFor(input.locale, "news.digest.title", {
    orgName: input.orgName,
    weekOf: formatWeekOf(input.weekOfYmd, input.locale),
  });

  const lines: string[] = [];
  const spacer = () => {
    if (lines.length > 0) lines.push("");
  };

  if (input.standings.length > 0) {
    spacer();
    lines.push(`**${msgFor(input.locale, "news.digest.section.standings")}**`);
    for (const section of input.standings) {
      lines.push("");
      lines.push(`_${section.divisionName}_`);
      for (const row of section.top3) {
        lines.push(
          msgFor(input.locale, "news.digest.standings.row", {
            position: row.position,
            name: row.name,
            points: row.points,
          }),
        );
      }
      if (section.climber) {
        lines.push(
          msgFor(input.locale, "news.digest.standings.climber", {
            entrant: section.climber.entrantName,
            from: section.climber.from,
            to: section.climber.to,
          }),
        );
      }
    }
  }

  if (input.leaders.length > 0) {
    spacer();
    lines.push(`**${msgFor(input.locale, "news.digest.section.leaders")}**`);
    for (const l of input.leaders) {
      lines.push(
        `- ${msgFor(input.locale, "news.digest.leaders.row", {
          division: l.divisionName,
          metric: l.metricLabel,
          name: l.personName,
          value: l.value,
        })}`,
      );
    }
  }

  if (input.upcoming.length > 0) {
    spacer();
    lines.push(`**${msgFor(input.locale, "news.digest.section.upcoming")}**`);
    for (const day of input.upcoming) {
      lines.push("");
      lines.push(`_${formatDayHeading(day.dayYmd, input.locale)}_`);
      for (const fx of day.lines) {
        lines.push(
          `- ${msgFor(input.locale, "news.digest.upcoming.line", {
            home: fx.homeName,
            away: fx.awayName,
            time: fx.timeLabel,
          })}`,
        );
      }
    }
    if (input.upcomingOverflow > 0) {
      lines.push(msgFor(input.locale, "news.digest.upcoming.more", { count: input.upcomingOverflow }));
    }
  }

  if (input.claimedHighlight) {
    spacer();
    lines.push(`**${msgFor(input.locale, "news.digest.section.claimed")}**`);
    lines.push(
      msgFor(input.locale, "news.digest.claimed.line", {
        name: input.claimedHighlight.personName,
        statLine: input.claimedHighlight.statLine,
      }),
    );
  }

  return { title, bodyMd: lines.join("\n") };
}
