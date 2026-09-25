"use client";
// S12/#421 W10 — the SINGLE registry both real entry points (the authed
// console, `fixture-console.tsx`, and the device-link pad,
// `device-score-pad.tsx`) consult to mount the scoring pad, plus the
// `<ScorePad/>` mount itself.
//
// R7 DEMOLISHED THE LEGACY/UNIVERSAL V2 PAD LANE this file used to route to
// (`pad-renderer.tsx`, `skins/registry.ts`'s `skinFor`, the
// `resolveScorePad`/`RESOLUTION_KIND`/`NO_V2_SKIN_SPORTS` decision table that
// used to live here) once carrom — the last of the 11 engine sports — landed
// its own v3 skin (`v3/registry.ts`'s `V3_SKINS`, R7/A3). R8 finished the
// job: `resolvePad` (`v3/registry.ts`) no longer HAS a "legacy" arm to fall
// through to — it returns a v3 skin for every `builtinModules` key
// directly, or throws for a key `V3_SKINS` does not own, in case a future
// engine sport ever ships without a v3 skin.
import { useCallback, useMemo } from "react";
import type { EventEnvelope, Lineup, LineupPair, LineupSlot } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import type { MemberIn, SideInfo, LineupSlotIn } from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { resolveModuleClient } from "./module-client";
import { deviceLinkTransport, sessionTransport, type PadAuthMode } from "./transport";
import type { OwnIdentity } from "./types";
import type { RejectionInfo } from "./use-pad-pipeline";
import { resolvePad } from "./v3/registry";
import type { TFn } from "./v3/context-strip";
import { PadHostV3 } from "./v3/pad-host";

// ---------------------------------------------------------------------------
// Server -> client shape builders both page loaders need. Collected here
// since this file is the one place both entry points already share.
// ---------------------------------------------------------------------------

/**
 * Structural, NOT `EventOut` (server/usecases/fixtures.ts) — this file ships
 * in the client bundle (module-client.test.ts's own "bundle purity" sweep
 * bans any `@/server/**` import from this directory), and both page loaders'
 * `listEvents` rows already satisfy this shape without a cast.
 */
// MOVED to ./wire (S12/#421). `WireEvent` and `eventOutToEnvelope` cannot
// live in this file: it is `"use client"`, and BOTH server page loaders call
// the mapper to build `initialEvents`. React refuses that at runtime, and
// `[].map(fn)` hid it until a fixture had its first event. See wire.ts's own
// header for the measurement. Deliberately NOT re-exported from here — a
// re-export through a `"use client"` module is still a client binding, so it
// would reintroduce exactly the crossing it looks like it fixes.

function toLineupSlot(s: LineupSlotIn, index: number): LineupSlot {
  return {
    personId: s.person_id,
    slot: s.slot,
    // DB order_no is nullable; fall back to this side's own append-order
    // index — the SAME fallback server/engine-db/lineups.ts's `buildLineup`
    // uses, so the client's optimistic fold never disagrees with the
    // server's fold over an unset order_no alone.
    orderNo: s.order_no ?? index + 1,
    ...(s.position_key ? { positionKey: s.position_key } : {}),
    ...(s.roles.length > 0 ? { roles: s.roles } : {}),
    // `role` (player/coach/staff, S3/#426 ruling) — S12/#421 pass B, Fix 2.
    // `readLineup`'s SQL (server/usecases/fixtures.ts) already selects the
    // real DB column into every row; the gap was purely `LineupSlotIn` never
    // declaring the field, so the client fold defaulted every slot to
    // "player" regardless of what was actually recorded. Verified end-to-end
    // (registry.test.tsx): this closes it for football's own scorer/assist
    // pool, which already filters by role via the kernel's `playingSquad`.
    // Cricket was NOT closed by this wire-shape fix alone and is now closed
    // separately: `orderFromLineup` (packages/engine/.../cricket.ts) built
    // `state.orders` off `lineup.slots` filtered only on
    // `slot === "starting"`, so a role:"coach" starting slot still opened the
    // batting even with `role` wired correctly here. Fixed in the same
    // session under owner ruling, with a regression test that puts the coach
    // at orderNo 1 and golden replay re-run at 133/133 with zero corpus files
    // dirty. Comment updated rather than left standing: a note that defers
    // work must be edited when the same session then does the work, or the
    // next reader re-diagnoses a closed gap (S11/#420 recorded this exact
    // cost).
    // Omitted for "player" itself, mirroring server/engine-db/lineups.ts's
    // own `buildLineup` convention — the engine's own `LineupSlot.role`
    // already defaults absent to "player" (core/lineup.ts), so this is a
    // wire-size choice, not a behaviour one.
    ...(s.role && s.role !== "player" ? { role: s.role } : {}),
    // `pairOrder` (doubles serve order, S3/#426's engine LineupSlot field) —
    // S12/#421 pass D, V361. Previously omitted deliberately: "no DB column
    // at all today ... carrying it through this function would be a dead,
    // always-undefined field" (this comment, pass B/C). The column, the
    // `readLineup`/`putLineup` write path and the editor's pair-order
    // control (rendered only for a pair-shaped entrant) all landed together
    // this pass, so the field is no longer dead — omitted only when
    // genuinely unset, the same "include only when meaningful" convention
    // `role`/`roles`/`positionKey` already use above.
    ...(s.pair_order != null ? { pairOrder: s.pair_order } : {}),
    // `squadNumber` (shirt number) — R8 sweep, WS-SQ. The THIRD field to be
    // found missing from this hand-copied list, after `role` (pass B) and
    // `pairOrder` (pass D), and the same silent shape every time: the engine's
    // `SquadMember.squadNumber` has existed since S3 (core/lineup.ts),
    // `entrant_members.squad_number` is a real populated column,
    // `readLineup`'s SQL (server/usecases/fixtures.ts) already selects it and
    // `LineupSlotIn` already DECLARED it — the number simply was not listed
    // here, so `initSquads` had nothing to carry and every squad member the
    // pad ever saw had `squadNumber: undefined`. tsc cannot catch that: an
    // optional field that is merely never set type-checks perfectly.
    //
    // What it unlocks: the substitution sheet's badge builders
    // (`footballCandidateMeta` in v3/skins/football.tsx, and the shared
    // `periodCandidateMeta` in v3/skins/period-shared.ts that hockey and ice
    // hockey use) lead with the SQUAD NUMBER and fall back to `positionKey`:
    //
    //     const lead = member.squadNumber !== undefined
    //       ? String(member.squadNumber) : member.positionKey;
    //
    // — owner ruling of 2026-09-01, superseding the position-led wording of
    // 2026-08-30 (quoted from `footballCandidateMeta`'s own docstring, which
    // is the ruling of record). R8 branch review: this comment used to say
    // `member.positionKey ?? member.squadNumber`, i.e. exactly backwards, and
    // it understated the blast radius with it.
    //
    // The real reach is every NUMBERED member, not just the bench.
    // `memberFromSlot` (core/lineup.ts) deliberately drops a BENCH slot's
    // declared position — a preference, not an occupancy — so before this
    // line the entire ON step was unbadgeable in principle, not merely
    // unbadged. But a numbered STARTER already had a badge, and this line
    // flips its lead from the position code to the shirt number. An
    // unnumbered starter still falls back to their position, unchanged.
    // `squad-number-seam.test.ts` drives that from the wire row through the
    // real fold into the real builder.
    //
    // `!= null` (not `!== undefined`) deliberately: this column is nullable
    // and `readLineup` returns a real `null` for a member with no declared
    // number. Omitted rather than carried as null, the same "absent unless it
    // adds information" convention every field above uses — and the engine's
    // own `memberFromSlot` omits the key entirely when the slot's is
    // undefined, so a null here would be a shape the kernel never produces.
    ...(s.squad_number != null ? { squadNumber: s.squad_number } : {}),
  };
}

function toLineup(side: SideInfo): Lineup {
  return { entrantId: side.id, slots: side.lineup.map(toLineupSlot) };
}

/**
 * `LineupPair` from the two sides' lineup slots + entrant ids — what
 * `SportModule.init`/`foldClient` need. Built identically for both entry
 * points since both hand `<ScorePad/>` the same `SideInfo` shape.
 */
export function lineupPairFrom(home: SideInfo, away: SideInfo): LineupPair {
  return { home: toLineup(home), away: toLineup(away) };
}

/**
 * personId -> display name, from both sides' rosters.
 * `PadRendererProps.personNames` has existed since S10/#419 and no caller
 * has ever passed it, so every person picker in the product has drawn a raw
 * UUID until this wave.
 */
export function personNamesFrom(home: SideInfo, away: SideInfo): Readonly<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const side of [home, away]) {
    for (const m of side.members as MemberIn[]) names[m.person_id] = m.full_name;
  }
  return names;
}

// ---------------------------------------------------------------------------
// <ScorePad/> — the single mount both dispatchers use
// ---------------------------------------------------------------------------

/**
 * Everything a server loader resolves ONCE for the pad, beyond what a
 * dispatcher already carries as an existing v1 prop (fixture id, sport key,
 * home/away). `auth` is deliberately NOT part of this bundle: it is
 * trivially known per dispatcher — `fixture-console.tsx` is always session,
 * `device-score-pad.tsx` is always device_link with the token it already
 * holds — never resolved server-side, so it stays a direct `<ScorePad/>`
 * prop instead.
 */
export interface ScorePadBootstrap {
  moduleVersion: string;
  /** Server-parsed variant cfg (`sportModule.configSchema.parse(...)`) —
   *  safe because `divisions.config`/the device-link fixture's `config` are
   *  already the resolved, schema-parsed cfg (S12/#421 decision log). */
  resolvedConfig: unknown;
  initialEvents: readonly EventEnvelope[];
  // W1 (entitlements v18): `band` is deleted — fidelity bands are a UX
  // choice, never an entitlement, and this bootstrap no longer carries one.
  // Task 4 finished the job: `ScorePadProps` has no `band` either, and the
  // pad host owns the scorer's own pick (`pad-host.tsx`'s `defaultBandFor` /
  // `resolveInitialBand`). Nothing server-side resolves a band any more.
  entitlements: Readonly<Record<string, boolean>>;
  identity: OwnIdentity;
}

export interface ScorePadProps {
  fixtureId: string;
  sportKey: string;
  moduleVersion: string;
  resolvedConfig: unknown;
  home: SideInfo;
  away: SideInfo;
  initialEvents: readonly EventEnvelope[];
  /** Forwarded straight to `PadHostV3.onEvents` — see its docstring. The
   *  chrome around this pad (fixture console, device pad) keeps its own event
   *  list for "Undo last" and cannot otherwise see what the pad submitted. */
  onEvents?: (events: readonly EventEnvelope[]) => void;
  /** Forwarded straight to `PadHostV3.onTerminalRefusal` (scorer sheets §4.5):
   *  a refusal that ends this surface's rights on the fixture, so the chrome
   *  can leave the pad. Only the device pad passes it. */
  onTerminalRefusal?: (rejection: RejectionInfo) => void;
  auth: PadAuthMode;
  /**
   * R7/C1 (D-4) — the chrome around this pad already mounts the one activity
   * ledger itself, so the pad must not mount a second. Passed by the fixture
   * console only; every other mount (the device pad) leaves it unset and the
   * pad keeps its own panel, which on `/score/[token]` is the ONLY history
   * there is. Honoured via v3's `showActivity` prop below.
   */
  hideActivity?: boolean;
  /** R7-46 — paired with `hideActivity`: chrome that mounts the ledger itself
   *  needs the pad's own partial-answer predicate, which only the pad can
   *  build. See `PadHostV3Props.onPartialResolver`. Ignored by the legacy
   *  lane, which has no dock vocabulary at all. */
  onPartialResolver?: (resolve: (eventType: string, payload: Record<string, unknown>) => boolean) => void;
  identity: OwnIdentity;
  entitlements: Readonly<Record<string, boolean>>;
}

type ModuleResolution = { ok: true; module: AnySportModule } | { ok: false; message: string };

/**
 * The single mount both real entry points use (S13/#422: unconditionally —
 * the feature flag that used to gate this has been removed entirely).
 * Resolves the module client-side (module-client.ts — no server round
 * trip), builds the lineup/person data both loaders' `SideInfo` already
 * carries, and renders `PadHostV3` with the skin `v3/registry.ts`'s
 * `resolvePad` resolves for this sport — every `builtinModules` key today
 * (R7 demolished the legacy lane this file used to fall back to; see this
 * file's own header).
 */
export function ScorePad(props: ScorePadProps) {
  const msg = useMsg();
  // Widens useMsg()'s MessageKey-only param to the plain `string` a v3
  // skin FACTORY declares (v3/registry.ts's own header explains why
  // `V3_SKINS` holds factories, never already-built skins) — the SAME
  // adapter `pad-host.tsx` already builds for the chassis's own `t` prop,
  // duplicated here rather than threaded through as a shared export: this
  // is the "component that resolves the skin" cricket.tsx's header points
  // at, a different component from `PadHostV3` with its own `useMsg()`.
  const t: TFn = useCallback((key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars), [msg]);
  const resolution = useMemo((): ModuleResolution => {
    try {
      return { ok: true, module: resolveModuleClient(props.sportKey, props.moduleVersion) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }, [props.sportKey, props.moduleVersion]);

  const lineups = useMemo(() => lineupPairFrom(props.home, props.away), [props.home, props.away]);
  const personNames = useMemo(() => personNamesFrom(props.home, props.away), [props.home, props.away]);
  const transport = useMemo(
    () => (props.auth.kind === "device_link" ? deviceLinkTransport(props.auth.token) : sessionTransport()),
    [props.auth],
  );

  if (!resolution.ok) {
    // Readable fallback rather than a blank page. The engine's own failure
    // text rides along as `reason` deliberately: a scorer courtside cannot
    // act on it, but the organiser they phone can, and it is the difference
    // between "the pad is broken" and "this division pins a module version
    // that no longer resolves".
    return (
      <div className="card p-4 text-sm text-red-700" role="alert">
        {msg("scorepad.v2.moduleUnavailable", { reason: resolution.message })}
      </div>
    );
  }

  // `resolveModuleClient` above already succeeded, which only happens for a
  // key the engine's registry actually has registered (i.e. a
  // `builtinModules` key), so `resolvePad` here is guaranteed a key
  // `v3/registry.ts` owns and cannot throw on this path.
  //
  // R1 shipped six chassis primitives with zero production import sites;
  // this is that import site — `PadHostV3` (./v3/pad-host.tsx). R2 through
  // R7/A3 (carrom, 2026-08-31) moved every sport onto it one at a time, and
  // R8 deleted the legacy lane `resolvePad` used to fall back to outright —
  // it returns a v3 skin directly now, or throws, with no wrapper to check
  // here (a future engine sport that ships without ever getting a v3 skin
  // still fails loudly, just inside `resolvePad` itself rather than at a
  // second check on this side).
  const skin = resolvePad(props.sportKey, t);

  return (
    <PadHostV3
      module={resolution.module}
      cfg={props.resolvedConfig}
      fixtureId={props.fixtureId}
      lineups={lineups}
      identity={props.identity}
      transport={transport}
      auth={props.auth}
      entitlements={props.entitlements}
      initialEvents={props.initialEvents}
      onEvents={props.onEvents}
      onTerminalRefusal={props.onTerminalRefusal}
      queueDbName={`scorepad-${props.fixtureId}`}
      personNames={personNames}
      showActivity={!props.hideActivity}
      onPartialResolver={props.onPartialResolver}
      skin={skin}
    />
  );
}
