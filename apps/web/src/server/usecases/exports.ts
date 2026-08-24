import "server-only";
// Rich exports (Jul3/06 §4–§6): assemble read-model data → pure DocModel →
// PDF/XLSX bytes. Branding is nulled for non-Pro AT THE MODEL LAYER (doc 10
// §2.3), and `printedAt` is the request time injected here so the engine
// stays clock-free.
import type postgres from "postgres";
import {
  buildAdmitTickets,
  buildAuditLedger,
  buildOfficialsRota,
  buildParticipants,
  buildRoster,
  buildBracket,
  buildBracketDe,
  buildLadderPoster,
  buildPagePoster,
  buildStandings,
  buildTimetable,
  DocModel,
  type BuildOpts,
  type DocBranding,
  type DocSection,
  type ExportFixture,
  type ExportOfficialSchedule,
  type ExportTicket,
  type PageBreaks,
} from "@seazn/engine/exports";
import { roundRole, type StandingsRow } from "@seazn/engine/competition";
import { roundRoleLabel } from "@/lib/round-role-label";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { fixtureWhen } from "@/lib/email-templates/official-assigned";
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { participantRows } from "./clubs";
import { resolveSponsors } from "./sponsors";
import { getMyOfficiating } from "./me-officiating";
import { eventRecorderNames, type AuditLedger } from "./fixtures";
// #14: the ONE court-name disambiguation rule (a bare name is unique only
// WITHIN its venue — courts_venue_name_active_idx is scoped per venue, so
// two venues may legally each name one "Court 1"). `courtNamesById` already
// resolves to the venue-qualified label via `buildCourtDirectory` — reused
// here rather than selecting the bare `courts.name` column, which is what
// let the officials rota PDF and the timetable/scoresheet exports show two
// indistinguishable "Court 1" entries for two different physical courts.
import { courtNamesById } from "./schedule";
import { siteOrigin } from "@/lib/site-origin";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

type Tx = postgres.TransactionSql;

/** Copy locale for a document nobody is "viewing".
 *
 *  An exported PDF is printed and pinned to a wall, or mailed to clubs — it
 *  has no single reader whose cookie could be consulted, so it uses the org's
 *  own default locale. This mirrors `calendar.ics/route.ts:32-33` exactly;
 *  the reasoning is recorded at that file's :24-30 and is the same reasoning
 *  here. Do NOT swap this for resolveLocale(). */
function exportLookup(defaultLocale: string | null): SlotLabelLookup {
  const locale = toLocale(defaultLocale);
  return (key, vars) => msgFor(locale, key, vars);
}

export interface ExportOpts {
  pageBreaks?: PageBreaks;
  landscape?: boolean;
  blank?: boolean;
  printedAt: string; // request time — injected, never Date.now() in the engine
}

interface DivisionMeta {
  id: string;
  name: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  default_locale: string;
  competition_id: string;
  competition_name: string;
  comp_slug: string;
  visibility: string;
  div_slug: string;
  branding: Record<string, unknown> | null;
  sport_key: string;
  module_version: string;
  config: unknown;
}

async function divisionMeta(tx: Tx, divisionId: string): Promise<DivisionMeta> {
  const [row] = await tx<DivisionMeta[]>`
    select d.id, d.name, d.org_id, org.name as org_name, org.slug as org_slug,
           org.default_locale,
           d.competition_id, c.name as competition_name, c.slug as comp_slug,
           c.visibility, d.slug as div_slug,
           c.branding, d.sport_key, d.module_version, d.config
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = d.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

/** Order fixtures so every court's sheets sit together, and flag the first
 *  fixture of each court so a page break can be put in front of it.
 *
 *  `pageBreaks=per_pitch` exists so an organiser can hand each court official
 *  their own pile. That only works if the sheets are grouped by court —
 *  `exportFixtures` orders by stage/round, which interleaves courts by design,
 *  so breaking on "the court changed" against that order breaks nearly every
 *  sheet and groups nothing.
 *
 *  Courts sort naturally ("Court 2" before "Court 10"), and fixtures with no
 *  court go last — they are the ones nobody can hand to a court yet. The sort
 *  is stable, so within a court the original stage/round order survives, which
 *  is the order play actually happens in. */
export function groupByCourt<T extends { court_id: string | null; court_name: string | null }>(
  fixtures: readonly T[],
): { fixture: T; startsNewCourt: boolean }[] {
  // P9: grouping keys on `court_id` (stable identity) while ORDERING by the
  // display name. Two venues may each hold a "Court 1"; keying the group on the
  // name would silently merge them into one stack.
  const ordered = [...fixtures].sort((a, b) => {
    if (a.court_id === b.court_id) return 0;
    if (a.court_id === null) return 1;
    if (b.court_id === null) return -1;
    // Name first (human order: "Court 2" before "Court 10"), then the id as a
    // TOTAL tie-break. Without the id, two same-named courts in different
    // venues compare equal, the sort leaves them interleaved, and their
    // fixtures never gather into one stack each — the exact merge that keying
    // on `court_id` exists to prevent.
    return (
      (a.court_name ?? "").localeCompare(b.court_name ?? "", undefined, { numeric: true }) ||
      (a.court_id < b.court_id ? -1 : a.court_id > b.court_id ? 1 : 0)
    );
  });
  let lastCourt: string | null | undefined;
  return ordered.map((fixture, i) => {
    const startsNewCourt = i > 0 && fixture.court_id !== lastCourt;
    lastCourt = fixture.court_id;
    return { fixture, startsNewCourt };
  });
}

// v12/Task 16: the live-page QR only points somewhere reachable — a
// `private` competition's `/shared/...` page 404s (V230 public_competitions_v
// gate), so no QR when private. `public`/`unlisted` both resolve.
export function liveUrlFor(meta: Pick<DivisionMeta, "visibility" | "org_slug" | "comp_slug" | "div_slug">): string | undefined {
  if (meta.visibility === "private") return undefined;
  return `${siteOrigin()}/shared/${meta.org_slug}/${meta.comp_slug}/${meta.div_slug}`;
}

// Jul3/06 §6 / v12: branding (club colours, sponsor logos, tournament
// styling) is the Pro layer — resolved server-side and simply absent
// otherwise. Shared by every caller so `resolveSponsors` is only ever
// called once per export: `brandingFor` layers division-level colour/logo
// overrides on top for the per-division exports; `buildCompetitionTimetable`
// (no DivisionMeta in hand) calls this directly.
async function orgBranding(
  orgId: string,
  orgName: string,
  competitionId: string,
): Promise<DocBranding | undefined> {
  // Scoped to the competition being exported — the same id handed to
  // resolveSponsors on the next line. `exports.branded` is an Event Pass key,
  // and resolving it org-wide made the pass invisible: a community org that
  // bought one still got a plain document for the competition it paid to brand
  // (Phase 2 pass-scoping sweep).
  if (!(await hasFeature(orgId, "exports.branded", competitionId))) return undefined;
  const sponsors = (await resolveSponsors(orgId, competitionId)).map((s) => ({
    name: s.name,
    tier: s.tier,
  }));
  return {
    orgName,
    ...(sponsors.length > 0 ? { sponsors } : {}),
  };
}

/**
 * The org name + competition id a branding lookup needs, read AHEAD of any
 * transaction.
 *
 * `orgBranding` awaits `hasFeature`, which queries the pooled `sql` proxy, and
 * every caller below used to reach it from INSIDE `withTenant` — a second pool
 * checkout while the first connection was still pinned, which is the
 * self-deadlock `lib/db.ts`'s nesting guard exists to catch. The scope must come
 * from somewhere the transaction has not opened yet, so it is read here.
 * Authorisation does not rest on it: the division is still read under RLS inside
 * the transaction, which 404s for a foreign org.
 */
async function brandingScope(
  divisionId: string,
): Promise<{ competition_id: string; org_name: string } | undefined> {
  const [row] = await sql<{ competition_id: string; org_name: string }[]>`
    select d.competition_id, org.name as org_name
    from divisions d join organizations org on org.id = d.org_id
    where d.id = ${divisionId}`;
  return row;
}

/**
 * The division-level layer on top of `orgBranding` — PURE, so it runs inside the
 * transaction on a `meta` the transaction read, while the entitlement half that
 * produced `base` stays outside it.
 */
function layerDivisionBranding(
  base: DocBranding | undefined,
  meta: DivisionMeta,
): DocBranding | undefined {
  if (base === undefined) return undefined;
  const branding = meta.branding ?? {};
  const colors: Record<string, string> = {};
  if (typeof branding.primary_color === "string") colors.primary = branding.primary_color;
  return {
    ...base,
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(typeof branding.logo_path === "string" ? { logos: [branding.logo_path] } : {}),
  };
}

interface FixtureExportRow {
  id: string;
  scheduled_at: string | null;
  /** P9: the real identity — the frozen `fixtures.court_label` column is
   *  never read here again. `court_name` is now resolved via the caller's
   *  `courtNames` map (#14: NOT a raw joined `courts.name` — two venues may
   *  legally share one bare name, and a plain join can't disambiguate). */
  court_id: string | null;
  court_name: string | null;
  round_no: number | null;
  stage_name: string;
  home_label: string | null;
  away_label: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  home_color: string | null;
  away_color: string | null;
  summary: { sides?: { line: string }[] } | null;
  status: string;
}

async function exportFixtures(
  tx: Tx,
  divisionId: string,
  courtNames: ReadonlyMap<string, string>,
): Promise<FixtureExportRow[]> {
  const rows = await tx<Omit<FixtureExportRow, "court_name">[]>`
    select f.id, f.scheduled_at::text as scheduled_at, f.court_id, f.round_no,
           s.name as stage_name,
           he.display_name as home_label,
           ae.display_name as away_label,
           f.home_slot_label, f.away_slot_label,
           htd.colors->>'primary' as home_color,
           atd.colors->>'primary' as away_color,
           m.summary, f.status
    from fixtures f
    join stages s on s.id = f.stage_id
    left join entrants he on he.id = f.home_entrant_id
    left join entrants ae on ae.id = f.away_entrant_id
    left join team_display_v htd on htd.team_id = he.team_id
    left join team_display_v atd on atd.team_id = ae.team_id
    left join match_states m on m.fixture_id = f.id
    where f.division_id = ${divisionId}
    order by s.seq, f.round_no, f.seq_in_round`;
  return rows.map((r) => ({
    ...r,
    court_name: r.court_id !== null ? (courtNames.get(r.court_id) ?? r.court_id) : null,
  }));
}

function toExportFixture(
  f: FixtureExportRow,
  divisionName: string,
  lookup: SlotLabelLookup,
): ExportFixture {
  const sides = f.summary?.sides;
  return {
    id: f.id,
    at: f.scheduled_at,
    court: f.court_name,
    stageName: f.stage_name,
    round: f.round_no,
    // A filled side wins; an empty one falls back to its placeholder label,
    // and only a side with neither reaches the localized TBD.
    home: f.home_label ?? resolveSlotLabel(f.home_slot_label, lookup, "schedule.tbd"),
    away: f.away_label ?? resolveSlotLabel(f.away_slot_label, lookup, "schedule.tbd"),
    ...(f.home_color !== null ? { homeColor: f.home_color } : {}),
    ...(f.away_color !== null ? { awayColor: f.away_color } : {}),
    divisionName,
    ...(f.status === "decided" && sides !== undefined && sides.length === 2
      ? { result: `${sides[0]!.line} – ${sides[1]!.line}` }
      : {}),
  };
}

// v12: per-kind blurb shown under the masthead (doc-render §Task 3). Was a
// module-level English map; the blurb is user-facing copy on a printed
// document, so it resolves through the document's own locale like every other
// string here. The key set lives in ui.json as `export.description.<kind>`.
// Spelled out rather than built as `export.description.${kind}`: a template
// literal is NOT assignable to the generated MsgKey union (i18n-keys.ts), so
// tsc could not tell a real key from a typo. This map is checked key-by-key,
// and adding a doc kind without adding its blurb is a compile error.
const DESCRIPTION_KEYS = {
  timetable: "export.description.timetable",
  standings: "export.description.standings",
  roster: "export.description.roster",
  participants: "export.description.participants",
  scoresheet: "export.description.scoresheet",
  bracket: "export.description.bracket",
} as const;

type ExportDocKind = keyof typeof DESCRIPTION_KEYS;

function descriptionFor(kind: ExportDocKind, lookup: SlotLabelLookup): string {
  return lookup(DESCRIPTION_KEYS[kind]);
}

/** Table chrome `build.ts` cannot resolve itself.
 *
 *  The engine carries no locale (engine-boundary / round-role.ts's header), so
 *  its column headers and its "no time yet" cell arrive pre-resolved from here
 *  — the same treatment `home`/`away` already get via `resolveSlotLabel`.
 *  Passing the whole block at every call site is deliberate: each builder reads
 *  only the sub-field it needs, and a doc kind gaining a table later then
 *  inherits the localized chrome instead of silently falling back to English.
 *
 *  `export.time.tbc` is a SEPARATE key from `schedule.tbd` on purpose: that one
 *  names an unknown ENTRANT ("TBD" as an opponent), this one names an unknown
 *  KICK-OFF TIME. They read alike in English and diverge in every other locale. */
// Exported for a direct unit test (exports.test.ts) — this function has no
// DB/tenant dependency of its own, so proving each field resolves for a
// given locale doesn't need the DB-fixture ceremony every other test in that
// file pays for. Every OTHER caller still goes through buildDivisionDocModel
// et al.; nothing outside the test file imports this.
export function exportChrome(lookup: SlotLabelLookup): NonNullable<BuildOpts["i18n"]> {
  return {
    timeTbc: lookup("export.time.tbc"),
    timetableColumns: [
      lookup("export.column.time"),
      lookup("export.column.court"),
      lookup("export.column.home"),
      "", // result/"vs" column — deliberately unlabeled, as it always has been
      lookup("export.column.away"),
      lookup("export.column.stage"),
    ],
    rotaColumns: [
      lookup("export.column.when"),
      lookup("export.column.court"),
      lookup("export.column.competitionDivision"),
      lookup("export.column.role"),
      lookup("export.column.match"),
      lookup("export.column.response"),
    ],
    participantsColumns: [
      lookup("export.column.club"),
      lookup("export.column.team"),
      lookup("export.column.division"),
      lookup("export.column.entrant"),
      lookup("export.column.player"),
      "#", // squad number — a glyph, not a word; nothing to translate
      lookup("export.column.position"),
    ],
    // F5 remainder — the VALUE fallbacks #630 left unwired (build.ts:52,76,
    // 198,209 and the four bracket-family builders' `?? "TBD"` sites).
    // `schedule.vs`/`bracket.tbd` are reused verbatim: same word, same
    // meaning, already resolved for exactly this concept elsewhere on this
    // very page (stages-panel.tsx/fixture-console.tsx for "vs", this file's
    // own bracket arm for "TBD" — see toExportFixture/the bracket case's
    // resolveSlotLabel calls). `board.unassigned` and `officials.resp*` are
    // the SAME reuse call for the same reason. `export.rota.noDuties` has no
    // existing counterpart anywhere else in the product, so it is new.
    resultVs: lookup("schedule.vs"),
    courtUnassigned: lookup("board.unassigned"),
    rotaNoDuties: lookup("export.rota.noDuties"),
    rotaResponseAccepted: lookup("officials.respAccepted"),
    rotaResponseDeclined: lookup("officials.respDeclined"),
    rotaResponsePending: lookup("officials.respPending"),
    entrantTbd: lookup("bracket.tbd"),
    // Repair pass (review of F5 remainder): build.ts:152/228's roster/rota
    // `signatures` arrays had no opts.i18n override at all — every sibling
    // field above them, added in the same original pass, already had one.
    rotaSignatures: [
      lookup("export.rota.signatureOfficial"),
      lookup("export.rota.signatureTimeOn"),
      lookup("export.rota.signatureTimeOff"),
    ],
    rosterSignatures: [
      lookup("export.roster.signatureCaptain"),
      lookup("export.roster.signatureOfficial"),
    ],
  };
}

/** The pure model for a division export — separated for golden-style tests;
 *  the route renders it to bytes. */
export async function buildDivisionDocModel(
  auth: AuthCtx,
  divisionId: string,
  kind: "timetable" | "standings" | "roster" | "participants" | "scoresheet" | "bracket",
  opts: ExportOpts,
): Promise<DocModel> {
  // Exports unlock via plan or an Event Pass on this competition (v3/07 §3).
  const expComp = await brandingScope(divisionId);
  await requireFeature(auth.orgId, "exports", expComp?.competition_id);
  const baseBranding = expComp
    ? await orgBranding(auth.orgId, expComp.org_name, expComp.competition_id)
    : undefined;
  // `participantRows` opens its OWN `withTenant`, and a nested transaction is
  // the same pool checkout by another name — so the one kind that needs it reads
  // it before this one opens. Every other kind pays nothing for that.
  const participants = kind === "participants" ? await participantRows(auth, { divisionId }) : null;
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const slotLookup = exportLookup(meta.default_locale);
    const branding = layerDivisionBranding(baseBranding, meta);
    const title = `${meta.competition_name} — ${meta.name}`;
    const common = {
      printedAt: opts.printedAt,
      description: descriptionFor(kind, slotLookup),
      i18n: exportChrome(slotLookup),
      ...(branding !== undefined ? { branding } : {}),
      ...(opts.pageBreaks !== undefined ? { pageBreaks: opts.pageBreaks } : {}),
      ...(opts.landscape !== undefined ? { landscape: opts.landscape } : {}),
    };

    const liveUrl = liveUrlFor(meta);

    switch (kind) {
      case "timetable": {
        const courtNames = await courtNamesById(tx);
        const fixtures = await exportFixtures(tx, divisionId, courtNames);
        return buildTimetable(title, fixtures.map((f) => toExportFixture(f, meta.name, slotLookup)), {
          ...common,
          ...(liveUrl !== undefined ? { liveUrl } : {}),
        });
      }
      case "standings": {
        const [snapshot] = await tx<{ rows: StandingsRow[] }[]>`
          select ss.rows from standings_snapshots ss
          join stages s on s.id = ss.stage_id
          where s.division_id = ${divisionId}
          order by s.seq desc, ss.updated_at desc limit 1`;
        if (!snapshot) throw new HttpError(404, "no standings yet");
        const names = await tx<{ id: string; display_name: string; badge_url: string | null }[]>`
          select id, display_name, badge_url from entrants where division_id = ${divisionId}`;
        const nameById = new Map(names.map((n) => [n.id, n.display_name]));
        // PROMPT-60: crests reach the PDF too (entrant badge only here — the
        // team-logo fallback stays a web concern; keep the export cheap).
        const badgeById = new Map(
          names.map((n) => [
            n.id,
            n.badge_url ? resolveEntrantBadge({ badge_url: n.badge_url }) : null,
          ]),
        );
        const sportModule = resolveModule(meta.sport_key, meta.module_version);
        const metricColumns = sportModule.metrics.slice(0, 4).map((m) => m.key);
        const rows = [...snapshot.rows]
          .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
          .map((r) => ({
            name: nameById.get(r.entrantId) ?? r.entrantId,
            played: r.played,
            won: r.won,
            drawn: r.drawn,
            lost: r.lost,
            points: r.points,
            metrics: r.metrics,
            ...(badgeById.get(r.entrantId) ? { badgeUrl: badgeById.get(r.entrantId) } : {}),
          }));
        return buildStandings(title, rows, {
          ...common,
          metricColumns,
          ...(liveUrl !== undefined ? { liveUrl } : {}),
        });
      }
      case "roster": {
        const teams = await tx<{
          entrant: string; club_name: string | null;
          players: { name: string; dob: string | null; number: number | null }[] | null;
        }[]>`
          select e.display_name as entrant, td.club_name,
                 (select json_agg(json_build_object(
                    'name', p.full_name, 'dob', p.dob::text, 'number', em.squad_number)
                    order by em.squad_number nulls last, p.full_name)
                  from entrant_members em join persons p on p.id = em.person_id
                  where em.entrant_id = e.id) as players
          from entrants e
          left join team_display_v td on td.team_id = e.team_id
          where e.division_id = ${divisionId} and e.status in ('registered','confirmed')
          order by e.display_name`;
        return buildRoster(
          title,
          teams.map((t) => ({
            teamName: t.entrant,
            ...(t.club_name !== null ? { clubName: t.club_name } : {}),
            players: (t.players ?? []).map((p) => ({
              name: p.name,
              ...(p.dob !== null ? { dob: p.dob } : {}),
              ...(p.number !== null ? { number: p.number } : {}),
            })),
          })),
          common,
        );
      }
      case "participants": {
        const rows = participants ?? [];
        return buildParticipants(
          title,
          rows.map((r) => ({
            club: r.club, team: r.team, division: r.division, entrant: r.entrant,
            player: r.player, number: r.squad_number, position: r.position,
          })),
          common,
        );
      }
      case "scoresheet": {
        const sportModule = resolveModule(meta.sport_key, meta.module_version);
        const courtNames = await courtNamesById(tx);
        const fixtures = await exportFixtures(tx, divisionId, courtNames);
        const sections: DocSection[] = [];
        const undecided = fixtures.filter((x) => x.status !== "decided");
        // per_pitch means "one printed stack per court", so the sheets have to
        // be grouped by court before anything is laid out. exportFixtures
        // orders by stage/round, which deliberately interleaves courts — the
        // old code broke a page "when the court changed" against that order and
        // so broke at nearly every sheet instead of at a handful of boundaries.
        const perPitch = (opts.pageBreaks ?? "auto") === "per_pitch";
        const plan = perPitch
          ? groupByCourt(undecided)
          : undecided.map((fixture) => ({ fixture, startsNewCourt: false }));
        for (const { fixture: f, startsNewCourt } of plan) {
          // Where this fixture's sheets begin. A sport template may emit more
          // than one section per fixture, so the break is anchored here rather
          // than at a section index — indexing sections against the fixture
          // list reads courts off the wrong fixture as soon as one does.
          const firstSection = sections.length;
          // Same fallback chain as toExportFixture: a filled side wins, an
          // empty one falls back to its placeholder label. ScoresheetInput.home
          // is a required string ("TBD feeds arrive pre-rendered" per its own
          // doc comment) — home_label/away_label are nullable now that the SQL
          // coalesce is gone, so this resolution can't be skipped here either.
          const homeLabel = f.home_label ?? resolveSlotLabel(f.home_slot_label, slotLookup, "schedule.tbd");
          const awayLabel = f.away_label ?? resolveSlotLabel(f.away_slot_label, slotLookup, "schedule.tbd");
          const input = {
            home: homeLabel,
            away: awayLabel,
            ...(f.home_color !== null ? { homeColor: f.home_color } : {}),
            ...(f.away_color !== null ? { awayColor: f.away_color } : {}),
            ...(f.scheduled_at !== null ? { at: f.scheduled_at } : {}),
            ...(f.court_name !== null ? { court: f.court_name } : {}),
            stageName: f.stage_name,
            ...(opts.blank === true ? { blank: true } : {}),
          };
          const fragment = sportModule.exportTemplates?.scoresheet;
          if (fragment !== undefined) {
            sections.push(...fragment(input, meta.config as never));
          } else {
            // sport without a bespoke sheet: a generic result form
            sections.push({
              heading: `${homeLabel} ${slotLookup("schedule.vs")} ${awayLabel}`,
              subheading: [f.scheduled_at, f.court_name, f.stage_name]
                .filter((x): x is string => x !== null)
                .join(" · "),
              formLines: [
                slotLookup("export.scoresheet.result"),
                slotLookup("export.scoresheet.notes"),
              ],
              signatures: [
                slotLookup("export.scoresheet.referee"),
                slotLookup("export.scoresheet.captainOf", { name: homeLabel }),
                slotLookup("export.scoresheet.captainOf", { name: awayLabel }),
              ],
            });
          }
          const start = sections[firstSection];
          if (startsNewCourt && firstSection > 0 && start !== undefined) {
            start.pageBreakBefore = true;
          }
        }
        return DocModel.parse({
          kind: "scoresheet",
          title,
          description: descriptionFor("scoresheet", slotLookup),
          meta: { printedAt: opts.printedAt },
          ...(branding !== undefined ? { branding } : {}),
          sections,
          pageBreaks: opts.pageBreaks ?? "auto",
        });
      }
      case "bracket": {
        // PROMPT-62 §4 (+G-audit): the first bracket-shaped stage as a
        // landscape poster — single-elim tree, double-elim lanes, or
        // stepladder rungs.
        const [stage] = await tx<{ id: string; kind: string }[]>`
          select id, kind from stages
          where division_id = ${divisionId} and kind in ('knockout', 'double_elim', 'stepladder', 'page_playoff')
          order by seq limit 1`;
        if (!stage) throw new HttpError(422, "this division has no bracket stage to poster", "BRACKET_NOT_AVAILABLE");
        const fixtures = await tx<
          {
            id: string; round_no: number; seq_in_round: number;
            home_entrant_id: string | null; away_entrant_id: string | null;
            home_slot_label: SlotLabel | null; away_slot_label: SlotLabel | null;
            outcome: unknown; headline: string | null;
          }[]
        >`
          select f.id, f.round_no, f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
                 f.home_slot_label, f.away_slot_label,
                 f.outcome, ms.summary->>'headline' as headline
          from fixtures f
          left join match_states ms on ms.fixture_id = f.id
          where f.stage_id = ${stage.id}
          order by f.round_no, f.seq_in_round`;
        if (fixtures.length === 0) {
          throw new HttpError(422, "the bracket hasn't been generated yet", "BRACKET_NOT_AVAILABLE");
        }
        const names = await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where division_id = ${divisionId}`;
        const nameById = new Map(names.map((n) => [n.id, n.display_name]));
        const exportFixtures = fixtures.map((f) => ({
          id: f.id,
          round_no: f.round_no,
          seq_in_round: f.seq_in_round,
          // A filled side wins; an empty one falls back to its placeholder
          // label — same fallback chain as toExportFixture/the scoresheet
          // loop, but "bracket.tbd" is THIS surface's own established
          // fallback key: bracket-panel.tsx, public-site/bracket.tsx and
          // slideshow.tsx already resolve every other bracket-shaped view
          // through it, never schedule.tbd. `nameById.get(...) ?? null`
          // (entrant_id set but the name lookup somehow missed) is left as
          // a bare null on purpose — that is a data-integrity edge case,
          // not a day-one placeholder, and out of this scope.
          home: f.home_entrant_id
            ? (nameById.get(f.home_entrant_id) ?? null)
            : resolveSlotLabel(f.home_slot_label, slotLookup, "bracket.tbd"),
          away: f.away_entrant_id
            ? (nameById.get(f.away_entrant_id) ?? null)
            : resolveSlotLabel(f.away_slot_label, slotLookup, "bracket.tbd"),
          headline: f.headline,
          decided: f.outcome !== null,
        }));
        const buildOpts = { ...common, ...(liveUrl !== undefined ? { liveUrl } : {}) };
        if (stage.kind === "double_elim") {
          return buildBracketDe(title, exportFixtures, {
            // bracket.winners/losers/grandFinal/reset are the SAME keys
            // bracket-panel.tsx and public-site/bracket.tsx already render
            // for the live double-elim lane headers — reused rather than
            // duplicated under a new bracket.poster.* prefix, so the
            // printed poster and the live page say the exact same word in
            // every locale instead of drifting onto a second vocabulary.
            winners: slotLookup("bracket.winners"),
            losers: slotLookup("bracket.losers"),
            grandFinal: slotLookup("bracket.grandFinal"),
            reset: slotLookup("bracket.reset"),
          }, buildOpts);
        }
        if (stage.kind === "page_playoff") {
          return buildPagePoster(title, exportFixtures, {
            // Same reuse: these are the exact round-name keys
            // roundRoleLabel() already resolves for qualifier1/eliminator/
            // qualifier2/final everywhere else in the product.
            q1: slotLookup("bracket.round.qualifier1"),
            eliminator: slotLookup("bracket.round.eliminator"),
            q2: slotLookup("bracket.round.qualifier2"),
            final: slotLookup("bracket.round.final"),
          }, { ...buildOpts, description: slotLookup("export.description.pagePlayoff") });
        }
        if (stage.kind === "stepladder") {
          return buildLadderPoster(
            title,
            exportFixtures,
            (i) =>
              i === exportFixtures.length - 1
                ? slotLookup("bracket.round.final")
                : slotLookup("bracket.round.rung", { n: i + 1 }),
            buildOpts,
          );
        }
        // F1 Task 4 / F4 bracket-poster scope (owner-approved): buildBracket
        // takes the round-name resolution as an injected callback — the
        // engine cannot carry English (round-role.ts's header). This whole
        // case arm used to pass hardcoded English text directly (the
        // laneLabels/Page-playoff/ladder chrome above were raw string
        // literals, not even routed through msg()) because "this export
        // surface has never been locale-aware". Wave A made the rest of the
        // export path locale-aware, so the bracket poster's chrome and round
        // names now resolve through the same org-locale slotLookup instead
        // of the client-safe English default.
        return buildBracket(
          title,
          exportFixtures,
          (fromEnd) =>
            roundRoleLabel(
              slotLookup,
              roundRole({
                stageKind: "knockout",
                lane: null,
                roundInLane: 0,
                lastRoundInLane: fromEnd,
                isFinal: false,
                thirdPlace: false,
                conditional: false,
                extKey: null,
              }),
            ),
          buildOpts,
        );
      }
    }
  });
}

/** Competition-wide pretty timetable (Jul3/06 §5): all divisions, one doc. */
export async function buildCompetitionTimetable(
  auth: AuthCtx,
  competitionId: string,
  opts: ExportOpts,
): Promise<DocModel> {
  await requireFeature(auth.orgId, "exports", competitionId);
  // Outside the transaction — `orgBranding` awaits `hasFeature`, a pooled read.
  // Same reasoning as `brandingScope` above.
  const [compRef] = await sql<{ org_id: string; org_name: string }[]>`
    select c.org_id, org.name as org_name
    from competitions c join organizations org on org.id = c.org_id
    where c.id = ${competitionId}`;
  const branding = compRef
    ? await orgBranding(compRef.org_id, compRef.org_name, competitionId)
    : undefined;
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ name: string; org_id: string; org_name: string; default_locale: string }[]>`
      select c.name, c.org_id, org.name as org_name, org.default_locale
      from competitions c join organizations org on org.id = c.org_id
      where c.id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    // Own org row, own lookup — this function reads a different meta row than
    // divisionMeta (a competition can outlive/outspan any one division), so it
    // cannot reuse buildDivisionDocModel's slotLookup.
    const slotLookup = exportLookup(comp.default_locale);
    const divisions = await tx<{ id: string; name: string }[]>`
      select id, name from divisions where competition_id = ${competitionId} order by name`;
    const courtNames = await courtNamesById(tx);
    const all: ExportFixture[] = [];
    for (const d of divisions) {
      const fixtures = await exportFixtures(tx, d.id, courtNames);
      all.push(...fixtures.map((f) => toExportFixture(f, d.name, slotLookup)));
    }
    return buildTimetable(comp.name, all, {
      printedAt: opts.printedAt,
      description: slotLookup("export.description.allFixtures"),
      i18n: exportChrome(slotLookup),
      ...(branding !== undefined ? { branding } : {}),
      pageBreaks: opts.pageBreaks ?? "per_division",
    });
  });
}

// --- v12: officials rota + admit tickets (Task 13) --------------------------

interface OfficialDutyRow {
  official_id: string;
  official_name: string;
  scheduled_at: string | null;
  venue_tz: string | null;
  /** P9: derived from `courts` via `fixtures.court_id`; the frozen
   *  `fixtures.court_label` column is not read. #14: `court_name` is
   *  resolved via the caller's `courtNames` map, not a raw joined
   *  `courts.name` — two venues may legally share one bare name. */
  court_id: string | null;
  court_name: string | null;
  comp_name: string;
  div_name: string;
  role_key: string;
  response: "pending" | "accepted" | "declined";
  home: string | null;
  away: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
}

async function officialDutyRows(
  tx: Tx,
  divisionId: string,
  courtNames: ReadonlyMap<string, string>,
): Promise<OfficialDutyRow[]> {
  const rows = await tx<Omit<OfficialDutyRow, "court_name">[]>`
    select o.id as official_id, o.display_name as official_name,
           f.scheduled_at::text as scheduled_at, coalesce(ss.tz, vorg.timezone, 'UTC') as venue_tz, f.court_id,
           c.name as comp_name, d.name as div_name,
           fo.role_key, fo.response,
           h.display_name as home, a.display_name as away,
           f.home_slot_label, f.away_slot_label
    from fixture_officials fo
    join officials o on o.id = fo.official_id
    join fixtures f on f.id = fo.fixture_id
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations vorg on vorg.id = d.org_id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where f.division_id = ${divisionId}
      and f.status in ('scheduled', 'in_play')
    order by o.display_name, f.scheduled_at nulls last`;
  return rows.map((r) => ({
    ...r,
    court_name: r.court_id !== null ? (courtNames.get(r.court_id) ?? r.court_id) : null,
  }));
}

/** Officials rota for a single division (v12/Task 13): every official with a
 *  duty on a still-live fixture, grouped by official, one section per page
 *  (13 May pattern). Org-scoped read; branding via the Task 7 helper. */
export async function buildOfficialsRotaDoc(
  auth: AuthCtx,
  divisionId: string,
  opts: ExportOpts,
): Promise<DocModel> {
  // Exports unlock via plan or an Event Pass on this competition (v3/07 §3),
  // same gate as buildDivisionDocModel — deferred at Task 13, added here.
  const expComp = await brandingScope(divisionId);
  await requireFeature(auth.orgId, "exports", expComp?.competition_id);
  const baseBranding = expComp
    ? await orgBranding(auth.orgId, expComp.org_name, expComp.competition_id)
    : undefined;
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const slotLookup = exportLookup(meta.default_locale);
    const branding = layerDivisionBranding(baseBranding, meta);
    const courtNames = await courtNamesById(tx);
    const rows = await officialDutyRows(tx, divisionId, courtNames);
    const byOfficial = new Map<string, ExportOfficialSchedule>();
    for (const r of rows) {
      const s = byOfficial.get(r.official_id) ?? { officialName: r.official_name, duties: [] };
      s.duties.push({
        at: fixtureWhen(r.scheduled_at, r.venue_tz),
        court: r.court_name,
        compDivision: `${r.comp_name} · ${r.div_name}`,
        role: r.role_key,
        opponents: `${r.home ?? resolveSlotLabel(r.home_slot_label, slotLookup, "schedule.tbd")} ${slotLookup("schedule.vs")} ${r.away ?? resolveSlotLabel(r.away_slot_label, slotLookup, "schedule.tbd")}`,
        response: r.response,
      });
      byOfficial.set(r.official_id, s);
    }
    return buildOfficialsRota(
      // Title is user-facing copy on the same printed page as the description
      // directly below it — leaving it English while translating the blurb
      // would ship a half-translated masthead.
      `${meta.competition_name} — ${slotLookup("export.title.officialsRota")}`,
      [...byOfficial.values()],
      {
        printedAt: opts.printedAt,
        description: slotLookup("export.description.officialsRota"),
        i18n: exportChrome(slotLookup),
        ...(branding !== undefined ? { branding } : {}),
        pageBreaks: "per_team",
      },
    );
  });
}

interface CompetitionTicketMeta {
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  org_id: string;
  org_name: string;
  /** Copy locale for the ticket's own chrome — the printed document has no
   *  single reader, so it takes the org's default, same rule as every other
   *  export here (`exportLookup`'s doc comment). */
  default_locale: string;
}

async function competitionTicketMeta(tx: Tx, competitionId: string): Promise<CompetitionTicketMeta> {
  const [row] = await tx<CompetitionTicketMeta[]>`
    select c.name, c.starts_on::text as starts_on, c.ends_on::text as ends_on,
           c.org_id, org.name as org_name, org.default_locale
    from competitions c
    join organizations org on org.id = c.org_id
    where c.id = ${competitionId}`;
  if (!row) throw new HttpError(404, "competition not found");
  return row;
}

interface TicketRegistrationRow {
  ref_code: string;
  display_name: string;
  status: string;
  player_name_display: string | null;
  youth: boolean;
}

async function ticketRegistrationRows(tx: Tx, competitionId: string): Promise<TicketRegistrationRow[]> {
  return tx<TicketRegistrationRow[]>`
    select g.ref_code, r.display_name, r.status, d.player_name_display, d.youth
    from registrations r
    join divisions d on d.id = r.division_id
    join registration_groups g on g.id = r.group_id
    where d.competition_id = ${competitionId}
      and r.status = 'confirmed' and g.ref_code is not null
    order by r.created_at`;
}

/** Admit tickets for a competition (v12/Task 13): every confirmed
 *  registration becomes a 2-up ticket, name-masked the same way the public
 *  /r/[ref] status page does; the QR is carried as a URL only (Task 12
 *  draws pixels). Org-scoped read; branding via the Task 7 helper. */
export async function buildAdmitTicketsDoc(
  auth: AuthCtx,
  competitionId: string,
  opts: ExportOpts,
): Promise<DocModel> {
  await requireFeature(auth.orgId, "exports", competitionId);
  // Outside the transaction — see `brandingScope` above.
  const [compRef] = await sql<{ org_id: string; org_name: string }[]>`
    select c.org_id, org.name as org_name
    from competitions c join organizations org on org.id = c.org_id
    where c.id = ${competitionId}`;
  const branding = compRef
    ? await orgBranding(compRef.org_id, compRef.org_name, competitionId)
    : undefined;
  return withTenant(auth.orgId, async (tx) => {
    const meta = await competitionTicketMeta(tx, competitionId);
    const rows = await ticketRegistrationRows(tx, competitionId);
    // Tickets come from `registrations`, not `entrants`: a competition whose
    // organiser added entrants directly has nothing to admit anyone with.
    // Rendering that as an empty branded page returned a 200 PDF that looked
    // exactly like a working export, so refuse the way the bracket arm does.
    if (rows.length === 0) {
      throw new HttpError(
        422,
        "this competition has no confirmed registrations to ticket",
        "TICKETS_NOT_AVAILABLE",
      );
    }
    const dates = `${meta.starts_on ?? "—"} – ${meta.ends_on ?? meta.starts_on ?? "—"}`;
    const tickets: ExportTicket[] = rows.map((r, i) => ({
      maskedName: maskDisplayName(r.display_name, resolveNameDisplay(r.player_name_display, r.youth)),
      competition: meta.name,
      dates,
      ref: r.ref_code,
      status: r.status.toUpperCase(),
      qrUrl: `${siteOrigin()}/r/${r.ref_code}`,
      seq: i + 1,
    }));
    return buildAdmitTickets(meta.name, tickets, {
      printedAt: opts.printedAt,
      description: exportLookup(meta.default_locale)("export.description.ticket"),
      ...(branding !== undefined ? { branding } : {}),
    });
  });
}

/** My officiating rota (v12/Task 13): cross-org, SEAZN-neutral (no org
 *  branding — the reader officiates for many organisations at once).
 *  Sourced from the same superuser read the /me officiating lane uses. */
export async function buildMyRotaDoc(
  userId: string,
  opts: ExportOpts,
): Promise<DocModel> {
  const { assignments } = await getMyOfficiating(userId);
  // Cross-org doc, so there is no single org `default_locale` to take the
  // document's OWN title/description/columns from. Checked (F5/Task 6): there
  // IS a reader-level preference — `users.locale` (V281: "the signed-in pick",
  // nullable, CHECK-constrained to the four locales), reachable from the
  // `userId` already in hand, and this document has exactly one reader. So the
  // doc-level chrome follows the READER; the per-duty rows below keep following
  // each duty's own org locale, which is right for a row naming that org's
  // competition. `toLocale` (inside exportLookup) turns a never-chosen null
  // into the default, so a user who has never picked still gets English.
  // Superuser read, deliberately: `buildMyRotaDoc` never opens a tenant door
  // (an official is usually not an org member — see me-officiating.ts's header).
  const [me] = await sql<{ locale: string | null }[]>`
    select locale from users where id = ${userId}`;
  const docLookup = exportLookup(me?.locale ?? null);
  const byOfficial = new Map<string, ExportOfficialSchedule>();
  for (const a of assignments) {
    const key = a.official_id;
    const s = byOfficial.get(key) ?? { officialName: a.org_name, duties: [] };
    // Cross-org doc: each duty is localized by ITS OWN org's default locale,
    // not one global choice — the reader officiates for many organisations.
    const lookup = exportLookup(a.org_default_locale);
    s.duties.push({
      at: fixtureWhen(a.scheduled_at, a.venue_tz),
      court: a.court_name,
      compDivision: `${a.competition_name} · ${a.division_name}`,
      role: a.role_key,
      opponents: `${a.home_name ?? resolveSlotLabel(a.home_slot_label, lookup, "schedule.tbd")} ${lookup("schedule.vs")} ${a.away_name ?? resolveSlotLabel(a.away_slot_label, lookup, "schedule.tbd")}`,
      response: a.response,
    });
    byOfficial.set(key, s);
  }
  return buildOfficialsRota(docLookup("export.title.myRota"), [...byOfficial.values()], {
    printedAt: opts.printedAt,
    description: docLookup("export.description.myRota"),
    i18n: exportChrome(docLookup),
    pageBreaks: "per_team",
  });
}

// --- v13: signed audit ledger PDF (PROMPT-63 §2) -----------------------------

/** Human-readable signed audit trail for one fixture: the hash-chained event
 *  stream as a table, verification verdict + head hash + signature in the
 *  description. Gating happens at the route (`scoring.audit_export`); this
 *  assembles the model with the org's branded chrome where entitled. */
export async function auditLedgerDoc(
  auth: AuthCtx,
  fixtureId: string,
  ledger: AuditLedger,
  signature: { key_id: string; issued_at: string } | null,
  opts: { printedAt: string },
): Promise<DocModel> {
  const recorders = await eventRecorderNames(auth, fixtureId);
  const [meta] = await sql<{ division_id: string }[]>`
    select division_id from fixtures where id = ${fixtureId}`;
  const scope = meta ? await brandingScope(meta.division_id) : undefined;
  const baseBranding = scope
    ? await orgBranding(auth.orgId, scope.org_name, scope.competition_id)
    : undefined;
  return withTenant(auth.orgId, async (tx) => {
    const divMeta = await divisionMeta(tx, meta!.division_id);
    const lookup = exportLookup(divMeta.default_locale);
    const branding = layerDivisionBranding(baseBranding, divMeta);
    // No slot-label fallback here, deliberately: an audit ledger is the
    // forensic record of a fixture that has already been scored, so both
    // sides are always filled entrants. A placeholder cannot reach this doc.
    const vs =
      ledger.fixture.home !== null || ledger.fixture.away !== null
        ? ` — ${ledger.fixture.home ?? "TBD"} ${lookup("schedule.vs")} ${ledger.fixture.away ?? "TBD"}`
        : "";
    return buildAuditLedger(
      `${divMeta.competition_name} — ${divMeta.name}${vs}`,
      {
        events: ledger.events.map((e) => ({
          seq: e.seq,
          at: e.recorded_at,
          actor: e.recorded_by ? (recorders[e.recorded_by] ?? e.recorded_by.slice(0, 8)) : "—",
          type: e.type,
          detail: JSON.stringify(e.payload ?? {}).slice(0, 80),
          voids: e.voids_event_id !== null ? "void" : "",
        })),
        verified: ledger.verified,
        firstTamperedSeq: ledger.first_tampered_seq,
        headHash: ledger.head_hash,
        signature,
      },
      { printedAt: opts.printedAt, ...(branding !== undefined ? { branding } : {}) },
    );
  });
}
