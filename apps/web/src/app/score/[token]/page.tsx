export const dynamic = "force-dynamic";
// /score/{token} — the account-less courtside pad (doc 13 §7, PROMPT-21).
// No session: the token IS the credential. The server resolves it once to
// render the shell; every scoring call from the client re-presents it as
// `Authorization: Bearer dl_…`. The token lives in this tab only — never
// localStorage.
import { resolveDeviceLinkToken } from "@/server/usecases/device-links";
import { getFixtureState, getLineup, listEvents } from "@/server/usecases/fixtures";
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

export default async function ScorePadPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let link;
  try {
    link = await resolveDeviceLinkToken(token);
  } catch (err) {
    // Expired / revoked / unknown → the doc 13 §7 dead-end screen.
    const message =
      err instanceof HttpError && err.code !== "LINK_INVALID"
        ? err.message
        : "This scoring link is not valid.";
    return <DeadLink message={message} />;
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
        sport_key: string;
        module_version: string;
        config: unknown;
        competition_id: string;
        competition_name: string;
        division_name: string;
        competition_branding: unknown;
      }[]
    >`
      select f.id, f.round_no, ven.name as venue_name, crt.name as court_name,
             f.scheduled_at, f.home_entrant_id, f.away_entrant_id,
             d.sport_key, d.module_version, d.config,
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
  if (!fixture) return <DeadLink message="This fixture no longer exists." />;

  // Same brand chain as the public pages / noticeboard (Pro entitlements
  // resolved inside orgBoardChrome): the volunteer's pad wears club colors.
  const chrome = await orgBoardChrome(read);
  const themeStyle = chrome.themed
    ? publicThemeStyleChain(fixture.competition_branding, chrome.branding)
    : undefined;

  const sportModule = resolveModule(fixture.sport_key, fixture.module_version);
  // R7 B2 — per-config catalog (see the fixture console page); the device
  // link's fixture carries its own resolved `config` column.
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
    rawConfig: fixture.config,
    hasFeatureFn: (key) => hasFeature(link.org_id, key, fixture.competition_id),
    initialEvents: events.map((e) => eventOutToEnvelope(fixture.id, e)),
    identity: { recordedBy: link.issued_by, deviceLinkId: link.id },
  });

  return (
    <main style={themeStyle} className="min-h-screen bg-court px-4 py-6">
      <div className="mx-auto max-w-2xl">
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
        }}
        sport={{
          key: fixture.sport_key,
          config: fixture.config as Record<string, unknown>,
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
        }))}
        scorePadV2={scorePadV2}
        />
      </div>
    </main>
  );
}

function DeadLink({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 text-center">
      <p className="text-4xl">⏱️</p>
      <h1 className="mt-3 text-lg font-semibold text-slate-100">{message}</h1>
      <p className="mt-2 text-sm text-slate-400">
        Ask the organiser to hand you a fresh link.
      </p>
    </main>
  );
}
