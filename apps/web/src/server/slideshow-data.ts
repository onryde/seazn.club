import "server-only";
// Slide builder for the noticeboard slideshow (v1 parity — the marketing page
// promises "Print & slideshow"). One slide deck per division; the competition
// slideshow concatenates the decks of every division with anything to show.
import { sql, withTenant } from "@/lib/db";
import { listStages, getStandings } from "@/server/usecases/stages";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { listEntrantLogoUrls } from "@/server/usecases/teams";
import { hasFeature } from "@/lib/entitlements";
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import { BRACKET_SLIDE_KINDS, bracketSlideLaysOut } from "@/components/v2/slideshow-rotation";
import { resolveLogoUrl } from "@/server/public-site/data";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { creditsNobody, forfeitLedgerOfReason, unseatedForfeitLoser } from "@/lib/forfeit-tag";
import { outcomeTagWords } from "@/lib/outcome-text";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";
import { getDictionary } from "@/lib/i18n";
import { poolLabel } from "@/lib/pool-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import {
  DERIVED_METRICS,
  PLAIN_LAYOUT,
  derivedMetricText,
  isLevelTable,
  pointsText,
  rankText,
  type OutcomeKey,
  type PointsRule,
  type StandingsRow,
  type TableLayout,
} from "@seazn/engine/competition";
import { cellText, compactKeysOf, fixedResultColumns, tableLayoutFor } from "@/server/public-site/standings-view";
import { standingsColumns, type MetricSpecLike } from "@/lib/public-site";
import { resolveModule } from "@/server/engine-db/registry";
import { stageTableRulesDocs } from "@/server/engine-db/table-rules";

const TABLE_KINDS = new Set(["league", "group", "swiss"]);

/** The result columns a standings slide prints between the entrant and Pts (W2d follow-up, final review m8): the public
 *  table's own declaration for a fixed-shape table (`fixedResultColumns`) — P · W · D · L, and IIHF's P · W · OTW · OTL ·
 *  D · L (RBG:343-344). */
export type StandingsSlideColumnKey = "played" | "won" | "otw" | "otl" | "drawn" | "lost";

export interface StandingsSlideColumn {
  key: StandingsSlideColumnKey;
  /** Still shown below `lg`, where a phone sees the board only when it asks for it (kiosk-phone-card.tsx). A table that
   *  splits its results keeps the public table's phone set (`compactKeysOf`: P, then Pts) and folds the rest, as the
   *  public table does: its six counts do not fit a 768px board (the slideshow-tv-rows budget). A table that does not
   *  split folds nothing — its P · W · D · L fit from 768, and its board stays as it always was. */
  compact: boolean;
}

export interface StandingsSlideRow {
  /** The rank as the public table prints it (`rankText`): the place, or "–" on a level table (X-TB-6). */
  rank: string;
  name: string;
  /** The result cells, paired by index with the slide's `columns`: the public table's own cell text (`cellText`), so
   *  IIHF's W and L leave out the overtime and shoot-out decisions that OTW and OTL hold. */
  results: string[];
  /** The points as the public table prints them (`pointsText` under the stage's unit): chess's half-points read
   *  "1½", never the stored 3 (RB2B-17: "on every surface"). */
  points: string;
  /** The "Pts ratio" cell, display-ready ("1.50", "∞", "—"): the engine's own
   *  `derivedMetricText` for `point_ratio`, the very text the normal standings
   *  table prints. Set on every row of a slide whose division ranks on
   *  `point_ratio` (the normal table shows the column under the same
   *  condition), and on none otherwise — the board shows the column exactly
   *  when a row carries this. */
  pointRatio?: string;
}

/** The inputs the division page hands `standingsColumns`: the pinned module's
 *  metrics, and the cascade — since W2d Task 9 the STAGE's order (its table rules
 *  from the one loader: its pin, else its live layers), never the division's
 *  override or the module default re-read here. */
interface StandingsShape {
  metricSpecs: readonly MetricSpecLike[];
  cascade: readonly string[];
  /** W2d T17: the stage's table layout (`tableLayoutFor`, the public table's own) — its points unit. */
  layout: TableLayout;
}

/** A stage's loaded rules as these builders receive them: the organiser's from `stageTableRulesDocs`, the public one's
 *  from `PublicStage.table_rules`. `points` and `reachable` are optional because hand-built inputs predate them, and
 *  read as no rules (whole points, the plain layout). */
interface StageRulesInput {
  readonly tiebreakers: readonly string[];
  readonly points?: PointsRule;
  readonly reachable?: readonly OutcomeKey[];
}

/** What a division says about its own standings. Every field is optional: a
 *  hand-built public input predates them, and reads as "no module". */
interface StandingsShapeInput {
  sport_key?: string;
  module_version?: string;
}

/** Resolves a division's pinned module's metrics the way the division page does
 *  (`(public)/shared/.../[divisionSlug]/page.tsx`): a module this build no
 *  longer carries degrades to structural columns only — it never throws. The
 *  cascade is each stage's own (`stageShape`). */
function divisionMetrics(division: StandingsShapeInput): readonly MetricSpecLike[] {
  if (division.sport_key === undefined || division.module_version === undefined) return [];
  try {
    return resolveModule(division.sport_key, division.module_version).metrics;
  } catch {
    return [];
  }
}

/** One stage's standings shape: the division's metrics and the stage's order (none for a stage whose rules the loader
 *  refused, or a hand-built input that carries none). */
const stageShape = (metricSpecs: readonly MetricSpecLike[], rules: StageRulesInput | null | undefined): StandingsShape => ({
  metricSpecs,
  cascade: rules?.tiebreakers ?? [],
  layout: rules?.points === undefined || rules.reachable === undefined ? PLAIN_LAYOUT : tableLayoutFor({ points: rules.points, reachable: rules.reachable }),
});

/** A snapshot row as `standings_snapshots` persists it. `metrics` is optional
 *  only because hand-built inputs predate it; a real snapshot always has it. */
interface StandingsSlideSnapshotRow {
  entrantId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  rank?: number;
  metrics?: Record<string, number>;
  /** W2d (X-TB-6): every row of a table with no counted fixture is level. */
  level?: boolean;
}

/**
 * One standings slide's rows, for BOTH builders. Whether a row carries the
 * "Pts ratio" is asked of `standingsColumns` itself — the function the normal
 * table picks its columns with — over the same module metrics, cascade and rows,
 * so the two tables cannot disagree about which columns a division has; and its
 * text is `derivedMetricText`, the engine's, which is what the table's cell
 * prints. This file computes no ratio of its own.
 */
function standingsSlideRows(
  snapRows: readonly StandingsSlideSnapshotRow[],
  shape: StandingsShape,
  names: Record<string, string>,
): { columns: StandingsSlideColumn[]; rows: StandingsSlideRow[]; level: boolean } {
  const engineRows: StandingsRow[] = snapRows.map((r) => ({ ...r, metrics: r.metrics ?? {} }));
  const showsPointRatio = standingsColumns(shape.metricSpecs, shape.cascade, engineRows, DERIVED_METRICS).some(
    (c) => c.kind === "derived" && c.key === "point_ratio",
  );
  // W2d follow-up (final review m8; RBG §3.4): the result columns are the public table's own declaration under the
  // stage's layout, and each cell its own text — no second column list and no second W.
  const results = fixedResultColumns(shape.layout);
  const folds = shape.layout.apart.length > 0;
  const compact = compactKeysOf(shape.layout);
  const columns = results.map((c) => ({ key: c.key as StandingsSlideColumnKey, compact: !folds || compact.has(c.key) }));
  // W2d T17 (X-TB-6, RB2B-17): the public table's own helpers — a level table has no places and no leader, and the
  // points print in the stage's unit.
  const level = isLevelTable(engineRows);
  const rows = engineRows.map((r, i) => ({
    rank: rankText({ ...r, rank: r.rank ?? i + 1 }, level),
    name: names[r.entrantId] ?? "—",
    results: results.map((c) => cellText(r, c, shape.layout)),
    points: pointsText(r.points, shape.layout.unit),
    ...(showsPointRatio ? { pointRatio: derivedMetricText(r, "point_ratio") ?? "—" } : {}),
  }));
  return { columns, rows, level };
}

export interface FixtureSlideItem {
  home: string;
  away: string;
  /** Team badge URLs (team → club via team_display_v) — the matchup slide is
   *  the one surface that may show both sides' badges at once (v3/03 §5). */
  homeLogo: string | null;
  awayLogo: string | null;
  /** Display-ready score headline from match_states, e.g. "2 – 1" or "21-15, 21-18". */
  line: string | null;
  /** Design review I-1 (audit 3.1): a result that credits nobody (a double walkover) carries no `line` — its 0 / 0 would
   *  read as a played draw — and this, the forfeit tag in the org's locale, drawn where the score would be. Absent on
   *  every other row. */
  tag?: string | null;
  /** Loop R M-11 (UI-2): a credited result's house tag ("w/o", "ret.", "DQ", "Aband. · DLS") and its expansion, in the
   *  org's locale, drawn in the status cell in place of the status word — which said "Forfeit" for every reason and
   *  "Ended" for an abandon decided by DLS or the award policy. Read through the one reader (`statusTagOf`). Absent on
   *  a played result, a bye, and a double walkover, whose tag already stands in the score's place (`tag`). */
  statusTag?: { word: string; full: string };
  status: string;
  round: number;
  /** N1d d4 — the fixture's round NAME in the org's locale ("Losers' round 1"),
   *  from the one public round namer (`publicRoundNamer`). Set by the PUBLIC
   *  builder only: the organiser board leaves it out and keeps its short code
   *  (`slideshow.round`, "R5"). Empty for a fixture whose stage the namer does
   *  not know, so a public row never falls back to the code. */
  roundName?: string;
}

/** v13 (PROMPT-64): bracket-slide node — the geometry is computed client-side
 *  by the shared engine twoSidedBracket, so this carries structure + labels. */
export interface BracketSlideFixture {
  id: string;
  round_no: number;
  seq_in_round: number;
  home: string | null;
  away: string | null;
  /** D4b (P6) — {key, params} i18n pattern ref. BOTH server builders
   *  (buildDivisionSlides, buildPublicDivisionSlides) resolve a locale-aware
   *  `home`/`away` string for an unfilled slot before a bracket slide reaches
   *  the client (`resolveSlotLabel` never returns null), so a side is null only
   *  on an entrant-name miss, where the client <Slideshow> shows its own
   *  `labels.tbd` (R10e u1: the component no longer reads this pair). Kept on
   *  the wire. */
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  line: string | null;
  /** As `FixtureSlideItem.tag` (review I-1): the double walkover's tag, its `line` null. */
  tag?: string | null;
  status: string;
}

export type Slide =
  | {
      kind: "standings";
      division: string;
      caption: string;
      /** The result columns, in order (W2d follow-up m8); each row's `results` holds their cells. */
      columns: StandingsSlideColumn[];
      rows: StandingsSlideRow[];
      /** W2d T17 (X-TB-6, anti-goal 3): no counted fixture yet — no row is drawn as first. */
      level: boolean;
    }
  | {
      kind: "fixtures";
      division: string;
      title: string;
      items: FixtureSlideItem[];
      /** v13: the live slide pins — the rotation returns to it every other
       *  step while matches are in play (slideshow-rotation.ts). */
      pinned?: boolean;
    }
  | {
      kind: "bracket";
      division: string;
      title: string;
      /** Which geometry the client draws — absent means knockout (old payloads). */
      stageKind?: "knockout" | "double_elim" | "stepladder" | "page_playoff";
      fixtures: BracketSlideFixture[];
    };

/**
 * Org chrome for the noticeboard masthead — brand color blob and logo URL,
 * entitlement-gated like the public pages (theme: dashboard.theme since V397,
 * logo: branding). `themed` is exposed so callers gate the OTHER links of the
 * theme chain (competition.branding) with the same read-entitlement — the
 * console read model doesn't empty branding the way the public views do.
 *
 * The theme key is NOT `dashboard.branding`. That key is badge removal alone
 * (enterprise only, V396); reading it here is what took Pro's brand colour off
 * its own noticeboard and left the "pro slideshow carries the org accent theme"
 * smoke check red. `entitlements-v18-theme.test.ts` drives this function.
 */
export async function orgBoardChrome(
  auth: AuthCtx,
): Promise<{ branding: unknown; logo: string | null; themed: boolean }> {
  const [themed, logoBranded, [org]] = await Promise.all([
    hasFeature(auth.orgId, "dashboard.theme"),
    hasFeature(auth.orgId, "branding"),
    sql<{ branding: unknown; logo_url: string | null; logo_storage_path: string | null }[]>`
      select branding, logo_url, logo_storage_path
      from organizations where id = ${auth.orgId}`,
  ]);
  return {
    branding: themed ? (org?.branding ?? null) : null,
    logo: logoBranded ? resolveLogoUrl(org?.logo_storage_path, org?.logo_url) : null,
    themed,
  };
}

export async function buildDivisionSlides(
  auth: AuthCtx,
  divisionId: string,
  divisionName: string,
): Promise<Slide[]> {
  const [stages, fixtures, entrants, logos, priv, org, consentRows] = await Promise.all([
    listStages(auth, divisionId),
    listDivisionFixtures(auth, divisionId),
    listEntrants(auth, divisionId),
    listEntrantLogoUrls(auth, divisionId),
    withTenant(auth.orgId, (tx) =>
      tx<
        {
          youth: boolean;
          player_name_display: string | null;
          sport_key: string;
          module_version: string;
        }[]
      >`
        select youth, player_name_display, sport_key, module_version
        from divisions where id = ${divisionId}`,
    ),
    // P6 fix round 3, Important 4 — mirrors PublicSlideInput.orgLocale: the
    // doc comment this replaced claimed "no locale anywhere in this tree",
    // which was false (the RSC callers hold `auth`/`org` and resolveLocale()
    // is available) but also beside the point — this slideshow is already
    // treated as a PUBLIC surface for name-display purposes (the comment two
    // lines down), so its locale should be the org's own public default too,
    // the same source the public twin uses, NOT the specific signed-in
    // staff member's personal preference (that distinction is deliberate —
    // see resolve-locale.ts's "orgDefault... for public league pages only").
    // Self-fetched here (not threaded through as a caller-supplied param,
    // unlike the pure public builder below) because this function already
    // does its own ad hoc per-division queries and `auth.orgId` is on hand.
    withTenant(auth.orgId, (tx) =>
      tx<{ default_locale: string | null }[]>`
        select default_locale from organizations where id = ${auth.orgId}`,
    ),
    // RS008 — every roster member's own consent, keyed by entrant (fetched
    // for every entrant kind uniformly, including team: a team roster IS
    // people, even though the team's OWN display_name below never takes
    // this axis — same `kind === "team"` bypass public.ts's publicEntrants
    // already established). `listEntrants` stays untouched (a general,
    // widely-used usecase); this is a small, local, PARALLEL query instead.
    withTenant(auth.orgId, (tx) =>
      tx<{ entrant_id: string; consent: { public_name?: boolean } | null }[]>`
        select em.entrant_id, p.consent
        from entrant_members em
        join persons p on p.id = em.person_id
        join entrants e on e.id = em.entrant_id
        where e.division_id = ${divisionId}`,
    ),
  ]);
  const locale = toLocale(org[0]?.default_locale);
  const lookup: SlotLabelLookup = (k, v) => msgFor(locale, k, v);
  // The pool labels' words (`table.poolLabel`), same org locale as `lookup`.
  const publicDict = await getDictionary(locale, "public");
  // RS008: "stricter wins" per entrant — ANY roster member's explicit
  // opt-out masks that entrant's own display_name (a solo "individual"
  // entrant has exactly one member; a "pair"/"team" can have several).
  const consentByEntrant = new Map<string, ({ public_name?: boolean } | null)[]>();
  for (const r of consentRows) {
    const list = consentByEntrant.get(r.entrant_id) ?? [];
    list.push(r.consent);
    consentByEntrant.set(r.entrant_id, list);
  }
  // Slideshow renders on venue screens — a public surface for name-display
  // purposes (v3/11 gap 8). Team names pass through; person names mask by
  // division youth policy OR the roster's own consent opt-out (RS008),
  // whichever is stricter — resolvePersonDisplayName is the single
  // canonical resolver for both axes at once.
  const names = Object.fromEntries(
    entrants.map((e) => [
      e.id,
      e.kind === "team"
        ? e.display_name
        : resolvePersonDisplayName(
            e.display_name,
            anyOptedOut(consentByEntrant.get(e.id) ?? []) ? { public_name: false } : null,
            priv[0]?.player_name_display ?? null,
            priv[0]?.youth ?? false,
          ),
    ]),
  );
  const slides: Slide[] = [];
  // The division's own module and each stage's order decide its standings
  // columns, the same way they do on its public page (W2d Task 9: the order from
  // the one loader, `stageTableRulesDocs`).
  const metricSpecs = divisionMetrics(priv[0] ?? {});
  const tableRules = await withTenant(auth.orgId, (tx) => stageTableRulesDocs(tx, stages.map((s) => s.id)));

  // ── Standings — one slide per table stage (per pool when pooled) ──
  for (const stage of stages.filter((s) => TABLE_KINDS.has(s.kind))) {
    const pools = await withTenant(auth.orgId, (tx) =>
      tx<{ id: string; key: string }[]>`
        select id, key from pools where stage_id = ${stage.id} order by key`,
    );
    const tables =
      pools.length > 0
        ? await Promise.all(
            pools.map(async (p) => ({
              // From the pool's KEY in the org's locale, never its stored
              // English name (`lib/pool-label.ts`).
              caption: `${stage.name} — ${poolLabel(publicDict, p.key)}`,
              snap: await getStandings(auth, stage.id, p.id),
            })),
          )
        : [{ caption: stage.name, snap: await getStandings(auth, stage.id) }];
    for (const { caption, snap } of tables) {
      const { columns, rows, level } = standingsSlideRows(snap.rows as StandingsSlideSnapshotRow[], stageShape(metricSpecs, tableRules[stage.id]), names);
      if (rows.length > 0) {
        slides.push({ kind: "standings", division: divisionName, caption, columns, rows, level });
      }
    }
  }

  // ── Fixtures — score headlines come from match_states.summary ──
  const ids = fixtures.map((f) => f.id);
  const summaries =
    ids.length === 0
      ? []
      : await withTenant(auth.orgId, (tx) =>
          tx<{ fixture_id: string; summary: { headline?: string } | null }[]>`
            select fixture_id, summary from match_states
            where fixture_id = any(${ids})`,
        );
  const lineOf = new Map(summaries.map((s) => [s.fixture_id, s.summary?.headline ?? null]));
  // Design review I-1 (audit 3.1): a double walkover credits nobody — no 0 / 0 on the TV; its tag in the score's place.
  const scoreOf = (f: (typeof fixtures)[number]): { line: string | null; tag?: string; statusTag?: { word: string; full: string } } =>
    creditsNobody(f.outcome)
      ? { line: null, tag: lookup("forfeit.tag.doubleWalkover") }
      : { line: lineOf.get(f.id) ?? null, ...statusTagOf(lookup, f) };

  // Fix round 3 (Important 4): `lookup` (this org's REAL locale, resolved
  // above from `orgLocale`) — was `msg` (client-safe English, always),
  // regardless of the org's own locale, even though the RSC callers
  // (slideshow/competitions/[id]/page.tsx, slideshow/divisions/[id]/page.tsx)
  // hold `org` and could always pass it through.
  // R116-1: an empty seat a walkover was won over (ruling 116's withdrawn winner) names her, never its bye label.
  const unseatedName = (f: (typeof fixtures)[number], which: "home" | "away"): string | null => {
    const id = unseatedForfeitLoser(f, which);
    return id === null ? null : (names[id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"));
  };
  const seatText = (f: (typeof fixtures)[number], which: "home" | "away"): string =>
    unseatedName(f, which) ?? resolveSlotLabel(which === "home" ? f.home_slot_label : f.away_slot_label, lookup, "schedule.tbd");
  const item = (f: (typeof fixtures)[number]): FixtureSlideItem => ({
    home: f.home_entrant_id
      ? (names[f.home_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : seatText(f, "home"),
    away: f.away_entrant_id
      ? (names[f.away_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : seatText(f, "away"),
    homeLogo: logos[f.home_entrant_id ?? ""] ?? null,
    awayLogo: logos[f.away_entrant_id ?? ""] ?? null,
    ...scoreOf(f),
    status: f.status,
    round: f.round_no,
  });

  const live = fixtures.filter((f) => f.status === "in_play").map(item);
  const results = fixtures
    .filter((f) => ["decided", "finalized", "forfeited"].includes(f.status))
    .slice(-8)
    .map(item);
  const upcoming = fixtures.filter((f) => f.status === "scheduled").slice(0, 8).map(item);

  if (live.length > 0)
    slides.push({
      kind: "fixtures", division: divisionName, title: "In play", items: live, pinned: true,
    });
  if (results.length > 0)
    slides.push({ kind: "fixtures", division: divisionName, title: "Latest results", items: results });
  if (upcoming.length > 0)
    slides.push({ kind: "fixtures", division: divisionName, title: "Coming up", items: upcoming });

  // ── Bracket — the knockout tree (v13/PROMPT-62 geometry), when it lays out ──
  for (const stage of stages.filter((s) => BRACKET_SLIDE_KINDS.has(s.kind))) {
    const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
    const refs = stageFixtures.map((f) => ({
      id: f.id, round_no: f.round_no, seq_in_round: f.seq_in_round,
    }));
    if (stageFixtures.length > 0 && bracketSlideLaysOut(stage.kind, refs)) {
      slides.push({
        kind: "bracket",
        division: divisionName,
        title: stage.name,
        stageKind: stage.kind as "knockout" | "double_elim" | "stepladder" | "page_playoff",
        // Fix round 3 (Important 4): home/away are fully resolved HERE (never
        // left null for an unfilled slot with a real label), mirroring
        // buildPublicDivisionSlides' fix round 1 finding #2. The client
        // <Slideshow> falls back to its own `labels.tbd` only on an
        // entrant-name miss (R10e u1). The raw *_slot_label fields stay on the
        // wire.
        fixtures: stageFixtures.map((f) => ({
          id: f.id,
          round_no: f.round_no,
          seq_in_round: f.seq_in_round,
          home: f.home_entrant_id
            ? (names[f.home_entrant_id] ?? null)
            : (unseatedName(f, "home") ?? resolveSlotLabel(f.home_slot_label ?? null, lookup, "bracket.tbd")),
          away: f.away_entrant_id
            ? (names[f.away_entrant_id] ?? null)
            : (unseatedName(f, "away") ?? resolveSlotLabel(f.away_slot_label ?? null, lookup, "bracket.tbd")),
          home_slot_label: f.home_slot_label,
          away_slot_label: f.away_slot_label,
          ...scoreOf(f),
          status: f.status,
        })),
      });
    }
  }

  return slides;
}

// ---------------------------------------------------------------------------
// v13 (PROMPT-64): PUBLIC presentation mode. The no-login /present routes
// reuse the SAME <Slideshow> with slides built from the public read models
// (consent/visibility enforced by the public_* views) — pure over
// getPublicDivision output, so it unit-tests without a DB.
// ---------------------------------------------------------------------------

export interface PublicSlideInput {
  division: {
    id: string;
    name: string;
    /** RS008 review fix #2 — this builder's own youth/player_name_display
     *  policy for the `names` map below (`resolvePersonDisplayName`,
     *  mirroring `buildDivisionSlides`'s identical fields). Optional and
     *  defaults to "full" (false/null) so every existing caller/test that
     *  predates this keeps its current behaviour; every real /present page
     *  reads `PublicDivision.youth`/`player_name_display`
     *  (public-site/data.ts) and should pass both through. */
    youth?: boolean;
    player_name_display?: string | null;
    /** The division's pinned module (`PublicDivision`), whose metrics pick its
     *  standings columns exactly as its public page's table does. Optional:
     *  hand-built inputs predate them and read as "no module", i.e. no ratio
     *  column. Both /present pages spread `getPublicDivision`'s result
     *  wholesale, so the real values arrive through this type — a type that
     *  omitted them would ship the column inert. */
    sport_key?: string;
    module_version?: string;
  };
  /** W2d Task 9: each stage carries its table rules (`PublicStage.table_rules`, the one loader's); its order picks the
   *  columns with the module's metrics. Absent or null: no order (no ratio column). */
  stages: { id: string; kind: string; name: string; table_rules?: StageRulesInput | null }[];
  /** A pool is labelled from its KEY (`lib/pool-label.ts`); the stored
   *  English `name` is deliberately not part of this input. */
  pools: { id: string; stage_id: string; key: string }[];
  fixtures: {
    id: string;
    stage_id: string;
    round_no: number;
    seq_in_round: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    /** Optional: several existing unit tests construct this input by hand
     *  without it — absent reads the same as null. */
    home_slot_label?: SlotLabel | null;
    away_slot_label?: SlotLabel | null;
    status: string;
    summary: { headline?: string } | null;
    /** N1c c3 — the round ROLE the public round namer reads to name a waiting
     *  side's feeder round (`getPublicDivision` carries all five). Optional:
     *  hand-built inputs predate them, and absent reads as a plain lane. */
    lane?: "WB" | "LB" | "GF" | null;
    is_final?: boolean | null;
    third_place?: boolean | null;
    conditional?: boolean | null;
    ext_key?: string | null;
    /** The bracket feed edges, which name a seat a `timing: "setup"`
     *  progression left stored-null ("Winner of Semi-finals, match 1" instead
     *  of "TBD"). Optional for the same reason the five above are: hand-built
     *  inputs predate them, and absent reads as "no feed known".
     *
     *  Both real callers spread `getPublicDivision`'s fixtures wholesale
     *  (`{ ...data }` in each /present page), so widening the type is what
     *  actually delivers them — WITHOUT it the namer here builds an empty feed
     *  map and the kiosk keeps saying "TBD" while every other public surface
     *  names the seat. A type that omits a field the caller passes is exactly
     *  how a seam ships inert. */
    winner_to_fixture?: string | null;
    winner_to_slot?: number | null;
    loser_to_fixture?: string | null;
    loser_to_slot?: number | null;
    /** R116-1 — the stored outcome, from which `unseatedForfeitLoser` reads whom an empty seat names (ruling 116's
     *  withdrawn winner, never "Bye"). Optional for the reason the feed edges are; both /present pages spread
     *  `getPublicDivision`'s fixtures, which carry it. */
    outcome?: unknown;
    /** Loop R M-11 — the active abandon's reason (`activeAbandonReasonSql`), the ledger `statusTagOf` reads an abandon's
     *  tag from. Optional for the reason the outcome is; both /present pages spread `getPublicDivision`'s fixtures,
     *  which carry it. */
    abandon_reason?: string | null;
  }[];
  standings: { stage_id: string; pool_id: string | null; rows: StandingsSlideSnapshotRow[] }[];
  entrants: {
    id: string;
    display_name: string;
    badge_url?: string | null;
    /** RS008 review fix #2 — a `team`'s own declared name never takes the
     *  consent axis (public.ts/public_entrants_v precedent, established
     *  throughout this session). Optional: absent bypasses masking exactly
     *  like a genuine team entrant would, matching every existing test that
     *  predates this field. */
    kind?: string;
    /** RS008 review fix #2 — true when ANY current roster member of this
     *  entrant has explicitly opted out (`consent.public_name === false`).
     *  Computed by the caller (`public-site/data.ts`'s `getPublicDivision`/
     *  `getPublicFixture`, which already derive this same signal to mask
     *  `display_name` themselves before it ever reaches here) — this
     *  builder stays pure/DB-free, so it cannot derive it independently.
     *  Absent/false never masks, matching `resolvePersonDisplayName`'s own
     *  "absence is never an opt-out" contract. */
    opted_out?: boolean;
  }[];
  /** P6 fix round 1, finding #2 (CRITICAL) — spectator-facing locale (v5
   *  i18n §4), `PublicOrg.default_locale` (same field data.ts:502-503
   *  already resolves from). Optional and defaults to English so every
   *  existing caller/test that predates this keeps its current behaviour;
   *  every real /present page has an `org` in scope and should pass it. */
  orgLocale?: string;
}

/** Loop R M-11 — a fixtures-slide row's status tag (`FixtureSlideItem.statusTag`), or nothing: `outcomeTagWords`, the
 *  one reader the organiser's result line uses, over the stored outcome, the active abandon's reason and the seats (an
 *  award stored before W2b names its reason only beside two seats). A double walkover never reaches here (its tag is
 *  the score's). */
function statusTagOf(
  lookup: SlotLabelLookup,
  f: { outcome: unknown; abandon_reason?: string | null; home_entrant_id: string | null; away_entrant_id: string | null },
): { statusTag?: { word: string; full: string } } {
  const words = outcomeTagWords(lookup, f.outcome, forfeitLedgerOfReason(f.abandon_reason), f);
  return words === null ? {} : { statusTag: words };
}

export async function buildPublicDivisionSlides(data: PublicSlideInput): Promise<Slide[]> {
  const orgLocale = toLocale(data.orgLocale);
  const lookup: SlotLabelLookup = (k, v) => msgFor(orgLocale, k, v);
  // N1c c3 — a side still waiting on a match reads its feeder's ROUND ("Winner
  // of Semi-finals, match 1") through the one public round namer the hub, the
  // match centre and the division page use, never the organiser board's
  // "Winner of R1·2". Its phrases live in the PUBLIC dictionary, loaded here
  // from the same `orgLocale` as `lookup`, so the two cannot disagree.
  const publicDict = await getDictionary(orgLocale, "public");
  const namer = publicRoundNamer({
    ui: lookup,
    dict: publicDict,
    fixtures: data.fixtures,
    stageKind: (stageId) => data.stages.find((s) => s.id === stageId)?.kind,
  });
  // RS008 review fix #2 — this "pure public twin" of buildDivisionSlides had
  // NO masking at all, not even by youth: the anonymous kiosk (/present)
  // could show an opted-out (or underage) person's full name where the
  // AUTHED noticeboard already masked it. Same resolver, same "team never
  // takes the consent axis" bypass; the caller (public-site/data.ts) already
  // masks display_name at the source too (belt and suspenders — see
  // PublicSlideInput's own doc comments), so this is correct even for a
  // caller that predates `kind`/`opted_out`/`youth`/`player_name_display`
  // and passes none of them (every field defaults to "never mask").
  const names = Object.fromEntries(
    data.entrants.map((e) => [
      e.id,
      e.kind === "team"
        ? e.display_name
        : resolvePersonDisplayName(
            e.display_name,
            e.opted_out ? { public_name: false } : null,
            data.division.player_name_display ?? null,
            data.division.youth ?? false,
          ),
    ]),
  );
  const stageById = new Map(data.stages.map((s) => [s.id, s]));
  const poolById = new Map(data.pools.map((p) => [p.id, p]));
  const slides: Slide[] = [];
  const metricSpecs = divisionMetrics(data.division);

  for (const snap of data.standings) {
    const stage = stageById.get(snap.stage_id);
    if (!stage || snap.rows.length === 0) continue;
    const pool = snap.pool_id !== null ? poolById.get(snap.pool_id) : undefined;
    const { columns, rows, level } = standingsSlideRows(snap.rows, stageShape(metricSpecs, stage.table_rules), names);
    slides.push({
      kind: "standings",
      division: data.division.name,
      // From the pool's KEY in the org's locale, never its stored English
      // name (`lib/pool-label.ts`).
      caption: pool !== undefined ? `${stage.name} — ${poolLabel(publicDict, pool.key)}` : stage.name,
      columns,
      rows,
      level,
    });
  }

  // The BRACKET slide owns its own "to be decided" word (`bracket.tbd`, a
  // different string from the namer's `schedule.tbd` in es/fr/nl), so it
  // cannot take a pre-resolved `seat()` string. It resolves the seat's LABEL
  // first — stored, else the feed edge — and falls back only when there is
  // genuinely none. Written this way because the obvious shape,
  // `f.home_slot_label ? namer.seat(...) : tbd`, short-circuits on exactly the
  // seat this exists for: a `timing: "setup"` bracket leaves a sibling-fed
  // seat's stored label NULL, so the namer was never reached and the kiosk
  // kept printing "TBD".
  // R116-1: an empty seat a walkover was won over (ruling 116's withdrawn winner) names her, never its bye label.
  const standIn = (f: PublicSlideInput["fixtures"][number], which: "home" | "away"): string | null => {
    const id = unseatedForfeitLoser({ ...f, outcome: f.outcome ?? null }, which);
    return id === null ? null : (names[id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"));
  };
  const bracketSeat = (f: PublicSlideInput["fixtures"][number], which: "home" | "away"): string => {
    const named = standIn(f, which);
    if (named !== null) return named;
    const stored = (which === "home" ? f.home_slot_label : f.away_slot_label) ?? null;
    const label = namer.seatLabelOf(f.id, which, stored);
    return label === null ? resolveSlotLabel(null, lookup, "bracket.tbd") : namer.seat(f.id, which, label);
  };

  // Design review I-1 (audit 3.1): a double walkover credits nobody — no 0 / 0 on the TV; its tag in the score's place.
  const publicScoreOf = (f: PublicSlideInput["fixtures"][number]): { line: string | null; tag?: string; statusTag?: { word: string; full: string } } =>
    creditsNobody(f.outcome)
      ? { line: null, tag: lookup("forfeit.tag.doubleWalkover") }
      : { line: f.summary?.headline ?? null, ...statusTagOf(lookup, { ...f, outcome: f.outcome ?? null }) };
  const item = (f: PublicSlideInput["fixtures"][number]): FixtureSlideItem => ({
    home: f.home_entrant_id
      ? (names[f.home_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      // `seat`, not `slot` — a setup bracket's sibling-fed seat has no stored
      // label, so the kiosk showed "TBD" on a match with a known feeder.
      : (standIn(f, "home") ?? namer.seat(f.id, "home", f.home_slot_label ?? null)),
    away: f.away_entrant_id
      ? (names[f.away_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : (standIn(f, "away") ?? namer.seat(f.id, "away", f.away_slot_label ?? null)),
    homeLogo: null,
    awayLogo: null,
    ...publicScoreOf(f),
    status: f.status,
    round: f.round_no,
    // N1d d4 — the row's round as the hub's rail names it, never the board's
    // "R{round}" code over the raw round_no (a losers' round 1 read "R3").
    roundName: namer.roundLabel(f.id) ?? "",
  });
  const live = data.fixtures.filter((f) => f.status === "in_play").map(item);
  const results = data.fixtures
    .filter((f) => ["decided", "finalized", "forfeited"].includes(f.status))
    .slice(-8).map(item);
  const upcoming = data.fixtures.filter((f) => f.status === "scheduled").slice(0, 8).map(item);
  if (live.length > 0)
    slides.push({ kind: "fixtures", division: data.division.name, title: lookup("slideshow.slide.inPlay"), items: live, pinned: true });
  if (results.length > 0)
    slides.push({ kind: "fixtures", division: data.division.name, title: lookup("slideshow.slide.latestResults"), items: results });
  if (upcoming.length > 0)
    slides.push({ kind: "fixtures", division: data.division.name, title: lookup("slideshow.slide.comingUp"), items: upcoming });

  for (const stage of data.stages.filter((s) => BRACKET_SLIDE_KINDS.has(s.kind))) {
    const stageFixtures = data.fixtures.filter((f) => f.stage_id === stage.id);
    const refs = stageFixtures.map((f) => ({ id: f.id, round_no: f.round_no, seq_in_round: f.seq_in_round }));
    if (stageFixtures.length > 0 && bracketSlideLaysOut(stage.kind, refs)) {
      slides.push({
        kind: "bracket",
        division: data.division.name,
        title: stage.name,
        stageKind: stage.kind as "knockout" | "double_elim" | "stepladder" | "page_playoff",
        // P6 fix round 1, finding #2: home/away are fully resolved HERE, in
        // the org's locale (never left null for an unfilled slot with a real
        // label). The client <Slideshow> falls back to its own `labels.tbd`,
        // which the present page resolves in that same locale (R10e u1), only
        // on an entrant-name miss.
        //
        // N1c c3: a labelled side goes through the round namer; a side with NO
        // label keeps the bracket's own "to be decided" (`bracket.tbd`), which
        // differs from the namer's `schedule.tbd` in es/fr/nl — the same split
        // the public Bracket component makes (R10d n4).
        fixtures: stageFixtures.map((f) => ({
          id: f.id, round_no: f.round_no, seq_in_round: f.seq_in_round,
          home: f.home_entrant_id ? (names[f.home_entrant_id] ?? null) : bracketSeat(f, "home"),
          away: f.away_entrant_id ? (names[f.away_entrant_id] ?? null) : bracketSeat(f, "away"),
          home_slot_label: f.home_slot_label ?? null,
          away_slot_label: f.away_slot_label ?? null,
          ...publicScoreOf(f),
          status: f.status,
        })),
      });
    }
  }

  return slides;
}
