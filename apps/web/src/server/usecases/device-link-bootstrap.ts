import "server-only";
// `GET /api/v1/device-link` — what `app/score/[token]/page.tsx` resolves for a scan, as JSON for the phone's Remote Scoring
// (capture design §7.1). Read-only; the link is resolved by the route, the reads here are the page's own, so the two cannot
// disagree about which screen a scan opens on or what the match is called. Nothing is read that the page does not read.
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { scanScreen } from "@/lib/scan-screen";
import type { SlotLabelLookup } from "@/lib/slot-label";
import { getEntrant } from "./entrants";
import { getFixtureState, getLineup, loadFixturePadCfg, type StoredLineupSlot } from "./fixtures";
import { resultCarriedForward } from "./carried-forward";
import { scanMatchNames } from "./scan-match-names";
import { readScanFixture } from "./scan-fixture";
import { requiredEngineEpoch } from "./scoring";
import type { ResolvedDeviceLink } from "./device-links";

/** One row of a side's team sheet, as `readLineup` stores it (S2-5 design §10): the phone's football and cricket pads read
 *  the slot, position, order, role(s) and shirt number; table tennis reads `pair_order`. Every field is the stored one,
 *  verbatim; `squad_number` is the roster's (`entrant_members`), null when unset. */
export type DeviceLinkBootstrapLineupRow = {
  person_id: string;
  pair_order: number | null;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number | null;
  /** The DB's `not null default 'player'`, passed through as stored. */
  role: string | null;
  roles: string[];
  squad_number: number | null;
};

export type DeviceLinkBootstrapSide = {
  entrant_id: string;
  name: string;
  kind: string;
  members: { person_id: string; full_name: string }[];
  /** In `readLineup`'s order: `order_no`, then name, then person (engine-db/lineups.ts's order, so both agree). */
  lineup: DeviceLinkBootstrapLineupRow[];
};

export type DeviceLinkBootstrap = {
  fixture_id: string;
  link_id: string;
  sport_key: string;
  module_version: string;
  cfg: unknown;
  rules_version: number;
  engine_epoch_required: number;
  screen: "view_only" | "division_not_started" | "waiting" | "confirm" | "pad";
  view_only_reason: string | null;
  names: { competition: string; division: string | null; round_label: string | null; ref: string | null };
  /** A seat with no entrant yet (a waiting match, a bye) is null: the same fixture the page shows "waiting" for. */
  sides: Record<"home" | "away", DeviceLinkBootstrapSide | null>;
  state: { status: string; last_seq: number };
};

/** The page's own trusted read context: RLS-bounded to the link's org, session-shaped so `getLineup`'s device-link refusal
 *  (an API-surface guard) does not apply to this server-side read. */
function readCtx(link: ResolvedDeviceLink): AuthCtx {
  return { orgId: link.org_id, via: "session", userId: link.issued_by, role: "admin", keyId: null };
}

async function sideOf(read: AuthCtx, fixtureId: string, entrantId: string | null): Promise<DeviceLinkBootstrapSide | null> {
  if (!entrantId) return null;
  const [entrant, lineup] = await Promise.all([getEntrant(read, entrantId), getLineup(read, fixtureId, entrantId)]);
  const members = entrant.members as { person_id: string; full_name: string }[];
  const slots = lineup.slots as StoredLineupSlot[];
  return {
    entrant_id: entrant.id,
    name: entrant.display_name,
    kind: entrant.kind,
    members: members.map((m) => ({ person_id: m.person_id, full_name: m.full_name })),
    lineup: slots.map(lineupRowOf),
  };
}

/** `slot` is `text` with `check (slot in ('starting','bench'))` (V215), so the narrowing is the database's guarantee. */
function lineupRowOf(l: StoredLineupSlot): DeviceLinkBootstrapLineupRow {
  return {
    person_id: l.person_id,
    pair_order: l.pair_order ?? null,
    slot: l.slot as DeviceLinkBootstrapLineupRow["slot"],
    position_key: l.position_key,
    order_no: l.order_no,
    role: l.role,
    roles: l.roles,
    squad_number: l.squad_number,
  };
}

export async function getDeviceLinkBootstrap(link: ResolvedDeviceLink, lookup: SlotLabelLookup): Promise<DeviceLinkBootstrap> {
  const read = readCtx(link);
  const fixture = await readScanFixture(link.org_id, link.fixture_id);
  if (!fixture) throw new HttpError(404, "fixture not found");
  const carried = await withTenant(link.org_id, (tx) => resultCarriedForward(tx, fixture.id));
  const screen = scanScreen({
    status: fixture.status,
    homeKnown: fixture.home_entrant_id !== null,
    awayKnown: fixture.away_entrant_id !== null,
    carriedForward: carried,
    divisionStatus: fixture.division_status,
  });
  const names = await withTenant(link.org_id, (tx) => scanMatchNames(tx, fixture.id, lookup));
  const { cfg, rulesVersion } = await loadFixturePadCfg(read, fixture.id);
  const [state, home, away] = await Promise.all([
    getFixtureState(read, fixture.id),
    sideOf(read, fixture.id, fixture.home_entrant_id),
    sideOf(read, fixture.id, fixture.away_entrant_id),
  ]);
  return {
    fixture_id: fixture.id,
    link_id: link.id,
    sport_key: fixture.sport_key,
    module_version: fixture.module_version,
    cfg,
    rules_version: rulesVersion,
    engine_epoch_required: requiredEngineEpoch(fixture.sport_key, fixture.module_version),
    screen: screen.screen,
    view_only_reason: screen.screen === "view_only" ? screen.reason : null,
    names: { competition: fixture.competition_name, division: fixture.division_name, round_label: names.roundLabel, ref: names.ref },
    sides: { home, away },
    state: { status: state.status, last_seq: state.last_seq },
  };
}
