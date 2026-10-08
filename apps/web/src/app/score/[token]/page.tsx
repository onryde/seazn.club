export const dynamic = "force-dynamic";
// /score/{token} — the account-less courtside pad (doc 13 §7, PROMPT-21).
// No session: the token IS the credential. The server resolves it once to
// render the shell; every scoring call from the client re-presents it as
// `Authorization: Bearer dl_…`. The token lives in this tab only — never
// localStorage.
import { resolveDeviceLinkToken } from "@/server/usecases/device-links";
import {
  getFixtureState,
  getLineup,
  listEvents,
  loadFixturePadCfg,
} from "@/server/usecases/fixtures";
import { getEntrant } from "@/server/usecases/entrants";
import { withTenant } from "@/lib/db";
import { resolveModule } from "@/server/engine-db";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";
import { HttpError } from "@/lib/errors";
import { orgBoardChrome } from "@/server/slideshow-data";
import { publicThemeStyleChain } from "@/lib/public-theme";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  DeviceScorePad,
  type PadSideInfo,
} from "@/components/v2/device-score-pad";
// S13/#422 W11 — the v2 scoring pad, resolved server-side unconditionally
// (S12/#421's flag has been removed entirely — see resolveScorePadBootstrap's
// own doc for what a resolution failure does instead of gating on a flag).
import { hasFeature } from "@/lib/entitlements";
import { resolveScorePadBootstrap } from "@/server/usecases/fidelity";
import { eventOutToEnvelope } from "@/components/v2/scorepad/wire";
import { ScanWaiting } from "@/components/v2/scan-waiting";
import { deadLinkKey, fixtureTimeLabel, scanScreen } from "@/lib/scan-screen";
import { resultCarriedForward } from "@/server/usecases/carried-forward";
import { scanMatchNames } from "@/server/usecases/scan-match-names";
import { resolveVenueTz } from "@/lib/tz";
import { entrantDisplayName, type EntrantNameSource } from "@/lib/entrant-name";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { msgFor } from "@/lib/messages-i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import type { MessageKey } from "@/lib/messages";
import { DEFAULT_LOCALE, getDictionary } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { HtmlLang } from "@/components/i18n/html-lang";
import type { ReactNode } from "react";

export default async function ScorePadPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // First, so even the dead-link screen speaks the scorer's language: the
  // resolver's own messages are English and never reach a screen (P12).
  const locale = await resolveLocale();
  const t = (k: MessageKey, v?: Record<string, string | number>) => msgFor(locale, k, v);

  let link;
  try {
    link = await resolveDeviceLinkToken(token);
  } catch (err) {
    // Expired / revoked / unknown → the doc 13 §7 dead-end screen, by CODE.
    const code = err instanceof HttpError ? (err.code ?? null) : null;
    return <DeadLink message={t(deadLinkKey(code))} hint={t("device.askFreshLink")} />;
  }

  // Server-trusted read context: this page IS the device-link surface, so it
  // loads exactly what the pad shows — fixture state, events, sides, sport.
  // The HTTP restrictions (fixtures.ts rejectDeviceLink) target the API
  // surface; this read runs in trusted server code, RLS-bounded to the org.
  const read: AuthCtx = {
    orgId: link.org_id,
    via: "session",
    userId: link.issued_by,
    role: "admin",
    keyId: null,
  };

  const fixture = await withTenant(link.org_id, async (tx) => {
    const [row] = await tx<
      {
        id: string;
        round_no: number;
        /** P9 cutover: DERIVED from `venues`/`courts` via `fixtures.venue_id`/
         *  `court_id` — the frozen `fixtures.venue`/`court_label` text columns
         *  are no longer written, so reading them blanks any fixture touched
         *  post-cutover. Same pattern as usecases/me.ts. */
        venue_name: string | null;
        court_name: string | null;
        scheduled_at: string | null;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        /** `fixtures.status` — the same column `getFixtureState` reports, read
         *  here so the screen is picked before any of the pad's own loads. */
        status: string;
        /** Each seated side's `entrants.display_name` (the snapshot), `kind`
         *  and roster in roster order: what the waiting screens resolve a
         *  seated side's name from, through `entrantDisplayName` — the way its
         *  printed card and the pad name it (final review I1). Plus each
         *  side's saved `pair_order` for THIS fixture, so a pair reads in its
         *  lineup order as Confirm and the card do (fix batch 2, item 3). */
        home_name: string | null;
        away_name: string | null;
        home_kind: string | null;
        away_kind: string | null;
        home_members: { person_id: string; full_name: string }[];
        away_members: { person_id: string; full_name: string }[];
        home_lineup: { person_id: string; pair_order: number }[];
        away_lineup: { person_id: string; pair_order: number }[];
        division_id: string;
        sport_key: string;
        module_version: string;
        config: unknown;
        competition_id: string;
        competition_name: string;
        division_name: string;
        /** Read in THIS render, so the refresh after the organiser's start
         *  sees it (`scanScreen`'s "not started" row). */
        division_status: string;
        competition_branding: unknown;
        /** `organizations.timezone`: the clock the printed sheet uses. */
        org_tz: string | null;
      }[]
    >`
      select f.id, f.round_no, ven.name as venue_name, crt.name as court_name,
             f.scheduled_at, f.home_entrant_id, f.away_entrant_id, f.status,
             he.display_name as home_name, ae.display_name as away_name,
             he.kind as home_kind, ae.kind as away_kind,
             hm.members as home_members, am.members as away_members,
             hl.slots as home_lineup, al.slots as away_lineup, d.id as division_id,
             d.sport_key, d.module_version, d.config, d.status as division_status,
             c.id as competition_id, c.name as competition_name, d.name as division_name,
             c.branding as competition_branding, o.timezone as org_tz
      from fixtures f
      left join courts crt on crt.id = f.court_id
      left join venues ven on ven.id = f.venue_id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
      -- Roster order as the sheet reads it (usecases/scorer-sheets.ts readEntrants).
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', p.id, 'full_name', p.full_name)
                                 order by em.squad_number nulls last, p.full_name), '[]'::json) as members
        from entrant_members em join persons p on p.id = em.person_id
        where em.entrant_id = he.id) hm on true
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', p.id, 'full_name', p.full_name)
                                 order by em.squad_number nulls last, p.full_name), '[]'::json) as members
        from entrant_members em join persons p on p.id = em.person_id
        where em.entrant_id = ae.id) am on true
      -- This fixture's saved pair order per side (usecases/scorer-sheets.ts readPairOrders).
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', l.person_id, 'pair_order', l.pair_order)), '[]'::json) as slots
        from lineups l
        where l.fixture_id = f.id and l.entrant_id = he.id and l.pair_order is not null) hl on true
      left join lateral (
        select coalesce(json_agg(json_build_object('person_id', l.person_id, 'pair_order', l.pair_order)), '[]'::json) as slots
        from lineups l
        where l.fixture_id = f.id and l.entrant_id = ae.id and l.pair_order is not null) al on true
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      left join organizations o on o.id = c.org_id
      where f.id = ${link.fixture_id}`;
    return row ?? null;
  });
  if (!fixture) return <DeadLink message={t("device.dead.gone")} hint={t("device.askFreshLink")} />;

  // Same brand chain as the public pages / noticeboard (Pro entitlements
  // resolved inside orgBoardChrome): the volunteer's pad wears club colors.
  // Every scan screen does — the waiting screens' `bg-court` is `--ps-court` —
  // so this stays above their early return.
  const chrome = await orgBoardChrome(read);
  const themeStyle = chrome.themed
    ? publicThemeStyleChain(fixture.competition_branding, chrome.branding)
    : undefined;

  // Scorer sheets §4.5 — which screen this scan opens on. One table
  // (`scanScreen`); `resultCarriedForward` is the same live predicate the
  // scoring path refuses on, status gate included (a SCHEDULED fixture whose
  // feed target was hand-seated is still the umpire's to score).
  //
  // Picked from the fixture row alone, BEFORE any load only the pad needs
  // (review 2026-09-25): a phone scanned early sits on a waiting screen that
  // re-renders this page every POLL_MS, possibly all morning, and each of
  // those renders used to pay for the pad's cfg, fold state, ledger, both
  // rosters and both lineups, to print two names. Pinned by page.test.tsx
  // ("the waiting screens load nothing only the pad needs").
  const carried = await withTenant(link.org_id, (tx) => resultCarriedForward(tx, fixture.id));
  const screen = scanScreen({
    status: fixture.status,
    homeKnown: fixture.home_entrant_id !== null,
    awayKnown: fixture.away_entrant_id !== null,
    carriedForward: carried,
    divisionStatus: fixture.division_status,
  });
  // The ORG clock, resolved exactly as the printed sheet resolves it
  // (usecases/scorer-sheets.ts `competitionClock`): the scorer checks this
  // time against the card in their hand, so a division's own
  // `schedule_settings.tz` must not move it (final review M1; owner ruling:
  // the org time zone only).
  const tz = resolveVenueTz(null, fixture.org_tz);
  const scheduledLabel = fixtureTimeLabel(fixture.scheduled_at, tz, intlLocaleFor(locale));
  // The match and each still-empty seat, named the way the schedule board
  // names them (owner ruling 2026-09-24: "QF·1", "Winner of QF·2"), in the
  // viewer's language.
  const names = await withTenant(link.org_id, (tx) => scanMatchNames(tx, fixture.id, t));
  const ref = names.ref;
  if (screen.screen === "waiting" || screen.screen === "division_not_started") {
    // No pad and no stream yet: Waiting re-renders THIS page (router.refresh)
    // until both sides exist, when it renders the pad fresh — the Waiting →
    // Confirm hop needs no client state. Its words go down as props, already
    // in the viewer's language, and NO dictionary provider wraps it: that
    // provider would re-send the whole merged `ui` dictionary on every
    // POLL_MS refresh, to say three sentences (Task 6 review I2). The provider
    // was also what set `<html lang>`; a scanning phone rarely carries the
    // locale cookie the root layout's fallback reads, so the page says it.
    //
    // Owner fix 2026-09-24: an unstarted division waits the same way, on the
    // organiser's Start. `division_status` is read by this render's own query,
    // and a refresh is a fresh dynamic render (no ETag, no cache), so the first
    // refresh after the start renders Confirm.
    const notStarted = screen.screen === "division_not_started";
    // A seated side by the name its printed card carries (final review I1),
    // a pair in this fixture's lineup order (fix batch 2, item 3).
    const seated = (
      name: string | null,
      kind: string | null,
      members: EntrantNameSource["members"],
      lineup: EntrantNameSource["lineup"],
    ) => (name === null ? null : entrantDisplayName({ name, kind: kind ?? undefined, members, lineup }));
    return (
      <main style={themeStyle} className="min-h-screen bg-court px-4 py-6">
        <HtmlLang lang={locale} />
        <div className="mx-auto max-w-2xl">
          <ScanWaiting
            home={seated(fixture.home_name, fixture.home_kind, fixture.home_members, fixture.home_lineup) ?? names.home}
            away={seated(fixture.away_name, fixture.away_kind, fixture.away_members, fixture.away_lineup) ?? names.away}
            matchRef={ref}
            meta={[fixture.court_name, scheduledLabel, fixture.division_name].filter((m): m is string => !!m)}
            waitingOn={notStarted ? "division_start" : "sides"}
            copy={
              notStarted
                ? {
                    lead: t("device.scan.notStarted.title"),
                    vs: t("schedule.vs"),
                    hint: t("device.scan.notStarted.body"),
                  }
                : {
                    lead: t("device.scan.waitingFor"),
                    vs: t("schedule.vs"),
                    hint: t("device.scan.waitingHint"),
                  }
            }
          />
        </div>
      </main>
    );
  }

  // Everything below is the pad's alone (Confirm, View-only, the pad itself).
  const sportModule = resolveModule(fixture.sport_key, fixture.module_version);
  // §T4 — the cfg this pad renders against. `fixture.config` is NOT the
  // fixture's own config: the query above aliases `d.config`, the DIVISION's,
  // and a comment here used to claim otherwise. So it disagrees with the fold
  // for any scored fixture (which folds against the frozen snapshot) and it
  // cannot see a stage overlay. `loadFixturePadCfg` resolves all three inputs;
  // `read` is a session-shaped ctx by construction above, so the API-surface
  // device-link refusal does not apply to it.
  // W2a: `{ cfg, stageKind }` — the pad reads the cfg here; Task 12 threads the stage kind on to it.
  const padCfg = (await loadFixturePadCfg(read, fixture.id)).cfg;
  // R7 B2 — per-config catalog (see the fixture console page). Still the raw
  // DIVISION config, deliberately: the catalog's inputs are teamSize /
  // playersPerSide / goalkeeper, which no sport in scope can override per
  // stage, and the spec records these four catalog sites as a known gap to be
  // closed the day a team sport gains a stage-overridable teamSize.
  const lineupCatalog = lineupCatalogFor(sportModule, fixture.config);
  const [state, events] = await Promise.all([
    getFixtureState(read, fixture.id),
    listEvents(read, fixture.id, 0),
  ]);

  async function side(entrantId: string | null): Promise<PadSideInfo | null> {
    if (!entrantId) return null;
    // Same pair the fixture console loads — a lineup saved there must reach
    // the pad's picker (this read is the trusted server ctx, not the
    // device-link API surface getLineup's rejectDeviceLink guards).
    const [entrant, lineup] = await Promise.all([
      getEntrant(read, entrantId),
      getLineup(read, fixture.id, entrantId),
    ]);
    return {
      id: entrant.id,
      name: entrant.display_name,
      // Without it `entrantDisplayName` falls back to the stored snapshot, and
      // Confirm and the pad header disagree with the printed card, which names
      // a one-person individual (or a pair) by its roster (final review I1).
      kind: entrant.kind,
      members: entrant.members as PadSideInfo["members"],
      lineup: lineup.slots as PadSideInfo["lineup"],
    };
  }
  const [home, away] = await Promise.all([
    side(fixture.home_entrant_id),
    side(fixture.away_entrant_id),
  ]);

  // The pad's copy (Confirm, View-only, the pad itself) reads through
  // `useMsg`, which outside a provider falls back to English — so a French
  // phone got French server lines around an English pad. It renders once, not
  // on a poll, so it carries the dictionary. English needs no provider: that
  // fallback IS the English catalog the bundle already carries.
  const ui = locale === DEFAULT_LOCALE ? null : await getDictionary(locale, "ui");
  const inLocale = (node: ReactNode) =>
    ui ? (
      <DictProvider dict={ui} locale={locale}>
        {node}
      </DictProvider>
    ) : (
      node
    );

  // S13/#422 — the v2 pad's bootstrap, resolved unconditionally now that the
  // feature flag that used to gate it is gone. `recordedBy` is the ISSUING human
  // (`link.issued_by` — doc 13 §7 attribution, the same value `read.userId`
  // above already carries); `deviceLinkId` is this specific link's own id,
  // distinct from any other link the same issuer may have handed out — see
  // registry.tsx's `ScorePadBootstrap` doc for why that distinction matters
  // to the timeline's own "undo only mine" rule. `null` only on a resolution
  // failure (resolveScorePadBootstrap's own doc) — DeviceScorePad renders no
  // pad section in that case, since there is no v1 fallback left.
  const scorePadV2 = await resolveScorePadBootstrap({
    sportModule,
    rawConfig: padCfg,
    hasFeatureFn: (key) => hasFeature(link.org_id, key, fixture.competition_id),
    initialEvents: events.map((e) => eventOutToEnvelope(fixture.id, e)),
    identity: { recordedBy: link.issued_by, deviceLinkId: link.id },
  });

  return (
    <main style={themeStyle} className="min-h-screen bg-court px-4 py-6">
      <div className="mx-auto max-w-2xl">
        {inLocale(
        <DeviceScorePad
        token={token}
        logo={chrome.logo}
        deviceLinkId={link.id}
        fixture={{
          id: fixture.id,
          round_no: fixture.round_no,
          venue: fixture.venue_name,
          court_label: fixture.court_name,
          competition_name: fixture.competition_name,
          division_name: fixture.division_name,
          match_ref: ref,
          scheduled_label: scheduledLabel,
          round_label: names.roundLabel,
        }}
        sport={{
          key: fixture.sport_key,
          config: padCfg as Record<string, unknown>,
          scorerLabel: sportModule.officialLabel.scorer,
          positionGroups: lineupCatalog.groups,
          roles: lineupCatalog.roles ?? [],
          lineupSize: lineupCatalog.lineup.size,
          benchMax: lineupCatalog.lineup.benchMax ?? 0,
        }}
        home={home}
        away={away}
        initialState={{
          status: state.status,
          last_seq: state.last_seq,
          summary: state.summary,
          state: state.state,
          outcome: state.outcome,
        }}
        initialEvents={events.map((e) => ({
          id: e.id,
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          recorded_at: e.recorded_at,
          voids_event_id: e.voids_event_id,
          device_link_id: e.device_link_id,
          recorded_by: e.recorded_by,
        }))}
        scorePadV2={scorePadV2}
        initialViewOnly={screen.screen === "view_only" ? screen.reason : null}
        />,
        )}
      </div>
    </main>
  );
}

/** Doc 13 §7's dead end. Both lines arrive localised: no English literal is
 *  left in this file. */
function DeadLink({ message, hint }: { message: string; hint: string }) {
  return (
    <main
      data-testid="scan-dead-link"
      className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 text-center"
    >
      <p className="text-4xl">⏱️</p>
      <h1 className="mt-3 text-lg font-semibold text-slate-100">{message}</h1>
      <p className="mt-2 text-sm text-slate-400">{hint}</p>
    </main>
  );
}
