// Public hub query perf T4 (2026-09-27): the match-centre loaders' independent
// reads run together, the loader reads the fixture/division/stage configs in
// one statement (and not at all where the caller already read those rows), the
// correlated `fixtures` subselects became one lateral probe, and the poster
// takes the stage name the page loader already returns. PERF ONLY — every
// document must come out identical.
//
// So each loader is diffed against its own pre-T4 body, frozen below from
// e5848d2f3: `loadMatchCentre` (with its private `loadSides`/`maskSideNames`),
// the body `getPublicFixture` caches, `publicFixture` with its context read,
// and `loadMatchPosterModel`. The frozen copies call today's helpers, which T4
// did not change, so what differs between the two sides is what T4 changed.
// The clock is frozen for both sides: the match centre reads `new Date()`.
//
// Swept over EVERY fixture of a realistic competition
// (`_public-loaders-scene.ts`): both sides waiting on feeders, one side
// waiting, byes played as forfeits, decided, in play, a withdrawn entrant's
// matches, a setup division's. Real Postgres required; skipped without
// DATABASE_URL.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

/** Every tagged-template statement's text, and the peak awaiting Postgres at once. */
const probe = vi.hoisted(() => ({ inFlight: 0, peak: 0, texts: [] as string[] }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const counted = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const query = Reflect.apply(target, thisArg, args) as PromiseLike<unknown>;
      const head = args[0];
      if (!(Array.isArray(head) && "raw" in head)) return query;
      probe.texts.push((head as string[]).join("$").replace(/\s+/g, " "));
      return (async () => {
        probe.inFlight += 1;
        probe.peak = Math.max(probe.peak, probe.inFlight);
        try {
          return await query;
        } finally {
          probe.inFlight -= 1;
        }
      })();
    },
  });
  return { ...actual, sql: counted };
});

/** Every argument list `resolveFixtureCfg` receives. The configs a loader hands
 *  the resolver mostly cannot show in a document — a frozen snapshot wins
 *  outright, and a stage config counts only through `rules` or a decider key —
 *  so the configs are compared where they are consumed, not downstream. */
const resolverArgs = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return {
    ...actual,
    resolveFixtureCfg: (...args: Parameters<typeof actual.resolveFixtureCfg>) => {
      resolverArgs.calls.push(args);
      return actual.resolveFixtureCfg(...args);
    },
  };
});

import type postgres from "postgres";
import { resolveVoids, type EventEnvelope } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { HttpError } from "@/lib/errors";
import { getDictionary, t, toLocale } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import { disambiguatedShorts, isoDateTime, servingSide } from "@/lib/public-site";
import { rulesLineText } from "@/lib/rules-line";
import { resolveSlotLabel } from "@/lib/slot-label";
import { resolveVenueTz } from "@/lib/tz";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { resolveLatestModule, resolveModule } from "@/server/engine-db/registry";
import { matchPosterModel } from "@/server/og/match-poster";
import { loadMatchPosterModel } from "@/server/og/match-poster-data";
import { posterImageDataUrl } from "@/server/og/poster-image";
import { publicFixture } from "@/server/usecases/public";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { venueTzRow } from "@/server/venue-tz";
import {
  getPublicCompetition,
  getPublicFixture,
  maskPublicEntrantNames,
  withCourtVenueName,
  type PublicCompetitionShell,
  type PublicDivision,
  type PublicFixture,
} from "../data";
import { effectiveRulesLine } from "../describe-rules";
import { publicRoundNamer } from "../feeder-slot-label";
import { buildMatchCentre, type MatchCentreInput } from "../match-centre";
import { loadMatchCentre, type MatchCentreLoadCtx } from "../match-centre-load";
import type { MatchCentreDocT, MsgT, SideT } from "../match-centre-schema";
import { readPublicLineups } from "../public-lineups";
import { variantLabel } from "../variant-label";
import { seedLoadersScene, type LoadersScene } from "./_public-loaders-scene";

const HAS_DB = !!process.env.DATABASE_URL;
type Sql = ReturnType<typeof postgres>;

// ── Frozen pre-T4 bodies (e5848d2f3). The differential oracle; never call ──
// ── these from product code.                                              ──

async function maskSideNamesBefore(
  q: Sql,
  entrants: { id: string; kind: string; display_name: string }[],
  division: { youth: boolean; playerNameDisplay: string | null },
): Promise<Map<string, string>> {
  const nonTeamIds = entrants.filter((e) => e.kind !== "team").map((e) => e.id);
  const consentRows =
    nonTeamIds.length > 0
      ? await q<{ entrant_id: string; consent: { public_name?: boolean } | null }[]>`
          select em.entrant_id, p.consent
          from entrant_members em
          join persons p on p.id = em.person_id
          where em.entrant_id in ${q(nonTeamIds)} and p.merged_into is null`
      : [];
  const consentsByEntrant = new Map<string, ({ public_name?: boolean } | null)[]>();
  for (const r of consentRows) {
    const list = consentsByEntrant.get(r.entrant_id) ?? [];
    list.push(r.consent);
    consentsByEntrant.set(r.entrant_id, list);
  }
  const names = new Map<string, string>();
  for (const e of entrants) {
    if (e.kind === "team") {
      names.set(e.id, e.display_name);
      continue;
    }
    const optedOut = anyOptedOut(consentsByEntrant.get(e.id) ?? []);
    names.set(
      e.id,
      resolvePersonDisplayName(e.display_name, optedOut ? { public_name: false } : null, division.playerNameDisplay, division.youth),
    );
  }
  return names;
}

interface SidePreBefore {
  entrantId: string;
  name: string;
  colour: string | null;
  badgeUrl: string | null;
  isPerson: boolean;
}

async function loadSidesBefore(
  q: Sql,
  fixture: Pick<PublicFixture, "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label">,
  division: { youth: boolean; playerNameDisplay: string | null },
  slot: (label: SlotLabel | null, seat: "home" | "away") => string,
): Promise<[SideT, SideT]> {
  const ids = [fixture.home_entrant_id, fixture.away_entrant_id].filter((id): id is string => id !== null);
  const rows =
    ids.length > 0
      ? await q<
          {
            id: string;
            kind: string;
            display_name: string;
            badge_url: string | null;
            team_display: { logo_path: string | null; colors: unknown } | null;
          }[]
        >`
          select id, kind, display_name, badge_url, team_display
          from public_entrants_v where id in ${q(ids)}`
      : [];
  const maskedNames = rows.length > 0 ? await maskSideNamesBefore(q, rows, division) : new Map<string, string>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sideOf = (entrantId: string | null, slotLabel: SlotLabel | null, seat: "home" | "away"): SidePreBefore => {
    if (entrantId === null) {
      const name = slot(slotLabel, seat);
      return { entrantId: "", name, colour: null, badgeUrl: null, isPerson: false };
    }
    const row = byId.get(entrantId);
    if (!row) return { entrantId, name: "?", colour: null, badgeUrl: null, isPerson: false };
    const name = maskedNames.get(entrantId) ?? row.display_name;
    const colors = row.team_display?.colors as { home_primary?: string } | null | undefined;
    return {
      entrantId,
      name,
      colour: colors?.home_primary ?? null,
      badgeUrl: resolveEntrantBadge({ badge_url: row.badge_url, team_logo_path: row.team_display?.logo_path ?? null }),
      isPerson: row.kind !== "team",
    };
  };
  const home = sideOf(fixture.home_entrant_id, fixture.home_slot_label, "home");
  const away = sideOf(fixture.away_entrant_id, fixture.away_slot_label, "away");
  const [homeShort, awayShort] = disambiguatedShorts(home, away);
  return [
    { entrantId: home.entrantId, name: home.name, short: homeShort, colour: home.colour, badgeUrl: home.badgeUrl },
    { entrantId: away.entrantId, name: away.name, short: awayShort, colour: away.colour, badgeUrl: away.badgeUrl },
  ];
}

async function loadMatchCentreBefore(q: Sql, fixture: PublicFixture, ctx: MatchCentreLoadCtx): Promise<MatchCentreDocT> {
  const eventRows = await q<
    {
      id: string;
      seq: number;
      type: string;
      payload: unknown;
      recorded_at: Date;
      recorded_by: string | null;
      voids_event_id: string | null;
    }[]
  >`
    select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
    from score_events where fixture_id = ${fixture.id} order by seq`;
  const envelopes: EventEnvelope[] = eventRows.map((r) => ({
    id: r.id,
    fixtureId: fixture.id,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
  }));
  const events = resolveVoids(envelopes);
  const [fixtureRow] = await q<{ config_snapshot: unknown }[]>`
    select config_snapshot from fixtures where id = ${fixture.id}`;
  const [divisionRow] = await q<{ config: unknown }[]>`
    select config from divisions where id = ${fixture.division_id}`;
  const [stageRow] = await q<{ config: Record<string, unknown> | null; kind: string }[]>`
    select config, kind from stages where id = ${fixture.stage_id}`;
  const rawCfg = resolveFixtureCfg(fixtureRow?.config_snapshot, divisionRow?.config, stageRow?.config);
  const sportModule =
    ctx.division.moduleVersion !== null
      ? resolveModule(ctx.division.sportKey, ctx.division.moduleVersion)
      : resolveLatestModule(ctx.division.sportKey);
  const parsedCfg = sportModule.configSchema.safeParse(rawCfg);
  const cfg = parsedCfg.success ? parsedCfg.data : rawCfg;
  // main's per-stage format label (c86254b6a), which landed after the freeze.
  const rulesLine = effectiveRulesLine(ctx.division.sportKey, sportModule, rawCfg, divisionRow?.config);
  const formatLabel =
    rulesLine === null
      ? ctx.division.formatLabel
      : rulesLineText(await getDictionary(toLocale(ctx.locale), "public"), rulesLine);
  const lineups = await readPublicLineups(q, fixture.id, {
    youth: ctx.division.youth,
    player_name_display: ctx.division.playerNameDisplay,
  });
  let slot: (label: SlotLabel | null, seat: "home" | "away") => string = (label) =>
    resolveSlotLabel(label, ctx.slotLabelLookup, "schedule.tbd");
  if (fixture.home_entrant_id === null || fixture.away_entrant_id === null) {
    const stageRows = await q<
      {
        id: string;
        stage_id: string;
        round_no: number;
        seq_in_round: number;
        lane: "WB" | "LB" | "GF" | null;
        is_final: boolean | null;
        third_place: boolean | null;
        conditional: boolean | null;
        ext_key: string | null;
        winner_to_fixture: string | null;
        winner_to_slot: number | null;
        loser_to_fixture: string | null;
        loser_to_slot: number | null;
      }[]
    >`
      select id, stage_id, round_no, seq_in_round, lane, is_final, third_place, conditional,
             (select x.ext_key from fixtures x where x.id = public_fixtures_v.id) as ext_key,
             (select x.winner_to_fixture from fixtures x where x.id = public_fixtures_v.id) as winner_to_fixture,
             (select x.winner_to_slot    from fixtures x where x.id = public_fixtures_v.id) as winner_to_slot,
             (select x.loser_to_fixture  from fixtures x where x.id = public_fixtures_v.id) as loser_to_fixture,
             (select x.loser_to_slot     from fixtures x where x.id = public_fixtures_v.id) as loser_to_slot
      from public_fixtures_v where stage_id = ${fixture.stage_id}`;
    const namer = publicRoundNamer({
      ui: ctx.slotLabelLookup,
      dict: await getDictionary(toLocale(ctx.locale), "public"),
      fixtures: stageRows,
      stageKind: () => stageRow?.kind,
    });
    slot = (label, seat) => namer.seat(fixture.id, seat, label);
  }
  const sides = await loadSidesBefore(
    q,
    fixture,
    { youth: ctx.division.youth, playerNameDisplay: ctx.division.playerNameDisplay },
    slot,
  );
  const venueTz = resolveVenueTz(ctx.division.tz, ctx.orgTz);
  const input: MatchCentreInput = {
    fixture,
    sportKey: ctx.division.sportKey,
    cfg,
    events,
    lineups,
    sides,
    venueTz,
    locale: ctx.locale,
    now: new Date(),
    hrefs: ctx.hrefs,
    stage: ctx.stage,
    moduleVersion: ctx.division.moduleVersion,
    formatLabel,
  };
  return buildMatchCentre(input);
}

/** The body `getPublicFixture` cached before T4, verbatim. */
async function getPublicFixtureBodyBefore(shell: PublicCompetitionShell, division: PublicDivision, fixtureId: string) {
  const [fixtureRow] = await sql<PublicFixture[]>`
    select id, division_id, stage_id, pool_id, round_no, seq_in_round,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           scheduled_at, venue, court_label,
           status, outcome, summary, last_seq,
           lane, is_final, third_place, conditional, stream_url,
           (select x.winner_to_fixture from fixtures x where x.id = public_fixtures_v.id) as winner_to_fixture,
           (select x.winner_to_slot    from fixtures x where x.id = public_fixtures_v.id) as winner_to_slot,
           (select x.loser_to_fixture  from fixtures x where x.id = public_fixtures_v.id) as loser_to_fixture,
           (select x.loser_to_slot     from fixtures x where x.id = public_fixtures_v.id) as loser_to_slot
    from public_fixtures_v
    where id = ${fixtureId} and division_id = ${division.id} limit 1`;
  if (!fixtureRow) return null;
  const fixture = await withCourtVenueName({ ...fixtureRow, scheduled_at: isoDateTime(fixtureRow.scheduled_at) });
  const rawNames = await sql<{ id: string; kind: string; display_name: string }[]>`
    select id, kind, display_name from public_entrants_v
    where division_id = ${division.id}`;
  const names = await maskPublicEntrantNames(rawNames, division);
  const [rt] = await sql<{ realtime: boolean }[]>`
    select org_has_feature(${shell.org.id}, 'realtime', ${shell.competition.id})
           as realtime`;
  const tzRow = await venueTzRow(division.id);
  const [stageRow] = await sql<{ name: string }[]>`
    select name from stages where id = ${fixture.stage_id}`;
  const [variantRow] = await sql<{ name: string }[]>`
    select name from sport_variants
    where sport_key = ${division.sport_key} and key = ${division.variant_key}
      and (org_id is null or org_id = ${shell.org.id})
    order by org_id nulls last
    limit 1`;
  const locale = toLocale(shell.org.default_locale);
  const basePath = `/shared/${shell.org.slug}/${shell.competition.slug}/${division.slug}`;
  const matchCentre = await loadMatchCentreBefore(sql, fixture, {
    orgTz: tzRow?.org_tz ?? null,
    division: {
      sportKey: division.sport_key,
      moduleVersion: division.module_version,
      formatLabel: variantLabel(
        { sportKey: division.sport_key, variantKey: division.variant_key, storedName: variantRow?.name ?? null },
        (key) => msgFor(locale, key),
      ),
      tz: tzRow?.division_tz ?? null,
      youth: division.youth ?? false,
      playerNameDisplay: division.player_name_display ?? null,
    },
    locale,
    hrefs: { division: basePath, competition: `/shared/${shell.org.slug}/${shell.competition.slug}`, calendar: `${basePath}/calendar.ics` },
    stage: stageRow ? { name: stageRow.name, roundLabel: null } : null,
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars),
  });
  return {
    fixture,
    entrantNames: Object.fromEntries(names.map((n) => [n.id, n.display_name])),
    realtime: rt?.realtime === true,
    matchCentre,
    venueTz: resolveVenueTz(tzRow?.division_tz, tzRow?.org_tz),
    stageName: stageRow?.name ?? null,
  };
}

async function loadFixtureMatchCentreCtxBefore(divisionId: string, stageId: string): Promise<MatchCentreLoadCtx> {
  const [row] = await sql<
    {
      sport_key: string;
      module_version: string;
      variant_key: string;
      variant_name: string | null;
      youth: boolean;
      player_name_display: string | null;
      division_tz: string | null;
      org_slug: string;
      org_tz: string | null;
      org_default_locale: string;
      competition_slug: string;
      division_slug: string;
    }[]
  >`
    select d.sport_key, d.module_version, d.variant_key,
           (select v.name from sport_variants v
             where v.sport_key = d.sport_key and v.key = d.variant_key
               and (v.org_id is null or v.org_id = d.org_id)
             order by v.org_id nulls last
             limit 1) as variant_name,
           d.youth, d.player_name_display,
           ss.tz as division_tz,
           o.slug as org_slug, o.timezone as org_tz, o.default_locale as org_default_locale,
           c.slug as competition_slug, d.slug as division_slug
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = d.org_id
    left join schedule_settings ss on ss.division_id = d.id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "fixture not found");
  const [stageRow] = await sql<{ name: string }[]>`select name from stages where id = ${stageId}`;
  const locale = toLocale(row.org_default_locale);
  const basePath = `/shared/${row.org_slug}/${row.competition_slug}/${row.division_slug}`;
  return {
    orgTz: row.org_tz,
    division: {
      sportKey: row.sport_key,
      moduleVersion: row.module_version,
      formatLabel: variantLabel(
        { sportKey: row.sport_key, variantKey: row.variant_key, storedName: row.variant_name },
        (key) => msgFor(locale, key),
      ),
      tz: row.division_tz,
      youth: row.youth,
      playerNameDisplay: row.player_name_display,
    },
    locale,
    hrefs: { division: basePath, competition: `/shared/${row.org_slug}/${row.competition_slug}`, calendar: `${basePath}/calendar.ics` },
    stage: stageRow ? { name: stageRow.name, roundLabel: null } : null,
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars),
  };
}

async function publicFixtureBefore(fixtureId: string): Promise<unknown> {
  const [row] = await sql<PublicFixture[]>`
    select id, division_id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id,
           away_entrant_id, home_slot_label, away_slot_label,
           scheduled_at, venue, court_label, status, outcome,
           summary, last_seq, stream_url
    from public_fixtures_v where id = ${fixtureId} limit 1`;
  if (!row) throw new HttpError(404, "fixture not found");
  const fixture = await withCourtVenueName(row);
  const ctx = await loadFixtureMatchCentreCtxBefore(fixture.division_id, fixture.stage_id);
  const match_centre = await loadMatchCentreBefore(sql, fixture, ctx);
  return { ...fixture, match_centre };
}

function setLineOfBefore(sets: MatchCentreDocT["sets"]): string | null {
  if (sets === null || sets.kind !== "sets") return null;
  const [home, away] = sets.rows;
  const pairs = sets.columns
    .map((_, i) => {
      const h = home[i];
      const a = away[i];
      return h == null && a == null ? null : `${h ?? "–"}–${a ?? "–"}`;
    })
    .filter((pair): pair is string => pair !== null);
  return pairs.length === 0 ? null : pairs.join(" · ");
}

async function loadMatchPosterModelBefore(orgSlug: string, competitionSlug: string, divisionSlug: string, fixtureId: string) {
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return null;
  const { org, competition, division, fixture, matchCentre } = data;
  const header = matchCentre.header;
  const serving = servingSide(fixture.summary);
  const activeIndex: 0 | 1 | null = header.battingIndex ?? (serving === "home" ? 0 : serving === "away" ? 1 : null);
  const [stageRow] = fixture.stage_id
    ? await sql<{ name: string }[]>`select name from stages where id = ${fixture.stage_id}`
    : [];
  const locale = toLocale(org.default_locale);
  const [pub, ui] = await Promise.all([getDictionary(locale, "public"), getDictionary(locale, "ui")]);
  const say = (m: MsgT | null): string | null => (m === null ? null : t(pub, m.key, m.params));
  const [logo, homeBadge, awayBadge] = await Promise.all([
    posterImageDataUrl(org.logo),
    posterImageDataUrl(header.sides[0].badgeUrl),
    posterImageDataUrl(header.sides[1].badgeUrl),
  ]);
  return matchPosterModel({
    branding: [competition.branding, org.branding],
    orgName: org.name,
    logo,
    badges: [homeBadge, awayBadge],
    competitionName: competition.name,
    divisionName: division.name,
    stageName: stageRow?.name ?? null,
    header,
    activeIndex,
    setLine: setLineOfBefore(matchCentre.sets),
    topPerformers: matchCentre.cricket?.topPerformers ?? null,
    copy: {
      statusLine: say(header.statusLine),
      pillNote: say(header.pillNote),
      live: t(pub, "matchCentre.status.live"),
      result: t(pub, "news.kind.result"),
      vs: t(ui, "schedule.vs"),
      topBatter: t(pub, "matchCentre.topBatter"),
      topBowler: t(pub, "matchCentre.topBowler"),
      poweredBy: t(pub, "layout.poweredBy", { brand: "seazn" }),
    },
  });
}

// ── The suite ─────────────────────────────────────────────────────────────

interface SweepFixture {
  id: string;
  slug: string;
  stage_kind: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  withdrawn: boolean;
}

let scene: LoadersScene;
let shell: PublicCompetitionShell;
let sweep: SweepFixture[];

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seedLoadersScene();
  shell = (await getPublicCompetition(scene.orgSlug, scene.compSlug))!;
  sweep = await sql<SweepFixture[]>`
    select f.id, d.slug, st.kind as stage_kind, f.status, f.home_entrant_id, f.away_entrant_id,
           exists (select 1 from entrants e
                    where e.id in (f.home_entrant_id, f.away_entrant_id) and e.status = 'withdrawn') as withdrawn
    from fixtures f
    join divisions d on d.id = f.division_id
    join stages st on st.id = f.stage_id
    where d.competition_id = ${scene.competitionId}
    order by d.slug, st.seq, f.round_no, f.seq_in_round`;
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// The match centre reads `new Date()`; both sides see the same instant.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function expectIdentical(after: unknown, before: unknown, label: string) {
  expect(after, label).toStrictEqual(before);
  expect(JSON.stringify(after), label).toBe(JSON.stringify(before));
}

const divisionOf = (slug: string) => shell.divisions.find((d) => d.slug === slug)!;
const waitingBoth = (f: SweepFixture) => f.home_entrant_id === null && f.away_entrant_id === null;
const waitingOne = (f: SweepFixture) => (f.home_entrant_id === null) !== (f.away_entrant_id === null);

describe.skipIf(!HAS_DB)("match-centre loaders — identical to the pre-T4 loaders over every fixture", () => {
  it("the sweep covers every shape the loaders branch on (so the diff below is not vacuous)", () => {
    expect(sweep.length).toBeGreaterThanOrEqual(20);
    expect(sweep.some(waitingBoth)).toBe(true);
    expect(sweep.some((f) => waitingOne(f) && f.status === "scheduled")).toBe(true);
    expect(sweep.some((f) => f.status === "forfeited" && waitingOne(f))).toBe(true); // a bye
    expect(sweep.some((f) => f.status === "finalized")).toBe(true);
    expect(sweep.some((f) => f.status === "in_play")).toBe(true);
    expect(sweep.some((f) => f.withdrawn)).toBe(true);
    expect(sweep.some((f) => f.slug === "draft")).toBe(true);
  });

  it("getPublicFixture: every fixture's page document equals the pre-T4 one", async () => {
    for (const f of sweep) {
      const division = divisionOf(f.slug);
      const body = await getPublicFixtureBodyBefore(shell, division, f.id);
      expect(body, f.id).not.toBeNull();
      const before = { org: shell.org, competition: shell.competition, division, ...body! };
      expectIdentical(await getPublicFixture(scene.orgSlug, scene.compSlug, f.slug, f.id), before, `${f.slug} ${f.id}`);
    }
    // A fixture of another division is still not this division's.
    const foreign = sweep.find((f) => f.slug !== "cup")!;
    expect(await getPublicFixture(scene.orgSlug, scene.compSlug, "cup", foreign.id)).toBeNull();
  });

  it("publicFixture: every fixture's poll document equals the pre-T4 one", async () => {
    for (const f of sweep) {
      expectIdentical(await publicFixture(f.id), await publicFixtureBefore(f.id), `${f.slug} ${f.id}`);
    }
  });

  it("loadMatchPosterModel: every fixture's poster equals the pre-T4 one (stage name included)", async () => {
    const upcoming = sweep.filter((f) => f.status === "scheduled");
    expect(upcoming.length).toBeGreaterThan(0);
    let heroes = 0;
    for (const f of sweep) {
      const before = await loadMatchPosterModelBefore(scene.orgSlug, scene.compSlug, f.slug, f.id);
      const after = await loadMatchPosterModel(scene.orgSlug, scene.compSlug, f.slug, f.id);
      expectIdentical(after, before, `${f.slug} ${f.id}`);
      if (JSON.stringify(after).includes('"Finals"')) heroes += 1;
    }
    // Premise: the stage name actually reaches a poster (an upcoming knockout's hero).
    expect(heroes).toBeGreaterThan(0);
  });

  it("the config resolver receives the same snapshot, division config and stage config per fixture — read by the loader itself or handed in by publicFixture", async () => {
    const argsOf = async (read: () => Promise<unknown>) => {
      resolverArgs.calls = [];
      await read();
      return resolverArgs.calls;
    };
    let snapshots = 0;
    let stageConfigs = 0;
    for (const f of sweep) {
      const division = divisionOf(f.slug);
      const before = await argsOf(() => getPublicFixtureBodyBefore(shell, division, f.id));
      expect(before, f.id).toHaveLength(1);
      expect(await argsOf(() => getPublicFixture(scene.orgSlug, scene.compSlug, f.slug, f.id)), f.id).toStrictEqual(before);
      expect(await argsOf(() => publicFixture(f.id)), f.id).toStrictEqual(await argsOf(() => publicFixtureBefore(f.id)));
      const [snapshot, , stageConfig] = before[0]!;
      if (snapshot != null) snapshots += 1;
      if (stageConfig != null && Object.keys(stageConfig as object).length > 0) stageConfigs += 1;
    }
    // Premise: both a frozen snapshot and a non-empty stage config reach the
    // resolver somewhere in the sweep, so a dropped one would show.
    expect(snapshots).toBeGreaterThan(0);
    expect(stageConfigs).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("match-centre loaders read less, and together, inside the pool budget", () => {
  const measure = async (read: () => Promise<unknown>) => {
    probe.peak = 0;
    probe.texts = [];
    await read();
    return { peak: probe.peak, texts: [...probe.texts] };
  };
  const ctxFor = async (f: SweepFixture) => {
    const division = divisionOf(f.slug);
    const locale = toLocale(shell.org.default_locale);
    const tzRow = await venueTzRow(division.id);
    return {
      orgTz: tzRow?.org_tz ?? null,
      division: {
        sportKey: division.sport_key,
        moduleVersion: division.module_version,
        formatLabel: "Score",
        tz: tzRow?.division_tz ?? null,
        youth: division.youth ?? false,
        playerNameDisplay: division.player_name_display ?? null,
      },
      locale,
      hrefs: { division: "/d", competition: "/c", calendar: null },
      stage: { name: "Stage", roundLabel: null },
      slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars),
    } satisfies MatchCentreLoadCtx;
  };
  const viewRow = async (id: string) =>
    (
      await sql<PublicFixture[]>`
        select id, division_id, stage_id, pool_id, round_no, seq_in_round,
               home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
               scheduled_at, venue, court_label, status, outcome, summary, last_seq,
               lane, is_final, third_place, conditional, stream_url
        from public_fixtures_v where id = ${id}`
    )[0]!;

  it("loadMatchCentre: one config statement where there were three, its reads in flight together (5 with a seat to name, 4 without)", async () => {
    // One seat to name AND one entrant to read: every lane is live.
    const waiting = sweep.find((f) => f.slug === "bracket" && waitingOne(f) && f.status === "scheduled")!;
    const filled = sweep.find((f) => f.slug === "cup" && f.status === "finalized")!;
    for (const [f, lanes] of [
      [waiting, 5],
      [filled, 4],
    ] as const) {
      const fixture = await viewRow(f.id);
      const ctx = await ctxFor(f);
      const before = await measure(() => loadMatchCentreBefore(sql, fixture, ctx));
      const after = await measure(() => loadMatchCentre(sql, fixture, ctx));
      expect(before.peak, f.id).toBe(1);
      expect(after.peak, f.id).toBe(lanes);
      expect(after.texts.length, after.texts.join("\n")).toBe(before.texts.length - 2);
    }
  });

  it("getPublicFixture: fewer statements, at most five in flight", async () => {
    const f = sweep.find((x) => x.slug === "cup" && waitingBoth(x))!;
    const before = await measure(() => getPublicFixtureBodyBefore(shell, divisionOf(f.slug), f.id));
    const after = await measure(() => getPublicFixture(scene.orgSlug, scene.compSlug, f.slug, f.id));
    const shellReads = 4; // getPublicCompetition (org, competition, divisions, live now) under the passthrough cache
    expect(before.peak).toBe(1);
    expect(after.peak).toBeGreaterThan(1);
    expect(after.peak).toBeLessThanOrEqual(5);
    expect(after.texts.length - shellReads).toBeLessThan(before.texts.length);
  });

  it("publicFixture: the division and stage rows are read once each, not twice; at most five in flight", async () => {
    const f = sweep.find((x) => x.slug === "cup" && waitingBoth(x))!;
    // Base tables only: `\b` does not match inside public_divisions_v / public_stages_v.
    const reads = (texts: string[], table: RegExp) => texts.filter((text) => table.test(text)).length;
    const before = await measure(() => publicFixtureBefore(f.id));
    const after = await measure(() => publicFixture(f.id));
    expect(reads(before.texts, /\bstages\b/), before.texts.join("\n")).toBe(2);
    expect(reads(after.texts, /\bstages\b/), after.texts.join("\n")).toBe(1);
    // The context read and the loader's config read each read `divisions`
    // before; now only the context does. (The court-name read joins it too.)
    expect(reads(after.texts, /\bdivisions\b/)).toBe(reads(before.texts, /\bdivisions\b/) - 1);
    expect(before.peak).toBe(1);
    expect(after.peak).toBeGreaterThan(1);
    expect(after.peak).toBeLessThanOrEqual(5);
  });
});
