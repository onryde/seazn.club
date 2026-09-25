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
import { entrantDisplayName } from "@/lib/entrant-name";
import { deadLinkKey, fixtureTimeLabel, scanScreen } from "@/lib/scan-screen";
import { resultCarriedForward } from "@/server/usecases/carried-forward";
import { scanMatchNames } from "@/server/usecases/scan-match-names";
import { venueTzForDivision } from "@/server/venue-tz";
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
      }[]
    >`
      select f.id, f.round_no, ven.name as venue_name, crt.name as court_name,
             f.scheduled_at, f.home_entrant_id, f.away_entrant_id, d.id as division_id,
             d.sport_key, d.module_version, d.config, d.status as division_status,
             c.id as competition_id, c.name as competition_name, d.name as division_name,
             c.branding as competition_branding
      from fixtures f
      left join courts crt on crt.id = f.court_id
      left join venues ven on ven.id = f.venue_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      where f.id = ${link.fixture_id}`;
    return row ?? null;
  });
  if (!fixture) return <DeadLink message={t("device.dead.gone")} hint={t("device.askFreshLink")} />;

  // Same brand chain as the public pages / noticeboard (Pro entitlements
  // resolved inside orgBoardChrome): the volunteer's pad wears club colors.
  const chrome = await orgBoardChrome(read);
  const themeStyle = chrome.themed
    ? publicThemeStyleChain(fixture.competition_branding, chrome.branding)
    : undefined;

  const sportModule = resolveModule(fixture.sport_key, fixture.module_version);
  // §T4 — the cfg this pad renders against. `fixture.config` is NOT the
  // fixture's own config: the query above aliases `d.config`, the DIVISION's,
  // and a comment here used to claim otherwise. So it disagrees with the fold
  // for any scored fixture (which folds against the frozen snapshot) and it
  // cannot see a stage overlay. `loadFixturePadCfg` resolves all three inputs;
  // `read` is a session-shaped ctx by construction above, so the API-surface
  // device-link refusal does not apply to it.
  const padCfg = await loadFixturePadCfg(read, fixture.id);
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
      members: entrant.members as PadSideInfo["members"],
      lineup: lineup.slots as PadSideInfo["lineup"],
    };
  }
  const [home, away] = await Promise.all([
    side(fixture.home_entrant_id),
    side(fixture.away_entrant_id),
  ]);

  // Scorer sheets §4.5 — which screen this scan opens on. One table
  // (`scanScreen`); `resultCarriedForward` is the same live predicate the
  // scoring path refuses on, status gate included (a SCHEDULED fixture whose
  // feed target was hand-seated is still the umpire's to score).
  const carried = await withTenant(link.org_id, (tx) => resultCarriedForward(tx, fixture.id));
  const screen = scanScreen({
    status: state.status,
    homeKnown: fixture.home_entrant_id !== null,
    awayKnown: fixture.away_entrant_id !== null,
    carriedForward: carried,
    divisionStatus: fixture.division_status,
  });
  // The venue's zone through the one authority for that join (`venue-tz.ts`),
  // never a fourth copy of it.
  const tz = await venueTzForDivision(fixture.division_id);
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
    return (
      <main style={themeStyle} className="min-h-screen bg-court px-4 py-6">
        <HtmlLang lang={locale} />
        <div className="mx-auto max-w-2xl">
          <ScanWaiting
            home={home ? entrantDisplayName(home) : names.home}
            away={away ? entrantDisplayName(away) : names.away}
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
