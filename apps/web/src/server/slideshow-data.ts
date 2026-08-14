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
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";
import { BRACKET_SLIDE_KINDS, bracketSlideLaysOut } from "@/components/v2/slideshow-rotation";
import { resolveLogoUrl } from "@/server/public-site/data";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";

const TABLE_KINDS = new Set(["league", "group", "swiss"]);

export interface StandingsSlideRow {
  rank: number;
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
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
  status: string;
  round: number;
}

/** v13 (PROMPT-64): bracket-slide node — the geometry is computed client-side
 *  by the shared engine twoSidedBracket, so this carries structure + labels. */
export interface BracketSlideFixture {
  id: string;
  round_no: number;
  seq_in_round: number;
  home: string | null;
  away: string | null;
  /** D4b (P6) — {key, params} i18n pattern ref, a defensive fallback: BOTH
   *  server builders (buildDivisionSlides, buildPublicDivisionSlides) now
   *  resolve a locale-aware `home`/`away` string for an unfilled slot before
   *  a bracket slide ever reaches the client (`resolveSlotLabel` never
   *  returns null), so this pair matters only for the client `<Slideshow>`
   *  component's OWN fallback (`f.home ?? resolveSlotLabel(f.home_slot_label,
   *  msg, …)`) — which genuinely has no locale/`<DictProvider>` anywhere in
   *  ITS rendering tree (slideshow.tsx imports the client-safe English
   *  `msg()` directly) and stays on it for that reason. That fallback is
   *  unreachable from a resolved slot in practice; it is not dead code, only
   *  no longer the common path (fix round 3, Important 4 — buildDivisionSlides
   *  did not used to resolve locale-aware labels at all; see below). */
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  line: string | null;
  status: string;
}

export type Slide =
  | { kind: "standings"; division: string; caption: string; rows: StandingsSlideRow[] }
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
 * entitlement-gated like the public pages (theme: dashboard.branding,
 * logo: branding). `themed` is exposed so callers gate the OTHER links of the
 * theme chain (competition.branding) with the same read-entitlement — the
 * console read model doesn't empty branding the way the public views do.
 */
export async function orgBoardChrome(
  auth: AuthCtx,
): Promise<{ branding: unknown; logo: string | null; themed: boolean }> {
  const [themed, logoBranded, [org]] = await Promise.all([
    hasFeature(auth.orgId, "dashboard.branding"),
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
  const [stages, fixtures, entrants, logos, priv, org] = await Promise.all([
    listStages(auth, divisionId),
    listDivisionFixtures(auth, divisionId),
    listEntrants(auth, divisionId),
    listEntrantLogoUrls(auth, divisionId),
    withTenant(auth.orgId, (tx) =>
      tx<{ youth: boolean; player_name_display: string | null }[]>`
        select youth, player_name_display from divisions where id = ${divisionId}`,
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
  ]);
  const locale = toLocale(org[0]?.default_locale);
  const lookup: SlotLabelLookup = (k, v) => msgFor(locale, k, v);
  // Slideshow renders on venue screens — a public surface for name-display
  // purposes (v3/11 gap 8). Team names pass through; person names mask.
  const mode = resolveNameDisplay(priv[0]?.player_name_display ?? null, priv[0]?.youth ?? false);
  const names = Object.fromEntries(
    entrants.map((e) => [
      e.id,
      e.kind === "team" ? e.display_name : maskDisplayName(e.display_name, mode),
    ]),
  );
  const slides: Slide[] = [];

  // ── Standings — one slide per table stage (per pool when pooled) ──
  for (const stage of stages.filter((s) => TABLE_KINDS.has(s.kind))) {
    const pools = await withTenant(auth.orgId, (tx) =>
      tx<{ id: string; name: string }[]>`
        select id, name from pools where stage_id = ${stage.id} order by key`,
    );
    const tables =
      pools.length > 0
        ? await Promise.all(
            pools.map(async (p) => ({
              caption: `${stage.name} — ${p.name}`,
              snap: await getStandings(auth, stage.id, p.id),
            })),
          )
        : [{ caption: stage.name, snap: await getStandings(auth, stage.id) }];
    for (const { caption, snap } of tables) {
      const rows = (snap.rows as {
        entrantId: string;
        played: number;
        won: number;
        drawn: number;
        lost: number;
        points: number;
        rank?: number;
      }[]).map((r, i) => ({
        rank: r.rank ?? i + 1,
        name: names[r.entrantId] ?? "—",
        played: r.played,
        won: r.won,
        drawn: r.drawn,
        lost: r.lost,
        points: r.points,
      }));
      if (rows.length > 0) {
        slides.push({ kind: "standings", division: divisionName, caption, rows });
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

  // Fix round 3 (Important 4): `lookup` (this org's REAL locale, resolved
  // above from `orgLocale`) — was `msg` (client-safe English, always),
  // regardless of the org's own locale, even though the RSC callers
  // (slideshow/competitions/[id]/page.tsx, slideshow/divisions/[id]/page.tsx)
  // hold `org` and could always pass it through.
  const item = (f: (typeof fixtures)[number]): FixtureSlideItem => ({
    home: f.home_entrant_id
      ? (names[f.home_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : resolveSlotLabel(f.home_slot_label, lookup, "schedule.tbd"),
    away: f.away_entrant_id
      ? (names[f.away_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : resolveSlotLabel(f.away_slot_label, lookup, "schedule.tbd"),
    homeLogo: logos[f.home_entrant_id ?? ""] ?? null,
    awayLogo: logos[f.away_entrant_id ?? ""] ?? null,
    line: lineOf.get(f.id) ?? null,
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
        // Fix round 3 (Important 4): home/away are now fully resolved HERE
        // (never left null for an unfilled slot with a real label), mirroring
        // buildPublicDivisionSlides' fix round 1 finding #2 — so the client
        // <Slideshow>'s own `f.home ?? resolveSlotLabel(f.home_slot_label,
        // msg, …)` fallback (client-safe English, no DictProvider in that
        // tree) is unreachable from a resolved label, same as the public
        // path. The raw *_slot_label fields stay on the wire for that
        // fallback's benefit (an org whose bracket predates this fix, or any
        // caller this session didn't re-verify) — never removed, just no
        // longer the common path.
        fixtures: stageFixtures.map((f) => ({
          id: f.id,
          round_no: f.round_no,
          seq_in_round: f.seq_in_round,
          home: f.home_entrant_id
            ? (names[f.home_entrant_id] ?? null)
            : resolveSlotLabel(f.home_slot_label ?? null, lookup, "bracket.tbd"),
          away: f.away_entrant_id
            ? (names[f.away_entrant_id] ?? null)
            : resolveSlotLabel(f.away_slot_label ?? null, lookup, "bracket.tbd"),
          home_slot_label: f.home_slot_label,
          away_slot_label: f.away_slot_label,
          line: lineOf.get(f.id) ?? null,
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
  division: { id: string; name: string };
  stages: { id: string; kind: string; name: string }[];
  pools: { id: string; stage_id: string; name: string }[];
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
  }[];
  standings: { stage_id: string; pool_id: string | null; rows: StandingsSlideSnapshotRow[] }[];
  entrants: { id: string; display_name: string; badge_url?: string | null }[];
  /** P6 fix round 1, finding #2 (CRITICAL) — spectator-facing locale (v5
   *  i18n §4), `PublicOrg.default_locale` (same field data.ts:502-503
   *  already resolves from). Optional and defaults to English so every
   *  existing caller/test that predates this keeps its current behaviour;
   *  every real /present page has an `org` in scope and should pass it. */
  orgLocale?: string;
}

interface StandingsSlideSnapshotRow {
  entrantId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  rank?: number;
}

export function buildPublicDivisionSlides(data: PublicSlideInput): Slide[] {
  const orgLocale = toLocale(data.orgLocale);
  const lookup: SlotLabelLookup = (k, v) => msgFor(orgLocale, k, v);
  const names = Object.fromEntries(data.entrants.map((e) => [e.id, e.display_name]));
  const stageById = new Map(data.stages.map((s) => [s.id, s]));
  const poolById = new Map(data.pools.map((p) => [p.id, p]));
  const slides: Slide[] = [];

  for (const snap of data.standings) {
    const stage = stageById.get(snap.stage_id);
    if (!stage || snap.rows.length === 0) continue;
    const pool = snap.pool_id !== null ? poolById.get(snap.pool_id) : undefined;
    slides.push({
      kind: "standings",
      division: data.division.name,
      caption: pool !== undefined ? `${stage.name} — ${pool.name}` : stage.name,
      rows: snap.rows.map((r, i) => ({
        rank: r.rank ?? i + 1,
        name: names[r.entrantId] ?? "—",
        played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, points: r.points,
      })),
    });
  }

  const item = (f: PublicSlideInput["fixtures"][number]): FixtureSlideItem => ({
    home: f.home_entrant_id
      ? (names[f.home_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : resolveSlotLabel(f.home_slot_label ?? null, lookup, "schedule.tbd"),
    away: f.away_entrant_id
      ? (names[f.away_entrant_id] ?? resolveSlotLabel(null, lookup, "schedule.tbd"))
      : resolveSlotLabel(f.away_slot_label ?? null, lookup, "schedule.tbd"),
    homeLogo: null,
    awayLogo: null,
    line: f.summary?.headline ?? null,
    status: f.status,
    round: f.round_no,
  });
  const live = data.fixtures.filter((f) => f.status === "in_play").map(item);
  const results = data.fixtures
    .filter((f) => ["decided", "finalized", "forfeited"].includes(f.status))
    .slice(-8).map(item);
  const upcoming = data.fixtures.filter((f) => f.status === "scheduled").slice(0, 8).map(item);
  if (live.length > 0)
    slides.push({ kind: "fixtures", division: data.division.name, title: "In play", items: live, pinned: true });
  if (results.length > 0)
    slides.push({ kind: "fixtures", division: data.division.name, title: "Latest results", items: results });
  if (upcoming.length > 0)
    slides.push({ kind: "fixtures", division: data.division.name, title: "Coming up", items: upcoming });

  for (const stage of data.stages.filter((s) => BRACKET_SLIDE_KINDS.has(s.kind))) {
    const stageFixtures = data.fixtures.filter((f) => f.stage_id === stage.id);
    const refs = stageFixtures.map((f) => ({ id: f.id, round_no: f.round_no, seq_in_round: f.seq_in_round }));
    if (stageFixtures.length > 0 && bracketSlideLaysOut(stage.kind, refs)) {
      slides.push({
        kind: "bracket",
        division: data.division.name,
        title: stage.name,
        stageKind: stage.kind as "knockout" | "double_elim" | "stepladder" | "page_playoff",
        // P6 fix round 1, finding #2: home/away are fully resolved HERE
        // (never left null for an unfilled slot with a real label) so the
        // shared client <Slideshow> — which has no locale/<DictProvider>
        // plumbing anywhere in its tree and stays on the client-safe
        // English msg() for that reason — never has to guess at this org's
        // locale. Its own `f.home ?? resolveSlotLabel(f.home_slot_label,
        // msg, …)` fallback is now unreachable from this (public) builder;
        // it stays live for buildDivisionSlides's org-authed slides above,
        // which are a DIFFERENT, out-of-scope surface (not a "visitor").
        fixtures: stageFixtures.map((f) => ({
          id: f.id, round_no: f.round_no, seq_in_round: f.seq_in_round,
          home: f.home_entrant_id
            ? (names[f.home_entrant_id] ?? null)
            : resolveSlotLabel(f.home_slot_label ?? null, lookup, "bracket.tbd"),
          away: f.away_entrant_id
            ? (names[f.away_entrant_id] ?? null)
            : resolveSlotLabel(f.away_slot_label ?? null, lookup, "bracket.tbd"),
          home_slot_label: f.home_slot_label ?? null,
          away_slot_label: f.away_slot_label ?? null,
          line: f.summary?.headline ?? null,
          status: f.status,
        })),
      });
    }
  }

  return slides;
}
