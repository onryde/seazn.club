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
import { readScanFixture } from "@/server/usecases/scan-fixture";
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
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { findQuickMatchByCompetition } from "@/server/usecases/quick-match-home";
import { openHomeToken } from "@/server/usecases/quick-match-tokens";
import { log } from "@/server/logger";
import { QuickMatchBackLink } from "@/components/v2/quick-match-back-link";
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

  const fixture = await readScanFixture(link.org_id, link.fixture_id);
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
  // W2a: `{ cfg, stageKind }` — the cfg drives the pad; the stage kind rides the bootstrap to it (Task 12: a bracket
  // offers no level result). Never discarded: a kind read and dropped is the inert seam (addendum 4).
  // W2c Task 15 (X-SR-7): the rules version, read in the SAME select as the cfg — the version this pad's taps send.
  const { cfg: padCfg, stageKind, rulesVersion } = await loadFixturePadCfg(read, fixture.id);
  // R7 B2 — per-config catalog (see the fixture console page). Still the raw
  // DIVISION config, deliberately: the catalog's inputs are teamSize /
  // playersPerSide / goalkeeper, which no sport in scope can override per
  // stage, and the spec records these four catalog sites as a known gap to be
  // closed the day a team sport gains a stage-overridable teamSize.
  const lineupCatalog = lineupCatalogFor(sportModule, fixture.config);
  // Quick match C12: the pad's way back to its home, or null for every other pad. Read here, with the pad's own loads,
  // so a waiting screen's poll never pays for it.
  const [state, events, quickMatchHref] = await Promise.all([
    getFixtureState(read, fixture.id),
    listEvents(read, fixture.id, 0),
    quickMatchHomeHref(link.org_id, fixture.competition_id),
  ]);

  const fixtureId = fixture.id; // a closure does not keep `fixture`'s null check
  async function side(entrantId: string | null): Promise<PadSideInfo | null> {
    if (!entrantId) return null;
    // Same pair the fixture console loads — a lineup saved there must reach
    // the pad's picker (this read is the trusted server ctx, not the
    // device-link API surface getLineup's rejectDeviceLink guards).
    const [entrant, lineup] = await Promise.all([
      getEntrant(read, entrantId),
      getLineup(read, fixtureId, entrantId),
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
    stageKind,
    rulesVersion,
  });

  return (
    <main style={themeStyle} className="min-h-screen bg-court px-4 py-6">
      {/* A quick match's pad (C12) is a flex column so its back link can sit above the pad from md up and under it on a
          phone (the link's own `max-md:order-last`; quick-match-back-link.tsx says why). Every other pad keeps the
          plain block it always had. The link sits outside the dictionary provider: its label is already resolved. */}
      <div className={quickMatchHref ? "mx-auto flex max-w-2xl flex-col gap-3" : "mx-auto max-w-2xl"}>
        {quickMatchHref ? <QuickMatchBackLink href={quickMatchHref} label={t("quickMatch.backToMatch")} /> : null}
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
        // W2c Task 15 (X-SR-7): the chrome's own writes send the version the pad was loaded with.
        rulesVersion={rulesVersion}
        />,
        )}
      </div>
    </main>
  );
}

/**
 * Quick match (spec C12; plan 1 Task 9): the href of the pad's way back to its quick match's home, `/q/<home token>`,
 * or null for every other pad. Only the system org's links can belong to a quick match, so any other org's pad returns
 * before a query. A system-org competition with no `quick_matches` row (a create that died before its last commit,
 * pre-flight D1) has no home to go back to. Expiry is not checked: the home answers an expired match honestly, and a
 * score revives the row (D5). The token is opened here, server-side; only the finished href reaches the client.
 *
 * The link is an extra and must never break scoring (controller ruling 2026-11-08; pre-flight A6, C8): when the home
 * token cannot be opened, whether the KEK is missing, the envelope is damaged, or a KEK was rotated without re-sealing,
 * the pad renders without the link and the server logs ONE warning with that case's reason code. The warning carries
 * the reason and the competition id only: never the token, the envelope, or the crypto error's own message.
 */
async function quickMatchHomeHref(orgId: string, competitionId: string): Promise<string | null> {
  if (orgId !== QUICK_MATCH_SYSTEM_ORG_ID) return null;
  const row = await findQuickMatchByCompetition(competitionId);
  if (!row) return null;
  let token: string;
  try {
    token = openHomeToken(row.tokenEnc);
  } catch (err) {
    log.warn({ reason: backLinkMiss(err), competitionId }, "quick match pad: back link hidden, the home token could not be opened");
    return null;
  }
  return `/q/${token}`;
}

/** Why a quick match's home token could not be opened, one reason code per case of the 2026-11-08 ruling. */
function backLinkMiss(err: unknown): string {
  // No usable DEVICE_LINK_KEK: a configuration gap (quick-match-tokens.ts checks the key before any decryption).
  if (err instanceof HttpError && err.code === "DEVICE_LINK_KEK_MISSING") return "quick_match_back_link_kek_missing";
  // relay/crypto.ts `openWith` refuses an envelope too short or of an unknown version by name, before decrypting: the
  // stored bytes are damaged.
  if (err instanceof Error && err.message.startsWith("relay envelope ")) return "quick_match_back_link_envelope_malformed";
  // Everything else is AES-GCM refusing to authenticate: the key is not the one that sealed it (a KEK rotated without
  // re-sealing) or the bytes were altered. GCM cannot tell those two apart.
  return "quick_match_back_link_envelope_rejected";
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
